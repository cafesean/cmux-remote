'use strict';
// Video Remote Desktop: server WebSocket endpoint (lib/screen-ws.js) with a stub bridge and a fake socket.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const { createScreenWs } = require('../lib/screen-ws');
const S = require('../lib/screen-stream');
const wsLib = require('../lib/ws');

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pkt = (h, payload = 'x') => S.frame(S.encodePacket(h, Buffer.from(payload)));
const meta = (o) => pkt({ type: 5, gen: 0 }, JSON.stringify(o));

function fakeWs() {
  const w = new EventEmitter();
  w.sent = []; w.closed = null; w.hello = false; w.bufferedAmount = 0;
  w.send = (d) => { w.sent.push(typeof d === 'string' ? JSON.parse(d) : { bin: d }); return true; };
  w.close = (code) => { if (w.closed) return; w.closed = code; w.emit('close', code); };
  w.markHello = () => { w.hello = true; };
  w.msg = (o) => w.emit('message', JSON.stringify(o), false);
  w.texts = (t) => w.sent.filter((x) => x.t === t);
  return w;
}
function stubBridge(over = {}) {
  const b = { ops: [], inputs: [], opens: [], closes: 0, info: { w: 1280, h: 800, displayW: 2560, displayH: 1600, fps: 30, axTrusted: true, control: true, focusSecure: false } };
  b.api = {
    open: (m, q, onChunk) => { b.opens.push(q); b.push = onChunk; return { close: () => { b.closes++; } }; },
    op: async (m, op) => { b.ops.push(op); },
    input: async (m, body) => { b.inputs.push(body); return over.inputStatus ? { status: over.inputStatus, body: {} } : { status: 200, body: { ok: true } }; },
    info: async () => ({ ...b.info }),
  };
  return b;
}
function policy(state) {   // state.plan: 'free' | 'pro'; state.refuseOpen
  return {
    authorize: async (req, u, ctx) => {
      if (ctx.method === 'GET' && state.refuseOpen) return { status: 402, body: { error: 'PLAN_LIMIT', details: { limit: 'devices' } } };
      if (ctx.method === 'POST' && state.plan === 'free') return { status: 402, body: { error: 'PLAN_LIMIT', details: { limit: 'remoteDesktop', plan: 'free' } } };
      state.seen = ctx; return null;
    },
    ctx: () => ({ cred: { kind: 'device' }, local: false, machineIds: ['m1'], keys: [] }),
    track: (req, s) => { state.sessions = (state.sessions || []); state.sessions.push(s); },
  };
}
function setup(o = {}) {
  const b = stubBridge(o);
  const pol = o.policy === null ? null : policy(o.state || { plan: 'pro' });
  const sw = createScreenWs({ serverToken: () => 'tok', authed: () => true, findMachine: (id) => (id === 'm1' ? { id: 'm1' } : null),
    accept: () => null, refuse: () => {}, policy: pol, bridge: b.api, kbps: () => o.kbps || 100000, limits: o.limits });
  return { b, sw };
}
const HELLO = { t: 'hello', v: 1, codecs: ['h264'], maxW: 1920, maxH: 1080, maxFps: 60, clientTs: 1 };
async function open(sw, ws = fakeWs(), extra = {}) {
  const s = sw.attach(ws, { req: {}, u: new URL('http://x/api/cmux/screen/ws?machine=m1'), m: { id: 'm1' }, display: 1, policyCtx: { cred: { kind: 'device' } }, ...extra });
  ws.msg(HELLO); await tick(); await tick();
  return { ws, s };
}
const video = (gen, seq, grantId, flags = 0) => pkt({ type: 1, flags, gen, seq, grantId }, 'frame' + seq);

test('gates: not_secured 503, bad key 401, unknown upgrade path 404, unknown machine 404; full policy context', async () => {
  let token = '', ok = false; const st = { plan: 'pro' };
  const pol = policy(st);
  const sw = createScreenWs({ serverToken: () => token, authed: () => ok, findMachine: (id) => (id === 'm1' ? { id: 'm1' } : null),
    accept: wsLib.accept, refuse: wsLib.refuse, policy: pol, bridge: stubBridge().api });
  const srv = http.createServer((q, r) => r.end()); srv.on('upgrade', (q, s, h) => sw.handleUpgrade(q, s, h));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const up = (path) => new Promise((res) => {
    const c = net.connect(port, '127.0.0.1', () => c.write('GET ' + path + ' HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + Buffer.alloc(16).toString('base64') + '\r\n\r\n'));
    let d = ''; c.on('data', (x) => { d += x; if (/\r\n\r\n/.test(d)) { c.destroy(); res(Number(d.split(' ')[1])); } }); c.on('error', () => res(0));
  });
  try {
    assert.strictEqual(await up('/api/cmux/screen/ws?machine=m1'), 503);
    token = 'tok';
    assert.strictEqual(await up('/api/cmux/screen/ws?machine=m1'), 401);
    ok = true;
    assert.strictEqual(await up('/api/other/ws'), 404);
    assert.strictEqual(await up('/api/cmux/screen/ws?machine=nope'), 404);
    st.refuseOpen = true;
    assert.strictEqual(await up('/api/cmux/screen/ws?machine=m1'), 402);
    st.refuseOpen = false;
    assert.strictEqual(await up('/api/cmux/screen/ws?machine=m1&display=1'), 101);
    for (const k of ['cred', 'local', 'method', 'path', 'machineId', 'machineIds', 'keys']) assert.ok(k in st.seen, 'policy ctx has ' + k);
    assert.strictEqual(st.seen.machineId, 'm1');
  } finally { srv.close(); }
});

test('Welcome {connId, gen, geometry, inputAllowed, focusSecure} then reset; valid hello ends the hello deadline', async () => {
  const { sw } = setup();
  const { ws, s } = await open(sw);
  const w = ws.texts('welcome')[0];
  assert.ok(ws.hello);
  assert.strictEqual(w.connId, s.connId); assert.strictEqual(w.gen, 1);
  assert.deepStrictEqual([w.w, w.h, w.displayW, w.displayH, w.inputAllowed, w.focusSecure], [1280, 800, 2560, 1600, true, false]);
  assert.deepStrictEqual(ws.texts('reset')[0].gen, 1);
  assert.ok(ws.sent.indexOf(w) < ws.sent.indexOf(ws.texts('reset')[0]));
});

test('Free: every input type -> PLAN_LIMIT remoteDesktop, nothing reaches the bridge; Pro: relayed', async () => {
  const st = { plan: 'free' };
  const { b, sw } = setup({ state: st });
  const { ws } = await open(sw);
  assert.strictEqual(ws.texts('welcome')[0].inputAllowed, false);
  const items = [{ t: 'mouse', seq: 1, type: 'move', fx: 0.1, fy: 0.1 }, { t: 'tap', seq: 2, fx: 0.5, fy: 0.5 }, { t: 'scroll', seq: 3, dy: 5 }, { t: 'type', seq: 4, text: 'a' }, { t: 'key', seq: 5, key: 'enter' }];
  for (const it of items) ws.msg(it);
  await wait(20);
  assert.strictEqual(b.inputs.length, 0);
  const errs = ws.texts('error');
  assert.strictEqual(errs.length, 5);
  for (const e of errs) { assert.strictEqual(e.code, 'PLAN_LIMIT'); assert.strictEqual(e.details.limit, 'remoteDesktop'); }
  const pro = setup({ state: { plan: 'pro' } });
  const p = await open(pro.sw);
  for (const it of items) p.ws.msg(it);
  await wait(20);
  assert.deepStrictEqual(pro.b.inputs.flatMap((x) => x.items.map((i) => i.t)), ['mouse', 'tap', 'scroll', 'type', 'key']);
});

test('policy change on an open socket: Free->Pro and Pro->Free re-send Welcome, stream not cut; AX lost keeps input off', async () => {
  const st = { plan: 'free' };
  const { b, sw } = setup({ state: st });
  const { ws, s } = await open(sw);
  st.plan = 'pro'; await s.onChange();
  assert.strictEqual(ws.texts('welcome').at(-1).inputAllowed, true);
  b.info.axTrusted = false; await s.onChange();
  assert.strictEqual(ws.texts('welcome').at(-1).inputAllowed, false);
  assert.ok(ws.texts('epoch').length >= 1, 'losing input bumps the epoch');
  b.info.axTrusted = true; await s.onChange();
  assert.strictEqual(ws.texts('welcome').at(-1).inputAllowed, true);
  b.info.control = false; await s.onChange();
  assert.strictEqual(ws.texts('welcome').at(-1).inputAllowed, false);
  b.info.control = true; st.plan = 'free'; b.info.axTrusted = false; await s.onChange();
  st.plan = 'pro'; await s.onChange();   // Free->Pro with AX missing stays false
  assert.strictEqual(ws.texts('welcome').at(-1).inputAllowed, false);
  assert.strictEqual(b.closes, 0); assert.strictEqual(ws.closed, null);
  s.destroy();   // revoke / key replace / device paused / machine dropped -> policy close
  assert.strictEqual(ws.closed, 4401);
});

test('second open on the same machine -> Fallback{viewers}; first stream unaffected', async () => {
  const { b, sw } = setup();
  const a = await open(sw);
  const ws2 = fakeWs();
  const s2 = sw.attach(ws2, { req: {}, u: new URL('http://x/'), m: { id: 'm1' }, display: 2 });
  assert.strictEqual(s2, null);
  assert.deepStrictEqual(ws2.texts('fallback')[0], { t: 'fallback', reason: 'viewers' });
  assert.ok(ws2.closed);
  assert.strictEqual(a.ws.closed, null); assert.strictEqual(b.closes, 0);
  assert.strictEqual(sw.session('m1'), a.s);
});

test('cleanup(connId) idempotent, retires every gen, never another connId', async () => {
  const { b, sw } = setup();
  const { ws, s } = await open(sw);
  let closes = 0; s.on('close', () => closes++);
  assert.strictEqual(sw.cleanup('other'), false);
  assert.strictEqual(sw.session('m1'), s);
  ws.emit('close', 1000); ws.emit('error', new Error('x'));
  assert.strictEqual(s.cleanup(s.connId), false);
  s.destroy();
  assert.strictEqual(closes, 1); assert.strictEqual(b.closes, 1);
  assert.strictEqual(sw.session('m1'), null);
  assert.deepStrictEqual(s.state().grants, []);
  const n = await open(sw);   // a replacement is untouched by a late cleanup of the old one
  s.cleanup(s.connId);
  assert.strictEqual(sw.session('m1'), n.s);
});

test('grant ledger: ready once sets 2; ack watermark retires; duplicate/older/other-gen acks ignored; ack above sent closes 1008', async () => {
  const { b, sw } = setup();
  const { ws, s } = await open(sw);
  assert.strictEqual(b.ops.filter((o) => o.op === 'grant').length, 0, 'nothing granted before ready');
  ws.msg({ t: 'ready', gen: 1 }); ws.msg({ t: 'ready', gen: 1 });
  let grants = b.ops.filter((o) => o.op === 'grant');
  assert.strictEqual(grants.length, 2);
  b.push(video(1, 1, grants[0].grantId, 1)); b.push(video(1, 2, grants[1].grantId));
  assert.strictEqual(ws.sent.filter((x) => x.bin).length, 2);
  assert.strictEqual(s.state().outstanding, 2);
  ws.msg({ t: 'ack', gen: 2, seq: 2 }); ws.msg({ t: 'ack', gen: 1, seq: 1 });
  assert.strictEqual(b.ops.filter((o) => o.op === 'grant').length, 3, 'replenish 2 - outstanding');
  ws.msg({ t: 'ack', gen: 1, seq: 1 }); ws.msg({ t: 'ack', gen: 1, seq: 0 });
  assert.strictEqual(b.ops.filter((o) => o.op === 'grant').length, 3);
  b.push(meta({ kind: 'skipped', gen: 1, grantId: b.ops.at(-1).grantId })); b.push(meta({ kind: 'skipped', gen: 1, grantId: b.ops.at(-1).grantId }));
  assert.ok(s.state().outstanding <= 2);
  ws.msg({ t: 'ack', gen: 1, seq: 99 });
  assert.strictEqual(ws.closed, 1008);
});

test('stall counts only sent, unprocessed video: idle grants never fall back; unacked sent video -> Fallback{stalled}', async () => {
  const { b, sw } = setup({ limits: { STALL_MS: 40 } });
  const { ws } = await open(sw);
  ws.msg({ t: 'ready', gen: 1 });
  await wait(80);
  assert.strictEqual(ws.texts('fallback').length, 0, 'static screen: grants idle, no fallback');
  b.push(video(1, 1, b.ops.find((o) => o.op === 'grant').grantId, 1));
  await wait(80);
  assert.deepStrictEqual(ws.texts('fallback')[0], { t: 'fallback', reason: 'stalled' });
});

test('emergency keyframe: one slot outside the window, carries its grant; unacked -> gen reset; keyframe <= 2/s', async () => {
  const { b, sw } = setup({ limits: { EMERGENCY_MS: 40, STALL_MS: 10000 } });
  const { ws, s } = await open(sw);
  ws.msg({ t: 'ready', gen: 1 });
  ws.msg({ t: 'keyframe', reason: 'decode_error', gen: 1 });
  ws.msg({ t: 'keyframe', reason: 'decode_error', gen: 1 });   // waits for the slot
  ws.msg({ t: 'keyframe', reason: 'decode_error', gen: 1 });   // over 2/s
  const kf = b.ops.filter((o) => o.op === 'keyframe');
  assert.strictEqual(kf.length, 1); assert.strictEqual(kf[0].emergency, true); assert.ok(kf[0].grantId);
  assert.strictEqual(s.state().outstanding, 2, 'emergency is not charged');
  assert.strictEqual(ws.texts('error').filter((e) => e.code === 'rate_limited').length, 1);
  b.push(video(1, 1, kf[0].grantId, 1));
  await wait(80);
  assert.strictEqual(ws.texts('reset').at(-1).gen, 2, 'unacked emergency resets the gen');
  assert.strictEqual(b.opens.at(-1).gen, 2);
  assert.strictEqual(sw.recoveryCount('m1'), 1);
});

test('recovery rebuilds <= 3 per 10 s, then Fallback{helper_failed}; counter per machine survives resets', async () => {
  const { b, sw } = setup();
  const { ws } = await open(sw);
  for (let i = 0; i < 4; i++) b.push(Buffer.from([0, 0, 0, 1]));   // bad frame length -> stream error -> rebuild
  await tick();
  assert.ok(ws.texts('reset').length >= 2);
  assert.deepStrictEqual(ws.texts('fallback').at(-1), { t: 'fallback', reason: 'helper_failed' });
  assert.strictEqual(sw.recoveryCount('m1'), 4);
});

test('epoch: posted/released carry connId+gen+epoch; older-epoch answers ignored; failed bumps the epoch', async () => {
  const { b, sw } = setup();
  const { ws, s } = await open(sw);
  ws.msg({ t: 'mouse', seq: 1, type: 'down', fx: 0.1, fy: 0.1 }); ws.msg({ t: 'mouse', seq: 2, type: 'up', fx: 0.1, fy: 0.1 });
  await tick();
  b.push(meta({ kind: 'posted', epoch: 0, seq: 2 }));
  assert.deepStrictEqual(ws.texts('posted')[0], { t: 'posted', connId: s.connId, gen: 1, epoch: 0, seq: 2 });
  b.push(meta({ kind: 'failed', epoch: 0, seq: 3, why: 'x' }));
  assert.deepStrictEqual(ws.texts('epoch')[0], { t: 'epoch', connId: s.connId, gen: 1, epoch: 1, reason: 'failed' });
  assert.ok(b.ops.some((o) => o.op === 'release' && o.epoch === 1));
  b.push(meta({ kind: 'posted', epoch: 0, seq: 4 })); b.push(meta({ kind: 'released', epoch: 0 }));
  assert.strictEqual(ws.texts('posted').length, 1); assert.strictEqual(ws.texts('released').length, 0);
  b.push(meta({ kind: 'released', epoch: 1 }));
  assert.deepStrictEqual(ws.texts('released')[0], { t: 'released', connId: s.connId, gen: 1, epoch: 1 });
});

test('revoke during a delayed POST: late answer of the older epoch is ignored', async () => {
  const b = stubBridge(); let resolveIn;
  b.api.input = (m, body) => { b.inputs.push(body); return new Promise((r) => { resolveIn = r; }); };
  const st = { plan: 'pro' };
  const sw = createScreenWs({ serverToken: () => 'tok', authed: () => true, findMachine: () => ({ id: 'm1' }), accept: () => null, refuse: () => {}, policy: policy(st), bridge: b.api, kbps: () => 1e5 });
  const { ws, s } = await open(sw);
  ws.msg({ t: 'mouse', seq: 1, type: 'up', fx: 0.1, fy: 0.1 });
  st.plan = 'free'; await s.onChange();
  const epochs = ws.texts('epoch').length;
  resolveIn({ status: 409, body: { error: 'stale' } }); await tick();
  assert.strictEqual(ws.texts('epoch').length, epochs, 'older-epoch answer does not bump again');
  ws.msg({ t: 'mouse', seq: 2, type: 'down', fx: 0.1, fy: 0.1 }); await wait(20);
  assert.strictEqual(b.inputs.length, 1, 'nothing posted after release');
});

test('limits: pending-Hello 4, Hello validation, Config validation, pending input 64 with up always passing', async () => {
  const { sw } = setup();
  const ws = fakeWs();
  sw.attach(ws, { req: {}, u: new URL('http://x/'), m: { id: 'm1' }, display: 1 });
  for (let i = 0; i < 4; i++) ws.msg({ t: 'ping', id: i });
  assert.strictEqual(ws.closed, null);
  ws.msg({ t: 'ping', id: 5 });
  assert.strictEqual(ws.closed, 1008);
  const s2 = setup(); const w2 = fakeWs(); s2.sw.attach(w2, { req: {}, u: new URL('http://x/'), m: { id: 'm1' }, display: 1 });
  w2.msg({ ...HELLO, maxFps: 24 });
  assert.strictEqual(w2.closed, 1008);
  const s3 = setup(); const o3 = await open(s3.sw);
  o3.ws.msg({ t: 'config', maxW: -1 });
  assert.strictEqual(o3.ws.closed, 1008);
  const s4 = setup(); const o4 = await open(s4.sw);
  for (let i = 1; i <= 70; i++) o4.ws.msg({ t: 'mouse', seq: i, type: 'move', fx: 0.1, fy: 0.1 });
  o4.ws.msg({ t: 'mouse', seq: 71, type: 'up', fx: 0.1, fy: 0.1 });
  await wait(20);
  assert.strictEqual(o4.ws.texts('error').filter((e) => e.code === 'rate_limited').length, 6);
  assert.ok(s4.b.inputs.flatMap((x) => x.items).some((i) => i.seq === 71), 'up always goes');
});

test('send-queue admission: a P-frame over the byte budget is dropped, its grant retired, an IDR requested', async () => {
  const { b, sw } = setup({ kbps: 8 });   // 8 kbps x 400 ms = 400 bytes
  const { ws, s } = await open(sw);
  ws.msg({ t: 'ready', gen: 1 });
  ws.bufferedAmount = 10000;
  const g = b.ops.find((o) => o.op === 'grant');
  b.push(video(1, 1, g.grantId));
  assert.strictEqual(ws.sent.filter((x) => x.bin).length, 0);
  assert.ok(!s.state().grants.includes(g.grantId));
  assert.ok(b.ops.some((o) => o.op === 'keyframe'));
});
