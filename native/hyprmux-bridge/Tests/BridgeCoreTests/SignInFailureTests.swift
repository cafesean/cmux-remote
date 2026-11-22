import XCTest
@testable import BridgeCore

final class SignInFailureTests: XCTestCase {
  func testOutcomeToMenuText() {
    XCTAssertEqual(SignInFailure.noClientId.text, "Sign-in isn't available yet")
    XCTAssertEqual(SignInFailure.unreachable.text, "Couldn't reach sign-in")
    XCTAssertEqual(SignInFailure.windowNotOpened.text, "Couldn't open the sign-in window")
    XCTAssertEqual(SignInFailure.cancelled.text, "Sign-in cancelled")
    XCTAssertEqual(SignInFailure.callbackError("access_denied").text, "Sign-in failed: access_denied")
    XCTAssertEqual(SignInFailure.token(status: 400, error: "invalid_grant").text, "Sign-in failed: token 400")
    XCTAssertEqual(SignInFailure.token(status: nil, error: nil).text, "Sign-in failed: token no response")
    XCTAssertEqual(SignInFailure.browserError(code: 3).text, "Sign-in failed: browser error 3")
    XCTAssertEqual(SignInFailure.badCallback.text, "Sign-in failed: bad callback")
    XCTAssertEqual(SignInFailure.tokenResponse.text, "Sign-in failed: token response incomplete")
    XCTAssertEqual(SignInFailure.saveFailed.text, "Sign-in failed: couldn't save the account")
    // only "no client id" keeps the old catch-all text
    let others: [SignInFailure] = [.unreachable, .windowNotOpened, .cancelled, .browserError(code: 1), .callbackError("x"),
                                   .badCallback, .token(status: 500, error: nil), .tokenResponse, .saveFailed]
    for f in others { XCTAssertNotEqual(f.text, SignInState.unavailableText, "\(f)") }
  }

  func testCallbackErrorParamMapsAndIsSanitized() {
    let r = ConnectAuth.code(fromCallback: URL(string: "hyprmux-bridge://oidc-callback?error=invalid_client&state=s"), expectedState: "s")
    XCTAssertEqual(r, .failure(.callbackError("invalid_client")))
    let odd = ConnectAuth.code(fromCallback: URL(string: "hyprmux-bridge://oidc-callback?error=%3Cscript%3E%20x&state=s"), expectedState: "s")
    XCTAssertEqual(odd, .failure(.callbackError("scriptx")))
    XCTAssertEqual(SignInFailure.safeCode(String(repeating: "a", count: 200))?.count, 64)
    XCTAssertEqual(SignInFailure.safeCode("%%%"), "unknown")
  }

  func testLogLineHasStepStatusCodeOnly() {
    let at = Date(timeIntervalSince1970: 0)
    XCTAssertEqual(SignInLog.line(step: "token", status: 400, error: "invalid_grant", at: at),
                   "1970-01-01T00:00:00Z sign-in step=token status=400 result=invalid_grant\n")
    XCTAssertEqual(SignInLog.line(step: "discover", status: 200, at: at), "1970-01-01T00:00:00Z sign-in step=discover status=200 result=ok\n")
    // an error value with spaces or '=' cannot smuggle extra fields into the line
    XCTAssertEqual(SignInLog.line(step: "callback", error: "a b=c", at: at), "1970-01-01T00:00:00Z sign-in step=callback result=abc\n")
  }

  func testAppendCreatesCoreLog() throws {
    let dir = NSTemporaryDirectory() + "signin-log-\(UUID().uuidString)/logs"
    defer { try? FileManager.default.removeItem(atPath: (dir as NSString).deletingLastPathComponent) }
    SignInLog.append("one\n", logsDir: dir)
    SignInLog.append("two\n", logsDir: dir)
    XCTAssertEqual(try String(contentsOfFile: dir + "/core.log", encoding: .utf8), "one\ntwo\n")
  }
}
