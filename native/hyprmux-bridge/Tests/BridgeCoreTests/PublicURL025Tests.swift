import XCTest
@testable import BridgeCore

/// 0.2.5 field bug: the pairing QR's u= came from PUBLIC_URL in the Bridge .env, which nothing updated on ensure.
final class PublicURL025Tests: WiredTests {
  func env() -> String { (try? String(contentsOfFile: state.paths.envPath, encoding: .utf8)) ?? "" }

  func testEnsureWritesPublicURLAndRestartsServerOnlyWhenChanged() throws {
    enforced = false
    _ = try signIn()
    let before = state.readEnv()
    XCTAssertNil(before["PUBLIC_URL"])
    agents.log.removeAll()
    XCTAssertEqual(session.setPhoneAccess(true, port: 4123), .ready(id: "t1", hostname: "abc1.hyprmux.com"))
    var after = state.readEnv()
    XCTAssertEqual(after["PUBLIC_URL"], "https://abc1.hyprmux.com")
    for (k, v) in before { XCTAssertEqual(after[k], v, k) }            // other keys untouched
    XCTAssertEqual(after.count, before.count + 1)
    let mode = try FileManager.default.attributesOfItem(atPath: state.paths.envPath)[.posixPermissions] as? NSNumber
    XCTAssertEqual(mode?.intValue, 0o600)
    XCTAssertTrue(agents.log.contains("-server") && agents.log.contains("+server"), "\(agents.log)")
    XCTAssertTrue(agents.registered.contains(.server))

    // same host again: no rewrite-driven restart
    StubHubProtocol.handler = { [base = StubHubProtocol.handler!] r in
      r.url.path == "/api/v1/apps/hyprmux/tunnels"
        ? (200, ["success": true, "data": ["id": "t1", "hostname": "abc1.hyprmux.com", "tunnelToken": "tok-1"]]) : base(r) }
    agents.log.removeAll()
    session.setPhoneAccess(true, port: 4123)
    XCTAssertFalse(agents.log.contains("-server"), "\(agents.log)")

    // a new host replaces the line in place (one PUBLIC_URL line) and restarts the server
    StubHubProtocol.handler = { [base = StubHubProtocol.handler!] r in
      r.url.path == "/api/v1/apps/hyprmux/tunnels"
        ? (200, ["success": true, "data": ["id": "t9", "hostname": "zzz9.hyprmux.com", "tunnelToken": "tok-9"]]) : base(r) }
    session.setPhoneAccess(true, port: 4123)
    after = state.readEnv()
    XCTAssertEqual(after["PUBLIC_URL"], "https://zzz9.hyprmux.com")
    XCTAssertEqual(env().components(separatedBy: "PUBLIC_URL=").count, 2, env())
    XCTAssertTrue(agents.log.contains("-server"))
  }

  func testFailedEnsureLeavesPublicURLAlone() throws {
    _ = try signIn()          // enforced free plan: first POST is PLAN_LIMIT
    session.setPhoneAccess(true, port: 4123)
    XCTAssertNil(state.readEnv()["PUBLIC_URL"])
  }
}
