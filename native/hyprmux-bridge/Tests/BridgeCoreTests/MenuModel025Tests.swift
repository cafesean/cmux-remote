import XCTest
@testable import BridgeCore

final class MenuModel025Tests: XCTestCase {
  func titles(_ items: [MenuItem]) -> [String] {
    items.map {
      switch $0 {
      case .info(let t, _): return "(\(t))"
      case .action(let t, _, let c): return c ? "✓\(t)" : t
      case .prominent(let t, _): return "*\(t)"
      case .submenu(let t, let s): return t + ">[" + titles(s).joined(separator: ",") + "]"
      case .separator: return "-"
      }
    }
  }
  let troubleshooting = ["(Troubleshooting)", "Restart", "Open Logs", "Stop Bridge", "(Version 0.2.5)", "-"]

  func testSignedOut() {
    let m = MenuModel.items(MenuInput(status: "Online", hostname: "abc1.hyprmux.com", version: "0.2.5"))
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "Sign In…", "Connect a Device…", "-", "Allow Remote Access", "Upload Folder…", "Session Tasks Folder…", "Check for Updates…", "-",
                               "Quit HyprMux Bridge"])
    XCTAssertEqual(m[0], .info("HyprMux · Online", tooltip: "abc1.hyprmux.com"))
  }

  func testSignedInPro() {
    let m = MenuModel.items(MenuInput(status: "Online", signedIn: true, email: "sean@example.test", plan: "pro",
                                      canManagePlan: true, remoteAccessOn: true, version: "0.2.5"))
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "sean@example.test · Pro>[Manage Plan…,Sign Out]", "Connect a Device…",
                               "Devices…", "-", "✓Allow Remote Access", "Upload Folder…", "Session Tasks Folder…", "Check for Updates…", "-", "Quit HyprMux Bridge"])
  }

  func testSignedInFreeShowsProminentUpgradeUnderAccount() {
    let m = MenuModel.items(MenuInput(status: "Online", signedIn: true, email: "sean@example.test", plan: "free", version: "0.2.5"))
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "sean@example.test · Free>[Sign Out]", "*Upgrade to Pro…",
                               "Connect a Device…", "Devices…", "-", "Allow Remote Access", "Upload Folder…", "Session Tasks Folder…", "Check for Updates…", "-", "Quit HyprMux Bridge"])
    XCTAssertEqual(m[2], .prominent("Upgrade to Pro…", .upgrade))
    XCTAssertTrue(titles(m).contains("Check for Updates…"), "k195: Check for Updates always visible")
    for gone in ["Restart", "Open Logs", "Stop Bridge", "(Version 0.2.5)", "Pair a Phone…", "Phone access"] {
      XCTAssertFalse(titles(m).contains(gone), gone)
    }
  }

  func testPlanUnknownNoUpgradeAndNeverSub() {
    let m = MenuModel.items(MenuInput(status: "Online", signedIn: true, version: "0.2.5"))
    XCTAssertEqual(titles(m)[1], "Signed in>[Sign Out]")
    XCTAssertFalse(m.contains(.prominent("Upgrade to Pro…", .upgrade)))
  }

  func testOptionHeldShowsTroubleshooting() {
    let m = MenuModel.items(MenuInput(status: "Online", signedIn: true, email: "a@b.test", plan: "pro", version: "0.2.5", optionHeld: true))
    let tt = titles(m)
    XCTAssertEqual(Array(tt.suffix(7)), troubleshooting + ["Quit HyprMux Bridge"])
    XCTAssertEqual(tt.firstIndex(of: "✓Allow Remote Access") ?? tt.firstIndex(of: "Allow Remote Access"), tt.count - 12)
    XCTAssertEqual(m[tt.count - 11], .action("Upload Folder…", .chooseUploadFolder))
    XCTAssertEqual(m[tt.count - 10], .action("Session Tasks Folder…", .chooseTasksFolder))
  }

  func testOfflineAndProblems() {
    let m = MenuModel.items(MenuInput(status: "Stopped", signedIn: true, email: "a@b.test", plan: "pro",
                                      problems: ["Couldn't reach hub"], version: "0.2.5"))
    XCTAssertEqual(Array(titles(m).prefix(3)), ["(HyprMux · Offline)", "a@b.test · Pro>[Sign Out]", "(Couldn't reach hub)"])
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
    XCTAssertEqual(titles(m), ["(HyprMux · Online)", "Connect a Device…", "-", "Allow Remote Access", "Upload Folder…", "Session Tasks Folder…", "Check for Updates…", "-", "Quit HyprMux Bridge"])
  }
}
