'use strict';
// Video Remote Desktop, bridge side: owns the hm-screen-stream helper (one per display), turns its
// framed stdout into the chunked body of GET /cmux/screen/video, forwards POST /cmux/screen/video/in
// batches, and is the ONLY release owner for buttons/modifiers the forwarded input may have left down.
//
// Helper wire: stdin JSON lines (start|rate|grant|keyframe|time|input|release|stop); stdout = outer
// u32 BE length L + one packet (42-byte header). Type 5 packets are meta (UTF-8 JSON payload).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HEADER = 42;
const MAX_PACKET = 4 * 1024 * 1024;
const STOP_AFTER_MS = 10000;              // helper kept this long after the last viewer leaves
const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
const RELEASE_RETRY_MS = 1000;            // JXA fallback release retried while AX is denied
const FOCUS_POLL_MS = 500;                // focusSecure poll while a control viewer exists
const T_META = 5;
const OPS = new Set(['grant', 'keyframe', 'rate', 'time', 'release']);
const LIMITS = { HEADER, MAX_PACKET, STOP_AFTER_MS, RESTART_BACKOFF_MS, RELEASE_RETRY_MS, FOCUS_POLL_MS };

function parseHeader(b) {
  return { type: b[0], flags: b[1], gen: b.readUInt32BE(2), seq: b.readUInt32BE(6), captureTs: b.readBigUInt64BE(10),
    encodeDoneTs: b.readBigUInt64BE(18), postedInput: b.readUInt32BE(26), rev: b.readUInt32BE(30), grantId: b.readUInt32BE(34),
    length: b.readUInt32BE(38) };
}

function encodePacket(h, payload) {
  const p = Buffer.from(payload || []);
  const b = Buffer.alloc(HEADER + p.length);
  b[0] = h.type; b[1] = h.flags || 0;
  b.writeUInt32BE(h.gen >>> 0, 2); b.writeUInt32BE((h.seq || 0) >>> 0, 6);
  b.writeBigUInt64BE(BigInt(h.captureTs || 0), 10); b.writeBigUInt64BE(BigInt(h.encodeDoneTs || 0), 18);
  b.writeUInt32BE((h.postedInput || 0) >>> 0, 26); b.writeUInt32BE((h.rev || 0) >>> 0, 30);
  b.writeUInt32BE((h.grantId || 0) >>> 0, 34); b.writeUInt32BE(p.length, 38);
  p.copy(b, HEADER);
  return b;
}
const frame = (packet) => { const l = Buffer.alloc(4); l.writeUInt32BE(packet.length, 0); return Buffer.concat([l, packet]); };

// Outer-length deframer. L < 42, L > 4 MiB or payloadLength != L - 42 -> onError (caller restarts the stream).
function createDeframer({ onPacket, onError, max = MAX_PACKET }) {
  let chunks = [], have = 0, dead = false;
  function take(n) {
    const out = Buffer.allocUnsafe(n); let o = 0;
    while (o < n) {
      const c = chunks[0], k = Math.min(c.length, n - o);
      c.copy(out, o, 0, k); o += k;
      if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
    }
    have -= n; return out;
  }
  function peek32() {   // read the outer length without consuming it
    const h = Buffer.allocUnsafe(4); let o = 0;
    for (const c of chunks) { const k = Math.min(c.length, 4 - o); c.copy(h, o, 0, k); o += k; if (o === 4) break; }
    return h.readUInt32BE(0);
  }
  return {
    push(buf) {
      if (dead || !buf || !buf.length) return;
      chunks.push(Buffer.from(buf)); have += buf.length;
      if (chunks.length > 64) chunks = [Buffer.concat(chunks)];
      while (have >= 4) {
        const L = peek32();
        if (L < HEADER || L > max) { dead = true; chunks = []; have = 0; return onError(new Error('bad_frame_length ' + L)); }
        if (have < 4 + L) return;
        take(4);
        const p = take(L);
        if (p.readUInt32BE(38) !== L - HEADER) { dead = true; chunks = []; have = 0; return onError(new Error('length_mismatch')); }
        onPacket(p, parseHeader(p));
      }
    },
    get dead() { return dead; },
  };
}

// Helper binary lookup. Compiled runtime: SCREEN_STREAM_BIN, else dirname(execPath)/hm-screen-stream, never the toolchain.
// Dev (node running the repo): swift build from the repo found via __dirname (never cwd).
function helperLookup(o = {}) {
  const env = o.env || process.env;
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const compiled = o.compiled != null ? o.compiled : !/(^|\/)node$/.test(o.execPath || process.execPath);
  const execPath = o.execPath || process.execPath;
  if (env.SCREEN_STREAM_BIN) return exists(env.SCREEN_STREAM_BIN) ? { bin: env.SCREEN_STREAM_BIN } : { error: 'helper_missing' };
  if (compiled) {
    const p = path.join(path.dirname(execPath), 'hm-screen-stream');
    return exists(p) ? { bin: p } : { error: 'helper_missing' };
  }
  const run = o.run || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const pkg = path.join(o.repoRoot || path.join(__dirname, '..'), 'native', 'hyprmux-bridge');
  const base = ['build', '-c', 'debug', '--package-path', pkg, '--product', 'hm-screen-stream'];
  try {
    run('swift', base);
    const dir = String(run('swift', [...base, '--show-bin-path'])).trim();
    const p = path.join(dir, 'hm-screen-stream');
    return exists(p) ? { bin: p } : { error: 'helper_missing' };
  } catch (_) { return { error: 'helper_missing' }; }
}

// Consecutive move/drag items of one type (same gen/epoch) collapse to the last, as the helper's Coalesce.moves.
// -> { items: kept, in order; dropped: the superseded ones }.
function coalesceMoves(list) {
  const items = [], dropped = [];
  const mt = (it) => (it && it.t === 'mouse' ? (it.type || it.kind) : null);
  const isMove = (it) => mt(it) === 'move' || mt(it) === 'drag';
  for (const it of list) {
    const last = items[items.length - 1];
    if (isMove(it) && last && isMove(last) && mt(last) === mt(it) && last.gen === it.gen && last.epoch === it.epoch) {
      dropped.push(last); items[items.length - 1] = it;
    } else items.push(it);
  }
  return { items, dropped };
}

// Conservative possiblyHeld: parts enter on forward, leave only on the helper's posted for the up (or a
// confirmed release). Each down is a press (id = its seq); an up retires the oldest open press of that button.
function createHeld() {
  const presses = new Map();     // part -> [pressSeq, ...] open presses
  const pendingUp = new Map();   // up seq -> [{part, press}]
  const add = (part, seq) => { if (!presses.has(part)) presses.set(part, []); presses.get(part).push(seq); };
  const claim = (part) => { const l = presses.get(part) || []; const taken = new Set([].concat(...[...pendingUp.values()].map((v) => v.filter((x) => x.part === part).map((x) => x.press)))); return l.find((s) => !taken.has(s)); };
  function forward(it) {
    if (!it || typeof it.seq !== 'number') return;
    const parts = [];
    const kind = it.t === 'mouse' ? (it.type || it.kind) : null;   // the app wire says type; older callers kind
    if (kind === 'down') add(it.button === 'right' ? 'right' : 'left', it.seq);
    else if (kind === 'up') {
      const part = it.button === 'right' ? 'right' : 'left';
      const press = claim(part);
      if (press != null) parts.push({ part, press });
    } else if (it.t === 'tap') { add(it.button === 'right' ? 'right' : 'left', it.seq); parts.push({ part: it.button === 'right' ? 'right' : 'left', press: it.seq }); }
    else if (it.t === 'key') {
      for (const m of [...(Array.isArray(it.mods) ? it.mods : []), 'key:' + it.key]) { add(m, it.seq); parts.push({ part: m, press: it.seq }); }
    }
    if (parts.length) pendingUp.set(it.seq, parts);
  }
  function posted(seq) {
    const parts = pendingUp.get(seq);
    if (!parts) return;
    pendingUp.delete(seq);
    for (const { part, press } of parts) {
      const l = presses.get(part) || []; const i = l.indexOf(press);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) presses.delete(part);
    }
  }
  function clear() { presses.clear(); pendingUp.clear(); }
  return { forward, posted, clear, empty: () => presses.size === 0, parts: () => [...presses.keys()] };
}

function createScreenStream(o = {}) {
  const env = o.env || process.env;
  const log = o.log || ((m) => console.error(m));
  const spawnFn = o.spawn || spawn;
  const lookup = o.lookup || (() => helperLookup({ env }));
  const jxaRelease = o.jxaRelease || (async () => 'noax');   // -> 'ok' | 'noax' | other failure
  const focusProbe = o.focusSecure || (async () => null);
  const lockProbe = o.lockState || (async () => null);
  const isTyping = (it) => it.t === 'key' || it.t === 'type';   // p43 locked-state -> { locked, secureInputOwner } | null
  const jpegIdle = o.jpegIdle || (async () => true);          // resolves once osaTail settled + no JPEG hold
  const stopAfter = o.stopAfterMs != null ? o.stopAfterMs : STOP_AFTER_MS;
  const backoff = o.backoffMs || RESTART_BACKOFF_MS;
  const retryMs = o.releaseRetryMs != null ? o.releaseRetryMs : RELEASE_RETRY_MS;
  const pollMs = o.focusPollMs != null ? o.focusPollMs : FOCUS_POLL_MS;
  const flags = o.flags || { view: false, control: false };
  const captureBlocked = o.captureBlocked || (() => false);

  const helpers = new Map();   // displayId -> helper state
  const held = createHeld();
  let releaseChain = Promise.resolve();
  let releasePending = false, retryTimer = null;
  let videoControl = null;     // { displayId, gen, epoch, open } while a video viewer with control exists
  let lastFocus = null, focusTimer = null, lastLock = null;

  function helperFor(displayId) {
    let h = helpers.get(displayId);
    if (h) return h;
    h = { displayId, proc: null, viewers: new Set(), stopTimer: null, restarts: 0, gen: 0, epoch: 0, acceptedEpoch: 0, posted: 0, released: new Map(), dead: false };
    helpers.set(displayId, h);
    return h;
  }
  function send(h, op) { if (h.proc && h.proc.stdin && !h.proc.stdin.destroyed) h.proc.stdin.write(JSON.stringify(op) + '\n'); }
  function broadcast(h, packet) { for (const v of h.viewers) v.write(packet); }
  function emitMeta(h, obj) {
    const p = encodePacket({ type: T_META, gen: h.gen }, Buffer.from(JSON.stringify(obj)));
    broadcast(h, frame(p));
  }

  function onMeta(h, m) {
    if (!m || typeof m.kind !== 'string') return;
    if (m.kind === 'posted') { held.posted(m.seq); h.posted = Math.max(h.posted, m.seq >>> 0); }
    else if (m.kind === 'released') { held.clear(); resolveRelease(h, m.epoch); }
    else if (m.kind === 'failed') { log('screen-stream: input failed ' + String(m.why || '')); if (m.why === 'noax' || m.why === 'not_trusted') blockAndRelease(); }
    else if (m.kind === 'watchdog_up' || m.kind === 'skipped' || m.kind === 'idr_over_budget') { /* passed through to the server */ }
  }

  function startHelper(h) {
    const L = lookup();
    if (L.error) { log('screen-stream: helper missing (' + L.error + ')'); h.missing = true; return false; }
    let proc;
    try { proc = spawnFn(L.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (_) { h.missing = true; return false; }
    h.proc = proc; h.missing = false;
    const df = createDeframer({
      onPacket: (p, hd) => {
        if (hd.type === T_META) { let m = null; try { m = JSON.parse(p.subarray(HEADER).toString('utf8')); } catch (_) {} onMeta(h, m); }
        broadcast(h, frame(p));
      },
      onError: (e) => { log('screen-stream: stream error ' + e.message + ', restarting'); try { proc.kill('SIGKILL'); } catch (_) {} },
    });
    proc.stdout.on('data', (d) => df.push(d));
    if (proc.stderr) proc.stderr.on('data', () => {});
    if (proc.stdin) proc.stdin.on('error', () => {});
    proc.on('error', () => {});
    proc.on('exit', () => onExit(h, proc));
    send(h, { op: 'start', gen: h.gen, displayId: h.displayId, ...(h.startOpts || {}) });
    // Tell the viewers the helper runs for this gen (grant ops before this answer 409 no_stream). Deferred so a
    // viewer that is attaching writes its response head first.
    const started = setImmediate(() => { if (h.proc === proc) emitMeta(h, { kind: 'started', displayId: h.displayId, gen: h.gen }); });
    if (started.unref) started.unref();
    return true;
  }
  function onExit(h, proc) {
    if (h.proc !== proc) return;
    h.proc = null;
    // Helper died before answering release: the bridge releases what it forwarded through JXA.
    if (!held.empty() || h.releaseWaiter) blockAndRelease();
    if (h.viewers.size && !h.stopping) {
      const ms = backoff[Math.min(h.restarts, backoff.length - 1)]; h.restarts++;
      h.restartTimer = setTimeout(() => { h.restartTimer = null; if (h.viewers.size) { h.gen++; startHelper(h); } }, ms);
      if (h.restartTimer.unref) h.restartTimer.unref();
    }
  }

  // ---- release owner (serialized) ----
  function resolveRelease(h, epoch) {
    if (h.releaseWaiter && epoch >= h.releaseWaiter.epoch) { const w = h.releaseWaiter; h.releaseWaiter = null; clearTimeout(w.t); w.resolve('ok'); }
  }
  function release(displayId, epoch) {
    const h = helperFor(displayId);
    const run = releaseChain.then(() => new Promise((resolve) => {
      if (!h.proc) return resolve('dead');
      h.acceptedEpoch = Math.max(h.acceptedEpoch, epoch);
      const t = setTimeout(() => { if (h.releaseWaiter) { h.releaseWaiter = null; resolve('timeout'); } }, 2000);
      h.releaseWaiter = { epoch, resolve, t };
      send(h, { op: 'release', epoch });
    })).then((r) => { if (r !== 'ok') blockAndRelease(); return r; });
    releaseChain = run.then(() => {}, () => {});
    return run;
  }
  function blockAndRelease() {
    releasePending = true;
    if (retryTimer) return;
    const attempt = async () => {
      retryTimer = null;
      let r = 'fail'; try { r = await jxaRelease(); } catch (_) {}
      if (r === 'ok') { held.clear(); releasePending = false; for (const h of helpers.values()) emitMeta(h, { kind: 'released', epoch: h.acceptedEpoch, by: 'bridge' }); return; }
      retryTimer = setTimeout(attempt, retryMs); if (retryTimer.unref) retryTimer.unref();
    };
    retryTimer = setTimeout(attempt, 0); if (retryTimer.unref) retryTimer.unref();
  }
  const inputBlocked = () => releasePending || !held.empty() && !videoControl;

  // ---- viewers ----
  function attach(displayId, gen, sink, opts2 = {}) {
    if (!flags.view) return { error: 'screen_disabled', flag: 'SCREEN_VIEW', status: 403 };
    if (captureBlocked()) return { error: 'screen_permission', need: 'screen_recording', status: 403 };   // D253
    const h = helperFor(displayId);
    if (h.stopTimer) { clearTimeout(h.stopTimer); h.stopTimer = null; }
    h.viewers.add(sink);
    if (gen != null) h.gen = gen >>> 0;
    h.startOpts = opts2.start || h.startOpts;
    if (!h.proc) { if (!startHelper(h)) { h.viewers.delete(sink); return { error: 'helper_missing', status: 503, fallback: true }; } }
    else {                                              // helper already running: announce it to this viewer only
      const p0 = h.proc;
      const t = setImmediate(() => { if (h.proc === p0 && h.viewers.has(sink)) sink.write(frame(encodePacket({ type: T_META, gen: h.gen }, Buffer.from(JSON.stringify({ kind: 'started', displayId: h.displayId, gen: h.gen }))))); });
      if (t.unref) t.unref();
    }
    probeLockOnce(h, true);   // p43 locked-state: a new viewer learns the lock state at once
    return { ok: true, detach: () => detach(h, sink) };
  }
  function detach(h, sink) {
    h.viewers.delete(sink);
    if (h.viewers.size) return;
    if (videoControl && videoControl.displayId === h.displayId) closeControl();
    h.stopTimer = setTimeout(() => {
      h.stopTimer = null;
      if (h.viewers.size) return;
      h.stopping = true; send(h, { op: 'stop' });
      const p = h.proc; setTimeout(() => { try { p && p.kill('SIGTERM'); } catch (_) {} }, 1000).unref();
      helpers.delete(h.displayId);
    }, stopAfter);
    if (h.stopTimer.unref) h.stopTimer.unref();
  }

  // ---- control: JPEG -> video proves release first; video owns control until retired ----
  async function openControl(displayId, gen, epoch) {
    if (!flags.control) return { ok: false, reason: 'screen_disabled' };
    videoControl = { displayId, gen, epoch, open: false };
    const vc = videoControl;
    await jpegIdle();
    let r = 'fail'; try { r = await jxaRelease(); } catch (_) {}
    if (videoControl !== vc) return { ok: false, reason: 'retired' };
    if (r !== 'ok') {
      vc.retry = setTimeout(() => { if (videoControl === vc) openControl(displayId, gen, epoch); }, retryMs);
      if (vc.retry.unref) vc.retry.unref();
      return { ok: false, reason: 'screen_permission' };
    }
    vc.open = true;
    startFocusPoll();
    return { ok: true };
  }
  function closeControl() {
    const vc = videoControl; if (!vc) return;
    if (vc.retry) clearTimeout(vc.retry);
    videoControl = null; stopFocusPoll();
    if (!held.empty()) blockAndRelease();
  }
  // JPEG input routes: refused while a video control viewer exists or a release is outstanding.
  const jpegInputAllowed = () => !videoControl && !releasePending && held.empty();

  async function input(b) {
    if (!flags.control) return { status: 403, body: { error: 'screen_disabled', flag: 'SCREEN_CONTROL' } };
    if (!b || !Array.isArray(b.items) || !Number.isInteger(b.gen) || !Number.isInteger(b.epoch)) return { status: 400, body: { error: 'bad_input' } };
    const vc = videoControl;
    if (!vc) return { status: 409, body: { error: 'stale' } };
    if (b.gen !== vc.gen || b.epoch < vc.epoch) return { status: 409, body: { error: 'stale' } };
    if (!vc.open || releasePending) return { status: 409, body: { error: 'input_blocked', reason: releasePending ? 'release_pending' : 'control_busy' } };
    if (b.epoch > vc.epoch) vc.epoch = b.epoch;
    let items = b.items.slice(0, 64).filter((it) => it && typeof it.seq === 'number' && typeof it.t === 'string');
    // p43 locked-state: a locked Mac takes no remote typing (loginwindow holds Secure Keyboard Entry). Key/type items
    // are refused with 423 mac_locked; clicks in the same batch still go.
    let locked = null;
    if (items.some(isTyping)) {
      try { const ls = await lockProbe({}); if (ls && ls.locked === true) locked = ls; } catch (_) {}
      if (videoControl !== vc || !vc.open || releasePending) return { status: 409, body: { error: 'stale' } };
      if (locked) noteLock(null, locked);   // 0.3.2: typing still goes (lock-screen password), the app only shows the state
    }
    const h = helperFor(vc.displayId);
    if (!h.proc) return { status: 409, body: { error: 'input_blocked', reason: 'helper_down' } };
    // Drag fix: the helper collapses consecutive moves/drags and posts only the last, so the others never got a
    // posted ack; the app (and screen-ws) count them pending forever, fill at 64 and hold every later drag.
    // Collapse here and ack the superseded ones at once.
    const co = coalesceMoves(items);
    items = co.items;
    for (const d of co.dropped) emitMeta(h, { kind: 'posted', epoch: b.epoch, seq: d.seq, coalesced: true });
    if (items.length) {
      for (const it of items) held.forward(it);
      send(h, { op: 'input', gen: b.gen, epoch: b.epoch, items });
      probeFocusOnce(h, true);
    }
    return { status: 200, body: { ok: true, postedUpTo: h.posted } };
  }

  // ---- helper ops from the server (grant, keyframe, rate, time, release) ----
  // Only primitive fields go to the helper stdin; the helper is picked by displayId (or the only one running).
  async function op(b) {
    if (!flags.view) return { status: 403, body: { error: 'screen_disabled', flag: 'SCREEN_VIEW' } };
    if (!b || typeof b !== 'object' || !OPS.has(b.op)) return { status: 400, body: { error: 'bad_op' } };
    if (b.op === 'release' && !flags.control) return { status: 403, body: { error: 'screen_disabled', flag: 'SCREEN_CONTROL' } };
    const intOk = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
    if ((b.op === 'grant' || b.op === 'keyframe') && (!intOk(b.gen) || !intOk(b.grantId))) return { status: 400, body: { error: 'bad_op' } };
    if (b.op === 'release' && !intOk(b.epoch)) return { status: 400, body: { error: 'bad_op' } };
    let h = null;
    if (b.displayId != null) h = helpers.get(Number(b.displayId)) || null;
    else if (helpers.size === 1) h = [...helpers.values()][0];
    if (!h || !h.proc) return { status: 409, body: { error: 'no_stream' } };
    if (b.op === 'release') {
      if (videoControl && videoControl.displayId === h.displayId && b.epoch > videoControl.epoch) videoControl.epoch = b.epoch;
      const r = await release(h.displayId, b.epoch);
      return { status: 200, body: { ok: r === 'ok', release: r } };
    }
    const clean = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'displayId') continue;
      if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 64)) clean[k] = v;
    }
    send(h, clean);
    return { status: 200, body: { ok: true } };
  }

  // ---- focusSecure meta (type 5) on change ----
  function probeFocusOnce(h, fresh) {
    Promise.resolve(focusProbe({ fresh })).then((v) => {
      if (v === lastFocus) return;
      lastFocus = v;
      for (const x of (h ? [h] : helpers.values())) emitMeta(x, { kind: 'focus', focusSecure: v });
    }, () => {});
  }
  // ---- p43 locked-state meta (type 5) {kind:'locked', locked, secureInputOwner} on change (and to a new viewer) ----
  function noteLock(h, ls, force) {
    if (!ls || typeof ls.locked !== 'boolean') return;
    const v = { kind: 'locked', locked: ls.locked, secureInputOwner: ls.secureInputOwner || null };
    const same = lastLock && lastLock.locked === v.locked && lastLock.secureInputOwner === v.secureInputOwner;
    if (same && !force) return;
    lastLock = v;
    for (const x of (h ? [h] : helpers.values())) emitMeta(x, v);
  }
  function probeLockOnce(h, force) { Promise.resolve(lockProbe({})).then((ls) => noteLock(h, ls, force), () => {}); }
  function startFocusPoll() { stopFocusPoll(); focusTimer = setInterval(() => { probeFocusOnce(null, false); probeLockOnce(null, false); }, pollMs); if (focusTimer.unref) focusTimer.unref(); }
  function stopFocusPoll() { if (focusTimer) clearInterval(focusTimer); focusTimer = null; }

  function stopAll() {
    stopFocusPoll(); if (retryTimer) clearTimeout(retryTimer); retryTimer = null;
    for (const h of helpers.values()) { h.stopping = true; if (h.stopTimer) clearTimeout(h.stopTimer); if (h.restartTimer) clearTimeout(h.restartTimer); try { h.proc && h.proc.kill('SIGKILL'); } catch (_) {} }
    helpers.clear();
  }

  return { attach, input, op, release, openControl, closeControl, jpegInputAllowed, inputBlocked, stopAll, held,
    state: () => ({ releasePending, control: videoControl && { ...videoControl, retry: undefined }, helpers: [...helpers.keys()] }) };
}

module.exports = { createScreenStream, createDeframer, helperLookup, createHeld, coalesceMoves, parseHeader, encodePacket, frame, LIMITS };
