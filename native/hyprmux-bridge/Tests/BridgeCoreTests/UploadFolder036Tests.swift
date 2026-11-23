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
