import XCTest
import CryptoKit
@testable import BridgeCore

final class FakeAgents: AgentService {
  var registered = Set<BridgeAgent>()
  var log: [String] = []
  var failOn: BridgeAgent?
  func register(_ a: BridgeAgent) throws {
    if a == failOn { throw BridgeError.io("register \(a)") }
    log.append("+\(a.rawValue)"); registered.insert(a)
  }
  func unregister(_ a: BridgeAgent) throws { log.append("-\(a.rawValue)"); registered.remove(a) }
  func isRegistered(_ a: BridgeAgent) -> Bool { registered.contains(a) }
}

/// Stub launchctl: per-label exit status and `print` body.
final class StubRunner: CommandRunner, @unchecked Sendable {
  var loaded = Set<String>()
  var bootedOut = Set<String>()
  var running: [String: String] = [:] // label -> program path
  /// SMAppService BundleProgram jobs: label -> (pid, executable path), printed the way launchd really does.
  var bundleProgram: [String: (pid: Int, exe: String)] = [:]
  /// proc_pidpath stand-in: the full executable path of a BundleProgram pid.
  var pidPath: @Sendable (Int32) -> String? { { [self] pid in self.bundleProgram.values.first { $0.pid == Int(pid) }?.exe } }
  func run(_ path: String, _ args: [String]) -> (status: Int32, output: String) {
    if path == "/bin/ps" {
      let pid = Int(args.last!) ?? -1
      if let hit = bundleProgram.values.first(where: { $0.pid == pid }) { return (0, (hit.exe as NSString).lastPathComponent + "\n") } // real ps: bare argv0
      return (1, "")
    }
    let label = String(args.last!.split(separator: "/").last!)
    if let bp = bundleProgram[label] {
      return (0, "\tstate = running\n\tprogram identifier = Contents/MacOS/x (mode: 2)\n\truns = 1\n\tpid = \(bp.pid)\n")
    }
    if let prog = running[label] { return (0, "\tstate = running\n\tprogram = \(prog)\n") }
    // 0.3.6: the Bridge's own jobs count as loaded (launchd took the SMAppService registration) unless a test
    // booted one out by hand.
    if label.hasPrefix("com.hyprmux.bridge."), !bootedOut.contains(label) { return (0, "\tstate = waiting\n") }
    return loaded.contains(label) ? (0, "\tstate = waiting\n") : (113, "")
  }
}

final class FakeKeychain: KeychainStore {
  var items: [String: Data] = [:]
  var reads = 0
  func read(service: String, account: String) throws -> Data? { reads += 1; return items[service + "/" + account] }
  func write(service: String, account: String, data: Data) throws { items[service + "/" + account] = data }
  func delete(service: String, account: String) throws { items[service + "/" + account] = nil }
}

final class FakeClock: BridgeClock {
  var t: TimeInterval = 0
  func now() -> TimeInterval { t }
  func sleep(_ s: TimeInterval) { t += s }
}

final class FakeProbe: ServerProbe {
  var version: String?
  func bridgeVersion() -> String? { version }
}

final class BridgeCoreTests: XCTestCase {
  var home = ""
  var paths: BridgePaths!
  var state: BridgeState!
  var runner: StubRunner!
  var agents: FakeAgents!
  var coord: AgentCoordinator!
  let bundle = "/Applications/HyprMux Bridge.app"

  override func setUpWithError() throws {
    home = NSTemporaryDirectory() + "bridge-\(UUID().uuidString)"
    paths = BridgePaths(home: home)
    state = BridgeState(paths: paths)
    try FileManager.default.createDirectory(atPath: paths.launchAgentsDir, withIntermediateDirectories: true)
    runner = StubRunner()
    agents = FakeAgents()
    let lc = Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath)
    coord = AgentCoordinator(agents: agents, legacy: LegacyGuard(launchctl: lc, launchAgentsDir: paths.launchAgentsDir), state: state)
  }

  override func tearDownWithError() throws { try? FileManager.default.removeItem(atPath: home) }

  func mode(_ p: String) throws -> Int {
    ((try FileManager.default.attributesOfItem(atPath: p)[.posixPermissions]) as! NSNumber).intValue
  }

  // AC0: labels + bundle id
  func testLabels() {
    XCTAssertEqual(BridgeAgent.allCases.map(\.label), [
      "com.hyprmux.bridge.daemon", "com.hyprmux.bridge.server",
      "com.hyprmux.bridge.tunnel", "com.hyprmux.bridge.core"])
    XCTAssertEqual(BridgeAgent.server.plistName, "com.hyprmux.bridge.server.plist")
    XCTAssertEqual(BridgeAgent.bundleIdentifier, "com.hyprmux.bridge")
  }

  // AC1 + AC14: legacy C3 / hand-install label blocks every agent; gone -> daemon, server, core; tunnel off
  func testLegacyGuardBlocksThenRegisters() throws {
    XCTAssertLessThanOrEqual(LegacyGuard.pollInterval, 5)
    runner.loaded = ["ai.yobolabs.hyprmux.server"]
    XCTAssertEqual(coord.tick(), .waitingForLegacy(["ai.yobolabs.hyprmux.server"]))
    XCTAssertTrue(agents.registered.isEmpty)
    XCTAssertTrue(LegacyGuard.message.hasPrefix("Update the HyprMux app"))
    runner.loaded = []
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core]))
    XCTAssertEqual(agents.registered, [.daemon, .server, .core])
  }

  func testHandInstallLabelBlocks() throws {
    FileManager.default.createFile(atPath: paths.launchAgentsDir + "/com.someone.cmux-remote.server.plist", contents: Data())
    runner.loaded = ["com.someone.cmux-remote.server"]
    XCTAssertEqual(coord.tick(), .waitingForLegacy(["com.someone.cmux-remote.server"]))
    XCTAssertTrue(agents.registered.isEmpty)
  }

  // AC15: flapping label -> full set or none, never half
  func testFlappingNeverHalfRegistered() {
    let full: Set<BridgeAgent> = [.daemon, .server, .core]
    for loaded in [true, false, true, false, true] {
      runner.loaded = loaded ? ["ai.yobolabs.hyprmux.tunnel"] : []
      coord.tick()
      XCTAssertTrue(agents.registered.isEmpty || agents.registered == full, "\(agents.registered)")
    }
    agents.registered = []
    runner.loaded = []
    agents.failOn = .core
    if case .failed = coord.tick() {} else { XCTFail("expected failure") }
    XCTAssertTrue(agents.registered.isEmpty)
  }

  func testTunnelOnlyWithPhoneAccessAndOwnToken() throws {
    try state.ensure()
    try state.retireC3IfFirstLaunch()
    try state.setPhoneAccess(true)
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core]))
    try state.writeTunnelToken("tok")
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core, .tunnel]))
    try state.setPhoneAccess(false)
    coord.tick()
    XCTAssertFalse(agents.registered.contains(.tunnel))
  }

  // AC2: existing .env untouched, 0600; dir 0700
  func testStateEnsureKeepsEnv() throws {
    try BridgeState.mkdirPrivate(paths.stateDir)
    let env = "PORT=4123\nSERVER_TOKEN=aaa\nBRIDGE_SECRET=bbb\n"
    FileManager.default.createFile(atPath: paths.envPath, contents: Data(env.utf8), attributes: [.posixPermissions: 0o644])
    try state.ensure()
    // Every existing line kept verbatim; only the p42 plan keys are appended, once.
    let planKeys = "HMX_PLAN_STATE_DIR=\"\(paths.stateDir)\"\nHMX_HUB_URL=\(BridgeState.hubBase)\nSCREEN_VIEW=1\nSCREEN_CONTROL=1\nHMX_DISCOVERY_PORT=47380\n"
    XCTAssertEqual(try String(contentsOfFile: paths.envPath, encoding: .utf8), env + planKeys)
    try state.ensure()
    XCTAssertEqual(try String(contentsOfFile: paths.envPath, encoding: .utf8), env + planKeys)
    XCTAssertEqual(try mode(paths.envPath), 0o600)
    XCTAssertEqual(try mode(paths.stateDir), 0o700)
    XCTAssertEqual(try mode(paths.runDir), 0o700)
  }

  func testStateEnsureFreshWritesEnv() throws {
    try state.ensure()
    let e = state.readEnv()
    XCTAssertNotNil(Int(e["PORT"] ?? ""))
    XCTAssertEqual(e["SERVER_TOKEN"]?.count, 48)
    XCTAssertEqual(e["BRIDGE_SECRET"]?.count, 48)
    XCTAssertEqual(e["HMX_PLAN_STATE_DIR"], paths.stateDir)
    XCTAssertEqual(e["HMX_HUB_URL"], BridgeState.hubBase)
    XCTAssertEqual(try mode(paths.envPath), 0o600)
  }

  // AC3: C3 key file never read/deleted; new 32-byte key in Keychain; second run reuses it
  func testInstallKeyIgnoresC3File() throws {
    try BridgeState.mkdirPrivate(paths.stateDir)
    let c3 = Data(repeating: 7, count: 32)
    let keyFile = paths.stateDir + "/install-key"
    FileManager.default.createFile(atPath: keyFile, contents: c3, attributes: [.posixPermissions: 0o600])
    let kc = FakeKeychain()
    let k1 = try InstallKeyStore(store: kc).loadOrCreate()
    XCTAssertEqual(k1.rawRepresentation.count, 32)
    XCTAssertNotEqual(k1.rawRepresentation, c3)
    XCTAssertEqual(FileManager.default.contents(atPath: keyFile), c3)
    let k2 = try InstallKeyStore(store: kc).loadOrCreate()
    XCTAssertEqual(k1.rawRepresentation, k2.rawRepresentation)
    XCTAssertEqual(kc.items.count, 1)
  }

  // AC19: first launch retires C3 pairings + tunnel token, keeps .env; Stop Bridge unregisters all four
  func testFirstLaunchRetiresC3() throws {
    try BridgeState.mkdirPrivate(paths.stateDir)
    let fm = FileManager.default
    fm.createFile(atPath: paths.devicesPath, contents: Data("{}".utf8))
    fm.createFile(atPath: paths.tunnelTokenPath, contents: Data("c3".utf8))
    fm.createFile(atPath: paths.envPath, contents: Data("PORT=1\n".utf8))
    try state.ensure()
    try state.retireC3IfFirstLaunch()
    XCTAssertFalse(fm.fileExists(atPath: paths.devicesPath))
    XCTAssertFalse(fm.fileExists(atPath: paths.tunnelTokenPath))
    XCTAssertTrue(fm.fileExists(atPath: paths.devicesPath + ".c3-retired"))
    XCTAssertEqual(fm.contents(atPath: paths.tunnelTokenPath + ".c3-retired"), Data("c3".utf8))
    XCTAssertTrue(String(decoding: fm.contents(atPath: paths.envPath) ?? Data(), as: UTF8.self).hasPrefix("PORT=1\n"))   // kept; p42 plan keys appended
    try state.setPhoneAccess(true)
    XCTAssertFalse(coord.tick() == .registered([.daemon, .server, .core, .tunnel]))
    try state.writeTunnelToken("bridge-token") // stub ensure
    try state.retireC3IfFirstLaunch() // second launch: no-op
    XCTAssertTrue(fm.fileExists(atPath: paths.tunnelTokenPath))
    XCTAssertEqual(coord.tick(), .registered([.daemon, .server, .core, .tunnel]))
    coord.unregisterAll()
    XCTAssertTrue(agents.registered.isEmpty)
    XCTAssertTrue(fm.fileExists(atPath: paths.tunnelTokenPath + ".c3-retired"))
  }

  // MARK: VersionGuard (R13)

  func makeGuard(_ probe: FakeProbe, _ clock: FakeClock, version: String = "0.2.1") -> VersionGuard {
    VersionGuard(coordinator: coord, state: state, launchctl: Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath), probe: probe,
                 clock: clock, bundleVersion: version, bundlePath: bundle)
  }

  func runAll() {
    for a in [BridgeAgent.daemon, .server, .core] { runner.running[a.label] = bundle + "/Contents/MacOS/x" }
  }

  // 0.2.0 field bug: launchd prints BundleProgram jobs as 'program identifier' + pid, never 'program ='.
  func testIsRunningReadsBundleProgramJobsByPid() {
    let lc = Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath)
    runner.bundleProgram["com.hyprmux.bridge.server"] = (pid: 4242, exe: bundle + "/Contents/MacOS/hyprmux-runtime")
    runner.bundleProgram["com.hyprmux.bridge.daemon"] = (pid: 4343, exe: "/Applications/Other.app/Contents/MacOS/hyprmux-runtime")
    XCTAssertTrue(lc.isRunning("com.hyprmux.bridge.server", inside: bundle))
    XCTAssertFalse(lc.isRunning("com.hyprmux.bridge.daemon", inside: bundle))
    XCTAssertFalse(lc.isRunning("com.hyprmux.bridge.core", inside: bundle))
  }

  // 0.2.0 field bug: core re-registered itself before writing the marker -> killed -> KeepAlive -> loop.
  func testCoreNeverRestartsItselfAndReachesHealthy() throws {
    try state.ensure()
    let probe = FakeProbe(); probe.version = "0.2.1"
    for (i, a) in [BridgeAgent.daemon, .server, .core].enumerated() {
      runner.bundleProgram[a.label] = (pid: 5000 + i, exe: bundle + "/Contents/MacOS/x")
    }
    let g = VersionGuard(coordinator: coord, state: state, launchctl: Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath), probe: probe,
                         clock: FakeClock(), bundleVersion: "0.2.1", bundlePath: bundle, selfAgent: .core)
    XCTAssertEqual(g.runAtLaunch(), .reregistered)
    XCTAssertFalse(agents.log.contains("-core"))
    XCTAssertFalse(agents.log.contains("+core"))
    XCTAssertEqual(state.readLastRunVersion(), "0.2.1")
    agents.log.removeAll()
    XCTAssertEqual(g.runAtLaunch(), .healthy)   // next launch: marker equal + agents seen running -> no restart
    XCTAssertTrue(agents.log.isEmpty)
  }

  // AC8 + AC9: version change -> one re-register each, marker written after health
  func testVersionChangeReregistersOnce() throws {
    try state.ensure()
    try state.writeLastRunVersion("0.2.0")
    let probe = FakeProbe(); probe.version = "0.2.1"; runAll()
    XCTAssertEqual(makeGuard(probe, FakeClock()).runAtLaunch(), .reregistered)
    XCTAssertEqual(agents.log.filter { $0.hasPrefix("+") }.sorted(), ["+core", "+daemon", "+server"])
    XCTAssertEqual(state.readLastRunVersion(), "0.2.1")
  }

  func testEqualAndHealthyNoReregister() throws {
    try state.ensure()
    try state.writeLastRunVersion("0.2.1")
    let probe = FakeProbe(); probe.version = "0.2.1"; runAll()
    XCTAssertEqual(makeGuard(probe, FakeClock()).runAtLaunch(), .healthy)
    XCTAssertTrue(agents.log.isEmpty)
  }

  func testLegacyLoadedNoRegistration() throws {
    runner.loaded = ["ai.yobolabs.hyprmux.bridge"]
    XCTAssertEqual(makeGuard(FakeProbe(), FakeClock()).runAtLaunch(), .blockedByLegacy(["ai.yobolabs.hyprmux.bridge"]))
    XCTAssertTrue(agents.log.isEmpty)
  }

  // AC11 + AC17: never healthy within 60 s -> marker stays, failure outcome; previous.url available
  func testUpdateDidNotStart() throws {
    try state.ensure()
    try state.writeLastRunVersion("0.2.0")
    let clock = FakeClock()
    XCTAssertEqual(makeGuard(FakeProbe(), clock).runAtLaunch(), .updateDidNotStart)
    XCTAssertEqual(state.readLastRunVersion(), "0.2.0")
    XCTAssertGreaterThanOrEqual(clock.t, 60)
    XCTAssertEqual(VersionGuard.failureMessage, "Update didn't start. Install the previous version")
    let json = #"{"version":"0.2.1","url":"https://example.test/b-0.2.1.dmg","sha256":"x","previous":{"version":"0.2.0","url":"https://example.test/b-0.2.0.dmg","sha256":"y"}}"#
    XCTAssertEqual(UpdateCheck.previousURL(Data(json.utf8))?.absoluteString, "https://example.test/b-0.2.0.dmg")
  }

  // AC16: equal version but server down -> re-register once; marker not rewritten
  func testEqualVersionRestoreReregisters() throws {
    try state.ensure()
    try state.writeLastRunVersion("0.2.0")
    let before = try FileManager.default.attributesOfItem(atPath: paths.lastRunVersionPath)[.modificationDate] as? Date
    let probe = FakeProbe()
    let clock = FakeClock()
    let g = makeGuard(probe, clock, version: "0.2.0")
    runAll()
    // server comes up only after the re-register
    final class Flip: ServerProbe { let a: FakeAgents; init(_ a: FakeAgents) { self.a = a }
      func bridgeVersion() -> String? { a.log.isEmpty ? nil : "0.2.0" } }
    let g2 = VersionGuard(coordinator: coord, state: state, launchctl: Launchctl(runner: runner, uid: 501, pidPath: runner.pidPath), probe: Flip(agents),
                          clock: clock, bundleVersion: "0.2.0", bundlePath: bundle)
    _ = g
    XCTAssertEqual(g2.runAtLaunch(), .reregistered)
    XCTAssertEqual(agents.log.filter { $0.hasPrefix("+") }.count, 3)
    let after = try FileManager.default.attributesOfItem(atPath: paths.lastRunVersionPath)[.modificationDate] as? Date
    XCTAssertEqual(before, after)
  }

  // AC18: wrong build (version mismatch) or companion agent from a foreign path -> re-register, no marker write
  func testWrongBuildOrForeignAgentReregisters() throws {
    try state.ensure()
    try state.writeLastRunVersion("0.2.1")
    let probe = FakeProbe(); probe.version = "0.2.1"; runAll()
    runner.running[BridgeAgent.daemon.label] = "/Users/x/old/HyprMux Bridge.app/Contents/MacOS/x"
    XCTAssertEqual(makeGuard(probe, FakeClock()).runAtLaunch(), .updateDidNotStart)
    XCTAssertEqual(agents.log.filter { $0.hasPrefix("+") }.count, 3)
    agents.log = []
    runAll()
    probe.version = "0.2.0"
    XCTAssertEqual(makeGuard(probe, FakeClock()).runAtLaunch(), .updateDidNotStart)
    XCTAssertEqual(agents.log.filter { $0.hasPrefix("+") }.count, 3)
    XCTAssertEqual(state.readLastRunVersion(), "0.2.1")
  }

  // AC11 + AC17: runtime never answers (fake clock) -> core writes the notice + previous.url; the menu shows it as a link
  func testMenuShowsUpdateDidNotStartWithPreviousURL() throws {
    try state.ensure()
    try state.writeLastRunVersion("0.2.0")
    let outcome = makeGuard(FakeProbe(), FakeClock()).runAtLaunch()
    XCTAssertEqual(outcome, .updateDidNotStart)
    let manifest = Data(#"{"version":"0.2.1","url":"https://example.test/b-0.2.1.dmg","previous":{"version":"0.2.0","url":"https://example.test/b-0.2.0.dmg"}}"#.utf8)
    try CoreStatus.from(outcome, version: "0.2.1", manifest: manifest, at: 1).write(to: paths.coreStatusPath)
    XCTAssertEqual(try mode(paths.coreStatusPath), 0o600)
    let notice = MenuNotice.from(CoreStatus.read(from: paths.coreStatusPath), bundleVersion: "0.2.1")
    XCTAssertEqual(notice, MenuNotice(text: "Update didn't start. Install the previous version",
                                      url: URL(string: "https://example.test/b-0.2.0.dmg")))
    XCTAssertEqual(state.readLastRunVersion(), "0.2.0")
    // stale file from another build, or a healthy launch -> nothing shown
    XCTAssertNil(MenuNotice.from(CoreStatus.read(from: paths.coreStatusPath), bundleVersion: "0.2.2"))
    try CoreStatus.from(.healthy, version: "0.2.1", manifest: nil, at: 2).write(to: paths.coreStatusPath)
    XCTAssertNil(MenuNotice.from(CoreStatus.read(from: paths.coreStatusPath), bundleVersion: "0.2.1"))
    // manifest unreachable -> notice still shown, no link
    let noLink = CoreStatus.from(.updateDidNotStart, version: "0.2.1", manifest: nil, at: 3)
    XCTAssertEqual(MenuNotice.from(noLink, bundleVersion: "0.2.1")?.url, nil)
    XCTAssertEqual(MenuNotice.from(noLink, bundleVersion: "0.2.1")?.text, VersionGuard.failureMessage)
  }

  // Update check: manual only
  func testUpdateCheck() {
    let j = Data(#"{"version":"0.3.0","url":"https://example.test/b.dmg","sha256":"z"}"#.utf8)
    XCTAssertEqual(UpdateCheck.evaluate(j, current: "0.2.0"), .available(version: "0.3.0", url: URL(string: "https://example.test/b.dmg")!))
    XCTAssertEqual(UpdateCheck.evaluate(j, current: "0.3.0"), .upToDate)
    XCTAssertEqual(UpdateCheck.evaluate(nil, current: "0.2.0"), .couldNotCheck)
    XCTAssertEqual(UpdateCheck.evaluate(Data("nope".utf8), current: "0.2.0"), .couldNotCheck)
    XCTAssertTrue(UpdateCheck.isNewer("0.2.10", than: "0.2.9"))
  }
}
