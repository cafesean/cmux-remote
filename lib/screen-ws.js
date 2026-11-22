'use strict';
// Video Remote Desktop, server side: the WebSocket endpoint /api/cmux/screen/ws for ONE video viewer per machine.
// Transport-neutral: handleUpgrade() serves node:http 'upgrade' (lib/ws.js); attach(ws, ctx) is the per-socket
// session any front door can call with an object that has send/close/markHello/bufferedAmount and emits
// 'message' (data, isBinary) and 'close'.
//
// Flow control is a grant ledger keyed by grantId: at most 2 charged grants outstanding (requested, encoding, in
// flight or sent-unacked); the client's {t:"ack", gen, seq} is a contiguous watermark over sent video. One
// emergency keyframe slot sits outside the window and outside the stall timer.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createDeframer, parseHeader, HEADER_LEN } = (() => {
  const S = require('./screen-stream');
  return { createDeframer: S.createDeframer, parseHeader: S.parseHeader, HEADER_LEN: S.LIMITS.HEADER };
})();

const PATH = '/api/cmux/screen/ws';
const LIMITS = Object.freeze({
  WINDOW: 2,                 // charged grants outstanding
  STALL_MS: 3000,            // sent, unprocessed charged video with no ack advance -> Fallback{stalled}
  EMERGENCY_MS: 3000,        // emergency keyframe unacked -> gen reset
  QUEUE_MS: 400,             // send-queue admission bound
  DRAIN_WINDOW_MS: 2000,
  RECOVERY_MAX: 3, RECOVERY_WINDOW_MS: 10000,
  KEYFRAME_PER_S: 2,
  PENDING_HELLO: 4,          // messages accepted before a valid hello
  PENDING_INPUT: 64,         // unposted input items; up/release always pass
  BATCH_MS: 8, BATCH_MAX: 16,
  MAX_DIM: 8192,
});
const INPUT_T = new Set(['mouse', 'tap', 'scroll', 'type', 'key']);
const T_VIDEO = 1, T_META = 5;

/** Drain estimator: bytes the socket actually wrote over the last 2 s, idle intervals excluded. */
function createDrain(now, windowMs = LIMITS.DRAIN_WINDOW_MS) {
  const samples = []; let last = null;
  return {
    /** call with the socket's bufferedAmount and the bytes just handed to it */
    tick(buffered, added = 0) {
      const t = now();
      if (last && last.buffered > 0) {                   // not idle: something was queued over the interval
        const wrote = last.buffered + added - buffered;
        if (wrote > 0 && t > last.t) samples.push({ t, ms: t - last.t, bytes: wrote });
      }
      last = { t, buffered };
      while (samples.length && t - samples[0].t > windowMs) samples.shift();
    },
    /** kbps measured, or null with no sample (startup, after idle) */
    kbps() {
      if (!samples.length) return null;
      let ms = 0, bytes = 0; for (const s of samples) { ms += s.ms; bytes += s.bytes; }
      return ms > 0 ? (bytes * 8) / ms : null;              // bits per ms = kbps
    },
  };
}

function validHello(m) {
  const dim = (v) => Number.isInteger(v) && v >= 1 && v <= LIMITS.MAX_DIM;
  return m && m.v === 1 && Array.isArray(m.codecs) && m.codecs.includes('h264') && dim(m.maxW) && dim(m.maxH) && (m.maxFps === 30 || m.maxFps === 60);
}
function validConfig(m) {
  const dim = (v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= LIMITS.MAX_DIM);
  return dim(m.maxW) && dim(m.maxH) && (m.maxFps === undefined || m.maxFps === 30 || m.maxFps === 60);
}

/**
 * o: {
 *   serverToken(): string, authed(req, u): bool, findMachine(id), accept(req, socket, head, opts) -> ws|null,
 *   refuse(socket, status, body),
 *   policy: null | { authorize(req, u, ctx) -> null | {status, body}, ctx(req, u, machine) -> {cred, local, machineIds, keys},
 *                    track(req, adapter, ctx, machineId) },   // adapter: on('close'), destroy(), onChange()
 *   bridge: { open(m, {display, gen, epoch}, onChunk, onEnd) -> {close()},  // framed packets (outer u32 L)
 *             op(m, op) -> Promise, input(m, body) -> Promise<{status, body}>,
 *             info(m, display) -> Promise<{w, h, displayW, displayH, fps, axTrusted, control, focusSecure}> },
 *   kbps?(m) -> number, now?, setT?, clearT?, limits?
 * }
 */
function createScreenWs(o) {
  const L = { ...LIMITS, ...(o.limits || {}) };
  const now = o.now || Date.now;
  const setT = o.setT || setTimeout, clearT = o.clearT || clearTimeout;
  const bridge = o.bridge;
  const byMachine = new Map();       // machineId -> session (one video viewer per machine)
  const recovery = new Map();        // machineId -> [rebuild timestamps], survives resets and reconnects
  const unref = (t) => { if (t && t.unref) t.unref(); return t; };

  function handleUpgrade(req, socket, head) {
    let u; try { u = new URL(req.url, 'http://x'); } catch (_) { o.refuse(socket, 400); return; }
    if (u.pathname !== PATH) return o.refuse(socket, 404, JSON.stringify({ error: 'not_found' }));
    if (!o.serverToken()) return o.refuse(socket, 503, JSON.stringify({ error: 'not_secured' }));
    if (!o.authed(req, u)) return o.refuse(socket, 401, JSON.stringify({ error: 'unauthorized' }));
    return admit(req, socket, head, u).catch(() => o.refuse(socket, 500, JSON.stringify({ error: 'internal' })));
  }
  async function admit(req, socket, head, u) {
    const m = o.findMachine(u.searchParams.get('machine'));
    let ctx = null;
    if (o.policy) {
      ctx = { op: 'api', method: 'GET', path: PATH, machineId: m ? m.id : null, ...o.policy.ctx(req, u, m) };
      const refusal = await o.policy.authorize(req, u, ctx);
      if (refusal) return o.refuse(socket, refusal.status || 402, JSON.stringify(refusal.body || { error: 'plan_limit' }));
    }
    if (!m) return o.refuse(socket, 404, JSON.stringify({ error: 'no_machine' }));
    const display = Number(u.searchParams.get('display') || 1);
    if (!Number.isInteger(display) || display < 1 || display > 8) return o.refuse(socket, 400, JSON.stringify({ error: 'bad_display' }));
    let sess = null;
    const ws = o.accept(req, socket, head, { onHelloTimeout: (w) => w.close(1008, 'hello') });
    if (!ws) return;
    sess = attach(ws, { req, u, m, display, policyCtx: ctx });
    return sess;
  }

  /** Per-socket session. ctx: { req, u, m, display, policyCtx } */
  function attach(ws, ctx) {
    const m = ctx.m;
    if (byMachine.has(m.id)) {                            // §13.0: second open on the same machine
      try { ws.send(JSON.stringify({ t: 'fallback', reason: 'viewers' })); } catch (_) {}
      try { ws.close(1000, 'viewers'); } catch (_) {}
      return null;
    }
    const s = new EventEmitter();
    s.connId = crypto.randomBytes(8).toString('hex');
    s.machineId = m.id;
    let gen = 0, epoch = 0, hello = null, preHello = 0, dead = false;
    let stream = null, deframer = null, readySeen = false, nextGrant = 1;
    const grants = new Map();             // grantId -> { gen, emergency, seq|null }
    let lastSent = -1, watermark = -1, stallT = null, emergency = null, keyframeWaiting = null, kfTimes = [];
    let inputAllowed = false, inputWhy = null, plan = null, info = null, welcomeSent = false;
    let pendingInput = 0, batch = [], batchT = null;
    let queuedBytes = 0;
    const drain = createDrain(now, L.DRAIN_WINDOW_MS);
    byMachine.set(m.id, s);

    // Helper ops carry the display's CGDirectDisplayID (from bridge info) so the bridge picks the right helper.
    const opOut = (x) => bridge.op(m, info && info.displayId != null ? { ...x, displayId: info.displayId } : x);
    const text = (obj) => { if (!dead) try { ws.send(JSON.stringify(obj)); } catch (_) {} };

    // ---- input capability: all three gates, recomputed on every change (§13.2, §14.2) ----
    async function computeInput() {
      let why = null;
      if (o.policy) {
        const r = await o.policy.authorize(ctx.req, ctx.u, { ...(ctx.policyCtx || {}), op: 'api', method: 'POST', path: '/api/cmux/screen/tap' });
        const code = o.policy.plan ? o.policy.plan() : null;   // the plan code the policy decision ran on
        if (r) { why = { code: 'PLAN_LIMIT', body: r.body }; plan = { code: (r.body && r.body.details && r.body.details.plan) || code || 'free', remoteDesktop: 'view' }; }
        else plan = code ? { code, remoteDesktop: 'full' } : null;
      }
      if (!why && !(info && info.control)) why = { code: 'screen_disabled' };
      if (!why && !(info && info.axTrusted)) why = { code: 'screen_permission' };
      inputWhy = why;
      return !why;
    }
    function welcome() {
      welcomeSent = true;
      text({ t: 'welcome', v: 1, connId: s.connId, gen, codec: 'h264', display: ctx.display, w: info.w, h: info.h, displayW: info.displayW, displayH: info.displayH,
        fps: info.fps, inputAllowed, focusSecure: !!info.focusSecure, plan, serverTs: now() * 1000 });
    }
    s.onChange = async () => {           // policy decision / flag / AX change: new Welcome, stream not cut
      if (dead || !welcomeSent) return;
      try { info = { ...info, ...(await bridge.info(m, ctx.display)) }; } catch (_) {}
      const was = inputAllowed;
      inputAllowed = await computeInput();
      if (dead) return;
      if (was && !inputAllowed) bumpEpoch('revoked');
      if (was !== inputAllowed) welcome();
    };

    // ---- media generation ----
    function openStream() {
      if (stream) { try { stream.close(); } catch (_) {} }
      deframer = createDeframer({ onPacket: (p, h) => onPacket(p, h), onError: () => rebuild('stream_error') });
      const df = deframer;
      stream = bridge.open(m, { display: ctx.display, displayId: info && info.displayId, gen, epoch }, (chunk) => { if (!dead && df === deframer) df.push(chunk); }, () => {});
    }
    function startGen(reason) {
      gen++; readySeen = false; grants.clear(); lastSent = -1; watermark = -1; queuedBytes = 0;
      clearEmergency(); clearStall();
      text({ t: 'reset', gen, reason });
      openStream();
    }
    function rebuild(reason) {
      if (dead) return;
      const list = (recovery.get(m.id) || []).filter((t) => now() - t < L.RECOVERY_WINDOW_MS);
      list.push(now()); recovery.set(m.id, list);
      if (list.length > L.RECOVERY_MAX) return fallback('helper_failed');
      startGen(reason);
    }
    function fallback(reason) {
      if (dead) return;
      text({ t: 'fallback', reason });
      if (stream) { try { stream.close(); } catch (_) {} stream = null; }
      grants.clear(); clearEmergency(); clearStall();
      s.mediaStopped = reason;
    }

    // ---- grant ledger ----
    const charged = () => { let n = 0; for (const g of grants.values()) if (!g.emergency) n++; return n; };
    function replenish() {
      if (dead || !readySeen || !stream || s.mediaStopped) return;
      for (let n = L.WINDOW - charged(); n > 0; n--) {
        const grantId = nextGrant++;
        grants.set(grantId, { gen, emergency: false, seq: null });
        Promise.resolve(opOut({ op: 'grant', gen, grantId })).catch(() => {});
      }
    }
    function retire(grantId) { const g = grants.get(grantId); if (!g) return false; grants.delete(grantId); if (emergency && emergency.grantId === grantId) clearEmergency(); return true; }
    function armStall() {
      let unacked = false;
      for (const g of grants.values()) if (!g.emergency && g.seq != null && g.seq > watermark) unacked = true;
      if (!unacked) return clearStall();
      if (!stallT) stallT = unref(setT(() => { stallT = null; fallback('stalled'); }, L.STALL_MS));
    }
    function clearStall() { if (stallT) { clearT(stallT); stallT = null; } }
    function clearEmergency() { if (emergency) { clearT(emergency.t); emergency = null; } if (keyframeWaiting) { const r = keyframeWaiting; keyframeWaiting = null; requestKeyframe(r); } }
    function requestKeyframe(reason) {
      if (dead || s.mediaStopped || !stream) return;
      if (emergency) { keyframeWaiting = reason; return; }              // one slot; a second request waits
      const grantId = nextGrant++;
      grants.set(grantId, { gen, emergency: true, seq: null });
      const g0 = gen;
      emergency = { grantId, t: unref(setT(() => { if (emergency && emergency.grantId === grantId) { emergency = null; if (gen === g0) rebuild('emergency_timeout'); } }, L.EMERGENCY_MS)) };
      Promise.resolve(opOut({ op: 'keyframe', gen, grantId, emergency: true, reason })).catch(() => {});
    }

    // ---- send-queue admission (§16.1, §17.3) ----
    function admitBytes(n) {
      const measured = drain.kbps();
      const ctl = o.kbps ? o.kbps(m) : 4000;
      const rate = measured == null ? ctl : Math.min(ctl, measured);
      queuedBytes = ws.bufferedAmount || 0;
      return ((queuedBytes + n) * 8) / Math.max(rate, 1) <= L.QUEUE_MS;
    }
    function sendBin(p) { const before = ws.bufferedAmount || 0; try { ws.send(p); } catch (_) { return false; } drain.tick(ws.bufferedAmount || 0, (ws.bufferedAmount || 0) - before); return true; }

    function onPacket(p, h) {
      if (dead) return;
      if (h.type === T_META) {
        let meta = null; try { meta = JSON.parse(p.subarray(HEADER_LEN).toString('utf8')); } catch (_) {}
        return onMeta(meta || {});
      }
      if (h.type !== T_VIDEO) { if (!s.mediaStopped) sendBin(p); return; }
      if (h.gen !== gen || s.mediaStopped) return;                      // older generation: dropped
      const g = grants.get(h.grantId);
      if (!g || g.gen !== gen) return;                                  // unknown/retired grant
      if (!admitBytes(p.length)) {                                      // server-side drop retires the grant
        retire(h.grantId);
        if (g.emergency) return rebuild('bandwidth');
        requestKeyframe('drop'); replenish(); return;
      }
      g.seq = h.seq; lastSent = Math.max(lastSent, h.seq);
      sendBin(p);
      if (!g.emergency) armStall();
    }
    function onMeta(meta) {
      if (meta.kind === 'skipped') { if (meta.gen === gen && retire(meta.grantId)) replenish(); return; }
      if (meta.kind === 'posted') { pendingInput = Math.max(0, pendingInput - 1); if (meta.epoch === epoch) text({ t: 'posted', connId: s.connId, gen, epoch, seq: meta.seq }); return; }
      if (meta.kind === 'released') { if (meta.epoch === epoch) text({ t: 'released', connId: s.connId, gen, epoch }); return; }
      if (meta.kind === 'failed') { if (meta.epoch === epoch) bumpEpoch('failed'); return; }
      if (meta.kind === 'focus') { if (info) info.focusSecure = !!meta.focusSecure; text({ t: 'focus', connId: s.connId, focusSecure: !!meta.focusSecure }); }
    }
    function bumpEpoch(reason) {
      epoch++; pendingInput = 0; batch = []; if (batchT) { clearT(batchT); batchT = null; }
      text({ t: 'epoch', connId: s.connId, gen, epoch, reason });
      Promise.resolve(opOut({ op: 'release', epoch })).catch(() => {});
    }

    // ---- input ----
    function onInput(msg) {
      if (!inputAllowed) {
        const w = inputWhy || { code: 'screen_disabled' };
        if (w.code === 'PLAN_LIMIT') return text({ t: 'error', code: 'PLAN_LIMIT', seq: msg.seq, details: { limit: 'remoteDesktop', ...((w.body && w.body.details) || {}), plan: (plan && plan.code) || 'free' } });
        if (w.code === 'screen_permission') return text({ t: 'error', code: 'screen_permission', need: 'accessibility', seq: msg.seq });
        return text({ t: 'error', code: 'screen_disabled', flag: 'SCREEN_CONTROL', seq: msg.seq });
      }
      if (!Number.isInteger(msg.seq) || msg.seq < 1) return text({ t: 'error', code: 'bad_input' });
      const release = msg.t === 'mouse' && msg.type === 'up';
      if (pendingInput >= L.PENDING_INPUT && !release) return text({ t: 'error', code: 'rate_limited', seq: msg.seq });
      pendingInput++;
      batch.push(msg);
      if (batch.length >= L.BATCH_MAX || release) return flush();
      if (!batchT) batchT = unref(setT(flush, L.BATCH_MS));
    }
    function flush() {
      if (batchT) { clearT(batchT); batchT = null; }
      if (!batch.length || dead) return;
      const items = batch; batch = [];
      const e0 = epoch, g0 = gen;
      Promise.resolve(bridge.input(m, { gen: g0, epoch: e0, items })).then((r) => {
        if (dead || e0 !== epoch) return;                               // late answer of an older epoch
        if (r && r.status >= 400) bumpEpoch((r.body && r.body.error) || 'failed');
      }, () => { if (!dead && e0 === epoch) bumpEpoch('failed'); });
    }

    // ---- client messages ----
    async function onHello(msg) {
      ws.markHello && ws.markHello();
      hello = msg;
      try { info = await bridge.info(m, ctx.display); } catch (_) { info = null; }
      if (dead) return;
      if (!info) { fallback('helper_failed'); return; }
      inputAllowed = await computeInput();
      if (dead) return;
      gen = 1; readySeen = false; grants.clear();
      welcome();                                        // Welcome first, then reset{gen}; the client answers ready{gen}
      text({ t: 'reset', gen, reason: 'start' });
      openStream();
    }
    function onMessage(data, isBinary) {
      if (dead) return;
      if (isBinary) return ws.close(1003, 'binary');
      let msg; try { msg = JSON.parse(String(data)); } catch (_) { return text({ t: 'error', code: 'bad_input' }); }
      if (!msg || typeof msg.t !== 'string') return text({ t: 'error', code: 'bad_input' });
      if (!hello) {
        if (msg.t !== 'hello') { if (++preHello > L.PENDING_HELLO) ws.close(1008, 'hello'); return; }
        if (!validHello(msg)) return ws.close(1008, 'hello');
        hello = msg; onHello(msg); return;
      }
      switch (msg.t) {
        case 'ready': if (msg.gen === gen && !readySeen) { readySeen = true; replenish(); } return;
        case 'ack': {
          if (msg.gen !== gen || !Number.isInteger(msg.seq)) return;
          if (msg.seq > lastSent) return ws.close(1008, 'ack');
          if (msg.seq <= watermark) return;
          watermark = msg.seq; clearStall();
          for (const [id, g] of [...grants]) if (g.seq != null && g.seq <= watermark) retire(id);
          armStall(); replenish(); return;
        }
        case 'keyframe': {
          if (msg.gen !== undefined && msg.gen !== gen) return;
          kfTimes = kfTimes.filter((t) => now() - t < 1000);
          if (kfTimes.length >= L.KEYFRAME_PER_S) return text({ t: 'error', code: 'rate_limited' });
          kfTimes.push(now()); requestKeyframe(String(msg.reason || 'decode_error')); return;
        }
        case 'config': if (!validConfig(msg)) return ws.close(1008, 'config'); Promise.resolve(opOut({ op: 'rate', gen, ...msg, t: undefined })).catch(() => {}); return;
        case 'ping': return text({ t: 'pong', id: msg.id, clientTs: msg.clientTs, serverTs: now() * 1000 });
        default: if (INPUT_T.has(msg.t)) return onInput(msg);   // unknown t is ignored (forward compatible)
      }
    }

    // ---- lifecycle ----
    function cleanup(id) {
      if (id !== s.connId || dead) return false;
      dead = true;
      if (batchT) clearT(batchT); clearStall(); if (emergency) clearT(emergency.t); emergency = null; keyframeWaiting = null;
      grants.clear();
      if (stream) { try { stream.close(); } catch (_) {} stream = null; }
      if (byMachine.get(m.id) === s) byMachine.delete(m.id);
      s.emit('close');
      return true;
    }
    s.cleanup = cleanup;
    s.destroy = () => { try { ws.close(4401, 'policy'); } catch (_) {} cleanup(s.connId); };
    s.state = () => ({ connId: s.connId, gen, epoch, readySeen, outstanding: charged(), emergency: emergency && emergency.grantId, watermark, lastSent,
      inputAllowed, mediaStopped: s.mediaStopped || null, grants: [...grants.keys()] });
    ws.on('message', onMessage);
    ws.on('close', () => cleanup(s.connId));
    ws.on('error', () => cleanup(s.connId));
    if (o.policy && o.policy.track) o.policy.track(ctx.req, s, ctx.policyCtx, m.id);
    return s;
  }

  return { PATH, handleUpgrade, attach, session: (machineId) => byMachine.get(machineId) || null,
    cleanup: (connId) => { for (const s of byMachine.values()) if (s.connId === connId) return s.cleanup(connId); return false; },
    recoveryCount: (machineId) => (recovery.get(machineId) || []).filter((t) => now() - t < L.RECOVERY_WINDOW_MS).length };
}

// Bridge GET /cmux/screen/info answer -> what a session needs. Bridge shape (lib/mac-screen.js info()):
// { view, control, displays: [{ index, id, x, y, w, h, scale }] (CG global points), canControl (AX trusted), focusSecure }.
// display = 1-based NSScreen index; a display not present throws (the session falls back).
function screenInfoFromBridge(b, display) {
  const list = b && Array.isArray(b.displays) ? b.displays : [];
  const d = list.find((x) => x && x.index === display) || list[display - 1];
  if (!d || !(d.w > 0) || !(d.h > 0)) throw new Error('display_gone');
  const scale = d.scale > 0 ? d.scale : 1;
  const nativeW = Math.round(d.w * scale), nativeH = Math.round(d.h * scale);
  return { displayId: d.id >>> 0, w: nativeW, h: nativeH, displayW: nativeW, displayH: nativeH, fps: 30,
    ptsW: d.w, ptsH: d.h, originX: d.x || 0, originY: d.y || 0, scale,
    axTrusted: b.canControl === true, control: b.control === true, focusSecure: !!b.focusSecure };
}

module.exports = { screenInfoFromBridge, createScreenWs, createDrain, validHello, validConfig, LIMITS, PATH };
