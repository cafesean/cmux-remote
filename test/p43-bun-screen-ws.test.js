'use strict';
// p43 HMXV-013/006: the screen socket under the compiled (Bun) runtime. server.js is built with
// `bun build --compile`; the front door must run the same auth / plan / machine gates as the node 'upgrade'
// path before any 101, then hand the socket to lib/screen-ws.js attach(). A stub bridge answers screen info.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUN = [process.env.BUN_BIN, path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun'].find((p) => p && fs.existsSync(p));
const TOKEN = 'tok-screen';
const WS = '/api/cmux/screen/ws';
const HELLO = JSON.stringify({ t: 'hello', v: 1, codecs: ['h264'], maxW: 1920, maxH: 1080, maxFps: 30 });

const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });

function stubBridge() {
  return listen((req, res) => {
    if (req.url.startsWith('/cmux/screen/info')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ view: true, control: true, canControl: true, focusSecure: false, displays: [{ index: 1, id: 7, x: 0, y: 0, w: 800, h: 600, scale: 1 }] }));
    }
    if (req.url.startsWith('/cmux/screen/video?')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return; }  // held open
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
}
function stubHub() {
  return listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/entitlement')) return res.end(JSON.stringify({ enforced: true, entitlement: { plan: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } } }));
    if (req.url.endsWith('/devices')) return res.end(JSON.stringify({ devices: [] }));
    return res.end(JSON.stringify({ enforced: true, defaultPlan: 'free', plans: [] }));
  });
}

function boot(bin, env) {
  const child = spawn(bin, [], { env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), HYPERMUX_PKG_ROOT: ROOT, PORT: '0', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no listen line\n' + out)), 15000);
    child.stdout.on('data', () => {
      const m = /server on http:\/\/[^:\s]+:(\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve({ child, port: Number(m[1]), log: () => out }); }
    });
    child.on('exit', (c) => reject(new Error(`exited ${c}\n${out}`)));
  });
}

// One upgrade attempt over a fresh connection: resolves 101 or the refusal status (and body).
function upgrade(port, p, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: { host: '127.0.0.1', connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    r.on('response', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('upgrade', (res, sock) => { sock.destroy(); resolve({ status: 101 }); });
    r.on('error', (e) => resolve({ status: 'error', body: e.message }));
    r.end();
  });
}

// Opens the screen socket, sends the hello, collects text messages until pred(msgs) or the deadline.
function session(url, after, pred, wait = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url); const msgs = []; let done = false;
    const fin = (why) => { if (done) return; done = true; try { ws.close(); } catch (_) {} resolve({ why, msgs }); };
    setTimeout(() => fin('timeout'), wait);
    ws.onopen = () => ws.send(HELLO);
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data); msgs.push(m);
      if (after) after(ws, m);
      if (pred(msgs)) fin('ok');
    };
    ws.onerror = () => fin('error'); ws.onclose = (e) => fin('close ' + e.code);
  });
}

test('screen socket through the compiled front door', { skip: (!BUN && 'bun not installed') || (typeof WebSocket !== 'function' && 'no WebSocket'), timeout: 180000 }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p43-bunscreen-')));
  const bin = path.join(tmp, 'srv');
  execFileSync(BUN, ['build', '--compile', path.join(ROOT, 'server.js'), '--outfile', bin], { cwd: ROOT, stdio: 'pipe' });
  const br = await stubBridge();
  const machines = (id) => JSON.stringify([{ id, label: id, baseUrl: `http://127.0.0.1:${br.address().port}`, secret: 'sb' }]);
  const srv = await boot(bin, { HOME: fs.mkdtempSync(path.join(tmp, 'h-')), SERVER_TOKEN: TOKEN, CMUX_MACHINES: machines('m1') });
  const hub = await stubHub();
  const planDir = fs.mkdtempSync(path.join(tmp, 'plan-'));
  fs.writeFileSync(path.join(planDir, 'owner.json'), JSON.stringify({ ownerSub: 'A', ownerEpoch: 1 }));
  fs.writeFileSync(path.join(planDir, 'hub-access-token'), JSON.stringify({ ownerSub: 'A', ownerEpoch: 1, accessToken: 'tok-A', exp: 4e9 }));
  const free = await boot(bin, { HOME: fs.mkdtempSync(path.join(tmp, 'f-')), SERVER_TOKEN: TOKEN, CMUX_MACHINES: machines('m1'),
    HMX_PLAN_STATE_DIR: planDir, HMX_HUB_URL: `http://127.0.0.1:${hub.address().port}` });
  t.after(() => { srv.child.kill('SIGKILL'); free.child.kill('SIGKILL'); br.close(); hub.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  await t.test('unauthenticated upgrade is refused before any 101', async () => {
    const none = await upgrade(srv.port, WS + '?machine=m1');
    assert.strictEqual(none.status, 401, JSON.stringify(none));
    const wrong = await upgrade(srv.port, WS + '?machine=m1', { authorization: 'Bearer nope' });
    assert.strictEqual(wrong.status, 401, JSON.stringify(wrong));
    const q = await upgrade(srv.port, WS + '?machine=m1&token=nope');
    assert.strictEqual(q.status, 401, JSON.stringify(q));
    // An unauthenticated client gets no echo either: the socket never opens.
    const r = await session(`ws://127.0.0.1:${srv.port}${WS}?machine=m1`, null, () => true, 3000);
    assert.ok(!r.msgs.length, 'unauthenticated socket answered: ' + JSON.stringify(r));
  });

  await t.test('authenticated: gates still refuse an unknown machine / bad display (no 101)', async () => {
    const H = { authorization: 'Bearer ' + TOKEN };
    assert.strictEqual((await upgrade(srv.port, WS + '?machine=nope', H)).status, 404);
    assert.strictEqual((await upgrade(srv.port, WS + '?machine=m1&display=9', H)).status, 400);
  });

  await t.test('authenticated: hello -> welcome round trip through the Bun front door', async () => {
    const r = await session(`ws://127.0.0.1:${srv.port}${WS}?machine=m1&token=${TOKEN}`, null, (ms) => ms.some((m) => m.t === 'welcome') && ms.some((m) => m.t === 'reset'));
    assert.strictEqual(r.why, 'ok', JSON.stringify(r));
    const w = r.msgs.find((m) => m.t === 'welcome');
    assert.strictEqual(w.v, 1); assert.strictEqual(w.display, 1); assert.strictEqual(w.w, 800); assert.strictEqual(w.inputAllowed, true);
  });

  await t.test('plan gate: Free -> view-only, input refused PLAN_LIMIT', async () => {
    let sent = false;
    const r = await session(`ws://127.0.0.1:${free.port}${WS}?machine=m1&token=${TOKEN}`,
      (ws, m) => { if (m.t === 'welcome' && !sent) { sent = true; ws.send(JSON.stringify({ t: 'tap', seq: 1, x: 1, y: 1 })); } },
      (ms) => ms.some((m) => m.t === 'error'));
    assert.strictEqual(r.why, 'ok', JSON.stringify(r) + '\n' + free.log());
    const w = r.msgs.find((m) => m.t === 'welcome');
    assert.strictEqual(w.inputAllowed, false);
    assert.deepStrictEqual(w.plan, { code: 'free', remoteDesktop: 'view' });
    const e = r.msgs.find((m) => m.t === 'error');
    assert.strictEqual(e.code, 'PLAN_LIMIT'); assert.strictEqual(e.details.limit, 'remoteDesktop');
  });
});
