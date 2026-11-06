'use strict';
// p41 D133 — sends survive a load spike on the bridge machine: a /cmux/send relay that times out
// (or hits a transient error) is queued per (machine, surface) and retried with backoff; the bridge
// dedupes by sendId so a retry of a send that DID type never types again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootServer } = require('./helpers/server-boot');
const { bootBridge } = require('./helpers/bridge-child');
const { createSendQueue, LIMITS } = require('../lib/send-queue');

const tick = () => new Promise((r) => setImmediate(r));
async function flush(n = 5) { for (let i = 0; i < n; i++) await tick(); }

// A controllable clock + timer list for the queue unit tests.
function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    async advance(ms) {
      t += ms;
      for (const h of timers.splice(0).sort((a, b) => a.at - b.at)) { if (h.at <= t) h.fn(); else timers.push(h); }
      await flush();
    },
    pending: () => timers.length,
  };
}
const timeoutErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const transient = (out) => (out.error ? { retry: true, cause: 'timeout' } : { retry: [502, 503, 504].includes(out.result.status) && !(out.result.body && out.result.body.error), cause: 'http_' + out.result.status });

test('D133 queue: a timed-out send answers 202, is retried with backoff and delivered in FIFO order', async () => {
  const c = clock();
  const log = [];
  let failsLeft = 2;
  const q = createSendQueue({ now: c.now, setTimer: c.setTimer, transient, attempt: async (it) => {
    log.push(`${it.sendId}#${it.attempts}`);
    if (it.sendId === 'id-aaaaaaaa' && failsLeft-- > 0) throw timeoutErr();
    return { status: 200, body: { ok: true } };
  } });
  const a = q.submit({ machine: 'm', surface: 's1', sendId: 'id-aaaaaaaa', payload: {} });
  assert.deepEqual(await a, { queued: true });
  const b = await q.submit({ machine: 'm', surface: 's1', sendId: 'id-bbbbbbbb', payload: {} });
  assert.deepEqual(b, { queued: true });            // behind a retrying head -> 202 at once
  assert.equal(q.get('m', 'id-aaaaaaaa').state, 'queued');
  assert.equal(q.get('m', 'id-aaaaaaaa').error, 'timeout');
  // Another surface is not held up.
  const other = await q.submit({ machine: 'm', surface: 's2', sendId: 'id-cccccccc', payload: {} });
  assert.equal(other.result.status, 200);
  await c.advance(LIMITS.backoffMs[0]);             // attempt 2 at +2 s: still fails
  assert.deepEqual(log, ['id-aaaaaaaa#1', 'id-cccccccc#1', 'id-aaaaaaaa#2']);
  await c.advance(LIMITS.backoffMs[0]);             // not yet: backoff is now 4 s
  assert.equal(log.length, 3);
  await c.advance(LIMITS.backoffMs[1] - LIMITS.backoffMs[0]);
  assert.deepEqual(log.slice(3), ['id-aaaaaaaa#3', 'id-bbbbbbbb#1']);
  assert.deepEqual(q.get('m', 'id-aaaaaaaa'), { state: 'sent', attempts: 3 });
  assert.deepEqual(q.get('m', 'id-bbbbbbbb'), { state: 'sent', attempts: 1 });
  assert.equal(q.get('m', 'nope-nope-nope'), null);
});

test('D133 queue: a delivered-first-time send answers its result; a non-transient error is not retried', async () => {
  const c = clock();
  let n = 0;
  const q = createSendQueue({ now: c.now, setTimer: c.setTimer, transient, attempt: async () => { n++; return { status: 502, body: { error: 'text_command_unconfirmed' } }; } });
  const r = await q.submit({ machine: 'm', surface: 's', sendId: 'id-xxxxxxxx', payload: {} });
  assert.equal(r.result.status, 502);
  assert.equal(c.pending(), 0);
  assert.equal(n, 1);
  assert.deepEqual(q.get('m', 'id-xxxxxxxx'), { state: 'failed', attempts: 1, error: 'text_command_unconfirmed' });
});

test('D133 queue: max age -> failed (expired), and the next send runs', async () => {
  const c = clock();
  const q = createSendQueue({ now: c.now, setTimer: c.setTimer, transient, attempt: async (it) => {
    if (it.sendId === 'id-stuckkkk') throw timeoutErr();
    return { status: 200, body: { ok: true } };
  } });
  await q.submit({ machine: 'm', surface: 's', sendId: 'id-stuckkkk', payload: {} });
  await q.submit({ machine: 'm', surface: 's', sendId: 'id-nextnext', payload: {} });
  for (let i = 0; i < 400 && c.pending(); i++) await c.advance(1000);
  const st = q.get('m', 'id-stuckkkk');
  assert.equal(st.state, 'failed');
  assert.equal(st.error, 'expired');
  assert.equal(st.attempts, 7);   // at 0, +2, 6, 14, 30, 60, 90 s; the next would land on the 120 s max age -> expired
  // The second send also waited past 120 s from ITS submit -> expired without an attempt.
  assert.equal(q.get('m', 'id-nextnext').state, 'failed');
  assert.equal(q.get('m', 'id-nextnext').attempts, 0);
});

test('D133 queue: more than 20 per surface -> full (429); a repeat of a queued id is not queued twice', async () => {
  const c = clock();
  const q = createSendQueue({ now: c.now, setTimer: c.setTimer, transient, attempt: async () => { throw timeoutErr(); } });
  for (let i = 0; i < LIMITS.perSurfaceMax; i++) {
    assert.deepEqual(await q.submit({ machine: 'm', surface: 's', sendId: `id-${String(i).padStart(8, '0')}`, payload: {} }), { queued: true });
  }
  assert.deepEqual(await q.submit({ machine: 'm', surface: 's', sendId: 'id-overflow', payload: {} }), { full: true });
  assert.deepEqual(await q.submit({ machine: 'm', surface: 's', sendId: 'id-00000003', payload: {} }), { queued: true });
  assert.equal(q.size('m', 's'), LIMITS.perSurfaceMax);
  assert.deepEqual(await q.submit({ machine: 'm', surface: 'other', sendId: 'id-overflow', payload: {} }), { queued: true });
});

// ---- route: real server.js child, stub bridge -------------------------------------------------

function stubBridge(plan) {
  const seen = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/cmux/send')) { res.writeHead(404); return res.end('{}'); }
      const b = JSON.parse(body);
      seen.push(b);
      const step = plan(n++, b);
      if (step === 'hang') return;   // the server's relay timeout fires
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(step.body));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    seen, base: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((c) => { srv.closeAllConnections(); srv.close(() => c()); }),
  })));
}
const post = async (base, body) => {
  const r = await fetch(`${base}/api/cmux/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const statusOf = async (base, id) => {
  const r = await fetch(`${base}/api/cmux/send/status?machine=default&sendId=${id}`);
  return { status: r.status, body: await r.json() };
};
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd133-')), 'send-ids.json');

test('D133 route: timeout -> 202 queued -> retried with the same sendId -> status sent; unknown -> 404', async (t) => {
  const up = await stubBridge((i) => (i === 0 ? 'hang' : { status: 200, body: { ok: true } }));
  const env = { CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: 'd133-secret', PUSH_ENABLED: '0', SEND_IDS_FILE: tmpFile(),
    SEND_RELAY_TIMEOUT_MS: '300', SEND_QUEUE_BACKOFF_MS: '200,200' };
  const srv = await bootServer({ env });
  t.after(async () => { await srv.stop(); await up.close(); });
  const id = 'dddddddd-1333-4333-8333-333333333333';
  const a = await post(srv.base, { surface: 's1', text: 'hi', submit: true, sendId: id });
  assert.equal(a.status, 202);
  assert.deepEqual(a.body, { queued: true, sendId: id });
  const again = await post(srv.base, { surface: 's1', text: 'hi', submit: true, sendId: id });
  assert.equal(again.status, 202);                    // app retry while queued: not queued twice
  let st;
  for (let i = 0; i < 40; i++) { st = await statusOf(srv.base, id); if (st.body.state === 'sent') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { state: 'sent', attempts: 2 });
  assert.equal(up.seen.length, 2);
  assert.ok(up.seen.every((b) => b.sendId === id), 'sendId passed to the bridge on every attempt');
  const dup = await post(srv.base, { surface: 's1', text: 'hi', submit: true, sendId: id });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(up.seen.length, 2);
  assert.equal((await statusOf(srv.base, 'eeeeeeee-1333-4333-8333-333333333333')).status, 404);
  // No sendId: the old one-shot behaviour, no queue (a gateway 502 is relayed as-is).
  const up2 = up.seen.length;
  const plain = await post(srv.base, { surface: 's1', text: 'x', submit: false });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.sendId, undefined);
  assert.equal(up.seen.length, up2 + 1);
});

test('D133 route: a bridge write-phase 502 is passed through unchanged (not queued)', async (t) => {
  const up = await stubBridge(() => ({ status: 502, body: { error: 'text_command_unconfirmed' } }));
  const env = { CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: 'd133-secret', PUSH_ENABLED: '0', SEND_IDS_FILE: tmpFile(), SEND_QUEUE_BACKOFF_MS: '100' };
  const srv = await bootServer({ env });
  t.after(async () => { await srv.stop(); await up.close(); });
  const r = await post(srv.base, { surface: 's1', text: 'hi', submit: true, sendId: 'ffffffff-1333-4333-8333-333333333333' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'text_command_unconfirmed');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(up.seen.length, 1);
});

// ---- bridge: real bridge.js child, fake cmux --------------------------------------------------

const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'tree') {   // the private-surface gate's probe: one ordinary workspace
  const sf = { id: '11111111-2222-4333-8444-555555555555', ref: 'surface:1', title: 't', type: 'terminal', selected: true, selected_in_pane: true };
  process.stdout.write(JSON.stringify({ windows: [{ id: 'w1', ref: 'window:1', workspaces: [{ id: 'ws1', ref: 'workspace:1', title: 'work', selected: true,
    panes: [{ id: 'p1', ref: 'pane:1', index: 0, focused: true, selected_surface_id: sf.id, surfaces: [sf] }] }] }] }), () => process.exit(0));
  return;
}
if (a[0] === 'send' || a[0] === 'send-key') fs.appendFileSync(process.env.FAKE_CMUX_LOG, a[0] + '\n');
setTimeout(() => process.stdout.write('OK\n', () => process.exit(0)), Number(process.env.FAKE_CMUX_DELAY_MS || 0));
`;

test('D133 bridge: the same sendId types once (sequential and concurrent repeats answer duplicate)', async (t) => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd133-br-')));
  const bin = path.join(dir, 'fake-cmux');
  const logFile = path.join(dir, 'calls.log');
  await fsp.writeFile(bin, FAKE_CMUX, { mode: 0o755 });
  await fsp.writeFile(logFile, '');
  const br = await bootBridge({ env: { CMUX_BIN: bin, FAKE_CMUX_LOG: logFile, FAKE_CMUX_DELAY_MS: '250', CMUX_SUBMIT_SETTLE_MS: '0' } });
  t.after(() => br.stop());
  const SURFACE = '11111111-2222-4333-8444-555555555555';
  const call = async (body) => {
    const r = await fetch(`${br.base}/cmux/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const typed = () => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l === 'send').length;

  const msg = { surface: SURFACE, text: 'hello', submit: false, sendId: 'abababab-1333-4333-8333-333333333333' };
  const [x, y] = await Promise.all([call(msg), call(msg)]);   // attempt 2 while attempt 1 still typing
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  assert.equal([x, y].filter((r) => r.body.duplicate === true).length, 1);
  const z = await call(msg);
  assert.deepEqual(z, { status: 200, body: { ok: true, duplicate: true } });
  assert.equal(typed(), 1);
  // Upper-case surface spelling is the same surface.
  assert.equal((await call({ ...msg, surface: SURFACE.toUpperCase() })).body.duplicate, true);
  assert.equal(typed(), 1);
  // A different id types; no id types every time (old behaviour); a bad id is refused.
  await call({ ...msg, sendId: 'cdcdcdcd-1333-4333-8333-333333333333' });
  await call({ surface: SURFACE, text: 'a', submit: false });
  await call({ surface: SURFACE, text: 'a', submit: false });
  assert.equal(typed(), 4);
  assert.equal((await call({ ...msg, sendId: 'bad id' })).status, 400);
});
