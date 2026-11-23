import XCTest
@testable import BridgeCore

final class BundleSwapTests: XCTestCase {
  func testReplacedOnlyWhenDiskDiffers() {
    XCTAssertFalse(BundleSwap.replaced(running: "0.3.8", onDisk: "0.3.8"))
    XCTAssertTrue(BundleSwap.replaced(running: "0.3.8", onDisk: "0.3.9"))
    XCTAssertTrue(BundleSwap.replaced(running: "0.3.8", onDisk: "0.3.7"))
    XCTAssertFalse(BundleSwap.replaced(running: "0.3.8", onDisk: nil))
  }

  func testOnDiskVersionReadsInfoPlistFresh() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bswap-\(UUID().uuidString).app")
    let contents = dir.appendingPathComponent("Contents")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    func write(_ v: String) throws {
      let d = try PropertyListSerialization.data(fromPropertyList: ["CFBundleShortVersionString": v], format: .xml, options: 0)
      try d.write(to: contents.appendingPathComponent("Info.plist"))
    }
    try write("0.3.8")
    XCTAssertEqual(BundleSwap.onDiskVersion(bundlePath: dir.path), "0.3.8")
    try write("0.3.9")
    XCTAssertEqual(BundleSwap.onDiskVersion(bundlePath: dir.path), "0.3.9")
    XCTAssertNil(BundleSwap.onDiskVersion(bundlePath: dir.path + "-missing"))
  }
}
