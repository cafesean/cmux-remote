import XCTest
@testable import BridgeCore

final class MenuBarTests: XCTestCase {
  func testStatusGoesToToolTipNotTitle() {
    XCTAssertEqual(MenuBarStatus.toolTip("Online"), "HyprMux Bridge: Online")
    XCTAssertEqual(MenuBarStatus.toolTip("Needs approval"), "HyprMux Bridge: Needs approval")
    XCTAssertFalse(MenuBarStatus.dimmed("Online"))
    for s in ["Starting", "Stopped", "Needs approval"] { XCTAssertTrue(MenuBarStatus.dimmed(s), s) }
    XCTAssertEqual(MenuBarStatus.fallbackTitle("Online"), "HyprMux")
    XCTAssertEqual(MenuBarStatus.fallbackTitle("Stopped"), "HyprMux (Stopped)")
  }

  func testReachableWithoutNotch() {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    XCTAssertTrue(MenuBarStatus.isReachable(item: CGRect(x: 1300, y: 958, width: 24, height: 24), screen: screen, notchLeft: nil, notchRight: nil))
    XCTAssertFalse(MenuBarStatus.isReachable(item: CGRect(x: -40, y: 958, width: 24, height: 24), screen: screen, notchLeft: nil, notchRight: nil))
    XCTAssertFalse(MenuBarStatus.isReachable(item: .zero, screen: screen, notchLeft: nil, notchRight: nil))
  }

  func testNotchHidesItem() {
    // 14" MacBook Pro: notch spans roughly x 662...850.
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let left = CGRect(x: 0, y: 950, width: 662, height: 32)
    let right = CGRect(x: 850, y: 950, width: 662, height: 32)
    XCTAssertTrue(MenuBarStatus.isReachable(item: CGRect(x: 900, y: 950, width: 24, height: 32), screen: screen, notchLeft: left, notchRight: right))
    XCTAssertFalse(MenuBarStatus.isReachable(item: CGRect(x: 700, y: 950, width: 24, height: 32), screen: screen, notchLeft: left, notchRight: right))
    XCTAssertFalse(MenuBarStatus.isReachable(item: CGRect(x: 840, y: 950, width: 24, height: 32), screen: screen, notchLeft: left, notchRight: right))
    XCTAssertTrue(MenuBarStatus.isReachable(item: CGRect(x: 600, y: 950, width: 24, height: 32), screen: screen, notchLeft: left, notchRight: right))
  }
}
