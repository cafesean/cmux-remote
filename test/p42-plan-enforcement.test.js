'use strict';
// p42 HMXB-005: plan policy (lib/plan-policy.js) + its wiring in lib/pairing.js. Stub hub, fake clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPolicy, PolicyRefusal, respond } = require('../lib/plan-policy');
const { createPairing } = require('../lib/pairing');

const quiet = { error() {}, log() {} };
function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'p42-')); }
function stubHub(over = {}) {
  const h = { calls: 0, plans: { enforced: true, defaultPlan: 'free', plans: [{ code: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } }] },
    entitlement: { enforced: true, plan: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } }, devices: [], fail: false, hang: false, ...over };
  const go = (v) => { h.calls++; if (h.hang) return new Promise(() => {}); if (h.fail) return Promise.reject(new Error('503')); return Promise.resolve(typeof v === 'function' ? v() : v); };
  h.client = { plans: () => go(() => h.plans), entitlement: () => go(() => h.entitlement), devices: () => go(() => h.devices) };
  return h;
}
function signIn(d, sub = 'A', epoch = 1, exp = 4e9) {
  fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ ownerSub: sub, ownerEpoch: epoch }));
  fs.writeFileSync(path.join(d, 'hub-access-token'), JSON.stringify({ ownerSub: sub, ownerEpoch: epoch, accessToken: 'tok-' + sub, exp }));
}
const clock = (t = 1e12) => { const c = { t, now: () => c.t }; return c; };
const req = (headers = {}, addr = '127.0.0.1') => ({ headers: { host: '127.0.0.1:1', ...headers }, socket: { remoteAddress: addr } });
const U = new URL('http://x/api/cmux/screen/mouse');
const fwd = { 'cf-connecting-ip': '1.2.3.4', host: 'mac.example' };

test('Free + enforced: RD input 402 remoteDesktop, screen shot passes, remote SERVER_TOKEN 402, local 200', async () => {
  const d = dir(); signIn(d); const hub = stubHub(); const c = clock();
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  for (const r of ['mouse', 'tap', 'scroll', 'type', 'key', 'dialogs/press', 'dialogs/type']) {
    const x = await p.authorize(req(), U, { op: 'api', cred: { kind: 'server' }, local: true, method: 'POST', path: '/api/cmux/screen/' + r });
    assert.ok(x instanceof PolicyRefusal && x.status === 402 && x.body.details.limit === 'remoteDesktop', r);
  }
  assert.strictEqual(await p.authorize(req(), U, { op: 'api', cred: { kind: 'server' }, local: true, method: 'GET', path: '/api/cmux/screen/shot' }), null);
  const remote = await p.authorize(req(fwd), U, { op: 'api', cred: { kind: 'server' }, local: false, method: 'GET', path: '/api/cmux/tabs' });
  assert.strictEqual(remote.status, 402); assert.strictEqual(remote.body.details.reason, 'server_token_remote');
  assert.strictEqual(await p.authorize(req(), U, { op: 'api', cred: { kind: 'server' }, local: true, method: 'GET', path: '/api/cmux/tabs' }), null);
});

test('Pro + enforced: every check passes', async () => {
  const d = dir(); signIn(d);
  const hub = stubHub({ entitlement: { enforced: true, plan: 'pro', limits: { maxMachines: null, maxDevices: null, remoteDesktop: 'full' } }, devices: [{ id: 'h1', status: 'active' }] });
  const p = createPolicy({ hub: hub.client, stateDir: d, now: clock().now, log: quiet });
  const dev = { id: 'k1', hubDeviceId: 'h1', ownerSub: 'A', ownerEpoch: 1 };
  assert.strictEqual(await p.authorize(req(fwd), U, { op: 'api', cred: { kind: 'device', dev }, method: 'POST', path: '/api/cmux/screen/mouse', machineId: 'm2', machineIds: ['m1', 'm2'] }), null);
  assert.strictEqual(await p.authorize(req(fwd), U, { op: 'api', cred: { kind: 'server' }, local: false }), null);
});

test('switch off: enforced:false / entitlement null -> D, no checks; no cache + hub down -> built-in Free', async () => {
  const d = dir(); signIn(d); const hub = stubHub({ entitlement: { enforced: false } });
  const p = createPolicy({ hub: hub.client, stateDir: d, now: clock().now, log: quiet });
  assert.strictEqual(await p.authorize(req(fwd), U, { op: 'api', cred: { kind: 'server' }, method: 'POST', path: '/api/cmux/screen/mouse' }), null);
  assert.strictEqual(p.decide().mode, 'D');
  const d2 = dir(); const h2 = stubHub({ fail: true });
  const p2 = createPolicy({ hub: h2.client, stateDir: d2, now: clock().now, log: quiet });
  const x = await p2.authorize(req(), U, { op: 'api', cred: {}, method: 'POST', path: '/api/cmux/screen/key' });
  assert.strictEqual(x.body.details.limit, 'remoteDesktop'); assert.strictEqual(p2.decide().mode, 'F');
});

test('downgrade Pro->Free within 300 s: 2nd key 402 paused, oldest keeps working', async () => {
  const d = dir(); signIn(d); const c = clock();
  const hub = stubHub({ entitlement: { enforced: true, plan: 'pro', limits: { maxMachines: null, maxDevices: null, remoteDesktop: 'full' } }, devices: [{ id: 'h1', status: 'active' }, { id: 'h2', status: 'active' }] });
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  const k1 = { id: 'k1', hubDeviceId: 'h1', ownerSub: 'A', ownerEpoch: 1 }, k2 = { id: 'k2', hubDeviceId: 'h2', ownerSub: 'A', ownerEpoch: 1 };
  assert.strictEqual(await p.authorize(req(fwd), U, { cred: { kind: 'device', dev: k2 } }), null);
  hub.entitlement = { enforced: true, plan: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } };
  hub.devices = [{ id: 'h1', status: 'active' }, { id: 'h2', status: 'paused' }];
  c.t += 300 * 1000;
  const x = await p.authorize(req(fwd), U, { cred: { kind: 'device', dev: k2 } });
  assert.strictEqual(x.body.details.reason, 'paused');
  assert.strictEqual(await p.authorize(req(fwd), U, { cred: { kind: 'device', dev: k1 } }), null);
});

test('stale bounds: cached enforced Free + hub failure -> Free at 23h59m, built-in Free after 24h; failure never writes enforced:false; owner B ignores A cache', async () => {
  const d = dir(); signIn(d); const c = clock(); const hub = stubHub();
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  await p.ensureFresh(); assert.strictEqual(p.decide().mode, 'E');
  hub.fail = true;
  c.t += 24 * 3600 * 1000 - 60000; await p.ensureFresh();
  assert.strictEqual(p.decide().mode, 'E'); assert.strictEqual(p.decide().free, true);
  c.t += 120000; await p.ensureFresh();
  const dd = p.decide(); assert.strictEqual(dd.mode, 'E'); assert.deepStrictEqual({ ...dd.limits }, { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'install-policy.json'))).enforcedLastKnown, true);
  signIn(d, 'B', 2); hub.fail = true;
  const pB = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  assert.strictEqual(Object.keys(pB.decide().devices || {}).length, 0);
  // cached enforced:false + failure -> no checks
  const d3 = dir(); signIn(d3); const h3 = stubHub({ entitlement: { enforced: false } }); const c3 = clock();
  const p3 = createPolicy({ hub: h3.client, stateDir: d3, now: c3.now, log: quiet });
  await p3.ensureFresh(); h3.fail = true; c3.t += 301000; await p3.ensureFresh();
  assert.strictEqual(p3.decide().mode, 'D');
});

test('cold cache: 50 concurrent -> 1 hub read; hanging hub answers within 5 s; next call >= 60 s after failure', async () => {
  const d = dir(); const c = clock(); const hub = stubHub();
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  await Promise.all(Array.from({ length: 50 }, () => p.authorize(req(), U, {})));
  assert.strictEqual(hub.calls, 1);
  const h2 = stubHub({ hang: true }); const c2 = clock();
  const p2 = createPolicy({ hub: h2.client, stateDir: dir(), now: c2.now, timeoutMs: 50, log: quiet });
  const t0 = Date.now(); const x = await p2.authorize(req(), U, { method: 'POST', path: '/api/cmux/screen/tap' });
  assert.ok(Date.now() - t0 < 1000); assert.strictEqual(x.body.details.limit, 'remoteDesktop');
  const n = h2.calls; c2.t += 30000; await p2.ensureFresh(); assert.strictEqual(h2.calls, n);
  c2.t += 31000; p2.ensureFresh(); assert.strictEqual(h2.calls, n + 1);
});

test('authorize never rejects; respond sends one typed body or one 500', async () => {
  const p = createPolicy({ hub: { plans() { throw new Error('boom'); } }, stateDir: dir(), now: clock().now, log: quiet });
  await assert.doesNotReject(p.authorize(req(), U, {}));
  const out = []; const res = { headersSent: false, writeHead(s) { out.push(s); this.headersSent = true; }, end() {} };
  respond(res, new PolicyRefusal(402, { error: 'PLAN_LIMIT' })); respond(res, new Error('x'));
  assert.deepStrictEqual(out, [402]);
  const out2 = []; respond({ writeHead(s) { out2.push(s); }, end() {} }, new Error('x')); assert.deepStrictEqual(out2, [500]);
});

test('machines: Free allows the first machine only, Pro all', async () => {
  const d = dir(); signIn(d); const p = createPolicy({ hub: stubHub().client, stateDir: d, now: clock().now, log: quiet });
  const x = await p.authorize(req(), U, { cred: { kind: 'server' }, local: true, machineId: 'remote', machineIds: ['local', 'remote'] });
  assert.strictEqual(x.body.details.limit, 'machines');
  assert.deepStrictEqual(p.allowedMachines(['local', 'remote']), ['local']);
});

// ---- pairing wiring ----
function fakeRes() {
  return new Promise((resolve) => { const r = { headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.writableEnded = true; resolve({ status: this.status, body: b ? JSON.parse(b) : null }); } }; resolve.r = r; resolve.res = r; this_res = r; });
}
let this_res;
function call(pairing, method, url, body, headers = {}, addr = '127.0.0.1') {
  const { EventEmitter } = require('events');
  const rq = new EventEmitter(); rq.method = method; rq.headers = { host: '127.0.0.1:1', ...headers }; rq.socket = { remoteAddress: addr }; rq.destroy = () => {};
  const done = fakeRes(); const res = this_res;
  pairing.handle(rq, res, new URL('http://x' + url));
  if (body !== undefined) setImmediate(() => { rq.emit('data', JSON.stringify(body)); rq.emit('end'); });
  return done;
}
function mkPairing(policy, extra = {}) {
  return createPairing({ file: path.join(dir(), 'devices.json'), idFile: path.join(dir(), 'server-id'), serverToken: 'T', publicUrl: 'https://mac.example', log: quiet, policy, ...extra });
}

test('Mode F offline: first claim 200, second 402 devices, code not consumed by the refusal; local Allow key never counts', async () => {
  const p = createPolicy({ hub: stubHub({ fail: true }).client, stateDir: dir(), now: clock().now, log: quiet });
  const pr = mkPairing(p);
  const c1 = pr.start('token').code, c2 = pr.start('token').code;
  assert.strictEqual((await call(pr, 'POST', '/api/pair/claim', { code: c1 })).status, 200);
  const r2 = await call(pr, 'POST', '/api/pair/claim', { code: c2 });
  assert.strictEqual(r2.status, 402); assert.strictEqual(r2.body.details.limit, 'devices');
  assert.strictEqual((await call(pr, 'POST', '/api/pair/claim', { code: 'NOPE2345' })).status, 404);
  assert.ok(pr.list().every((d) => !('hubDeviceId' in d)));   // unbound keys list no hubDeviceId
  // a local:true record never counts as a device
  const pr2 = mkPairing(p);
  pr2.list(); // sanity
  assert.strictEqual(p.claimAllowed([{ id: 'a', local: true }]), true);
  assert.strictEqual(p.claimAllowed([{ id: 'a', local: true }, { id: 'b', local: false }]), false);
});

test('Mode E claim: hubDeviceId active -> 200 + stored + listed; missing -> 402 not_in_plan; same id re-claim replaces older key; hanging hub -> 503 BUSY, code still usable', async () => {
  const d = dir(); signIn(d); const hub = stubHub({ devices: [{ id: 'h1', status: 'active' }, { id: 'h2', status: 'paused' }] });
  const p = createPolicy({ hub: hub.client, stateDir: d, now: clock().now, log: quiet });
  const pr = mkPairing(p);
  const r1 = await call(pr, 'POST', '/api/pair/claim', { code: pr.start('token').code, hubDeviceId: 'h1' });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(pr.list()[0].hubDeviceId, 'h1');
  const r2 = await call(pr, 'POST', '/api/pair/claim', { code: pr.start('token').code, hubDeviceId: 'hX' });
  assert.strictEqual(r2.body.details.reason, 'not_in_plan');
  const r3 = await call(pr, 'POST', '/api/pair/claim', { code: pr.start('token').code, hubDeviceId: 'h2' });
  assert.strictEqual(r3.body.details.reason, 'paused');
  const r4 = await call(pr, 'POST', '/api/pair/claim', { code: pr.start('token').code, hubDeviceId: 'h1' });
  assert.strictEqual(r4.status, 200);
  assert.strictEqual(pr.verifyKey(r1.body.deviceKey), null); assert.ok(pr.verifyKey(r4.body.deviceKey));
  const g = await call(pr, 'GET', '/api/pair/devices', undefined, { authorization: 'Bearer ' + r4.body.deviceKey, ...fwd }, '127.0.0.1');
  assert.strictEqual(g.status, 200); assert.strictEqual(g.body.devices[0].hubDeviceId, 'h1');
  const d2 = dir(); signIn(d2); const h2 = stubHub({ hang: true });
  const p2 = createPolicy({ hub: h2.client, stateDir: d2, now: clock().now, timeoutMs: 30, log: quiet });
  const pr2 = mkPairing(p2); const code = pr2.start('token').code;
  const b = await call(pr2, 'POST', '/api/pair/claim', { code, hubDeviceId: 'h1' });
  assert.strictEqual(b.status, 503); assert.strictEqual(pr2.list().length, 0);
  h2.hang = false; h2.devices = [{ id: 'h1', status: 'active' }];
});

test('start: non-local SERVER_TOKEN on Free -> 402 server_token_remote; bad key 401 on /api/pair/devices even on a cold cache', async () => {
  const d = dir(); signIn(d); const p = createPolicy({ hub: stubHub({ hang: true }).client, stateDir: d, now: clock().now, timeoutMs: 30, log: quiet });
  const pr = mkPairing(p);
  const s = await call(pr, 'POST', '/api/pair/start', undefined, { authorization: 'Bearer T', ...fwd });
  assert.strictEqual(s.status, 402); assert.strictEqual(s.body.details.reason, 'server_token_remote');
  assert.strictEqual((await call(pr, 'GET', '/api/pair/devices', undefined, { authorization: 'Bearer junk', ...fwd })).status, 401);
});

// ---- the real server.js with a stub hub (HMX_HUB_URL) and a stub bridge ----
const http = require('http');
const { bootServer } = require('./helpers/server-boot');
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });

test('server.js: Free + enforced at handleApi: RD input 402, shot 200, remote SERVER_TOKEN 402, machines limited, 401 stays 401, tickets bound', async () => {
  const hubSeen = [];
  const hub = await listen((req, res) => {
    hubSeen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/entitlement')) return res.end(JSON.stringify({ enforced: true, entitlement: { plan: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } } }));
    if (req.url.endsWith('/devices')) return res.end(JSON.stringify({ devices: [] }));
    return res.end(JSON.stringify({ enforced: true, defaultPlan: 'free', plans: [] }));
  });
  const br = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const d = dir(); signIn(d);
  const port = br.address().port;
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', HMX_PLAN_STATE_DIR: d, HMX_HUB_URL: `http://127.0.0.1:${hub.address().port}`,
    CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: `http://127.0.0.1:${port}`, secret: 'sb' }, { id: 'm2', label: 'M2', baseUrl: `http://127.0.0.1:${port}`, secret: 'sb' }]) } });
  const H = { authorization: 'Bearer tok' };
  try {
    let r = await fetch(s.base + '/api/cmux/screen/mouse?machine=m1', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 402); assert.strictEqual((await r.json()).details.limit, 'remoteDesktop');
    r = await fetch(s.base + '/api/cmux/machines', { headers: H });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual((await r.json()).machines.map((m) => m.id), ['m1']);
    r = await fetch(s.base + '/api/cmux/machines?machine=m2', { headers: H });
    assert.strictEqual(r.status, 402); assert.strictEqual((await r.json()).details.limit, 'machines');
    for (const h of [{ authorization: 'Bearer tok' }, { 'x-app-token': 'tok' }]) {
      r = await fetch(s.base + '/api/cmux/machines', { headers: { ...h, 'cf-connecting-ip': '1.2.3.4' } });
      assert.strictEqual(r.status, 402); assert.strictEqual((await r.json()).details.reason, 'server_token_remote');
    }
    r = await fetch(s.base + '/api/cmux/machines?token=tok', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    assert.strictEqual(r.status, 402);
    r = await fetch(s.base + '/api/cmux/machines', { headers: { authorization: 'Bearer junk', 'cf-connecting-ip': '1.2.3.4' } });
    assert.strictEqual(r.status, 401);
    r = await fetch(s.base + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x', { headers: H });
    assert.strictEqual(r.status, 200);
    const { ticket } = await r.json();
    r = await fetch(s.base + '/api/cmux/fs/download?ticket=' + ticket, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    assert.strictEqual(r.status, 402, 'a SERVER_TOKEN ticket redeemed through the tunnel on Free is refused');
    r = await fetch(s.base + '/api/cmux/fs/download?ticket=' + ticket);
    assert.strictEqual(r.status, 403, 'the refused ticket was deleted');
    assert.ok(s.alive());
    assert.ok(hubSeen.some((u) => u === '/api/v1/apps/hyprmux/entitlement'));
  } finally { await s.stop(); hub.close(); br.close(); }
});

test('server.js without HMX_PLAN_STATE_DIR: no plan checks (self-hosted behaviour unchanged)', async () => {
  const br = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const port = br.address().port;
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: `http://127.0.0.1:${port}`, secret: 'sb' }, { id: 'm2', label: 'M2', baseUrl: `http://127.0.0.1:${port}`, secret: 'sb' }]) } });
  try {
    const r = await fetch(s.base + '/api/cmux/machines', { headers: { authorization: 'Bearer tok', 'cf-connecting-ip': '1.2.3.4' } });
    assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).machines.length, 2);
  } finally { await s.stop(); br.close(); }
});
