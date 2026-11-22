import XCTest
@testable import BridgeCore

/// Connect issues a refresh token only for offline_access + prompt=consent; without one every sign-in fails.
final class AuthorizeScopeTests: XCTestCase {
  func testAuthorizeURLAsksForRefreshToken() throws {
    let url = try XCTUnwrap(ConnectAuth.authorizeURL(ConnectConfig(clientId: "client"), verifier: "v", state: "s"))
    let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
    func q(_ n: String) -> String? { items.first { $0.name == n }?.value }
    let scopes = Set((q("scope") ?? "").split(separator: " ").map(String.init))
    XCTAssertEqual(scopes, ["openid", "email", "offline_access", "hub:app"])
    XCTAssertEqual(q("prompt"), "consent")
    XCTAssertEqual(q("resource"), "https://hub.appmatic.io/api")
    XCTAssertEqual(q("response_type"), "code")
    XCTAssertEqual(q("code_challenge_method"), "S256")
  }
}
