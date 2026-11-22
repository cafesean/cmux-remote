import Foundation
#if canImport(ServiceManagement)
import ServiceManagement
#endif

/// The four LaunchAgents that live inside HyprMux Bridge.app/Contents/Library/LaunchAgents.
public enum BridgeAgent: String, CaseIterable, Sendable {
  case daemon, server, tunnel, core

  public static let bundleIdentifier = "com.hyprmux.bridge"
  public var label: String { "\(Self.bundleIdentifier).\(rawValue)" }
  public var plistName: String { label + ".plist" }

  /// The set that must run: daemon, server, core always; tunnel only while Phone access is on
  /// and this Bridge's own tunnel token exists.
  public static func required(tunnel: Bool) -> [BridgeAgent] {
    tunnel ? [.daemon, .server, .core, .tunnel] : [.daemon, .server, .core]
  }
}

/// Register / unregister seam (SMAppService in the app, a fake in tests).
public protocol AgentService: AnyObject {
  func register(_ agent: BridgeAgent) throws
  func unregister(_ agent: BridgeAgent) throws
  func isRegistered(_ agent: BridgeAgent) -> Bool
}

extension AgentService {
  /// Unregister then register: launchd stops the job, then starts the copy from the current bundle.
  public func restart(_ agent: BridgeAgent) throws {
    try? unregister(agent)
    try register(agent)
  }
}

#if canImport(ServiceManagement)
public final class SMAppServiceAgents: AgentService {
  public init() {}
  private func svc(_ a: BridgeAgent) -> SMAppService { SMAppService.agent(plistName: a.plistName) }

  public func register(_ agent: BridgeAgent) throws {
    let s = svc(agent)
    if s.status == .enabled { return }
    try s.register()
  }

  public func unregister(_ agent: BridgeAgent) throws {
    let s = svc(agent)
    if s.status == .notRegistered || s.status == .notFound { return }
    try s.unregister()
  }

  public func isRegistered(_ agent: BridgeAgent) -> Bool {
    let st = svc(agent).status
    return st == .enabled || st == .requiresApproval
  }

  public func needsApproval() -> Bool {
    BridgeAgent.allCases.contains { svc($0).status == .requiresApproval }
  }
}
#endif

/// Runs a command and returns its exit status + stdout (launchctl only).
public protocol CommandRunner: Sendable {
  func run(_ path: String, _ args: [String]) -> (status: Int32, output: String)
}

public struct ProcessRunner: CommandRunner {
  public init() {}
  public func run(_ path: String, _ args: [String]) -> (status: Int32, output: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return (127, "") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
  }
}

/// `launchctl print gui/<uid>/<label>`: exit 0 = loaded (113 = not found).
public struct Launchctl: Sendable {
  public let runner: CommandRunner
  public let uid: UInt32
  public init(runner: CommandRunner = ProcessRunner(), uid: UInt32 = getuid()) {
    self.runner = runner
    self.uid = uid
  }

  public func print(_ label: String) -> (status: Int32, output: String) {
    runner.run("/bin/launchctl", ["print", "gui/\(uid)/\(label)"])
  }

  public func isLoaded(_ label: String) -> Bool { print(label).status == 0 }

  /// True when the job is `state = running` and its program lives inside `bundlePath`.
  public func isRunning(_ label: String, inside bundlePath: String) -> Bool {
    let r = print(label)
    guard r.status == 0 else { return false }
    var running = false
    var program: String?
    for raw in r.output.split(separator: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line == "state = running" { running = true }
      if line.hasPrefix("program = ") { program = String(line.dropFirst("program = ".count)) }
    }
    let root = bundlePath.hasSuffix("/") ? bundlePath : bundlePath + "/"
    return running && (program?.hasPrefix(root) ?? false)
  }
}
