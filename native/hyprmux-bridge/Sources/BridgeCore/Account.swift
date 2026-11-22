import Foundation
import CryptoKit

// MARK: Connect sign-in (PKCE)

public struct ConnectConfig: Equatable, Sendable {
  public var clientId: String
  public var issuer = "https://auth.appmatic.io"
  public var redirectURI = "hyprmux-bridge://oidc-callback"
  public var scope = "hub:app"
  public var resource = "https://hub.appmatic.io/api"
  public init(clientId: String) { self.clientId = clientId }

  /// Sign-in is hidden when the build carries no client id.
  public var signInVisible: Bool { !clientId.isEmpty }
}

public enum SignInState: Equatable, Sendable {
  case signedOut(message: String?)
  case signedIn(ownerSub: String)
  public static let unavailableText = "Sign-in isn't available yet"
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
    ]
    return u?.url
  }

  /// Callback handling: any error (incl. redirect_uri_mismatch), state mismatch, or missing code → stay signed out.
  public static func code(fromCallback url: URL?, expectedState: String) -> Result<String, SignInError> {
    guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return .failure(.unavailable) }
    func q(_ n: String) -> String? { items.first { $0.name == n }?.value }
    if q("error") != nil { return .failure(.unavailable) }
    guard q("state") == expectedState, let code = q("code"), !code.isEmpty else { return .failure(.unavailable) }
    return .success(code)
  }

  public enum SignInError: Error, Equatable { case unavailable }

  public static func stateAfter(_ r: Result<String, SignInError>, ownerSub: String?) -> SignInState {
    switch r {
    case .success where ownerSub != nil: return .signedIn(ownerSub: ownerSub!)
    default: return .signedOut(message: SignInState.unavailableText)
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
