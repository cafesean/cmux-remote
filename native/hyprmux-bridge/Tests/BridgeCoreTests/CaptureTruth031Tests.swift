import XCTest
@testable import BridgeCore

/// 0.3.1: the menu says Screen Recording is missing only when the bridge reports a real capture failure
/// (/cmux/screen/info canCapture === false). The menu app's own CGPreflightScreenCaptureAccess is not the runtime's grant.
final class CaptureTruth031Tests: XCTestCase {
  func info(_ cap: String, _ ctl: String = "true") -> Data { Data("{\"ok\":true,\"canCapture\":\(cap),\"canControl\":\(ctl)}".utf8) }

  func testParseBridgeInfo() {
    XCTAssertEqual(BridgeScreenTruth.parse(info("true"))?.capture, .granted)
    XCTAssertEqual(BridgeScreenTruth.parse(info("false"))?.capture, .denied)
    XCTAssertEqual(BridgeScreenTruth.parse(info("\"unknown\""))?.capture, .unknown)
    XCTAssertEqual(BridgeScreenTruth.parse(info("true", "false"))?.control, false)
    XCTAssertNil(BridgeScreenTruth.parse(Data("nope".utf8)))
  }

  func testLineHiddenWhenBridgeSaysTrue() {
    let s = RemoteDesktopPermissions.menuStatus(bridge: BridgeScreenTruth(capture: .granted, control: true), localAccessibility: true)
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(s), [])
  }

  func testLineHiddenWhenBridgeSaysUnknown() {
    let s = RemoteDesktopPermissions.menuStatus(bridge: BridgeScreenTruth(capture: .unknown, control: true), localAccessibility: true)
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(s), [])
  }

  func testLineHiddenWhenBridgeUnreachable() {
    let s = RemoteDesktopPermissions.menuStatus(bridge: nil, localAccessibility: true)
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(s), [])
  }

  func testLineShownOnlyOnRealCaptureFailure() {
    let s = RemoteDesktopPermissions.menuStatus(bridge: BridgeScreenTruth(capture: .denied, control: true), localAccessibility: true)
    XCTAssertEqual(RemoteDesktopPermissions.menuItems(s), [
      .info(RemoteDesktopPermissions.needsPermissionText), .action("Allow Screen Recording…", .allowScreenRecording)])
  }

  func testAccessibilityFromBridgeInputTrustElseLiveCheck() {
    let fromBridge = RemoteDesktopPermissions.menuStatus(bridge: BridgeScreenTruth(capture: .granted, control: false), localAccessibility: true)
    XCTAssertFalse(fromBridge.accessibility)
    let live = RemoteDesktopPermissions.menuStatus(bridge: BridgeScreenTruth(capture: .granted, control: nil), localAccessibility: false)
    XCTAssertFalse(live.accessibility)
    XCTAssertTrue(RemoteDesktopPermissions.menuStatus(bridge: nil, localAccessibility: true).accessibility)
  }
}
