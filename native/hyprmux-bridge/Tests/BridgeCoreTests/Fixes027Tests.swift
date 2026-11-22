import XCTest
@testable import BridgeCore

/// 0.2.7: Remote Desktop flags (SCREEN_VIEW / SCREEN_CONTROL) in the Bridge .env, and quoted values with spaces.
final class Fixes027Tests: XCTestCase {
  var home: String!
  var paths: BridgePaths!
  var state: BridgeState!

  override func setUpWithError() throws {
    home = NSTemporaryDirectory() + "f027-\(UUID().uuidString)"
    paths = BridgePaths(home: home)
    state = BridgeState(paths: paths)
  }

  override func tearDownWithError() throws { try? FileManager.default.removeItem(atPath: home) }

  func text() throws -> String { try String(contentsOfFile: paths.envPath, encoding: .utf8) }

  func seed(_ env: String) throws {
    try BridgeState.mkdirPrivate(paths.stateDir)
    FileManager.default.createFile(atPath: paths.envPath, contents: Data(env.utf8), attributes: [.posixPermissions: 0o600])
  }

  func testFreshEnvHasBothScreenKeys() throws {
    try state.ensure()
    let e = state.readEnv()
    XCTAssertEqual(e["SCREEN_VIEW"], "1")
    XCTAssertEqual(e["SCREEN_CONTROL"], "1")
  }

  func testFreshEnvQuotesValuesWithSpaces() throws {
    try state.ensure()
    let t = try text()
    XCTAssertTrue(paths.devicesPath.contains(" "))
    XCTAssertTrue(t.contains("DEVICES_FILE=\"\(paths.devicesPath)\"\n"))
    XCTAssertTrue(t.contains("HMX_PLAN_STATE_DIR=\"\(paths.stateDir)\"\n"))
    XCTAssertTrue(t.contains("HMX_HUB_URL=\(BridgeState.hubBase)\n"))   // no space: unquoted
    // readEnv strips the quotes, like the server's loadenv.js
    XCTAssertEqual(state.readEnv()["DEVICES_FILE"], paths.devicesPath)
    XCTAssertEqual(state.readEnv()["HMX_PLAN_STATE_DIR"], paths.stateDir)
  }

  func testExistingEnvMissingScreenKeysGetsThemAppended() throws {
    let env = "PORT=4123\nSERVER_TOKEN=aaa\nDEVICES_FILE=\(paths.devicesPath)\nHMX_PLAN_STATE_DIR=\(paths.stateDir)\nHMX_HUB_URL=\(BridgeState.hubBase)\n"
    try seed(env)
    try state.ensure()
    XCTAssertEqual(try text(), env + "SCREEN_VIEW=1\nSCREEN_CONTROL=1\n")
    try state.ensure()   // idempotent
    XCTAssertEqual(try text(), env + "SCREEN_VIEW=1\nSCREEN_CONTROL=1\n")
  }

  func testExistingScreenControlZeroIsUntouched() throws {
    let env = "PORT=4123\nHMX_PLAN_STATE_DIR=\(paths.stateDir)\nHMX_HUB_URL=\(BridgeState.hubBase)\nSCREEN_CONTROL=0"
    try seed(env)
    try state.ensure()
    XCTAssertEqual(try text(), env + "\nSCREEN_VIEW=1\n")
    XCTAssertEqual(state.readEnv()["SCREEN_CONTROL"], "0")
  }

  func testExistingScreenViewOffIsUntouched() throws {
    let env = "PORT=4123\nSCREEN_VIEW=0\nSCREEN_CONTROL=0\n"
    try seed(env)
    try state.ensure()
    let t = try text()
    XCTAssertTrue(t.hasPrefix(env))
    XCTAssertFalse(t.contains("SCREEN_VIEW=1"))
    XCTAssertFalse(t.contains("SCREEN_CONTROL=1"))
  }
}
