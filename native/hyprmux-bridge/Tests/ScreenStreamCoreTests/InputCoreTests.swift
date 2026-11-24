import XCTest
@testable import ScreenStreamCore

final class InputCoreTests: XCTestCase {
  let d = DisplayGeometry(displayId: 1, originX: 100, originY: 50, ptsW: 1000, ptsH: 500, nativeW: 2000, nativeH: 1000, scale: 2)
  func item(_ t: String, seq: UInt32 = 1, epoch: UInt32 = 0, _ f: (inout InputItem) -> Void = { _ in }) -> InputItem {
    var i = InputItem(gen: 0, epoch: epoch, seq: seq, t: t); f(&i); return i
  }
  func plan(_ i: InputItem, secure: Bool = false, held: Bool = false) -> Result<[EventStep], PlanError> {
    InputPlanner.plan(i, display: d, secureInput: secure, leftHeld: held)
  }

  // Table: every op vs the JXA path in lib/mac-screen.js (ptr, mouse, scroll, type, key).
  func testOpTableMatchesJXA() {
    let p = (x: 600.0, y: 300.0)
    XCTAssertEqual(try plan(item("mouse") { $0.type = "move"; $0.fx = 0.5; $0.fy = 0.5 }).get(),
                   [.mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil)])
    XCTAssertEqual(try plan(item("mouse") { $0.type = "move"; $0.fx = 0.5; $0.fy = 0.5 }, held: true).get(),
                   [.mouse(.leftDragged, x: p.x, y: p.y, button: .left, clickState: 1)])
    XCTAssertEqual(try plan(item("mouse") { $0.type = "down"; $0.fx = 0.5; $0.fy = 0.5 }).get(),
                   [.mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil), .mouse(.leftDown, x: p.x, y: p.y, button: .left, clickState: 1)])
    XCTAssertEqual(try plan(item("mouse") { $0.type = "drag"; $0.fx = 0.5; $0.fy = 0.5 }, held: true).get(),
                   [.mouse(.leftDragged, x: p.x, y: p.y, button: .left, clickState: 1)])
    XCTAssertEqual(plan(item("mouse") { $0.type = "drag"; $0.fx = 0.5; $0.fy = 0.5 }), .failure(.notDown))
    XCTAssertEqual(try plan(item("mouse") { $0.type = "up"; $0.fx = 0; $0.fy = 1 }).get(),
                   [.mouse(.leftUp, x: 100, y: 550, button: .left, clickState: 1)])
    XCTAssertEqual(try plan(item("tap") { $0.fx = 0.5; $0.fy = 0.5 }).get(), [
      .mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil),
      .mouse(.leftDown, x: p.x, y: p.y, button: .left, clickState: 1), .mouse(.leftUp, x: p.x, y: p.y, button: .left, clickState: 1)])
    XCTAssertEqual(try plan(item("tap") { $0.fx = 0.5; $0.fy = 0.5; $0.double = true }).get(), [
      .mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil),
      .mouse(.leftDown, x: p.x, y: p.y, button: .left, clickState: 1), .mouse(.leftUp, x: p.x, y: p.y, button: .left, clickState: 1),
      .mouse(.leftDown, x: p.x, y: p.y, button: .left, clickState: 2), .mouse(.leftUp, x: p.x, y: p.y, button: .left, clickState: 2)])
    XCTAssertEqual(try plan(item("tap") { $0.fx = 0.5; $0.fy = 0.5; $0.button = "right" }).get(), [
      .mouse(.moved, x: p.x, y: p.y, button: .right, clickState: nil),
      .mouse(.rightDown, x: p.x, y: p.y, button: .right, clickState: 1), .mouse(.rightUp, x: p.x, y: p.y, button: .right, clickState: 1)])
    XCTAssertEqual(try plan(item("scroll") { $0.dy = 120; $0.dx = -40 }).get(), [.scroll(wheel1: -120, wheel2: 40)])
    XCTAssertEqual(try plan(item("scroll") { $0.dy = 9999; $0.fx = 0.5; $0.fy = 0.5 }).get(),
                   [.mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil), .scroll(wheel1: -3000, wheel2: 0)])
    XCTAssertEqual(try plan(item("key") { $0.key = "c"; $0.mods = ["cmd"] }).get(),
                   [.key(code: 8, down: true, flags: 0x100000), .key(code: 8, down: false, flags: 0x100000)])
    XCTAssertEqual(try plan(item("key") { $0.key = "Z"; $0.mods = ["shift", "cmd"] }).get(),
                   [.key(code: 6, down: true, flags: 0x120000), .key(code: 6, down: false, flags: 0x120000)])
    XCTAssertEqual(try plan(item("key") { $0.key = "return" }).get(),
                   [.key(code: 36, down: true, flags: 0), .key(code: 36, down: false, flags: 0)])
    XCTAssertEqual(plan(item("bogus")), .failure(.badop))
    XCTAssertEqual(InputPlanner.plan(item("tap") { $0.fx = 0.5; $0.fy = 0.5 }, display: nil, secureInput: false, leftHeld: false), .failure(.nodisplay))
  }

  func testKeyAllowListRejectsDangerousCombos() {
    for (k, m) in [("q", ["cmd"]), ("esc", ["cmd", "opt"]), ("a", []), ("b", ["cmd"]), ("c", ["hyper"])] as [(String, [String])] {
      XCTAssertNil(KeyTable.parse(key: k, mods: m), "\(m)+\(k)")
    }
    XCTAssertEqual(KeyTable.parse(key: "tab", mods: ["shift", "cmd"])?.combo, "cmd+shift+tab")
    XCTAssertEqual(KeyTable.allow.count, 53)   // = lib/mac-screen.js KEY_ALLOW.size
  }

  func testTypeUnicodeChunks16() {
    // chars with no US keycode stay unicode chunks of 16 units
    let s = try! plan(item("type") { $0.text = String(repeating: "é", count: 20) }).get()
    XCTAssertEqual(s, [.unicode(Array(repeating: 0xE9, count: 16), down: true), .unicode(Array(repeating: 0xE9, count: 16), down: false), .pause(ms: 5),
                       .unicode(Array(repeating: 0xE9, count: 4), down: true), .unicode(Array(repeating: 0xE9, count: 4), down: false), .pause(ms: 5)])
  }

  func testTypeSendsRealKeycodesWithTextK151() {
    // HMX k151: never keycode 0 for a char that has its own key ("a" for every key in apps that read the keycode)
    let s = try! plan(item("type") { $0.text = "xA éé!" }).get()
    XCTAssertEqual(s, [
      .keyText(code: 7, down: true, flags: 0, units: [120]), .keyText(code: 7, down: false, flags: 0, units: [120]), .pause(ms: 2),
      .keyText(code: 0, down: true, flags: 0x20000, units: [65]), .keyText(code: 0, down: false, flags: 0x20000, units: [65]), .pause(ms: 2),
      .keyText(code: 49, down: true, flags: 0, units: [32]), .keyText(code: 49, down: false, flags: 0, units: [32]), .pause(ms: 2),
      .unicode([0xE9, 0xE9], down: true), .unicode([0xE9, 0xE9], down: false), .pause(ms: 5),
      .keyText(code: 18, down: true, flags: 0x20000, units: [33]), .keyText(code: 18, down: false, flags: 0x20000, units: [33]), .pause(ms: 2)])
    let all = try! plan(item("type") { $0.text = "hello" }).get()
    XCTAssertFalse(all.contains { if case .unicode = $0 { return true } else { return false } }, "plain ASCII never goes as keycode 0")
    XCTAssertEqual(plan(item("type") { $0.text = String(repeating: "a", count: 1001) }), .failure(.toolong))
  }

  func testSecureInputUsesKeycodesD106() {
    let s = try! plan(item("type") { $0.text = "aA!é" }, secure: true).get()
    XCTAssertEqual(s, [
      .key(code: 0, down: true, flags: 0), .pause(ms: 20), .key(code: 0, down: false, flags: 0), .pause(ms: 20), .pause(ms: 60),
      .key(code: 0, down: true, flags: 0x20000), .pause(ms: 20), .key(code: 0, down: false, flags: 0x20000), .pause(ms: 20), .pause(ms: 60),
      .key(code: 18, down: true, flags: 0x20000), .pause(ms: 20), .key(code: 18, down: false, flags: 0x20000), .pause(ms: 20), .pause(ms: 60),
      .unicode([0xE9], down: true), .unicode([0xE9], down: false), .pause(ms: 5)])
    XCTAssertEqual(plan(item("type") { $0.text = String(repeating: "a", count: 101) }, secure: true), .failure(.toolong))
  }

  func testCoalesceKeepsLastMoveAndOrder() {
    let a = item("mouse", seq: 1) { $0.type = "move" }, b = item("mouse", seq: 2) { $0.type = "move" }
    let c = item("mouse", seq: 3) { $0.type = "down" }, e = item("mouse", seq: 4) { $0.type = "drag" }, f = item("mouse", seq: 5) { $0.type = "drag" }
    XCTAssertEqual(Coalesce.moves([a, b, c, e, f]).map(\.seq), [2, 3, 5])
  }

  // MARK: engine with a fake clock and a recording poster

  final class Fake { var now: UInt64 = 0; var ax = true; var posted: [EventStep] = [] }
  func env(_ f: Fake) -> InputEngine.Env {
    InputEngine.Env(now: { f.now }, axTrusted: { f.ax }, secureInput: { false }, display: { self.d },
                    post: { s in if case .pause = s { return true }; f.posted.append(s); return true })
  }
  func down(_ seq: UInt32, epoch: UInt32 = 0) -> InputItem { item("mouse", seq: seq, epoch: epoch) { $0.type = "down"; $0.fx = 0.5; $0.fy = 0.5 } }

  func testReleaseBeforeOldBatchRejectsIt() {
    let f = Fake(); var eng = InputEngine()
    XCTAssertEqual(eng.release(epoch: 0, env(f)), [.released(epoch: 0)])
    f.now += 1_500_000   // the old batch arrives 1.5 s late
    XCTAssertEqual(eng.run([down(1), item("type", seq: 2) { $0.text = "hi" }], env(f)),
                   [.failed(epoch: 0, seq: 1, why: "stale"), .failed(epoch: 0, seq: 2, why: "stale")])
    XCTAssertTrue(f.posted.isEmpty)
    XCTAssertTrue(eng.held.isEmpty)
  }

  func testOldBatchBeforeReleaseIsReleased() {
    let f = Fake(); var eng = InputEngine()
    XCTAssertEqual(eng.run([down(1)], env(f)), [.posted(epoch: 0, seq: 1)])
    XCTAssertTrue(eng.held.contains(.button(.left)))
    f.now += 1_500_000
    f.posted = []
    XCTAssertEqual(eng.release(epoch: 0, env(f)), [.released(epoch: 0)])
    XCTAssertEqual(f.posted, [.mouse(.leftUp, x: 600, y: 300, button: .left, clickState: 1)])   // ups posted before the answer
    XCTAssertTrue(eng.held.isEmpty)
    XCTAssertEqual(eng.acceptedEpoch, 1)
    XCTAssertEqual(eng.run([down(2, epoch: 0)], env(f)), [.failed(epoch: 0, seq: 2, why: "stale")])
    XCTAssertEqual(eng.run([down(3, epoch: 1)], env(f)), [.posted(epoch: 1, seq: 3)])
  }

  func testReleaseNeverTouchesANewerEpoch() {
    let f = Fake(); var eng = InputEngine()
    _ = eng.release(epoch: 0, env(f))
    _ = eng.run([down(1, epoch: 1)], env(f))
    f.posted = []
    XCTAssertEqual(eng.release(epoch: 0, env(f)), [.released(epoch: 0)])   // late duplicate release
    XCTAssertTrue(f.posted.isEmpty)
    XCTAssertTrue(eng.held.contains(.button(.left)))
  }

  func testWrongGenIsStale() {
    let f = Fake(); var eng = InputEngine(gen: 3)
    XCTAssertEqual(eng.run([down(1)], env(f)), [.failed(epoch: 0, seq: 1, why: "stale")])
  }

  func testAXDeniedReleaseKeepsHeldSet() {
    let f = Fake(); var eng = InputEngine()
    _ = eng.run([down(1)], env(f))
    f.ax = false; f.posted = []
    XCTAssertEqual(eng.release(epoch: 0, env(f)), [.failed(epoch: 0, seq: nil, why: "noax")])
    XCTAssertTrue(f.posted.isEmpty)
    XCTAssertTrue(eng.held.contains(.button(.left)))
    XCTAssertEqual(eng.run([down(2, epoch: 0)], env(f)), [.failed(epoch: 0, seq: 2, why: "stale")])
    f.ax = true   // the bridge retries the same release
    XCTAssertEqual(eng.release(epoch: 0, env(f)), [.released(epoch: 0)])
    XCTAssertEqual(f.posted.count, 1)
    XCTAssertTrue(eng.held.isEmpty)
  }

  func testInputWithoutAXFailsNoax() {
    let f = Fake(); f.ax = false; var eng = InputEngine()
    XCTAssertEqual(eng.run([down(1)], env(f)), [.failed(epoch: 0, seq: 1, why: "noax")])
    XCTAssertTrue(f.posted.isEmpty)
  }

  func testWatchdogReleasesAfter5sIdle() {
    let f = Fake(); var eng = InputEngine()
    _ = eng.run([down(1)], env(f))
    f.now = 4_000_000
    _ = eng.run([item("mouse", seq: 2) { $0.type = "drag"; $0.fx = 0.1; $0.fy = 0.1 }], env(f))   // a drag is a further event
    f.now = 8_999_999
    XCTAssertEqual(eng.watchdog(env(f)), [])
    f.posted = []
    f.now = 9_000_000
    XCTAssertEqual(eng.watchdog(env(f)), [.watchdog(epoch: 0, what: "left")])
    XCTAssertEqual(f.posted, [.mouse(.leftUp, x: 200, y: 100, button: .left, clickState: 1)])
    XCTAssertTrue(eng.held.isEmpty)
  }

  func testWatchdogReleasesHeldModifier() {
    var h = HeldSet()
    h.observe(.key(code: 55, down: true, flags: 0x100000), epoch: 2, now: 0)
    XCTAssertEqual(h.overdue(now: 4_999_999).count, 0)
    let due = h.overdue(now: 5_000_000)
    XCTAssertEqual(due.map(\.1), [.key(code: 55, down: false, flags: 0)])
  }

  func testPostedCarriesSurvivingSeqForCoalescedMoves() {
    let f = Fake(); var eng = InputEngine()
    let r = eng.run([item("mouse", seq: 7) { $0.type = "move"; $0.fx = 0; $0.fy = 0 }, item("mouse", seq: 8) { $0.type = "move"; $0.fx = 1; $0.fy = 1 }], env(f))
    XCTAssertEqual(r, [.coalesced(epoch: 0, seq: 7), .posted(epoch: 0, seq: 8)])
    XCTAssertEqual(f.posted, [.mouse(.moved, x: 1100, y: 550, button: .left, clickState: nil)])
    XCTAssertEqual(eng.lastPostedSeq, 8)
  }

  // Drag: down, drags, up. Superseded drags are acked as posted (coalesced) in seq order; the posted drag carries
  // clickState 1 and the delta from the last posted point.
  func testDragAcksSupersededInOrderAndFillsDelta() {
    let f = Fake(); var eng = InputEngine()
    let drag = { (seq: UInt32, fx: Double) in self.item("mouse", seq: seq) { $0.type = "drag"; $0.fx = fx; $0.fy = 0.5 } }
    let r = eng.run([down(1), drag(2, 0.6), drag(3, 0.7), item("mouse", seq: 4) { $0.type = "up"; $0.fx = 0.7; $0.fy = 0.5 }], env(f))
    XCTAssertEqual(r, [.posted(epoch: 0, seq: 1), .coalesced(epoch: 0, seq: 2), .posted(epoch: 0, seq: 3), .posted(epoch: 0, seq: 4)])
    XCTAssertEqual(f.posted, [
      .mouse(.moved, x: 600, y: 300, button: .left, clickState: nil),
      .mouse(.leftDown, x: 600, y: 300, button: .left, clickState: 1),
      .mouse(.leftDragged, x: 800, y: 300, button: .left, clickState: 1, delta: MouseDelta(dx: 200, dy: 0)),
      .mouse(.leftUp, x: 800, y: 300, button: .left, clickState: 1),
    ])
    XCTAssertEqual(eng.lastPostedSeq, 4)
    let j = InputRecord.coalesced(epoch: 0, seq: 2).json
    XCTAssertEqual(j["kind"] as? String, "posted"); XCTAssertEqual(j["seq"] as? UInt32, 2); XCTAssertEqual(j["coalesced"] as? Bool, true)
  }

  func testItemFromJSONFallsBackToBatchGenEpoch() {
    let it = InputItem.from(["seq": 4, "t": "key", "key": "c", "mods": ["cmd"]], gen: 2, epoch: 5)!
    XCTAssertEqual([it.gen, it.epoch, it.seq], [2, 5, 4])
    XCTAssertNil(InputItem.from(["t": "key"], gen: 2, epoch: 5))
  }
}
