// hm-key-tap — HMX k110 step 2. Spawned by the Bridge runtime only while a local HyprMux viewer asks for key capture
// (POST /api/keys/capture, heartbeat; the runtime kills it 3 s after the last one, on off, and on exit).
// While it runs, a session event tap swallows exactly ⌘Tab, ⌘⇧Tab, ⌘Space, ⌘`, ⌘⇧` (KeyCombo.match) and writes one JSON
// line per combo to stdout: {"kind":"combo","combo":"cmd+tab"}. Everything else passes untouched. Events the HyprMux
// screen helper posted (KeyCombo.postedMarker) always pass, so Remote Desktop to this same Mac cannot loop.
// stdout first line: {"kind":"ready"}, or {"kind":"error","need":"accessibility"} and exit 2 (no tap without the grant).
// stdin EOF (the runtime went away) = exit, so the keyboard is never left captured.
import Foundation
import CoreGraphics
import ApplicationServices
import ScreenStreamCore

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ o: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) { print(s) }
}

guard AXIsProcessTrusted() else { emit(["kind": "error", "need": "accessibility"]); exit(2) }

var swallowedDown = Set<UInt16>()   // keycodes whose key-down we swallowed: their key-up is swallowed too
var tapRef: CFMachPort?

let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  if event.getIntegerValueField(.eventSourceUserData) == KeyCombo.postedMarker { return Unmanaged.passUnretained(event) }
  let code = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
  if type == .keyUp {
    if swallowedDown.remove(code) != nil { return nil }
    return Unmanaged.passUnretained(event)
  }
  guard type == .keyDown, let combo = KeyCombo.match(keycode: code, flags: event.flags.rawValue) else {
    return Unmanaged.passUnretained(event)
  }
  swallowedDown.insert(code)
  if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { emit(["kind": "combo", "combo": combo]) }
  return nil
}

guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                  eventsOfInterest: mask, callback: callback, userInfo: nil) else {
  emit(["kind": "error", "need": "accessibility"]); exit(2)
}
tapRef = tap
let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit(["kind": "ready"])

// The runtime closes our stdin when it stops capture or dies: leave at once.
DispatchQueue.global().async {
  while readLine() != nil {}
  exit(0)
}
signal(SIGTERM) { _ in exit(0) }
CFRunLoopRun()
