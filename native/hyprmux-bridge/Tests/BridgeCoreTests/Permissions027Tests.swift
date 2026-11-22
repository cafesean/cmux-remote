import XCTest
@testable import BridgeCore

/// 0.2.7: Remote Desktop permissions (Screen Recording + Accessibility) as part of setup, the menu line when one is
/// missing, and one agent restart after a grant is seen.
final class Permissions027Tests: XCTestCase {
  let none = PermissionStatus(screenRecording: false, accessibility: false)
  let both = PermissionStatus(screenRecording: true, accessibility: true)
  let screenOnly = PermissionStatus(screenRecording: true, accessibility: false)
  let axOnly = PermissionStatus(screenRecording: false, accessibility: true)

  // MARK: menu items

  func testNoPermissionItemsWhenBothGranted() {
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(both), [])
  }

  func testBothMissingShowsLineAndBothItems() {
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(none), [
      .info(RemoteDesktopPermissions.needsPermissionText),
      .action("Allow Screen Recording…", .allowScreenRecording),
      .action("Allow Accessibility…", .allowAccessibility),
    ])
  }

  func testOnlyMissingItemShows() {
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(screenOnly), [
      .info(RemoteDesktopPermissions.needsPermissionText), .action("Allow Accessibility…", .allowAccessibility)])
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(axOnly), [
      .info(RemoteDesktopPermissions.needsPermissionText), .action("Allow Screen Recording…", .allowScreenRecording)])
  }

  func testSettingsURLsOpenExactPanes() {
    XCTAssertEqual(RemoteDesktopPermissions.settingsURL(.screenRecording).absoluteString,
                   "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    XCTAssertEqual(RemoteDesktopPermissions.settingsURL(.accessibility).absoluteString,
                   "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
  }

  // MARK: menu placement (v2 layout kept; permission block right under Status, only when needed)

  func input(_ p: PermissionStatus?) -> MenuInput {
    var i = MenuInput(status: "Online", signInVisible: true, signedIn: true, email: "a@b.c", plan: "pro", version: "0.2.7")
    i.permissions = p
    return i
  }

  func testMenuPutsPermissionBlockUnderStatus() {
    let items = MenuModel.items(input(none))
    XCTAssertEqual(items[0], .info("HyprMux · Online", tooltip: "Remote access is off"))
    XCTAssertEqual(items[1], .info(RemoteDesktopPermissions.needsPermissionText))
    XCTAssertEqual(items[2], .action("Allow Screen Recording…", .allowScreenRecording))
    XCTAssertEqual(items[3], .action("Allow Accessibility…", .allowAccessibility))
    XCTAssertEqual(items[4], .separator)
    XCTAssertEqual(items[5], .submenu("a@b.c · Pro", [.action("Sign Out", .signOut)]))
  }

  func testMenuUnchangedWhenGrantedOrUnknown() {
    let base = MenuModel.items(input(nil))
    XCTAssertEqual(MenuModel.items(input(both)), base)
    XCTAssertFalse(base.contains(.info(RemoteDesktopPermissions.needsPermissionText)))
  }

  // MARK: setup step (first run / after sign-in)

  func testSetupAsksOnlyForMissing() {
    XCTAssertEqual(RemoteDesktopPermissions.setupRequests(none, trigger: .firstRun, askedBefore: false),
                   [.screenRecording, .accessibility])
    XCTAssertEqual(RemoteDesktopPermissions.setupRequests(screenOnly, trigger: .firstRun, askedBefore: false), [.accessibility])
    XCTAssertEqual(RemoteDesktopPermissions.setupRequests(both, trigger: .signIn, askedBefore: false), [])
  }

  func testLaunchAsksOnceButSignInAlwaysAsks() {
    XCTAssertEqual(RemoteDesktopPermissions.setupRequests(none, trigger: .firstRun, askedBefore: true), [])
    XCTAssertEqual(RemoteDesktopPermissions.setupRequests(axOnly, trigger: .signIn, askedBefore: true), [.screenRecording])
  }

  func testAskedMarkerRoundTrip() throws {
    let dir = NSTemporaryDirectory() + "perm027-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let m = SetupMarker(path: dir + "/remote-desktop-setup-asked")
    XCTAssertFalse(m.exists)
    m.markAsked()
    XCTAssertTrue(m.exists)
  }

  // MARK: restart once after a grant

  func testFirstObservationNeverRestarts() {
    var w = PermissionWatcher()
    XCTAssertFalse(w.observe(both))
  }

  func testGrantSeenRestartsOnce() {
    var w = PermissionWatcher()
    XCTAssertFalse(w.observe(none))
    XCTAssertFalse(w.observe(none))
    XCTAssertTrue(w.observe(screenOnly))   // Screen Recording newly granted
    XCTAssertFalse(w.observe(screenOnly))  // no repeat
    XCTAssertTrue(w.observe(both))         // Accessibility newly granted
    XCTAssertFalse(w.observe(both))
  }

  func testRevokeThenRegrantDoesNotRestartAgain() {
    var w = PermissionWatcher()
    _ = w.observe(none)
    XCTAssertTrue(w.observe(screenOnly))
    XCTAssertFalse(w.observe(none))
    XCTAssertFalse(w.observe(screenOnly))
  }

  func testRestartTouchesServerAndBridgeOnly() {
    XCTAssertEqual(Set(RemoteDesktopPermissions.restartAgents), [.server, .daemon])
    XCTAssertEqual(RemoteDesktopPermissions.restartSkipping, [.core, .tunnel])
  }
}
