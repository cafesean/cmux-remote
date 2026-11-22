import Foundation

/// Upgrade gap: replacing the app bundle leaves the agents launchd already runs on the old binary until they
/// are killed. On menu-app launch, compare this bundle's version with the running core's /api/version and,
/// when they differ, restart the agents the same way the menu's Restart does (SMAppService unregister +
/// register through AgentCoordinator), never with launchctl.
public enum UpgradeRestart {
  public enum Decision: Equatable {
    /// Running core matches this bundle, or nothing answered (core not up yet: launchd starts the new copy).
    case none
    /// The running core reports another version: restart the agents.
    case restart(running: String)
  }

  public static func decide(bundleVersion: String, runningVersion: String?) -> Decision {
    guard let running = runningVersion?.trimmingCharacters(in: .whitespacesAndNewlines), !running.isEmpty,
          running != bundleVersion else { return .none }
    return .restart(running: running)
  }

  /// One check at menu launch. Legacy agents loaded = the coordinator is waiting; leave them alone.
  @discardableResult
  public static func runAtMenuLaunch(probe: ServerProbe, coordinator: AgentCoordinator, bundleVersion: String) -> Decision {
    guard coordinator.legacy.loadedLabels().isEmpty else { return .none }
    let d = decide(bundleVersion: bundleVersion, runningVersion: probe.bridgeVersion())
    if case .restart = d { _ = coordinator.reregisterRequired() }
    return d
  }
}
