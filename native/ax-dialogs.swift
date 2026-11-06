// p41 D136 — Accessibility helper for Mac dialogs. Source only: the bridge compiles it once per source hash
// into ~/Library/Caches/cmux-remote/ and spawns it, so TCC responsibility stays with the bridge's node.
// One JSON request on stdin, one JSON answer on stdout. Never reads or prints typed text (it types nothing).
//   {op:'read',  pid, frame}            -> {buttons:[{title,frame,default}], text, password, fields}
//   {op:'read',  items:[{pid,frame}]}   -> {results:[<read answer | {error}>]}   (one spawn per poll)
//   {op:'press', pid, frame, title}     -> {ok:true} | {error}
//   {op:'focus', pid, frame, kind}      -> {ok:true} | {error}      kind 'secure' | 'text'
//   {op:'windows', pid}                 -> {axError, windows:[{role,subrole,frame}]}   (diagnosis)
// error: not_trusted | no_windows | no_window | no_button | no_field | press_failed | bad_request
import ApplicationServices
import Foundation

let FRAME_TOL: CGFloat = 3, MAX_DEPTH = 10, MAX_NODES = 400, MAX_BUTTONS = 12, TEXT_MAX = 500, TITLE_MAX = 80

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String {
  guard let v = attr(el, name) else { return "" }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}
func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
        CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return CGRect(origin: pt, size: sz)
}
func title(_ el: AXUIElement) -> String {
  var t = str(el, kAXTitleAttribute); if t.isEmpty { t = str(el, kAXDescriptionAttribute) }
  return String(t.prefix(TITLE_MAX))
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func fj(_ r: CGRect) -> [String: Double] { ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.width), "h": Double(r.height)] }

func window(_ req: [String: Any]) -> (AXUIElement?, String?) {
  guard let pid = (req["pid"] as? NSNumber)?.int32Value, let f = req["frame"] as? [String: Any],
        let x = (f["x"] as? NSNumber)?.doubleValue, let y = (f["y"] as? NSNumber)?.doubleValue,
        let w = (f["w"] as? NSNumber)?.doubleValue, let h = (f["h"] as? NSNumber)?.doubleValue else { return (nil, "bad_request") }
  let app = AXUIElementCreateApplication(pid)
  guard let ws = attr(app, kAXWindowsAttribute) as? [AXUIElement], !ws.isEmpty else { return (nil, "no_windows") }
  for win in ws {
    guard let r = frame(win) else { continue }
    if abs(r.origin.x - x) <= FRAME_TOL && abs(r.origin.y - y) <= FRAME_TOL && abs(r.width - w) <= FRAME_TOL && abs(r.height - h) <= FRAME_TOL { return (win, nil) }
  }
  // Agent alerts (UserNotificationCenter, universalAccessAuthWarn) list AXWindows with role AXApplication and
  // no frame. Fallback: hit-test the dialog's centre, keep the hit only if it belongs to this pid, climb to its window.
  let sys = AXUIElementCreateSystemWide()
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(sys, Float(x + w / 2), Float(y + h / 2), &hit) == .success, var el = hit {
    var hp: pid_t = 0
    if AXUIElementGetPid(el, &hp) == .success && hp == pid {
      var top = el
      for _ in 0..<MAX_DEPTH {
        let r = str(el, kAXRoleAttribute)
        if r == kAXWindowRole || r == "AXSheet" { return (el, nil) }
        if r == kAXApplicationRole { break }
        top = el
        guard let p = attr(el, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() else { break }
        el = p as! AXUIElement
      }
      return (top, nil)   // topmost non-application ancestor of the hit
    }
  }
  return (nil, "no_window")
}
// BFS below the window; visit returns false to stop.
func walk(_ win: AXUIElement, _ visit: (AXUIElement, String) -> Bool) {
  var q: [(AXUIElement, Int)] = [(win, 0)], i = 0
  while i < q.count && i < MAX_NODES {
    let (el, d) = q[i]; i += 1
    if d > 0 && !visit(el, str(el, kAXRoleAttribute)) { return }
    if d < MAX_DEPTH { for c in children(el) { q.append((c, d + 1)) } }
  }
}
func read(_ req: [String: Any]) -> [String: Any] {
  let (w, err) = window(req); guard let win = w else { return ["error": err!] }
  var buttons: [[String: Any]] = [], texts: [String] = [], tl = 0, password = false, fields = 0
  var defFrame: CGRect? = nil
  if let d = attr(win, kAXDefaultButtonAttribute), CFGetTypeID(d) == AXUIElementGetTypeID() { defFrame = frame(d as! AXUIElement) }
  walk(win) { el, role in
    switch role {
    case kAXButtonRole:
      let t = title(el)
      if !t.isEmpty, buttons.count < MAX_BUTTONS, let r = frame(el) { buttons.append(["title": t, "frame": fj(r), "default": defFrame.map { $0 == r } ?? false]) }
    case kAXStaticTextRole:
      let v = str(el, kAXValueAttribute); if !v.isEmpty && tl < TEXT_MAX { texts.append(v); tl += v.count + 1 }
    case "AXSecureTextField": password = true
    case kAXTextFieldRole: fields += 1
    default: break
    }
    return true
  }
  return ["buttons": buttons, "text": String(texts.joined(separator: " ").prefix(TEXT_MAX)), "password": password, "fields": fields]
}
func press(_ req: [String: Any]) -> [String: Any] {
  guard let want = req["title"] as? String, !want.isEmpty else { return ["error": "bad_request"] }
  let (w, err) = window(req); guard let win = w else { return ["error": err!] }
  var hit: AXUIElement? = nil
  walk(win) { el, role in if role == kAXButtonRole && title(el) == want { hit = el; return false }; return true }
  guard let b = hit else { return ["error": "no_button"] }
  return AXUIElementPerformAction(b, kAXPressAction as CFString) == .success ? ["ok": true] : ["error": "press_failed"]
}
func focus(_ req: [String: Any]) -> [String: Any] {
  let (w, err) = window(req); guard let win = w else { return ["error": err!] }
  var sec: AXUIElement? = nil, txt: AXUIElement? = nil
  walk(win) { el, role in
    if role == "AXSecureTextField" { sec = el; return false }
    if role == kAXTextFieldRole && txt == nil { txt = el }
    return true
  }
  let want = (req["kind"] as? String) == "text" ? (txt ?? sec) : (sec ?? txt)
  guard let f = want else { return ["error": "no_field"] }
  _ = AXUIElementSetAttributeValue(f, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  return ["ok": true]
}

func answer(_ o: Any) {
  let d = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{\"error\":\"encode\"}".utf8)
  FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data("\n".utf8))
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 64 * 1024, let req = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else { answer(["error": "bad_request"]); exit(0) }
guard AXIsProcessTrusted() else { answer(["error": "not_trusted"]); exit(0) }
switch req["op"] as? String {
case "read":
  if let items = req["items"] as? [[String: Any]] { answer(["results": items.prefix(20).map { read($0) }]) } else { answer(read(req)) }
case "press": answer(press(req))
case "focus": answer(focus(req))
case "windows":   // diagnosis: AX window frames of one pid (no text)
  let app = AXUIElementCreateApplication((req["pid"] as? NSNumber)?.int32Value ?? 0)
  var v: CFTypeRef?; let e = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v)
  answer(["axError": e.rawValue, "windows": ((v as? [AXUIElement]) ?? []).map { w in ["role": str(w, kAXRoleAttribute), "subrole": str(w, kAXSubroleAttribute), "frame": frame(w).map(fj) ?? [:]] as [String: Any] }])
default: answer(["error": "bad_request"])
}
