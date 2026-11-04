'use strict';
// p41 B2: QR pairing. A code is minted on the host (SERVER_TOKEN or a local-only request), shown as a
// QR, and traded once by the app for a device key. Keys are stored hashed and are an equal credential
// to SERVER_TOKEN. Unit-level cases run lib/pairing.js behind a bare http server with a fake clock;
// the cases that are about what server.js does with the credential boot the real server.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { createPairing } = require('../lib/pairing');
const { bootServer, call } = require('./helpers/server-boot');

const TOKEN = 'srv-token-for-tests';
const TEN_MIN = 10 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));

async function mount(opts) {
  const o = opts || {};
  const dir = tmp();
  const file = path.join(dir, 'devices.json');
  const clock = { t: 1_700_000_000_000 };
  const pairing = createPairing({ file, serverToken: o.serverToken === undefined ? TOKEN : o.serverToken,
    publicUrl: o.publicUrl, now: () => clock.t, log: { error() {} } });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/pair/')) return pairing.handle(req, res, u);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { pairing, clock, file, dir, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('start mints an 8-char code from an unambiguous alphabet and a cmuxremote:// link', async () => {
  const m = await mount({ publicUrl: 'https://cmux-max.cafesean.com/' });
  try {
    const r = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    assert.strictEqual(r.status, 200);
    assert.match(r.json.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    assert.strictEqual(r.json.expiresAt, m.clock.t + TEN_MIN);
    assert.strictEqual(r.json.qr, `cmuxremote://pair?u=${encodeURIComponent('https://cmux-max.cafesean.com')}&c=${r.json.code}`);
  } finally { await m.close(); }
});

test('without PUBLIC_URL the link uses the request Host', async () => {
  const m = await mount();
  try {
    const r = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    assert.strictEqual(r.json.qr, `cmuxremote://pair?u=${encodeURIComponent(m.base)}&c=${r.json.code}`);
  } finally { await m.close(); }
});

test('code expires after 10 min', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    m.clock.t += TEN_MIN - 1;
    const ok = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'phone' } });
    assert.strictEqual(ok.status, 200, 'still valid one ms before expiry');
    const second = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    m.clock.t += TEN_MIN;
    const late = await call(m.base, 'POST', '/api/pair/claim', { body: { code: second.json.code, deviceName: 'phone' } });
    assert.strictEqual(late.status, 410);
  } finally { await m.close(); }
});

test('claim with expired code → 410', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    m.clock.t += TEN_MIN + 1;
    const r = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'phone' } });
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.json.error, 'code_expired');
    assert.strictEqual(m.pairing.list().length, 0, 'no device was created');
  } finally { await m.close(); }
});

test('code is single use', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    const a = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'phone' } });
    assert.strictEqual(a.status, 200);
    assert.ok(a.json.deviceKey && a.json.deviceKey.length >= 43, '32 bytes, base64url');
    const b = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'other' } });
    assert.strictEqual(b.status, 404);
    assert.strictEqual(m.pairing.list().length, 1);
  } finally { await m.close(); }
});

test('a code is accepted case-insensitively; junk bodies are 400', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/claim', { body: { deviceName: 'x' } })).status, 400);
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/claim', { body: '{nope' })).status, 400);
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/claim', { body: { code: ` ${json.code.toLowerCase()} `, deviceName: 'x' } })).status, 200);
  } finally { await m.close(); }
});

test('devices.json never contains the raw key', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    const { json: claimed } = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'Sean iPhone' } });
    const raw = fs.readFileSync(m.file, 'utf8');
    assert.ok(!raw.includes(claimed.deviceKey), 'raw key is not on disk');
    const stored = JSON.parse(raw).devices[0];
    assert.strictEqual(stored.keyHash, crypto.createHash('sha256').update(claimed.deviceKey).digest('hex'));
    assert.deepStrictEqual(Object.keys(stored).sort(), ['createdAt', 'deviceName', 'id', 'keyHash', 'lastSeenAt']);
    assert.strictEqual(stored.deviceName, 'Sean iPhone');
    assert.strictEqual(fs.statSync(m.file).mode & 0o777, 0o600);
    assert.strictEqual(fs.readdirSync(m.dir).length, 1, 'the atomic-write temp file is gone');
  } finally { await m.close(); }
});

test('the device list has no hashes, and a revoke removes the device', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'phone' } });
    assert.strictEqual((await call(m.base, 'GET', '/api/pair/devices')).status, 401, 'needs a credential');
    const list = await call(m.base, 'GET', '/api/pair/devices', { token: TOKEN });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.devices.length, 1);
    assert.ok(!('keyHash' in list.json.devices[0]) && !/[0-9a-f]{64}/.test(list.text));
    const id = list.json.devices[0].id;
    assert.strictEqual((await call(m.base, 'DELETE', `/api/pair/devices/${id}`, { token: TOKEN })).status, 200);
    assert.strictEqual((await call(m.base, 'DELETE', `/api/pair/devices/${id}`, { token: TOKEN })).status, 404);
    assert.strictEqual((await call(m.base, 'GET', '/api/pair/devices', { token: TOKEN })).json.devices.length, 0);
  } finally { await m.close(); }
});

test('devices survive a restart (a new instance reads the same file)', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    const { json: c } = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'phone' } });
    const again = createPairing({ file: m.file, serverToken: TOKEN, log: { error() {} } });
    assert.ok(again.verifyKey(c.deviceKey));
    assert.strictEqual(again.verifyKey('not-a-key'), null);
    assert.strictEqual(again.verifyKey(''), null);
  } finally { await m.close(); }
});

test('start: SERVER_TOKEN works from anywhere, a local request works without it', async () => {
  const m = await mount();
  try {
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/start', { token: TOKEN, headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 200);
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/start', { headers: { 'x-app-token': TOKEN, 'x-forwarded-for': '203.0.113.9' } })).status, 200);
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/start')).status, 200, 'loopback, no forwarding header');
    const wrong = await call(m.base, 'POST', '/api/pair/start', { token: 'nope', headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(wrong.status, 401);
  } finally { await m.close(); }
});

test('start refused from a forwarded (tunnel) request without SERVER_TOKEN', async () => {
  const open = await mount({ serverToken: '' });
  const locked = await mount();
  try {
    const a = await call(open.base, 'POST', '/api/pair/start', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(a.status, 403);
    assert.strictEqual(a.json.error, 'local_only');
    assert.strictEqual((await call(open.base, 'POST', '/api/pair/start')).status, 200, 'local is fine on an open server');
    const b = await call(locked.base, 'POST', '/api/pair/start', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(b.status, 401);
    assert.strictEqual(open.pairing.list().length + locked.pairing.list().length, 0);
  } finally { await open.close(); await locked.close(); }
});

test('a device key cannot mint more pairing codes', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    const { json: c } = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'phone' } });
    const r = await call(m.base, 'POST', '/api/pair/start', { token: c.deviceKey, headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(r.status, 401);
  } finally { await m.close(); }
});

test('claim attempts are rate limited: 10 misses a minute, then 429', async () => {
  const m = await mount();
  try {
    const { json } = await call(m.base, 'POST', '/api/pair/start', { token: TOKEN });
    for (let i = 0; i < 10; i++) {
      assert.strictEqual((await call(m.base, 'POST', '/api/pair/claim', { body: { code: 'AAAAAAAA', deviceName: 'x' } })).status, 404);
    }
    const blocked = await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'x' } });
    assert.strictEqual(blocked.status, 429);
    m.clock.t += 60_001;
    assert.strictEqual((await call(m.base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: 'x' } })).status, 200);
  } finally { await m.close(); }
});

// ---- the real server ----------------------------------------------------------------------------
async function boot() {
  const dir = tmp();
  const devices = path.join(dir, 'devices.json');
  const s = await bootServer({ env: { SERVER_TOKEN: TOKEN, DEVICES_FILE: devices, PUBLIC_URL: 'https://cmux-max.cafesean.com' } });
  return { s, devices };
}
async function pairOne(base, name) {
  const { json } = await call(base, 'POST', '/api/pair/start', { token: TOKEN });
  const r = await call(base, 'POST', '/api/pair/claim', { body: { code: json.code, deviceName: name || 'phone' } });
  assert.strictEqual(r.status, 200);
  return r.json.deviceKey;
}

test('device key works where SERVER_TOKEN does, in every header form', async () => {
  const { s, devices } = await boot();
  try {
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines')).status, 401);
    const key = await pairOne(s.base);
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines', { token: TOKEN })).status, 200);
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines', { token: key })).status, 200, 'Authorization: Bearer');
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines', { headers: { 'x-app-token': key } })).status, 200, 'x-app-token');
    assert.strictEqual((await call(s.base, 'GET', `/api/cmux/machines?token=${key}`)).status, 200, '?token=');
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines', { token: key + 'x' })).status, 401);
    assert.ok(!fs.readFileSync(devices, 'utf8').includes(key));
  } finally { await s.stop(); }
});

test('revoked key refused', async () => {
  const { s } = await boot();
  try {
    const key = await pairOne(s.base);
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines', { token: key })).status, 200);
    const id = (await call(s.base, 'GET', '/api/pair/devices', { token: key })).json.devices[0].id;
    assert.strictEqual((await call(s.base, 'DELETE', `/api/pair/devices/${id}`, { token: TOKEN })).status, 200);
    assert.strictEqual((await call(s.base, 'GET', '/api/cmux/machines', { token: key })).status, 401);
    assert.strictEqual((await call(s.base, 'GET', '/api/pair/devices', { token: key })).status, 401);
  } finally { await s.stop(); }
});

test('real server: local start needs no token, a tunnelled one does; claim is open', async () => {
  const { s } = await boot();
  try {
    const local = await call(s.base, 'POST', '/api/pair/start');
    assert.strictEqual(local.status, 200);
    assert.ok(local.json.qr.startsWith('cmuxremote://pair?u=https%3A%2F%2Fcmux-max.cafesean.com&c='));
    const tunnel = await call(s.base, 'POST', '/api/pair/start', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(tunnel.status, 401);
    const claim = await call(s.base, 'POST', '/api/pair/claim', { body: { code: local.json.code, deviceName: 'phone' }, headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(claim.status, 200, 'the app claims through the tunnel without any credential');
  } finally { await s.stop(); }
});

test('bin/cmux-remote-pair.js prints a QR and the raw link against the real server', async () => {
  const { s } = await boot();
  try {
    const cli = path.join(__dirname, '..', 'bin', 'cmux-remote-pair.js');
    const run = (args) => new Promise((resolve) => {
      const c = spawn(process.execPath, [cli, ...args], { cwd: s.cwd, env: { PATH: process.env.PATH, PORT: String(s.port) } });
      let stdout = ''; let stderr = '';
      c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      c.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const full = await run([]);
    assert.strictEqual(full.code, 0, full.stderr);
    const lines = full.stdout.split('\n');
    const link = lines.find((l) => l.startsWith('cmuxremote://pair?'));
    assert.ok(link && link.includes('u=https%3A%2F%2Fcmux-max.cafesean.com&c='), 'the raw link sits on its own line');
    assert.ok(/[█▀▄]/.test(full.stdout), 'a QR is drawn');
    const only = await run(['--link']);
    assert.match(only.stdout, /^cmuxremote:\/\/pair\?u=[^\n]+&c=[A-Z2-9]{8}\n$/);
    const dead = spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH, PORT: '1' }, cwd: s.cwd, encoding: 'utf8' });
    assert.strictEqual(dead.status, 1);
    assert.match(dead.stderr, /no server on 127\.0\.0\.1:1/);
  } finally { await s.stop(); }
});
