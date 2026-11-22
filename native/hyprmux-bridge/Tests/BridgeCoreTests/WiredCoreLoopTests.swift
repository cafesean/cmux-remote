import XCTest
@testable import BridgeCore

/// Remaining HMXB-004 tier_1_auto ACs through BridgeSession + HTTPHubTransport (URLSession) against the
/// URLProtocol stub hub, with the fake clock driving the core loop.
final class WiredCoreLoopTests: WiredTests {
  func wrap(_ f: @escaping (StubHubProtocol.Seen) -> (Int, Any)?) {
    let base = StubHubProtocol.handler!
    StubHubProtocol.handler = { r in f(r) ?? base(r) }
  }
  var tunnelPosts: Int { calls("POST", "/api/v1/apps/hyprmux/tunnels").count }
  var deletes: [StubHubProtocol.Seen] { calls("DELETE", "/api/v1/apps/hyprmux/tunnels/me") }

  // AC5: hub never answers -> 10 s total (4 + 2 + 4), one retry, "Couldn't reach hub"; 503 BUSY then 200 -> one retry
  func testAC5TimeoutBudgetWired() throws {
    enforced = false
    _ = try signIn()
    wrap { $0.url.path == "/api/v1/apps/hyprmux/tunnels" ? (-1, [:]) : nil }
    let t0 = clock.t
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .unreachable)
    XCTAssertEqual(clock.t - t0, 10)
    XCTAssertEqual(tunnelPosts, 2)
    XCTAssertTrue(calls("POST", "/api/v1/apps/hyprmux/tunnels").allSatisfy { $0.headers["x-hmx-sig"] != nil })
    try setUpWithError()
    enforced = false
    _ = try signIn()
    var busy = true
    wrap { r in
      guard r.url.path == "/api/v1/apps/hyprmux/tunnels", busy else { return nil }
      busy = false
      return (503, ["success": false, "error": ["code": "BUSY"]])
    }
    let t1 = clock.t
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    XCTAssertEqual(tunnelPosts, 2)
    XCTAssertLessThanOrEqual(clock.t - t1, 10)
  }

  // AC6: checkout poll in the core loop sees a flip at t=40 by t=50; with no flip it stops at 15 min
  func testAC6CheckoutPollWired() throws {
    let p = try signIn()
    XCTAssertNotNil(session.upgrade())
    let t0 = clock.t
    while session.poller.active && clock.t - t0 < 120 {
      clock.t += 1
      if clock.t - t0 >= 40 { plan = "pro" }
      session.coreTick(port: 4123, tokenEndpoint: p.token)
    }
    XCTAssertFalse(session.poller.active)
    XCTAssertLessThanOrEqual(clock.t - t0, 50)
    plan = "free"
    XCTAssertNotNil(session.upgrade())
    let t1 = clock.t
    while session.poller.active && clock.t - t1 < 2000 {
      clock.t += 10
      session.coreTick(port: 4123, tokenEndpoint: p.token)
    }
    XCTAssertFalse(session.poller.active)
    XCTAssertGreaterThan(clock.t - t1, 15 * 60)
    XCTAssertLessThanOrEqual(clock.t - t1, 15 * 60 + 10)
  }

  // AC14: hub down at sign-out; A->B->C keeps two entries persisted before send, ?id on every DELETE, no bearer,
  // B's ensure not blocked, killed mid-send replays, 404 / 409 TUNNEL_CHANGED resolve
  func testAC14QueueHubDownWired() throws {
    enforced = false
    let p = try signIn("A")
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    var hubDown = true
    var seenEntryAtSend: [Bool] = []
    wrap { [unowned self] r in
      guard r.url.path == "/api/v1/apps/hyprmux/tunnels/me" else { return nil }
      seenEntryAtSend.append(self.session.queue.hasPending)
      if hubDown { return (-1, [:]) }
      return r.url.query == "id=t1" ? (404, [:]) : (409, ["success": false, "error": ["code": "TUNNEL_CHANGED"]])
    }
    _ = try signIn("B")
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t2", hostname: "abc2.hyprmux.com"))
    _ = try signIn("C")
    XCTAssertEqual(session.queue.load().map(\.ownerSub), ["A", "B"])
    XCTAssertEqual(session.queue.load().map(\.tunnelId), ["t1", "t2"])
    XCTAssertTrue(seenEntryAtSend.allSatisfy { $0 })
    // core killed mid-send: replayed after restart
    var e = session.queue.load(); e[0].inFlight = true
    try BridgeState.writePrivate(state.paths.pendingTunnelDeletePath, String(decoding: try JSONEncoder().encode(e), as: UTF8.self))
    try session.queue.recoverAfterRestart()
    hubDown = false
    clock.t += 300
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertFalse(session.queue.hasPending)
    XCTAssertTrue(deletes.allSatisfy { ($0.url.query ?? "").hasPrefix("id=t") && $0.headers["authorization"] == nil && $0.headers["x-hmx-sig"] != nil })
    XCTAssertEqual(Set(deletes.suffix(2).map { $0.url.query! }), ["id=t1", "id=t2"])
  }

  // AC16: Upgrade by A, then A->B during the poll: the poll stops (no read with A's token); a late billing/done
  // re-reads only B
  func testAC16PollFencedToOwnerWired() throws {
    let p = try signIn("A")
    XCTAssertNotNil(session.upgrade())
    _ = try signIn("B")
    let before = calls("GET", "/api/v1/apps/hyprmux/entitlement").count
    clock.t += 10
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertFalse(session.poller.active)
    let reads = calls("GET", "/api/v1/apps/hyprmux/entitlement").dropFirst(before)
    XCTAssertFalse(reads.contains { $0.headers["authorization"] == "Bearer \(Self.jwt("A"))" })
    let n = calls("GET", "/api/v1/apps/hyprmux/entitlement").count
    session.handleURL(URL(string: "hyprmux-bridge://billing/done")!)
    let late = calls("GET", "/api/v1/apps/hyprmux/entitlement").dropFirst(n)
    XCTAssertEqual(late.map { $0.headers["authorization"] }, ["Bearer \(Self.jwt("B"))"])
  }

  // AC18: delete #1 times out (held by the hub), #2 -> 2xx, B ensure -> B1; the held #1 then lands -> 409
  // TUNNEL_CHANGED, B1 stays live, entry stays resolved, tunnel agent still up
  func testAC18LateDeleteWired() throws {
    enforced = false
    let p = try signIn("A")
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    var liveRow = "t1"
    var first = true
    wrap { r in
      guard r.url.path == "/api/v1/apps/hyprmux/tunnels/me" else { return nil }
      if first { first = false; return (-1, [:]) } // held
      let id = String((r.url.query ?? "").dropFirst(3))
      if id == liveRow { liveRow = ""; return (204, Data()) }
      return (409, ["success": false, "error": ["code": "TUNNEL_CHANGED"]])
    }
    _ = try signIn("B")
    XCTAssertTrue(session.queue.hasPending)
    clock.t += 300
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertFalse(session.queue.hasPending)
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t2", hostname: "abc2.hyprmux.com"))
    liveRow = "t2"
    // the held #1 lands now: same signed request replayed at the stub
    let held = deletes[0]
    let reply = HTTPHubTransport(base: URL(string: "https://hub.example.test")!, session: urlSession)
      .send(HubRequest(method: "DELETE", path: held.url.path, query: held.url.query, headers: held.headers, body: nil), timeout: 4)
    XCTAssertEqual(HubEnvelope.errorCode(409, { if case .response(_, let b) = reply { return b }; return Data() }()), "TUNNEL_CHANGED")
    XCTAssertEqual(liveRow, "t2")
    XCTAssertFalse(session.queue.hasPending)
    XCTAssertTrue(agents.registered.contains(.tunnel))
    XCTAssertEqual(state.readLastTunnel(), LastTunnel(id: "t2", hostname: "abc2.hyprmux.com"))
  }

  // AC19: a timed-out DELETE is retried by the core loop 300 s later with the same ?id; no own-tunnel read; 24 h -> dropped
  func testAC19SameIdRetryWired() throws {
    enforced = false
    let p = try signIn("A")
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    wrap { $0.url.path == "/api/v1/apps/hyprmux/tunnels/me" ? (-1, [:]) : nil }
    try session.signOut()
    session.coreTick(port: 4123, tokenEndpoint: p.token) // not due
    XCTAssertEqual(deletes.count, 1)
    clock.t += 300
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertEqual(deletes.map { $0.url.query }, ["id=t1", "id=t1"])
    XCTAssertTrue(calls("GET", "/api/v1/apps/hyprmux/tunnels/me").isEmpty)
    XCTAssertTrue(calls("GET", "/api/v1/apps/hyprmux/tunnels").isEmpty)
    clock.t += 24 * 3600
    session.coreTick(port: 4123, tokenEndpoint: p.token)
    XCTAssertFalse(session.queue.hasPending)
    XCTAssertEqual(session.queue.notices, [TunnelDeleteQueue.giveUpText])
  }
}
