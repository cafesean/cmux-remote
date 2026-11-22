import XCTest
import CryptoKit
@testable import BridgeCore

/// Local stub hub + issuer behind URLProtocol: the wired path runs real URLSession requests.
final class StubHubProtocol: URLProtocol {
  struct Seen { let method: String; let url: URL; let headers: [String: String]; let body: String }
  nonisolated(unsafe) static var seen: [Seen] = []
  nonisolated(unsafe) static var handler: ((Seen) -> (Int, Any))?
  nonisolated(unsafe) static var clock: FakeClock?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body = request.httpBody ?? Data()
    if body.isEmpty, let s = request.httpBodyStream {
      s.open(); var buf = [UInt8](repeating: 0, count: 65536)
      while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
      s.close()
    }
    let seen = Seen(method: request.httpMethod ?? "GET", url: request.url!,
                    headers: (request.allHTTPHeaderFields ?? [:]).reduce(into: [:]) { $0[$1.key.lowercased()] = $1.value },
                    body: String(decoding: body, as: UTF8.self))
    Self.seen.append(seen)
    let (status, obj) = Self.handler?(seen) ?? (404, [:])
    if status < 0 { // hub never answers: burn the request timeout on the fake clock, then time out
      Self.clock?.t += request.timeoutInterval
      client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
      return
    }
    let data = (obj as? Data) ?? (try! JSONSerialization.data(withJSONObject: obj))
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
                        cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

class WiredTests: XCTestCase {
  var home = ""
  var state: BridgeState!
  var agents: FakeAgents!
  var coord: AgentCoordinator!
  var clock: FakeClock!
  var session: BridgeSession!
  var kc: FakeKeychain!
  let key = Curve25519.Signing.PrivateKey()
  var plan = "free"
  var enforced = true
  var tunnelN = 0
  var nextSub = "A"

  static func jwt(_ sub: String) -> String {
    let p = InstallKeySigner.b64url(try! JSONSerialization.data(withJSONObject: ["sub": sub]))
    return "e30.\(p).sig"
  }

  override func setUpWithError() throws {
    home = NSTemporaryDirectory() + "wired-\(UUID().uuidString)"
    let paths = BridgePaths(home: home)
    state = BridgeState(paths: paths)
    try state.ensure()
    try state.retireC3IfFirstLaunch()
    agents = FakeAgents()
    coord = AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: Launchctl(runner: StubRunner(), uid: 501),
                                                                 launchAgentsDir: home + "/none"), state: state)
    clock = FakeClock(); clock.t = 2_000_000
    StubHubProtocol.clock = clock
    kc = FakeKeychain()
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubHubProtocol.self]
    let us = URLSession(configuration: cfg)
    StubHubProtocol.seen = []
    StubHubProtocol.handler = { [unowned self] r in
      switch (r.method, r.url.path) {
      case ("GET", "/.well-known/openid-configuration"):
        return (200, ["authorization_endpoint": "https://auth.example.test/oauth/authorize", "token_endpoint": "https://auth.example.test/oauth/token"])
      case ("POST", "/oauth/token"):
        if r.body.contains("grant_type=refresh_token") { return (200, ["access_token": Self.jwt(nextSub), "expires_in": 600]) }
        return (200, ["access_token": Self.jwt(nextSub), "refresh_token": "RT-\(nextSub)", "expires_in": 600])
      case ("POST", "/api/v1/apps/hyprmux/tunnels"):
        tunnelN += 1
        if enforced && plan == "free" && tunnelN == 1 {
          return (402, ["success": false, "error": ["code": "PLAN_LIMIT", "details": ["code": "PLAN_LIMIT", "upgradeUrl": "https://hyprmux.com/pricing"]]])
        }
        return (200, ["success": true, "data": ["id": "t\(tunnelN)", "hostname": "abc\(tunnelN).hyprmux.com", "tunnelToken": "tok-\(tunnelN)"]])
      case ("GET", "/api/v1/apps/hyprmux/entitlement"):
        return (200, ["success": true, "data": ["plan": plan, "enforced": enforced]])
      case ("POST", "/api/v1/apps/hyprmux/billing/checkout"):
        return (200, ["success": true, "data": ["url": "https://checkout.example.test/s/1"]])
      case ("GET", "/api/v1/apps/hyprmux/devices"):
        return (200, ["success": true, "data": ["devices": [["id": "r9", "deviceId": "d-phone"]]]])
      case ("DELETE", "/api/v1/apps/hyprmux/devices/r9"): return (204, Data())
      case ("DELETE", "/api/v1/apps/hyprmux/tunnels/me"): return (204, Data())
      case ("DELETE", "/api/pair/devices/k1"): return (200, ["ok": true])
      default: return (404, [:])
      }
    }
    session = BridgeSession(config: ConnectConfig(clientId: "client-1"),
                            hub: HTTPHubTransport(base: URL(string: "https://hub.example.test")!, session: us),
                            auth: HTTPHubTransport(base: URL(string: "https://auth.example.test")!, session: us),
                            state: state, owner: OwnerFiles(paths: paths, keychain: kc), coordinator: coord, agents: agents,
                            clock: clock, key: key)
    self.urlSession = us
  }
  var urlSession: URLSession!

  override func tearDownWithError() throws { try? FileManager.default.removeItem(atPath: home) }

  func calls(_ method: String, _ path: String) -> [StubHubProtocol.Seen] { StubHubProtocol.seen.filter { $0.method == method && $0.url.path == path } }

  func signIn(_ sub: String = "A") throws -> BridgeSession.PendingSignIn {
    nextSub = sub
    let p = try XCTUnwrap(session.beginSignIn())
    let cb = URL(string: "hyprmux-bridge://oidc-callback?code=c1&state=\(p.state)")
    XCTAssertEqual(session.completeSignIn(p, callback: cb), .signedIn(ownerSub: sub))
    return p
  }

  func testWiredSignInTunnelRefreshUpgradeSignOut() throws {
    // sign-in: discovery, PKCE authorize URL, code -> token exchange
    let p = try signIn()
    XCTAssertEqual(p.url.host, "auth.example.test")
    XCTAssertTrue(p.url.absoluteString.contains("redirect_uri=hyprmux-bridge://oidc-callback"))
    let tok = try XCTUnwrap(calls("POST", "/oauth/token").first)
    XCTAssertTrue(tok.body.contains("grant_type=authorization_code") && tok.body.contains("code_verifier=\(p.verifier)"))
    XCTAssertEqual(kc.items["ai.yobolabs.hyprmux.bridge/connect-refresh"], Data("RT-A".utf8))
    let at = try String(contentsOfFile: state.paths.hubAccessTokenPath, encoding: .utf8)
    XCTAssertFalse(at.contains("RT-A"))

    // phone access: Free at the limit -> limit + upgrade link, no token
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .limit(upgradeUrl: "https://hyprmux.com/pricing"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.paths.tunnelTokenPath))
    let ens = try XCTUnwrap(calls("POST", "/api/v1/apps/hyprmux/tunnels").first)
    XCTAssertEqual(ens.headers["authorization"], "Bearer \(Self.jwt("A"))")
    XCTAssertNotNil(ens.headers["x-hmx-sig"])

    // upgrade: checkout returnTo bridge; billing/done -> one entitlement read of the owner
    XCTAssertEqual(session.upgrade()?.host, "checkout.example.test")
    XCTAssertEqual(calls("POST", "/api/v1/apps/hyprmux/billing/checkout").first?.body, #"{"plan":"pro","returnTo":"bridge"}"#)
    plan = "pro"
    let before = calls("GET", "/api/v1/apps/hyprmux/entitlement").count
    session.handleURL(URL(string: "hyprmux-bridge://billing/done")!)
    XCTAssertEqual(calls("GET", "/api/v1/apps/hyprmux/entitlement").count, before + 1)
    XCTAssertFalse(session.poller.active)

    // core tick: plan re-check unblocks -> one re-ensure (Phone access on) -> tunnel-token + agent
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertEqual(calls("POST", "/api/v1/apps/hyprmux/tunnels").count, 2)
    XCTAssertEqual(try String(contentsOfFile: state.paths.tunnelTokenPath, encoding: .utf8), "tok-2")
    XCTAssertTrue(agents.registered.contains(.tunnel))
    session.coreTick(port: 4123, tokenEndpoint: p.token) // within 300 s: no new POST
    XCTAssertEqual(calls("POST", "/api/v1/apps/hyprmux/tunnels").count, 2)

    // refresh 60 s before expiry
    clock.t += 545
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertEqual(calls("POST", "/oauth/token").filter { $0.body.contains("grant_type=refresh_token") }.count, 1)
    XCTAssertFalse(OwnerFiles(paths: state.paths, keychain: kc).needsRefresh(now: clock.t))

    // Devices… Remove from plan: hub row by deviceId, then exactly that local key over loopback
    let local = LoopbackServer(transport: HTTPHubTransport(base: URL(string: "http://127.0.0.1:4123")!, session: urlSession), token: "ST")
    XCTAssertTrue(session.removeFromPlan(hubDeviceId: "d-phone", localId: "k1", server: local))
    XCTAssertEqual(calls("DELETE", "/api/v1/apps/hyprmux/devices/r9").count, 1)
    XCTAssertEqual(calls("DELETE", "/api/pair/devices/k1").first?.headers["authorization"], "Bearer ST")

    // sign-out: tunnel down first, install-key DELETE ?id=t2 (no bearer), credentials gone
    try session.signOut()
    XCTAssertFalse(agents.registered.contains(.tunnel))
    let del = try XCTUnwrap(calls("DELETE", "/api/v1/apps/hyprmux/tunnels/me").last)
    XCTAssertEqual(del.url.query, "id=t2")
    XCTAssertNil(del.headers["authorization"])
    XCTAssertNotNil(del.headers["x-hmx-sig"])
    XCTAssertNil(session.ownerSub)
    XCTAssertNil(kc.items["ai.yobolabs.hyprmux.bridge/connect-refresh"])
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.paths.hubAccessTokenPath))
  }

  func testWiredAuthorizeErrorAndHiddenSignIn() throws {
    let p = try XCTUnwrap(session.beginSignIn())
    XCTAssertEqual(session.completeSignIn(p, callback: URL(string: "hyprmux-bridge://oidc-callback?error=redirect_uri_mismatch")),
                   .signedOut(message: SignInState.unavailableText))
    XCTAssertNil(session.ownerSub)
    XCTAssertEqual(session.setPhoneAccess(true, port: 1), .signInRequired)
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core]))
    let hidden = BridgeSession(config: ConnectConfig(clientId: ""), hub: HTTPHubTransport(base: URL(string: "https://hub.example.test")!),
                               auth: HTTPHubTransport(base: URL(string: "https://auth.example.test")!), state: state,
                               owner: OwnerFiles(paths: state.paths, keychain: kc), coordinator: coord, agents: agents, clock: clock, key: key)
    XCTAssertNil(hidden.beginSignIn())
  }

  func testWiredFairUseNoUpgrade() throws {
    _ = try signIn()
    StubHubProtocol.handler = { r in
      r.url.path == "/api/v1/apps/hyprmux/tunnels"
        ? (409, ["success": false, "error": ["code": "FAIR_USE_LIMIT", "details": ["code": "FAIR_USE_LIMIT", "limit": "machines", "max": 20]]])
        : (404, [:])
    }
    let s = session.setPhoneAccess(true, port: 1)
    XCTAssertEqual(s, .fairUse)
    XCTAssertFalse(s!.offersUpgrade)
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.paths.tunnelTokenPath))
  }
}
