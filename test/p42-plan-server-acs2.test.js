'use strict';
// p42 HMXB-005: server.js acceptance cases, part 2 (real server, stub hub in the {success, data} envelope, stub bridges):
// R3 typed refusals + one 500, R9 cold aliases, R5 machine downgrade / paused key closing open streams, R1 tickets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { bootServer, REPO } = require('./helpers/server-boot');
const { createPolicy, PolicyRefusal } = require('../lib/plan-policy');
const { createPairing } = require('../lib/pairing');
const { createReadBody } = require('../lib/read-body');

const quiet = { error() {}, log() {} };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p42s2-'));
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
const shut = (s) => { s.closeAllConnections?.(); s.close(); };
function signIn(d, sub = 'A', epoch = 1) {
  fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ ownerSub: sub, ownerEpoch: epoch }));
  fs.writeFileSync(path.join(d, 'hub-access-token'), JSON.stringify({ ownerSub: sub, ownerEpoch: epoch, accessToken: 'tok-' + sub, exp: 4e9 }));
}
const FREE = { plan: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } };
const PRO = { plan: 'pro', limits: { maxMachines: null, maxDevices: null, remoteDesktop: 'full' } };
const LIMIT = (limit, reason) => ({ error: 'PLAN_LIMIT', code: 'PLAN_LIMIT', details: reason ? { limit, reason } : { limit } });

// The hub answers in its {success, data} envelope; the state object is mutated by the tests.
async function envelopeHub(state) {
  const ok = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
  return listen((req, res) => {
    if (req.url.endsWith('/entitlement')) return ok(res, { enforced: true, entitlement: state.ent });
    if (req.url.endsWith('/devices')) {
      if (state.devicesFail) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"success":false}'); }
      return ok(res, { devices: state.devices || [] });
    }
    return ok(res, { enforced: true, defaultPlan: 'free', plans: [] });
  });
}
// One stub bridge per machine; it reports its own bridge machineId (the alias) in /cmux/sessions.
// Streams (thread-stream SSE, download) stay open until the server closes them.
function bridge(machineId) {
  return listen((req, res) => {
    if (req.url === '/cmux/sessions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ machineId, sessions: [{ id: machineId + ':s1' }] })); }
    if (req.url.endsWith('/thread-stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': open\n\n'); }
    if (req.url.startsWith('/cmux/fs/download')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.write('first-bytes'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"messages":[]}');
  });
}
// Test-only preload for the server child: SIGUSR2 runs exactly what the R5 poll tick runs at a deadline
// (policy.refresh() then policy.recheck(machineIds)), because the real server cannot take a fake clock;
// /api/sessions/boom*/thread throw inside sessionsProxy.handle (before / after the headers went out).
function preload(extra = '') {
  const f = path.join(dir(), 'preload.js');
  fs.writeFileSync(f, [
    "'use strict';",
    'const pp = require(' + JSON.stringify(path.join(REPO, 'lib', 'plan-policy.js')) + ');',
    'const oc = pp.createPolicy;',
    'pp.createPolicy = (o) => { const p = oc(o); let ids; const sp = p.startPoll;',
    '  p.startPoll = (x = {}) => { ids = x.machineIds; return sp(x); };',
    "  process.on('SIGUSR2', async () => { await p.refresh().catch(() => {}); const n = p.recheck(ids); console.log('test-hook: tick closed ' + n); });",
    '  return p; };',
    'const sp = require(' + JSON.stringify(path.join(REPO, 'lib', 'sessions-proxy.js')) + ');',
    'const os2 = sp.createSessionsProxy;',
    'sp.createSessionsProxy = (o) => { const s = os2(o); const h = s.handle;',
    "  s.handle = async (req, res, u) => { if (u.pathname === '/api/sessions/boom/thread') throw new Error('boom');",
    "    if (u.pathname === '/api/sessions/boom2/thread') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('x'); throw new Error('boom2'); }",
    '    return h(req, res, u); };',
    '  return s; };',
    extra,
  ].join('\n'));
  return ['--require', f];
}
const tick = async (s) => { const n = s.stdout().length; s.child.kill('SIGUSR2');
  for (let i = 0; i < 100 && !/test-hook: tick closed/.test(s.stdout().slice(n)); i++) await new Promise((r) => setTimeout(r, 30)); };
// Opens a streaming GET; ended(ms) resolves true when the server closes it (done or reset), false after ms.
async function openStream(url, headers) {
  const ctrl = new AbortController();
  const r = await fetch(url, { headers, signal: ctrl.signal });
  const reader = r.body.getReader();
  await reader.read();   // first bytes arrived: the stream is open
  let closed = false;
  const done = (async () => { try { for (;;) { const x = await reader.read(); if (x.done) break; } } catch (_) {} closed = true; })();
  return { status: r.status, isClosed: () => closed, ended: (ms) => Promise.race([done.then(() => true), new Promise((res) => setTimeout(() => res(closed), ms))]), abort: () => ctrl.abort() };
}
const machines = (a, b) => JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: 'http://127.0.0.1:' + a.address().port, secret: 'sb' }, { id: 'm2', label: 'M2', baseUrl: 'http://127.0.0.1:' + b.address().port, secret: 'sb' }]);
async function boot(st, extraEnv = {}, nodeArgs = preload()) {
  const hub = await envelopeHub(st); const b1 = await bridge('mac-one'); const b2 = await bridge('mac-two'); const d = extraEnv.HMX_PLAN_STATE_DIR || dir();
  if (!extraEnv.HMX_PLAN_STATE_DIR) signIn(d);
  const s = await bootServer({ nodeArgs, env: { SERVER_TOKEN: 'tok', PUBLIC_URL: 'https://mac.example', HMX_PLAN_STATE_DIR: d, HMX_HUB_URL: 'http://127.0.0.1:' + hub.address().port, CMUX_MACHINES: machines(b1, b2), ...extraEnv } });
  return { s, hub, b1, b2, d, stop: async () => { await s.stop(); shut(hub); shut(b1); shut(b2); } };
}
const H = { authorization: 'Bearer tok' };
const J = { 'content-type': 'application/json' };
const get = async (url, headers = H) => { const r = await fetch(url, { headers }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t }; };
const post = async (url, body, headers = H) => { const r = await fetch(url, { method: 'POST', headers: { ...headers, ...J }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j }; };

// ---------------------------------------------------------------- AC20 (R3)
test('AC20 R3: exact 402/503 bodies from handleApi, read-body, claim, download and sessions-proxy; throws -> one 500; process stays up', async () => {
  const st = { ent: FREE, devices: [], devicesFail: true };
  const x = await boot(st); const b = x.s.base;
  try {
    let r = await post(b + '/api/cmux/screen/mouse?machine=m1', {});
    assert.deepStrictEqual([r.status, r.json], [402, LIMIT('remoteDesktop')], 'handleApi');
    r = await post(b + '/api/cmux/send', { machine: 'm2', text: 'x' });
    assert.deepStrictEqual([r.status, r.json], [402, LIMIT('machines')], 'read-body');
    r = await get(b + '/api/sessions/mac-two%3As1/thread');
    assert.deepStrictEqual([r.status, r.json], [402, LIMIT('machines')], 'sessions-proxy (byPrefix)');
    const tk = (await get(b + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x')).json.ticket;
    r = await get(b + '/api/cmux/fs/download?ticket=' + tk, { 'cf-connecting-ip': '1.2.3.4' });
    assert.deepStrictEqual([r.status, r.json], [402, LIMIT('devices', 'server_token_remote')], 'download');
    const code = (await post(b + '/api/pair/start', {})).json.code;
    r = await post(b + '/api/pair/claim', { code, hubDeviceId: 'h1' }, {});
    assert.deepStrictEqual([r.status, r.json], [503, { error: 'BUSY', code: 'BUSY' }], 'claim, hub devices failing');
    r = await get(b + '/api/sessions/boom/thread');
    assert.deepStrictEqual([r.status, r.json], [500, { error: 'internal' }], 'unexpected throw -> one 500');
    const late = await Promise.race([get(b + '/api/sessions/boom2/thread').then((v) => v.status), new Promise((res) => setTimeout(() => res('hung'), 3000))]);
    assert.strictEqual(late, 200, 'a throw after the headers went out ends that response (no second status, no hang)');
    assert.ok(x.s.alive(), 'process stays up');
    assert.strictEqual((await get(b + '/api/cmux/machines')).status, 200);
  } finally { await x.stop(); }
});

test('AC20 R3 unit: read-body sends the exact 503 body and one 500 on a throwing handler; bind 503 BUSY; claim throw -> 500 pairing_error', async () => {
  const sent = []; const sendJson = (res, s, body) => { sent.push([s, body]); res.headersSent = true; };
  const mk = (checkMachine) => createReadBody({ ensureMachine: async () => {}, sendJson, log: () => {}, checkMachine });
  const feed = (rb, body, cb) => new Promise((done) => { const rq = new EventEmitter(); rq.cmuxRes = { headersSent: false }; rq.destroy = () => {};
    rb(rq, (b) => { try { cb(b); } finally { setImmediate(done); } }); rq.emit('data', JSON.stringify(body)); rq.emit('end'); setTimeout(done, 50); });
  await feed(mk(async () => new PolicyRefusal(503, { error: 'BUSY', code: 'BUSY' })), { machine: 'm2' }, () => { throw new Error('must not run'); });
  await feed(mk(null), { machine: 'm1' }, () => { throw new Error('handler bug'); });
  assert.deepStrictEqual(sent, [[503, { error: 'BUSY', code: 'BUSY' }], [500, { error: 'internal' }]]);
  // pairing claim/bind boundaries
  const call = (pr, method, url, body, headers = {}) => new Promise((resolve) => {
    const rq = new EventEmitter(); rq.method = method; rq.headers = { host: '127.0.0.1:1', ...headers }; rq.socket = { remoteAddress: '127.0.0.1' }; rq.destroy = () => {};
    let n = 0; const res = { headersSent: false, writeHead(s) { n++; this.status = s; this.headersSent = true; }, end(b) { resolve({ status: this.status, body: b ? JSON.parse(b) : null, writes: n }); } };
    pr.handle(rq, res, new URL('http://x' + url));
    if (body !== undefined) setImmediate(() => { rq.emit('data', JSON.stringify(body)); rq.emit('end'); });
  });
  const mkPr = (policy) => createPairing({ file: path.join(dir(), 'devices.json'), idFile: path.join(dir(), 'server-id'), serverToken: 'T', publicUrl: 'https://mac.example', log: quiet, policy });
  const d = dir(); signIn(d);
  const hang = { plans: () => new Promise(() => {}), entitlement: () => new Promise(() => {}), devices: () => new Promise(() => {}) };
  const p = createPolicy({ hub: hang, stateDir: d, timeoutMs: 30, log: quiet });
  const pr = mkPr(p); const legacy = pr.claim(pr.start('t' + Math.random()).code, 'old');
  const KH = { authorization: 'Bearer ' + legacy.deviceKey };
  const n = await call(pr, 'GET', '/api/pair/nonce', undefined, KH);
  const kp = crypto.generateKeyPairSync('ed25519');
  const sig = crypto.sign(null, Buffer.from(['hmx-bind-v1', 'hyprmux', 'A', n.body.bridgeInstallId, 'h1', n.body.nonce].join('\n')), kp.privateKey).toString('base64url');
  const bd = await call(pr, 'POST', '/api/pair/bind', { hubDeviceId: 'h1', nonce: n.body.nonce, signature: sig }, KH);
  assert.deepStrictEqual([bd.status, bd.body], [503, { error: 'BUSY', code: 'BUSY' }], 'bind, hub hanging');
  const boomP = { ...p, authorize: () => Promise.reject(new Error('policy bug')) };
  const pr2 = mkPr(boomP);
  const cl = await call(pr2, 'POST', '/api/pair/claim', { code: pr2.start('t' + Math.random()).code });
  assert.deepStrictEqual([cl.status, cl.body, cl.writes], [500, { error: 'pairing_error' }, 1]);
});

// ---------------------------------------------------------------- AC21 (R9)
test('AC21 R9 cold alias: fresh server, alias of the disallowed machine never seen -> 402 machines (not 404/502) on ?machine=, body, /api/sessions?machine= and session-id routes', async () => {
  const st = { ent: FREE, devices: [] };
  const routes = [
    (b) => get(b + '/api/cmux/tabs?machine=mac-two'),
    (b) => post(b + '/api/cmux/send', { machine: 'mac-two', text: 'x' }),
    (b) => get(b + '/api/sessions?machine=mac-two'),
    (b) => get(b + '/api/sessions/mac-two%3As1/thread'),
    (b) => get(b + '/api/sessions/mac-two%3As1/thread-stream'),
  ];
  for (const [i, route] of routes.entries()) {
    const x = await boot(st);   // a new server per route: every alias lookup is cold
    try {
      const r = await route(x.s.base);
      assert.deepStrictEqual([r.status, r.json], [402, LIMIT('machines')], 'route ' + i);
      assert.ok(x.s.alive());
    } finally { await x.stop(); }
  }
  const x = await boot(st);
  try {
    assert.strictEqual((await get(x.s.base + '/api/sessions/mac-one%3As1/thread')).status, 200, 'allowed alias still routes');
    const l = (await get(x.s.base + '/api/sessions')).json;
    assert.deepStrictEqual(l.sessions.map((s) => s.id), ['mac-one:s1']);
  } finally { await x.stop(); }
});

// ---------------------------------------------------------------- AC22 (R5 + R9)
test('AC22 R5/R9 unit (fake clock + fake timers): machine downgrade closes the open session on the disallowed machine at the deadline (<= 305 s); repeated cycles re-arm; failing hub backs off 30 s -> 300 s', async () => {
  const d = dir(); signIn(d); const c = { t: 1e12 }; const q = [];
  const hub = { ent: { enforced: true, ...PRO }, fail: false, calls: 0 };
  const go = (v) => { hub.calls++; return hub.fail ? Promise.reject(new Error('503')) : Promise.resolve(v()); };
  const client = { plans: () => go(() => ({ enforced: true, defaultPlan: 'free', plans: [] })), entitlement: () => go(() => hub.ent), devices: () => go(() => []) };
  const p = createPolicy({ hub: client, stateDir: d, now: () => c.t, log: quiet });
  await p.ensureFresh();
  p.startPoll({ machineIds: () => ['m1', 'm2'], setT: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clearT: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); } });
  const run = async () => { const t = q.find((x) => x.fn.name === 'tick'); q.splice(q.indexOf(t), 1); c.t += t.ms; await t.fn(); return t.ms; };
  for (let cycle = 0; cycle < 3; cycle++) {
    hub.ent = { enforced: true, ...PRO };
    let onM2 = false, onM1 = false;
    p.track({ cred: { kind: 'server' }, local: true, machineId: 'm2', close: () => { onM2 = true; } });
    p.track({ cred: { kind: 'server' }, local: true, machineId: 'm1', close: () => { onM1 = true; } });
    const ms1 = await run(); assert.ok(ms1 <= 300000); assert.strictEqual(onM2, false, 'Pro: stays open, re-armed');
    hub.ent = { enforced: true, ...FREE };
    const ms2 = await run();
    assert.ok(ms2 <= 305000, 'closed by fetchedAt + 305 s'); assert.strictEqual(onM2, true, 'cycle ' + cycle); assert.strictEqual(onM1, false);
  }
  hub.fail = true; const gaps = [];
  for (let i = 0; i < 6; i++) gaps.push(await run());
  assert.ok(gaps.every((g) => g >= 30000), 'never a zero-delay loop: ' + gaps);
  assert.deepStrictEqual(gaps.slice(1), [60000, 120000, 240000, 300000, 300000]);
});

test('AC22 R5/R9 real server (SIGUSR2 = the poll tick at the deadline): Pro -> Free closes an open download and an open session thread-stream on m2; m1 stays open', async () => {
  const st = { ent: PRO, devices: [] };
  const x = await boot(st); const b = x.s.base;
  try {
    const tk2 = (await get(b + '/api/cmux/fs/download-ticket?machine=m2&path=/tmp/x')).json.ticket;
    const tk1 = (await get(b + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x')).json.ticket;
    const dl2 = await openStream(b + '/api/cmux/fs/download?ticket=' + tk2, {});
    const dl1 = await openStream(b + '/api/cmux/fs/download?ticket=' + tk1, {});
    const ss2 = await openStream(b + '/api/sessions/mac-two%3As1/thread-stream', H);
    const ss2q = await openStream(b + '/api/sessions/mac-two%3As1/thread-stream?machine=m2', H);
    assert.deepStrictEqual([dl2.status, dl1.status, ss2.status, ss2q.status], [200, 200, 200, 200]);
    st.ent = FREE; await tick(x.s);
    assert.strictEqual(await dl2.ended(2000), true, 'download on m2 closed');
    assert.strictEqual(await ss2q.ended(2000), true, 'thread-stream ?machine=m2 closed');
    assert.strictEqual(await ss2.ended(2000), true, 'thread-stream by session id on m2 closed');
    assert.strictEqual(dl1.isClosed(), false, 'm1 transfer stays open');
    dl1.abort();
    assert.ok(x.s.alive());
  } finally { await x.stop(); }
});

// ---------------------------------------------------------------- AC11 2nd half + AC23 (R1)
test('AC11/AC23 R1 real server: an accepted transfer of key K closes when K is paused; old ticket then refused 402 paused + deleted; a replacement key for the same hubDeviceId kills the old ticket', async () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url');
  const st = { ent: FREE, devices: [{ id: 'h1', status: 'active', publicKey: pub }] };
  const x = await boot(st); const b = x.s.base;
  const claimK = async () => {
    const code = (await post(b + '/api/pair/start', {})).json.code;
    const n = (await get(b + '/api/pair/nonce?code=' + code, {})).json;
    const sig = crypto.sign(null, Buffer.from(['hmx-bind-v1', 'hyprmux', 'A', n.bridgeInstallId, 'h1', n.nonce].join('\n')), kp.privateKey).toString('base64url');
    const r = await post(b + '/api/pair/claim', { code, deviceName: 'phone', hubDeviceId: 'h1', nonce: n.nonce, signature: sig }, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); return r.json.deviceKey;
  };
  try {
    const K = { authorization: 'Bearer ' + await claimK(), 'cf-connecting-ip': '1.2.3.4' };
    const t1 = (await get(b + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x', K)).json.ticket;
    const t2 = (await get(b + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/y', K)).json.ticket;
    const dl = await openStream(b + '/api/cmux/fs/download?ticket=' + t1, { 'cf-connecting-ip': '1.2.3.4' });
    assert.strictEqual(dl.status, 200);
    st.devices = [{ id: 'h1', status: 'paused', publicKey: pub }]; await tick(x.s);
    assert.strictEqual(await dl.ended(2000), true, 'transfer closed at the deadline after K paused');
    let r = await get(b + '/api/cmux/fs/download?ticket=' + t2, { 'cf-connecting-ip': '1.2.3.4' });
    assert.deepStrictEqual([r.status, r.json], [402, LIMIT('devices', 'paused')]);
    assert.strictEqual((await get(b + '/api/cmux/fs/download?ticket=' + t2, {})).status, 403, 'refused ticket deleted');
    // replacement key for the same hubDeviceId
    st.devices = [{ id: 'h1', status: 'active', publicKey: pub }]; await tick(x.s);
    const K1 = { authorization: 'Bearer ' + await claimK(), 'cf-connecting-ip': '1.2.3.4' };
    const t3 = (await get(b + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/z', K1)).json.ticket;
    await claimK();   // a newer key for h1 replaces K1
    r = await get(b + '/api/cmux/fs/download?ticket=' + t3, { 'cf-connecting-ip': '1.2.3.4' });
    assert.strictEqual(r.status, 401, 'old key ticket refused');
  } finally { await x.stop(); }
});

test('AC11 R1 wall clock: an accepted transfer closes at DL_TRANSFER_MAX_MS (the 30 min timer, shortened in the child by the preload)', async () => {
  const shorten = "const st0 = global.setTimeout; global.setTimeout = (fn, ms, ...a) => st0(fn, ms === 30 * 60 * 1000 ? 300 : ms, ...a);";
  const x = await boot({ ent: PRO, devices: [] }, {}, preload(shorten));
  try {
    const tk = (await get(x.s.base + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x')).json.ticket;
    const dl = await openStream(x.s.base + '/api/cmux/fs/download?ticket=' + tk, {});
    assert.strictEqual(await dl.ended(3000), true);
  } finally { await x.stop(); }
});

test('AC23 R1: a SERVER_TOKEN ticket does not survive a token change (the change needs a restart; tickets are in memory) -> 403', async () => {
  const st = { ent: PRO, devices: [] };
  const x = await boot(st);
  const tk = (await get(x.s.base + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x')).json.ticket;
  await x.s.stop();
  const y = await boot(st, { SERVER_TOKEN: 'tok2', HMX_PLAN_STATE_DIR: x.d });
  try {
    const r = await get(y.s.base + '/api/cmux/fs/download?ticket=' + tk, {});
    assert.strictEqual(r.status, 403);
  } finally { await y.stop(); shut(x.hub); shut(x.b1); shut(x.b2); }
});
