import Foundation
#if canImport(Security)
import Security
#endif

public enum BridgeError: Error, Equatable { case io(String) }

/// Shared state dir (same paths as the HyprMux app host, so .env PORT is kept).
public struct BridgePaths: Sendable {
  public let home: String
  public init(home: String) { self.home = home }

  public static func current() -> BridgePaths {
    if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return BridgePaths(home: String(cString: dir)) }
    return BridgePaths(home: NSHomeDirectory())
  }

  public var stateDir: String { home + "/Library/Application Support/HyprMux" }
  /// No spaces allowed in socket paths ("Application Support" has one): Caches, recreated by the runtime.
  public var runDir: String { home + "/Library/Caches/ai.yobolabs.hyprmux/run" }
  public var launchAgentsDir: String { home + "/Library/LaunchAgents" }
  public var logsDir: String { stateDir + "/logs" }
  public var envPath: String { stateDir + "/.env" }
  public var devicesPath: String { stateDir + "/devices.json" }
  public var tunnelTokenPath: String { stateDir + "/tunnel-token" }
  public var hostOwnerPath: String { stateDir + "/host-owner" }
  public var lastRunVersionPath: String { stateDir + "/last-run-version" }
  public var phoneAccessPath: String { stateDir + "/phone-access" }
  public var coreStatusPath: String { stateDir + "/core-status.json" }
}

public struct BridgeState: Sendable {
  public static let retiredSuffix = ".c3-retired"
  public let paths: BridgePaths
  public init(paths: BridgePaths) { self.paths = paths }

  private var fm: FileManager { .default }

  /// Make the state + run dirs (0700) and .env (0600) if missing. Never rewrites an existing .env.
  public func ensure() throws {
    try Self.mkdirPrivate(paths.stateDir)
    try Self.mkdirPrivate(paths.runDir)
    if fm.fileExists(atPath: paths.envPath) {
      guard chmod(paths.envPath, 0o600) == 0 else { throw BridgeError.io("chmod .env") }
      try appendPlanKeys()
      return
    }
    let bridgeSecret = try Self.randomHex(24)
    let sock = paths.runDir + "/bridge.sock"
    let lines = [
      "# HyprMux Bridge server (written on first run; 0600).",
      "PORT=\(try Self.freePort())",
      "HOST=127.0.0.1",
      "SERVER_TOKEN=\(try Self.randomHex(24))",
      "BRIDGE_SOCKET=\(sock)",
      "BRIDGE_SECRET=\(bridgeSecret)",
      "CMUX_MACHINE_URL=unix:\(sock)",
      "CMUX_MACHINE_SECRET=\(bridgeSecret)",
      "CMUX_MACHINE_LABEL=\(shortHostName())",
      "DEVICES_FILE=\(paths.devicesPath)",
    ] + planKeyLines()
    try Self.writePrivate(paths.envPath, lines.joined(separator: "\n") + "\n")
  }

  /// p42: plan enforcement in server.js is on only when it knows the Bridge state dir and the hub.
  public static let hubBase = "https://hub.appmatic.io"
  func planKeyLines() -> [String] { ["HMX_PLAN_STATE_DIR=\(paths.stateDir)", "HMX_HUB_URL=\(Self.hubBase)"] }

  /// An existing env file keeps every line as written; only missing plan keys are appended, never rewritten.
  func appendPlanKeys() throws {
    let text = (try? String(contentsOfFile: paths.envPath, encoding: .utf8)) ?? ""
    let have = Set(text.split(separator: "\n").compactMap { $0.split(separator: "=", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } })
    let add = planKeyLines().filter { !have.contains(String($0.split(separator: "=", maxSplits: 1)[0])) }
    if add.isEmpty { return }
    let sep = text.isEmpty || text.hasSuffix("\n") ? "" : "\n"
    try Self.writePrivate(paths.envPath, text + sep + add.joined(separator: "\n") + "\n")
  }

  /// First Bridge launch on a Mac that ran the app host: retire its pairings and tunnel token (.env kept),
  /// then mark this Mac as Bridge-owned. Idempotent.
  public func retireC3IfFirstLaunch() throws {
    if fm.fileExists(atPath: paths.hostOwnerPath) { return }
    for p in [paths.devicesPath, paths.tunnelTokenPath] where fm.fileExists(atPath: p) {
      let dst = p + Self.retiredSuffix
      if fm.fileExists(atPath: dst) { try fm.removeItem(atPath: dst) }
      guard rename(p, dst) == 0 else { throw BridgeError.io("retire \(p)") }
    }
    try Self.writePrivate(paths.hostOwnerPath, "bridge\n")
  }

  /// Written only by the Bridge's own tunnel ensure (after first launch retired the old one).
  public func hasOwnTunnelToken() -> Bool {
    fm.fileExists(atPath: paths.hostOwnerPath) && fm.fileExists(atPath: paths.tunnelTokenPath)
  }

  public func writeTunnelToken(_ token: String) throws {
    guard !token.contains("\n") else { throw BridgeError.io("newline") }
    try Self.writePrivate(paths.tunnelTokenPath, token)
  }

  public var phoneAccessOn: Bool { fm.fileExists(atPath: paths.phoneAccessPath) }

  public func setPhoneAccess(_ on: Bool) throws {
    if on { try Self.writePrivate(paths.phoneAccessPath, "on\n") } else { try? fm.removeItem(atPath: paths.phoneAccessPath) }
  }

  public func readLastRunVersion() -> String? {
    (try? String(contentsOfFile: paths.lastRunVersionPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public func writeLastRunVersion(_ v: String) throws { try Self.writePrivate(paths.lastRunVersionPath, v + "\n") }

  public func readEnv() -> [String: String] {
    guard let text = try? String(contentsOfFile: paths.envPath, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for raw in text.split(separator: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty || line.hasPrefix("#") { continue }
      guard let eq = line.firstIndex(of: "=") else { continue }
      out[String(line[..<eq])] = String(line[line.index(after: eq)...])
    }
    return out
  }

  // MARK: helpers

  public static func mkdirPrivate(_ path: String) throws {
    let fm = FileManager.default
    if !fm.fileExists(atPath: path) {
      try fm.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    guard chmod(path, 0o700) == 0 else { throw BridgeError.io("chmod \(path)") }
  }

  public static func writePrivate(_ path: String, _ text: String) throws {
    let tmp = path + ".tmp"
    guard FileManager.default.createFile(atPath: tmp, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else {
      throw BridgeError.io("write \(path)")
    }
    guard chmod(tmp, 0o600) == 0, rename(tmp, path) == 0 else { throw BridgeError.io("rename \(path)") }
  }

  public static func randomHex(_ bytes: Int) throws -> String {
    var buf = [UInt8](repeating: 0, count: bytes)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes, &buf) == errSecSuccess else { throw BridgeError.io("random") }
    return buf.map { String(format: "%02x", $0) }.joined()
  }

  /// A free loopback TCP port (bind :0, read it back). Picked once and kept in .env.
  public static func freePort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BridgeError.io("socket") }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    addr.sin_port = 0
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0 }
    }
    guard bound else { throw BridgeError.io("bind") }
    return Int(UInt16(bigEndian: addr.sin_port))
  }
}

/// gethostname(2), first label (ProcessInfo.hostName does DNS lookups and can block).
public func shortHostName() -> String {
  var buf = [CChar](repeating: 0, count: 256)
  guard gethostname(&buf, buf.count) == 0 else { return "This Mac" }
  let name = String(cString: buf).components(separatedBy: ".").first ?? ""
  return name.isEmpty ? "This Mac" : name
}
