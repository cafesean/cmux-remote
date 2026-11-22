import Foundation
import CryptoKit

// MARK: owner barrier + owner token file (core is the only writer of both)

public struct OwnerRecord: Codable, Equatable, Sendable {
  public var ownerSub: String?
  public var ownerEpoch: Int
}

public struct OwnerAccessToken: Codable, Equatable, Sendable {
  public var ownerSub: String
  public var ownerEpoch: Int
  public var accessToken: String
  public var exp: TimeInterval
}

extension BridgePaths {
  public var ownerPath: String { stateDir + "/owner.json" }
  public var hubAccessTokenPath: String { stateDir + "/hub-access-token" }
  public var pendingTunnelDeletePath: String { stateDir + "/pending-tunnel-delete.json" }
  public var planCachePath: String { stateDir + "/plan-cache.json" }
  public var installPolicyPath: String { stateDir + "/install-policy.json" }
}

public final class OwnerFiles {
  public static let refreshAccount = "connect-refresh"
  public static let refreshLeadSeconds: TimeInterval = 60
  let paths: BridgePaths
  let keychain: KeychainStore

  public init(paths: BridgePaths, keychain: KeychainStore) {
    self.paths = paths
    self.keychain = keychain
  }

  public func readOwner() -> OwnerRecord {
    FileManager.default.contents(atPath: paths.ownerPath).flatMap { try? JSONDecoder().decode(OwnerRecord.self, from: $0) }
      ?? OwnerRecord(ownerSub: nil, ownerEpoch: 0)
  }

  public func writeOwner(_ o: OwnerRecord) throws {
    try BridgeState.writePrivate(paths.ownerPath, String(decoding: try JSONEncoder().encode(o), as: UTF8.self))
  }

  /// Refresh token lives only in the Keychain (own item, no access group).
  public func storeRefreshToken(_ token: String) throws {
    try keychain.write(service: InstallKeyStore.service, account: Self.refreshAccount, data: Data(token.utf8))
  }

  public func refreshToken() -> String? {
    (try? keychain.read(service: InstallKeyStore.service, account: Self.refreshAccount)).flatMap { $0 }.map { String(decoding: $0, as: UTF8.self) }
  }

  /// Written for an owner only after that owner's credentials exist (refresh token in the Keychain).
  public func writeAccessToken(_ t: OwnerAccessToken) throws {
    let o = readOwner()
    guard refreshToken() != nil, o.ownerSub == t.ownerSub, o.ownerEpoch == t.ownerEpoch else { throw BridgeError.io("no owner credentials") }
    try BridgeState.writePrivate(paths.hubAccessTokenPath, String(decoding: try JSONEncoder().encode(t), as: UTF8.self))
  }

  public func readAccessToken() -> OwnerAccessToken? {
    FileManager.default.contents(atPath: paths.hubAccessTokenPath).flatMap { try? JSONDecoder().decode(OwnerAccessToken.self, from: $0) }
  }

  public func needsRefresh(now: TimeInterval) -> Bool {
    guard let t = readAccessToken() else { return refreshToken() != nil }
    return now >= t.exp - Self.refreshLeadSeconds
  }

  /// Delete the owner token file and the Keychain refresh item. Never touches plan-cache.json / install-policy.json.
  public func deleteCredentials() {
    try? FileManager.default.removeItem(atPath: paths.hubAccessTokenPath)
    try? keychain.delete(service: InstallKeyStore.service, account: Self.refreshAccount)
  }
}

// MARK: pending tunnel delete queue (persisted before send)

public struct PendingTunnelDelete: Codable, Equatable, Sendable {
  public var ownerSub: String
  public var epoch: Int
  public var tunnelId: String?
  public var hostname: String
  public var at: TimeInterval
  public var nextAttempt: TimeInterval
  public var inFlight: Bool
}

public final class TunnelDeleteQueue {
  public static let retrySeconds: TimeInterval = 300
  public static let giveUpSeconds: TimeInterval = 24 * 3600
  public static let giveUpText = "Couldn't remove this Mac from your previous account. Sign in to that account on hyprmux.com to remove it."
  public static let pendingText = "Removing this Mac from your previous account…"

  let path: String
  let transport: HubTransport
  let clock: BridgeClock
  let key: Curve25519.Signing.PrivateKey
  public private(set) var notices: [String] = []

  public init(path: String, transport: HubTransport, clock: BridgeClock, key: Curve25519.Signing.PrivateKey) {
    self.path = path
    self.transport = transport
    self.clock = clock
    self.key = key
  }

  public func load() -> [PendingTunnelDelete] {
    FileManager.default.contents(atPath: path).flatMap { try? JSONDecoder().decode([PendingTunnelDelete].self, from: $0) } ?? []
  }

  func save(_ q: [PendingTunnelDelete]) throws {
    try BridgeState.writePrivate(path, String(decoding: try JSONEncoder().encode(q), as: UTF8.self))
  }

  public func append(_ e: PendingTunnelDelete) throws {
    var q = load()
    q.append(e)
    try save(q)
  }

  /// Entries still waiting (menu shows pendingText while any is left). They never block a newer ensure:
  /// every DELETE carries ?id=, so a late one cannot remove a newer row (409 TUNNEL_CHANGED).
  public var hasPending: Bool { !load().isEmpty }

  /// Restart: a send that never finished (core killed) is replayed.
  public func recoverAfterRestart() throws {
    var q = load()
    for i in q.indices where q[i].inFlight { q[i].inFlight = false; q[i].nextAttempt = clock.now() }
    try save(q)
  }

  /// Send every due entry once (marked in flight on disk before the DELETE goes out). A timeout or error is
  /// retried with the same ?id every 300 s; 2xx / 404 / 409 TUNNEL_CHANGED resolve; after 24 h the entry is dropped
  /// with the give-up notice.
  public func process() throws {
    var q = load()
    var i = 0
    while i < q.count {
      let now = clock.now()
      if now - q[i].at >= Self.giveUpSeconds {
        notices.append(Self.giveUpText)
        q.remove(at: i)
        try save(q)
        continue
      }
      guard q[i].nextAttempt <= now else { i += 1; continue }
      q[i].inFlight = true
      try save(q)
      let reply = sendDelete(q[i])
      q[i].inFlight = false
      if case .response(let status, let body) = reply,
         (200..<300).contains(status) || status == 404 || (status == 409 && HubEnvelope.errorCode(status, body) == "TUNNEL_CHANGED") {
        q.remove(at: i)
        try save(q)
        continue
      }
      q[i].nextAttempt = now + Self.retrySeconds
      try save(q)
      i += 1
    }
  }

  /// Install-key signed (no bearer); ?id= when known. Signed path = pathname only.
  func sendDelete(_ e: PendingTunnelDelete) -> HubReply {
    let path = HubTunnelClient.tunnelsPath + "/me"
    guard let h = try? InstallKeySigner.headers(key: key, method: "DELETE", path: path, body: "", nowMs: Int64(clock.now() * 1000)) else {
      return .network
    }
    let query = e.tunnelId.map { "id=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0)" }
    return transport.send(HubRequest(method: "DELETE", path: path, query: query, headers: h, body: nil), timeout: HubTunnelClient.attemptTimeout)
  }
}

// MARK: sign-out / owner change (R8 order)

public final class OwnerChange {
  let state: BridgeState
  let coordinator: AgentCoordinator
  let agents: AgentService
  let owner: OwnerFiles
  let queue: TunnelDeleteQueue
  let clock: BridgeClock

  public init(state: BridgeState, coordinator: AgentCoordinator, agents: AgentService, owner: OwnerFiles,
              queue: TunnelDeleteQueue, clock: BridgeClock) {
    self.state = state
    self.coordinator = coordinator
    self.agents = agents
    self.owner = owner
    self.queue = queue
    self.clock = clock
  }

  /// (1) stop tunnel + Phone access off, (2) owner.json epoch+1, (3) persist delete intent, (4) delete credentials,
  /// then send the queued DELETE. `newOwner` nil = sign-out.
  public func run(newOwner: String?) throws {
    try? agents.unregister(.tunnel)
    try state.setPhoneAccess(false)
    let old = owner.readOwner()
    try owner.writeOwner(OwnerRecord(ownerSub: newOwner, ownerEpoch: old.ownerEpoch + 1))
    if let sub = old.ownerSub, let last = state.readLastTunnel() {
      let now = clock.now()
      try queue.append(PendingTunnelDelete(ownerSub: sub, epoch: old.ownerEpoch, tunnelId: last.id, hostname: last.hostname,
                                           at: now, nextAttempt: now, inFlight: false))
    }
    owner.deleteCredentials()
    try queue.process()
  }
}

// MARK: re-ensure on refresh (R11)

public struct EntitlementSnapshot: Equatable, Sendable {
  public var enforced: Bool
  public var tunnelAllowed: Bool
  public init(enforced: Bool, tunnelAllowed: Bool) {
    self.enforced = enforced
    self.tunnelAllowed = tunnelAllowed
  }
}

public enum ReEnsurePolicy {
  /// One POST /tunnels on the refresh where the tunnel becomes allowed again, only while Phone access is on.
  public static func shouldEnsure(previous: EntitlementSnapshot?, current: EntitlementSnapshot, phoneAccessOn: Bool) -> Bool {
    guard phoneAccessOn, let p = previous else { return false }
    let unblocked = (p.enforced && !current.enforced) || (!p.tunnelAllowed && current.tunnelAllowed)
    return unblocked
  }
}
