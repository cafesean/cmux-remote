import XCTest
import CryptoKit
@testable import BridgeCore

/// 0.2.4 field fixes (Sean's MacBook): each test failed on 0.2.3.
final class FieldFixes024Tests: WiredTests {
  func wrap(_ f: @escaping (StubHubProtocol.Seen) -> (Int, Any)?) {
    let base = StubHubProtocol.handler!
    StubHubProtocol.handler = { r in f(r) ?? base(r) }
  }
  var tunnelPosts: Int { calls("POST", "/api/v1/apps/hyprmux/tunnels").count }
  var deletes: [StubHubProtocol.Seen] { calls("DELETE", "/api/v1/apps/hyprmux/tunnels/me") }
  func coreLog() -> String { (try? String(contentsOfFile: state.paths.logsDir + "/core.log", encoding: .utf8)) ?? "" }

  // 1. OFF stops the tunnel agent only; ON gets the same tunnel back and nothing deletes it.
  func testPhoneOffKeepsTunnelAndOnDropsQueuedDeleteOfSameId() throws {
    enforced = false
    _ = try signIn()
    wrap { r in r.url.path == "/api/v1/apps/hyprmux/tunnels"
      ? (200, ["success": true, "data": ["id": "t1", "hostname": "abc1.hyprmux.com", "tunnelToken": "tok-1"]]) : nil }
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    XCTAssertTrue(agents.registered.contains(.tunnel))
    session.setPhoneAccess(false, port: 4123)
    XCTAssertFalse(agents.registered.contains(.tunnel))
    XCTAssertTrue(deletes.isEmpty)
    XCTAssertFalse(session.queue.hasPending)
    XCTAssertTrue(FileManager.default.fileExists(atPath: state.paths.tunnelTokenPath))
    XCTAssertEqual(state.readLastTunnel(), LastTunnel(id: "t1", hostname: "abc1.hyprmux.com"))
    // a delete queued by 0.2.3 for the same tunnel (hub was slow) must not run after ON returns it again
    try session.queue.append(PendingTunnelDelete(ownerSub: "A", epoch: 1, tunnelId: "t1", hostname: "abc1.hyprmux.com",
                                                 at: clock.t, nextAttempt: clock.t + 60, inFlight: false))
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    XCTAssertFalse(session.queue.hasPending)
    clock.t += 120
    session.coreTick(port: 4123, tokenEndpoint: nil)
    XCTAssertTrue(deletes.isEmpty)
    XCTAssertTrue(agents.registered.contains(.tunnel))
    // sign-out still deletes
    try session.signOut()
    XCTAssertEqual(deletes.last?.url.query, "id=t1")
  }

  // 2a. A new tunnel token restarts the tunnel agent (cloudflared kept the old token).
  func testNewTunnelTokenRestartsTunnelAgent() throws {
    enforced = false
    _ = try signIn()
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    agents.log.removeAll()
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t2", hostname: "abc2.hyprmux.com"))
    XCTAssertEqual(try String(contentsOfFile: state.paths.tunnelTokenPath, encoding: .utf8), "tok-2")
    XCTAssertEqual(Array(agents.log.suffix(2)), ["-tunnel", "+tunnel"])
    XCTAssertTrue(coreLog().contains("agent-restart agent=tunnel reason=token_changed"), coreLog())
    // same token again: no restart
    wrap { r in r.url.path == "/api/v1/apps/hyprmux/tunnels"
      ? (200, ["success": true, "data": ["id": "t2", "hostname": "abc2.hyprmux.com", "tunnelToken": "tok-2"]]) : nil }
    agents.log.removeAll()
    session.setPhoneAccess(true, port: 4123)
    XCTAssertFalse(agents.log.contains("-tunnel"))
  }

  // 2b. cloudflared logs 'Tunnel not found' -> one re-ensure for that token, not a loop.
  func testTunnelNotFoundInLogReEnsuresOnce() throws {
    enforced = false
    _ = try signIn()
    session.setPhoneAccess(true, port: 4123)
    XCTAssertEqual(tunnelPosts, 1)
    session.coreTick(port: 4123, tokenEndpoint: nil)
    XCTAssertEqual(tunnelPosts, 1)
    let log = state.paths.logsDir + "/tunnel.log"
    try "2026-11-22T00:00:00Z ERR Register tunnel error from server side error=\"Unauthorized: Tunnel not found\"\n"
      .write(toFile: log, atomically: false, encoding: .utf8)
    session.coreTick(port: 4123, tokenEndpoint: nil)
    XCTAssertEqual(tunnelPosts, 2)
    XCTAssertEqual(try String(contentsOfFile: state.paths.tunnelTokenPath, encoding: .utf8), "tok-2")
    session.coreTick(port: 4123, tokenEndpoint: nil)
    XCTAssertEqual(tunnelPosts, 2)
    XCTAssertTrue(coreLog().contains("tunnel-not-found action=re_ensure"), coreLog())
  }

  // 4. Sign-in registers the hub app session (bearer) once; startup does it when none is recorded.
  func testSignInCallsHubSessionOnce() throws {
    wrap { r in r.url.path == "/api/v1/apps/hyprmux/session" ? (200, ["success": true, "data": ["user": ["id": "u1"]]]) : nil }
    _ = try signIn()
    let s = calls("POST", "/api/v1/apps/hyprmux/session")
    XCTAssertEqual(s.count, 1)
    XCTAssertEqual(s.first?.headers["authorization"], "Bearer \(Self.jwt("A"))")
    XCTAssertTrue(session.hubSessionRecorded)
    session.ensureHubSession()
    XCTAssertEqual(calls("POST", "/api/v1/apps/hyprmux/session").count, 1)
    try FileManager.default.removeItem(atPath: state.paths.hubSessionPath)
    session.ensureHubSession()
    XCTAssertEqual(calls("POST", "/api/v1/apps/hyprmux/session").count, 2)
    XCTAssertTrue(coreLog().contains("hub-session status=200 result=ok"), coreLog())
  }

  // 7. core.log: ensure line has status, hostname, id prefix; never the tunnel token.
  func testEnsureLogLine() throws {
    enforced = false
    _ = try signIn()
    wrap { r in r.url.path == "/api/v1/apps/hyprmux/tunnels"
      ? (200, ["success": true, "data": ["id": "0123456789abcdef", "hostname": "abc1.hyprmux.com", "tunnelToken": "SECRET-TOKEN"]]) : nil }
    session.setPhoneAccess(true, port: 4123)
    let l = coreLog()
    XCTAssertTrue(l.contains("tunnel-ensure status=ready host=abc1.hyprmux.com id=01234567\n"), l)
    XCTAssertFalse(l.contains("SECRET-TOKEN"))
    XCTAssertFalse(l.contains("0123456789abcdef"))
  }
}

/// Thread-safe hub stub that holds each POST /tunnels for a moment (two callers overlap).
final class SlowTunnelHub: HubTransport, @unchecked Sendable {
  let lock = NSLock()
  var posts = 0
  func send(_ r: HubRequest, timeout: TimeInterval) -> HubReply {
    lock.lock(); posts += 1; let n = posts; lock.unlock()
    Thread.sleep(forTimeInterval: 0.3)
    return StubHub.ok(["id": "t\(n)", "hostname": "abc\(n).hyprmux.com", "tunnelToken": "tok-\(n)"])
  }
}

final class EnsureSerialTests: XCTestCase {
  // 3. Two concurrent ensures from one Mac: one POST; the second gets the first's result.
  func testConcurrentEnsureIsSerialized() throws {
    let home = NSTemporaryDirectory() + "serial-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: home) }
    let state = BridgeState(paths: BridgePaths(home: home))
    try state.ensure(); try state.retireC3IfFirstLaunch()
    let agents = FakeAgents()
    let coord = AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: Launchctl(runner: StubRunner(), uid: 501),
                                                                     launchAgentsDir: home + "/none"), state: state)
    let hub = SlowTunnelHub()
    let key = Curve25519.Signing.PrivateKey()
    let clock = FakeClock()
    final class Box: @unchecked Sendable { var r: [TunnelState?] = [nil, nil] }
    let box = Box()
    let g = DispatchGroup()
    for i in 0..<2 {
      DispatchQueue.global().async(group: g) {
        let c = HubTunnelClient(transport: hub, clock: clock, key: key)
        box.r[i] = try? PhoneAccess(state: state, coordinator: coord).turnOn(client: c, port: 1, bearer: "AT")
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
    g.wait()
    XCTAssertEqual(hub.posts, 1)
    XCTAssertEqual(box.r[0], .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    XCTAssertEqual(box.r[1], .ready(id: "t1", hostname: "abc1.hyprmux.com"))
  }

  // 3b. 503 BUSY with Retry-After: retried after the hub's delay (inside the 10 s budget).
  func testBusyRetryAfterHonored() {
    let clock = FakeClock(); clock.t = 100
    let hub = StubHub(clock)
    let busy = try! JSONSerialization.data(withJSONObject: ["success": false, "error": ["code": "BUSY"], "retryAfter": 3])
    hub.replies = [.response(status: 503, body: busy), StubHub.ok(["id": "t1", "hostname": "abc1.hyprmux.com", "tunnelToken": "tok-1"])]
    let (s, _) = HubTunnelClient(transport: hub, clock: clock, key: Curve25519.Signing.PrivateKey()).ensure(port: 1, bearer: "AT")
    XCTAssertEqual(s, .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    XCTAssertEqual(clock.t, 103)
  }

  func testRetryAfterHeaderFoldedIntoBody() {
    let d = HTTPHubTransport.foldRetryAfter(status: 503, header: "3", body: Data(#"{"success":false,"error":{"code":"BUSY"}}"#.utf8))
    XCTAssertEqual(HubEnvelope.retryAfter(d), 3)
    XCTAssertNil(HubEnvelope.retryAfter(HTTPHubTransport.foldRetryAfter(status: 200, header: "3", body: Data("{}".utf8))))
  }
}

final class PairAndLaunchTests: XCTestCase {
  // 5. ps -o comm= prints the bare argv0; the executable path comes from proc_pidpath.
  func testExecutablePathOfSelfIsAbsolute() {
    let p = Launchctl.executablePath(pid: getpid())
    XCTAssertTrue(p?.hasPrefix("/") == true, p ?? "nil")
  }

  // 6. Pair window text: unreachable server -> "Bridge isn't running"; no public address -> Phone access.
  func testPairingResultText() {
    let clock = FakeClock()
    let hub = StubHub(clock)
    let srv = LoopbackServer(transport: hub, token: "ST")
    hub.replies = [.network]
    XCTAssertEqual(srv.startPairing(), .notRunning)
    XCTAssertEqual(PairingStart.notRunning.text, "Bridge isn't running")
    hub.replies = [.response(status: 409, body: Data(#"{"error":"no_public_address"}"#.utf8))]
    XCTAssertEqual(srv.startPairing(), .refused("no_public_address"))
    XCTAssertEqual(PairingStart.refused("no_public_address").text, "Turn on Phone access first.")
    hub.replies = [.response(status: 200, body: Data(#"{"code":"123456","qr":"cmuxremote://pair?c=123456"}"#.utf8))]
    XCTAssertEqual(srv.startPairing(), .link("cmuxremote://pair?c=123456"))
    XCTAssertEqual(PairingStart.link("x").text, "Scan with the HyprMux app")
    XCTAssertEqual(PairingStart.link("x").logResult, "ok")
  }
}
