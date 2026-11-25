import XCTest
@testable import BridgeCore

/// p45 S7 (D11): the Bridge menu "Session Tasks Folder…" writes one HYPERMUX_TASKS_DIR line into the state-dir
/// env file; Clear removes it. Example paths only (a temp dir).
final class TasksFolder045Tests: XCTestCase {
  var root = ""
  override func setUpWithError() throws {
    root = NSTemporaryDirectory() + "tf-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
  }
  override func tearDown() {
    _ = chmod(root + "/locked", 0o700)
    try? FileManager.default.removeItem(atPath: root)
  }

  func freshState() throws -> BridgeState {
    let state = BridgeState(paths: BridgePaths(home: root + "/home"))
    try state.ensure()
    return state
  }
  func env(_ s: BridgeState) throws -> String { try String(contentsOfFile: s.paths.envPath, encoding: .utf8) }
  func mode(_ s: BridgeState) -> mode_t { var st = stat(); XCTAssertEqual(stat(s.paths.envPath, &st), 0); return st.st_mode & 0o777 }
  func taskLines(_ text: String) -> [String] { text.components(separatedBy: "\n").filter { $0.hasPrefix("HYPERMUX_TASKS_DIR=") } }

  func testDefaultUnsetThenSetReplaceClear() throws {
    let state = try freshState()
    let before = try env(state)
    XCTAssertNil(state.tasksDir())
    XCTAssertEqual(taskLines(before), [])
    let a = root + "/example-tasks"
    let b = root + "/My Tasks"   // a space: envLine quotes it, readEnv unquotes it
    try FileManager.default.createDirectory(atPath: a, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: b, withIntermediateDirectories: true)
    try state.setTasksDir(a)
    XCTAssertEqual(state.tasksDir(), a)
    XCTAssertEqual(mode(state), 0o600)
    try state.setTasksDir(b)
    XCTAssertEqual(state.tasksDir(), b)
    let after = try env(state)
    XCTAssertEqual(taskLines(after), ["HYPERMUX_TASKS_DIR=\"\(b)\""])
    XCTAssertEqual(after.components(separatedBy: "\n").filter { !$0.hasPrefix("HYPERMUX_TASKS_DIR=") },
                   before.components(separatedBy: "\n"), "other lines byte-identical, in order")
    XCTAssertEqual(mode(state), 0o600)
    try state.clearTasksDir()
    XCTAssertNil(state.tasksDir())
    XCTAssertEqual(try env(state), before)
    XCTAssertEqual(mode(state), 0o600)
  }

  func testRejectsRelativeMissingFileUnreadableAndWritesNothing() throws {
    let state = try freshState()
    let before = try env(state)
    let file = root + "/note.md"
    FileManager.default.createFile(atPath: file, contents: Data("x".utf8))
    let locked = root + "/locked"
    try FileManager.default.createDirectory(atPath: locked, withIntermediateDirectories: true)
    XCTAssertEqual(chmod(locked, 0o000), 0)
    for bad in ["example-tasks", "./example-tasks", root + "/missing", file, locked] {
      XCTAssertThrowsError(try state.setTasksDir(bad), bad) { e in
        XCTAssertFalse("\(e)".contains(self.root), "error text carries no path")
      }
      XCTAssertEqual(try env(state), before, bad)
    }
    XCTAssertNil(state.tasksDir())
  }

  func testRefusesNewlineAndQuotePathsForTasksAndUploadFolder() throws {
    let state = try freshState()
    let before = try env(state)
    for name in ["x\nHYPERMUX_EVIL=1", "x\rcr", "x\"quote", "x\ttab"] {
      let dir = root + "/" + name
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      XCTAssertThrowsError(try state.setTasksDir(dir), name) { e in XCTAssertFalse("\(e)".contains(self.root)) }
      XCTAssertThrowsError(try state.setUploadDir(dir), name)
      XCTAssertEqual(try env(state), before, "env file unchanged: \(name)")
    }
    XCTAssertNil(state.tasksDir())
    XCTAssertEqual(mode(state), 0o600)
  }

  func testValueSurvivesEnsureOnExistingFile() throws {
    let state = try freshState()
    let dir = root + "/example-tasks"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try state.setTasksDir(dir)
    let set = try env(state)
    try state.ensure()   // the upgrade path: an existing env file is never rewritten
    XCTAssertEqual(try env(state), set)
    XCTAssertEqual(state.tasksDir(), dir)
    XCTAssertEqual(mode(state), 0o600)
  }

  func testMenuShowsTasksFolderNextToUploadFolderAndClearWhenSet() {
    let off = MenuModel.items(MenuInput(status: "Online", version: "0.3.14"))
    guard let u = off.firstIndex(of: .action("Upload Folder…", .chooseUploadFolder)) else { return XCTFail("no Upload Folder…") }
    XCTAssertEqual(off[u + 1], .action("Session Tasks Folder…", .chooseTasksFolder))
    XCTAssertFalse(off.contains(.action("Clear Session Tasks Folder", .clearTasksFolder)))
    let on = MenuModel.items(MenuInput(status: "Online", version: "0.3.14", tasksFolderSet: true))
    guard let u2 = on.firstIndex(of: .action("Upload Folder…", .chooseUploadFolder)) else { return XCTFail("no Upload Folder…") }
    XCTAssertEqual(Array(on[(u2 + 1)...(u2 + 2)]), [.action("Session Tasks Folder…", .chooseTasksFolder),
                                                    .action("Clear Session Tasks Folder", .clearTasksFolder)])
  }
}
