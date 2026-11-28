import Foundation

/// HMX k110 step 2 (requested 2026-11-23: "capture keystrokes when the remote desktop is active … command tab … so that it
/// will actually affect the remote desktop rather than local"; again 2026-11-28: "All key combinations still apply OUTSIDE
/// of hyprmux desktop"). macOS acts on these combos before any app sees them, so the app cannot forward them; the
/// Bridge's key tap swallows exactly these while capture is on and hands them to the app, which sends them to the remote
/// Mac (remote Bridge KEY_ALLOW already allows cmd+tab, cmd+shift+tab, cmd+space, cmd+`).
/// Force Quit (⌥⌘Esc) and everything else always stays on this Mac.
public enum KeyCombo {
  public static let tab: UInt16 = 48, space: UInt16 = 49, grave: UInt16 = 50
  // CGEventFlags bits
  public static let cmd: UInt64 = 0x100000, shift: UInt64 = 0x20000, opt: UInt64 = 0x80000, ctrl: UInt64 = 0x40000

  /// The combo name for a key-down (keycode + flags), or nil when it is not one we capture.
  public static func match(keycode: UInt16, flags: UInt64) -> String? {
    guard flags & cmd != 0, flags & ctrl == 0, flags & opt == 0 else { return nil }
    let sh = flags & shift != 0
    switch keycode {
    case tab: return sh ? "cmd+shift+tab" : "cmd+tab"
    case space: return sh ? nil : "cmd+space"
    case grave: return sh ? "cmd+shift+`" : "cmd+`"
    default: return nil
    }
  }

  /// Marker set (kCGEventSourceUserData) on every event the HyprMux screen helper posts, so this Mac's key tap
  /// never swallows input a remote viewer sends to it (Remote Desktop to the same Mac would loop otherwise).
  public static let postedMarker: Int64 = 0x484D_5850   // "HMXP"
}
