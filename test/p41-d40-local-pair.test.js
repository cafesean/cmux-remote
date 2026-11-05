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
const { createPairing } = require('../lib/pairing');
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
  const env = { SERVER_TOKEN: TOKEN, DEVICES_FILE: path.join(dir, 'devices.json'), CMUX_MACHINE_URL: 'http://127.0.0.1:9' };
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
