// Input for the screen-stream helper: the pure half of the CGEvent port of the bridge's JXA input path
// (lib/mac-screen.js JXA_INPUT). Each input item becomes a list of abstract event steps; the helper turns
// steps into CGEvents and posts them. Also here: the epoch gate, the held set and the 5 s safety watchdog.
// No CoreGraphics import, so all of it is unit tested without posting anything.
import Foundation

/// CGEventType raw values used by the JXA path (numeric fallbacks in ptr()).
public enum MouseKind: UInt32, Equatable {
  case leftDown = 1, leftUp = 2, rightDown = 3, rightUp = 4, moved = 5, leftDragged = 6
}

public enum MouseButton: UInt32, Equatable { case left = 0, right = 1 }

/// kCGMouseEventDeltaX / DeltaY of a dragged event (points moved since the last posted pointer event).
public struct MouseDelta: Equatable {
  public var dx: Double, dy: Double
  public init(dx: Double, dy: Double) { self.dx = dx; self.dy = dy }
}

/// One step the helper performs, in order.
public enum EventStep: Equatable {
  /// CGEventCreateMouseEvent(type, point, button); clickState and delta set when non-nil.
  case mouse(MouseKind, x: Double, y: Double, button: MouseButton, clickState: Int?, delta: MouseDelta? = nil)
  /// CGEventCreateScrollWheelEvent(pixel units, wheelCount 2, wheel1, wheel2).
  case scroll(wheel1: Int32, wheel2: Int32)
  /// CGEventCreateKeyboardEvent(keycode, down) + CGEventSetFlags(flags).
  case key(code: UInt16, down: Bool, flags: UInt64)
  /// Keycode 0 + CGEventKeyboardSetUnicodeString(units).
  case unicode([UInt16], down: Bool)
  /// HMX k151: the char's real US keycode (+ flags) AND CGEventKeyboardSetUnicodeString(units). Apps that read the
  /// text get the text; apps that read the keycode (terminals) get the right key instead of keycode 0 = "a".
  case keyText(code: UInt16, down: Bool, flags: UInt64, units: [UInt16])
  /// Sleep between steps (the JXA delay() calls).
  case pause(ms: Int)
}

public enum InputLimits {
  public static let secureTypeMaxChars = 100
  public static let typeMaxChars = 1000
  public static let unicodeChunk = 16
  public static let scrollMax = 3000
  public static let holdMaxUs: UInt64 = 5_000_000
}

// MARK: keys (same table and allow-list as lib/mac-screen.js KEYCODES / KEY_ALLOW / parseKey)

public enum KeyTable {
  public static let keycodes: [String: UInt16] = [
    "return": 36, "tab": 48, "space": 49, "delete": 51, "esc": 53, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "f": 3, "t": 17, "w": 13, "n": 45, "l": 37, "r": 15, "`": 50,
  ]
  public static let modFlags: [String: UInt64] = ["cmd": 0x100000, "ctrl": 0x40000, "opt": 0x80000, "shift": 0x20000]
  public static let modOrder = ["cmd", "ctrl", "opt", "shift"]
  static let plain = ["return", "tab", "space", "delete", "esc", "forwarddelete", "left", "right", "up", "down",
                      "home", "end", "pageup", "pagedown"]
  public static let allow: Set<String> = Set(plain + plain.map { "shift+" + $0 } + [
    "opt+left", "opt+right", "opt+delete", "cmd+left", "cmd+right", "cmd+up", "cmd+down", "cmd+delete",
    "cmd+a", "cmd+c", "cmd+v", "cmd+x", "cmd+z", "cmd+shift+z", "cmd+f", "cmd+t", "cmd+w", "cmd+n",
    "cmd+l", "cmd+r", "cmd+tab", "cmd+shift+tab", "cmd+space", "cmd+`", "ctrl+c", "shift+tab",
  ])

  /// -> (combo, code, flags) or nil when the key or combo is not allowed.
  public static func parse(key: String, mods: [String]) -> (combo: String, code: UInt16, flags: UInt64)? {
    let k = key.lowercased().trimmingCharacters(in: .whitespaces)
    guard let code = keycodes[k] else { return nil }
    let ms = mods.map { $0.lowercased() }
    guard ms.allSatisfy({ modFlags[$0] != nil }) else { return nil }
    let uniq = modOrder.filter { ms.contains($0) }
    let combo = (uniq + [k]).joined(separator: "+")
    guard allow.contains(combo) else { return nil }
    return (combo, code, uniq.reduce(UInt64(0)) { $0 | modFlags[$1]! })
  }

  // D106 Secure Input: US-layout keycodes (+shift) for ASCII, as JXA KC / SH.
  public static let kc: [Character: UInt16] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
  ]
  public static let shifted: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-",
    "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
  ]
  public static let shiftFlag: UInt64 = 0x20000

  /// JXA kc(ch): keycode + shift, or nil (then the char goes as unicode).
  public static func secureKey(_ ch: Character) -> (code: UInt16, shift: Bool)? {
    if let c = kc[ch] { return (c, false) }
    let l = Character(String(ch).lowercased())
    if l != ch, let c = kc[l] { return (c, true) }
    if let b = shifted[ch], let c = kc[b] { return (c, true) }
    return nil
  }

  /// Keycodes of the modifier keys themselves (cmd, shift, opt, ctrl and their right-hand twins, caps, fn).
  public static let modifierKeycodes: Set<UInt16> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]
}

// MARK: items

public struct InputItem: Equatable {
  public var gen: UInt32, epoch: UInt32, seq: UInt32
  public var t: String
  public var type: String?          // mouse: move|down|drag|up
  public var fx: Double?, fy: Double?
  public var button: String?, double: Bool
  public var dx: Double?, dy: Double?
  public var text: String?
  public var key: String?, mods: [String]

  public init(gen: UInt32, epoch: UInt32, seq: UInt32, t: String, type: String? = nil, fx: Double? = nil, fy: Double? = nil,
              button: String? = nil, double: Bool = false, dx: Double? = nil, dy: Double? = nil, text: String? = nil,
              key: String? = nil, mods: [String] = []) {
    self.gen = gen; self.epoch = epoch; self.seq = seq; self.t = t; self.type = type; self.fx = fx; self.fy = fy
    self.button = button; self.double = double; self.dx = dx; self.dy = dy; self.text = text; self.key = key; self.mods = mods
  }

  /// From one JSON object; gen/epoch fall back to the batch's. nil when seq or t is missing.
  public static func from(_ o: [String: Any], gen: UInt32?, epoch: UInt32?) -> InputItem? {
    func u(_ k: String) -> UInt32? {
      guard let n = o[k] as? NSNumber, n.doubleValue >= 0, n.doubleValue <= Double(UInt32.max) else { return nil }
      return n.uint32Value
    }
    func d(_ k: String) -> Double? { (o[k] as? NSNumber).map { $0.doubleValue } }
    guard let seq = u("seq"), let t = o["t"] as? String, let g = u("gen") ?? gen, let e = u("epoch") ?? epoch else { return nil }
    return InputItem(gen: g, epoch: e, seq: seq, t: t, type: o["type"] as? String, fx: d("fx"), fy: d("fy"),
                     button: o["button"] as? String, double: (o["double"] as? Bool) ?? false, dx: d("dx"), dy: d("dy"),
                     text: o["text"] as? String, key: o["key"] as? String, mods: (o["mods"] as? [String]) ?? [])
  }

  public var isMove: Bool { t == "mouse" && (type == "move" || type == "drag") }
}

/// Consecutive moves (same kind) collapse to the last one; everything else keeps its place and order.
public enum Coalesce {
  public static func moves(_ items: [InputItem]) -> [InputItem] { groups(items).map(\.item) }

  /// Each kept item with the items it superseded (in order), so their seqs can be acked as posted.
  public static func groups(_ items: [InputItem]) -> [(item: InputItem, superseded: [InputItem])] {
    var out: [(item: InputItem, superseded: [InputItem])] = []
    for it in items {
      if it.isMove, let last = out.last?.item, last.isMove, last.type == it.type, last.epoch == it.epoch, last.gen == it.gen {
        out[out.count - 1] = (it, out[out.count - 1].superseded + [last])
      } else { out.append((it, [])) }
    }
    return out
  }
}

// MARK: planner (item -> steps, the JXA semantics)

public enum PlanError: String, Error, Equatable { case badop, nodisplay, toolong, badkey, badcoords, notDown = "not_down" }

public enum InputPlanner {
  /// leftHeld: the left button is down (a move then becomes a drag, as the bridge does today).
  public static func plan(_ it: InputItem, display: DisplayGeometry?, secureInput: Bool, leftHeld: Bool) -> Result<[EventStep], PlanError> {
    switch it.t {
    case "mouse": return pointer(it, display, leftHeld)
    case "tap": return tap(it, display)
    case "scroll": return scroll(it, display)
    case "type": return type(it, secureInput)
    case "key":
      guard let k = it.key, let p = KeyTable.parse(key: k, mods: it.mods) else { return .failure(.badkey) }
      return .success([.key(code: p.code, down: true, flags: p.flags), .key(code: p.code, down: false, flags: p.flags)])
    default: return .failure(.badop)
    }
  }

  static func point(_ it: InputItem, _ d: DisplayGeometry) -> (x: Double, y: Double)? {
    guard let fx = it.fx, let fy = it.fy, fx.isFinite, fy.isFinite else { return nil }
    return DisplayMap.inputPoint(fx: fx, fy: fy, in: d)
  }

  // JXA ptr(): one raw left-button event; down is preceded by a move; down/drag/up carry clickState 1.
  static func pointer(_ it: InputItem, _ d: DisplayGeometry?, _ leftHeld: Bool) -> Result<[EventStep], PlanError> {
    guard let d else { return .failure(.nodisplay) }
    guard let p = point(it, d) else { return .failure(.badcoords) }
    var kind: MouseKind
    switch it.type {
    case "move": kind = leftHeld ? .leftDragged : .moved
    case "drag": guard leftHeld else { return .failure(.notDown) }; kind = .leftDragged
    case "down": kind = .leftDown
    case "up": kind = .leftUp
    default: return .failure(.badop)
    }
    var s: [EventStep] = []
    if kind == .leftDown { s.append(.mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil)) }
    // down/dragged/up carry clickState 1 (the engine fills a dragged event's delta from the last posted point).
    s.append(.mouse(kind, x: p.x, y: p.y, button: .left, clickState: kind == .moved ? nil : 1))
    return .success(s)
  }

  // JXA mouse(): move, then n x (down, up) with clickState i; right button when asked.
  static func tap(_ it: InputItem, _ d: DisplayGeometry?) -> Result<[EventStep], PlanError> {
    guard let d else { return .failure(.nodisplay) }
    guard let p = point(it, d) else { return .failure(.badcoords) }
    let r = it.button == "right"
    let b: MouseButton = r ? .right : .left
    var s: [EventStep] = [.mouse(.moved, x: p.x, y: p.y, button: b, clickState: nil)]
    for i in 1...(it.double ? 2 : 1) {
      s.append(.mouse(r ? .rightDown : .leftDown, x: p.x, y: p.y, button: b, clickState: i))
      s.append(.mouse(r ? .rightUp : .leftUp, x: p.x, y: p.y, button: b, clickState: i))
    }
    return .success(s)
  }

  // JXA scroll(): optional move (left button) to fx,fy, then pixel scroll wheel1 = -dy, wheel2 = -dx.
  static func scroll(_ it: InputItem, _ d: DisplayGeometry?) -> Result<[EventStep], PlanError> {
    func c(_ v: Double?) -> Int32 {
      guard let v, v.isFinite else { return 0 }
      return Int32(max(-Double(InputLimits.scrollMax), min(Double(InputLimits.scrollMax), v.rounded())))
    }
    var s: [EventStep] = []
    if let d, it.fx != nil, let p = point(it, d) { s.append(.mouse(.moved, x: p.x, y: p.y, button: .left, clickState: nil)) }
    s.append(.scroll(wheel1: -c(it.dy), wheel2: -c(it.dx)))
    return .success(s)
  }

  static func type(_ it: InputItem, _ secure: Bool) -> Result<[EventStep], PlanError> {
    guard let text = it.text else { return .failure(.badop) }
    if !secure {
      guard text.utf16.count <= InputLimits.typeMaxChars else { return .failure(.toolong) }
      return .success(keyText(text))
    }
    guard text.utf16.count <= InputLimits.secureTypeMaxChars else { return .failure(.toolong) }
    var s: [EventStep] = []
    for ch in text {
      guard let k = KeyTable.secureKey(ch) else { s += unicode(String(ch)); continue }
      let f = k.shift ? KeyTable.shiftFlag : 0
      s += [.key(code: k.code, down: true, flags: f), .pause(ms: 20), .key(code: k.code, down: false, flags: f), .pause(ms: 20), .pause(ms: 60)]
    }
    return .success(s)
  }

  /// HMX k151 (typing in a text box typed only 'a' for every keypress): outside Secure Input
  /// every char went as keycode 0 + a unicode string, and an app that reads the keycode typed "a" for each key.
  /// Now a char with a US keycode goes as that keycode (+ shift) carrying its own text; runs of other chars
  /// (accents, emoji, CJK) stay unicode chunks. Same steps as JXA typeText() in lib/mac-screen.js.
  public static func keyText(_ text: String) -> [EventStep] {
    var s: [EventStep] = []
    var run = ""
    for ch in text {
      guard let k = KeyTable.secureKey(ch) else { run.append(ch); continue }
      if !run.isEmpty { s += unicode(run); run = "" }
      let f = k.shift ? KeyTable.shiftFlag : 0
      let u = Array(String(ch).utf16)
      s += [.keyText(code: k.code, down: true, flags: f, units: u), .keyText(code: k.code, down: false, flags: f, units: u), .pause(ms: 2)]
    }
    if !run.isEmpty { s += unicode(run) }
    return s
  }

  /// JXA typeUni(): 16 UTF-16 units per event pair, 5 ms apart (a surrogate pair is never split).
  public static func unicode(_ text: String) -> [EventStep] {
    let u = Array(text.utf16)
    var s: [EventStep] = []
    var i = 0
    while i < u.count {
      var j = min(i + InputLimits.unicodeChunk, u.count)
      if j < u.count, j > i + 1, UTF16.isLeadSurrogate(u[j - 1]) { j -= 1 }
      let ch = Array(u[i..<j])
      s += [.unicode(ch, down: true), .unicode(ch, down: false), .pause(ms: 5)]
      i = j
    }
    return s
  }
}

// MARK: held set + watchdog

public enum HeldKey: Hashable { case button(MouseButton), modifier(UInt16) }

public struct HeldEntry: Equatable {
  public var epoch: UInt32
  public var lastEventUs: UInt64
  public var x: Double, y: Double
}

/// What is down right now, from the steps actually posted.
public struct HeldSet {
  public private(set) var held: [HeldKey: HeldEntry] = [:]
  var lastX = 0.0, lastY = 0.0
  public init() {}
  public var isEmpty: Bool { held.isEmpty }
  public func contains(_ k: HeldKey) -> Bool { held[k] != nil }

  /// Record one posted step.
  public mutating func observe(_ s: EventStep, epoch: UInt32, now: UInt64) {
    switch s {
    case let .mouse(kind, x, y, button, _, _):
      lastX = x; lastY = y
      switch kind {
      case .leftDown, .rightDown: held[.button(button)] = HeldEntry(epoch: epoch, lastEventUs: now, x: x, y: y)
      case .leftUp, .rightUp: held[.button(button)] = nil
      case .leftDragged: if held[.button(.left)] != nil { held[.button(.left)] = HeldEntry(epoch: held[.button(.left)]!.epoch, lastEventUs: now, x: x, y: y) }
      case .moved: break
      }
    case let .key(code, down, _):
      guard KeyTable.modifierKeycodes.contains(code) else { return }
      if down { held[.modifier(code)] = HeldEntry(epoch: epoch, lastEventUs: now, x: lastX, y: lastY) } else { held[.modifier(code)] = nil }
    case .scroll, .unicode, .keyText, .pause: break   // keyText codes are never modifier keys
    }
  }

  /// The up step for one held key (button up at its last point, modifier key up with no flags).
  public static func upStep(_ k: HeldKey, _ e: HeldEntry) -> EventStep {
    switch k {
    case .button(.left): return .mouse(.leftUp, x: e.x, y: e.y, button: .left, clickState: 1)
    case .button(.right): return .mouse(.rightUp, x: e.x, y: e.y, button: .right, clickState: 1)
    case let .modifier(c): return .key(code: c, down: false, flags: 0)
    }
  }

  static func order(_ a: HeldKey, _ b: HeldKey) -> Bool {
    func r(_ k: HeldKey) -> Int { switch k { case let .button(b): return Int(b.rawValue); case let .modifier(c): return 100 + Int(c) } }
    return r(a) < r(b)
  }

  /// Ups for every entry of epoch <= upTo (a release never touches a newer epoch's state).
  public func ups(throughEpoch upTo: UInt32) -> [(HeldKey, EventStep)] {
    held.filter { $0.value.epoch <= upTo }.keys.sorted(by: Self.order).map { ($0, Self.upStep($0, held[$0]!)) }
  }

  /// D159: entries held holdMaxUs with no further event for them.
  public func overdue(now: UInt64, holdMaxUs: UInt64 = InputLimits.holdMaxUs) -> [(HeldKey, EventStep)] {
    held.filter { now &- $0.value.lastEventUs >= holdMaxUs }.keys.sorted(by: Self.order).map { ($0, Self.upStep($0, held[$0]!)) }
  }

  public mutating func drop(_ k: HeldKey) { held[k] = nil }
}

// MARK: epoch gate + the serial input engine (posting injected)

public enum InputRecord: Equatable {
  case posted(epoch: UInt32, seq: UInt32)
  /// A move/drag superseded by a later one in the same batch: never posted itself, acked so the client drains.
  case coalesced(epoch: UInt32, seq: UInt32)
  case failed(epoch: UInt32, seq: UInt32?, why: String)
  case released(epoch: UInt32)
  case watchdog(epoch: UInt32, what: String)

  public var json: [String: Any] {
    switch self {
    case let .posted(e, s): return ["kind": "posted", "epoch": e, "seq": s]
    case let .coalesced(e, s): return ["kind": "posted", "epoch": e, "seq": s, "coalesced": true]
    case let .failed(e, s, w): var o: [String: Any] = ["kind": "failed", "epoch": e, "why": w]; if let s { o["seq"] = s }; return o
    case let .released(e): return ["kind": "released", "epoch": e]
    case let .watchdog(e, w): return ["kind": "watchdog_up", "epoch": e, "what": w]
    }
  }
}

/// Serial: one caller at a time (the helper's input queue). post returns false when a CGEvent could not be made.
public struct InputEngine {
  public private(set) var gen: UInt32
  public private(set) var acceptedEpoch: UInt32 = 0
  public private(set) var held = HeldSet()
  public private(set) var lastPostedSeq: UInt32 = 0
  public init(gen: UInt32 = 0) { self.gen = gen }

  public struct Env {
    public var now: () -> UInt64
    public var axTrusted: () -> Bool
    public var secureInput: () -> Bool
    public var display: () -> DisplayGeometry?
    public var post: (EventStep) -> Bool
    public init(now: @escaping () -> UInt64, axTrusted: @escaping () -> Bool, secureInput: @escaping () -> Bool,
                display: @escaping () -> DisplayGeometry?, post: @escaping (EventStep) -> Bool) {
      self.now = now; self.axTrusted = axTrusted; self.secureInput = secureInput; self.display = display; self.post = post
    }
  }

  /// A new media gen: items of any other gen are stale. Held state is kept (the bridge still owns its release).
  public mutating func setGen(_ g: UInt32) { gen = g }

  /// Gate: wrong gen or epoch < acceptedEpoch -> stale, nothing posted. A newer epoch is adopted.
  public mutating func admit(_ it: InputItem) -> Bool {
    guard it.gen == gen, it.epoch >= acceptedEpoch else { return false }
    acceptedEpoch = it.epoch
    return true
  }

  /// One batch, in order (consecutive moves coalesced first).
  public mutating func run(_ items: [InputItem], _ env: Env) -> [InputRecord] {
    var out: [InputRecord] = []
    for (it, superseded) in Coalesce.groups(items) {
      for x in superseded { out.append(.coalesced(epoch: x.epoch, seq: x.seq)) }
      guard admit(it) else { out.append(.failed(epoch: it.epoch, seq: it.seq, why: "stale")); continue }
      guard env.axTrusted() else { out.append(.failed(epoch: it.epoch, seq: it.seq, why: "noax")); continue }
      switch InputPlanner.plan(it, display: env.display(), secureInput: env.secureInput(), leftHeld: held.contains(.button(.left))) {
      case let .failure(e): out.append(.failed(epoch: it.epoch, seq: it.seq, why: e.rawValue))
      case let .success(steps):
        var ok = true
        for var s in steps {
          if case .pause = s { _ = env.post(s); continue }
          if case let .mouse(.leftDragged, x, y, b, c, nil) = s {
            s = .mouse(.leftDragged, x: x, y: y, button: b, clickState: c, delta: MouseDelta(dx: x - held.lastX, dy: y - held.lastY))
          }
          guard env.post(s) else { ok = false; break }
          held.observe(s, epoch: it.epoch, now: env.now())
        }
        if ok { lastPostedSeq = it.seq; out.append(.posted(epoch: it.epoch, seq: it.seq)) }
        else { out.append(.failed(epoch: it.epoch, seq: it.seq, why: "post_failed")) }
      }
    }
    return out
  }

  /// release{epoch}: retire it (acceptedEpoch = epoch + 1), post ups for held state of that epoch or older,
  /// then answer released. AX denied: nothing posted, held set kept, failed{noax}; the bridge retries.
  public mutating func release(epoch: UInt32, _ env: Env) -> [InputRecord] {
    if epoch &+ 1 > acceptedEpoch { acceptedEpoch = epoch &+ 1 }
    let ups = held.ups(throughEpoch: epoch)
    if !ups.isEmpty && !env.axTrusted() { return [.failed(epoch: epoch, seq: nil, why: "noax")] }
    for (k, s) in ups { _ = env.post(s); held.drop(k) }
    return [.released(epoch: epoch)]
  }

  /// D159 watchdog tick: ups for anything held 5 s with no further event for it.
  public mutating func watchdog(_ env: Env) -> [InputRecord] {
    let due = held.overdue(now: env.now())
    guard !due.isEmpty, env.axTrusted() else { return [] }
    var out: [InputRecord] = []
    for (k, s) in due {
      let e = held.held[k]!.epoch
      _ = env.post(s); held.drop(k)
      out.append(.watchdog(epoch: e, what: Self.name(k)))
    }
    return out
  }

  static func name(_ k: HeldKey) -> String {
    switch k { case let .button(b): return b == .left ? "left" : "right"; case let .modifier(c): return "mod\(c)" }
  }
}
