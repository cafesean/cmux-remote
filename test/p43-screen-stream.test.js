'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/screen-stream');

const pkt = (type, gen, payload) => S.encodePacket({ type, gen, seq: 1 }, payload);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(10); } };

test('deframer: split at every byte and coalesced; 1.5 MiB IDR', () => {
  const ps = [pkt(1, 1, Buffer.from('cfg')), pkt(1, 1, Buffer.alloc(1536 * 1024, 7)), pkt(4, 1, Buffer.alloc(13)), pkt(5, 1, Buffer.from('{}'))];
  const all = Buffer.concat(ps.map(S.frame));
  for (const step of [4093, 65536, all.length]) {
    const got = [];
    const d = S.createDeframer({ onPacket: (p, h) => got.push([p.length, h.type]), onError: (e) => assert.fail(e) });
    for (let i = 0; i < all.length; i += step) d.push(all.subarray(i, i + step));
    assert.deepStrictEqual(got, ps.map((p) => [p.length, p[0]]));
  }
  const small = Buffer.concat([ps[0], ps[2], ps[3]].map(S.frame));
  for (let cut = 1; cut < small.length; cut++) {
    let n = 0;
    const d = S.createDeframer({ onPacket: () => n++, onError: (e) => assert.fail(e) });
    d.push(small.subarray(0, cut)); d.push(small.subarray(cut));
    assert.strictEqual(n, 3);
  }
});

test('deframer: L < 42, L > 4 MiB, length mismatch -> stream error', () => {
  for (const L of [41, 4 * 1024 * 1024 + 1]) {
    let err = null; const b = Buffer.alloc(4); b.writeUInt32BE(L);
    S.createDeframer({ onPacket: () => assert.fail('packet'), onError: (e) => { err = e; } }).push(b);
    assert.ok(err, 'error for L=' + L);
  }
  const p = pkt(1, 1, Buffer.from('abcd')); p.writeUInt32BE(9, 38);
  let err = null; S.createDeframer({ onPacket: () => assert.fail('packet'), onError: (e) => { err = e; } }).push(S.frame(p));
  assert.match(err.message, /length_mismatch/);
});

test('compiled lookup: SCREEN_STREAM_BIN or execPath dir only; missing -> helper_missing, swift never run', () => {
  const run = () => assert.fail('swift invoked');
  assert.deepStrictEqual(S.helperLookup({ env: {}, compiled: true, execPath: '/nope/hypermux', exists: () => false, run }), { error: 'helper_missing' });
  assert.deepStrictEqual(S.helperLookup({ env: {}, compiled: true, execPath: '/a/hypermux', exists: (p) => p === '/a/hm-screen-stream', run }), { bin: '/a/hm-screen-stream' });
  assert.deepStrictEqual(S.helperLookup({ env: { SCREEN_STREAM_BIN: '/x/h' }, compiled: true, exists: (p) => p === '/x/h', run }), { bin: '/x/h' });
  assert.deepStrictEqual(S.helperLookup({ env: { SCREEN_STREAM_BIN: '/x/h' }, compiled: false, exists: () => false, run }), { error: 'helper_missing' });
});

test('dev lookup: swift build -c debug --package-path <repo>/native/hyprmux-bridge --product hm-screen-stream from __dirname', () => {
  const calls = [];
  const r = S.helperLookup({ env: {}, compiled: false, exists: () => true, run: (c, a) => { calls.push([c, ...a].join(' ')); return '/bin/dir\n'; } });
  const pkg = path.join(__dirname, '..', 'native', 'hyprmux-bridge');
  assert.deepStrictEqual(calls, [
    'swift build -c debug --package-path ' + pkg + ' --product hm-screen-stream',
    'swift build -c debug --package-path ' + pkg + ' --product hm-screen-stream --show-bin-path']);
  assert.deepStrictEqual(r, { bin: '/bin/dir/hm-screen-stream' });
});

test('possiblyHeld per press id: down(1), up(2), down(3), posted-up(2) -> still held', () => {
  const h = S.createHeld();
  h.forward({ seq: 1, t: 'mouse', kind: 'down' }); h.forward({ seq: 2, t: 'mouse', kind: 'up' }); h.forward({ seq: 3, t: 'mouse', kind: 'down' });
  h.posted(2);
  assert.deepStrictEqual(h.parts(), ['left']);
  h.forward({ seq: 4, t: 'mouse', kind: 'up' }); h.posted(4);
  assert.ok(h.empty());
});

test('possiblyHeld: enters on forward, leaves only on posted-up; compound key counts per part', () => {
  const h = S.createHeld();
  h.forward({ seq: 5, t: 'key', key: 'c', mods: ['cmd'] });
  assert.deepStrictEqual(h.parts().sort(), ['cmd', 'key:c']);
  h.posted(99); assert.ok(!h.empty());
  h.posted(5); assert.ok(h.empty());
});

// fake helper: SCREEN_STREAM_BIN points at a shell wrapper around test/fixtures/p43-fake-helper.js (no capture, no input)
function fakeHelper(dir, behaviour) {
  const p = path.join(dir, 'hm-screen-stream');
  const fx = path.join(__dirname, 'fixtures', 'p43-fake-helper.js');
  fs.writeFileSync(p, '#!/bin/sh\nFAKE_HELPER_MODE=' + behaviour + ' exec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(fx) + '\n', { mode: 0o755 });
  return p;
}
const sink = () => { const s = { got: [], write: (b) => s.got.push(b) }; return s; };
const metas = (s) => s.got.flatMap((b) => { const d = []; S.createDeframer({ onPacket: (p, h) => { if (h.type === 5) d.push(JSON.parse(p.subarray(42))); }, onError: () => {} }).push(b); return d; });

function mk(behaviour, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p43ss-'));
  const bin = fakeHelper(dir, behaviour);
  return S.createScreenStream({ lookup: () => S.helperLookup({ env: { SCREEN_STREAM_BIN: bin } }),
    flags: { view: true, control: true }, log: () => {}, releaseRetryMs: 30, focusPollMs: 20, stopAfterMs: 50, backoffMs: [20], ...over });
}

test('helper missing -> helper_missing fallback; flags off -> screen_disabled; D253 -> never spawns', async () => {
  const ss = S.createScreenStream({ lookup: () => ({ error: 'helper_missing' }), flags: { view: true, control: true }, log: () => {} });
  assert.strictEqual(ss.attach(1, 1, sink()).error, 'helper_missing');
  const off = S.createScreenStream({ spawn: () => assert.fail('spawned'), flags: { view: false, control: false }, log: () => {} });
  assert.strictEqual(off.attach(1, 1, sink()).error, 'screen_disabled');
  assert.strictEqual((await off.input({ gen: 1, epoch: 1, items: [] })).body.flag, 'SCREEN_CONTROL');
  const d253 = S.createScreenStream({ spawn: () => assert.fail('spawned'), flags: { view: true, control: true }, captureBlocked: () => true, log: () => {} });
  assert.strictEqual(d253.attach(1, 1, sink()).need, 'screen_recording');
});

test('JPEG->video: input opens only after JXA release succeeds; noax -> off + retry; JPEG input refused while video owns control', async (t) => {
  const answers = ['noax', 'ok'];
  let idleWaited = false;
  const ss = mk('ok', { jxaRelease: async () => answers.shift() || 'ok', jpegIdle: async () => { idleWaited = true; } });
  t.after(() => ss.stopAll());
  assert.ok(ss.attach(7, 1, sink()).ok);
  const first = await ss.openControl(7, 1, 1);
  assert.ok(idleWaited);
  assert.deepStrictEqual(first, { ok: false, reason: 'screen_permission' });
  assert.strictEqual((await ss.input({ gen: 1, epoch: 1, items: [] })).status, 409);
  assert.strictEqual(ss.jpegInputAllowed(), false);
  await tick(80);
  assert.strictEqual(ss.state().control.open, true);
  assert.strictEqual((await ss.input({ gen: 1, epoch: 1, items: [{ seq: 1, t: 'mouse', kind: 'move', fx: 0.5, fy: 0.5 }] })).status, 200);
  assert.strictEqual((await ss.input({ gen: 2, epoch: 1, items: [] })).status, 409, 'stale gen');
  assert.strictEqual((await ss.input({ gen: 1, epoch: 0, items: [] })).status, 409, 'old epoch');
});

test('helper exits before released -> JXA release + released; AX denied -> kept, blocked, retried', async (t) => {
  const answers = ['ok', 'noax', 'noax', 'ok'];   // first = the JPEG->video proof
  const ss = mk('die_on_input', { jxaRelease: async () => answers.shift() || 'ok' });
  t.after(() => ss.stopAll());
  const s = sink(); ss.attach(3, 1, s);
  assert.ok((await ss.openControl(3, 1, 1)).ok);
  await ss.input({ gen: 1, epoch: 1, items: [{ seq: 1, t: 'mouse', kind: 'down', fx: 0.1, fy: 0.1 }] });
  assert.ok(!ss.held.empty(), 'possiblyHeld on forward');
  await until(() => ss.state().releasePending);
  assert.strictEqual(ss.state().releasePending, true, 'blocked while AX denied');
  assert.ok(!ss.held.empty(), 'held survives helper death');
  assert.strictEqual(ss.jpegInputAllowed(), false);
  await until(() => !ss.state().releasePending);
  assert.ok(ss.held.empty());
  assert.ok(metas(s).some((m) => m.kind === 'released' && m.by === 'bridge'));
});

test('focusSecure: type 5 meta on change while the image is static', async (t) => {
  const seq = [false, false, true, true, false];
  const ss = mk('ok', { jxaRelease: async () => 'ok', focusSecure: async () => (seq.length > 1 ? seq.shift() : seq[0]) });
  t.after(() => ss.stopAll());
  const s = sink(); ss.attach(2, 1, s);
  await ss.openControl(2, 1, 1);
  await until(() => metas(s).filter((m) => m.kind === 'focus').length >= 3);
  assert.deepStrictEqual(metas(s).filter((m) => m.kind === 'focus').map((m) => m.focusSecure), [false, true, false]);
});

test('helper posted meta clears possiblyHeld; helper stops after the last viewer (scaled 10 s)', async (t) => {
  const ss = mk('ok', { jxaRelease: async () => 'ok' });
  t.after(() => ss.stopAll());
  const a = ss.attach(4, 1, sink());
  await ss.openControl(4, 1, 1);
  await ss.input({ gen: 1, epoch: 1, items: [{ seq: 1, t: 'mouse', kind: 'down' }, { seq: 2, t: 'mouse', kind: 'up' }] });
  await until(() => ss.held.empty());
  a.detach();
  assert.deepStrictEqual(ss.state().helpers, [4]);
  await until(() => ss.state().helpers.length === 0);
});

test("bridge reports the helper start: 'started' meta for this gen after attach (not inside it), and to a viewer joining a running helper", async (t) => {
  const ss = mk('ok');
  t.after(() => ss.stopAll());
  const a = sink();
  assert.ok(ss.attach(9, 4, a).ok);
  assert.strictEqual(a.got.length, 0, 'nothing written synchronously: the route writes its head first');
  await until(() => metas(a).some((m) => m.kind === 'started'));
  assert.deepStrictEqual(metas(a).find((m) => m.kind === 'started'), { kind: 'started', displayId: 9, gen: 4 });
  const b = sink();
  assert.ok(ss.attach(9, 5, b).ok);
  assert.strictEqual(b.got.length, 0);
  await until(() => metas(b).some((m) => m.kind === 'started'));
  assert.strictEqual(metas(b).find((m) => m.kind === 'started').gen, 5);
});

test('k191: a new viewer gen on a running helper moves the helper to that gen, so clicks are not stale', async (t) => {
  const logs = [];
  const ss = mk('ok', { jxaRelease: async () => 'ok', log: (l) => logs.push(l) });
  t.after(() => ss.stopAll());
  const a = sink();
  const first = ss.attach(9, 1, a);
  assert.ok((await ss.openControl(9, 1, 1)).ok);
  assert.strictEqual((await ss.input({ gen: 1, epoch: 1, items: [{ seq: 1, t: 'mouse', kind: 'down', fx: 0.5, fy: 0.5 }] })).status, 200);
  await until(() => metas(a).some((m) => m.kind === 'posted' && m.seq === 1));
  // screen-ws downscale: a new stream at gen 2 replaces the old one while the helper keeps running
  const b = sink();
  assert.ok(ss.attach(9, 2, b).ok);
  first.detach();
  assert.ok((await ss.openControl(9, 2, 2)).ok);
  await until(() => metas(b).some((m) => m.kind === 'started' && m.gen === 2));
  assert.strictEqual((await ss.input({ gen: 2, epoch: 2, items: [{ seq: 2, t: 'mouse', kind: 'up', fx: 0.5, fy: 0.5 }] })).status, 200);
  await until(() => metas(b).some((m) => (m.kind === 'posted' || m.kind === 'failed') && m.seq === 2));
  assert.ok(!metas(b).some((m) => m.kind === 'failed' && m.why === 'stale'), 'no stale refusal after the gen change');
  assert.ok(logs.some((l) => /helper gen -> 2/.test(l)));
});
