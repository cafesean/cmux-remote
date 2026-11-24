import Foundation

/// k126 (Sean 2026-11-24: "There should only be one bridge running"; m 3660: the mini ran two HyprMux Bridge
/// menu apps after the 0.3.9 -> 0.3.10 bundle swap): one menu app per Mac. Every instance runs the same rule on
/// the same list, so exactly one wins and the others quit themselves. The newest launch wins: after a bundle swap
/// that is the copy started from the new bundle. Ties (same launch second) go to the higher pid.
public enum SingleInstance {
  public struct Peer: Equatable {
    public let pid: Int32
    /// Launch time (seconds since 1970); nil when the system does not report it (sorts oldest).
    public let launched: Double?
    public init(pid: Int32, launched: Double?) {
      self.pid = pid
      self.launched = launched
    }
  }

  public enum Decision: Equatable {
    /// This instance is the one to keep; ask these others to quit.
    case keepSelf(quit: [Int32])
    /// Another instance is newer: this one quits.
    case quitSelf(winner: Int32)
  }

  /// The instance to keep among `peers` (self included).
  public static func winner(_ peers: [Peer]) -> Int32? {
    peers.max { a, b in
      let ta = a.launched ?? -.infinity, tb = b.launched ?? -.infinity
      return ta == tb ? a.pid < b.pid : ta < tb
    }?.pid
  }

  /// What this instance does. `others` = every OTHER running instance of the same bundle id.
  public static func decide(selfPeer: Peer, others: [Peer]) -> Decision {
    let rest = others.filter { $0.pid != selfPeer.pid }
    guard let w = winner(rest + [selfPeer]), w != selfPeer.pid else { return .keepSelf(quit: rest.map(\.pid)) }
    return .quitSelf(winner: w)
  }
}
