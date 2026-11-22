import Foundation
import CryptoKit

// MARK: Connect sign-in (PKCE)

public struct ConnectConfig: Equatable, Sendable {
  public var clientId: String
  public var issuer = "https://auth.appmatic.io"
  public var redirectURI = "hyprmux-bridge://oidc-callback"
  /// offline_access is what makes Connect (node-oidc-provider) issue the refresh token completeSignIn requires;
  /// it survives only together with prompt=consent (authorizeURL).
  public var scope = "openid offline_access hub:app"
  public var resource = "https://hub.appmatic.io/api"
  public init(clientId: String) { self.clientId = clientId }

  /// Sign-in is hidden when the build carries no client id.
  public var signInVisible: Bool { !clientId.isEmpty }
}

public enum SignInState: Equatable, Sendable {
  case signedOut(message: String?)
  case signedIn(ownerSub: String)
  /// Only for a build with no client id; every other failure says what went wrong (SignInFailure.text).
  public static let unavailableText = "Sign-in isn't available yet"
}

/// Why a sign-in attempt ended signed out. `text` is the menu line; `logCode` goes to core.log.
public enum SignInFailure: Error, Equatable, Sendable {
  case noClientId
  case unreachable                       // OIDC discovery failed
  case windowNotOpened                   // ASWebAuthenticationSession.start() returned false
  case cancelled                         // ASWebAuthenticationSessionError.canceledLogin
  case browserError(code: Int)           // any other ASWebAuthenticationSession error
  case callbackError(String)             // ?error= on the redirect back
  case badCallback                       // no callback URL, state mismatch, or no code
  case token(status: Int?, error: String?) // token exchange not 200 (nil status = no response)
  case tokenResponse                     // 200 without access token, refresh token or sub
  case saveFailed                        // owner / Keychain / access-token write failed

  public var text: String {
    switch self {
    case .noClientId: return SignInState.unavailableText
    case .unreachable: return "Couldn't reach sign-in"
    case .windowNotOpened: return "Couldn't open the sign-in window"
    case .cancelled: return "Sign-in cancelled"
    case .browserError(let c): return "Sign-in failed: browser error \(c)"
    case .callbackError(let e): return "Sign-in failed: \(e)"
    case .badCallback: return "Sign-in failed: bad callback"
    case .token(let s, _): return "Sign-in failed: token \(s.map(String.init) ?? "no response")"
    case .tokenResponse: return "Sign-in failed: token response incomplete"
    case .saveFailed: return "Sign-in failed: couldn't save the account"
    }
  }

  public var logCode: String {
    switch self {
    case .noClientId: return "no_client_id"
    case .unreachable: return "discovery_failed"
    case .windowNotOpened: return "window_not_opened"
    case .cancelled: return "cancelled"
    case .browserError(let c): return "browser_error_\(c)"
    case .callbackError(let e): return e
    case .badCallback: return "bad_callback"
    case .token(let s, let e): return e ?? (s == nil ? "no_response" : "http_error")
    case .tokenResponse: return "token_response_incomplete"
    case .saveFailed: return "save_failed"
    }
  }

  /// OAuth error codes are short ASCII; anything else (or a value that could carry data) is cut to [A-Za-z0-9._-]{1,64}.
  public static func safeCode(_ s: String?) -> String? {
    guard let s else { return nil }
    let kept = String(String.UnicodeScalarView(s.unicodeScalars.filter {
      ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || "._-".unicodeScalars.contains($0)
    }).prefix(64))
    return kept.isEmpty ? "unknown" : kept
  }
}

/// One line per sign-in step in logs/core.log: step, http status, error code. Never tokens, codes or verifiers:
/// the line builder takes no free text beyond the step name and a sanitized error code.
public enum SignInLog {
  public static func line(step: String, status: Int? = nil, error: String? = nil, at: Date) -> String {
    let f = ISO8601DateFormatter()
    var s = "\(f.string(from: at)) sign-in step=\(step)"
    if let status { s += " status=\(status)" }
    s += " result=" + (SignInFailure.safeCode(error) ?? "ok")
    return s + "\n"
  }

  public static func append(_ line: String, logsDir: String) {
    let fm = FileManager.default
    try? fm.createDirectory(atPath: logsDir, withIntermediateDirectories: true)
    let path = logsDir + "/core.log"
    if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) }
    guard let h = FileHandle(forWritingAtPath: path) else { return }
    defer { try? h.close() }
    _ = try? h.seekToEnd()
    try? h.write(contentsOf: Data(line.utf8))
  }
}

/// One line per Bridge step in logs/core.log (tunnel ensure, agent restarts, pairing, hub session).
/// Values are sanitized codes (letters, digits, . _ -; 64 max): never tokens or pairing codes.
public enum CoreLog {
  public static func line(_ event: String, _ fields: [(String, String?)], at: Date = Date()) -> String {
    var s = "\(ISO8601DateFormatter().string(from: at)) \(event)"
    for (k, v) in fields { if let v { s += " \(k)=\(SignInFailure.safeCode(v) ?? "unknown")" } }
    return s + "\n"
  }

  public static func append(_ event: String, _ fields: [(String, String?)], logsDir: String) {
    SignInLog.append(line(event, fields), logsDir: logsDir)
  }

  /// First 8 characters of a tunnel id (enough to match the hub row, not the whole id).
  public static func idPrefix(_ id: String?) -> String? { id.map { String($0.prefix(8)) } }
}

public enum ConnectAuth {
  public static func verifier() -> String { InstallKeySigner.b64url(Data((0..<32).map { _ in UInt8.random(in: 0...255) })) }
  public static func challenge(_ verifier: String) -> String { InstallKeySigner.b64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }

  public static func authorizeURL(_ c: ConnectConfig, verifier: String, state: String) -> URL? {
    var u = URLComponents(string: c.issuer + "/authorize")
    u?.queryItems = [
      .init(name: "response_type", value: "code"), .init(name: "client_id", value: c.clientId),
      .init(name: "redirect_uri", value: c.redirectURI), .init(name: "scope", value: c.scope),
      .init(name: "resource", value: c.resource), .init(name: "state", value: state),
      .init(name: "code_challenge", value: challenge(verifier)), .init(name: "code_challenge_method", value: "S256"),
      .init(name: "prompt", value: "consent"),
    ]
    return u?.url
  }

  /// Callback handling: any error (incl. redirect_uri_mismatch), state mismatch, or missing code → stay signed out.
  public static func code(fromCallback url: URL?, expectedState: String) -> Result<String, SignInFailure> {
    guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return .failure(.badCallback) }
    func q(_ n: String) -> String? { items.first { $0.name == n }?.value }
    if let e = q("error") { return .failure(.callbackError(SignInFailure.safeCode(e)!)) }
    guard q("state") == expectedState, let code = q("code"), !code.isEmpty else { return .failure(.badCallback) }
    return .success(code)
  }

  public typealias SignInError = SignInFailure

  public static func stateAfter(_ r: Result<String, SignInFailure>, ownerSub: String?) -> SignInState {
    switch r {
    case .success where ownerSub != nil: return .signedIn(ownerSub: ownerSub!)
    case .failure(let f): return .signedOut(message: f.text)
    default: return .signedOut(message: SignInFailure.tokenResponse.text)
    }
  }
}

// MARK: Upgrade + checkout poll

public final class CheckoutPoller {
  public static let interval: TimeInterval = 10
  public static let window: TimeInterval = 15 * 60
  public static let checkoutPath = "/api/v1/apps/hyprmux/billing/checkout"
  public static let checkoutBody = "{\"plan\":\"pro\",\"returnTo\":\"bridge\"}"

  public private(set) var ownerSub: String?
  var startedAt: TimeInterval = 0
  var lastPoll: TimeInterval = 0
  public private(set) var active = false
  let clock: BridgeClock

  public init(clock: BridgeClock) { self.clock = clock }

  /// POST checkout with the owner's bearer; returns the Stripe url to open.
  public static func startCheckout(transport: HubTransport, bearer: String) -> URL? {
    let r = transport.send(HubRequest(method: "POST", path: checkoutPath, query: nil,
                                      headers: ["authorization": "Bearer \(bearer)", "content-type": "application/json"],
                                      body: checkoutBody), timeout: 10)
    guard case .response(let s, let d) = r, (200..<300).contains(s),
          let u = (HubEnvelope.data(d)?["url"] as? String) ?? (HubEnvelope.json(d)?["url"] as? String),
          let url = URL(string: u), url.scheme == "https" else { return nil }
    return url
  }

  public func begin(ownerSub: String) {
    self.ownerSub = ownerSub
    startedAt = clock.now()
    lastPoll = startedAt
    active = true
  }

  /// Called on the timer; `read` returns the plan for an owner. Fenced to the initiating owner.
  public func tick(currentOwner: String?, read: (String) -> String?) {
    guard active, let o = ownerSub else { return }
    let now = clock.now()
    if currentOwner != o || now - startedAt > Self.window { active = false; return }
    guard now - lastPoll >= Self.interval else { return }
    lastPoll = now
    if read(o) == "pro" { active = false }
  }

  /// hyprmux-bridge://billing/done: one re-read of the CURRENT owner only.
  public func billingDone(currentOwner: String?, read: (String) -> String?) {
    guard let c = currentOwner else { return }
    if read(c) == "pro" { active = false }
    if c != ownerSub { active = false }
  }
}

// MARK: Devices… Remove from plan

public struct HubDevice: Equatable, Sendable {
  public var id: String
  public var deviceId: String
}

/// Local loopback call to server.js with SERVER_TOKEN (revokes the paired key bound to that device).
public protocol LocalServer: AnyObject {
  func revokeDevice(localId: String) -> Bool
}

public enum DeviceRemoval {
  public static func devicesPath(_ rowId: String) -> String { "/api/v1/apps/hyprmux/devices/\(rowId)" }

  /// DELETE …/devices/{rowId} for the row whose deviceId = hubDeviceId, then revoke exactly that local key.
  public static func remove(hubDeviceId: String, localId: String, rows: [HubDevice], transport: HubTransport,
                            bearer: String, server: LocalServer) -> Bool {
    guard let row = rows.first(where: { $0.deviceId == hubDeviceId }) else { return false }
    let r = transport.send(HubRequest(method: "DELETE", path: devicesPath(row.id), query: nil,
                                      headers: ["authorization": "Bearer \(bearer)"], body: nil), timeout: 10)
    guard case .response(let s, _) = r, (200..<300).contains(s) || s == 404 else { return false }
    return server.revokeDevice(localId: localId)
  }
}
