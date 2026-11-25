import XCTest
@testable import ScreenStreamCore

final class DisplayMapTests: XCTestCase {
  // Retina main (1512x982 pt @2x) + non-Retina 1920x1080 @1x left of and above it (negative origin in CG).
  let screens = [
    ScreenDesc(displayId: 1, appKitFrame: PointRect(x: 0, y: 0, w: 1512, h: 982), scale: 2),
    ScreenDesc(displayId: 4_128_833, appKitFrame: PointRect(x: -1920, y: 200, w: 1920, h: 1080), scale: 1),
  ]

  func testMainDisplayGeometry() {
    let g = DisplayMap.geometry(n: 1, screens: screens)!
    XCTAssertEqual(g.displayId, 1)
    XCTAssertEqual([g.originX, g.originY, g.ptsW, g.ptsH], [0, 0, 1512, 982])
    XCTAssertEqual([g.nativeW, g.nativeH], [3024, 1964])
  }

  func testSecondaryAtNegativeOrigin() {
    let g = DisplayMap.geometry(n: 2, screens: screens)!
    XCTAssertEqual(g.displayId, 4_128_833)
    XCTAssertEqual([g.originX, g.originY], [-1920, -298])
    XCTAssertEqual([g.nativeW, g.nativeH], [1920, 1080])
    XCTAssertEqual(g.scale, 1)
  }

  func testOutOfRange() {
    XCTAssertNil(DisplayMap.geometry(n: 0, screens: screens))
    XCTAssertNil(DisplayMap.geometry(n: 3, screens: screens))
    XCTAssertNil(DisplayMap.geometry(n: 1, screens: []))
  }

  func testCaptureMatchesByIdNotPosition() {
    // SCShareableContent order differs from NSScreen order: still picks the same display.
    XCTAssertEqual(DisplayMap.captureIndex(displayId: 4_128_833, candidates: [4_128_833, 1]), 0)
    XCTAssertEqual(DisplayMap.captureIndex(displayId: 1, candidates: [4_128_833, 1]), 1)
    XCTAssertNil(DisplayMap.captureIndex(displayId: 9, candidates: [4_128_833, 1]))
  }

  func testReorderKeepsCaptureAndInputOnSameId() {
    // Secondary becomes screens[0] (menu bar moved): display 2 is now the Retina panel, by id.
    let reordered = [
      ScreenDesc(displayId: 4_128_833, appKitFrame: PointRect(x: 0, y: 0, w: 1920, h: 1080), scale: 1),
      ScreenDesc(displayId: 1, appKitFrame: PointRect(x: 1920, y: -200, w: 1512, h: 982), scale: 2),
    ]
    let g = DisplayMap.geometry(n: 2, screens: reordered)!
    XCTAssertEqual(g.displayId, 1)
    XCTAssertEqual(DisplayMap.captureIndex(displayId: g.displayId, candidates: [1, 4_128_833]), 0)
    let p = DisplayMap.inputPoint(fx: 0.5, fy: 0.5, in: g)
    XCTAssertEqual(p.x, 1920 + 756)
    XCTAssertEqual(p.y, (1080 - (-200 + 982)) + 491)
  }

  func testInputPointClampsAndUsesPoints() {
    let g = DisplayMap.geometry(n: 2, screens: screens)!
    let mid = DisplayMap.inputPoint(fx: 0.5, fy: 0.5, in: g)
    XCTAssertEqual(mid.x, -960); XCTAssertEqual(mid.y, -298 + 540)
    let clamped = DisplayMap.inputPoint(fx: -3, fy: .nan, in: g)
    XCTAssertEqual(clamped.x, -1920); XCTAssertEqual(clamped.y, -298)
    // k94: the far edge is the display's last point (x = 0 is the NEXT display's first column)
    let far = DisplayMap.inputPoint(fx: 9, fy: 9, in: g)
    XCTAssertEqual(far.x, -1); XCTAssertEqual(far.y, -298 + 1079)
    let edge = DisplayMap.inputPoint(fx: 1, fy: 1, in: g)
    XCTAssertEqual(edge.x, -1); XCTAssertEqual(edge.y, -298 + 1079)
    let corner = DisplayMap.inputPoint(fx: 0, fy: 0, in: g)
    XCTAssertEqual(corner.x, -1920); XCTAssertEqual(corner.y, -298)
  }

  func testEncodeSizeCapsAtNativeAndIsEven() {
    XCTAssertTrue(DisplayMap.encodeSize(requestW: nil, nativeW: 3024, nativeH: 1964) == (3024, 1964))
    XCTAssertTrue(DisplayMap.encodeSize(requestW: 9999, nativeW: 1920, nativeH: 1080) == (1920, 1080))
    let s = DisplayMap.encodeSize(requestW: 1171, nativeW: 3024, nativeH: 1964)
    XCTAssertEqual(s.w % 2, 0); XCTAssertEqual(s.h % 2, 0); XCTAssertEqual(s.w, 1170)
  }
}

final class AVCCTests: XCTestCase {
  func testSplitsLengthPrefixedUnits() {
    // SEI(6) len 2, IDR(5) len 3
    let d: [UInt8] = [0, 0, 0, 2, 0x06, 0xAA, 0, 0, 0, 3, 0x65, 0x88, 0x84]
    let u = AVCC.nalUnits(d)!
    XCTAssertEqual(u.map(\.type), [6, 5])
    XCTAssertEqual(u[1].range, 10..<13)
    XCTAssertTrue(AVCC.isIDR(u))
  }

  func testPFrameIsNotIDR() {
    XCTAssertFalse(AVCC.isIDR(AVCC.nalUnits([0, 0, 0, 2, 0x41, 0x9A])!))
  }

  func testRejectsTruncatedOrZeroLength() {
    XCTAssertNil(AVCC.nalUnits([0, 0, 0, 5, 0x65, 0x88]))
    XCTAssertNil(AVCC.nalUnits([0, 0, 0, 0]))
    XCTAssertNil(AVCC.nalUnits([0, 0]))
    XCTAssertEqual(AVCC.nalUnits([])!, [])
  }
}
