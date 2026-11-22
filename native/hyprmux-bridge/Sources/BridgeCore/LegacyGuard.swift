import Foundation

/// Blocks every Bridge agent while an older phone-access host still runs on this Mac:
/// the HyprMux app's own agents or a hand-installed cmux-remote (launchd plists in ~/Library/LaunchAgents).
public struct LegacyGuard: Sendable {
  public static let pollInterval: TimeInterval = 5
  public static let message = "Update the HyprMux app (or stop the old cmux-remote install) to move phone access here"
  public static let appLabels = ["ai.yobolabs.hyprmux.server", "ai.yobolabs.hyprmux.bridge", "ai.yobolabs.hyprmux.tunnel"]

  public let launchctl: Launchctl
  public let launchAgentsDir: String

  public init(launchctl: Launchctl, launchAgentsDir: String) {
    self.launchctl = launchctl
    self.launchAgentsDir = launchAgentsDir
  }

  /// Hand-install labels come from plist names `*.cmux-remote.{bridge,server}.plist`.
  public func candidateLabels() -> [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: launchAgentsDir)) ?? []
    let hand = names.filter { $0.hasSuffix(".cmux-remote.bridge.plist") || $0.hasSuffix(".cmux-remote.server.plist") }
      .map { String($0.dropLast(".plist".count)) }
      .sorted()
    return Self.appLabels + hand
  }

  public func loadedLabels() -> [String] { candidateLabels().filter { launchctl.isLoaded($0) } }
}
