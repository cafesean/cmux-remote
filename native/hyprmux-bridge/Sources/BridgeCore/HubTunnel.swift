import Foundation
import CryptoKit

// MARK: transport seam

public struct HubRequest: Equatable, Sendable {
  public var method: String
  /// Pathname (signed) plus optional query (not signed).
  public var path: String
  public var query: String?
  public var headers: [String: String]
  public var body: String?
}

public enum HubReply: Equatable, Sendable {
  case response(status: Int, body: Data)
  case timeout
  case network
}

/// One HTTP exchange with the hub. Must return within `timeout` (URLSession in the app, a stub in tests).
public protocol HubTransport: AnyObject {
  func send(_ request: HubRequest, timeout: TimeInterval) -> HubReply
}

// MARK: install-key signature (same signing string as the app host)

public enum InstallKeySigner {
  public static func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// "<METHOD>\n<pathname>\n<ts ms>\n<sha256(body) hex>"
  public static func signingString(method: String, path: String, ts: String, body: String) -> String {
    let h = SHA256.hash(data: Data(body.utf8)).map { String(format: "%02x", $0) }.joined()
    return "\(method)\n\(path)\n\(ts)\n\(h)"
  }

  public static func headers(key: Curve25519.Signing.PrivateKey, method: String, path: String, body: String,
                             nowMs: Int64) throws -> [String: String] {
    let ts = String(nowMs)
    let sig = try key.signature(for: Data(signingString(method: method, path: path, ts: ts, body: body).utf8))
    return ["x-hmx-key": b64url(key.publicKey.rawRepresentation), "x-hmx-ts": ts, "x-hmx-sig": b64url(sig)]
  }
}

// MARK: envelope

enum HubEnvelope {
  static func json(_ d: Data) -> [String: Any]? { try? JSONSerialization.jsonObject(with: d) as? [String: Any] }

  /// details.code / details.reason / error.code, or a plain `error` string, else http_<status>.
  static func errorCode(_ status: Int, _ body: Data) -> String {
    let b = json(body)
    if let s = b?["error"] as? String { return s }
    let e = b?["error"] as? [String: Any]
    let d = e?["details"] as? [String: Any]
    if let c = d?["code"] as? String { return c }
    if let r = d?["reason"] as? String { return r }
    if let c = e?["code"] as? String { return c }
    return "http_\(status)"
  }

  /// Seconds the hub asked to wait (503 BUSY): top-level retryAfter (HTTPHubTransport folds the Retry-After header in)
  /// or error.details.retryAfter.
  static func retryAfter(_ body: Data) -> TimeInterval? {
    let b = json(body)
    if let n = b?["retryAfter"] as? Double { return n }
    if let n = details(body)?["retryAfter"] as? Double { return n }
    return nil
  }

  static func details(_ body: Data) -> [String: Any]? { ((json(body)?["error"] as? [String: Any])?["details"]) as? [String: Any] }
  static func data(_ body: Data) -> [String: Any]? {
    guard let b = json(body), b["success"] as? Bool == true else { return nil }
    return b["data"] as? [String: Any]
  }
}

// MARK: tunnel ensure

public enum TunnelState: Equatable, Sendable {
  case ready(id: String?, hostname: String)
  case limit(upgradeUrl: String?)
  case fairUse
  case unreachable
  case signInRequired
  case failed(String)

  public static let fairUseText = "Pro includes up to 20 machines and 20 devices."
  public static let unreachableText = "Couldn't reach hub"

  /// The Upgrade menu item only for a Free limit with a link.
  public var offersUpgrade: Bool { if case .limit(let u) = self { return u != nil } else { return false } }
}

public struct EnsuredTunnel: Equatable, Sendable {
  public let id: String?
  public let hostname: String
  public let tunnelToken: String
}

public final class HubTunnelClient {
  public static let tunnelsPath = "/api/v1/apps/hyprmux/tunnels"
  public static let attemptTimeout: TimeInterval = 4
  public static let retryBackoff: TimeInterval = 2
  public static let totalBudget: TimeInterval = 10

  let transport: HubTransport
  let clock: BridgeClock
  let key: Curve25519.Signing.PrivateKey

  public init(transport: HubTransport, clock: BridgeClock, key: Curve25519.Signing.PrivateKey) {
    self.transport = transport
    self.clock = clock
    self.key = key
  }

  func nowMs() -> Int64 { Int64(clock.now() * 1000) }

  enum Attempt { case done(TunnelState, EnsuredTunnel?), retry(TunnelState, after: TimeInterval?) }

  /// POST /tunnels {port}: Connect bearer + install-key signature; one retry (tunnels_revoked, 503 BUSY,
  /// timeout/network) inside 10 s total (4 s + 2 s + 4 s). A 503 BUSY with Retry-After waits what the hub asked,
  /// at least 2 s and no longer than the 10 s budget leaves for the second attempt.
  public func ensure(port: Int, bearer: String) -> (TunnelState, EnsuredTunnel?) {
    let t0 = clock.now()
    switch attempt(port: port, bearer: bearer) {
    case .done(let s, let t): return (s, t)
    case .retry(_, let after):
      let room = Self.totalBudget - Self.attemptTimeout - (clock.now() - t0)
      clock.sleep(max(Self.retryBackoff, min(after ?? Self.retryBackoff, room)))
      switch attempt(port: port, bearer: bearer) {
      case .done(let s, let t): return (s, t)
      case .retry(let s, _): return (s, nil)
      }
    }
  }

  func attempt(port: Int, bearer: String) -> Attempt {
    let body = "{\"port\":\(port)}"
    guard var headers = try? InstallKeySigner.headers(key: key, method: "POST", path: Self.tunnelsPath, body: body, nowMs: nowMs()) else {
      return .done(.failed("sign"), nil)
    }
    headers["authorization"] = "Bearer \(bearer)"
    headers["content-type"] = "application/json"
    let reply = transport.send(HubRequest(method: "POST", path: Self.tunnelsPath, query: nil, headers: headers, body: body),
                               timeout: Self.attemptTimeout)
    switch reply {
    case .timeout, .network:
      return .retry(.unreachable, after: nil)
    case .response(let status, let data):
      if (200..<300).contains(status) {
        guard let d = HubEnvelope.data(data), let host = d["hostname"] as? String, let tok = d["tunnelToken"] as? String,
              host.range(of: "^[a-z0-9]+\\.hyprmux\\.com$", options: .regularExpression) != nil, !tok.contains("\n") else {
          return .done(.failed("bad_response"), nil)
        }
        let id = d["id"] as? String
        return .done(.ready(id: id, hostname: host), EnsuredTunnel(id: id, hostname: host, tunnelToken: tok))
      }
      let code = HubEnvelope.errorCode(status, data)
      if status == 401 { return .done(.signInRequired, nil) }
      if code == "tunnels_revoked" || status == 503 { return .retry(.unreachable, after: HubEnvelope.retryAfter(data)) }
      if status == 402 && code == "PLAN_LIMIT" || status == 409 && code == "mac_limit" {
        return .done(.limit(upgradeUrl: HubEnvelope.details(data)?["upgradeUrl"] as? String), nil)
      }
      if status == 409 && code == "FAIR_USE_LIMIT" { return .done(.fairUse, nil) }
      return .done(.failed(code), nil)
    }
  }
}

/// Phone access on: ensure, then write tunnel-token (0600, no newline) and register the tunnel agent.
/// Ensures from this Mac run one at a time (flock on ensure.lock, menu + core processes alike): a caller that waited
/// while another ensure succeeded takes that result instead of POSTing again (the hub created two tunnels otherwise).
/// A changed tunnel token restarts the tunnel agent (a running cloudflared keeps the token it started with).
public final class PhoneAccess {
  let state: BridgeState
  let coordinator: AgentCoordinator
  public init(state: BridgeState, coordinator: AgentCoordinator) {
    self.state = state
    self.coordinator = coordinator
  }

  @discardableResult
  public func turnOn(client: HubTunnelClient, port: Int, bearer: String) throws -> TunnelState {
    try state.setPhoneAccess(true)
    let gen = state.ensureGeneration()
    return try state.withEnsureLock {
      let logs = state.paths.logsDir
      if state.ensureGeneration() != gen, state.hasOwnTunnelToken(), let last = state.readLastTunnel() {
        CoreLog.append("tunnel-ensure", [("status", "joined"), ("host", last.hostname), ("id", CoreLog.idPrefix(last.id))], logsDir: logs)
        _ = coordinator.registerRequired()
        publishURL(last.hostname)
        return .ready(id: last.id, hostname: last.hostname)
      }
      let (s, t) = client.ensure(port: port, bearer: bearer)
      guard let t else {
        CoreLog.append("tunnel-ensure", [("status", Self.code(s))], logsDir: logs)
        return s
      }
      CoreLog.append("tunnel-ensure", [("status", "ready"), ("host", t.hostname), ("id", CoreLog.idPrefix(t.id))], logsDir: logs)
      let old = state.readTunnelToken()
      try state.writeTunnelToken(t.tunnelToken)
      try state.writeLastTunnel(LastTunnel(id: t.id, hostname: t.hostname))
      try state.bumpEnsureGeneration()
      _ = coordinator.registerRequired()
      if let old, old != t.tunnelToken, coordinator.wantsTunnel {
        let r = (try? coordinator.agents.restart(.tunnel)) != nil
        CoreLog.append("agent-restart", [("agent", "tunnel"), ("reason", "token_changed"), ("result", r ? "ok" : "failed")], logsDir: logs)
      }
      publishURL(t.hostname)
      return s
    }
  }

  /// server.js reads PUBLIC_URL (the pairing QR's u=) from the env file only at start: write the ensured hostname
  /// and restart the server agent when it changed, so a pairing never points at a dead host.
  func publishURL(_ hostname: String) {
    let logs = state.paths.logsDir
    guard let changed = try? state.setEnvValue("PUBLIC_URL", "https://\(hostname)") else {
      CoreLog.append("public-url", [("result", "write_failed")], logsDir: logs)
      return
    }
    guard changed else { return }
    let agents = coordinator.agents
    let r = agents.isRegistered(.server) ? ((try? agents.restart(.server)) != nil ? "ok" : "failed") : "not_registered"
    CoreLog.append("agent-restart", [("agent", "server"), ("reason", "public_url_changed"), ("host", hostname), ("result", r)], logsDir: logs)
  }

  static func code(_ s: TunnelState) -> String {
    switch s {
    case .ready: return "ready"
    case .limit: return "limit"
    case .fairUse: return "fair_use"
    case .unreachable: return "unreachable"
    case .signInRequired: return "sign_in_required"
    case .failed(let c): return "failed_" + c
    }
  }
}

public struct LastTunnel: Codable, Equatable, Sendable {
  public var id: String?
  public var hostname: String
}

extension BridgeState {
  public func ensureGeneration() -> Int {
    Int((try? String(contentsOfFile: paths.ensureGenPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
  }
  func bumpEnsureGeneration() throws { try Self.writePrivate(paths.ensureGenPath, "\(ensureGeneration() + 1)\n") }

  /// Exclusive flock on ensure.lock for the whole ensure (blocks; separate opens contend even in one process).
  func withEnsureLock<T>(_ body: () throws -> T) throws -> T {
    try Self.mkdirPrivate(paths.stateDir)
    let fd = open(paths.ensureLockPath, O_RDWR | O_CREAT, 0o600)
    guard fd >= 0 else { throw BridgeError.io("ensure lock") }
    defer { flock(fd, LOCK_UN); close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw BridgeError.io("ensure lock") }
    return try body()
  }

  public var lastTunnelPath: String { paths.stateDir + "/last-tunnel.json" }
  public func writeLastTunnel(_ t: LastTunnel) throws {
    try Self.writePrivate(lastTunnelPath, String(decoding: try JSONEncoder().encode(t), as: UTF8.self))
  }
  public func readLastTunnel() -> LastTunnel? {
    FileManager.default.contents(atPath: lastTunnelPath).flatMap { try? JSONDecoder().decode(LastTunnel.self, from: $0) }
  }
}
