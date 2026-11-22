import Foundation

/// Registers the Bridge agents as one set: either the full required set or none.
public final class AgentCoordinator {
  public enum Phase: Equatable {
    case waitingForLegacy([String])
    case registered([BridgeAgent])
    case failed(String)
  }

  let agents: AgentService
  let legacy: LegacyGuard
  let state: BridgeState

  public init(agents: AgentService, legacy: LegacyGuard, state: BridgeState) {
    self.agents = agents
    self.legacy = legacy
    self.state = state
  }

  public var wantsTunnel: Bool { state.phoneAccessOn && state.hasOwnTunnelToken() }
  public var required: [BridgeAgent] { BridgeAgent.required(tunnel: wantsTunnel) }

  /// One poll (every LegacyGuard.pollInterval while waiting).
  @discardableResult
  public func tick() -> Phase {
    let loaded = legacy.loadedLabels()
    if !loaded.isEmpty {
      unregisterAll()
      return .waitingForLegacy(loaded)
    }
    return registerRequired()
  }

  /// Register the required set; on any failure roll back to none. Drops the tunnel agent when not wanted.
  public func registerRequired() -> Phase {
    let want = required
    var done: [BridgeAgent] = []
    do {
      for a in want {
        try agents.register(a)
        done.append(a)
      }
    } catch {
      for a in done { try? agents.unregister(a) }
      return .failed("\(error)")
    }
    for a in BridgeAgent.allCases where !want.contains(a) && agents.isRegistered(a) { try? agents.unregister(a) }
    return .registered(want)
  }

  /// Restart (unregister + register) each required agent exactly once. `skipping` = the agent the caller runs
  /// as (core): unregistering it would kill the caller before it can record health, and launchd relaunches it
  /// (KeepAlive) into the same re-register: a restart loop. The running caller is already this bundle's copy.
  public func reregisterRequired(skipping: Set<BridgeAgent> = []) -> Phase {
    let want = required
    do {
      for a in want where !skipping.contains(a) { try agents.restart(a) }
    } catch {
      for a in want where !skipping.contains(a) { try? agents.unregister(a) }
      return .failed("\(error)")
    }
    return .registered(want)
  }

  /// Menu "Stop Bridge": unregister all four (manual rollback path).
  public func unregisterAll() {
    for a in BridgeAgent.allCases where agents.isRegistered(a) { try? agents.unregister(a) }
  }
}
