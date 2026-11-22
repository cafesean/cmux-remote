// Helper wire v1: the 42-byte packet header, outer-length framing, type 4 payloads, the grant ledger
// and content revision. Pure and allocation-light so it is unit tested without a screen.
import Foundation

public enum PacketType: UInt8 { case video = 1, cursorPos = 2, cursorShape = 3, heartbeat = 4, meta = 5 }

public struct PacketFlags: OptionSet, Equatable {
  public let rawValue: UInt8
  public init(rawValue: UInt8) { self.rawValue = rawValue }
  public static let keyframe = PacketFlags(rawValue: 1 << 0)
  public static let config = PacketFlags(rawValue: 1 << 1)    // payload = u32 avcC length, avcC, NAL units
  public static let refine = PacketFlags(rawValue: 1 << 2)    // still-screen sharpen IDR
  public static let snapshot = PacketFlags(rawValue: 1 << 3)  // encoded from the retained buffer
  public static let free = PacketFlags(rawValue: 1 << 4)      // emergency IDR, not charged
}

public enum PacketHeader {
  public static let size = 42
  public static let maxPacket = 4 * 1024 * 1024
}

public enum WireError: Error, Equatable { case short, lengthMismatch, badType(UInt8), badFrameLength(Int) }

@inline(__always) func put32(_ b: inout [UInt8], _ v: UInt32) {
  b += [UInt8(v >> 24), UInt8(truncatingIfNeeded: v >> 16), UInt8(truncatingIfNeeded: v >> 8), UInt8(truncatingIfNeeded: v)]
}
@inline(__always) func put64(_ b: inout [UInt8], _ v: UInt64) { put32(&b, UInt32(v >> 32)); put32(&b, UInt32(truncatingIfNeeded: v)) }
@inline(__always) func get32<C: RandomAccessCollection>(_ b: C, _ o: Int) -> UInt32 where C.Element == UInt8, C.Index == Int {
  let s = b.startIndex + o
  return UInt32(b[s]) << 24 | UInt32(b[s + 1]) << 16 | UInt32(b[s + 2]) << 8 | UInt32(b[s + 3])
}
@inline(__always) func get64<C: RandomAccessCollection>(_ b: C, _ o: Int) -> UInt64 where C.Element == UInt8, C.Index == Int {
  UInt64(get32(b, o)) << 32 | UInt64(get32(b, o + 4))
}

public struct Packet: Equatable {
  public var type: PacketType
  public var flags: PacketFlags
  public var gen: UInt32, seq: UInt32
  public var captureTs: UInt64, encodeDoneTs: UInt64
  public var postedInput: UInt32, rev: UInt32, grantId: UInt32
  public var payload: [UInt8]

  public init(type: PacketType, flags: PacketFlags = [], gen: UInt32, seq: UInt32, captureTs: UInt64 = 0, encodeDoneTs: UInt64 = 0,
              postedInput: UInt32 = 0, rev: UInt32 = 0, grantId: UInt32 = 0, payload: [UInt8]) {
    self.type = type; self.flags = flags; self.gen = gen; self.seq = seq; self.captureTs = captureTs
    self.encodeDoneTs = encodeDoneTs; self.postedInput = postedInput; self.rev = rev; self.grantId = grantId; self.payload = payload
  }

  public func encode() -> [UInt8] {
    var b: [UInt8] = []
    b.reserveCapacity(PacketHeader.size + payload.count)
    b.append(type.rawValue); b.append(flags.rawValue)
    put32(&b, gen); put32(&b, seq); put64(&b, captureTs); put64(&b, encodeDoneTs)
    put32(&b, postedInput); put32(&b, rev); put32(&b, grantId); put32(&b, UInt32(payload.count))
    b += payload
    return b
  }

  /// One bare packet (a WS message, or a frame body after the outer length is stripped).
  public static func decode(_ b: [UInt8]) throws -> Packet {
    guard b.count >= PacketHeader.size else { throw WireError.short }
    guard let t = PacketType(rawValue: b[0]) else { throw WireError.badType(b[0]) }
    let n = Int(get32(b, 38))
    guard n == b.count - PacketHeader.size else { throw WireError.lengthMismatch }
    return Packet(type: t, flags: PacketFlags(rawValue: b[1]), gen: get32(b, 2), seq: get32(b, 6), captureTs: get64(b, 10),
                  encodeDoneTs: get64(b, 18), postedInput: get32(b, 26), rev: get32(b, 30), grantId: get32(b, 34),
                  payload: Array(b[PacketHeader.size...]))
  }
}

/// Helper stdout / bridge chunked body: outer u32 BE length L, then L bytes = one packet.
public enum Framing {
  public static func frame(_ packet: [UInt8]) -> [UInt8] {
    var b: [UInt8] = []
    b.reserveCapacity(4 + packet.count)
    put32(&b, UInt32(packet.count)); b += packet
    return b
  }
}

public struct Deframer {
  var buf: [UInt8] = []
  public init() {}
  public var buffered: Int { buf.count }
  /// Feed bytes; returns every complete packet body. Throws on L < 42 or L > 4 MiB (stream error).
  public mutating func push(_ bytes: [UInt8]) throws -> [[UInt8]] {
    buf += bytes
    var out: [[UInt8]] = []
    var i = 0
    while buf.count - i >= 4 {
      let l = Int(get32(buf, i))
      guard l >= PacketHeader.size, l <= PacketHeader.maxPacket else { throw WireError.badFrameLength(l) }
      guard buf.count - i - 4 >= l else { break }
      out.append(Array(buf[(i + 4)..<(i + 4 + l)]))
      i += 4 + l
    }
    if i > 0 { buf.removeFirst(i) }
    return out
  }
}

/// Type 4 subtype 0: {lastCaptureTs u64, latestRev u32}, 13 bytes.
public enum Heartbeat {
  public static func encode(lastCaptureTs: UInt64, latestRev: UInt32) -> [UInt8] {
    var b: [UInt8] = [0]; put64(&b, lastCaptureTs); put32(&b, latestRev); return b
  }
  public static func decode(_ b: [UInt8]) -> (lastCaptureTs: UInt64, latestRev: UInt32)? {
    guard b.count == 13, b[0] == 0 else { return nil }
    return (get64(b, 1), get32(b, 9))
  }
}

/// Type 4 subtype 1: {frameCaptureTs u64, helperRecvTs u64, helperSendTs u64, timeId u32}, 29 bytes.
public enum TimeReply {
  public static func encode(frameCaptureTs: UInt64, helperRecvTs: UInt64, helperSendTs: UInt64, timeId: UInt32) -> [UInt8] {
    var b: [UInt8] = [1]; put64(&b, frameCaptureTs); put64(&b, helperRecvTs); put64(&b, helperSendTs); put32(&b, timeId); return b
  }
  public static func decode(_ b: [UInt8]) -> (frameCaptureTs: UInt64, helperRecvTs: UInt64, helperSendTs: UInt64, timeId: UInt32)? {
    guard b.count == 29, b[0] == 1 else { return nil }
    return (get64(b, 1), get64(b, 9), get64(b, 17), get32(b, 25))
  }
}

/// IDR payload with flags.config: u32 avcC length, avcC, then the AVCC NAL units.
public enum VideoPayload {
  public static func withConfig(avcC: [UInt8], nals: [UInt8]) -> [UInt8] {
    var b: [UInt8] = []; put32(&b, UInt32(avcC.count)); return b + avcC + nals
  }
  public static func split(_ p: [UInt8], config: Bool) -> (avcC: [UInt8]?, nals: [UInt8])? {
    guard config else { return (nil, p) }
    guard p.count >= 4 else { return nil }
    let n = Int(get32(p, 0))
    guard 4 + n <= p.count else { return nil }
    return (Array(p[4..<(4 + n)]), Array(p[(4 + n)...]))
  }
}

/// AVCDecoderConfigurationRecord (ISO 14496-15) build/parse, 4-byte NAL lengths.
public enum AvcC {
  public static func build(sps: [[UInt8]], pps: [[UInt8]]) -> [UInt8] {
    guard let s0 = sps.first, s0.count >= 4 else { return [] }
    var b: [UInt8] = [1, s0[1], s0[2], s0[3], 0xFF, 0xE0 | UInt8(sps.count & 0x1F)]
    for s in sps { b += [UInt8(s.count >> 8), UInt8(s.count & 0xFF)] + s }
    b.append(UInt8(pps.count))
    for p in pps { b += [UInt8(p.count >> 8), UInt8(p.count & 0xFF)] + p }
    return b
  }
  public static func parameterSets(_ a: [UInt8]) -> (sps: [[UInt8]], pps: [[UInt8]])? {
    guard a.count >= 7, a[0] == 1 else { return nil }
    var i = 6
    func sets(_ count: Int) -> [[UInt8]]? {
      var out: [[UInt8]] = []
      for _ in 0..<count {
        guard i + 2 <= a.count else { return nil }
        let n = Int(a[i]) << 8 | Int(a[i + 1]); i += 2
        guard i + n <= a.count else { return nil }
        out.append(Array(a[i..<(i + n)])); i += n
      }
      return out
    }
    i = 6
    guard let sps = sets(Int(a[5] & 0x1F)) else { return nil }
    return parseTail(a, sps: sps)
  }
  static func parseTail(_ a: [UInt8], sps: [[UInt8]]) -> (sps: [[UInt8]], pps: [[UInt8]])? {
    var i = 6 + sps.reduce(0) { $0 + 2 + $1.count }
    guard i < a.count else { return nil }
    let np = Int(a[i]); i += 1
    var pps: [[UInt8]] = []
    for _ in 0..<np {
      guard i + 2 <= a.count else { return nil }
      let n = Int(a[i]) << 8 | Int(a[i + 1]); i += 2
      guard i + n <= a.count else { return nil }
      pps.append(Array(a[i..<(i + n)])); i += n
    }
    return (sps, pps)
  }
}

/// Content revision: +1 per captured frame that has dirty rects; idle / no-dirty callbacks do not count.
public struct RevCounter {
  public private(set) var rev: UInt32 = 0
  public init() {}
  @discardableResult public mutating func observe(complete: Bool, dirtyRects: Int) -> Bool {
    guard complete, dirtyRects > 0 else { return false }
    rev &+= 1
    return true
  }
}

public struct Grant: Equatable {
  public var gen: UInt32, grantId: UInt32, at: UInt64
}

/// Helper-side grant ledger: one grant = one charged frame. At most 2 outstanding; a grant with no capture
/// within 1 s is retired as skipped{gen, grantId}. One emergency slot, separate from charged grants.
public struct GrantLedger {
  public static let maxOutstanding = 2
  public static let skipAfterUs: UInt64 = 1_000_000
  public private(set) var gen: UInt32 = 0
  public private(set) var pending: [Grant] = []
  public private(set) var ignored = 0
  var emergency: Grant?
  public init() {}

  public mutating func reset(gen: UInt32) { self.gen = gen; pending.removeAll(); emergency = nil }

  public mutating func grant(gen: UInt32, grantId: UInt32, now: UInt64) {
    guard gen == self.gen, !pending.contains(where: { $0.grantId == grantId }), emergency?.grantId != grantId,
          pending.count < Self.maxOutstanding else { ignored += 1; return }
    pending.append(Grant(gen: gen, grantId: grantId, at: now))
  }

  /// Oldest live grant for a captured frame, or nil (frame dropped before encode).
  public mutating func take(now: UInt64) -> Grant? { pending.isEmpty ? nil : pending.removeFirst() }

  public var available: Bool { !pending.isEmpty }

  /// Grants older than 1 s: retired, report skipped for each.
  public mutating func expire(now: UInt64) -> [Grant] {
    let dead = pending.filter { now &- $0.at >= Self.skipAfterUs }
    pending.removeAll { now &- $0.at >= Self.skipAfterUs }
    return dead
  }

  public mutating func reserveEmergency(gen: UInt32, grantId: UInt32) -> Bool {
    guard gen == self.gen, emergency == nil else { ignored += 1; return false }
    emergency = Grant(gen: gen, grantId: grantId, at: 0)
    return true
  }
  public mutating func takeEmergency() -> Grant? { defer { emergency = nil }; return emergency }
}

/// Encode size: requested w,h capped at native, aspect kept, even; no request -> long edge capped at 1920.
public enum StreamSize {
  public static let defaultLongEdge = 1920
  public static func resolve(w: Int?, h: Int?, nativeW: Int, nativeH: Int) -> (w: Int, h: Int) {
    let nw = Double(nativeW), nh = Double(nativeH)
    var s: Double
    if let w, let h, w > 0, h > 0 { s = min(Double(w) / nw, Double(h) / nh) }
    else if let w, w > 0 { s = Double(w) / nw }
    else { s = Double(defaultLongEdge) / max(nw, nh) }
    s = min(s, 1)
    let ew = max(Int((nw * s).rounded(.down)), 2) & ~1, eh = max(Int((nh * s).rounded(.down)), 2) & ~1
    return (ew, eh)
  }
}

/// An IDR is over budget when it cannot drain in 400 ms at the current rate, or exceeds the 4 MiB parser bound.
public enum IdrBudget {
  public static let budgetMs = 400
  public static func over(bytes: Int, kbps: Int) -> Bool {
    if bytes + PacketHeader.size > PacketHeader.maxPacket { return true }
    return Double(bytes) * 8 / Double(max(kbps, 1)) > Double(budgetMs)
  }
}

/// One stdin JSON line. Only the helper's eight ops parse; anything else is ignored by the caller.
public struct ControlOp {
  public static let ops: Set<String> = ["start", "rate", "grant", "keyframe", "time", "input", "release", "stop"]
  public let op: String
  public let fields: [String: Any]
  public static func parse(_ line: String) -> ControlOp? {
    guard let d = line.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let op = o["op"] as? String, ops.contains(op) else { return nil }
    return ControlOp(op: op, fields: o)
  }
  public func uint(_ k: String) -> UInt32? {
    guard let n = fields[k] as? NSNumber, n.doubleValue >= 0, n.doubleValue <= Double(UInt32.max) else { return nil }
    return n.uint32Value
  }
  public func int(_ k: String) -> Int? { (fields[k] as? NSNumber).map { $0.intValue } }
  public func string(_ k: String) -> String? { fields[k] as? String }
  public func bool(_ k: String) -> Bool { (fields[k] as? Bool) ?? false }
}
