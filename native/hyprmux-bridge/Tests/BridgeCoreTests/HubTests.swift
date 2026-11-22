import XCTest
import CryptoKit
@testable import BridgeCore

/// Scripted hub: each reply consumes clock time like a real exchange (a timeout burns the full timeout).
final class StubHub: HubTransport {
  var replies: [HubReply] = []
  var sent: [HubRequest] = []
  var onSend: ((HubRequest) -> Void)?
  let clock: FakeClock
  init(_ clock: FakeClock) { self.clock = clock }
  func send(_ r: HubRequest, timeout: TimeInterval) -> HubReply {
    onSend?(r)
    sent.append(r)
    let reply = replies.isEmpty ? .timeout : replies.removeFirst()
    if reply == .timeout { clock.t += timeout }
    return reply
  }
  static func ok(_ data: [String: Any]) -> HubReply {
    .response(status: 200, body: try! JSONSerialization.data(withJSONObject: ["success": true, "data": data]))
  }
  static func err(_ status: Int, _ code: String, _ details: [String: Any] = [:]) -> HubReply {
    var d = details; d["code"] = code
    return .response(status: status, body: try! JSONSerialization.data(withJSONObject: ["success": false, "error": ["code": code, "details": d]]))
  }
}

final class FakeServer: LocalServer {
  var revoked: [String] = []
  func revokeDevice(localId: String) -> Bool { revoked.append(localId); return true }
}

final class HubTests: XCTestCase {
  var home = ""
  var paths: BridgePaths!
  var state: BridgeState!
  var agents: FakeAgents!
  var coord: AgentCoordinator!
  var clock: FakeClock!
  var hub: StubHub!
  var kc: FakeKeychain!
  let key = Curve25519.Signing.PrivateKey()

  override func setUpWithError() throws {
    home = NSTemporaryDirectory() + "hub-\(UUID().uuidString)"
    paths = BridgePaths(home: home)
    state = BridgeState(paths: paths)
    try state.ensure()
    try state.retireC3IfFirstLaunch()
    agents = FakeAgents()
    coord = AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: Launchctl(runner: StubRunner(), uid: 501),
                                                                 launchAgentsDir: home + "/none"), state: state)
    clock = FakeClock()
    clock.t = 1_000_000
    hub = StubHub(clock)
    kc = FakeKeychain()
  }

  override func tearDownWithError() throws { try? FileManager.default.removeItem(atPath: home) }

  func client() -> HubTunnelClient { HubTunnelClient(transport: hub, clock: clock, key: key) }
  func queue() -> TunnelDeleteQueue {
    TunnelDeleteQueue(path: paths.pendingTunnelDeletePath, transport: hub, clock: clock, key: key)
  }
  func mode(_ p: String) throws -> Int { ((try FileManager.default.attributesOfItem(atPath: p)[.posixPermissions]) as! NSNumber).intValue }
  let good: [String: Any] = ["id": "t1", "hostname": "abc123.hyprmux.com", "tunnelToken": "tok-1"]

  // AC0
  func testEnsureWritesTokenAndSigns() throws {
    hub.replies = [StubHub.ok(good)]
    let s = try PhoneAccess(state: state, coordinator: coord).turnOn(client: client(), port: 4123, bearer: "AT")
    XCTAssertEqual(s, .ready(id: "t1", hostname: "abc123.hyprmux.com"))
    XCTAssertEqual(try String(contentsOfFile: paths.tunnelTokenPath, encoding: .utf8), "tok-1")
    XCTAssertEqual(try mode(paths.tunnelTokenPath), 0o600)
    XCTAssertTrue(agents.registered.contains(.tunnel))
    let r = hub.sent[0]
    XCTAssertEqual(r.headers["authorization"], "Bearer AT")
    XCTAssertEqual(r.path, "/api/v1/apps/hyprmux/tunnels")
    let msg = InstallKeySigner.signingString(method: "POST", path: r.path, ts: r.headers["x-hmx-ts"]!, body: r.body!)
    XCTAssertEqual(msg.split(separator: "\n").count, 4)
    func unb64(_ s: String) -> Data {
      var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      while t.count % 4 != 0 { t += "=" }
      return Data(base64Encoded: t)!
    }
    let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unb64(r.headers["x-hmx-key"]!))
    XCTAssertTrue(pub.isValidSignature(unb64(r.headers["x-hmx-sig"]!), for: Data(msg.utf8)))
  }

  // AC1 + AC12
  func testRetryAndLimits() {
    hub.replies = [StubHub.err(409, "tunnels_revoked"), StubHub.ok(good)]
    XCTAssertEqual(client().ensure(port: 1, bearer: "AT").0, .ready(id: "t1", hostname: "abc123.hyprmux.com"))
    XCTAssertEqual(hub.sent.count, 2)
    hub.sent = []
    hub.replies = [StubHub.err(402, "PLAN_LIMIT", ["upgradeUrl": "https://hyprmux.com/pricing"])]
    let lim = client().ensure(port: 1, bearer: "AT")
    XCTAssertEqual(lim.0, .limit(upgradeUrl: "https://hyprmux.com/pricing"))
    XCTAssertNil(lim.1)
    XCTAssertTrue(lim.0.offersUpgrade)
    hub.replies = [StubHub.err(409, "mac_limit", ["upgradeUrl": "https://hyprmux.com/pricing"])]
    XCTAssertEqual(client().ensure(port: 1, bearer: "AT").0, .limit(upgradeUrl: "https://hyprmux.com/pricing"))
    hub.replies = [StubHub.err(409, "FAIR_USE_LIMIT", ["limit": "machines", "max": 20])]
    let fu = client().ensure(port: 1, bearer: "AT")
    XCTAssertEqual(fu.0, .fairUse)
    XCTAssertFalse(fu.0.offersUpgrade)
    XCTAssertEqual(TunnelState.fairUseText, "Pro includes up to 20 machines and 20 devices.")
    XCTAssertFalse(FileManager.default.fileExists(atPath: paths.tunnelTokenPath))
  }

  // AC5
  func testTimeoutBudgetAndBusy() {
    let t0 = clock.t
    XCTAssertEqual(client().ensure(port: 1, bearer: "AT").0, .unreachable)
    XCTAssertEqual(clock.t - t0, 10)
    XCTAssertEqual(hub.sent.count, 2)
    XCTAssertEqual(TunnelState.unreachableText, "Couldn't reach hub")
    hub.sent = []
    let t1 = clock.t
    hub.replies = [StubHub.err(503, "BUSY"), StubHub.ok(good)]
    XCTAssertEqual(client().ensure(port: 1, bearer: "AT").0, .ready(id: "t1", hostname: "abc123.hyprmux.com"))
    XCTAssertEqual(hub.sent.count, 2)
    XCTAssertLessThanOrEqual(clock.t - t1, 10)
  }

  // AC2
  func testAuthorizeErrorStaysSignedOut() throws {
    let c = ConnectConfig(clientId: "client")
    XCTAssertTrue(c.signInVisible)
    XCTAssertFalse(ConnectConfig(clientId: "").signInVisible)
    let v = ConnectAuth.verifier()
    let url = ConnectAuth.authorizeURL(c, verifier: v, state: "s1")!.absoluteString
    XCTAssertTrue(url.contains("redirect_uri=hyprmux-bridge://oidc-callback"))
    XCTAssertTrue(url.contains("code_challenge_method=S256"))
    let r = ConnectAuth.code(fromCallback: URL(string: "hyprmux-bridge://oidc-callback?error=redirect_uri_mismatch&state=s1"), expectedState: "s1")
    XCTAssertEqual(ConnectAuth.stateAfter(r, ownerSub: nil), .signedOut(message: "Sign-in isn't available yet"))
    XCTAssertEqual(ConnectAuth.code(fromCallback: nil, expectedState: "s1"), .failure(.unavailable))
    XCTAssertEqual(ConnectAuth.code(fromCallback: URL(string: "hyprmux-bridge://oidc-callback?code=x&state=s1"), expectedState: "s1"), .success("x"))
    // local pairing still works: the base set registers without any sign-in
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core]))
  }

  // AC3
  func testAccessTokenFile() throws {
    let o = OwnerFiles(paths: paths, keychain: kc)
    try o.writeOwner(OwnerRecord(ownerSub: "A", ownerEpoch: 1))
    let t = OwnerAccessToken(ownerSub: "A", ownerEpoch: 1, accessToken: "AT", exp: clock.t + 600)
    XCTAssertThrowsError(try o.writeAccessToken(t)) // no credentials yet
    try o.storeRefreshToken("RT")
    try o.writeAccessToken(t)
    XCTAssertEqual(try mode(paths.hubAccessTokenPath), 0o600)
    let text = try String(contentsOfFile: paths.hubAccessTokenPath, encoding: .utf8)
    XCTAssertTrue(text.contains("AT"))
    XCTAssertFalse(text.contains("RT"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: paths.hubAccessTokenPath + ".tmp"))
    XCTAssertFalse(o.needsRefresh(now: clock.t + 500))
    XCTAssertTrue(o.needsRefresh(now: clock.t + 541))
    o.deleteCredentials()
    XCTAssertFalse(FileManager.default.fileExists(atPath: paths.hubAccessTokenPath))
    XCTAssertNil(o.refreshToken())
  }

  func signedIn(_ sub: String, epoch: Int) throws -> OwnerFiles {
    let o = OwnerFiles(paths: paths, keychain: kc)
    try o.writeOwner(OwnerRecord(ownerSub: sub, ownerEpoch: epoch))
    try o.storeRefreshToken("RT-\(sub)")
    try o.writeAccessToken(OwnerAccessToken(ownerSub: sub, ownerEpoch: epoch, accessToken: "AT-\(sub)", exp: clock.t + 600))
    return o
  }

  // AC7
  func testSignOutOrder() throws {
    hub.replies = [StubHub.ok(good)]
    let o = try signedIn("A", epoch: 1)
    let q = queue()
    try PhoneAccess(state: state, coordinator: coord).turnOn(client: client(), port: 1, bearer: "AT-A")
    FileManager.default.createFile(atPath: paths.planCachePath, contents: Data("{}".utf8))
    FileManager.default.createFile(atPath: paths.installPolicyPath, contents: Data("{}".utf8))
    hub.sent = []
    var seenAtSend: (tunnel: Bool, phone: Bool, epoch: Int, entry: Bool, token: Bool)?
    hub.onSend = { [unowned self] _ in
      seenAtSend = (agents.registered.contains(.tunnel), state.phoneAccessOn, o.readOwner().ownerEpoch,
                    !q.load().isEmpty, FileManager.default.fileExists(atPath: paths.hubAccessTokenPath))
    }
    hub.replies = [.response(status: 204, body: Data())]
    try OwnerChange(state: state, coordinator: coord, agents: agents, owner: o, queue: q, clock: clock).run(newOwner: "B")
    let s = try XCTUnwrap(seenAtSend)
    XCTAssertFalse(s.tunnel); XCTAssertFalse(s.phone); XCTAssertEqual(s.epoch, 2); XCTAssertTrue(s.entry); XCTAssertFalse(s.token)
    XCTAssertEqual(hub.sent.count, 1)
    let d = hub.sent[0]
    XCTAssertEqual(d.method, "DELETE"); XCTAssertEqual(d.query, "id=t1"); XCTAssertNil(d.headers["authorization"])
    XCTAssertNotNil(d.headers["x-hmx-sig"])
    XCTAssertEqual(o.readOwner(), OwnerRecord(ownerSub: "B", ownerEpoch: 2))
    XCTAssertNil(o.refreshToken())
    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.planCachePath))
    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.installPolicyPath))
    XCTAssertTrue(q.load().isEmpty)
  }

  // AC14 (hub S3b): queued per old owner, persisted before send, every DELETE carries ?id=, newer ensure not blocked
  func testQueueHubDown() throws {
    let q = queue()
    try state.writeLastTunnel(LastTunnel(id: "tA", hostname: "aaa.hyprmux.com"))
    var o = try signedIn("A", epoch: 1)
    try OwnerChange(state: state, coordinator: coord, agents: agents, owner: o, queue: q, clock: clock).run(newOwner: "B")
    try state.writeLastTunnel(LastTunnel(id: "tB", hostname: "bbb.hyprmux.com"))
    o = try signedIn("B", epoch: 2)
    try OwnerChange(state: state, coordinator: coord, agents: agents, owner: o, queue: q, clock: clock).run(newOwner: "C")
    XCTAssertEqual(q.load().map(\.ownerSub), ["A", "B"])
    XCTAssertTrue(q.hasPending)
    // C's ensure is not blocked by the queue
    hub.sent = []
    hub.replies = [StubHub.ok(["id": "tC", "hostname": "ccc.hyprmux.com", "tunnelToken": "tok-C"])]
    XCTAssertEqual(try PhoneAccess(state: state, coordinator: coord).turnOn(client: client(), port: 1, bearer: "AT-C"),
                   .ready(id: "tC", hostname: "ccc.hyprmux.com"))
    // killed mid-send: entry persisted in flight -> replayed on restart
    var e = q.load(); e[0].inFlight = true
    try BridgeState.writePrivate(paths.pendingTunnelDeletePath, String(decoding: try JSONEncoder().encode(e), as: UTF8.self))
    try q.recoverAfterRestart()
    clock.t += 300
    hub.sent = []
    hub.replies = [.response(status: 404, body: Data()), StubHub.err(409, "TUNNEL_CHANGED")]
    try q.process()
    XCTAssertEqual(hub.sent.map(\.query), ["id=tA", "id=tB"])
    XCTAssertTrue(hub.sent.allSatisfy { $0.headers["authorization"] == nil && $0.headers["x-hmx-sig"] != nil })
    XCTAssertFalse(q.hasPending)
  }

  // timed-out delete is retried with the same ?id every 300 s; 24 h -> give-up notice, entry dropped
  func testTimedOutDeleteRetriedSameId() throws {
    let q = queue()
    try q.append(PendingTunnelDelete(ownerSub: "A", epoch: 1, tunnelId: "tA", hostname: "aaa.hyprmux.com", at: clock.t,
                                     nextAttempt: clock.t, inFlight: false))
    try q.process() // times out
    try q.process() // not due yet
    XCTAssertEqual(hub.sent.count, 1)
    clock.t += 300
    try q.process()
    XCTAssertEqual(hub.sent.map(\.query), ["id=tA", "id=tA"])
    clock.t += 24 * 3600
    try q.process()
    XCTAssertEqual(q.notices, [TunnelDeleteQueue.giveUpText])
    XCTAssertFalse(q.hasPending)
  }

  // AC18: late #1 completes with TUNNEL_CHANGED after B1 is live
  func testLateDeleteCounterexample() throws {
    let q = queue()
    try q.append(PendingTunnelDelete(ownerSub: "A", epoch: 1, tunnelId: "A1", hostname: "aaa.hyprmux.com", at: clock.t,
                                     nextAttempt: clock.t, inFlight: false))
    try q.process() // #1 times out
    XCTAssertEqual(q.load().count, 1)
    clock.t += 300
    hub.replies = [.response(status: 204, body: Data())]
    try q.process() // #2
    XCTAssertTrue(q.load().isEmpty)
    hub.replies = [StubHub.ok(["id": "B1", "hostname": "bbb.hyprmux.com", "tunnelToken": "tok-B"])]
    XCTAssertEqual(try PhoneAccess(state: state, coordinator: coord).turnOn(client: client(), port: 1, bearer: "AT-B"),
                   .ready(id: "B1", hostname: "bbb.hyprmux.com"))
    // the held #1 now answers 409 TUNNEL_CHANGED: hub keeps B1 (conditional delete), nothing local changes
    XCTAssertEqual(HubEnvelope.errorCode(409, { if case .response(_, let b) = StubHub.err(409, "TUNNEL_CHANGED") { return b }; return Data() }()), "TUNNEL_CHANGED")
    XCTAssertTrue(q.load().isEmpty)
    XCTAssertEqual(state.readLastTunnel(), LastTunnel(id: "B1", hostname: "bbb.hyprmux.com"))
    XCTAssertTrue(agents.registered.contains(.tunnel))
  }

  // AC6 + AC10 + AC16
  func testCheckoutPoll() {
    hub.replies = [.response(status: 200, body: try! JSONSerialization.data(withJSONObject: ["success": true, "data": ["url": "https://checkout.example.test/s"]]))]
    XCTAssertEqual(CheckoutPoller.startCheckout(transport: hub, bearer: "AT")?.host, "checkout.example.test")
    XCTAssertEqual(hub.sent[0].body, #"{"plan":"pro","returnTo":"bridge"}"#)
    let p = CheckoutPoller(clock: clock)
    let t0 = clock.t
    p.begin(ownerSub: "A")
    var reads: [TimeInterval] = []
    while p.active && clock.t - t0 < 100 {
      clock.t += 1
      p.tick(currentOwner: "A") { _ in reads.append(self.clock.t - t0); return self.clock.t - t0 >= 40 ? "pro" : "free" }
    }
    XCTAssertFalse(p.active)
    XCTAssertLessThanOrEqual(reads.last!, 50)
    let p2 = CheckoutPoller(clock: clock)
    let t1 = clock.t
    p2.begin(ownerSub: "A")
    var n = 0
    while p2.active { clock.t += 10; p2.tick(currentOwner: "A") { _ in n += 1; return "free" } }
    XCTAssertGreaterThan(clock.t - t1, 15 * 60)
    XCTAssertEqual(n, 90)
    // fenced: owner changes mid-poll -> stops, no read of the old owner
    let p3 = CheckoutPoller(clock: clock)
    p3.begin(ownerSub: "A")
    clock.t += 10
    var who: [String] = []
    p3.tick(currentOwner: "B") { who.append($0); return "free" }
    XCTAssertFalse(p3.active)
    XCTAssertTrue(who.isEmpty)
    // late billing/done: exactly one re-read of the current owner
    p3.billingDone(currentOwner: "B") { who.append($0); return "free" }
    XCTAssertEqual(who, ["B"])
  }

  // AC8 + AC15
  func testRemoveFromPlan() {
    let srv = FakeServer()
    hub.replies = [.response(status: 204, body: Data())]
    let rows = [HubDevice(id: "r1", deviceId: "d-other"), HubDevice(id: "r2", deviceId: "d-phone")]
    XCTAssertTrue(DeviceRemoval.remove(hubDeviceId: "d-phone", localId: "k7", rows: rows, transport: hub, bearer: "AT", server: srv))
    XCTAssertEqual(hub.sent.map(\.path), ["/api/v1/apps/hyprmux/devices/r2"])
    XCTAssertEqual(hub.sent[0].method, "DELETE")
    XCTAssertEqual(srv.revoked, ["k7"])
  }

  // AC9
  func testReEnsurePolicy() {
    let on = EntitlementSnapshot(enforced: true, tunnelAllowed: true)
    let off = EntitlementSnapshot(enforced: false, tunnelAllowed: true)
    XCTAssertTrue(ReEnsurePolicy.shouldEnsure(previous: on, current: off, phoneAccessOn: true))
    XCTAssertFalse(ReEnsurePolicy.shouldEnsure(previous: off, current: off, phoneAccessOn: true))
    XCTAssertFalse(ReEnsurePolicy.shouldEnsure(previous: on, current: off, phoneAccessOn: false))
    XCTAssertTrue(ReEnsurePolicy.shouldEnsure(previous: EntitlementSnapshot(enforced: true, tunnelAllowed: false), current: on, phoneAccessOn: true))
  }
}
