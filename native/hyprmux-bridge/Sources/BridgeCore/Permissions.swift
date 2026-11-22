import Foundation
#if canImport(ApplicationServices)
import ApplicationServices
#endif

/// The two macOS privacy grants Remote Desktop needs: Screen Recording (capture) and Accessibility (input).
public enum RemoteDesktopPermission: String, CaseIterable, Equatable, Sendable {
  case screenRecording, accessibility
}

public struct PermissionStatus: Equatable, Sendable {
  public var screenRecording: Bool
  public var accessibility: Bool
  public init(screenRecording: Bool, accessibility: Bool) {
    self.screenRecording = screenRecording; self.accessibility = accessibility
  }
  public func granted(_ p: RemoteDesktopPermission) -> Bool {
    switch p {
    case .screenRecording: return screenRecording
    case .accessibility: return accessibility
    }
  }
  public var missing: [RemoteDesktopPermission] { RemoteDesktopPermission.allCases.filter { !granted($0) } }
  public var allGranted: Bool { missing.isEmpty }
}

/// What starts the setup step: the first menu launch, or a completed sign-in.
public enum PermissionSetupTrigger: Equatable, Sendable { case firstRun, signIn }

public enum RemoteDesktopPermissions {
  public static let needsPermissionText = "Remote Desktop needs permission"

  public static func settingsURL(_ p: RemoteDesktopPermission) -> URL {
    switch p {
    case .screenRecording: return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
    case .accessibility: return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
    }
  }

  static func title(_ p: RemoteDesktopPermission) -> String {
    p == .screenRecording ? "Allow Screen Recording…" : "Allow Accessibility…"
  }

  static func action(_ p: RemoteDesktopPermission) -> MenuAction {
    p == .screenRecording ? .allowScreenRecording : .allowAccessibility
  }

  /// The menu block under Status: nothing when both are granted.
  public static func menuItems(_ s: PermissionStatus) -> [MenuItem] {
    let missing = s.missing
    guard !missing.isEmpty else { return [] }
    return [.info(needsPermissionText)] + missing.map { .action(title($0), action($0)) }
  }

  /// Which system prompts to show. First run asks once (the marker remembers it); a completed sign-in asks again.
  /// Never asks for a grant that is already there.
  public static func setupRequests(_ s: PermissionStatus, trigger: PermissionSetupTrigger, askedBefore: Bool)
    -> [RemoteDesktopPermission] {
    if trigger == .firstRun && askedBefore { return [] }
    return s.missing
  }

  /// The agents that capture / inject input (hyprmux-runtime server + bridge). Core and tunnel keep running.
  public static let restartAgents: [BridgeAgent] = [.daemon, .server]
  public static var restartSkipping: Set<BridgeAgent> { Set(BridgeAgent.allCases).subtracting(restartAgents) }
}

/// 0.3.1: what the bridge (the process that captures and posts input) reports in /cmux/screen/info.
public enum CaptureTruth: Equatable, Sendable { case granted, denied, unknown }

public struct BridgeScreenTruth: Equatable, Sendable {
  public var capture: CaptureTruth
  /// The bridge's input-trust check (canControl); nil = not reported.
  public var control: Bool?
  public init(capture: CaptureTruth, control: Bool?) { self.capture = capture; self.control = control }

  /// canCapture true -> granted, false -> denied (a real capture failed), anything else ("unknown") -> unknown.
  public static func parse(_ d: Data) -> BridgeScreenTruth? {
    guard let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
    let cap: CaptureTruth
    if let n = j["canCapture"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { cap = n.boolValue ? .granted : .denied }
    else { cap = .unknown }
    var ctl: Bool? = nil
    if let n = j["canControl"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { ctl = n.boolValue }
    return BridgeScreenTruth(capture: cap, control: ctl)
  }
}

extension RemoteDesktopPermissions {
  /// The status the menu shows. Screen Recording is missing ONLY on a real capture failure the bridge reported; the
  /// menu app's own CGPreflightScreenCaptureAccess is not consulted (it is not the capturing process). Accessibility
  /// comes from the bridge's input-trust check, else the live AXIsProcessTrusted read on menu open.
  public static func menuStatus(bridge: BridgeScreenTruth?, localAccessibility: Bool) -> PermissionStatus {
    PermissionStatus(screenRecording: bridge?.capture != .denied, accessibility: bridge?.control ?? localAccessibility)
  }
}

/// Remembers that the first-run permission step has run (one empty file in the state dir).
public struct SetupMarker: Sendable {
  public let path: String
  public init(path: String) { self.path = path }
  public var exists: Bool { FileManager.default.fileExists(atPath: path) }
  public func markAsked() {
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                             withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: path, contents: Data())
  }
}

/// Re-checked on menu open (no polling). A grant seen going missing -> granted asks for one agent restart
/// (macOS often needs a relaunch before capture works); each permission restarts at most once per menu-app run.
public struct PermissionWatcher: Sendable {
  private var last: PermissionStatus?
  private var restartedFor: Set<String> = []
  public init() {}

  public mutating func observe(_ now: PermissionStatus) -> Bool {
    defer { last = now }
    guard let before = last else { return false }
    var fire = false
    for p in RemoteDesktopPermission.allCases where !before.granted(p) && now.granted(p) && !restartedFor.contains(p.rawValue) {
      restartedFor.insert(p.rawValue)
      fire = true
    }
    return fire
  }
}

/// The real TCC calls (menu app only).
public protocol PermissionProbe {
  func status() -> PermissionStatus
  func request(_ p: RemoteDesktopPermission)
}

#if canImport(ApplicationServices)
public struct SystemPermissionProbe: PermissionProbe {
  public init() {}
  public func status() -> PermissionStatus {
    PermissionStatus(screenRecording: CGPreflightScreenCaptureAccess(), accessibility: AXIsProcessTrusted())
  }
  public func request(_ p: RemoteDesktopPermission) {
    switch p {
    case .screenRecording: _ = CGRequestScreenCaptureAccess()
    case .accessibility:
      let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
      _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }
  }
}
#endif
