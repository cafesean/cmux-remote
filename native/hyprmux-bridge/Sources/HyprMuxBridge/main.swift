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
let permissionProbe = SystemPermissionProbe()
let permissionMarker = SetupMarker(path: paths.stateDir + "/remote-desktop-setup-asked")

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
    timer.setEventHandler {
      // k123: a replaced bundle (manual DMG update with the menu app closed) must not keep running old code.
      let onDisk = BundleSwap.onDiskVersion(bundlePath: Bundle.main.bundlePath)
      if BundleSwap.replaced(running: bundleVersion, onDisk: onDisk) {
        CoreLog.append("bundle-replaced-restart", [("running", bundleVersion), ("disk", onDisk ?? "-")], logsDir: paths.logsDir)
        exit(0)
      }
      session.coreTick(port: serverPort(), tokenEndpoint: tokenEndpoint)
    }
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
  var accountText: String?

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { NSApp.windows.first ?? NSWindow() }

  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let menu = NSMenu()
  var statusText = "Starting"
  var noticeText: String?
  var coreNoticeURL: URL?
  var updateText: String?
  var timer: Timer?
  var permissions: PermissionStatus?
  var permissionWatcher = PermissionWatcher()

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
    // Upgrade gap: a replaced bundle leaves the old core running; restart the agents once when versions differ.
    DispatchQueue.global().async { [weak self] in
      let d = UpgradeRestart.runAtMenuLaunch(probe: LocalServerProbe(port: serverPort()), coordinator: coordinator,
                                             bundleVersion: bundleVersion)
      if case .restart = d { DispatchQueue.main.async { self?.poll() } }
    }
    timer = Timer.scheduledTimer(withTimeInterval: LegacyGuard.pollInterval, repeats: true) { [weak self] _ in self?.poll() }
    checkPermissions()
    runPermissionSetup(.firstRun)
  }

  // MARK: Remote Desktop permissions (Screen Recording + Accessibility)
  //
  // TCC charges capture and input to the responsible process. hyprmux-runtime (which spawns hm-screen-stream and
  // posts input) runs as an SMAppService BundleProgram agent inside this bundle, so macOS lists the grant under
  // HyprMux Bridge (com.hyprmux.bridge), the same identity as this menu app: asking here grants the Bridge.

  /// Re-reads both grants (menu open; no polling). A grant that just appeared restarts server + bridge once,
  /// through the SMAppService path (never launchctl), so capture works without quitting anything.
  func checkPermissions() {
    // 0.3.1: the menu line trusts the bridge's real capture result, not this process's preflight.
    let now = RemoteDesktopPermissions.menuStatus(bridge: loopback()?.screenTruth(),
                                                  localAccessibility: permissionProbe.status().accessibility)
    permissions = now
    guard permissionWatcher.observe(now) else { return }
    CoreLog.append("permission-granted-restart", [("screen", now.screenRecording ? "1" : "0"),
                                                  ("ax", now.accessibility ? "1" : "0")], logsDir: paths.logsDir)
    DispatchQueue.global().async { [weak self] in
      guard legacy.loadedLabels().isEmpty else { return }
      _ = coordinator.reregisterRequired(skipping: RemoteDesktopPermissions.restartSkipping)
      DispatchQueue.main.async { self?.poll() }
    }
  }

  /// Setup step: the system prompts for whatever is still missing (first run once; again after each sign-in).
  func runPermissionSetup(_ trigger: PermissionSetupTrigger) {
    let asks = RemoteDesktopPermissions.setupRequests(permissionProbe.status(), trigger: trigger,
                                                      askedBefore: permissionMarker.exists)
    if trigger == .firstRun { permissionMarker.markAsked() }
    guard !asks.isEmpty else { return }
    NSApp.activate(ignoringOtherApps: true)
    for p in asks { permissionProbe.request(p) }
  }

  func openPermissionPane(_ p: RemoteDesktopPermission) { NSWorkspace.shared.open(RemoteDesktopPermissions.settingsURL(p)) }

  /// k95: pick the folder files dropped into a session are saved to; saved as UPLOAD_DIR, then the daemon restarts
  /// so it takes the new folder (the server and tunnel keep running).
  func chooseUploadFolder() {
    let panel = NSOpenPanel()
    panel.title = "Upload Folder"
    panel.message = "Files you drop into a HyprMux session are saved here."
    panel.prompt = "Use Folder"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.directoryURL = URL(fileURLWithPath: state.uploadDir())
    NSApp.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK, let url = panel.url else { return }
    do {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      try state.setUploadDir(url.path)
      try agents.restart(.daemon)
    } catch {
      let a = NSAlert()
      a.messageText = "Couldn't use that folder"
      a.informativeText = "\(error)"
      a.runModal()
    }
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

  var menuActions: [MenuAction] = []

  func render(_ items: [MenuItem], into menu: NSMenu) {
    for it in items {
      switch it {
      case .separator: menu.addItem(.separator())
      case .info(let t, let tip):
        let mi = NSMenuItem(title: t, action: nil, keyEquivalent: "")
        mi.isEnabled = false
        mi.toolTip = tip
        menu.addItem(mi)
      case .prominent(let t, let a):
        let mi = NSMenuItem(title: t, action: #selector(performMenuAction(_:)), keyEquivalent: "")
        mi.target = self
        mi.tag = menuActions.count
        menuActions.append(a)
        mi.attributedTitle = NSAttributedString(string: t, attributes: [
          .font: NSFont.menuFont(ofSize: 0).withTraits(.bold), .foregroundColor: NSColor.controlAccentColor])
        if let img = NSImage(systemSymbolName: MenuModel.upgradeSymbol, accessibilityDescription: nil) {
          mi.image = img.withSymbolConfiguration(.init(paletteColors: [.white, .controlAccentColor]))
        }
        menu.addItem(mi)
      case .action(let t, let a, let checked):
        let mi = NSMenuItem(title: t, action: #selector(performMenuAction(_:)), keyEquivalent: "")
        mi.target = self
        mi.tag = menuActions.count
        menuActions.append(a)
        mi.state = checked ? .on : .off
        menu.addItem(mi)
      case .submenu(let t, let sub):
        let mi = NSMenuItem(title: t, action: nil, keyEquivalent: "")
        let m = NSMenu(title: t)
        render(sub, into: m)
        mi.submenu = m
        menu.addItem(mi)
      }
    }
  }

  func menuInput() -> MenuInput {
    var problems: [String] = []
    if let n = noticeText { problems.append(n) }
    let s = session
    let signedIn = s?.ownerSub != nil
    if let s, s.config.signInVisible {
      if !signedIn, let why = accountText { problems.append(why) }
      switch s.tunnelState {
      case .fairUse?: problems.append(TunnelState.fairUseText)
      case .unreachable?: problems.append(TunnelState.unreachableText)
      case .limit?: problems.append("Free plan: 1 machine")
      default: break
      }
      if s.queue.hasPending { problems.append(TunnelDeleteQueue.pendingText) }
    }
    if let u = updateText { problems.append(u) }
    let core = MenuNotice.from(CoreStatus.read(from: paths.coreStatusPath), bundleVersion: bundleVersion)
    coreNoticeURL = core?.url
    return MenuInput(status: statusText, hostname: state.phoneAccessOn ? state.readLastTunnel()?.hostname : nil,
                     signInVisible: s?.config.signInVisible ?? false, signedIn: signedIn, email: s?.accountEmail, plan: s?.plan,
                     canManagePlan: s?.canManagePlan ?? false, problems: problems, notice: core?.text, noticeOpens: core?.url != nil,
                     remoteAccessOn: state.phoneAccessOn, version: bundleVersion,
                     optionHeld: NSEvent.modifierFlags.contains(.option), permissions: permissions)
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    menuActions = []
    checkPermissions()
    render(MenuModel.items(menuInput()), into: menu)
  }

  @objc func performMenuAction(_ sender: NSMenuItem) {
    guard sender.tag >= 0, sender.tag < menuActions.count else { return }
    switch menuActions[sender.tag] {
    case .signIn: signIn()
    case .connectDevice: connectDevice()
    case .devices: showDevices()
    case .toggleRemoteAccess: togglePhone()
    case .upgrade: upgrade()
    case .restart: restart()
    case .openLogs: openLogs()
    case .signOut: signOut()
    case .quit: quit()
    case .openNotice: openCoreNotice()
    case .managePlan: managePlan()
    case .stopBridge: stopBridge()
    case .checkUpdate: checkUpdate()
    case .allowScreenRecording: openPermissionPane(.screenRecording)
    case .allowAccessibility: openPermissionPane(.accessibility)
    case .chooseUploadFolder: chooseUploadFolder()
    }
  }

  /// Allow Remote Access: off stops the tunnel agent only (the tunnel and its hostname are kept, never deleted).
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
            } else {
              _ = s.readEntitlement()
              DispatchQueue.main.async { self.runPermissionSetup(.signIn) }
            }
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

  /// Manage Plan: manageUrl "portal" needs a hub round trip, so off the main thread.
  @objc func managePlan() {
    DispatchQueue.global().async { [weak self] in
      if let url = self?.session?.managePlanURL() { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
    }
  }

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

  // MARK: Connect a Device (one window: QR, code, address, Copy Link)

  var connectWindow: NSWindow?
  var connectQR: NSImageView?
  var connectStatus: NSTextField?
  var connectCode: NSTextField?
  var connectAddress: NSTextField?
  var connectCopy: NSButton?
  var connectLink: String?
  var connectRun = 0

  /// Turns Remote Access on first when it is off (or the server's PUBLIC_URL is not the ensured host), shows
  /// "Starting…" until the remote address answers, then starts pairing. A second click refreshes the same window.
  @objc func connectDevice() {
    connectRun += 1
    let run = connectRun
    presentConnect(nil, status: "Starting…")
    let port = serverPort()
    DispatchQueue.global().async { [weak self] in
      guard let self else { return }
      let host = state.readLastTunnel()?.hostname
      let published = host.map { state.readEnv()["PUBLIC_URL"] == "https://\($0)" } ?? false
      var ensured = host
      if !state.phoneAccessOn || !state.hasOwnTunnelToken() || !published {
        guard let s = self.session else { return self.connectDone(run, nil, status: "Sign in to connect a device.") }
        let t = s.setPhoneAccess(true, port: port)
        DispatchQueue.main.async { self.poll() }
        guard case .ready(_, let h) = t else { return self.connectDone(run, nil, status: Self.connectFailure(t)) }
        ensured = h
      }
      if let h = ensured { _ = Self.waitUntilUp(URL(string: "https://\(h)/healthz")) }
      _ = Self.waitUntilUp(URL(string: "http://127.0.0.1:\(serverPort())/healthz"))
      let result = self.loopback()?.startPairing() ?? .notRunning
      CoreLog.append("pairing-start", [("result", result.logResult)], logsDir: paths.logsDir)
      self.connectDone(run, result, status: result.text)
    }
  }

  static func connectFailure(_ t: TunnelState?) -> String {
    switch t {
    case .signInRequired?: return "Sign in to connect a device."
    case .limit?: return "Free plan: 1 machine. Upgrade to connect this Mac."
    case .fairUse?: return TunnelState.fairUseText
    case .unreachable?: return TunnelState.unreachableText
    default: return "Couldn't turn on Remote Access."
    }
  }

  /// Polls url (1 s apart, up to 20 s) until it answers 200.
  static func waitUntilUp(_ url: URL?) -> Bool {
    guard let url else { return false }
    for _ in 0..<20 {
      var ok = false
      let sem = DispatchSemaphore(value: 0)
      URLSession.shared.dataTask(with: URLRequest(url: url, timeoutInterval: 2)) { _, r, _ in
        ok = (r as? HTTPURLResponse)?.statusCode == 200
        sem.signal()
      }.resume()
      _ = sem.wait(timeout: .now() + 3)
      if ok { return true }
      Thread.sleep(forTimeInterval: 1)
    }
    return false
  }

  func connectDone(_ run: Int, _ result: PairingStart?, status: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self, run == self.connectRun, self.connectWindow != nil else { return }
      self.presentConnect(result, status: status)
    }
  }

  func label(_ s: String, _ frame: NSRect, size: CGFloat, mono: Bool = false) -> NSTextField {
    let l = NSTextField(labelWithString: s)
    l.frame = frame
    l.alignment = .center
    l.font = mono ? .monospacedSystemFont(ofSize: size, weight: .semibold) : .systemFont(ofSize: size)
    l.isSelectable = true
    return l
  }

  func presentConnect(_ result: PairingStart?, status: String) {
    let w: NSWindow
    if let existing = connectWindow {
      w = existing
    } else {
      w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 440), styleMask: [.titled, .closable], backing: .buffered, defer: false)
      w.title = "Connect a Device"
      w.isReleasedWhenClosed = false
      w.delegate = self
      let v = w.contentView!
      let qr = NSImageView(frame: NSRect(x: 40, y: 160, width: 260, height: 260))
      let st = label("", NSRect(x: 20, y: 128, width: 300, height: 20), size: 13)
      let code = label("", NSRect(x: 20, y: 92, width: 300, height: 30), size: 24, mono: true)
      let addr = label("", NSRect(x: 20, y: 66, width: 300, height: 20), size: 12)
      let copy = NSButton(title: "Copy Link", target: self, action: #selector(copyConnectLink))
      copy.frame = NSRect(x: 110, y: 20, width: 120, height: 32)
      for x in [qr, st, code, addr, copy] as [NSView] { v.addSubview(x) }
      w.center()
      connectWindow = w; connectQR = qr; connectStatus = st; connectCode = code; connectAddress = addr; connectCopy = copy
    }
    var parts: PairingLink?
    if case .link(let l)? = result { parts = PairingLink.parse(l) ?? PairingLink(link: l, address: "", code: "") }
    connectLink = parts?.link
    connectQR?.image = parts.flatMap { Self.qrImage($0.link) }
    connectStatus?.stringValue = status
    connectCode?.stringValue = parts?.code ?? ""
    connectAddress?.stringValue = parts?.address ?? ""
    connectCopy?.isEnabled = parts != nil
    NSApp.activate(ignoringOtherApps: true)
    w.makeKeyAndOrderFront(nil)
  }

  static func qrImage(_ link: String) -> NSImage? {
    guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    f.setValue(Data(link.utf8), forKey: "inputMessage")
    guard let img = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
    let rep = NSCIImageRep(ciImage: img)
    let ns = NSImage(size: rep.size)
    ns.addRepresentation(rep)
    return ns
  }

  @objc func copyConnectLink() {
    guard let l = connectLink else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(l, forType: .string)
    connectStatus?.stringValue = "Link copied"
  }

  func windowWillClose(_ notification: Notification) {
    guard (notification.object as? NSWindow) === connectWindow else { return }
    connectWindow = nil; connectQR = nil; connectStatus = nil; connectCode = nil; connectAddress = nil; connectCopy = nil
    connectLink = nil
  }

  @objc func handleURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
    guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: s) else { return }
    DispatchQueue.global().async { [weak self] in self?.session?.handleURL(url) }
  }

  @objc func openCoreNotice() { if let u = coreNoticeURL { NSWorkspace.shared.open(u) } }
  @objc func restart() { _ = coordinator.reregisterRequired(); poll() }
  @objc func openLogs() { NSWorkspace.shared.open(URL(fileURLWithPath: paths.logsDir)) }
  @objc func quit() { NSApp.terminate(nil) }

  /// Troubleshooting (Option held): manual update check; the result shows as one line until the next check.
  @objc func checkUpdate() {
    switch UpdateCheck.evaluate(UpdateCheck.fetch(), current: bundleVersion) {
    case .available(_, let url): NSWorkspace.shared.open(url); updateText = nil
    case .upToDate: updateText = "Up to date"
    case .couldNotCheck: updateText = UpdateCheck.couldNotCheckText
    }
  }
  /// Troubleshooting (Option held): unregister every agent until the next launch or Restart.
  @objc func stopBridge() { timer?.invalidate(); coordinator.unregisterAll(); statusText = "Stopped"; updateButton() }
}

extension NSFont {
  func withTraits(_ t: NSFontDescriptor.SymbolicTraits) -> NSFont {
    NSFont(descriptor: fontDescriptor.withSymbolicTraits(t), size: pointSize) ?? self
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = MenuController()
app.delegate = controller
NSAppleEventManager.shared().setEventHandler(controller, andSelector: #selector(MenuController.handleURLEvent(_:withReplyEvent:)),
                                             forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
app.run()
