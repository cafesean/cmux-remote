import CoreGraphics
import Foundation

/// Menu bar status item: the HyprMux logo (template image) with the status in the tooltip and the first menu line.
public enum MenuBarStatus {
  /// Contents/Resources/StatusBarIconTemplate.png (+ @2x), copied in by package-bridge.sh.
  public static let iconName = "StatusBarIconTemplate"
  public static let onlineText = "Online"

  public static func toolTip(_ status: String) -> String { "HyprMux Bridge: \(status)" }

  /// Anything but Online draws the logo dimmed.
  public static func dimmed(_ status: String) -> Bool { status != onlineText }

  /// Title used only when the icon resource is missing (a bare `swift run` outside the .app).
  public static func fallbackTitle(_ status: String) -> String { status == onlineText ? "HyprMux" : "HyprMux (\(status))" }

  /// Whether a status item whose window sits at `item` (screen coordinates) can be clicked: fully on the screen and,
  /// on a notched display, fully inside the menu bar area left or right of the notch (`NSScreen.auxiliaryTop*Area`).
  /// A full menu bar pushes items under the notch, where they draw nothing and take no clicks.
  public static func isReachable(item: CGRect, screen: CGRect, notchLeft: CGRect?, notchRight: CGRect?) -> Bool {
    guard item.width > 0, item.minX >= screen.minX, item.maxX <= screen.maxX else { return false }
    let sides = [notchLeft, notchRight].compactMap { $0 }
    if sides.isEmpty { return true }
    return sides.contains(where: { item.minX >= $0.minX && item.maxX <= $0.maxX })
  }
}
