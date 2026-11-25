// Display identity and geometry for the screen-stream helper.
//
// Display n (1-based) is NSScreen.screens[n-1]. Its deviceDescription["NSScreenNumber"] is the
// CGDirectDisplayID; capture (SCDisplay.displayID) and input (CGEvent points) both key off that id,
// so they cannot land on different screens. AppKit frames are bottom-left origin, y up, relative to
// the main screen (screens[0]); CG global points are top-left origin of the main screen, y down.

public struct PointRect: Equatable {
  public var x: Double, y: Double, w: Double, h: Double
  public init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
}

/// What the helper reads from one NSScreen (kept AppKit-free so it can be faked in tests).
public struct ScreenDesc: Equatable {
  public var displayId: UInt32
  public var appKitFrame: PointRect
  public var scale: Double
  public init(displayId: UInt32, appKitFrame: PointRect, scale: Double) {
    self.displayId = displayId; self.appKitFrame = appKitFrame; self.scale = scale
  }
}

public struct DisplayGeometry: Equatable {
  public var displayId: UInt32
  /// CG global points (top-left origin of the main display).
  public var originX: Double, originY: Double, ptsW: Double, ptsH: Double
  public var nativeW: Int, nativeH: Int
  public var scale: Double
}

public enum DisplayMap {
  /// AppKit (bottom-left, y up) -> CG global (top-left, y down). mainHeight = screens[0] height in points.
  public static func cgGlobalRect(_ f: PointRect, mainHeight: Double) -> PointRect {
    PointRect(x: f.x, y: mainHeight - (f.y + f.h), w: f.w, h: f.h)
  }

  /// Display n (1-based, same order as screencapture -D n) -> geometry, or nil when n is out of range.
  public static func geometry(n: Int, screens: [ScreenDesc]) -> DisplayGeometry? {
    guard n >= 1, n <= screens.count, let main = screens.first else { return nil }
    let s = screens[n - 1]
    let r = cgGlobalRect(s.appKitFrame, mainHeight: main.appKitFrame.h)
    return DisplayGeometry(displayId: s.displayId, originX: r.x, originY: r.y, ptsW: r.w, ptsH: r.h,
                           nativeW: Int((r.w * s.scale).rounded()), nativeH: Int((r.h * s.scale).rounded()),
                           scale: s.scale)
  }

  /// Index of the capture target whose displayID matches (never positional).
  public static func captureIndex(displayId: UInt32, candidates: [UInt32]) -> Int? {
    candidates.firstIndex(of: displayId)
  }

  /// Input fraction (of the display's points rectangle, clamped to 0...1) -> CG global point.
  /// k94: the far edge (fraction 1) is the display's LAST point, never `origin + size`: that point is outside the
  /// display (on the next display, or nowhere), so the Dock and the right/bottom hot corners never saw the pointer.
  public static func inputPoint(fx: Double, fy: Double, in g: DisplayGeometry) -> (x: Double, y: Double) {
    let cx = fx.isFinite ? min(max(fx, 0), 1) : 0
    let cy = fy.isFinite ? min(max(fy, 0), 1) : 0
    return (g.originX + min(cx * g.ptsW, max(g.ptsW - 1, 0)), g.originY + min(cy * g.ptsH, max(g.ptsH - 1, 0)))
  }

  /// Encoded size: requested px capped at native, aspect kept, even dimensions (H.264 4:2:0).
  public static func encodeSize(requestW: Int?, nativeW: Int, nativeH: Int) -> (w: Int, h: Int) {
    let w = min(max(requestW ?? nativeW, 2), nativeW)
    let h = Int((Double(nativeH) * Double(w) / Double(nativeW)).rounded())
    return (w & ~1, max(h, 2) & ~1)
  }
}
