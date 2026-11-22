import Foundation

/// Manual updates only: read the manifest, and the menu opens the DMG link in the browser.
/// There is no download, install or replace code anywhere in the Bridge.
public struct UpdateManifest: Decodable, Equatable, Sendable {
  public struct Previous: Decodable, Equatable, Sendable {
    public let version: String
    public let url: String
    public let sha256: String?
  }
  public let version: String
  public let url: String
  public let sha256: String?
  public let previous: Previous?
}

public enum UpdateResult: Equatable {
  case upToDate
  case available(version: String, url: URL)
  case couldNotCheck
}

public enum UpdateCheck {
  public static let manifestURL = URL(string: "https://hyprmux.com/bridge/latest.json")!
  public static let couldNotCheckText = "Couldn't check"

  public static func parse(_ data: Data) -> UpdateManifest? { try? JSONDecoder().decode(UpdateManifest.self, from: data) }

  public static func evaluate(_ data: Data?, current: String) -> UpdateResult {
    guard let data, let m = parse(data), let url = URL(string: m.url), url.scheme == "https" else { return .couldNotCheck }
    return isNewer(m.version, than: current) ? .available(version: m.version, url: url) : .upToDate
  }

  /// Numeric dotted compare (missing parts = 0).
  public static func isNewer(_ a: String, than b: String) -> Bool {
    let pa = a.split(separator: ".").map { Int($0) ?? 0 }
    let pb = b.split(separator: ".").map { Int($0) ?? 0 }
    for i in 0..<max(pa.count, pb.count) {
      let x = i < pa.count ? pa[i] : 0
      let y = i < pb.count ? pb[i] : 0
      if x != y { return x > y }
    }
    return false
  }

  /// Link for "Update didn't start. Install the previous version".
  public static func previousURL(_ data: Data?) -> URL? {
    guard let data, let p = parse(data)?.previous, let u = URL(string: p.url), u.scheme == "https" else { return nil }
    return u
  }

  public static func fetch(timeout: TimeInterval = 10) -> Data? {
    var req = URLRequest(url: manifestURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    req.httpMethod = "GET"
    let sem = DispatchSemaphore(value: 0)
    final class Box: @unchecked Sendable { var data: Data? }
    let box = Box()
    URLSession.shared.dataTask(with: req) { d, r, _ in
      if let h = r as? HTTPURLResponse, h.statusCode == 200 { box.data = d }
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 1)
    return box.data
  }
}

/// Local server version probe over 127.0.0.1:<PORT>/api/version.
public final class LocalServerProbe: ServerProbe {
  let port: Int
  public init(port: Int) { self.port = port }

  public func bridgeVersion() -> String? {
    guard let url = URL(string: "http://127.0.0.1:\(port)/api/version") else { return nil }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
    req.httpMethod = "GET"
    let sem = DispatchSemaphore(value: 0)
    final class Box: @unchecked Sendable { var v: String? }
    let box = Box()
    URLSession.shared.dataTask(with: req) { d, r, _ in
      if let h = r as? HTTPURLResponse, h.statusCode == 200, let d,
         let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
        box.v = obj["bridge"] as? String
      }
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    return box.v
  }
}
