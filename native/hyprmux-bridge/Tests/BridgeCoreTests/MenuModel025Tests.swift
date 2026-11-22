import XCTest
@testable import BridgeCore

final class MenuModel025Tests: XCTestCase {
  func titles(_ items: [MenuItem]) -> [String] {
    items.map {
      switch $0 {
      case .info(let t, _): return "(\(t))"
      case .action(let t, _, let c): return c ? "✓\(t)" : t
      case .submenu(let t, _): return t + ">"
      case .separator: return "-"
      }
    }
  }
  func settings(_ items: [MenuItem]) -> [MenuItem] {
    for case .submenu("Settings", let s) in items { return s }
    XCTFail("no Settings"); return []
  }

  func testSignedOut() {
    let m = MenuModel.items(MenuInput(status: "Online", hostname: "abc1.hyprmux.com", version: "0.2.5"))
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "Sign In…", "Connect a Device…", "-", "Settings>", "Quit HyprMux Bridge"])
    XCTAssertEqual(m[0], .info("HyprMux · Online", tooltip: "abc1.hyprmux.com"))
    XCTAssertEqual(titles(settings(m)), ["Allow Remote Access", "Restart", "Open Logs", "-", "(Version 0.2.5)"])
  }

  func testSignedInOnlineFree() {
    let m = MenuModel.items(MenuInput(status: "Online", hostname: "abc1.hyprmux.com", signedIn: true, email: "sean@example.test",
                                      plan: "free", remoteAccessOn: true, version: "0.2.5"))
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "(sean@example.test · Free)", "Connect a Device…", "Devices…", "-",
                               "Settings>", "Quit HyprMux Bridge"])
    XCTAssertEqual(titles(settings(m)), ["✓Allow Remote Access", "Upgrade", "Restart", "Open Logs", "Sign Out", "-", "(Version 0.2.5)"])
    XCTAssertFalse(titles(m).contains("Pair a Phone…"))
    XCTAssertFalse(titles(m).contains("Phone access"))
  }

  func testSignedInProNeverShowsSub() {
    let m = MenuModel.items(MenuInput(status: "Online", signedIn: true, email: nil, plan: "pro", version: "0.2.5"))
    XCTAssertEqual(titles(m)[1], "(Signed in · Pro)")
    XCTAssertFalse(titles(settings(m)).contains("Upgrade"))
  }

  func testOfflineAndProblems() {
    let m = MenuModel.items(MenuInput(status: "Stopped", signedIn: true, email: "a@b.test", plan: "pro",
                                      problems: ["Couldn't reach hub"], version: "0.2.5"))
    XCTAssertEqual(titles(m).prefix(3), ["(HyprMux · Offline)", "(a@b.test · Pro)", "(Couldn't reach hub)"])
    XCTAssertEqual(m[0], .info("HyprMux · Offline", tooltip: "Remote access is off"))
    XCTAssertEqual(MenuModel.statusLine(MenuInput(status: "Needs approval", version: "1")), "HyprMux · Needs approval")
  }

  func testNoticeOnlyWhenReal() {
    let none = MenuModel.items(MenuInput(status: "Online", version: "0.2.5"))
    XCTAssertFalse(none.contains { if case .action(_, .openNotice, _) = $0 { return true }; return false })
    let m = MenuModel.items(MenuInput(status: "Online", notice: "Update available: 0.2.6", noticeOpens: true, version: "0.2.5"))
    XCTAssertTrue(m.contains(.action("Update available: 0.2.6", .openNotice)))
    let plain = MenuModel.items(MenuInput(status: "Online", notice: "Update didn't start", version: "0.2.5"))
    XCTAssertTrue(plain.contains(.info("Update didn't start")))
  }

  func testPairingLinkParts() {
    let p = PairingLink.parse("cmuxremote://pair?u=https%3A%2F%2Fabc1.hyprmux.com&c=AB12CD34")
    XCTAssertEqual(p?.address, "https://abc1.hyprmux.com")
    XCTAssertEqual(p?.code, "AB12CD34")
    XCTAssertNil(PairingLink.parse("cmuxremote://pair?u=x"))
  }

  func testHiddenSignIn() {
    let m = MenuModel.items(MenuInput(status: "Online", signInVisible: false, version: "0.2.5"))
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "Connect a Device…", "-", "Settings>", "Quit HyprMux Bridge"])
  }
}
