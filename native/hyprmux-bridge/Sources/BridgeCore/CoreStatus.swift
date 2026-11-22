import Foundation

/// What the headless core tells the menu app: `<state>/core-status.json` (0600, tmp+rename, core is the only writer).
public struct CoreStatus: Codable, Equatable, Sendable {
  public var version: String
  public var launch: String
  public var notice: String?
  public var noticeURL: String?
  public var at: TimeInterval

  public init(version: String, launch: String, notice: String? = nil, noticeURL: String? = nil, at: TimeInterval) {
    self.version = version
    self.launch = launch
    self.notice = notice
    self.noticeURL = noticeURL
    self.at = at
  }

  /// Build the status for a launch outcome. `manifest` is latest.json (fetched only on failure).
  public static func from(_ outcome: VersionGuard.Outcome, version: String, manifest: Data?, at: TimeInterval) -> CoreStatus {
    switch outcome {
    case .healthy: return CoreStatus(version: version, launch: "healthy", at: at)
    case .reregistered: return CoreStatus(version: version, launch: "reregistered", at: at)
    case .blockedByLegacy: return CoreStatus(version: version, launch: "blockedByLegacy", notice: LegacyGuard.message, at: at)
    case .failed(let why): return CoreStatus(version: version, launch: "failed", notice: why, at: at)
    case .updateDidNotStart:
      return CoreStatus(version: version, launch: "updateDidNotStart", notice: VersionGuard.failureMessage,
                        noticeURL: UpdateCheck.previousURL(manifest)?.absoluteString, at: at)
    }
  }

  public func write(to path: String) throws {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    try BridgeState.writePrivate(path, String(decoding: try enc.encode(self), as: UTF8.self))
  }

  public static func read(from path: String) -> CoreStatus? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return try? JSONDecoder().decode(CoreStatus.self, from: data)
  }
}

/// The menu line for core's notice: text, plus the link it opens (nil = informational only).
public struct MenuNotice: Equatable, Sendable {
  public let text: String
  public let url: URL?

  /// Only a status written by THIS bundle version is shown (a stale file from an older build is ignored).
  public static func from(_ status: CoreStatus?, bundleVersion: String) -> MenuNotice? {
    guard let s = status, s.version == bundleVersion, let text = s.notice else { return nil }
    let url = s.noticeURL.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
    return MenuNotice(text: text, url: url)
  }
}
