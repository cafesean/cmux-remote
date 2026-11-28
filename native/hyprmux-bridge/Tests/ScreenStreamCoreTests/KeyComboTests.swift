import XCTest
@testable import ScreenStreamCore

final class KeyComboTests: XCTestCase {
  func testCapturesOnlyTheSystemCombos() {
    let c = KeyCombo.cmd, s = KeyCombo.shift
    XCTAssertEqual(KeyCombo.match(keycode: 48, flags: c), "cmd+tab")
    XCTAssertEqual(KeyCombo.match(keycode: 48, flags: c | s), "cmd+shift+tab")
    XCTAssertEqual(KeyCombo.match(keycode: 49, flags: c), "cmd+space")
    XCTAssertEqual(KeyCombo.match(keycode: 50, flags: c), "cmd+`")
    XCTAssertNil(KeyCombo.match(keycode: 50, flags: c | s))   // not in the remote KEY_ALLOW
  }
  func testEverythingElsePasses() {
    XCTAssertNil(KeyCombo.match(keycode: 48, flags: 0))                                  // plain Tab
    XCTAssertNil(KeyCombo.match(keycode: 48, flags: KeyCombo.opt))                       // ⌥Tab: the app already forwards it
    XCTAssertNil(KeyCombo.match(keycode: 53, flags: KeyCombo.cmd | KeyCombo.opt))        // ⌥⌘Esc Force Quit stays local
    XCTAssertNil(KeyCombo.match(keycode: 8, flags: KeyCombo.cmd))                        // ⌘C: app-level, already forwarded
    XCTAssertNil(KeyCombo.match(keycode: 49, flags: KeyCombo.cmd | KeyCombo.ctrl))       // ⌃⌘Space emoji picker stays local
    XCTAssertNil(KeyCombo.match(keycode: 49, flags: KeyCombo.cmd | KeyCombo.shift))
  }
}
