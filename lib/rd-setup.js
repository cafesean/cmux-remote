'use strict';
// p41 D189 (HMX-76) — Remote Desktop setup status: which macOS privacy (TCC) grants the Mac screen needs
// and whether this Mac has them. TCC cannot be granted remotely, so the app shows a checklist ON the Mac
// and a "needs setup on this Mac" row on the phone.
//
// WHO needs the grant: capture (screencapture), input (osascript CGEventPost) and the D136 Swift helper are
// all spawned by the bridge, so macOS charges them to the bridge's RESPONSIBLE process — the binary the
// LaunchAgent runs (node, or the bun-compiled hypermux). `binary` names it so the checklist can say which
// app to switch on.
//   screen-recording  CGPreflightScreenCaptureAccess   (view: screencapture, Vision OCR of dialogs)
//   accessibility     AXIsProcessTrusted                (control: CGEventPost mouse/keys; D136 AX dialogs)
// Input Monitoring is NOT needed: nothing here listens to events (CGEventPost needs Accessibility only).
//
// p41 D189b GROUND TRUTH for Screen Recording: CGPreflightScreenCaptureAccess and a non-empty screencapture
// both lie (macOS 15+ captures wallpaper + menu bar without the grant; a lock-screen frame looks "fine").
// The same JXA run (osascript, child of the bridge's node = the SAME spawn chain as screencapture) reads
// CGWindowListCopyWindowInfo(onScreenOnly): macOS hands out OTHER apps' kCGWindowName only to a process
// with Screen Recording. Normal (layer 0) windows of other apps with a name -> truth true; such windows but
// none named -> truth false; no such window on screen (lock screen, empty desktop) -> truth null (can't tell).
// Reading the window list never prompts (only capture APIs do).
//
// Probe = one read-only JXA run. It never calls CGRequestScreenCaptureAccess or AXIsProcessTrustedWithOptions
// (both pop a dialog). Cached (ttl), one probe in flight at a time, killed after timeoutMs.
const { spawn } = require('child_process');

const RD_PROBE_TTL_MS = 30000;          // cached probe answer reused this long
const RD_PROBE_TIMEOUT_MS = 5000;       // one osascript probe; killed after
const RD_PROBE_FRESH_MIN_MS = 2000;     // ?fresh=1 (the Mac checklist on foreground) re-probes at most this often
const RD_REMIND_TTL_MS = 10 * 60 * 1000;   // "Remind on Mac" flag shown this long, then dropped
// Ground truth beats the probe: a real capture / trusted input inside this window counts as granted, whatever
// the probe said (osascript's TCC attribution can differ from the bridge's: a false "missing" would hide a
// working Remote Desktop).
const RD_OBSERVED_MS = 10 * 60 * 1000;
const LIMITS = { RD_PROBE_TTL_MS, RD_PROBE_TIMEOUT_MS, RD_PROBE_FRESH_MIN_MS, RD_REMIND_TTL_MS, RD_OBSERVED_MS };

const SETTINGS_URL = {
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
const PERM_IDS = ['screen-recording', 'accessibility'];

const JXA_PERMS = `ObjC.import('CoreGraphics');ObjC.import('ApplicationServices');ObjC.import('Foundation');
function truth(){var me=$.NSProcessInfo.processInfo.processIdentifier,w=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0)))||[],n=0,named=0;
for(var i=0;i<w.length;i++){var x=w[i];if(!x||x.kCGWindowLayer!==0||x.kCGWindowOwnerPID===me)continue;n++;if(typeof x.kCGWindowName==='string'&&x.kCGWindowName.length)named++;}
return {windows:n,named:named};}
function run(){var s=false,a=false,t=null;try{s=!!$.CGPreflightScreenCaptureAccess();}catch(e){}try{a=!!$.AXIsProcessTrusted();}catch(e){}try{t=truth();}catch(e){}
return JSON.stringify({screenRecording:s,accessibility:a,windows:t?t.windows:null,named:t?t.named:null});}`;

/** {windows, named} -> truth: true (another app's window name visible), false (windows, none named), null (can't tell). */
function truthOf(windows, named) {
  if (!Number.isInteger(windows) || !Number.isInteger(named) || windows < 1) return null;
  return named > 0;
}

/**
 * osascript stdout -> { 'screen-recording': bool, accessibility: bool, truth: bool|null, windows, named } | null
 * (unparseable). An older probe without the window counts -> truth null.
 */
function parseProbe(out) {
  let j = null;
  try { j = JSON.parse(String(out || '').trim()); } catch (_) { return null; }
  if (!j || typeof j !== 'object' || typeof j.screenRecording !== 'boolean' || typeof j.accessibility !== 'boolean') return null;
  return { 'screen-recording': j.screenRecording, accessibility: j.accessibility, truth: truthOf(j.windows, j.named),
    windows: Number.isInteger(j.windows) ? j.windows : null, named: Number.isInteger(j.named) ? j.named : null };
}

const OBSERVED_KEY = { 'screen-recording': 'capture', accessibility: 'input' };

/**
 * probe answer (+ observed successes) -> the `screen` capability. FAIL OPEN: probe null (error, timeout,
 * unparseable) = unknown, ready null — the app never says "needs setup" on it. Per permission:
 *   screen-recording: truth decides when it can (true/false, source 'truth'); truth null -> preflight, or an
 *     observed capture — the latter ONLY if a truth check passed within RD_PROBE_TTL_MS of that capture
 *     (truthOkAt; a wallpaper / lock-screen frame alone proves nothing, D189b).
 *   accessibility: probe || observed input / AX press within RD_OBSERVED_MS (source 'observed').
 *   probe = what preflight / AXIsProcessTrusted said; truth = the window-name check (screen-recording only).
 */
function buildStatus(granted, { binary, view, control, remindAt, at, observed, truthOkAt = 0, now = Date.now() }) {
  const base = { view: !!view, control: !!control, binary, at, ...(remindAt ? { remindAt } : {}) };
  if (!granted) return { ...base, ready: null, perms: [] };
  const seenAt = (id) => { const t = observed && observed[OBSERVED_KEY[id]]; return t && now - t < RD_OBSERVED_MS ? t : 0; };
  const perms = PERM_IDS.map((id) => {
    const probe = !!granted[id], t = seenAt(id);
    const row = { id, probe, settingsUrl: SETTINGS_URL[id], binary };
    if (id === 'screen-recording') {
      const truth = granted.truth === true || granted.truth === false ? granted.truth : null;
      if (truth !== null) return { ...row, granted: truth, source: 'truth', truth };
      const obs = !!t && !!truthOkAt && Math.abs(t - truthOkAt) <= RD_PROBE_TTL_MS;
      return { ...row, granted: probe || obs, source: !probe && obs ? 'observed' : 'probe', truth: null };
    }
    return { ...row, granted: probe || !!t, source: !probe && t ? 'observed' : 'probe' };
  });
  return { ...base, ready: perms.every((p) => p.granted), perms };
}

function createRdSetup(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const platform = opts.platform || process.platform;
  const childEnv = opts.childEnv || (() => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }));
  const OSA = env.SCREEN_OSASCRIPT_BIN || '/usr/bin/osascript';
  const binary = opts.binary || env.HYPRMUX_TCC_BINARY || process.execPath;
  const flags = opts.flags || (() => ({ view: false, control: false }));
  const runProbe = opts.runProbe || defaultProbe;
  const observed = opts.observed || (() => null);
  const timeoutMs = opts.timeoutMs || RD_PROBE_TIMEOUT_MS;
  let cache = null, cacheAt = 0, inflight = null, remindAt = 0, truthOkAt = 0;

  function defaultProbe() {
    return new Promise((resolve) => {
      let out = '', done = false, c, t;
      const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      try { c = spawn(OSA, ['-l', 'JavaScript', '-'], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return fin(null); }
      t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) {} fin(null); }, timeoutMs);
      c.stdout.on('data', (d) => { if (out.length < 4096) out += d; });
      c.on('error', () => fin(null));
      c.on('close', () => fin(parseProbe(out)));
      c.stdin.on('error', () => {});
      c.stdin.end(JXA_PERMS);
    });
  }
  function probe() {
    if (inflight) return inflight;
    inflight = Promise.resolve().then(runProbe).catch(() => null).then((g) => {
      inflight = null; cacheAt = now();
      cache = g;   // a failed probe is cached too (null): no retry storm while osascript is wedged
      if (g && g.truth === true) truthOkAt = cacheAt;   // D189b: when Screen Recording last PROVED itself
      return g;
    });
    return inflight;
  }
  function remind() {
    const t = now();
    return remindAt && t - remindAt < RD_REMIND_TTL_MS ? remindAt : 0;
  }
  const shape = () => {
    const f = flags();
    let obs = null; try { obs = observed(); } catch (_) {}
    return buildStatus(cache, { binary, view: f.view, control: f.control, remindAt: remind(), at: cacheAt, observed: obs, truthOkAt, now: now() });
  };
  /** -> Promise<screen status> | null off macOS. fresh: re-probe unless one ran < RD_PROBE_FRESH_MIN_MS ago. */
  async function status({ fresh = false } = {}) {
    if (platform !== 'darwin') return null;
    const age = now() - cacheAt;
    if (!cacheAt || age >= RD_PROBE_TTL_MS || (fresh && age >= RD_PROBE_FRESH_MIN_MS)) await probe();
    const s = shape();
    if (s.ready === true && remindAt) remindAt = 0;   // all granted: the reminder is done
    return s;
  }
  /** Sync, for capabilities(): last cached value (kicks a background probe when stale). */
  function cached() {
    if (platform !== 'darwin') return null;
    if (!cacheAt || now() - cacheAt >= RD_PROBE_TTL_MS) probe();
    return cacheAt ? shape() : undefined;
  }
  function setRemind(clear) { remindAt = clear ? 0 : now(); return { ok: true, remindAt: remindAt || null }; }
  return { status, cached, setRemind };
}

module.exports = { createRdSetup, parseProbe, truthOf, buildStatus, LIMITS, SETTINGS_URL, PERM_IDS, JXA_PERMS };
