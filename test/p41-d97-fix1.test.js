'use strict';
// p41 D97 fix round 1 (security review): FAKE screencapture / sips / osascript only — never the real
// screen, never real input.
//   P1 server: no SERVER_TOKEN -> every /api/cmux/screen/* 503 not_secured, bridge never contacted.
//   P2 bridge: no BRIDGE_SECRET + non-loopback BRIDGE_HOST -> SCREEN_VIEW/SCREEN_CONTROL forced off.
//   P2 mac-screen: one shot in flight across ALL displays; a concurrent one -> 429 busy + retryMs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootServer } = require('./helpers/server-boot');
const { bootBridge } = require('./helpers/bridge-child');
const { createMacScreen, isLoopback, LIMITS } = require('../lib/mac-screen');

const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
// Slow capture (300 ms) so a second request lands while the first is in flight.
const FAKE_CAP = fake(String.raw`
fs.appendFileSync(D + '/cap.log', JSON.stringify(process.argv.slice(2)) + '\n');
const out = process.argv[process.argv.length - 1];
setTimeout(() => fs.writeFileSync(out, Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60, 9)])), 300);
`);
const FAKE_SIPS = fake(String.raw`
const a = process.argv.slice(2); fs.copyFileSync(a[a.indexOf('--out') - 1], a[a.indexOf('--out') + 1]);
`);
const FAKE_OSA = fake(String.raw`
fs.appendFileSync(D + '/osa.log', 'x\n'); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('ok\n'));
`);

let dir, env;
const kidEnv = () => ({ PATH: process.env.PATH, FAKE_DIR: dir });
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd97f-')));
  for (const [n, src] of [['screencapture', FAKE_CAP], ['sips', FAKE_SIPS], ['osascript', FAKE_OSA]]) fs.writeFileSync(path.join(dir, n), src, { mode: 0o755 });
  env = { FAKE_DIR: dir, SCREEN_VIEW: '1', SCREEN_CONTROL: '1',
    SCREEN_SCREENCAPTURE_BIN: path.join(dir, 'screencapture'), SCREEN_SIPS_BIN: path.join(dir, 'sips'), SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript') };
});
after(async () => { if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

function fakeBridge() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"view":true,"control":true}'); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(c)) })));
}

test('P1 server: empty SERVER_TOKEN -> /api/cmux/screen/* 503 not_secured, bridge never contacted', async () => {
  const fb = await fakeBridge();
  const s = await bootServer({ env: { SERVER_TOKEN: '', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: fb.url, secret: 'sb' }]) } });
  try {
    for (const [m, p, b] of [['GET', '/api/cmux/screen/info?machine=m1'], ['GET', '/api/cmux/screen/shot?machine=m1'],
      ['POST', '/api/cmux/screen/tap', { machine: 'm1', fx: 0.5, fy: 0.5 }], ['POST', '/api/cmux/screen/type', { machine: 'm1', text: 'hi' }],
      ['POST', '/api/cmux/screen/scroll', { machine: 'm1', dy: 5 }], ['POST', '/api/cmux/screen/key', { machine: 'm1', key: 'return' }]]) {
      const r = await fetch(s.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      assert.equal(r.status, 503, p); assert.deepEqual(await r.json(), { error: 'not_secured' });
    }
    assert.deepEqual(fb.seen, []);
  } finally { await s.stop(); await fb.close(); }
});

test('P1 server: with SERVER_TOKEN the screen routes still relay (guard is token-only)', async () => {
  const fb = await fakeBridge();
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: fb.url, secret: 'sb' }]) } });
  try {
    assert.equal((await fetch(s.base + '/api/cmux/screen/info?machine=m1')).status, 401);
    const r = await fetch(s.base + '/api/cmux/screen/info?machine=m1', { headers: { authorization: 'Bearer tok' } });
    assert.equal(r.status, 200);
    assert.deepEqual(fb.seen, ['/cmux/screen/info']);
  } finally { await s.stop(); await fb.close(); }
});

test('P2 isLoopback', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.5', '', 'example.com']) assert.equal(isLoopback(h), false, h);
});

test('P2 mac-screen: no secret + non-loopback host -> view/control forced off, logged once; secret or socket or loopback keeps them', async () => {
  const logs = [];
  const ms = createMacScreen({ env, secret: '', host: '0.0.0.0', log: (l) => logs.push(l), childEnv: kidEnv });
  assert.deepEqual(ms.flags, { view: false, control: false });
  assert.equal(logs.length, 1); assert.match(logs[0], /forced OFF.*BRIDGE_SECRET is empty/);
  assert.equal((await ms.shot()).body.error, 'screen_disabled');
  assert.equal((await ms.input('tap', { fx: 0.5, fy: 0.5 })).body.error, 'screen_disabled');
  assert.equal(rd('cap.log'), ''); assert.equal(rd('osa.log'), '');
  for (const o of [{ secret: 's', host: '0.0.0.0' }, { secret: '', host: '127.0.0.1' }, { secret: '', host: '0.0.0.0', socket: '/x/b.sock' }]) {
    const l2 = [];
    assert.deepEqual(createMacScreen({ env, ...o, log: (l) => l2.push(l) }).flags, { view: true, control: true }, JSON.stringify(o));
    assert.equal(l2.length, 0);
  }
  assert.deepEqual(createMacScreen({ env: {}, secret: '', host: '0.0.0.0', log: (l) => logs.push(l) }).flags, { view: false, control: false });
  assert.equal(logs.length, 1, 'no warning when the flags were never asked for');
});

test('P2 bridge: BRIDGE_SECRET empty + BRIDGE_HOST 0.0.0.0 -> /cmux/screen/* 403 screen_disabled + boot warning', async () => {
  const b = await bootBridge({ env: { ...env, BRIDGE_HOST: '0.0.0.0', COMPLETIONS_ENABLED: '0', NODE_ENV: 'test' } });
  try {
    const base = b.base.replace('0.0.0.0', '127.0.0.1');
    const r = await fetch(base + '/cmux/screen/shot'); const j = await r.json();
    assert.equal(r.status, 403); assert.equal(j.error, 'screen_disabled');
    const t = await fetch(base + '/cmux/screen/tap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"fx":0.5,"fy":0.5}' });
    assert.equal(t.status, 403);
    assert.match(b.stdout(), /SCREEN_VIEW\/SCREEN_CONTROL forced OFF/);
    assert.equal(rd('cap.log'), '');
  } finally { await b.stop(); }
});

test('P2 mac-screen: one shot in flight across displays; concurrent -> 429 busy retryMs; frees after', async () => {
  fs.writeFileSync(path.join(dir, 'cap.log'), '');
  const ms = createMacScreen({ env, secret: 's', host: '127.0.0.1', childEnv: kidEnv });
  const [a, b] = await Promise.all([ms.shot(1), ms.shot(2)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 429); assert.equal(b.body.error, 'busy'); assert.equal(b.body.retryMs, LIMITS.SCREEN_SHOT_BUSY_RETRY_MS);
  assert.equal(rd('cap.log').trim().split('\n').length, 1, 'only one screencapture ran');
  assert.equal((await ms.shot(2)).status, 200, 'display 2 free once the first shot finished');
});
