import Foundation

public protocol BridgeClock: AnyObject {
  func now() -> TimeInterval
  func sleep(_ seconds: TimeInterval)
}

public final class SystemClock: BridgeClock {
  public init() {}
  public func now() -> TimeInterval { Date().timeIntervalSince1970 }
  public func sleep(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}

/// Local server probe: `/api/version` `bridge` field, nil when the server does not answer.
public protocol ServerProbe: AnyObject {
  func bridgeVersion() -> String?
}

/// Launch health check, independent of any marker: the server reports this bundle's version AND every
/// required agent runs from this bundle. Re-register once on a version change or any failed part;
/// write last-run-version only after the full check passes.
public final class VersionGuard {
  public static let launchCheckSeconds: TimeInterval = 10
  public static let healthGateSeconds: TimeInterval = 60
  public static let pollSeconds: TimeInterval = 1
  public static let failureMessage = "Update didn't start. Install the previous version"

  public enum Outcome: Equatable {
    case healthy
    case reregistered
    case blockedByLegacy([String])
    case updateDidNotStart
    case failed(String)
  }

  let coordinator: AgentCoordinator
  let state: BridgeState
  let launchctl: Launchctl
  let probe: ServerProbe
  let clock: BridgeClock
  let bundleVersion: String
  let bundlePath: String
  /// The agent this process runs as (core), never restarted by its own check.
  let selfAgent: BridgeAgent?

  public init(coordinator: AgentCoordinator, state: BridgeState, launchctl: Launchctl, probe: ServerProbe,
              clock: BridgeClock, bundleVersion: String, bundlePath: String, selfAgent: BridgeAgent? = nil) {
    self.coordinator = coordinator
    self.state = state
    self.launchctl = launchctl
    self.probe = probe
    self.clock = clock
    self.bundleVersion = bundleVersion
    self.bundlePath = bundlePath
    self.selfAgent = selfAgent
  }

  /// One full check: version match + each required agent running from this bundle.
  public func checkOnce() -> Bool {
    guard probe.bridgeVersion() == bundleVersion else { return false }
    return coordinator.required.allSatisfy { launchctl.isRunning($0.label, inside: bundlePath) }
  }

  func waitHealthy(_ seconds: TimeInterval) -> Bool {
    let deadline = clock.now() + seconds
    while true {
      if checkOnce() { return true }
      if clock.now() >= deadline { return false }
      clock.sleep(Self.pollSeconds)
    }
  }

  public func runAtLaunch() -> Outcome {
    let loaded = coordinator.legacy.loadedLabels()
    if !loaded.isEmpty { return .blockedByLegacy(loaded) }
    let last = state.readLastRunVersion()
    let versionChanged = last != bundleVersion
    if !versionChanged && waitHealthy(Self.launchCheckSeconds) { return .healthy }
    if case .failed(let why) = coordinator.reregisterRequired(skipping: selfAgent.map { [$0] } ?? []) { return .failed(why) }
    guard waitHealthy(Self.healthGateSeconds) else { return .updateDidNotStart }
    if versionChanged {
      do { try state.writeLastRunVersion(bundleVersion) } catch { return .failed("\(error)") }
    }
    return .reregistered
  }
}
