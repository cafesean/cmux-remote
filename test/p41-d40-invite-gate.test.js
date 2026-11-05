'use strict';
// p41 D40 W2: the invite gate. Only a device with canInvite (the desktop app paired on the Mac by the Allow
// click) or SERVER_TOKEN may mint a pairing code. Starts are rate limited per credential, live codes are
// capped server-wide, and a code is refused when the only address it could carry is loopback. Fixtures are
// synthetic; no test pops a real dialog.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPairing } = require('../lib/pairing');
const { createConfirm } = require('../lib/confirm-dialog');

const TOKEN = 'srv-token-for-tests';
const PUB = 'https://mux.example.test';
const KEY_QR = 'qr-paired-device-key-for-tests';
const KEY_LOCAL = 'local-desktop-device-key-for-tests';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pair-invite-'));

function req(base, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? '' : JSON.stringify(body);
    const h = { ...(headers || {}) };
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: u.hostname, port: u.port, method, path: p, headers: h }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject); r.end(data);
  });
}

// A legacy (pre-W2) QR-paired device with no flags, and a local desktop device with canInvite.
function seed(dir) {
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, JSON.stringify({ devices: [
    { id: 'aaaaaaaaaaaa', deviceName: 'phone', keyHash: sha256(KEY_QR), createdAt: 1, lastSeenAt: 1 },
    { id: 'bbbbbbbbbbbb', deviceName: 'Desk app', keyHash: sha256(KEY_LOCAL), createdAt: 1, lastSeenAt: 1, local: true, canInvite: true, invitedBy: 'local' },
  ] }));
  return file;
}

async function mount(o = {}) {
  const dir = tmp();
  const file = o.noSeed ? path.join(dir, 'devices.json') : seed(dir);
  const clock = { t: 1_700_000_000_000 };
  const pairing = createPairing({ file, serverToken: o.serverToken === undefined ? TOKEN : o.serverToken,
    publicUrl: o.publicUrl === undefined ? PUB : o.publicUrl, now: () => clock.t, log: { error() {} }, ...(o.pairing || {}) });
  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://x');
    if (u.pathname.startsWith('/api/pair/')) return pairing.handle(rq, rs, u);
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { pairing, clock, file, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
const bearer = (k, extra) => ({ authorization: `Bearer ${k}`, ...(extra || {}) });
const start = (m, k, extra) => req(m.base, 'POST', '/api/pair/start', bearer(k, extra));
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).devices;

test('invite gate: a QR-paired key → 403 not_allowed; no code minted', async () => {
  const m = await mount();
  try {
    const r = await start(m, KEY_QR);
    assert.strictEqual(r.status, 403, r.text);
    assert.deepStrictEqual(r.json, { error: 'not_allowed' });
    assert.strictEqual(r.text.includes('code'), false);
  } finally { await m.close(); }
});

test('invite gate: a local (canInvite) key → code; success shape unchanged', async () => {
  const m = await mount();
  try {
    const r = await start(m, KEY_LOCAL);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['code', 'expiresAt', 'qr']);
    assert.strictEqual(r.json.qr, `cmuxremote://pair?u=${encodeURIComponent(PUB)}&c=${r.json.code}`);
  } finally { await m.close(); }
});

test('invite gate: a bad key is still 401, the token still mints, from anywhere', async () => {
  const m = await mount();
  try {
    assert.strictEqual((await start(m, 'nope')).status, 401);
    const r = await start(m, TOKEN, { 'x-forwarded-for': '203.0.113.7' });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.json.code, /^[A-Z2-9]{8}$/);
  } finally { await m.close(); }
});

test('invite gate: the 6th start in a minute → 429 rate_limited, per credential; the window slides', async () => {
  const m = await mount();
  try {
    for (let i = 0; i < 5; i++) assert.strictEqual((await start(m, KEY_LOCAL)).status, 200, `start ${i + 1}`);
    const sixth = await start(m, KEY_LOCAL);
    assert.strictEqual(sixth.status, 429);
    assert.deepStrictEqual(sixth.json, { error: 'rate_limited' });
    assert.strictEqual((await start(m, TOKEN)).status, 200, 'another credential has its own budget');
    m.clock.t += 60 * 1000 + 1;
    assert.strictEqual((await start(m, KEY_LOCAL)).status, 200, 'a minute later the key may start again');
  } finally { await m.close(); }
});

test('invite gate: the 21st live code → 429 too_many_codes; a claim or expiry frees a slot', async () => {
  const m = await mount();
  try {
    let last;
    for (let i = 0; i < 20; i++) {
      if (i && i % 5 === 0) m.clock.t += 61 * 1000;          // stay under the per-minute budget
      last = await start(m, i % 2 ? TOKEN : KEY_LOCAL);
      assert.strictEqual(last.status, 200, `code ${i + 1}: ${last.text}`);
    }
    m.clock.t += 61 * 1000;
    const over = await start(m, TOKEN);
    assert.strictEqual(over.status, 429);
    assert.deepStrictEqual(over.json, { error: 'too_many_codes' });
    const c = await req(m.base, 'POST', '/api/pair/claim', {}, { code: last.json.code, deviceName: 'tablet' });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual((await start(m, TOKEN)).status, 200, 'a claimed code no longer counts');
    assert.strictEqual((await start(m, TOKEN)).status, 429);
    m.clock.t += 10 * 60 * 1000;                              // the first codes expire
    assert.strictEqual((await start(m, TOKEN)).status, 200, 'an expired code no longer counts');
  } finally { await m.close(); }
});

test('invite gate: loopback Host + no PUBLIC_URL → 409 no_public_address (token, local key, open server)', async () => {
  const m = await mount({ publicUrl: '' });
  try {
    for (const k of [TOKEN, KEY_LOCAL]) {
      for (const host of [`127.0.0.1:${m.port}`, `localhost:${m.port}`, `[::1]:${m.port}`]) {
        const r = await req(m.base, 'POST', '/api/pair/start', bearer(k, { host }));
        assert.strictEqual(r.status, 409, `${host}: ${r.text}`);
        assert.deepStrictEqual(r.json, { error: 'no_public_address' });
      }
    }
    // A Host the phone can reach (LAN name, tunnel) still mints, and the link carries it.
    const ok = await req(m.base, 'POST', '/api/pair/start', bearer(TOKEN, { host: 'mac.example.test:8080' }));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.ok(ok.json.qr.startsWith(`cmuxremote://pair?u=${encodeURIComponent('http://mac.example.test:8080')}&c=`));
    // The not_allowed answer comes first: a QR key learns nothing about the address.
    assert.strictEqual((await req(m.base, 'POST', '/api/pair/start', bearer(KEY_QR, { host: `127.0.0.1:${m.port}` }))).status, 403);
  } finally { await m.close(); }
  const open = await mount({ publicUrl: '', serverToken: '' });
  try {
    const r = await req(open.base, 'POST', '/api/pair/start', { host: `127.0.0.1:${open.port}` });
    assert.strictEqual(r.status, 409, r.text);
    assert.deepStrictEqual(r.json, { error: 'no_public_address' });
  } finally { await open.close(); }
});

test('invite gate: a 409 or 403 does not use the rate budget', async () => {
  const m = await mount({ publicUrl: '' });
  try {
    for (let i = 0; i < 7; i++) assert.strictEqual((await req(m.base, 'POST', '/api/pair/start', bearer(KEY_LOCAL, { host: `127.0.0.1:${m.port}` }))).status, 409);
    for (let i = 0; i < 5; i++) assert.strictEqual((await req(m.base, 'POST', '/api/pair/start', bearer(KEY_LOCAL, { host: 'mac.example.test' }))).status, 200);
  } finally { await m.close(); }
});

test('invite gate: claim records invitedBy (device id or token); the new device cannot invite', async () => {
  const m = await mount();
  try {
    const a = await start(m, KEY_LOCAL);
    const b = await start(m, TOKEN);
    const ca = await req(m.base, 'POST', '/api/pair/claim', {}, { code: a.json.code, deviceName: 'phone-a' });
    const cb = await req(m.base, 'POST', '/api/pair/claim', {}, { code: b.json.code, deviceName: 'phone-b' });
    assert.strictEqual(ca.status, 200); assert.strictEqual(cb.status, 200);
    const disk = onDisk(m.file);
    const da = disk.find((d) => d.id === ca.json.id);
    const db = disk.find((d) => d.id === cb.json.id);
    assert.strictEqual(da.invitedBy, 'bbbbbbbbbbbb');
    assert.strictEqual(db.invitedBy, 'token');
    assert.strictEqual(da.canInvite, false);
    assert.strictEqual(da.local, false);
    const r = await start(m, ca.json.deviceKey);
    assert.strictEqual(r.status, 403, 'a phone paired by QR cannot invite');
    assert.deepStrictEqual(r.json, { error: 'not_allowed' });
  } finally { await m.close(); }
});

test('invite gate: open server local CLI start records invitedBy local', async () => {
  const m = await mount({ serverToken: '' });
  try {
    const r = await req(m.base, 'POST', '/api/pair/start', { host: `127.0.0.1:${m.port}` });
    assert.strictEqual(r.status, 200, r.text);
    const c = await req(m.base, 'POST', '/api/pair/claim', {}, { code: r.json.code, deviceName: 'phone' });
    assert.strictEqual(onDisk(m.file).find((d) => d.id === c.json.id).invitedBy, 'local');
  } finally { await m.close(); }
});

test('legacy devices.json without canInvite loads; the list shows local/canInvite false, invitedBy null', async () => {
  const m = await mount();
  try {
    const r = await req(m.base, 'GET', '/api/pair/devices', bearer(TOKEN));
    assert.strictEqual(r.status, 200, r.text);
    const byId = Object.fromEntries(r.json.devices.map((d) => [d.id, d]));
    assert.deepStrictEqual(byId.aaaaaaaaaaaa, { id: 'aaaaaaaaaaaa', deviceName: 'phone', createdAt: 1, lastSeenAt: byId.aaaaaaaaaaaa.lastSeenAt, local: false, canInvite: false, invitedBy: null });
    assert.strictEqual(byId.bbbbbbbbbbbb.local, true);
    assert.strictEqual(byId.bbbbbbbbbbbb.canInvite, true);
    assert.strictEqual(byId.bbbbbbbbbbbb.invitedBy, 'local');
    assert.ok(!r.text.includes('keyHash'));
    // A legacy key still authenticates everywhere else.
    assert.strictEqual((await req(m.base, 'GET', '/api/pair/devices', bearer(KEY_QR))).status, 200);
  } finally { await m.close(); }
});

test('invite gate: canInvite must be exactly true (a truthy string is not enough)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, JSON.stringify({ devices: [{ id: 'cccccccccccc', deviceName: 'x', keyHash: sha256(KEY_QR), createdAt: 1, lastSeenAt: 1, canInvite: 'true' }] }));
  const pairing = createPairing({ file, serverToken: TOKEN, publicUrl: PUB, log: { error() {} } });
  const server = http.createServer((rq, rs) => pairing.handle(rq, rs, new URL(rq.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await req(`http://127.0.0.1:${server.address().port}`, 'POST', '/api/pair/start', bearer(KEY_QR));
    assert.strictEqual(r.status, 403);
  } finally { await new Promise((r) => server.close(r)); }
});

// ---- W1 review fold-ins ----------------------------------------------------------------------------

function fakeConfirm(answer) {
  const calls = [];
  return { calls, available: () => true, ask(o) { calls.push(o); return answer === 'hold' ? new Promise(() => {}) : Promise.resolve(answer); } };
}
const lh = (m) => ({ host: `127.0.0.1:${m.port}` });

test('W1 fold-in: a failed save on an allowed local pair keeps the request; the retried wait mints', async () => {
  let fail = true;
  const write = (f, text) => { if (fail) throw new Error('disk full'); fs.writeFileSync(f, text); };
  const m = await mount({ pairing: { confirm: fakeConfirm('allow'), write } });
  try {
    const s = await req(m.base, 'POST', '/api/pair/local', lh(m), { deviceName: 'Desk app' });
    assert.strictEqual(s.status, 202, s.text);
    const w1 = await req(m.base, 'POST', '/api/pair/local/wait', lh(m), { requestId: s.json.requestId });
    assert.strictEqual(w1.status, 500);
    assert.deepStrictEqual(w1.json, { error: 'storage_failed' });
    fail = false;
    const w2 = await req(m.base, 'POST', '/api/pair/local/wait', lh(m), { requestId: s.json.requestId });
    assert.strictEqual(w2.status, 200, w2.text);
    assert.ok(w2.json.deviceKey);
    const w3 = await req(m.base, 'POST', '/api/pair/local/wait', lh(m), { requestId: s.json.requestId });
    assert.strictEqual(w3.status, 404, 'single use once minted');
  } finally { await m.close(); }
});

test('W1 fold-in: the server deadline aborts the dialog (signal passed to confirm.ask)', async () => {
  const confirm = fakeConfirm('hold');
  const m = await mount({ pairing: { confirm, localWaitMs: 50 } });
  try {
    const s = await req(m.base, 'POST', '/api/pair/local', lh(m), { deviceName: 'Desk app' });
    assert.strictEqual(s.status, 202);
    const sig = confirm.calls[0].signal;
    assert.ok(sig && typeof sig.aborted === 'boolean', 'ask gets an AbortSignal');
    assert.strictEqual(sig.aborted, false);
    const w = await req(m.base, 'POST', '/api/pair/local/wait', lh(m), { requestId: s.json.requestId });
    assert.strictEqual(w.status, 403);
    assert.deepStrictEqual(w.json, { error: 'timeout' });
    assert.strictEqual(sig.aborted, true, 'the dialog is closed when the server gives up');
  } finally { await m.close(); }
});

test('W1 fold-in: createConfirm passes the signal to execFile; an abort is a timeout', async () => {
  const seen = [];
  const execFile = (cmd, args, opts, cb) => {
    seen.push(opts);
    opts.signal.addEventListener('abort', () => cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }), '', ''));
  };
  const c = createConfirm({ platform: 'darwin', execFile });
  const ac = new AbortController();
  const p = c.ask({ number: '1234', deviceName: 'x', timeoutMs: 60000, signal: ac.signal });
  ac.abort();
  assert.strictEqual(await p, 'timeout');
  assert.strictEqual(seen[0].signal, ac.signal);
});

test('W1 fold-in: format characters (bidi, zero-width) are flattened in the shown name; copy says compare', async () => {
  const seen = [];
  const execFile = (cmd, args, opts, cb) => { seen.push(args); setImmediate(() => cb(null, 'button returned:Deny, gave up:false\n', '')); };
  const c = createConfirm({ platform: 'darwin', execFile });
  await c.ask({ number: '1234', deviceName: 'a‮b⁦c​d‏e﻿f', timeoutMs: 60000 });
  const args = seen[0];
  const name = args[args.length - 2];
  assert.ok(!/\p{Cf}/u.test(name), `no format characters left: ${JSON.stringify(name)}`);
  assert.match(name, /^a b c d e f$/);
  const script = args.filter((a, i) => args[i - 1] === '-e').join('\n');
  assert.match(script, /Allow only if the app shows this number\./);
});
