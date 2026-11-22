import XCTest
@testable import BridgeCore

final class AccountEmail025Tests: WiredTests {
  static func idToken(_ sub: String, _ email: String) -> String {
    "e30.\(InstallKeySigner.b64url(try! JSONSerialization.data(withJSONObject: ["sub": sub, "email": email]))).sig"
  }

  func testEmailFromIdTokenFencedToOwnerAndClearedOnSignOut() throws {
    StubHubProtocol.handler = { [base = StubHubProtocol.handler!] r in
      if r.method == "POST", r.url.path == "/oauth/token", r.body.contains("grant_type=authorization_code") {
        return (200, ["access_token": Self.jwt("A"), "refresh_token": "RT-A", "expires_in": 600, "id_token": Self.idToken("A", "a@example.test")])
      }
      return base(r)
    }
    _ = try signIn()
    XCTAssertEqual(session.accountEmail, "a@example.test")
    let mode = try FileManager.default.attributesOfItem(atPath: state.paths.ownerEmailPath)[.posixPermissions] as? NSNumber
    XCTAssertEqual(mode?.intValue, 0o600)
    try session.signOut()
    XCTAssertNil(session.accountEmail)
    XCTAssertFalse(FileManager.default.fileExists(atPath: state.paths.ownerEmailPath))
  }

  func testEmailFromHubSessionWhenTokenHasNone() throws {
    StubHubProtocol.handler = { [base = StubHubProtocol.handler!] r in
      r.url.path == "/api/v1/apps/hyprmux/session" ? (200, ["success": true, "data": ["user": ["id": "u1", "email": "hub@example.test"]]]) : base(r)
    }
    _ = try signIn()
    XCTAssertEqual(session.accountEmail, "hub@example.test")
  }

  func testIdTokenForAnotherSubIgnored() {
    XCTAssertNil(BridgeSession.email(["id_token": Self.idToken("B", "b@example.test")], sub: "A"))
    XCTAssertEqual(BridgeSession.email(["id_token": Self.idToken("A", "a@example.test")], sub: "A"), "a@example.test")
  }
}
