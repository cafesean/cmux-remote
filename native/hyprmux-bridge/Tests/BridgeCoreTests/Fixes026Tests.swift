import XCTest
@testable import BridgeCore

/// 0.2.6 field fixes: upgrade restart on menu launch, Manage Plan for manageUrl "portal".
final class UpgradeRestartTests: XCTestCase {
  func testDecide() {
    XCTAssertEqual(UpgradeRestart.decide(bundleVersion: "0.2.6", runningVersion: "0.2.5"), .restart(running: "0.2.5"))
    XCTAssertEqual(UpgradeRestart.decide(bundleVersion: "0.2.6", runningVersion: "0.2.6"), .none)
    XCTAssertEqual(UpgradeRestart.decide(bundleVersion: "0.2.6", runningVersion: nil), .none)
    XCTAssertEqual(UpgradeRestart.decide(bundleVersion: "0.2.6", runningVersion: ""), .none)
    XCTAssertEqual(UpgradeRestart.decide(bundleVersion: "0.2.6", runningVersion: "0.2.6\n"), .none)
    // a downgrade (previous version reinstalled) restarts too
    XCTAssertEqual(UpgradeRestart.decide(bundleVersion: "0.2.5", runningVersion: "0.2.6"), .restart(running: "0.2.6"))
  }

  func coordinator(_ home: String, _ agents: FakeAgents, legacy: Set<String> = []) throws -> AgentCoordinator {
    let state = BridgeState(paths: BridgePaths(home: home))
    try state.ensure()
    let runner = StubRunner(); runner.loaded = legacy
    let dir = home + "/LaunchAgents"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    for l in legacy { FileManager.default.createFile(atPath: dir + "/\(l).plist", contents: Data()) }
    return AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: Launchctl(runner: runner, uid: 501), launchAgentsDir: dir),
                            state: state)
  }

  func testMenuLaunchRestartsAgentsOnVersionMismatchViaCoordinator() throws {
    let home = NSTemporaryDirectory() + "ur-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: home) }
    let agents = FakeAgents()
    let c = try coordinator(home, agents)
    _ = c.registerRequired()
    agents.log = []
    let probe = FakeProbe(); probe.version = "0.2.5"
    XCTAssertEqual(UpgradeRestart.runAtMenuLaunch(probe: probe, coordinator: c, bundleVersion: "0.2.6"), .restart(running: "0.2.5"))
    // every required agent (core included: the menu is not core) unregistered then registered, once each
    for a in c.required {
      XCTAssertEqual(agents.log.filter { $0 == "-\(a.rawValue)" }.count, 1, a.rawValue)
      XCTAssertEqual(agents.log.filter { $0 == "+\(a.rawValue)" }.count, 1, a.rawValue)
      XCTAssertLessThan(agents.log.firstIndex(of: "-\(a.rawValue)")!, agents.log.firstIndex(of: "+\(a.rawValue)")!)
    }
    XCTAssertTrue(c.required.contains(.core))
    XCTAssertEqual(Set(c.required), agents.registered)
  }

  func testMenuLaunchLeavesAgentsAloneWhenMatchingOrSilent() throws {
    let home = NSTemporaryDirectory() + "ur-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: home) }
    let agents = FakeAgents()
    let c = try coordinator(home, agents)
    _ = c.registerRequired()
    agents.log = []
    let probe = FakeProbe()
    probe.version = "0.2.6"
    XCTAssertEqual(UpgradeRestart.runAtMenuLaunch(probe: probe, coordinator: c, bundleVersion: "0.2.6"), .none)
    probe.version = nil
    XCTAssertEqual(UpgradeRestart.runAtMenuLaunch(probe: probe, coordinator: c, bundleVersion: "0.2.6"), .none)
    XCTAssertEqual(agents.log, [])
  }

  func testMenuLaunchWaitsWhileLegacyAgentsLoaded() throws {
    let home = NSTemporaryDirectory() + "ur-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: home) }
    let agents = FakeAgents()
    let c = try coordinator(home, agents, legacy: ["ai.yobolabs.hyprmux.server"])
    let probe = FakeProbe(); probe.version = "0.2.5"
    XCTAssertEqual(UpgradeRestart.runAtMenuLaunch(probe: probe, coordinator: c, bundleVersion: "0.2.6"), .none)
    XCTAssertEqual(agents.log, [])
  }
}

final class ManagePortal026Tests: WiredTests {
  func entitlement(_ manage: Any) {
    StubHubProtocol.handler = { [base = StubHubProtocol.handler!] r in
      switch (r.method, r.url.path) {
      case ("GET", "/api/v1/apps/hyprmux/entitlement"):
        return (200, ["success": true, "data": ["plan": "pro", "enforced": true, "manageUrl": manage]])
      case ("POST", "/api/v1/apps/hyprmux/billing/portal"):
        return (200, ["success": true, "data": ["url": "https://billing.example.test/p/1"]])
      default: return base(r)
      }
    }
  }

  func testPortalShowsManageAndOpensHubPortalURL() throws {
    entitlement("portal")
    _ = try signIn()
    XCTAssertNotNil(session.readEntitlement())
    XCTAssertTrue(session.canManagePlan)
    XCTAssertNil(session.manageURL)
    XCTAssertEqual(session.managePlanURL(), URL(string: "https://billing.example.test/p/1"))
    let call = try XCTUnwrap(calls("POST", "/api/v1/apps/hyprmux/billing/portal").first)
    XCTAssertEqual(call.headers["authorization"], "Bearer \(Self.jwt("A"))")
  }

  func testHttpsManageUrlOpensDirectlyWithoutPortalCall() throws {
    entitlement("https://manage.example.test/x")
    _ = try signIn()
    _ = session.readEntitlement()
    XCTAssertTrue(session.canManagePlan)
    XCTAssertEqual(session.managePlanURL(), URL(string: "https://manage.example.test/x"))
    XCTAssertTrue(calls("POST", "/api/v1/apps/hyprmux/billing/portal").isEmpty)
  }

  func testNullOrOtherManageUrlHidesManage() throws {
    entitlement(NSNull())
    _ = try signIn()
    _ = session.readEntitlement()
    XCTAssertFalse(session.canManagePlan)
    XCTAssertNil(session.managePlanURL())
    entitlement("http://insecure.example.test")
    _ = session.readEntitlement()
    XCTAssertFalse(session.canManagePlan)
  }

  func testPortalNonHttpsReplyRejected() {
    let hub = StubHub(FakeClock())
    hub.replies = [StubHub.ok(["url": "http://billing.example.test/p/1"])]
    XCTAssertNil(CheckoutPoller.startPortal(transport: hub, bearer: "b"))
    hub.replies = [StubHub.err(404, "NOT_FOUND")]
    XCTAssertNil(CheckoutPoller.startPortal(transport: hub, bearer: "b"))
    XCTAssertEqual(hub.sent.last?.path, "/api/v1/apps/hyprmux/billing/portal")
    XCTAssertEqual(hub.sent.last?.method, "POST")
  }
}
