import XCTest
@testable import ScreenStreamCore

private func hex(_ s: String) -> [UInt8] {
  let c = Array(s.filter { !$0.isWhitespace })
  return stride(from: 0, to: c.count, by: 2).map { UInt8(String(c[$0...$0 + 1]), radix: 16)! }
}
private func toHex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

final class PacketHeaderTests: XCTestCase {
  // type 1, flags keyframe|config (0x03), gen 7, seq 1, captureTs 0x0102030405060708, encodeDoneTs 0x1112131415161718,
  // postedInput 9, rev 5, grantId 42, payload [aa bb]
  let idrFixture = """
    01 03 00000007 00000001 0102030405060708 1112131415161718 00000009 00000005 0000002a 00000002 aabb
    """

  func testHeaderIs42Bytes() { XCTAssertEqual(PacketHeader.size, 42) }

  func testEncodeMatchesFixture() {
    let p = Packet(type: .video, flags: [.keyframe, .config], gen: 7, seq: 1, captureTs: 0x0102030405060708,
                   encodeDoneTs: 0x1112131415161718, postedInput: 9, rev: 5, grantId: 42, payload: [0xAA, 0xBB])
    XCTAssertEqual(toHex(p.encode()), toHex(hex(idrFixture)))
  }

  func testDecodeRoundTrip() throws {
    let p = try Packet.decode(hex(idrFixture))
    XCTAssertEqual(p.type, .video); XCTAssertEqual(p.flags, [.keyframe, .config]); XCTAssertEqual(p.gen, 7)
    XCTAssertEqual(p.seq, 1); XCTAssertEqual(p.rev, 5); XCTAssertEqual(p.grantId, 42); XCTAssertEqual(p.postedInput, 9)
    XCTAssertEqual(p.captureTs, 0x0102030405060708); XCTAssertEqual(p.encodeDoneTs, 0x1112131415161718)
    XCTAssertEqual(p.payload, [0xAA, 0xBB])
  }

  func testDecodeRejectsLengthMismatch() {
    var b = hex(idrFixture); b.append(0)
    XCTAssertThrowsError(try Packet.decode(b))
    XCTAssertThrowsError(try Packet.decode(Array(b.prefix(41))))
  }

  func testFlagBits() {
    XCTAssertEqual(PacketFlags.keyframe.rawValue, 1); XCTAssertEqual(PacketFlags.config.rawValue, 2)
    XCTAssertEqual(PacketFlags.refine.rawValue, 4); XCTAssertEqual(PacketFlags.snapshot.rawValue, 8)
    XCTAssertEqual(PacketFlags.free.rawValue, 16)
  }
}

final class FramingTests: XCTestCase {
  func packets() -> [Packet] {
    (0..<3).map { (i: Int) -> Packet in
      let f: PacketFlags = i == 0 ? [.keyframe, .config] : []
      let body = [UInt8](repeating: UInt8(i), count: i * 3)
      return Packet(type: .video, flags: f, gen: 1, seq: UInt32(i), captureTs: UInt64(i), encodeDoneTs: UInt64(i),
                    postedInput: 0, rev: UInt32(i + 1), grantId: UInt32(10 + i), payload: body)
    }
  }

  func testFramedFixture() {
    let p = Packet(type: .heartbeat, flags: [], gen: 1, seq: 0, captureTs: 0, encodeDoneTs: 0, postedInput: 0, rev: 0, grantId: 0,
                   payload: Heartbeat.encode(lastCaptureTs: 0x10, latestRev: 3))
    XCTAssertEqual(toHex(Framing.frame(p.encode())), toHex(hex("""
      00000037 04 00 00000001 00000000 0000000000000000 0000000000000000 00000000 00000000 00000000 0000000d
      00 0000000000000010 00000003
      """)))
  }

  func testDeframerEveryByteBoundary() throws {
    let stream = packets().flatMap { Framing.frame($0.encode()) }
    for cut in 0...stream.count {
      var d = Deframer()
      var got = try d.push(Array(stream[0..<cut]))
      got += try d.push(Array(stream[cut...]))
      XCTAssertEqual(got.map { try! Packet.decode($0) }, packets(), "cut \(cut)")
      XCTAssertEqual(d.buffered, 0)
    }
  }

  func testDeframerRejectsTinyAndHugeLengths() {
    var d = Deframer()
    XCTAssertThrowsError(try d.push([0, 0, 0, 41] + [UInt8](repeating: 0, count: 41)))
    var e = Deframer()
    XCTAssertThrowsError(try e.push([0x00, 0x40, 0x00, 0x01]))  // 4 MiB + 1
  }
}

final class Type4Tests: XCTestCase {
  func testHeartbeatIs13Bytes() {
    let b = Heartbeat.encode(lastCaptureTs: 1, latestRev: 2)
    XCTAssertEqual(b.count, 13); XCTAssertEqual(b[0], 0)
    XCTAssertEqual(Heartbeat.decode(b)?.latestRev, 2); XCTAssertNil(Heartbeat.decode(Array(b.prefix(12))))
  }
  func testTimeReplyIs29Bytes() {
    let b = TimeReply.encode(frameCaptureTs: 1, helperRecvTs: 2, helperSendTs: 3, timeId: 4)
    XCTAssertEqual(toHex(b), "01" + "0000000000000001" + "0000000000000002" + "0000000000000003" + "00000004")
    XCTAssertEqual(TimeReply.decode(b)?.timeId, 4); XCTAssertNil(TimeReply.decode(b + [0]))
  }
}

final class AvcCPayloadTests: XCTestCase {
  func testConfigPayloadRoundTrip() {
    let avcC: [UInt8] = [1, 2, 3], nals: [UInt8] = [0, 0, 0, 1, 0x65]
    let p = VideoPayload.withConfig(avcC: avcC, nals: nals)
    XCTAssertEqual(toHex(p), "00000003010203" + "0000000165")
    let s = VideoPayload.split(p, config: true)
    XCTAssertEqual(s?.avcC, avcC); XCTAssertEqual(s?.nals, nals)
    XCTAssertNil(VideoPayload.split([0, 0, 0, 9, 1], config: true))
  }
  func testAvcCParameterSets() {
    // avcC v1, profile 0x64, 4-byte lengths, 1 SPS [67 64], 1 PPS [68 ee]
    let avcC = hex("01 64 00 1f ff e1 0002 6764 01 0002 68ee")
    let ps = AvcC.parameterSets(avcC)
    XCTAssertEqual(ps?.sps, [[0x67, 0x64]]); XCTAssertEqual(ps?.pps, [[0x68, 0xEE]])
    XCTAssertEqual(AvcC.build(sps: [[0x67, 0x64, 0x00, 0x1f]], pps: [[0x68, 0xEE]]).prefix(5), [1, 0x64, 0, 0x1f, 0xFF])
  }
}

final class RevTests: XCTestCase {
  func testRevIncrementsOnlyOnDirtyCompleteFrames() {
    var r = RevCounter()
    XCTAssertFalse(r.observe(complete: false, dirtyRects: 3))
    XCTAssertFalse(r.observe(complete: true, dirtyRects: 0))
    XCTAssertTrue(r.observe(complete: true, dirtyRects: 1)); XCTAssertEqual(r.rev, 1)
    XCTAssertFalse(r.observe(complete: true, dirtyRects: 0)); XCTAssertEqual(r.rev, 1)
    XCTAssertTrue(r.observe(complete: true, dirtyRects: 2)); XCTAssertEqual(r.rev, 2)
  }
}

final class GrantLedgerTests: XCTestCase {
  func testNoChargedFrameWithoutGrant() {
    var l = GrantLedger()
    l.reset(gen: 1)
    XCTAssertNil(l.take(now: 0))
    l.grant(gen: 1, grantId: 5, now: 0)
    XCTAssertEqual(l.take(now: 10)?.grantId, 5)
    XCTAssertNil(l.take(now: 20))
  }
  func testGrantsOfOtherGenIgnoredAndDuplicatesIgnored() {
    var l = GrantLedger(); l.reset(gen: 2)
    l.grant(gen: 1, grantId: 1, now: 0); l.grant(gen: 2, grantId: 2, now: 0); l.grant(gen: 2, grantId: 2, now: 0)
    XCTAssertEqual(l.pending.count, 1)
    XCTAssertEqual(l.ignored, 2)
  }
  func testOutstandingCappedAtTwo() {
    var l = GrantLedger(); l.reset(gen: 1)
    for i in 1...3 { l.grant(gen: 1, grantId: UInt32(i), now: 0) }
    XCTAssertEqual(l.pending.map(\.grantId), [1, 2]); XCTAssertEqual(l.ignored, 1)
  }
  func testSkippedAfterOneSecondWithNoCapture() {
    var l = GrantLedger(); l.reset(gen: 1)
    l.grant(gen: 1, grantId: 7, now: 0); l.grant(gen: 1, grantId: 8, now: 600_000)
    XCTAssertEqual(l.expire(now: 999_999).count, 0)
    XCTAssertEqual(l.expire(now: 1_000_000).map(\.grantId), [7])
    XCTAssertEqual(l.expire(now: 1_000_000).count, 0)  // idempotent
    XCTAssertEqual(l.take(now: 1_000_001)?.grantId, 8)
  }
  func testEmergencySlotIsSeparateAndSingle() {
    var l = GrantLedger(); l.reset(gen: 1)
    l.grant(gen: 1, grantId: 1, now: 0); l.grant(gen: 1, grantId: 2, now: 0)
    XCTAssertTrue(l.reserveEmergency(gen: 1, grantId: 9))
    XCTAssertFalse(l.reserveEmergency(gen: 1, grantId: 10))
    XCTAssertEqual(l.takeEmergency()?.grantId, 9)
    XCTAssertNil(l.takeEmergency())
    XCTAssertEqual(l.pending.count, 2)  // emergency never consumed a charged grant
  }
  func testResetDropsEverything() {
    var l = GrantLedger(); l.reset(gen: 1)
    l.grant(gen: 1, grantId: 1, now: 0); _ = l.reserveEmergency(gen: 1, grantId: 2)
    l.reset(gen: 2)
    XCTAssertTrue(l.pending.isEmpty); XCTAssertNil(l.takeEmergency())
  }
}

final class SizeAndBudgetTests: XCTestCase {
  func testDefaultCapsLongEdgeAt1920() {
    let s = StreamSize.resolve(w: nil, h: nil, nativeW: 3600, nativeH: 2338)
    XCTAssertEqual(s.w, 1920); XCTAssertEqual(s.h, 1246)
  }
  func testRequestedSizeCappedAtNativeAndEven() {
    XCTAssertEqual(StreamSize.resolve(w: 5000, h: 4000, nativeW: 3600, nativeH: 2338).w, 3600)
    let s = StreamSize.resolve(w: 1001, h: 801, nativeW: 3600, nativeH: 2338)
    XCTAssertTrue(s.w % 2 == 0 && s.h % 2 == 0 && s.w <= 1001 && s.h <= 801)
  }
  func testIdrBudget() {
    XCTAssertFalse(IdrBudget.over(bytes: 200_000, kbps: 4000))   // 400 ms at 4 Mbps = 200 kB
    XCTAssertTrue(IdrBudget.over(bytes: 200_001, kbps: 4000))
    XCTAssertTrue(IdrBudget.over(bytes: 4 * 1024 * 1024, kbps: 1_000_000))
  }
}

final class ControlOpTests: XCTestCase {
  func testOnlyKnownOps() {
    for op in ["start", "rate", "grant", "keyframe", "time", "input", "release", "stop"] {
      XCTAssertNotNil(ControlOp.parse("{\"op\":\"\(op)\"}"), op)
    }
    XCTAssertNil(ControlOp.parse("{\"op\":\"credit\"}"))
    XCTAssertNil(ControlOp.parse("not json"))
    let g = ControlOp.parse("{\"op\":\"grant\",\"gen\":3,\"grantId\":11}")
    XCTAssertEqual(g?.op, "grant"); XCTAssertEqual(g?.uint("gen"), 3); XCTAssertEqual(g?.uint("grantId"), 11)
  }
}
