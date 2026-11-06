'use strict';
// p41 D135 — "Mac dialogs": notice the system dialogs that pop up on the Mac (a macOS permission request,
// a password prompt, Chrome's 'Allow remote debugging?') and tell the phone, which then opens the D97
// Mac screen zoomed on that dialog. DETECT + ALERT ONLY: nothing here clicks, types or presses a button
// (answering still goes through D97 SCREEN_CONTROL, if the owner turned it on), and no dialog text or
// password is ever read, stored or sent — only the owning process name and the window's bounds.
//
// Detection = one JXA run of CGWindowListCopyWindowInfo(onScreenOnly) (osascript, script on stdin like
// D97). Owner names and bounds need no permission; window TITLES need Screen Recording, so the label
// comes from the owner name alone. Gated by SCREEN_VIEW on the bridge (it shows where on the screen a
// dialog is), 403 screen_disabled otherwise.
const crypto = require('crypto');

// ---- limits (each one is a LIMITS.md row) ----
const MAC_DIALOG_POLL_MS = Math.max(2000, Number(process.env.MAC_DIALOG_POLL_MS) || 5000);   // server polls each Mac this often
const MAC_DIALOG_OFF_RECHECK_MS = 60000;   // a Mac answering 403 screen_disabled / not reachable is re-asked this often
const MAC_DIALOG_CACHE_MS = 2000;          // bridge reuses one osascript answer this long (several viewers -> one run)
const MAC_DIALOG_MAX = 20;                 // dialogs per answer (the rest dropped)
const MAC_DIALOG_PUSHED_MAX = 200;         // pushed-id memory per Mac (ids of closed dialogs are pruned first)
// Chrome sheet heuristic: an UNTITLED Chrome window no bigger than this (points). Untitled-ness needs
// Screen Recording; without it every Chrome window is untitled and only the size test remains.
const CHROME_DIALOG_MAX_W = 600;
const CHROME_DIALOG_MAX_H = 400;
// p41 D136: answering a dialog from the phone (SCREEN_CONTROL only). The AX walk is capped so a big
// window (a Chrome page mis-taken for a dialog) can never stall the 12 s osascript run.
const AX_WALK_MAX_DEPTH = 10;            // children levels below the dialog window
const AX_WALK_MAX_NODES = 400;           // AX elements visited per dialog
const AX_MAX_BUTTONS = 12;               // buttons reported per dialog
const AX_TEXT_MAX_CHARS = 500;           // joined static text per dialog
const AX_TITLE_MAX_CHARS = 80;           // one button title
const AX_FRAME_TOL = 3;                  // points: AX window frame vs CG window bounds (native/ax-dialogs.swift)
const DIALOG_TYPE_MAX_CHARS = 256;       // one /screen/dialogs/type
const DIALOG_BODY_MAX_BYTES = 4096;      // press/type request body
const LIMITS = { AX_WALK_MAX_DEPTH, AX_WALK_MAX_NODES, AX_MAX_BUTTONS, AX_TEXT_MAX_CHARS, AX_TITLE_MAX_CHARS, AX_FRAME_TOL,
  DIALOG_TYPE_MAX_CHARS, DIALOG_BODY_MAX_BYTES, MAC_DIALOG_POLL_MS, MAC_DIALOG_OFF_RECHECK_MS, MAC_DIALOG_CACHE_MS, MAC_DIALOG_MAX, MAC_DIALOG_PUSHED_MAX,
  CHROME_DIALOG_MAX_W, CHROME_DIALOG_MAX_H };

// owner process name -> plain-words label. Extend only by adding a literal here.
const DIALOG_OWNERS = {
  SecurityAgent: 'Password prompt',                       // admin / keychain password sheet
  coreautha: 'Password prompt',                           // LocalAuthentication (Touch ID / password)
  AuthenticationServicesAgent: 'Sign-in request',         // passkey / web sign-in sheet
  UserNotificationCenter: 'macOS permission request',     // 'X would like to …' alerts
  universalAccessAuthWarn: 'macOS permission request',    // 'X would like to control this computer'
  CoreServicesUIAgent: 'macOS security check',            // 'X is an app downloaded from the internet'
};
const CHROME_OWNER = 'Google Chrome';

// Static JXA; `prelude` = mac-screen's JXA_SCREENS (imports + screens(), no input functions). Owners filtered in JXA to keep
// stdout small; names are sent only as "is there a title" (never the text). D136: + owner pid (for the AX helper).
function dialogScript(prelude) {
  const owners = JSON.stringify([...Object.keys(DIALOG_OWNERS), CHROME_OWNER]);
  return `${prelude}
function run(){var O=${owners};var a=ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,0)),w=[];
for(var i=0;i<a.count;i++){var d=a.objectAtIndex(i);var o=ObjC.unwrap(d.objectForKey('kCGWindowOwnerName'));if(O.indexOf(o)<0)continue;var b=d.objectForKey('kCGWindowBounds');var n=ObjC.unwrap(d.objectForKey('kCGWindowName'));
w.push({owner:o,pid:ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID')),layer:ObjC.unwrap(d.objectForKey('kCGWindowLayer')),x:ObjC.unwrap(b.objectForKey('X')),y:ObjC.unwrap(b.objectForKey('Y')),w:ObjC.unwrap(b.objectForKey('Width')),h:ObjC.unwrap(b.objectForKey('Height')),titled:!!(n&&String(n).length)});}
return JSON.stringify({displays:screens(),windows:w});}`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const r4 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

// -> label | null for one window record from the JXA run.
function labelFor(win) {
  if (!win || typeof win.owner !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(DIALOG_OWNERS, win.owner)) return DIALOG_OWNERS[win.owner];
  if (win.owner === CHROME_OWNER && !win.titled && win.w > 0 && win.h > 0 && win.w <= CHROME_DIALOG_MAX_W && win.h <= CHROME_DIALOG_MAX_H) return 'Chrome permission';
  return null;
}

// Window (CG global points, top-left origin) -> { display, rect:{fx,fy,fw,fh} } on the display holding
// its centre (else the one it overlaps most, else display 1), fractions clamped to that display.
function mapToDisplay(win, displays) {
  const ds = Array.isArray(displays) ? displays.filter((d) => d && d.w > 0 && d.h > 0) : [];
  if (!ds.length) return null;
  const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
  let d = ds.find((s) => cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h);
  if (!d) {
    let best = 0;
    for (const s of ds) {
      const ov = Math.max(0, Math.min(win.x + win.w, s.x + s.w) - Math.max(win.x, s.x)) * Math.max(0, Math.min(win.y + win.h, s.y + s.h) - Math.max(win.y, s.y));
      if (ov > best) { best = ov; d = s; }
    }
  }
  if (!d) d = ds[0];
  const x0 = Math.max(win.x, d.x), y0 = Math.max(win.y, d.y);
  const x1 = Math.min(win.x + win.w, d.x + d.w), y1 = Math.min(win.y + win.h, d.y + d.h);
  return { display: Number(d.index) || ds.indexOf(d) + 1,
    rect: { fx: r4((x0 - d.x) / d.w), fy: r4((y0 - d.y) / d.h), fw: r4(Math.max(0, x1 - x0) / d.w), fh: r4(Math.max(0, y1 - y0) / d.h) } };
}

const dialogId = (win) => crypto.createHash('sha1')
  .update(`${win.owner}|${Math.round(win.x)}|${Math.round(win.y)}|${Math.round(win.w)}|${Math.round(win.h)}`).digest('hex').slice(0, 12);

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
// D136: AX helper read answer -> { buttons:[{title, default?, rect}], text, password, fields } | { buttons:[], axError }.
// Button rects are fractions of the dialog's display (like the dialog rect); `abs` (CG points) stays internal.
function enrich(rawAx, displays, display) {
  if (!rawAx || typeof rawAx !== 'object') return { buttons: [], axError: 'ax_failed' };
  if (rawAx.error) return { buttons: [], axError: clip(String(rawAx.error), 40) };
  const d = (Array.isArray(displays) ? displays : []).find((s) => Number(s.index) === display);
  const buttons = [];
  for (const b of Array.isArray(rawAx.buttons) ? rawAx.buttons : []) {
    const title = clip(b && b.title, AX_TITLE_MAX_CHARS);
    const f = (b && b.frame) || {};
    const abs = { x: num(f.x), y: num(f.y), w: num(f.w), h: num(f.h) };
    if (!title || abs.x == null || abs.y == null || !(abs.w > 0) || !(abs.h > 0)) continue;
    const o = { title };
    if (b.default === true) o.default = true;
    if (d) o.rect = { fx: r4((abs.x - d.x) / d.w), fy: r4((abs.y - d.y) / d.h), fw: r4(abs.w / d.w), fh: r4(abs.h / d.h) };
    Object.defineProperty(o, 'abs', { value: abs, enumerable: false });   // never serialised
    buttons.push(o);
    if (buttons.length >= AX_MAX_BUTTONS) break;
  }
  return { buttons, text: clip(rawAx.text, AX_TEXT_MAX_CHARS), password: rawAx.password === true,
    fields: Math.max(0, Math.min(20, Math.round(Number(rawAx.fields) || 0))) };
}

// JXA stdout -> [{ id, owner, label, display, rect, [D136 buttons, text, password, fields | axError] }] (no `since`)
// | null when unparseable. Each entry carries a non-enumerable `win` {owner,pid,x,y,w,h} for press/type.
function parseDialogs(out, keepDisplays = false) {
  let j = null; try { j = JSON.parse(out); } catch (_) { return null; }
  if (!j || !Array.isArray(j.windows) || !Array.isArray(j.displays)) return null;
  const seen = new Set(), res = [];
  for (const raw of j.windows) {
    const win = { owner: raw && raw.owner, titled: !!(raw && raw.titled), x: num(raw && raw.x), y: num(raw && raw.y), w: num(raw && raw.w), h: num(raw && raw.h) };
    if (win.x == null || win.y == null || !(win.w > 0) || !(win.h > 0)) continue;
    const label = labelFor(win);
    if (!label) continue;
    const at = mapToDisplay(win, j.displays);
    if (!at) continue;
    const id = dialogId(win);
    if (seen.has(id)) continue;
    seen.add(id);
    const dlg = { id, owner: win.owner, label, display: at.display, rect: at.rect };
    if (keepDisplays) Object.defineProperty(dlg, '_displays', { value: j.displays, enumerable: false });
    Object.defineProperty(dlg, 'win', { value: { owner: win.owner, pid: num(raw.pid), x: win.x, y: win.y, w: win.w, h: win.h }, enumerable: false });
    res.push(dlg);
    if (res.length >= MAC_DIALOG_MAX) break;
  }
  return res;
}

// Bridge side: osascript answer cached MAC_DIALOG_CACHE_MS, one run in flight, `since` kept per id.
// osa(script) -> Promise<{ ok, out } | { ok:false, err }> (mac-screen's single-file osascript queue).
// D136: axRead(items) -> Promise<answers[]> (SCREEN_CONTROL on): each dialog gains buttons/text/password/fields,
// or buttons:[] + axError (then the app falls back to the D135 Open-screen path).
function createDialogReader({ osa, prelude, now = Date.now, axRead = null }) {
  const script = dialogScript(prelude);
  const since = new Map();
  let cache = null, cacheAt = 0, inflight = null;
  // fresh=true (D136 press/type) skips the cache: the dialog must still be there NOW.
  async function read(fresh = false) {
    if (!fresh && cache && now() - cacheAt < MAC_DIALOG_CACHE_MS) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await osa(script);
      if (!r.ok) return r.err === 'busy' ? { status: 429, body: { error: 'busy', retryMs: 500 } } : { status: 502, body: { error: 'screen_failed', cause: r.err } };
      const list = parseDialogs(r.out, true);
      if (!list) return { status: 502, body: { error: 'screen_failed' } };
      if (axRead && list.length) {
        let ans = null; try { ans = await axRead(list.map((d) => ({ pid: d.win.pid, frame: { x: d.win.x, y: d.win.y, w: d.win.w, h: d.win.h } }))); } catch (_) {}
        list.forEach((d, i) => Object.assign(d, enrich(Array.isArray(ans) ? ans[i] : { error: (ans && ans.error) || 'helper_failed' }, d._displays, d.display)));
      }
      const t = now(), live = new Set(list.map((d) => d.id));
      for (const id of [...since.keys()]) if (!live.has(id)) since.delete(id);
      for (const d of list) { if (!since.has(d.id)) since.set(d.id, t); d.since = since.get(d.id); }
      cache = { status: 200, body: { dialogs: list } }; cacheAt = t;
      return cache;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  return { read };
}

// Server side: poll each Mac's /cmux/screen/dialogs, push ONE NEEDS-YOU alert per new dialog id.
// The first good answer per Mac only seeds (a server restart never re-buzzes a dialog already open).
// notify(payload) = alerts.notify. bridge(m, path, opts) -> fetch-like Response. active() false (no phone
// subscribed) -> no poll, so no osascript runs on any Mac.
function createDialogWatch({ machines, bridge, notify, now = Date.now, log = console, active = () => true }) {
  const st = new Map();   // machineId -> { pushed:Set|null, nextAt, dialogs }
  const many = () => machines.length > 1;
  async function pollMachine(m) {
    const s = st.get(m.id) || { pushed: null, nextAt: 0, dialogs: [] };
    st.set(m.id, s);
    if (now() < s.nextAt) return;
    let d = null, status = 0;
    try {
      const r = await bridge(m, '/cmux/screen/dialogs', { timeout: 12000 });
      status = r.status;
      d = await r.json().catch(() => null);
    } catch (_) { s.nextAt = now() + MAC_DIALOG_OFF_RECHECK_MS; return; }
    if (status === 403 || status === 404 || !d || !Array.isArray(d.dialogs)) {   // flag off / older bridge / bad answer
      if (status !== 429) s.nextAt = now() + MAC_DIALOG_OFF_RECHECK_MS;
      return;
    }
    s.dialogs = d.dialogs;
    const ids = new Set(d.dialogs.map((x) => x && x.id).filter(Boolean));
    if (!s.pushed) { s.pushed = ids; return; }   // seeding poll
    for (const x of d.dialogs) {
      if (!x || !x.id || s.pushed.has(x.id)) continue;
      s.pushed.add(x.id);
      const label = String(x.label || 'A dialog').slice(0, 60);
      const p = { title: `${m.label || m.id} needs you`, body: `${label} on ${m.label || m.id}`, tag: 'mac-dialog-' + m.id + '-' + x.id,
        machine: m.id, surface: null, kind: 'mac-dialog', id: x.id };
      if (!many()) p.title = `${m.label || 'Your Mac'} needs you`;
      try { await notify(p); } catch (e) { log.error(`mac-dialogs: push failed ${(e && e.message) || e}`); }
    }
    // forget closed dialogs first, then cap
    for (const id of [...s.pushed]) if (!ids.has(id) && s.pushed.size > MAC_DIALOG_PUSHED_MAX) s.pushed.delete(id);
    for (const id of [...s.pushed]) { if (s.pushed.size <= MAC_DIALOG_PUSHED_MAX) break; s.pushed.delete(id); }
  }
  let polling = null;
  const tick = () => { if (!active()) return Promise.resolve(); if (!polling) polling = Promise.all(machines.map(pollMachine)).finally(() => { polling = null; }); return polling; };
  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, MAC_DIALOG_POLL_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { tick, start, stop, state: (id) => st.get(id) };
}

module.exports = { LIMITS, DIALOG_OWNERS, enrich, labelFor, mapToDisplay, parseDialogs, dialogScript, dialogId, createDialogReader, createDialogWatch };
