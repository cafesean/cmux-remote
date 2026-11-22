import Foundation

/// The menu bar menu as data: BridgeState-derived input -> items. main.swift only renders it.
public enum MenuAction: Equatable, Sendable {
  case signIn, connectDevice, devices, toggleRemoteAccess, upgrade, managePlan, signOut, quit, openNotice
  case restart, openLogs, stopBridge, checkUpdate
}

public indirect enum MenuItem: Equatable, Sendable {
  /// Disabled line; tooltip optional.
  case info(String, tooltip: String? = nil)
  case action(String, MenuAction, checked: Bool = false)
  /// An action drawn to stand out (bold, accent color, symbol): Upgrade to Pro.
  case prominent(String, MenuAction)
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
  /// nil = not read yet (no Upgrade offered until the plan is known).
  public var plan: String?
  /// The hub gave a plan management link (entitlement manageUrl).
  public var canManagePlan: Bool
  /// A problem worth a line: legacy guard, sign-in failure, tunnel limit/unreachable, pending delete.
  public var problems: [String]
  /// The core's update/notice line (MenuNotice); nil = no real notice.
  public var notice: String?
  public var noticeOpens: Bool
  public var remoteAccessOn: Bool
  public var version: String
  /// Option held while the menu opened: show the Troubleshooting section.
  public var optionHeld: Bool

  public init(status: String, hostname: String? = nil, signInVisible: Bool = true, signedIn: Bool = false, email: String? = nil,
              plan: String? = nil, canManagePlan: Bool = false, problems: [String] = [], notice: String? = nil,
              noticeOpens: Bool = false, remoteAccessOn: Bool = false, version: String, optionHeld: Bool = false) {
    self.status = status; self.hostname = hostname; self.signInVisible = signInVisible; self.signedIn = signedIn
    self.email = email; self.plan = plan; self.canManagePlan = canManagePlan; self.problems = problems; self.notice = notice
    self.noticeOpens = noticeOpens; self.remoteAccessOn = remoteAccessOn; self.version = version; self.optionHeld = optionHeld
  }
}

public enum MenuModel {
  public static let connectTitle = "Connect a Device…"
  public static let remoteAccessTitle = "Allow Remote Access"
  public static let upgradeTitle = "Upgrade to Pro…"
  public static let upgradeSymbol = "arrow.up.circle.fill"

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
    let signedIn = i.signInVisible && i.signedIn
    if i.signInVisible {
      if signedIn {
        var account: [MenuItem] = []
        if i.canManagePlan { account.append(.action("Manage Plan…", .managePlan)) }
        account.append(.action("Sign Out", .signOut))
        out.append(.submenu(accountLine(email: i.email, plan: i.plan), account))
        if let p = i.plan, p != "pro" { out.append(.prominent(upgradeTitle, .upgrade)) }
      } else {
        out.append(.action("Sign In…", .signIn))
      }
    }
    for p in i.problems { out.append(.info(p)) }
    if let n = i.notice { out.append(i.noticeOpens ? .action(n, .openNotice) : .info(n)) }
    out.append(.action(connectTitle, .connectDevice))
    if signedIn { out.append(.action("Devices…", .devices)) }
    out.append(.separator)
    out.append(.action(remoteAccessTitle, .toggleRemoteAccess, checked: i.remoteAccessOn))
    out.append(.separator)
    if i.optionHeld {
      out += [.info("Troubleshooting"), .action("Restart", .restart), .action("Open Logs", .openLogs),
              .action("Stop Bridge", .stopBridge), .action("Check for Update", .checkUpdate),
              .info("Version \(i.version)"), .separator]
    }
    out.append(.action("Quit HyprMux Bridge", .quit))
    return out
  }
}
