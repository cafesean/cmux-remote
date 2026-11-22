import Foundation

/// The menu bar menu as data: BridgeState-derived input -> items. main.swift only renders it.
public enum MenuAction: Equatable, Sendable {
  case signIn, connectDevice, devices, toggleRemoteAccess, upgrade, restart, openLogs, signOut, quit, openNotice
}

public indirect enum MenuItem: Equatable, Sendable {
  /// Disabled line; tooltip optional.
  case info(String, tooltip: String? = nil)
  case action(String, MenuAction, checked: Bool = false)
  case submenu(String, [MenuItem])
  case separator
}

public struct MenuInput: Equatable, Sendable {
  /// Online / Starting / Needs approval / Stopped (MenuController.poll).
  public var status: String
  /// The ensured remote hostname (last-tunnel.json), for the status tooltip.
  public var hostname: String?
  public var signInVisible: Bool
  public var signedIn: Bool
  public var email: String?
  public var plan: String?
  /// A problem worth a line: legacy guard, sign-in failure, tunnel limit/unreachable, pending delete.
  public var problems: [String]
  /// The core's update/notice line (MenuNotice); nil = no real notice.
  public var notice: String?
  public var noticeOpens: Bool
  public var remoteAccessOn: Bool
  public var version: String

  public init(status: String, hostname: String? = nil, signInVisible: Bool = true, signedIn: Bool = false, email: String? = nil,
              plan: String? = nil, problems: [String] = [], notice: String? = nil, noticeOpens: Bool = false,
              remoteAccessOn: Bool = false, version: String) {
    self.status = status; self.hostname = hostname; self.signInVisible = signInVisible; self.signedIn = signedIn
    self.email = email; self.plan = plan; self.problems = problems; self.notice = notice; self.noticeOpens = noticeOpens
    self.remoteAccessOn = remoteAccessOn; self.version = version
  }
}

public enum MenuModel {
  public static let connectTitle = "Connect a Device…"
  public static let remoteAccessTitle = "Allow Remote Access"

  /// "Stopped" reads as Offline; every other status word is shown as is.
  public static func statusWord(_ status: String) -> String { status == "Stopped" ? "Offline" : status }

  public static func statusLine(_ i: MenuInput) -> String { "HyprMux · \(statusWord(i.status))" }

  /// Signed-in account line: the email, never the raw subject.
  public static func accountLine(email: String?, plan: String?) -> String {
    let who = email ?? "Signed in"
    guard let p = plan, !p.isEmpty else { return who }
    return "\(who) · \(p.prefix(1).uppercased() + p.dropFirst())"
  }

  public static func items(_ i: MenuInput) -> [MenuItem] {
    var out: [MenuItem] = [.info(statusLine(i), tooltip: i.hostname ?? (i.remoteAccessOn ? nil : "Remote access is off"))]
    let account = i.signInVisible
    if account {
      out.append(i.signedIn ? .info(accountLine(email: i.email, plan: i.plan)) : .action("Sign In…", .signIn))
    }
    for p in i.problems { out.append(.info(p)) }
    if let n = i.notice { out.append(i.noticeOpens ? .action(n, .openNotice) : .info(n)) }
    out.append(.action(connectTitle, .connectDevice))
    if account && i.signedIn { out.append(.action("Devices…", .devices)) }
    out.append(.separator)
    var settings: [MenuItem] = [.action(remoteAccessTitle, .toggleRemoteAccess, checked: i.remoteAccessOn)]
    if account && i.signedIn && i.plan != "pro" { settings.append(.action("Upgrade", .upgrade)) }
    settings += [.action("Restart", .restart), .action("Open Logs", .openLogs)]
    if account && i.signedIn { settings.append(.action("Sign Out", .signOut)) }
    settings += [.separator, .info("Version \(i.version)")]
    out.append(.submenu("Settings", settings))
    out.append(.action("Quit HyprMux Bridge", .quit))
    return out
  }
}
