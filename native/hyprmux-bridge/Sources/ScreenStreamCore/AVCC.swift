// AVCC (length-prefixed) H.264 access-unit helpers.

public struct NALUnit: Equatable {
  public var type: UInt8
  public var range: Range<Int>
}

public enum AVCC {
  /// Split one AVCC access unit into NAL units. nil when a length prefix runs past the buffer or is zero.
  public static func nalUnits(_ d: [UInt8], lengthSize: Int = 4) -> [NALUnit]? {
    guard (1...4).contains(lengthSize) else { return nil }
    var out: [NALUnit] = []
    var i = 0
    while i < d.count {
      guard i + lengthSize <= d.count else { return nil }
      var len = 0
      for k in 0..<lengthSize { len = (len << 8) | Int(d[i + k]) }
      let start = i + lengthSize
      guard len > 0, start + len <= d.count else { return nil }
      out.append(NALUnit(type: d[start] & 0x1F, range: start..<(start + len)))
      i = start + len
    }
    return out
  }

  /// True when the access unit carries an IDR slice (NAL type 5).
  public static func isIDR(_ units: [NALUnit]) -> Bool { units.contains { $0.type == 5 } }
}
