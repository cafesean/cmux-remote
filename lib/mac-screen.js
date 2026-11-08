'use strict';
// p41 D97 — "Mac screen": view AND control the whole Mac desktop from the phone/iPad.
//
// OFF BY DEFAULT, two independent per-Mac flags (env on the bridge):
//   SCREEN_VIEW=1     /cmux/screen/info + /cmux/screen/shot      (needs Screen Recording)
//   SCREEN_CONTROL=1  /cmux/screen/tap|scroll|type|key|mouse     (needs Accessibility)
// Unset -> 403 { error: 'screen_disabled', flag }.
//
// No native deps, nothing compiled: capture is the built-in `screencapture -x -t jpg` into a 0700
// temp dir (file 0600) recompressed by `sips` like the browser shot, then deleted. Input is JXA
// (`osascript -l JavaScript -`) with the ObjC bridge to CoreGraphics CGEventPost. The WHOLE script —
// including any typed text — goes in on STDIN, never argv (ps-visible), and is never logged.
//
// TCC (macOS privacy): grants are charged to the RESPONSIBLE process. osascript / screencapture
// spawned by the bridge inherit the bridge's responsibility, so the grant belongs to the binary the
// LaunchAgent runs (the `node` binary, or the bun-compiled hypermux binary) — not to osascript.
// Denied capture -> 403 screen_permission { need: 'screen_recording' }; untrusted input (checked with
// AXIsProcessTrusted before posting — CGEventPost drops events silently otherwise) -> 403
// screen_permission { need: 'accessibility' }. Both carry the exact System Settings path.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { createShotLimiter } = require('./shot-limiter');
const { createDialogReader, LIMITS: DLG } = require('./mac-dialogs');
const { createAxHelper } = require('./ax-helper');

// ---- limits (each one is a LIMITS.md row) ----
const SCREEN_FOCUS_CACHE_MS = 1000;         // D201: focused-field "is it a password field" answer reused this long (one AX helper run per window)
const SCREEN_SHOT_MIN_MS = Math.max(500, Number(process.env.SCREEN_SHOT_MIN_MS) || 500);   // floor never below 500
const SCREEN_SHOT_MAX_BYTES = Math.max(1, Number(process.env.SCREEN_SHOT_MAX_BYTES) || 2 * 1024 * 1024);
// p41 D109 (Sean 2026-11-06 'Resolution is very low'): 1600 px blurred a 3024 px Retina screen once zoomed.
// 3200 px keeps a 13-16" Retina at native size (Max: 3024 px q65 ~600 KB, under the 2 MB cap).
const SCREEN_SHOT_MAX_DIM = Math.max(800, Number(process.env.SCREEN_SHOT_MAX_DIM) || 3200);   // px, longest edge after sips downscale
const SCREEN_SHOT_JPEG_Q = String(Math.min(90, Math.max(30, Number(process.env.SCREEN_SHOT_JPEG_Q) || 65)));
const SCREEN_CAPTURE_TIMEOUT_MS = 8000;     // screencapture / sips each
// p41 D102: 5 s killed osascript while an Xcode archive loaded the Mac (load ~24: one run took 4.3 s
// just to reach TCC, then SIGKILL -> 502). 12 s rides out load; still under the server relay's 15 s.
const SCREEN_OSA_TIMEOUT_MS = Math.max(1000, Number(process.env.SCREEN_OSA_TIMEOUT_MS) || 12000);   // one osascript run (killed after)
const SCREEN_INPUT_MAX_PER_SEC = 20;        // input events (tap/scroll/type/key) per rolling second, all clients
const SCREEN_INPUT_QUEUE_MAX = 4;           // osascript runs waiting; more -> 429 busy
const SCREEN_SECURE_TYPE_MAX_CHARS = 100;   // D106: Secure Input types ~80 ms/key (faster drops keys) -> 100 keys fits the 12 s osascript limit
const SCREEN_TYPE_MAX_CHARS = 1000;         // one /screen/type
const SCREEN_SCROLL_MAX = 3000;             // |dy|,|dx| px per /screen/scroll
const SCREEN_MAX_DISPLAY = 8;               // ?display=1..8
// p41 D159 (Sean 2026-11-07 'it doesn't track your mouse ... no clicking and dragging'): /screen/mouse
// {type: move|down|drag|up}. Moves/drags have their OWN rolling-second cap (they do not eat the 20/s
// click/type budget) and coalesce latest-wins: while one move waits for osascript, a newer one replaces
// it (answer {coalesced:true}). A held button with no drag/up for SCREEN_MOUSE_HOLD_MAX_MS gets a
// safety mouseUp at its last point, so a dropped connection never leaves the Mac button stuck down.
const SCREEN_MOUSE_MOVE_MAX_PER_SEC = Math.min(60, Math.max(5, Number(process.env.SCREEN_MOUSE_MOVE_MAX_PER_SEC) || 30));   // move+drag osascript runs per rolling second, all clients (coalesced moves not counted)
const SCREEN_MOUSE_HOLD_MAX_MS = Math.max(200, Number(process.env.SCREEN_MOUSE_HOLD_MAX_MS) || 5000);   // idle ms after down/drag -> safety up
const SCREEN_SHOT_BUSY_RETRY_MS = 500;      // retryMs when another shot is already in flight
// p41 D101: tap/scroll/type/key {shot:true} answer with a fresh frame (D88 pattern) so the phone sees
// its click land without waiting out the poll. Own, shorter floor; a frame inside it WAITS (the last
// input of a burst must paint), each one re-arms the poll floor, and it never runs beside another shot.
// p41 D103: a sleeping display captures as pure black (Sean 2026-11-06 08:1x: 'Screen is black';
// system_profiler 'Display Asleep: Yes'). While frames are asked for, assert user activity
// (caffeinate -u) so the display wakes and stays on; after the viewer stops it sleeps as usual.
const SCREEN_WAKE_HOLD_S = 30;              // each caffeinate -u holds the display awake this long
const SCREEN_WAKE_EVERY_MS = 15000;         // re-assert at most this often while frames are asked for
const SCREEN_WAKE_SETTLE_MS = 1200;         // first frame after a (possible) wake waits for the display to light
const SCREEN_INPUT_SETTLE_MS = 120;         // let the Mac repaint after the event before capturing
const SCREEN_INPUT_SHOT_MIN_MS = Math.max(250, Number(process.env.SCREEN_INPUT_SHOT_MIN_MS) || 300);   // floor never below 250
const LIMITS = { SCREEN_FOCUS_CACHE_MS, SCREEN_SHOT_MIN_MS, SCREEN_SHOT_MAX_BYTES, SCREEN_SHOT_MAX_DIM, SCREEN_CAPTURE_TIMEOUT_MS,
  SCREEN_OSA_TIMEOUT_MS, SCREEN_INPUT_MAX_PER_SEC, SCREEN_INPUT_QUEUE_MAX, SCREEN_TYPE_MAX_CHARS, SCREEN_SECURE_TYPE_MAX_CHARS,
  SCREEN_SCROLL_MAX, SCREEN_MAX_DISPLAY, SCREEN_SHOT_BUSY_RETRY_MS, SCREEN_INPUT_SETTLE_MS, SCREEN_INPUT_SHOT_MIN_MS,
  SCREEN_WAKE_HOLD_S, SCREEN_WAKE_EVERY_MS, SCREEN_WAKE_SETTLE_MS, SCREEN_MOUSE_MOVE_MAX_PER_SEC, SCREEN_MOUSE_HOLD_MAX_MS };

const SETTINGS_PATH = {
  screen_recording: 'System Settings > Privacy & Security > Screen & System Audio Recording',
  accessibility: 'System Settings > Privacy & Security > Accessibility',
};

// ---- key allow-list: canonical "mod+mod+key" (mods sorted cmd,ctrl,opt,shift) ----
const KEYCODES = { return: 36, tab: 48, space: 49, delete: 51, esc: 53, forwarddelete: 117,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  a: 0, c: 8, v: 9, x: 7, z: 6, f: 3, t: 17, w: 13, n: 45, l: 37, r: 15, '`': 50 };
const MOD_FLAGS = { cmd: 0x100000, ctrl: 0x40000, opt: 0x80000, shift: 0x20000 };
const MOD_ORDER = ['cmd', 'ctrl', 'opt', 'shift'];
const PLAIN = ['return', 'tab', 'space', 'delete', 'esc', 'forwarddelete', 'left', 'right', 'up', 'down',
  'home', 'end', 'pageup', 'pagedown'];
// Deliberately absent: cmd+q (quits whatever is frontmost), cmd+opt+esc, ctrl+cmd+q (lock), any
// power/logout combo, arbitrary letters with cmd. Extend only by adding a literal here.
const KEY_ALLOW = new Set([
  ...PLAIN, ...PLAIN.map((k) => 'shift+' + k),
  'opt+left', 'opt+right', 'opt+delete', 'cmd+left', 'cmd+right', 'cmd+up', 'cmd+down', 'cmd+delete',
  'cmd+a', 'cmd+c', 'cmd+v', 'cmd+x', 'cmd+z', 'cmd+shift+z', 'cmd+f', 'cmd+t', 'cmd+w', 'cmd+n',
  'cmd+l', 'cmd+r', 'cmd+tab', 'cmd+shift+tab', 'cmd+space', 'cmd+`', 'ctrl+c', 'shift+tab',
]);
// -> { combo, code, flags } | null
function parseKey(key, mods) {
  const k = String(key || '').toLowerCase().trim();
  if (!Object.prototype.hasOwnProperty.call(KEYCODES, k)) return null;
  const ms = Array.isArray(mods) ? mods.map((m) => String(m).toLowerCase()) : [];
  if (ms.some((m) => !MOD_FLAGS[m])) return null;
  const uniq = MOD_ORDER.filter((m) => ms.includes(m));
  const combo = [...uniq, k].join('+');
  if (!KEY_ALLOW.has(combo)) return null;
  return { combo, code: KEYCODES[k], flags: uniq.reduce((f, m) => f | MOD_FLAGS[m], 0) };
}

const isLoopback = (h) => { const x = String(h).trim().toLowerCase().replace(/^\[|\]$/g, ''); return x === 'localhost' || x === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(x) || x === '::ffff:127.0.0.1'; };
const flagOn = (v) => v === '1' || v === 'true';
const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null; };
const clampInt = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : 0; };

// ---- JXA scripts (static; params are JSON literals appended by the caller, script goes on stdin) ----
// Display geometry in CG global points (top-left origin). NSScreen is bottom-left, so flip by the
// primary screen's height. Display n = NSScreen.screens[n-1]; screencapture -D uses the same order
// (main display first).
// D135: the read-only half (imports + screens()) is shared with lib/mac-dialogs.js, which never posts input.
const JXA_SCREENS = `ObjC.import('AppKit');ObjC.import('CoreGraphics');
function screens(){var s=$.NSScreen.screens,out=[],H=s.objectAtIndex(0).frame.size.height;for(var i=0;i<s.count;i++){var sc=s.objectAtIndex(i),f=sc.frame;out.push({index:i+1,x:f.origin.x,y:H-(f.origin.y+f.size.height),w:f.size.width,h:f.size.height,scale:sc.backingScaleFactor});}return out;}`;
const JXA_PRELUDE = `${JXA_SCREENS}ObjC.import('ApplicationServices');ObjC.import('Carbon');
function disp(n){var l=screens();return l[(n||1)-1]||null;}
function post(e){$.CGEventPost($.kCGHIDEventTap,e);}`;
const JXA_INFO = `${JXA_PRELUDE}
function run(){var cap=false;try{cap=!!$.CGPreflightScreenCaptureAccess();}catch(e){}return JSON.stringify({displays:screens(),canCapture:cap,canControl:!!$.AXIsProcessTrusted(),secureInput:!!$.IsSecureEventInputEnabled()});}`;
// P = { op, display, fx, fy, button, double, dx, dy, text, code, flags }
const JXA_INPUT = `${JXA_PRELUDE}
function mouse(P){var d=disp(P.display);if(!d)return'nodisplay';var pt={x:d.x+P.fx*d.w,y:d.y+P.fy*d.h};var r=P.button==='right';
var dn=r?$.kCGEventRightMouseDown:$.kCGEventLeftMouseDown,up=r?$.kCGEventRightMouseUp:$.kCGEventLeftMouseUp,b=r?$.kCGMouseButtonRight:$.kCGMouseButtonLeft;
post($.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,b));var n=P.double?2:1;for(var i=1;i<=n;i++){var e1=$.CGEventCreateMouseEvent(null,dn,pt,b);$.CGEventSetIntegerValueField(e1,$.kCGMouseEventClickState,i);post(e1);var e2=$.CGEventCreateMouseEvent(null,up,pt,b);$.CGEventSetIntegerValueField(e2,$.kCGMouseEventClickState,i);post(e2);}return'ok';}
function scroll(P){var d=disp(P.display);if(d&&P.fx!=null)post($.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,{x:d.x+P.fx*d.w,y:d.y+P.fy*d.h},$.kCGMouseButtonLeft));post($.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitPixel,2,-P.dy,-P.dx));return'ok';}
// p41 D106: a password field (Secure Input, e.g. the lock screen) reads the event's KEYCODE, and the old
// path sent every char as keycode 0 ('a') + a unicode string. Under Secure Input, ASCII goes as real
// US-layout keycodes (+shift); everything else (and every char outside Secure Input) as unicode.
var KC={a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,'1':18,'2':19,'3':20,'4':21,'6':22,'5':23,'=':24,'9':25,'7':26,'-':27,'8':28,'0':29,']':30,o:31,u:32,'[':33,i:34,p:35,l:37,j:38,"'":39,k:40,';':41,'\\\\':42,',':43,'/':44,n:45,m:46,'.':47,'\`':50,' ':49};
var SH={'!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0','_':'-','+':'=','{':'[','}':']','|':'\\\\',':':';','"':"'",'<':',','>':'.','?':'/','~':'\`'};
function kc(ch){if(KC.hasOwnProperty(ch))return{c:KC[ch],s:false};var l=ch.toLowerCase();if(l!==ch&&KC.hasOwnProperty(l))return{c:KC[l],s:true};if(SH.hasOwnProperty(ch))return{c:KC[SH[ch]],s:true};return null;}
function typeKeys(t){for(var i=0;i<t.length;i++){var k=kc(t[i]);if(!k){typeUni(t[i]);continue;}[true,false].forEach(function(d){var e=$.CGEventCreateKeyboardEvent(null,k.c,d);$.CGEventSetFlags(e,k.s?$.kCGEventFlagMaskShift:0);post(e);delay(0.02);});delay(0.06);}return'ok';}
function typeUni(t){for(var i=0;i<t.length;i+=16){var ch=t.slice(i,i+16),u=[];for(var j=0;j<ch.length;j++)u.push(ch.charCodeAt(j));['d','u'].forEach(function(s){var e=$.CGEventCreateKeyboardEvent(null,0,s==='d');$.CGEventKeyboardSetUnicodeString(e,u.length,u);post(e);});delay(0.005);}return'ok';}
function type(P){if(!$.IsSecureEventInputEnabled())return typeUni(P.text);if(P.text.length>${SCREEN_SECURE_TYPE_MAX_CHARS})return'toolong';return typeKeys(P.text);}
function key(P){var a=$.CGEventCreateKeyboardEvent(null,P.code,true);$.CGEventSetFlags(a,P.flags);post(a);var b=$.CGEventCreateKeyboardEvent(null,P.code,false);$.CGEventSetFlags(b,P.flags);post(b);return'ok';}
// p41 D159: one raw left-button event. kind -> CGEventType (numeric fallback if the bridge lacks the name):
// move=kCGEventMouseMoved(5) down=kCGEventLeftMouseDown(1) drag=kCGEventLeftMouseDragged(6) up=kCGEventLeftMouseUp(2).
function ptr(P){var d=disp(P.display);if(!d)return'nodisplay';var pt={x:d.x+P.fx*d.w,y:d.y+P.fy*d.h},b=$.kCGMouseButtonLeft;
var T={move:$.kCGEventMouseMoved||5,down:$.kCGEventLeftMouseDown||1,drag:$.kCGEventLeftMouseDragged||6,up:$.kCGEventLeftMouseUp||2}[P.kind];if(T==null)return'badop';
if(P.kind==='down')post($.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved||5,pt,b));
var e=$.CGEventCreateMouseEvent(null,T,pt,b);if(P.kind==='down'||P.kind==='up')$.CGEventSetIntegerValueField(e,$.kCGMouseEventClickState,1);post(e);return'ok';}
function run(){var P=PARAMS;if(!$.AXIsProcessTrusted())return'noax';if(P.op==='mouse')return ptr(P);if(P.op==='tap')return mouse(P);if(P.op==='scroll')return scroll(P);if(P.op==='type')return type(P);if(P.op==='key')return key(P);return'badop';}`;

function createMacScreen(opts = {}) {
  const env = opts.env || process.env;
  const childEnv = opts.childEnv || (() => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }));
  const now = opts.now || Date.now;
  const log = opts.log || ((m) => console.error(m));
  const OSA = env.SCREEN_OSASCRIPT_BIN || '/usr/bin/osascript';
  const CAP = env.SCREEN_SCREENCAPTURE_BIN || '/usr/sbin/screencapture';
  const SIPS = env.SCREEN_SIPS_BIN || '/usr/bin/sips';
  const CAFF = env.SCREEN_CAFFEINATE_BIN || '/usr/bin/caffeinate';
  // A bridge with no BRIDGE_SECRET listening on a non-loopback TCP host is open to the LAN: never
  // serve the desktop there, whatever the flags say. A UNIX socket (opts.socket) opens no TCP port.
  const insecure = !opts.secret && !opts.socket && !isLoopback(opts.host == null ? '127.0.0.1' : opts.host);
  const wanted = flagOn(env.SCREEN_VIEW) || flagOn(env.SCREEN_CONTROL);
  const view = !insecure && flagOn(env.SCREEN_VIEW);
  const control = !insecure && flagOn(env.SCREEN_CONTROL);
  if (insecure && wanted) (opts.log || console.log)(`WARNING: SCREEN_VIEW/SCREEN_CONTROL forced OFF — BRIDGE_SECRET is empty and BRIDGE_HOST ${opts.host} is not loopback. Set BRIDGE_SECRET to enable Mac screen.`);
  const shotLimiter = createShotLimiter({ minMs: SCREEN_SHOT_MIN_MS, now });
  const inputShotLimiter = createShotLimiter({ minMs: SCREEN_INPUT_SHOT_MIN_MS, now });
  let shotInFlight = false;
  // p41 D189: ground truth for the Remote Desktop setup probe — when a real capture / a trusted input last worked.
  const observedAt = { capture: 0, input: 0 };
  let lastCapture = null;   // null until a real shot has run   // ONE capture at a time across all displays (each is a screencapture + sips)
  const inputTimes = [];
  let lastWake = 0;
  // p41 D103: -> ms to wait before capturing (0 = display already held awake by us).
  function wakeDisplay() {
    const t = now();
    if (t - lastWake < SCREEN_WAKE_EVERY_MS) return 0;
    const fresh = t - lastWake > SCREEN_WAKE_HOLD_S * 1000;   // our hold lapsed: the display may be asleep
    lastWake = t;
    try {
      const c = spawn(CAFF, ['-u', '-t', String(SCREEN_WAKE_HOLD_S)], { env: childEnv(), stdio: 'ignore', detached: true });
      c.on('error', () => {}); c.unref();
    } catch (_) { return 0; }
    return fresh ? SCREEN_WAKE_SETTLE_MS : 0;
  }
  let osaTail = Promise.resolve();
  let osaWaiting = 0;

  // One osascript at a time; script on stdin. -> Promise<{ ok, out } | { ok:false, err }>
  function osa(script) {
    if (osaWaiting >= SCREEN_INPUT_QUEUE_MAX) return Promise.resolve({ ok: false, err: 'busy' });
    osaWaiting++;
    const run = osaTail.then(() => new Promise((resolve) => {
      let out = '', done = false, timedOut = false;
      const t0 = now();
      // p41 D102: every failure gets one log line (cause, exit code/signal, ms) — never the script or stderr.
      const fin = (r) => {
        if (done) return; done = true; clearTimeout(t);
        if (r.ok && r.out === 'ok') observedAt.input = now();   // D189: input scripts answer 'ok' only after AXIsProcessTrusted passed
        if (!r.ok) log(`mac-screen: osascript ${r.err}${r.detail ? ' ' + r.detail : ''} after ${now() - t0} ms (timeout ${SCREEN_OSA_TIMEOUT_MS} ms)`);
        resolve(r);
      };
      let c, t = null;
      try { c = spawn(OSA, ['-l', 'JavaScript', '-'], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { return fin({ ok: false, err: 'spawn', detail: String((e && e.code) || 'throw') }); }
      t = setTimeout(() => { timedOut = true; try { c.kill('SIGKILL'); } catch (_) {} }, SCREEN_OSA_TIMEOUT_MS);
      c.stdout.on('data', (d) => { if (out.length < 64 * 1024) out += d; });
      c.stderr.on('data', () => {});   // may echo the script on a syntax error: never kept, never logged
      c.on('error', (e) => fin({ ok: false, err: 'spawn', detail: String((e && e.code) || 'error') }));
      c.on('close', (code, sig) => fin(code === 0 ? { ok: true, out: out.trim() }
        : { ok: false, err: timedOut ? 'timeout' : 'exit', detail: sig ? `signal=${sig}` : `code=${code}` }));
      c.stdin.on('error', () => {});
      c.stdin.end(typeof script === 'function' ? script() : script);   // D159: a coalesced move builds its script at start
    }));
    osaTail = run.then(() => {}, () => {});
    return run.finally(() => { osaWaiting--; });
  }

  function inputRate() {
    const t = now();
    while (inputTimes.length && t - inputTimes[0] >= 1000) inputTimes.shift();
    if (inputTimes.length >= SCREEN_INPUT_MAX_PER_SEC) return { ok: false, retryMs: 1000 - (t - inputTimes[0]) };
    inputTimes.push(t);
    return { ok: true };
  }

  // ---- p41 D159 mouse move / press / drag / release ----
  const moveTimes = [];
  function moveRate() {
    const t = now();
    while (moveTimes.length && t - moveTimes[0] >= 1000) moveTimes.shift();
    if (moveTimes.length >= SCREEN_MOUSE_MOVE_MAX_PER_SEC) return { ok: false, retryMs: 1000 - (t - moveTimes[0]) };
    moveTimes.push(t);
    return { ok: true };
  }
  let held = null;          // { display, fx, fy } while the left button is down
  let holdTimer = null;
  let moveSlot = null;      // { P } : a queued (not yet started) move/drag; newer moves overwrite P
  const ptrScript = (P) => `${JXA_INPUT}\nvar PARAMS=${JSON.stringify(P)};`;
  function armHold() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (!held) return;
      const P = { op: 'mouse', kind: 'up', display: held.display, fx: held.fx, fy: held.fy };
      held = null;
      log(`mac-screen: mouse safety up after ${SCREEN_MOUSE_HOLD_MAX_MS} ms without drag/up`);
      osa(ptrScript(P)).catch(() => {});
    }, SCREEN_MOUSE_HOLD_MAX_MS);
    if (holdTimer.unref) holdTimer.unref();
  }
  const ptrResult = (r) => {
    if (!r.ok) return r.err === 'busy' ? { status: 429, body: { error: 'busy', retryMs: 200 } } : { status: 502, body: { error: 'screen_failed', cause: r.err } };
    if (r.out === 'noax') return denied('accessibility');
    if (r.out === 'nodisplay') return { status: 400, body: { error: 'bad_display' } };
    if (r.out !== 'ok') return { status: 502, body: { error: 'screen_failed' } };
    return { status: 200, body: { ok: true } };
  };
  async function mouse(b) {
    if (!control) return disabled('SCREEN_CONTROL');
    if (!b || !['move', 'down', 'drag', 'up'].includes(b.type)) return { status: 400, body: { error: 'bad_type' } };
    let display = 1;
    if (b.display != null) {
      display = Number(b.display);
      if (!Number.isInteger(display) || display < 1 || display > SCREEN_MAX_DISPLAY) return { status: 400, body: { error: 'bad_display' } };
    }
    const fx = clamp01(b.fx), fy = clamp01(b.fy);
    if (fx == null || fy == null) return { status: 400, body: { error: 'bad_coords' } };
    let kind = b.type;
    if (kind === 'drag' && !held) return { status: 409, body: { error: 'not_down' } };
    if (kind === 'move' && held) kind = 'drag';   // pointer moving with the button down IS a drag
    const P = { op: 'mouse', kind, display, fx, fy };
    if (kind === 'move' || kind === 'drag') {
      if (held) { held = { display, fx, fy }; armHold(); }
      if (moveSlot && moveSlot.P.kind === kind) { moveSlot.P = P; return { status: 200, body: { ok: true, coalesced: true } }; }
      const rate = moveRate();
      if (!rate.ok) return { status: 429, body: { error: 'rate_limited', retryMs: rate.retryMs } };
      const slot = { P };
      moveSlot = slot;
      const r = await osa(() => { if (moveSlot === slot) moveSlot = null; return ptrScript(slot.P); });
      if (moveSlot === slot) moveSlot = null;   // never started (busy)
      return ptrResult(r);
    }
    moveSlot = null;   // a press/release seals the queued move: later moves queue AFTER it, in order
    if (kind === 'down') {
      const rate = inputRate();
      if (!rate.ok) return { status: 429, body: { error: 'rate_limited', retryMs: rate.retryMs } };
      held = { display, fx, fy }; armHold();
      const r = await osa(ptrScript(P));
      if (!r.ok || r.out !== 'ok') { held = null; if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
      return ptrResult(r);
    }
    // up: always posted (frees a stuck button even without our down); never rate-limited away
    held = null;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    const r = await osa(ptrScript(P));
    const out = ptrResult(r);
    if (out.status !== 200 || b.shot !== true || !view) return out;
    return { status: 200, body: { ok: true, ...(await inputFrame(display)) } };
  }

  const disabled = (flag) => ({ status: 403, body: { error: 'screen_disabled', flag,
    message: `Mac screen ${flag === 'SCREEN_VIEW' ? 'viewing' : 'control'} is off on this Mac. Set ${flag}=1 for the HyprMux server and restart it.` } });
  const denied = (need) => ({ status: 403, body: { error: 'screen_permission', need, settingsPath: SETTINGS_PATH[need],
    message: `Allow ${need === 'accessibility' ? 'Accessibility' : 'Screen Recording'} for the HyprMux server in ${SETTINGS_PATH[need]}, then restart the server.` } });

  async function info() {
    if (!view) return disabled('SCREEN_VIEW');
    const r = await osa(JXA_INFO);
    if (!r.ok) return r.err === 'busy' ? { status: 429, body: { error: 'busy', retryMs: 500 } } : { status: 502, body: { error: 'screen_failed', cause: r.err } };
    let j = null; try { j = JSON.parse(r.out); } catch (_) {}
    if (!j || !Array.isArray(j.displays)) return { status: 502, body: { error: 'screen_failed' } };
    return { status: 200, body: { ok: true, view, control, displays: j.displays, canCapture: lastCapture === null ? !!j.canCapture : lastCapture,
      canControl: !!j.canControl, secureInput: !!j.secureInput, focusSecure: await focusSecure(), settingsPath: SETTINGS_PATH } };
  }

  // p41 D101: one frame right after an input -> { mime, image } | {} (never rejects; {} = poll as usual).
  async function inputFrame(display) {
    const wait = inputShotLimiter.reserve('d' + display) + SCREEN_INPUT_SETTLE_MS;
    await new Promise((r) => setTimeout(r, wait));
    if (shotInFlight) return {};   // a shot is already running; the client polls next
    shotInFlight = true;
    shotLimiter.mark('d' + display);
    try {
      const r = await shotNow(display);
      if (r.status === 200) { lastCapture = true; return { mime: r.body.mime, image: r.body.image, focusSecure: await focusSecure() }; }
      if (r.body && r.body.error === 'screen_permission') lastCapture = false;
      return {};
    } catch (_) { return {}; } finally { shotInFlight = false; }
  }

  async function shot(displayParam) {
    if (!view) return disabled('SCREEN_VIEW');
    let display = 1;
    if (displayParam != null && displayParam !== '') {
      display = Number(displayParam);
      if (!Number.isInteger(display) || display < 1 || display > SCREEN_MAX_DISPLAY) return { status: 400, body: { error: 'bad_display' } };
    }
    if (shotInFlight) return { status: 429, body: { error: 'busy', retryMs: SCREEN_SHOT_BUSY_RETRY_MS } };
    const gate = shotLimiter.take('d' + display);
    if (!gate.ok) return { status: 429, body: { error: 'rate_limited', retryMs: gate.retryMs } };
    shotInFlight = true;
    try {
      const settle = wakeDisplay();
      if (settle) await new Promise((res) => setTimeout(res, settle));
      const [r, fs2] = await Promise.all([shotNow(display), focusSecure()]);
      if (r.status === 200) r.body.focusSecure = fs2;   // D201
      // canCapture truth = the last real capture (the JXA preflight checks osascript, not the node that captures).
      if (r.status === 200) lastCapture = true;
      else if (r.body && r.body.error === 'screen_permission') lastCapture = false;
      return r;
    } finally { shotInFlight = false; }
  }

  async function shotNow(display) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hm-screen-'));   // 0700
    const raw = path.join(dir, 'raw.jpg'), out = path.join(dir, 'out.jpg');
    try {
      fs.closeSync(fs.openSync(raw, 'w', 0o600));   // screencapture writes into an existing 0600 file
      const cap = await new Promise((resolve) => execFile(CAP, ['-x', '-C', '-t', 'jpg', '-D', String(display), raw],   // -C: draw the mouse cursor (D101)
        { timeout: SCREEN_CAPTURE_TIMEOUT_MS, env: childEnv() }, (err, _o, stderr) => resolve({ err, stderr: String(stderr || '') })));
      let size = 0; try { size = fs.statSync(raw).size; } catch (_) {}
      if (cap.err || !size) {
        if (/not permitted|permission|screen recording|could not create image|not authorized|privacy/i.test(cap.stderr) || (!cap.err && !size)) return denied('screen_recording');
        if (/invalid display|display/i.test(cap.stderr)) return { status: 400, body: { error: 'bad_display' } };
        return { status: 502, body: { error: 'screen_failed' } };
      }
      const se = await new Promise((resolve) => execFile(SIPS, ['-Z', String(SCREEN_SHOT_MAX_DIM), '-s', 'format', 'jpeg',
        '-s', 'formatOptions', SCREEN_SHOT_JPEG_Q, raw, '--out', out], { timeout: SCREEN_CAPTURE_TIMEOUT_MS, env: childEnv() }, (e) => resolve(e)));
      let buf; try { buf = await fsp.readFile(se ? raw : out); } catch (_) { return { status: 502, body: { error: 'screen_failed' } }; }
      if (buf.length > SCREEN_SHOT_MAX_BYTES) return { status: 413, body: { error: 'too_large', limit: SCREEN_SHOT_MAX_BYTES } };
      observedAt.capture = now();   // D189
      return { status: 200, body: { ok: true, display, mime: 'image/jpeg', image: buf.toString('base64') } };
    } finally {
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function input(op, b) {
    if (!control) return disabled('SCREEN_CONTROL');
    const P = { op, display: 1 };
    if (b.display != null) {
      const d = Number(b.display);
      if (!Number.isInteger(d) || d < 1 || d > SCREEN_MAX_DISPLAY) return { status: 400, body: { error: 'bad_display' } };
      P.display = d;
    }
    if (op === 'tap') {
      P.fx = clamp01(b.fx); P.fy = clamp01(b.fy);
      if (P.fx == null || P.fy == null) return { status: 400, body: { error: 'bad_coords' } };
      if (b.button != null && b.button !== 'left' && b.button !== 'right') return { status: 400, body: { error: 'bad_button' } };
      P.button = b.button === 'right' ? 'right' : 'left';
      P.double = b.double === true;
    } else if (op === 'scroll') {
      P.dy = clampInt(b.dy, SCREEN_SCROLL_MAX); P.dx = clampInt(b.dx, SCREEN_SCROLL_MAX);
      if (!P.dy && !P.dx) return { status: 400, body: { error: 'no_delta' } };
      if (b.fx != null || b.fy != null) {
        P.fx = clamp01(b.fx); P.fy = clamp01(b.fy);
        if (P.fx == null || P.fy == null) return { status: 400, body: { error: 'bad_coords' } };
      }
    } else if (op === 'type') {
      if (typeof b.text !== 'string' || !b.text.length) return { status: 400, body: { error: 'no_text' } };
      if (b.text.length > SCREEN_TYPE_MAX_CHARS) return { status: 413, body: { error: 'too_long', limit: SCREEN_TYPE_MAX_CHARS } };
      P.text = b.text;
    } else if (op === 'key') {
      const k = parseKey(b.key, b.mods);
      if (!k) return { status: 400, body: { error: 'bad_key' } };
      P.code = k.code; P.flags = k.flags; P.combo = k.combo;
    } else return { status: 404, body: { error: 'not_found' } };
    const rate = inputRate();
    if (!rate.ok) return { status: 429, body: { error: 'rate_limited', retryMs: rate.retryMs } };
    const r = await osa(`${JXA_INPUT}\nvar PARAMS=${JSON.stringify(P)};`);
    if (!r.ok) return r.err === 'busy' ? { status: 429, body: { error: 'busy', retryMs: 500 } } : { status: 502, body: { error: 'screen_failed', cause: r.err } };
    if (r.out === 'noax') return denied('accessibility');
    if (r.out === 'nodisplay') return { status: 400, body: { error: 'bad_display' } };
    if (r.out === 'toolong') return { status: 413, body: { error: 'too_long', limit: SCREEN_SECURE_TYPE_MAX_CHARS, secureInput: true } };
    if (r.out !== 'ok') return { status: 502, body: { error: 'screen_failed' } };
    if (op === 'tap' || op === 'key') focusCache = null;   // D201: focus may have moved (click / Tab)
    if (b.shot !== true || !view) return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, ...(await inputFrame(P.display)) } };
  }

  // p41 D135: system dialogs on screen (owner + bounds only; detect + alert, never clicks). SCREEN_VIEW-gated.
  // D136: with SCREEN_CONTROL on, each read also walks the dialog's AX tree (buttons/text/fields).
  const axHelper = opts.axHelper || createAxHelper({ env, childEnv, log });
  // p41 D201: is the Mac's focused UI element a password field (AXSecureTextField role/subrole)? Read-only AX
  // query (role/subrole only, never the value). -> true | false | null (unknown: SCREEN_CONTROL off / not
  // trusted / helper error). Cached SCREEN_FOCUS_CACHE_MS; concurrent callers share one helper run.
  let focusCache = null, focusRun = null;
  function focusSecure() {
    if (!control) return Promise.resolve(null);
    if (focusCache && now() - focusCache.at < SCREEN_FOCUS_CACHE_MS) return Promise.resolve(focusCache.v);
    if (focusRun) return focusRun;
    // D206: never wait on the helper's first swiftc build (~20 s, far longer on a loaded Mac): answer null
    // (unknown) now, uncached, and let ready() build it in the background; a later frame reads it.
    if (typeof axHelper.ready === 'function' && !axHelper.ready()) return Promise.resolve(null);
    focusRun = axHelper.run({ op: 'focused' }).then((r) => (r && typeof r.secure === 'boolean' ? r.secure : null), () => null)
      .then((v) => { focusCache = { at: now(), v }; focusRun = null; return v; });
    return focusRun;
  }
  const dialogReader = createDialogReader({ osa, prelude: JXA_SCREENS, now,
    axRead: control ? async (items) => { const r = await axHelper.run({ op: 'read', items }); return Array.isArray(r.results) ? r.results : r; } : null,
    ocrRead: control ? async (items) => { const r = await axHelper.run({ op: 'ocr', items }); return Array.isArray(r.results) ? r.results : r; } : null });
  async function dialogs() {
    if (!view) return disabled('SCREEN_VIEW');
    return dialogReader.read();
  }

  // p41 D136: answer a dialog from the phone. SCREEN_CONTROL-gated; the dialog is re-read (no cache) so a
  // press never lands on a dialog that already closed. Press = AXPress on the button the AX walk finds by
  // exact title in the window matching the dialog's bounds; AXPress refused -> CGEvent click at its centre.
  // Type = focus the first secure (else plain) field via AX, then the D104/D106 type path. Text rides
  // osascript STDIN only and is never logged; the log line says 'typed N chars'.
  const osaFail = (r) => (r.err === 'busy' ? { status: 429, body: { error: 'busy', retryMs: 500 } } : { status: 502, body: { error: 'screen_failed', cause: r.err } });
  async function liveDialog(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return { res: { status: 400, body: { error: 'bad_id' } } };
    const r = await dialogReader.read(true);
    if (r.status !== 200) return { res: r };
    const d = r.body.dialogs.find((x) => x.id === id);
    if (!d) return { res: { status: 409, body: { error: 'dialog_gone' } } };
    return { d };
  }
  async function dialogPress(b) {
    if (!control) return disabled('SCREEN_CONTROL');
    if (!b || typeof b.button !== 'string' || !b.button || b.button.length > DLG.AX_TITLE_MAX_CHARS) return { status: 400, body: { error: 'bad_button' } };
    const L = await liveDialog(b.id);
    if (L.res) return L.res;
    const d = L.d;
    const btn = (d.buttons || []).find((x) => x.title === b.button);
    // OCR dialog: the fresh read just re-OCR'd it, so a missing title means the dialog changed under us.
    if (!btn && d.ocr) return { status: 409, body: { error: 'dialog_changed' } };
    if (!btn) return { status: 404, body: { error: 'no_button', ...(d.axError ? { axError: d.axError } : {}) } };
    const rate = inputRate();
    if (!rate.ok) return { status: 429, body: { error: 'rate_limited', retryMs: rate.retryMs } };
    if (btn.ocr) return clickButton(d, btn, b.button);
    const frame = { x: d.win.x, y: d.win.y, w: d.win.w, h: d.win.h };
    const r = await axHelper.run({ op: 'press', pid: d.win.pid, frame, title: b.button });
    if (r.error === 'not_trusted') return denied('accessibility');
    if (r.error === 'no_window' || r.error === 'no_windows') return { status: 409, body: { error: 'dialog_gone' } };
    if (r.error === 'no_button') return { status: 404, body: { error: 'no_button' } };
    if (r.ok !== true) {
      if (r.error !== 'press_failed' || !btn.rect) return { status: 502, body: { error: 'screen_failed', cause: r.error } };
      return clickButton(d, btn, b.button);   // AXPress refused
    }
    log(`mac-screen: dialog press id=${d.id} owner=${d.owner} button=${JSON.stringify(b.button)} method=ax`);
    observedAt.input = now();   // D189: the AX helper pressed (it re-checks AXIsProcessTrusted)
    return { status: 200, body: { ok: true, method: 'ax' } };
  }
  // CGEvent click at the button's centre through the D97 mouse path.
  async function clickButton(d, btn, title) {
    const P = { op: 'tap', display: d.display, fx: btn.rect.fx + btn.rect.fw / 2, fy: btn.rect.fy + btn.rect.fh / 2, button: 'left', double: false };
    const c = await osa(`${JXA_INPUT}\nvar PARAMS=${JSON.stringify(P)};`);
    if (!c.ok) return osaFail(c);
    if (c.out === 'noax') return denied('accessibility');
    if (c.out !== 'ok') return { status: 502, body: { error: 'screen_failed' } };
    log(`mac-screen: dialog press id=${d.id} owner=${d.owner} button=${JSON.stringify(title)} method=click${btn.ocr ? ' (ocr)' : ''}`);
    return { status: 200, body: { ok: true, method: 'click' } };
  }
  async function dialogType(b) {
    if (!control) return disabled('SCREEN_CONTROL');
    if (!b || typeof b.text !== 'string' || !b.text.length) return { status: 400, body: { error: 'no_text' } };
    if (b.text.length > DLG.DIALOG_TYPE_MAX_CHARS) return { status: 413, body: { error: 'too_long', limit: DLG.DIALOG_TYPE_MAX_CHARS } };
    const L = await liveDialog(b.id);
    if (L.res) return L.res;
    const d = L.d;
    if (!d.password && !(d.fields > 0)) return { status: 404, body: { error: 'no_field', ...(d.axError ? { axError: d.axError } : {}) } };
    const rate = inputRate();
    if (!rate.ok) return { status: 429, body: { error: 'rate_limited', retryMs: rate.retryMs } };
    const f = await axHelper.run({ op: 'focus', pid: d.win.pid, frame: { x: d.win.x, y: d.win.y, w: d.win.w, h: d.win.h }, kind: d.password ? 'secure' : 'text' });
    if (f.error === 'not_trusted') return denied('accessibility');
    if (f.error === 'no_window' || f.error === 'no_windows') return { status: 409, body: { error: 'dialog_gone' } };
    if (f.error === 'no_field') return { status: 404, body: { error: 'no_field' } };
    if (f.ok !== true) return { status: 502, body: { error: 'screen_failed', cause: f.error } };
    // JXA_INPUT's type()/key() (D104/D106, Secure Input aware); this later run() wins (last declaration counts).
    const r = await osa(`${JXA_INPUT}
function run(){if(!$.AXIsProcessTrusted())return'noax';var P=PARAMS;delay(0.15);var t=type(P);if(t!=='ok')return t;if(P.submit){delay(0.05);key({code:36,flags:0});}return'ok';}
var PARAMS=${JSON.stringify({ text: b.text, submit: b.submit === true })};`);
    if (!r.ok) return osaFail(r);
    if (r.out === 'noax') return denied('accessibility');
    if (r.out === 'toolong') return { status: 413, body: { error: 'too_long', limit: SCREEN_SECURE_TYPE_MAX_CHARS, secureInput: true } };
    if (r.out !== 'ok') return { status: 502, body: { error: 'screen_failed' } };
    log(`mac-screen: dialog type id=${d.id} owner=${d.owner} typed ${b.text.length} chars${b.submit === true ? ' +enter' : ''}`);
    return { status: 200, body: { ok: true } };
  }

  return { info, shot, input, mouse, dialogs, dialogPress, dialogType, flags: { view, control }, observed: () => ({ ...observedAt }) };
}

module.exports = { createMacScreen, isLoopback, parseKey, KEY_ALLOW, LIMITS, SETTINGS_PATH, JXA_INPUT, JXA_INFO, JXA_PRELUDE, JXA_SCREENS };
