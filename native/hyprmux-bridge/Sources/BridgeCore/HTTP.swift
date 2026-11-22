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
        box.reply = .response(status: h.statusCode, body: data ?? Data())
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
  public func pairingLink() -> String? {
    let r = transport.send(HubRequest(method: "POST", path: "/api/pair/start", query: nil,
                                      headers: ["authorization": "Bearer \(token)", "content-type": "application/json"], body: "{}"),
                           timeout: 5)
    guard case .response(200, let d) = r else { return nil }
    return HubEnvelope.json(d)?["qr"] as? String
  }
}
