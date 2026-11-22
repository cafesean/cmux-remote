import Foundation
import CryptoKit

/// The wired account + phone-access path used by the menu app and the core agent.
public final class BridgeSession {
  public static let hubTimeout: TimeInterval = 10
  public static let planRecheckSeconds: TimeInterval = 300

  public let config: ConnectConfig
  let hub: HubTransport
  let auth: HubTransport
  let state: BridgeState
  let owner: OwnerFiles
  let coordinator: AgentCoordinator
  let agents: AgentService
  let clock: BridgeClock
  let key: Curve25519.Signing.PrivateKey
  public let queue: TunnelDeleteQueue
  public let poller: CheckoutPoller
  var lastSnapshot: EntitlementSnapshot?
  var lastPlanCheck: TimeInterval = -.infinity
  public private(set) var tunnelState: TunnelState?
  public private(set) var plan: String?

  public init(config: ConnectConfig, hub: HubTransport, auth: HubTransport, state: BridgeState, owner: OwnerFiles,
              coordinator: AgentCoordinator, agents: AgentService, clock: BridgeClock, key: Curve25519.Signing.PrivateKey) {
    self.config = config
    self.hub = hub
    self.auth = auth
    self.state = state
    self.owner = owner
    self.coordinator = coordinator
    self.agents = agents
    self.clock = clock
    self.key = key
    queue = TunnelDeleteQueue(path: state.paths.pendingTunnelDeletePath, transport: hub, clock: clock, key: key)
    poller = CheckoutPoller(clock: clock)
  }

  public var ownerSub: String? { owner.readOwner().ownerSub }
  var bearer: String? {
    guard let t = owner.readAccessToken(), t.ownerSub == ownerSub, t.ownerEpoch == owner.readOwner().ownerEpoch else { return nil }
    return t.accessToken
  }

  // MARK: OIDC

  public struct Endpoints: Equatable { public var authorize: String; public var token: String }

  public func discover() -> Endpoints? { discoverWithStatus().endpoints }

  func discoverWithStatus() -> (endpoints: Endpoints?, status: Int?) {
    let r = auth.send(HubRequest(method: "GET", path: "/.well-known/openid-configuration", query: nil, headers: [:], body: nil),
                      timeout: Self.hubTimeout)
    guard case .response(let s, let d) = r else { return (nil, nil) }
    guard s == 200, let j = HubEnvelope.json(d), let a = j["authorization_endpoint"] as? String,
          let t = j["token_endpoint"] as? String else { return (nil, s) }
    return (Endpoints(authorize: a, token: t), s)
  }

  /// Appends one sign-in step to logs/core.log (step, http status, error code only).
  public func logSignIn(_ step: String, status: Int? = nil, error: String? = nil) {
    SignInLog.append(SignInLog.line(step: step, status: status, error: error, at: Date(timeIntervalSince1970: clock.now())),
                     logsDir: state.paths.logsDir)
  }

  /// Logs a failure the menu saw (window, cancel, browser error) and returns its menu line.
  public func signInFailed(_ f: SignInFailure, step: String) -> String {
    logSignIn(step, error: f.logCode)
    return f.text
  }

  public struct PendingSignIn: Equatable { public let url: URL; public let verifier: String; public let state: String; public let token: String }

  /// nil = sign-in hidden (no client id) or the issuer is unreachable; beginSignInResult says which.
  public func beginSignIn() -> PendingSignIn? { try? beginSignInResult().get() }

  public func beginSignInResult() -> Result<PendingSignIn, SignInFailure> {
    guard config.signInVisible else { logSignIn("begin", error: SignInFailure.noClientId.logCode); return .failure(.noClientId) }
    let (found, status) = discoverWithStatus()
    guard let ep = found else { logSignIn("discover", status: status, error: SignInFailure.unreachable.logCode); return .failure(.unreachable) }
    logSignIn("discover", status: status)
    var c = config
    c.issuer = ""
    let v = ConnectAuth.verifier()
    let st = ConnectAuth.verifier()
    guard let base = ConnectAuth.authorizeURL(c, verifier: v, state: st),
          var comps = URLComponents(string: ep.authorize) else {
      logSignIn("authorize_url", error: SignInFailure.unreachable.logCode); return .failure(.unreachable)
    }
    comps.queryItems = URLComponents(url: base, resolvingAgainstBaseURL: false)?.queryItems
    guard let url = comps.url else { logSignIn("authorize_url", error: SignInFailure.unreachable.logCode); return .failure(.unreachable) }
    return .success(PendingSignIn(url: url, verifier: v, state: st, token: ep.token))
  }

  static func form(_ items: [(String, String)]) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return items.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
  }

  struct Tokens { let access: String; let refresh: String?; let exp: TimeInterval; let sub: String }

  func tokenCall(_ endpoint: String, _ items: [(String, String)]) -> Result<Tokens, SignInFailure> {
    let r = auth.send(HubRequest(method: "POST", path: endpoint, query: nil,
                                 headers: ["content-type": "application/x-www-form-urlencoded"], body: Self.form(items)),
                      timeout: Self.hubTimeout)
    guard case .response(let s, let d) = r else { return .failure(.token(status: nil, error: nil)) }
    guard s == 200 else { return .failure(.token(status: s, error: SignInFailure.safeCode(HubEnvelope.errorCode(s, d)))) }
    guard let j = HubEnvelope.json(d), let at = j["access_token"] as? String,
          let sub = Self.jwtSub(at) else { return .failure(.tokenResponse) }
    let exp = clock.now() + ((j["expires_in"] as? Double) ?? 300)
    return .success(Tokens(access: at, refresh: j["refresh_token"] as? String, exp: exp, sub: sub))
  }

  static func jwtSub(_ jwt: String) -> String? {
    let parts = jwt.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var s = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    guard let d = Data(base64Encoded: s), let j = HubEnvelope.json(d) else { return nil }
    return j["sub"] as? String
  }

  /// Callback → code → tokens. A new person = owner change (R8) first; then refresh token (Keychain) and access file.
  @discardableResult
  public func completeSignIn(_ pending: PendingSignIn, callback: URL?) -> SignInState {
    let c: String
    switch ConnectAuth.code(fromCallback: callback, expectedState: pending.state) {
    case .failure(let f): logSignIn("callback", error: f.logCode); return .signedOut(message: f.text)
    case .success(let got): c = got; logSignIn("callback")
    }
    let r = tokenCall(pending.token, [("grant_type", "authorization_code"), ("code", c), ("redirect_uri", config.redirectURI),
                                      ("client_id", config.clientId), ("code_verifier", pending.verifier), ("resource", config.resource)])
    let t: Tokens
    switch r {
    case .failure(let f):
      if case .token(let s, _) = f { logSignIn("token", status: s, error: f.logCode) } else { logSignIn("token", status: 200, error: f.logCode) }
      return .signedOut(message: f.text)
    case .success(let got) where got.refresh == nil:
      logSignIn("token", status: 200, error: SignInFailure.tokenResponse.logCode)
      return .signedOut(message: SignInFailure.tokenResponse.text)
    case .success(let got): t = got; logSignIn("token", status: 200)
    }
    let refresh = t.refresh!
    do {
      let cur = owner.readOwner()
      if cur.ownerSub != t.sub {
        if cur.ownerSub != nil {
          try OwnerChange(state: state, coordinator: coordinator, agents: agents, owner: owner, queue: queue, clock: clock).run(newOwner: t.sub)
        } else {
          try owner.writeOwner(OwnerRecord(ownerSub: t.sub, ownerEpoch: cur.ownerEpoch + 1))
        }
      }
      try owner.storeRefreshToken(refresh)
      let o = owner.readOwner()
      try owner.writeAccessToken(OwnerAccessToken(ownerSub: t.sub, ownerEpoch: o.ownerEpoch, accessToken: t.access, exp: t.exp))
    } catch {
      logSignIn("save", error: SignInFailure.saveFailed.logCode)
      return .signedOut(message: SignInFailure.saveFailed.text)
    }
    logSignIn("done")
    return .signedIn(ownerSub: t.sub)
  }

  /// Core: refresh 60 s before expiry. invalid_grant (revoked) → sign-out; a network failure keeps the owner.
  public func refreshIfNeeded(tokenEndpoint: String?) {
    guard let sub = ownerSub, owner.needsRefresh(now: clock.now()), let rt = owner.refreshToken(), let ep = tokenEndpoint else { return }
    let r = auth.send(HubRequest(method: "POST", path: ep, query: nil, headers: ["content-type": "application/x-www-form-urlencoded"],
                                 body: Self.form([("grant_type", "refresh_token"), ("refresh_token", rt), ("client_id", config.clientId),
                                                  ("resource", config.resource)])), timeout: Self.hubTimeout)
    if case .response(let s, let d) = r, s == 400 || s == 401, HubEnvelope.errorCode(s, d) == "invalid_grant" {
      try? signOut()
      return
    }
    guard case .response(200, let d) = r, let j = HubEnvelope.json(d), let at = j["access_token"] as? String else { return }
    if let newRT = j["refresh_token"] as? String { try? owner.storeRefreshToken(newRT) }
    let exp = clock.now() + ((j["expires_in"] as? Double) ?? 300)
    try? owner.writeAccessToken(OwnerAccessToken(ownerSub: sub, ownerEpoch: owner.readOwner().ownerEpoch, accessToken: at, exp: exp))
  }

  public func signOut() throws {
    try OwnerChange(state: state, coordinator: coordinator, agents: agents, owner: owner, queue: queue, clock: clock).run(newOwner: nil)
  }

  // MARK: plan

  /// GET /entitlement (owner) → plan + snapshot.
  public func readEntitlement(for sub: String? = nil) -> (plan: String, snapshot: EntitlementSnapshot)? {
    guard let b = bearer, sub == nil || sub == ownerSub else { return nil }
    let r = hub.send(HubRequest(method: "GET", path: "/api/v1/apps/hyprmux/entitlement", query: nil,
                                headers: ["authorization": "Bearer \(b)"], body: nil), timeout: Self.hubTimeout)
    guard case .response(200, let d) = r else { return nil }
    let j = HubEnvelope.data(d) ?? HubEnvelope.json(d)
    guard let e = (j?["entitlement"] as? [String: Any]) ?? j, let plan = e["plan"] as? String else { return nil }
    let enforced = e["enforced"] as? Bool == true
    let atLimit = tunnelState.map { if case .limit = $0 { return true } else { return false } } ?? false
    // A paid plan, or enforcement off, lifts a Free limit the last ensure hit.
    let snap = EntitlementSnapshot(enforced: enforced, tunnelAllowed: !atLimit || !enforced || plan != "free")
    self.plan = plan
    return (plan, snap)
  }

  /// Core: plan re-check every 300 s; one re-ensure on the refresh that unblocks the tunnel, only while Phone access is on.
  public func planRecheck(port: Int, force: Bool = false) {
    let now = clock.now()
    guard force || now - lastPlanCheck >= Self.planRecheckSeconds else { return }
    lastPlanCheck = now
    guard let (_, snap) = readEntitlement() else { return }
    if ReEnsurePolicy.shouldEnsure(previous: lastSnapshot, current: snap, phoneAccessOn: state.phoneAccessOn) {
      _ = setPhoneAccess(true, port: port)
    }
    lastSnapshot = snap
  }

  // MARK: phone access

  @discardableResult
  public func setPhoneAccess(_ on: Bool, port: Int) -> TunnelState? {
    if on {
      guard let b = bearer else { tunnelState = .signInRequired; return tunnelState }
      let c = HubTunnelClient(transport: hub, clock: clock, key: key)
      tunnelState = (try? PhoneAccess(state: state, coordinator: coordinator).turnOn(client: c, port: port, bearer: b)) ?? .failed("io")
      if case .limit = tunnelState { lastSnapshot = EntitlementSnapshot(enforced: true, tunnelAllowed: false) }
      return tunnelState
    }
    try? agents.unregister(.tunnel)
    try? state.setPhoneAccess(false)
    if let sub = ownerSub, let last = state.readLastTunnel() {
      let now = clock.now()
      try? queue.append(PendingTunnelDelete(ownerSub: sub, epoch: owner.readOwner().ownerEpoch, tunnelId: last.id,
                                            hostname: last.hostname, at: now, nextAttempt: now, inFlight: false))
      try? queue.process()
    }
    tunnelState = nil
    return nil
  }

  /// One core pass: delete queue, token refresh, plan re-check, checkout poll.
  public func coreTick(port: Int, tokenEndpoint: String?) {
    try? queue.process()
    refreshIfNeeded(tokenEndpoint: tokenEndpoint)
    planRecheck(port: port)
    poller.tick(currentOwner: ownerSub) { readEntitlement(for: $0)?.plan }
  }

  // MARK: devices + upgrade

  public func devices() -> [HubDevice] {
    guard let b = bearer else { return [] }
    let r = hub.send(HubRequest(method: "GET", path: "/api/v1/apps/hyprmux/devices", query: nil,
                                headers: ["authorization": "Bearer \(b)"], body: nil), timeout: Self.hubTimeout)
    guard case .response(200, let d) = r else { return [] }
    let j = HubEnvelope.data(d) ?? HubEnvelope.json(d)
    return ((j?["devices"] as? [[String: Any]]) ?? []).compactMap {
      guard let id = $0["id"] as? String, let dev = $0["deviceId"] as? String else { return nil }
      return HubDevice(id: id, deviceId: dev)
    }
  }

  public func removeFromPlan(hubDeviceId: String, localId: String, server: LocalServer) -> Bool {
    guard let b = bearer else { return false }
    return DeviceRemoval.remove(hubDeviceId: hubDeviceId, localId: localId, rows: devices(), transport: hub, bearer: b, server: server)
  }

  /// Upgrade (Free only): checkout returnTo bridge, then poll 10 s x 15 min fenced to this owner.
  public func upgrade() -> URL? {
    guard let b = bearer, let sub = ownerSub, let url = CheckoutPoller.startCheckout(transport: hub, bearer: b) else { return nil }
    poller.begin(ownerSub: sub)
    return url
  }

  /// hyprmux-bridge://billing/done
  public func handleURL(_ url: URL) {
    guard url.scheme == "hyprmux-bridge", url.host == "billing", url.path == "/done" else { return }
    poller.billingDone(currentOwner: ownerSub) { readEntitlement(for: $0)?.plan }
  }
}
