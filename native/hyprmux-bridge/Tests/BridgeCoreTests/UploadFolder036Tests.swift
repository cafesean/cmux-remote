import XCTest
@testable import BridgeCore

/// 0.3.6 k95: the user picks the upload folder from the Bridge menu; it is one UPLOAD_DIR line in the env file.
final class UploadFolder036Tests: XCTestCase {
  func tmpHome() -> String { NSTemporaryDirectory() + "uf-\(UUID().uuidString)" }

  func testDefaultIsHyprMuxUploadsUnderHome() throws {
    let home = tmpHome(); defer { try? FileManager.default.removeItem(atPath: home) }
    let state = BridgeState(paths: BridgePaths(home: home))
    try state.ensure()
    XCTAssertEqual(state.uploadDir(), home + "/HyprMux-Uploads")
  }

  func testSetAppendsThenReplacesOneLineAndKeepsTheRest() throws {
    let home = tmpHome(); defer { try? FileManager.default.removeItem(atPath: home) }
    let state = BridgeState(paths: BridgePaths(home: home))
    try state.ensure()
    let before = try String(contentsOfFile: state.paths.envPath, encoding: .utf8)
    try state.setUploadDir("/Users/x/cmux-uploads")
    XCTAssertEqual(state.uploadDir(), "/Users/x/cmux-uploads")
    try state.setUploadDir("/Users/x/My Files")   // spaces are quoted, read back unquoted
    XCTAssertEqual(state.uploadDir(), "/Users/x/My Files")
    let after = try String(contentsOfFile: state.paths.envPath, encoding: .utf8)
    XCTAssertEqual(after.components(separatedBy: "\n").filter { $0.hasPrefix("UPLOAD_DIR=") }, ["UPLOAD_DIR=\"/Users/x/My Files\""])
    // every other line is unchanged, in order
    XCTAssertEqual(after.components(separatedBy: "\n").filter { !$0.hasPrefix("UPLOAD_DIR=") },
                   before.components(separatedBy: "\n"))
    var st = stat(); XCTAssertEqual(stat(state.paths.envPath, &st), 0)
    XCTAssertEqual(st.st_mode & 0o777, 0o600)
  }

  func testMenuOffersUploadFolder() {
    let m = MenuModel.items(MenuInput(status: "Online", version: "0.3.6"))
    XCTAssertTrue(m.contains(.action("Upload Folder…", .chooseUploadFolder)))
  }
}

/// 0.3.6 (mini 2026-11-23): daemon + core were enabled in SMAppService but not loaded in launchd after an
/// uninstall/reinstall, so register() skipped them and the mini listed no machine. The poll now re-registers them.
final class AgentHeal036Tests: XCTestCase {
  func testEnabledButNotLoadedAgentIsReRegistered() throws {
    let home = NSTemporaryDirectory() + "heal-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: home) }
    let paths = BridgePaths(home: home)
    try FileManager.default.createDirectory(atPath: paths.launchAgentsDir, withIntermediateDirectories: true)
    let state = BridgeState(paths: paths)
    let runner = StubRunner()
    let agents = FakeAgents()
    agents.registered = [.daemon, .server, .core]          // SMAppService says enabled
    runner.bootedOut = ["com.hyprmux.bridge.daemon", "com.hyprmux.bridge.core"]   // launchd has no job
    let coord = AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath),
                                                                     launchAgentsDir: paths.launchAgentsDir), state: state)
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core]))
    XCTAssertEqual(agents.log, ["+daemon", "-daemon", "+daemon", "+server", "+core", "-core", "+core"])
  }

  func testLoadedAgentsAreLeftAlone() throws {
    let home = NSTemporaryDirectory() + "heal-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: home) }
    let paths = BridgePaths(home: home)
    try FileManager.default.createDirectory(atPath: paths.launchAgentsDir, withIntermediateDirectories: true)
    let runner = StubRunner()
    let agents = FakeAgents()
    let coord = AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath),
                                                                     launchAgentsDir: paths.launchAgentsDir), state: BridgeState(paths: paths))
    _ = coord.tick()
    XCTAssertEqual(agents.log, ["+daemon", "+server", "+core"])
  }
}
