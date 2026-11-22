'use strict';
// p42 HMXB-005: remaining R0/R6/R7 acceptance cases of the plan policy. Stub hub, fake clock.
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
const PRO = { enforced: true, plan: 'pro', limits: { maxMachines: null, maxDevices: null, remoteDesktop: 'full' } };

test('AC5: /plans (owner-null) is re-read only after 300 s', async () => {
  const d = dir(); const c = clock(); const hub = stubHub();
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  await p.ensureFresh(); assert.strictEqual(hub.calls, 1);
  c.t += 299 * 1000; await p.ensureFresh(); assert.strictEqual(hub.calls, 1);
  c.t += 2000; await p.ensureFresh(); assert.strictEqual(hub.calls, 2);
});

test('AC26 R0: owner present + no answer: enforcedLastKnown true -> E with built-in Free; false -> D; fresh install outage -> Free', async () => {
  const d = dir(); signIn(d); const c = clock();
  fs.writeFileSync(path.join(d, 'install-policy.json'), JSON.stringify({ enforcedLastKnown: true }));
  const p = createPolicy({ hub: stubHub({ fail: true }).client, stateDir: d, now: c.now, log: quiet });
  await p.ensureFresh();
  const a = p.decide(); assert.strictEqual(a.mode, 'E'); assert.strictEqual(a.free, true);
  assert.deepStrictEqual({ ...a.limits }, { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' });
  const x = await p.authorize(req(fwd), U, { op: 'api', cred: {}, method: 'POST', path: '/api/cmux/screen/mouse' });
  assert.strictEqual(x.body.details.limit, 'remoteDesktop');
  const d2 = dir(); signIn(d2);
  fs.writeFileSync(path.join(d2, 'install-policy.json'), JSON.stringify({ enforcedLastKnown: false }));
  const p2 = createPolicy({ hub: stubHub({ fail: true }).client, stateDir: d2, now: c.now, log: quiet });
  await p2.ensureFresh(); assert.strictEqual(p2.decide().mode, 'D');
  const d3 = dir(); signIn(d3);   // signed in during an outage on a fresh install: never read
  const p3 = createPolicy({ hub: stubHub({ fail: true }).client, stateDir: d3, now: c.now, log: quiet });
  await p3.ensureFresh(); const z = p3.decide(); assert.strictEqual(z.mode, 'E'); assert.strictEqual(z.free, true);
});

test('AC30 R0/R7: owner present, token expired + hub 401 -> cached owner answer <= 24 h, then E with Free; never F', async () => {
  const d = dir(); const c = clock(); signIn(d, 'A', 1, c.t / 1000 + 3600);
  const hub = stubHub({ entitlement: PRO });
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  await p.ensureFresh(); assert.strictEqual(p.decide().mode, 'E'); assert.strictEqual(p.decide().free, false);
  signIn(d, 'A', 1, c.t / 1000 - 1);           // token expired, owner.json unchanged
  hub.fail = true;                             // and the hub refuses (401) any refresh
  c.t += 301 * 1000; await p.ensureFresh();
  let x = p.decide(); assert.strictEqual(x.mode, 'E'); assert.strictEqual(x.free, false, 'cached Pro answer still used');
  c.t += 24 * 3600 * 1000; await p.ensureFresh();
  x = p.decide(); assert.strictEqual(x.mode, 'E'); assert.strictEqual(x.free, true, 'built-in Free after 24 h');
  assert.notStrictEqual(x.mode, 'F');
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
const crypto = require('crypto');
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'), priv: privateKey };
}
const signFor = (kp, { ownerSub = 'A', installId, hubDeviceId, nonce }) =>
  crypto.sign(null, Buffer.from(['hmx-bind-v1', 'hyprmux', ownerSub, installId, hubDeviceId, nonce].join('\n')), kp.priv).toString('base64url');
async function signedClaim(pr, body, kp, ownerSub = 'A') {
  const n = await call(pr, 'GET', '/api/pair/nonce?code=' + body.code);
  assert.strictEqual(n.status, 200);
  return call(pr, 'POST', '/api/pair/claim', { ...body, nonce: n.body.nonce, signature: signFor(kp, { ownerSub, installId: n.body.bridgeInstallId, hubDeviceId: body.hubDeviceId, nonce: n.body.nonce }) });
}
async function signedBind(pr, key, hubDeviceId, kp, ownerSub = 'A') {
  const H = { authorization: 'Bearer ' + key };
  const n = await call(pr, 'GET', '/api/pair/nonce', undefined, H);
  assert.strictEqual(n.status, 200);
  return call(pr, 'POST', '/api/pair/bind', { hubDeviceId, nonce: n.body.nonce, signature: signFor(kp, { ownerSub, installId: n.body.bridgeInstallId, hubDeviceId, nonce: n.body.nonce }) }, H);
}


const seedDevices = (recs) => { const f = path.join(dir(), 'devices.json'); fs.writeFileSync(f, JSON.stringify({ devices: recs })); return f; };
const rec = (id, createdAt, extra = {}) => ({ id, deviceName: id, keyHash: 'h' + id, createdAt, lastSeenAt: createdAt, local: false, canInvite: false, ...extra });

test('AC15 start: SERVER_TOKEN ok, canInvite key ok / without 403 not_allowed, no key 401; no token: local ok, remote 403 local_only; never 402 devices', async () => {
  const d = dir(); signIn(d);
  const p = createPolicy({ hub: stubHub({ devices: [] }).client, stateDir: d, now: clock().now, log: quiet });
  const pr = mkPairing(p);
  const phone = pr.claim(pr.start('t' + Math.random()).code, 'phone');      // one device already: Free is full
  assert.strictEqual((await call(pr, 'POST', '/api/pair/start', undefined, { authorization: 'Bearer T' })).status, 200);
  const no = await call(pr, 'POST', '/api/pair/start', undefined, { authorization: 'Bearer ' + phone.deviceKey });
  assert.deepStrictEqual([no.status, no.body.error], [403, 'not_allowed']);
  assert.strictEqual((await call(pr, 'POST', '/api/pair/start', undefined, { authorization: 'Bearer junk', ...fwd })).status, 401);
  const inviter = { ...rec('inv', 1, { local: true, canInvite: true }) };
  const crypto2 = require('crypto'); const ik = 'invkey'; inviter.keyHash = crypto2.createHash('sha256').update(ik).digest('hex');
  const pr2 = mkPairing(p, { file: seedDevices([inviter]) });
  const ok = await call(pr2, 'POST', '/api/pair/start', undefined, { authorization: 'Bearer ' + ik });
  assert.notStrictEqual(ok.status, 402); assert.strictEqual(ok.status, 200);
  const pr3 = mkPairing(p, { serverToken: '' });
  assert.strictEqual((await call(pr3, 'POST', '/api/pair/start')).status, 200);
  const far = await call(pr3, 'POST', '/api/pair/start', undefined, fwd);
  assert.deepStrictEqual([far.status, far.body.error], [403, 'local_only']);
});

test('AC19 owner-null (F): eligible = oldest non-local by createdAt, tie lowest id; a local record made before the phones never counts', async () => {
  const p = createPolicy({ hub: stubHub({ fail: true }).client, stateDir: dir(), now: clock().now, log: quiet });
  await p.ensureFresh(); assert.strictEqual(p.decide().mode, 'F');
  const keys = [rec('loc', 1, { local: true }), rec('b', 5), rec('a', 5), rec('c', 9)];
  const asDev = (id) => keys.find((k) => k.id === id);
  assert.strictEqual(await p.authorize(req(fwd), U, { cred: { kind: 'device', dev: asDev('a') }, keys }), null);
  for (const id of ['b', 'c']) assert.strictEqual((await p.authorize(req(fwd), U, { cred: { kind: 'device', dev: asDev(id) }, keys })).body.details.limit, 'devices');
  assert.strictEqual(await p.authorize(req(), U, { cred: { kind: 'device', dev: asDev('loc') }, keys }), null);
});

test('AC24 Mode F concurrency: two codes claimed at once -> exactly one key, the other 402 devices with its code released; pre-existing local record -> first 200, second 402', async () => {
  const p = createPolicy({ hub: stubHub({ fail: true }).client, stateDir: dir(), now: clock().now, log: quiet });
  const pr = mkPairing(p);
  const c1 = pr.start('t' + Math.random()).code, c2 = pr.start('t' + Math.random()).code;
  const rs = await Promise.all([call(pr, 'POST', '/api/pair/claim', { code: c1 }), call(pr, 'POST', '/api/pair/claim', { code: c2 })]);
  assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 402]);
  assert.strictEqual(pr.list().filter((d) => !d.local).length, 1);
  const lost = rs[0].status === 402 ? c1 : c2;
  assert.strictEqual((await call(pr, 'GET', '/api/pair/nonce?code=' + lost)).status, 200, 'refused code released, still reservable');
  const pr2 = mkPairing(p, { file: seedDevices([rec('loc', 1, { local: true, canInvite: true })]) });
  assert.strictEqual((await call(pr2, 'POST', '/api/pair/claim', { code: pr2.start('t' + Math.random()).code })).status, 200);
  assert.strictEqual((await call(pr2, 'POST', '/api/pair/claim', { code: pr2.start('t' + Math.random()).code })).status, 402);
});

test('AC18 owner transfer: stale-epoch key rebinds with fresh proof (same id and other id); lost response -> fresh nonce + same payload -> 200', async () => {
  const d = dir(); signIn(d, 'A', 1); const k1 = keypair(), k2 = keypair(); const c = clock();
  const hub = stubHub({ devices: [{ id: 'h1', status: 'active', publicKey: k1.pub }, { id: 'h2', status: 'active', publicKey: k2.pub }] });
  const p = createPolicy({ hub: hub.client, stateDir: d, now: c.now, log: quiet });
  const pr = mkPairing(p);
  const a = pr.claim(pr.start('t' + Math.random()).code, 'a'), b = pr.claim(pr.start('t' + Math.random()).code, 'b');
  assert.strictEqual((await signedBind(pr, a.deviceKey, 'h1', k1)).status, 200);
  assert.strictEqual(pr.byId(a.id).ownerEpoch, 1);
  signIn(d, 'A2', 2); c.t += 301000;                                        // owner transfer: new owner + epoch
  const same = await signedBind(pr, a.deviceKey, 'h1', k1, 'A2');
  assert.deepStrictEqual([same.status, same.body], [200, { bound: true }]);
  assert.deepStrictEqual([pr.byId(a.id).ownerSub, pr.byId(a.id).ownerEpoch], ['A2', 2]);
  assert.strictEqual((await signedBind(pr, b.deviceKey, 'h2', k2, 'A2')).status, 200);
  // the response of a commit was lost: the client fetches a fresh nonce and re-signs the same payload
  const again = await signedBind(pr, a.deviceKey, 'h1', k1, 'A2');
  assert.deepStrictEqual([again.status, again.body], [200, { bound: true }]);
});
