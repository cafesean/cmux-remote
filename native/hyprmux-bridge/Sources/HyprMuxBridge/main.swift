import AppKit
import BridgeCore

// HyprMux Bridge: menu bar UI (default) or the headless `--core` LaunchAgent.
// Quit ends only the menu bar process; registered agents (core included) keep running.

let paths = BridgePaths.current()
let state = BridgeState(paths: paths)
let launchctl = Launchctl()
let legacy = LegacyGuard(launchctl: launchctl, launchAgentsDir: paths.launchAgentsDir)
let agents = SMAppServiceAgents()
let coordinator = AgentCoordinator(agents: agents, legacy: legacy, state: state)
let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"

func serverPort() -> Int { Int(state.readEnv()["PORT"] ?? "") ?? 0 }

func prepareState() {
  try? state.ensure()
  try? state.retireC3IfFirstLaunch()
  _ = try? InstallKeyStore(store: LoginKeychain()).loadOrCreate()
}

if CommandLine.arguments.contains("--core") {
  prepareState()
  let guardian = VersionGuard(coordinator: coordinator, state: state, launchctl: launchctl,
                              probe: LocalServerProbe(port: serverPort()), clock: SystemClock(),
                              bundleVersion: bundleVersion, bundlePath: Bundle.main.bundlePath)
  let outcome = guardian.runAtLaunch()
  let manifest = outcome == .updateDidNotStart ? UpdateCheck.fetch() : nil
  try? CoreStatus.from(outcome, version: bundleVersion, manifest: manifest, at: Date().timeIntervalSince1970)
    .write(to: paths.coreStatusPath)
  dispatchMain()
}

final class MenuController: NSObject, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let menu = NSMenu()
  var statusText = "Starting"
  var noticeText: String?
  var updateText: String?
  var coreNoticeURL: URL?
  var timer: Timer?

  override init() {
    super.init()
    item.button?.title = "HyprMux"
    menu.delegate = self
    item.menu = menu
    prepareState()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: LegacyGuard.pollInterval, repeats: true) { [weak self] _ in self?.poll() }
  }

  func poll() {
    switch coordinator.tick() {
    case .waitingForLegacy:
      statusText = "Stopped"
      noticeText = LegacyGuard.message
    case .registered:
      noticeText = nil
      statusText = agents.needsApproval() ? "Needs approval" : (healthOK() ? "Online" : "Starting")
    case .failed(let why):
      statusText = "Stopped"
      noticeText = why
    }
    item.button?.title = statusText == "Online" ? "HyprMux" : "HyprMux (\(statusText))"
  }

  func healthOK() -> Bool {
    let port = serverPort()
    guard port > 0, let url = URL(string: "http://127.0.0.1:\(port)/healthz") else { return false }
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: URLRequest(url: url, timeoutInterval: 1)) { _, r, _ in
      ok = (r as? HTTPURLResponse)?.statusCode == 200
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2)
    return ok
  }

  func add(_ title: String, _ action: Selector?, enabled: Bool = true) {
    let mi = NSMenuItem(title: title, action: action, keyEquivalent: "")
    mi.target = self
    mi.isEnabled = enabled && action != nil
    menu.addItem(mi)
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    add("Status: \(statusText)", nil, enabled: false)
    if let n = noticeText { add(n, nil, enabled: false) }
    if let core = MenuNotice.from(CoreStatus.read(from: paths.coreStatusPath), bundleVersion: bundleVersion) {
      coreNoticeURL = core.url
      add(core.text, core.url == nil ? nil : #selector(openCoreNotice))
    }
    add("Version \(bundleVersion)", nil, enabled: false)
    menu.addItem(.separator())
    let phone = NSMenuItem(title: "Phone access", action: #selector(togglePhone), keyEquivalent: "")
    phone.target = self
    phone.state = state.phoneAccessOn ? .on : .off
    menu.addItem(phone)
    add(updateText ?? "Check for Update", #selector(checkUpdate))
    add("Restart", #selector(restart))
    add("Open Logs", #selector(openLogs))
    add("Stop Bridge", #selector(stopBridge))
    menu.addItem(.separator())
    add("Quit", #selector(quit))
  }

  @objc func togglePhone() {
    try? state.setPhoneAccess(!state.phoneAccessOn)
    poll()
  }

  @objc func checkUpdate() {
    switch UpdateCheck.evaluate(UpdateCheck.fetch(), current: bundleVersion) {
    case .available(_, let url): NSWorkspace.shared.open(url); updateText = nil
    case .upToDate: updateText = "Up to date"
    case .couldNotCheck: updateText = UpdateCheck.couldNotCheckText
    }
  }

  @objc func openCoreNotice() { if let u = coreNoticeURL { NSWorkspace.shared.open(u) } }
  @objc func restart() { _ = coordinator.reregisterRequired(); poll() }
  @objc func openLogs() { NSWorkspace.shared.open(URL(fileURLWithPath: paths.logsDir)) }
  @objc func stopBridge() { timer?.invalidate(); coordinator.unregisterAll(); statusText = "Stopped" }
  @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController()
app.run()
