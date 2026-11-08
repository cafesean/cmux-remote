'use strict';
// p41 D40 W0: GET /api/pair/hello and a persistent serverId. The desktop app probes the server on
// this Mac with no credential; hello answers only harmless facts, and only to a request localOnly()
// accepts (loopback peer, loopback Host, no Origin / cross-site fetch, no forwarding header). serverId
// is created once next to devices.json so the app can tell "same server I already paired by tunnel".
// Fixtures are synthetic.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPairing, thisMacName, THIS_MAC_LABEL } = require('../lib/pairing');
const { bootServer } = require('./helpers/server-boot');

const TOKEN = 'srv-token-for-tests';
const ID_RE = /^[0-9a-f]{24}$/;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pair-hello-'));

// http.request, not fetch: a test has to set Host and Origin freely, which fetch will not.
function raw(base, method, pathAndQuery, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ host: u.hostname, port: u.port, method, path: pathAndQuery, headers: headers || {} }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject); r.end();
  });
}

async function mount(opts) {
  const o = opts || {};
  const dir = o.dir || tmp();
  const file = path.join(dir, 'devices.json');
  const pairing = createPairing({ file, serverToken: TOKEN, log: { error() {} }, ...o.pairing });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/pair/')) return pairing.handle(req, res, u);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { pairing, dir, file, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('hello answers on loopback with no credential, even on a server with a SERVER_TOKEN', async () => {
  const m = await mount({ pairing: { version: '9.9.9', localMachine: 'local-a' } });
  try {
    const r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}` });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json, {
      app: 'cmux-remote', version: '9.9.9', serverId: m.pairing.serverId, localMachine: 'local-a',
      hasPublicUrl: false, autoPair: false,
    });
    assert.match(r.json.serverId, ID_RE);
    // localhost Host is loopback too
    assert.strictEqual((await raw(m.base, 'GET', '/api/pair/hello', { host: `localhost:${m.port}` })).status, 200);
  } finally { await m.close(); }
});

test('hello reports hasPublicUrl, a lazy localMachine and autoPair from the confirm mechanism', async () => {
  let avail = false;
  const m = await mount({ pairing: { publicUrl: 'https://mirror.example.test', localMachine: () => 'm1', autoPair: () => avail } });
  try {
    const h = { host: `127.0.0.1:${m.port}` };
    let r = await raw(m.base, 'GET', '/api/pair/hello', h);
    assert.strictEqual(r.json.hasPublicUrl, true);
    assert.strictEqual(r.json.localMachine, 'm1');
    assert.strictEqual(r.json.autoPair, false);
    avail = true;
    r = await raw(m.base, 'GET', '/api/pair/hello', h);
    assert.strictEqual(r.json.autoPair, true);
  } finally { await m.close(); }
});

test('hello with no local machine says null, never undefined', async () => {
  const m = await mount();
  try {
    const r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.localMachine, null);
    assert.strictEqual(typeof r.json.version, 'string');
  } finally { await m.close(); }
});

test('hello 403 with Origin header', async () => {
  const m = await mount();
  try {
    const r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}`, origin: 'http://evil.example.test' });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { error: 'local_only' });
    assert.ok(!r.text.includes(m.pairing.serverId), 'serverId must not leak in a refusal');
  } finally { await m.close(); }
});

test('hello 403 with x-forwarded-for', async () => {
  const m = await mount();
  try {
    const r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}`, 'x-forwarded-for': '203.0.113.7' });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { error: 'local_only' });
  } finally { await m.close(); }
});

test('hello 403 for a rebinding Host and a cross-site fetch; credentials do not unlock it', async () => {
  const m = await mount();
  try {
    let r = await raw(m.base, 'GET', '/api/pair/hello', { host: 'rebind.example.test' });
    assert.strictEqual(r.status, 403);
    r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}`, 'sec-fetch-site': 'cross-site' });
    assert.strictEqual(r.status, 403);
    r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}`, 'x-forwarded-for': '203.0.113.7', authorization: `Bearer ${TOKEN}` });
    assert.strictEqual(r.status, 403, 'hello is local-only, a token through the tunnel does not open it');
  } finally { await m.close(); }
});

test('hello is GET only', async () => {
  const m = await mount();
  try {
    const r = await raw(m.base, 'POST', '/api/pair/hello', { host: `127.0.0.1:${m.port}` });
    assert.strictEqual(r.status, 404);
  } finally { await m.close(); }
});

test('serverId stable across two createPairing() on the same dir', () => {
  const dir = tmp();
  const file = path.join(dir, 'devices.json');
  const a = createPairing({ file, log: { error() {} } });
  assert.match(a.serverId, ID_RE);
  const idFile = path.join(dir, 'server-id');
  assert.strictEqual(fs.readFileSync(idFile, 'utf8').trim(), a.serverId, 'idFile defaults next to devices.json');
  assert.strictEqual(fs.statSync(idFile).mode & 0o777, 0o600);
  const b = createPairing({ file, log: { error() {} } });
  assert.strictEqual(b.serverId, a.serverId);
  const c = createPairing({ file: path.join(tmp(), 'devices.json'), log: { error() {} } });
  assert.notStrictEqual(c.serverId, a.serverId, 'another server dir is another server');
});

test('explicit idFile is honoured; a corrupt id file is replaced and logged', () => {
  const dir = tmp();
  const idFile = path.join(dir, 'nested', 'my-id');
  const a = createPairing({ file: path.join(dir, 'devices.json'), idFile, log: { error() {} } });
  assert.ok(!fs.existsSync(idFile), 'nothing is written until the id is first used');
  const first = a.serverId;
  assert.strictEqual(fs.readFileSync(idFile, 'utf8').trim(), first);
  fs.writeFileSync(idFile, 'not-an-id\n');
  const errors = [];
  const b = createPairing({ file: path.join(dir, 'devices.json'), idFile, log: { error: (s) => errors.push(s) } });
  assert.match(b.serverId, ID_RE);
  assert.notStrictEqual(b.serverId, a.serverId);
  assert.strictEqual(fs.readFileSync(idFile, 'utf8').trim(), b.serverId);
  assert.strictEqual(errors.length, 1);
});

test('an unwritable id file still gives a usable in-memory serverId and logs it', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file, so nothing can be created under it');
  const errors = [];
  const p = createPairing({ file: path.join(dir, 'devices.json'), idFile: path.join(blocker, 'server-id'), log: { error: (s) => errors.push(s) } });
  assert.match(p.serverId, ID_RE);
  assert.ok(errors.some((e) => /will not persist/.test(e)), errors.join('\n'));
  assert.strictEqual(p.serverId, p.serverId, 'one id for the life of the process even when it cannot persist');
});

// ---- the real server ----------------------------------------------------------------------------
test('real server: hello names the loopback machine, its package version, and keeps serverId across restarts', async () => {
  const dir = tmp();
  const env = { SERVER_TOKEN: TOKEN, DEVICES_FILE: path.join(dir, 'devices.json'), CMUX_MACHINE_URL: 'http://127.0.0.1:9', PAIR_LOCAL: 'off' };
  const version = require('../package.json').version;
  let s = await bootServer({ env });
  let first;
  try {
    const r = await raw(s.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${s.port}` });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.app, 'cmux-remote');
    assert.strictEqual(r.json.version, version);
    assert.strictEqual(r.json.localMachine, 'default');
    assert.strictEqual(r.json.hasPublicUrl, false);
    assert.strictEqual(r.json.autoPair, false);
    assert.match(r.json.serverId, ID_RE);
    first = r.json.serverId;
    const no = await raw(s.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${s.port}`, origin: 'http://evil.example.test' });
    assert.strictEqual(no.status, 403);
  } finally { await s.stop(); }
  s = await bootServer({ env: { ...env, CMUX_MACHINE_URL: 'https://remote.example.test', PUBLIC_URL: 'https://mirror.example.test' } });
  try {
    const r = await raw(s.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${s.port}` });
    assert.strictEqual(r.json.serverId, first, 'serverId survives a restart');
    assert.strictEqual(r.json.localMachine, null, 'a remote-only registry has no local machine');
    assert.strictEqual(r.json.hasPublicUrl, true);
  } finally { await s.stop(); }
});

// ---- W1: POST /api/pair/local + the Allow click ----------------------------------------------------
// The confirm mechanism is injected: no test ever pops a real dialog.
const { createConfirm } = require('../lib/confirm-dialog');
const lh = (m) => ({ host: `127.0.0.1:${m.port}`, 'content-type': 'application/json' });

function post(base, p, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({ host: u.hostname, port: u.port, method: 'POST', path: p, headers: { ...headers, 'content-length': Buffer.byteLength(data) } }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject); r.end(data);
  });
}

// A fake confirm whose answer the test chooses, or holds open until the test releases it.
function fakeConfirm(answer) {
  const calls = [];
  let release = null;
  return {
    calls,
    available: () => answer !== 'unavailable-now',
    ask(o) { calls.push(o); if (answer === 'hold') return new Promise((r) => { release = r; }); return Promise.resolve(answer); },
    release: (a) => release && release(a),
  };
}

const devicesOnDisk = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).devices; } catch (_) { return null; } };

test('local pair: allow → device key, device saved local+canInvite, key works', async () => {
  const confirm = fakeConfirm('allow');
  const m = await mount({ pairing: { confirm, localMachine: 'local-a' } });
  try {
    const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'Desk app' });
    assert.strictEqual(r.status, 202, r.text);
    assert.match(r.json.requestId, /^[0-9a-f]{32}$/);
    assert.match(r.json.number, /^\d{4}$/);
    assert.strictEqual(confirm.calls.length, 1);
    assert.strictEqual(confirm.calls[0].number, r.json.number, 'the dialog shows the same number the app shows');
    assert.strictEqual(confirm.calls[0].deviceName, 'Desk app');
    assert.strictEqual(confirm.calls[0].timeoutMs, 60 * 1000);
    const w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
    assert.strictEqual(w.status, 200, w.text);
    assert.deepStrictEqual(Object.keys(w.json).sort(), ['deviceKey', 'id', 'localMachine', 'serverId']);
    assert.strictEqual(w.json.serverId, m.pairing.serverId);
    assert.strictEqual(w.json.localMachine, 'local-a');
    const dev = devicesOnDisk(m.file).find((d) => d.id === w.json.id);
    assert.ok(dev, 'device is on disk');
    assert.strictEqual(dev.local, true);
    assert.strictEqual(dev.canInvite, true);
    assert.strictEqual(dev.invitedBy, 'local');
    assert.ok(!JSON.stringify(devicesOnDisk(m.file)).includes(w.json.deviceKey), 'only the hash is stored');
    assert.ok(m.pairing.verifyKey(w.json.deviceKey), 'the key is a credential');
    // the result is single use
    const again = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
    assert.strictEqual(again.status, 404);
  } finally { await m.close(); }
});

test('local pair: deny → 403 denied, devices.json unchanged (second user on the Mac gets nothing without the click)', async () => {
  const confirm = fakeConfirm('deny');
  const m = await mount({ pairing: { confirm } });
  try {
    const before = fs.existsSync(m.file) ? fs.readFileSync(m.file, 'utf8') : null;
    const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
    assert.strictEqual(r.status, 202);
    const w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
    assert.strictEqual(w.status, 403);
    assert.deepStrictEqual(w.json, { error: 'denied' });
    const after = fs.existsSync(m.file) ? fs.readFileSync(m.file, 'utf8') : null;
    assert.strictEqual(after, before);
    assert.strictEqual(m.pairing.list().length, 0);
  } finally { await m.close(); }
});

test('local pair: timeout → 403 timeout; unavailable → 403 unavailable', async () => {
  for (const a of ['timeout', 'unavailable']) {
    const m = await mount({ pairing: { confirm: fakeConfirm(a) } });
    try {
      const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
      assert.strictEqual(r.status, 202);
      const w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
      assert.strictEqual(w.status, 403);
      assert.deepStrictEqual(w.json, { error: a });
      assert.strictEqual(m.pairing.list().length, 0);
    } finally { await m.close(); }
  }
});

test('local pair: a confirm that throws or answers garbage fails closed', async () => {
  for (const confirm of [{ available: () => true, ask: () => Promise.reject(new Error('boom')) },
    { available: () => true, ask: () => Promise.resolve('yes please') }]) {
    const m = await mount({ pairing: { confirm } });
    try {
      const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
      const w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
      assert.strictEqual(w.status, 403);
      assert.strictEqual(m.pairing.list().length, 0);
    } finally { await m.close(); }
  }
});

test('local pair: no confirm mechanism → 403 unavailable before any dialog', async () => {
  const confirm = fakeConfirm('unavailable-now');
  const m = await mount({ pairing: { confirm } });
  try {
    const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { error: 'unavailable' });
    assert.strictEqual(confirm.calls.length, 0);
    const none = await mount();      // createPairing with no confirm at all
    try {
      assert.strictEqual((await post(none.base, '/api/pair/local', lh(none), { deviceName: 'x' })).status, 403);
    } finally { await none.close(); }
  } finally { await m.close(); }
});

test('local pair: second request while one is pending → 409; one dialog at a time', async () => {
  const confirm = fakeConfirm('hold');
  const m = await mount({ pairing: { confirm } });
  try {
    const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
    assert.strictEqual(r.status, 202);
    const r2 = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'y' });
    assert.strictEqual(r2.status, 409);
    assert.deepStrictEqual(r2.json, { error: 'pending' });
    assert.strictEqual(confirm.calls.length, 1);
    const waiting = post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
    await new Promise((res) => setTimeout(res, 30));
    // the event loop is free while the click is awaited
    assert.strictEqual((await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}` })).status, 200);
    confirm.release('allow');
    const w = await waiting;
    assert.strictEqual(w.status, 200, w.text);
  } finally { await m.close(); }
});

test('local pair: 4th request in 10 min → 429; the window slides', async () => {
  let t = 1_000_000;
  const m = await mount({ pairing: { confirm: fakeConfirm('deny'), now: () => t } });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
      assert.strictEqual(r.status, 202, `attempt ${i + 1}`);
      await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
      t += 1000;
    }
    const r4 = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
    assert.strictEqual(r4.status, 429);
    assert.deepStrictEqual(r4.json, { error: 'rate_limited' });
    t += 10 * 60 * 1000;
    assert.strictEqual((await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' })).status, 202);
  } finally { await m.close(); }
});

test('local pair: a dialog that never answers is cut off at LOCAL_WAIT_MS', async () => {
  let t = 1_000_000;
  const confirm = fakeConfirm('hold');
  const m = await mount({ pairing: { confirm, now: () => t, localWaitMs: 50 } });
  try {
    const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' });
    const w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
    assert.strictEqual(w.status, 403);
    assert.deepStrictEqual(w.json, { error: 'timeout' });
    confirm.release('allow');                   // a late click does nothing
    await new Promise((res) => setTimeout(res, 10));
    assert.strictEqual(m.pairing.list().length, 0);
    assert.strictEqual((await post(m.base, '/api/pair/local', lh(m), { deviceName: 'x' })).status, 202, 'no longer pending');
  } finally { await m.close(); }
});

test('local pair: wait with unknown or missing requestId → 404 / 400', async () => {
  const m = await mount({ pairing: { confirm: fakeConfirm('allow') } });
  try {
    let w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: 'ab'.repeat(16) });
    assert.strictEqual(w.status, 404);
    w = await post(m.base, '/api/pair/local/wait', lh(m), {});
    assert.strictEqual(w.status, 400);
  } finally { await m.close(); }
});

test('local pair: Origin, rebinding Host, cross-site → 403 local_only on both routes, no dialog', async () => {
  const confirm = fakeConfirm('allow');
  const m = await mount({ pairing: { confirm } });
  try {
    const bad = [
      { ...lh(m), origin: 'http://evil.example.test' },
      { ...lh(m), host: 'rebind.example.test' },
      { ...lh(m), 'sec-fetch-site': 'same-origin' },
    ];
    for (const h of bad) {
      const r = await post(m.base, '/api/pair/local', h, { deviceName: 'x' });
      assert.strictEqual(r.status, 403, JSON.stringify(h));
      assert.deepStrictEqual(r.json, { error: 'local_only' });
      const w = await post(m.base, '/api/pair/local/wait', h, { requestId: 'ab'.repeat(16) });
      assert.strictEqual(w.status, 403);
    }
    assert.strictEqual(confirm.calls.length, 0);
  } finally { await m.close(); }
});

test('cloudflared headers (cf-connecting-ip + x-forwarded-for + cf-ray + public Host) → 403 on hello AND local', async () => {
  const confirm = fakeConfirm('allow');
  const m = await mount({ pairing: { confirm } });
  try {
    const tunnel = { host: 'mirror.example.test', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7',
      'cf-ray': '0123456789abcdef-AAA', 'x-forwarded-proto': 'https', 'content-type': 'application/json' };
    // each tunnel signal on its own also refuses, so one edit to FORWARD_HEADERS cannot open the route
    const each = [tunnel,
      { host: `127.0.0.1:${m.port}`, 'cf-connecting-ip': '203.0.113.7' },
      { host: `127.0.0.1:${m.port}`, 'cf-ray': '0123456789abcdef-AAA' },
      { host: 'mirror.example.test' }];
    for (const h of each) {
      assert.strictEqual((await raw(m.base, 'GET', '/api/pair/hello', h)).status, 403, `hello ${JSON.stringify(h)}`);
      const r = await post(m.base, '/api/pair/local', { ...h, 'content-type': 'application/json' }, { deviceName: 'x' });
      assert.strictEqual(r.status, 403, `local ${JSON.stringify(h)}`);
      assert.ok(!r.text.includes(m.pairing.serverId));
    }
    assert.strictEqual(confirm.calls.length, 0, 'a tunnel request never pops the dialog');
  } finally { await m.close(); }
});

test('SERVER_SOCKET mode: a unix-socket peer is not local → local pairing unsupported (403)', async () => {
  const confirm = fakeConfirm('allow');
  const pairing = createPairing({ file: path.join(tmp(), 'devices.json'), confirm, log: { error() {} } });
  const sock = path.join(tmp(), 's.sock');
  const server = http.createServer((req, res) => pairing.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(sock, r));
  try {
    const r = await new Promise((resolve, reject) => {
      const q = http.request({ socketPath: sock, method: 'POST', path: '/api/pair/local', headers: { host: 'localhost', 'content-type': 'application/json' } }, (res) => {
        let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
      });
      q.on('error', reject); q.end('{"deviceName":"x"}');
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(confirm.calls.length, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test('hello autoPair reads confirm.available() and never spawns a process', async () => {
  let spawned = 0;
  const confirm = createConfirm({ platform: 'darwin', execFile: () => { spawned++; } });
  const m = await mount({ pairing: { confirm } });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await raw(m.base, 'GET', '/api/pair/hello', { host: `127.0.0.1:${m.port}` });
      assert.strictEqual(r.json.autoPair, true);
    }
    assert.strictEqual(spawned, 0);
  } finally { await m.close(); }
});

// ---- createConfirm (osascript is faked) -----------------------------------------------------------
test('createConfirm on linux: available() === false, ask → unavailable, nothing spawned', async () => {
  let spawned = 0;
  const c = createConfirm({ platform: 'linux', execFile: () => { spawned++; } });
  assert.strictEqual(c.available(), false);
  assert.strictEqual(await c.ask({ number: '1234', deviceName: 'x', timeoutMs: 1000 }), 'unavailable');
  assert.strictEqual(spawned, 0);
});

test('createConfirm on darwin: device name goes in as an argument, never into the script; results mapped', async () => {
  const seen = [];
  let reply = { err: null, stdout: 'button returned:Allow, gave up:false\n' };
  const execFile = (cmd, args, opts, cb) => { seen.push({ cmd, args, opts }); setImmediate(() => cb(reply.err, reply.stdout, '')); };
  const c = createConfirm({ platform: 'darwin', execFile });
  assert.strictEqual(c.available(), true);
  const evil = '" & (do shell script "touch /tmp/x") & "\n\nNumber 0000';
  assert.strictEqual(await c.ask({ number: '4821', deviceName: evil, timeoutMs: 60000 }), 'allow');
  const { cmd, args, opts } = seen[0];
  assert.strictEqual(cmd, '/usr/bin/osascript');
  const script = args.filter((a, i) => args[i - 1] === '-e').join('\n');
  assert.ok(!script.includes('do shell script'), 'user text never reaches the script');
  assert.ok(!script.includes('4821'), 'the number is an argument too');
  assert.match(script, /on run argv/);
  assert.match(script, /default button "Deny"/);
  assert.match(script, /giving up after/);
  assert.strictEqual(args[args.length - 1], '60', 'dialog gives up after the wait time');
  assert.ok(args.includes('4821'));
  const nameArg = args[args.length - 2];
  assert.ok(!/[\n\r]/.test(nameArg), 'control characters are flattened so the name cannot fake a second Number line');
  assert.ok(opts.timeout > 60000, 'a hung osascript is killed after the dialog would have given up');

  reply = { err: null, stdout: 'button returned:Deny, gave up:false\n' };
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 60000 }), 'deny');
  reply = { err: null, stdout: 'button returned:, gave up:true\n' };
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 60000 }), 'timeout');
  reply = { err: Object.assign(new Error('User canceled. (-128)'), { code: 1 }), stdout: '' };
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 60000 }), 'deny');
  reply = { err: Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), stdout: '' };
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 60000 }), 'timeout');
  reply = { err: Object.assign(new Error('No user interaction allowed. (-1713)'), { code: 1 }), stdout: '' };
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 60000 }), 'unavailable');
  reply = { err: null, stdout: 'something odd\n' };
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 60000 }), 'unavailable');
});

test('createConfirm: execFile that throws synchronously → unavailable', async () => {
  const c = createConfirm({ platform: 'darwin', execFile: () => { throw new Error('ENOENT'); } });
  assert.strictEqual(await c.ask({ number: '1', deviceName: 'x', timeoutMs: 1000 }), 'unavailable');
});

test('real server: PAIR_LOCAL=off disables local pairing (hello autoPair false, local 403 unavailable); tunnel headers 403', async () => {
  const dir = tmp();
  const s = await bootServer({ env: { SERVER_TOKEN: TOKEN, DEVICES_FILE: path.join(dir, 'devices.json'), CMUX_MACHINE_URL: 'http://127.0.0.1:9', PAIR_LOCAL: 'off' } });
  try {
    const h = { host: `127.0.0.1:${s.port}`, 'content-type': 'application/json' };
    assert.strictEqual((await raw(s.base, 'GET', '/api/pair/hello', h)).json.autoPair, false);
    const r = await post(s.base, '/api/pair/local', h, { deviceName: 'x' });
    assert.strictEqual(r.status, 403, r.text);
    assert.deepStrictEqual(r.json, { error: 'unavailable' });
    const t = await post(s.base, '/api/pair/local', { host: 'mirror.example.test', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7', 'cf-ray': 'abc-AAA' }, { deviceName: 'x' });
    assert.strictEqual(t.status, 403);
    assert.deepStrictEqual(t.json, { error: 'local_only' });
  } finally { await s.stop(); }
});

// p41 D199 (HMX-86): the iOS-on-Mac build sent its iPad model; the dialog read "Device: iPad Pro (12.9-inch) ...".
test('local pair: an iPad/iPhone model label from loopback is shown and saved as this Mac; the number check stays', async () => {
  const confirm = fakeConfirm('allow');
  const m = await mount({ pairing: { confirm, localMachine: 'local-a' } });
  try {
    const r = await post(m.base, '/api/pair/local', lh(m), { deviceName: 'iPad Pro (12.9-inch) (3rd generation)' });
    assert.strictEqual(r.status, 202, r.text);
    assert.strictEqual(confirm.calls[0].deviceName, THIS_MAC_LABEL);
    assert.strictEqual(confirm.calls[0].number, r.json.number, 'the dialog still shows the app\'s number');
    const w = await post(m.base, '/api/pair/local/wait', lh(m), { requestId: r.json.requestId });
    assert.strictEqual(w.status, 200, w.text);
    assert.strictEqual(devicesOnDisk(m.file).find((d) => d.id === w.json.id).deviceName, THIS_MAC_LABEL);
  } finally { await m.close(); }
});

test('thisMacName: iOS model / empty -> This Mac; the app\'s own label or a Mac name kept', () => {
  assert.strictEqual(THIS_MAC_LABEL, 'This Mac (HyprMux app)');
  for (const n of ['iPad Pro (12.9-inch) (3rd generation)', 'iPad', 'iPhone 15 Pro', 'ipod touch', '', '  ', undefined, 'device']) assert.strictEqual(thisMacName(n), THIS_MAC_LABEL, String(n));
  assert.strictEqual(thisMacName("This Mac (HyprMux app) · Sean's Mac mini"), "This Mac (HyprMux app) · Sean's Mac mini");
  assert.strictEqual(thisMacName('这台 Mac（HyprMux 应用）'), '这台 Mac（HyprMux 应用）');
  assert.strictEqual(thisMacName('Desk app'), 'Desk app');
  assert.strictEqual(thisMacName('x'.repeat(200)).length, 64, 'still capped at NAME_MAX');
});
