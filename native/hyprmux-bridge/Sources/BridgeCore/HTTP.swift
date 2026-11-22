import Foundation

/// URLSession transport. `path` is joined to `base`, or used as-is when it is an absolute https URL
/// (OIDC endpoints from discovery). Blocking by design: core and menu call it off the main thread.
public final class HTTPHubTransport: HubTransport {
  let base: URL
  let session: URLSession

  public init(base: URL, session: URLSession = URLSession(configuration: .ephemeral)) {
    self.base = base
    self.session = session
  }

  func url(_ r: HubRequest) -> URL? {
    var s = r.path.hasPrefix("https://") || r.path.hasPrefix("http://") ? r.path : base.absoluteString + r.path
    if let q = r.query { s += (s.contains("?") ? "&" : "?") + q }
    return URL(string: s)
  }

  /// HubReply carries no headers: a 503's numeric Retry-After goes into the JSON body as top-level retryAfter.
  static func foldRetryAfter(status: Int, header: String?, body: Data) -> Data {
    guard status == 503, let h = header, let n = Double(h.trimmingCharacters(in: .whitespaces)),
          var j = HubEnvelope.json(body), j["retryAfter"] == nil else { return body }
    j["retryAfter"] = n
    return (try? JSONSerialization.data(withJSONObject: j)) ?? body
  }

  public func send(_ r: HubRequest, timeout: TimeInterval) -> HubReply {
    guard let u = url(r) else { return .network }
    var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    req.httpMethod = r.method
    for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
    if let b = r.body { req.httpBody = Data(b.utf8) }
    final class Box: @unchecked Sendable { var reply: HubReply = .timeout }
    let box = Box()
    let sem = DispatchSemaphore(value: 0)
    session.dataTask(with: req) { data, resp, err in
      if let h = resp as? HTTPURLResponse {
        box.reply = .response(status: h.statusCode, body: Self.foldRetryAfter(status: h.statusCode, header: h.value(forHTTPHeaderField: "Retry-After"),
                                                                              body: data ?? Data()))
      } else if let e = err as? URLError, e.code == .timedOut {
        box.reply = .timeout
      } else {
        box.reply = .network
      }
      sem.signal()
    }.resume()
    if sem.wait(timeout: .now() + timeout + 0.5) == .timedOut { return .timeout }
    return box.reply
  }
}

/// server.js over loopback with SERVER_TOKEN: revoke a paired key, start a pairing code (QR payload).
public final class LoopbackServer: LocalServer {
  let transport: HubTransport
  let token: String

  public init(port: Int, token: String, session: URLSession = URLSession(configuration: .ephemeral)) {
    transport = HTTPHubTransport(base: URL(string: "http://127.0.0.1:\(port)")!, session: session)
    self.token = token
  }

  init(transport: HubTransport, token: String) {
    self.transport = transport
    self.token = token
  }

  public func revokeDevice(localId: String) -> Bool {
    let id = localId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? localId
    let r = transport.send(HubRequest(method: "DELETE", path: "/api/pair/devices/\(id)", query: nil,
                                      headers: ["authorization": "Bearer \(token)"], body: nil), timeout: 5)
    if case .response(let s, _) = r { return s == 200 || s == 404 }
    return false
  }

  /// The pairing link for the QR window (server.js /api/pair/start), nil when the server refuses.
  public func pairingLink() -> String? { if case .link(let l) = startPairing() { return l } else { return nil } }

  /// /api/pair/start: a link, the server not answering (Bridge not running), or the server's refusal code.
  public func startPairing() -> PairingStart {
    let r = transport.send(HubRequest(method: "POST", path: "/api/pair/start", query: nil,
                                      headers: ["authorization": "Bearer \(token)", "content-type": "application/json"], body: "{}"),
                           timeout: 5)
    guard case .response(let s, let d) = r else { return .notRunning }
    if s == 200, let qr = HubEnvelope.json(d)?["qr"] as? String { return .link(qr) }
    return .refused(HubEnvelope.errorCode(s, d))
  }
}

/// What the Pair a Phone window shows.
public enum PairingStart: Equatable, Sendable {
  case link(String)
  case notRunning
  case refused(String)

  public var text: String {
    switch self {
    case .link: return "Scan with the HyprMux app"
    case .notRunning: return "Bridge isn't running"
    case .refused(let c) where c == "no_public_address": return "Turn on Phone access first."
    case .refused(let c): return "Couldn't start pairing (\(SignInFailure.safeCode(c) ?? "unknown"))"
    }
  }

  /// core.log result for "pairing-start" (never the code or link).
  public var logResult: String {
    switch self {
    case .link: return "ok"
    case .notRunning: return "not_running"
    case .refused(let c): return c
    }
  }
}
