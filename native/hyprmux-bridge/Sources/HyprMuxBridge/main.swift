import AppKit
import AuthenticationServices
import CoreImage
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

/// Build setting HYPRMUX_HUB_CLIENT_ID (Info.plist key); empty hides sign-in.
let hubClientId = Bundle.main.object(forInfoDictionaryKey: "HyprMuxHubClientID") as? String ?? ""
let clock = SystemClock()

func makeSession() -> BridgeSession? {
  guard let key = try? InstallKeyStore(store: LoginKeychain()).loadOrCreate() else { return nil }
  let cfg = ConnectConfig(clientId: hubClientId)
  return BridgeSession(config: cfg, hub: HTTPHubTransport(base: URL(string: "https://hub.appmatic.io")!),
                       auth: HTTPHubTransport(base: URL(string: cfg.issuer)!), state: state,
                       owner: OwnerFiles(paths: paths, keychain: LoginKeychain()), coordinator: coordinator, agents: agents,
                       clock: clock, key: key)
}

func prepareState() {
  try? state.ensure()
  try? state.retireC3IfFirstLaunch()
  _ = try? InstallKeyStore(store: LoginKeychain()).loadOrCreate()
}

if CommandLine.arguments.contains("--core") {
  prepareState()
  let guardian = VersionGuard(coordinator: coordinator, state: state, launchctl: launchctl,
                              probe: LocalServerProbe(port: serverPort()), clock: SystemClock(),
                              bundleVersion: bundleVersion, bundlePath: Bundle.main.bundlePath, selfAgent: .core)
  let outcome = guardian.runAtLaunch()
  let manifest = outcome == .updateDidNotStart ? UpdateCheck.fetch() : nil
  try? CoreStatus.from(outcome, version: bundleVersion, manifest: manifest, at: Date().timeIntervalSince1970)
    .write(to: paths.coreStatusPath)
  // Core loop: delete queue, token refresh 60 s before expiry, plan re-check (300 s), checkout poll (10 s).
  if let session = makeSession() {
    let tokenEndpoint = session.discover()?.token
    // An owner from an earlier version never created the hub app session (team gate): do it once now.
    session.refreshIfNeeded(tokenEndpoint: tokenEndpoint)
    session.ensureHubSession()
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "core"))
    timer.schedule(deadline: .now(), repeating: CheckoutPoller.interval)
    timer.setEventHandler { session.coreTick(port: serverPort(), tokenEndpoint: tokenEndpoint) }
    timer.resume()
    withExtendedLifetime(timer) { dispatchMain() }
  }
  dispatchMain()
}

/// The HyprMux logo as a template image (Contents/Resources); nil under a bare `swift run`.
let statusIcon: NSImage? = {
  guard let img = Bundle.main.image(forResource: MenuBarStatus.iconName) else { return nil }
  img.isTemplate = true
  img.size = NSSize(width: 18, height: 18)
  return img
}()

final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, ASWebAuthenticationPresentationContextProviding {
  let session = makeSession()
  var authSession: ASWebAuthenticationSession?
  var qrWindow: NSWindow?
  var qrImage: NSImageView?
  var qrLabel: NSTextField?
  var accountText: String?

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { NSApp.windows.first ?? NSWindow() }

  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let menu = NSMenu()
  var statusText = "Starting"
  var noticeText: String?
  var updateText: String?
  var coreNoticeURL: URL?
  var timer: Timer?

  override init() {
    super.init()
    if let icon = statusIcon {
      item.button?.image = icon
      item.button?.imagePosition = .imageOnly
    }
    updateButton()
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
    updateButton()
  }

  /// Logo only; the status goes to the tooltip (and the first menu line). Not Online draws the logo dimmed.
  func updateButton() {
    guard let b = item.button else { return }
    b.toolTip = MenuBarStatus.toolTip(statusText)
    b.appearsDisabled = MenuBarStatus.dimmed(statusText)
    if statusIcon == nil { b.title = MenuBarStatus.fallbackTitle(statusText) }
  }

  /// Launching the app again while it runs (Finder, Spotlight, `open`) opens the menu, so it is reachable even
  /// when a full menu bar has pushed the item under the notch.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    DispatchQueue.main.async { [weak self] in self?.showMenu() }
    return false
  }

  func showMenu() {
    if let b = item.button, let w = b.window, let screen = w.screen,
       MenuBarStatus.isReachable(item: w.frame, screen: screen.frame,
                                 notchLeft: screen.auxiliaryTopLeftArea, notchRight: screen.auxiliaryTopRightArea) {
      b.performClick(nil)
    } else {
      NSApp.activate(ignoringOtherApps: true)
      menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }
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
    if let s = session, s.config.signInVisible {
      if let sub = s.ownerSub {
        add("Account: \(sub)\(s.plan.map { " (\($0))" } ?? "")", nil, enabled: false)
        add("Devices…", #selector(showDevices))
        if s.plan != "pro" { add("Upgrade", #selector(upgrade)) }
        add("Sign Out", #selector(signOut))
      } else {
        if let why = accountText { add(why, nil, enabled: false) }
        add("Sign In…", #selector(signIn))
      }
      if let t = s.tunnelState {
        switch t {
        case .fairUse: add(TunnelState.fairUseText, nil, enabled: false)
        case .unreachable: add(TunnelState.unreachableText, nil, enabled: false)
        case .limit: add("Free plan: 1 machine", nil, enabled: false)
        default: break
        }
      }
      if s.queue.hasPending { add(TunnelDeleteQueue.pendingText, nil, enabled: false) }
    }
    add("Pair a Phone…", #selector(showQR))
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
    let on = !state.phoneAccessOn
    let port = serverPort()
    DispatchQueue.global().async { [weak self] in
      if let s = self?.session { s.setPhoneAccess(on, port: port) } else { try? state.setPhoneAccess(on) }
      DispatchQueue.main.async { self?.poll() }
    }
  }

  @objc func signIn() {
    guard let s = session else { return }
    DispatchQueue.global().async { [weak self] in
      let begun = s.beginSignInResult()
      DispatchQueue.main.async {
        guard let self else { return }
        self.accountText = nil
        let pending: BridgeSession.PendingSignIn
        switch begun {
        case .failure(let f): self.accountText = f.text; return
        case .success(let p): pending = p
        }
        let a = ASWebAuthenticationSession(url: pending.url, callbackURLScheme: "hyprmux-bridge") { url, error in
          DispatchQueue.global().async {
            if url == nil, let error {
              let f: SignInFailure = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                ? .cancelled : .browserError(code: (error as NSError).code)
              let m = s.signInFailed(f, step: "browser")
              DispatchQueue.main.async { self.accountText = m }
            } else if case .signedOut(let m) = s.completeSignIn(pending, callback: url) {
              DispatchQueue.main.async { self.accountText = m }
            } else { _ = s.readEntitlement() }
          }
        }
        a.presentationContextProvider = self
        a.prefersEphemeralWebBrowserSession = false
        self.authSession = a
        if a.start() {
          s.logSignIn("window")
        } else {
          self.accountText = s.signInFailed(.windowNotOpened, step: "window")
        }
      }
    }
  }

  @objc func signOut() { DispatchQueue.global().async { [weak self] in try? self?.session?.signOut() } }

  @objc func upgrade() {
    DispatchQueue.global().async { [weak self] in
      if let url = self?.session?.upgrade() { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
    }
  }

  func loopback() -> LoopbackServer? {
    let env = state.readEnv()
    guard let port = Int(env["PORT"] ?? ""), let token = env["SERVER_TOKEN"] else { return nil }
    return LoopbackServer(port: port, token: token)
  }

  @objc func showDevices() {
    guard let s = session else { return }
    DispatchQueue.global().async { [weak self] in
      let rows = s.devices()
      DispatchQueue.main.async {
        let alert = NSAlert()
        alert.messageText = "Devices on your plan"
        alert.informativeText = rows.isEmpty ? "No devices." : rows.map(\.deviceId).joined(separator: "\n")
        alert.addButton(withTitle: "Close")
        if let first = rows.first { alert.addButton(withTitle: "Remove \(first.deviceId) from plan") }
        if alert.runModal() == .alertSecondButtonReturn, let first = rows.first, let srv = self?.loopback() {
          DispatchQueue.global().async { _ = s.removeFromPlan(hubDeviceId: first.deviceId, localId: first.deviceId, server: srv) }
        }
      }
    }
  }

  /// One Pair a Phone window: a second click brings it to front and refreshes the code in place (one code on
  /// screen); closing the window drops it. No local server -> "Bridge isn't running".
  @objc func showQR() {
    DispatchQueue.global().async { [weak self] in
      let result = self?.loopback()?.startPairing() ?? .notRunning
      CoreLog.append("pairing-start", [("result", result.logResult)], logsDir: paths.logsDir)
      DispatchQueue.main.async { self?.presentQR(result) }
    }
  }

  func presentQR(_ result: PairingStart) {
    let w: NSWindow
    if let existing = qrWindow {
      w = existing
    } else {
      w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 340), styleMask: [.titled, .closable], backing: .buffered, defer: false)
      w.title = "Pair a Phone"
      w.isReleasedWhenClosed = false
      w.delegate = self
      let view = NSImageView(frame: NSRect(x: 20, y: 40, width: 280, height: 280))
      let label = NSTextField(labelWithString: "")
      label.frame = NSRect(x: 20, y: 10, width: 280, height: 20)
      w.contentView?.addSubview(view)
      w.contentView?.addSubview(label)
      w.center()
      qrWindow = w
      qrImage = view
      qrLabel = label
    }
    qrImage?.image = nil
    if case .link(let link) = result, let f = CIFilter(name: "CIQRCodeGenerator") {
      f.setValue(Data(link.utf8), forKey: "inputMessage")
      if let img = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) {
        let rep = NSCIImageRep(ciImage: img)
        let ns = NSImage(size: rep.size)
        ns.addRepresentation(rep)
        qrImage?.image = ns
      }
    }
    qrLabel?.stringValue = result.text
    NSApp.activate(ignoringOtherApps: true)
    w.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    guard (notification.object as? NSWindow) === qrWindow else { return }
    qrWindow = nil
    qrImage = nil
    qrLabel = nil
  }

  @objc func handleURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
    guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: s) else { return }
    DispatchQueue.global().async { [weak self] in self?.session?.handleURL(url) }
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
  @objc func stopBridge() { timer?.invalidate(); coordinator.unregisterAll(); statusText = "Stopped"; updateButton() }
  @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController()
app.delegate = controller
NSAppleEventManager.shared().setEventHandler(controller, andSelector: #selector(MenuController.handleURLEvent(_:withReplyEvent:)),
                                             forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
app.run()
