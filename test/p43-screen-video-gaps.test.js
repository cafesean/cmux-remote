'use strict';
// p43 Video Remote Desktop, bridge gaps: displayId on shot-returning input and on type/key, the AX-denied
// JXA release retry and a release still pending on POST /cmux/screen/video/in, and helper teardown on
// bridge shutdown. REAL bridge.js children, FAKE helper / osascript / screencapture: nothing here captures
// the screen or posts real input.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { bootBridge } = require('./helpers/bridge-child');
const { JXA_INPUT } = require('../lib/mac-screen');

const SECRET = 'pw-SYNTHETIC-p43g-5b19';
const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
// osascript: geometry for JXA_INFO, 'noax' for the release script while D/noax exists, else 'ok'.
const FAKE_OSA = fake(String.raw`
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(D + '/osa-stdin.log', s + '\n<<END>>\n');
  if (s.includes('canCapture')) return process.stdout.write(JSON.stringify({ displays: [{ index: 1, id: 69733378, x: 0, y: 0, w: 1512, h: 982, scale: 2 }, { index: 2, id: 4128836, x: 1512, y: 0, w: 1920, h: 1080, scale: 1 }], canCapture: true, canControl: true }) + '\n');
  if (s.includes('[55,54,56,60') && fs.existsSync(D + '/noax')) return process.stdout.write('noax\n');
  if (/"displayId":12345\b/.test(s)) return process.stdout.write('nodisplay\n');
  process.stdout.write('ok\n');
});
`);
const FAKE_CAFF = fake("fs.appendFileSync(D + '/caff.log', JSON.stringify(process.argv.slice(2)) + '\\n');");
const FAKE_CAP = fake("const out = process.argv[process.argv.length - 1]; fs.appendFileSync(D + '/cap.log', JSON.stringify(process.argv.slice(2)) + '\\n'); fs.writeFileSync(out, Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60, 9)]));");
const FAKE_SIPS = fake("const a = process.argv.slice(2); fs.copyFileSync(a[a.indexOf('--out') - 1], a[a.indexOf('--out') + 1]);");
// Helper: records its pid; answers start with meta, each input item with posted; a type item 'EXIT' kills it
// (a helper death while a forwarded press is still held). Never exits on stdin EOF: an orphan stays alive.
const FAKE_HELPER = fake(String.raw`
fs.appendFileSync(D + '/helper.pid', process.pid + '\n');
const pkt = (gen, obj) => { const p = Buffer.from(JSON.stringify(obj)); const b = Buffer.alloc(46 + p.length); b.writeUInt32BE(42 + p.length, 0); b[4] = 5; b.writeUInt32BE(gen >>> 0, 6); b.writeUInt32BE(p.length, 42); p.copy(b, 46); return b; };
let buf = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  let m = null; try { m = JSON.parse(line); } catch (_) {}
  if (m && m.op === 'start') process.stdout.write(pkt(m.gen, { kind: 'ready', displayId: m.displayId }));
  if (m && m.op === 'input') for (const it of m.items) { if (it.t === 'type' && it.text === 'EXIT') process.exit(1); process.stdout.write(pkt(m.gen, { kind: 'posted', seq: it.seq })); }
  if (m && m.op === 'stop') process.exit(0); } });
process.stdout.on('error', () => {});
setInterval(() => {}, 1000);
`);

let on, dir, base;
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const releases = () => rd('osa-stdin.log').split('[55,54,56,60').length - 1;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p43g-')));
  for (const [n, src] of [['osascript', FAKE_OSA], ['caffeinate', FAKE_CAFF], ['hm-screen-stream', FAKE_HELPER], ['screencapture', FAKE_CAP], ['sips', FAKE_SIPS]]) fs.writeFileSync(path.join(dir, n), src, { mode: 0o755 });
  base = { FAKE_DIR: dir, NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', TMPDIR: dir, BRIDGE_SECRET: SECRET,
    SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'), SCREEN_CAFFEINATE_BIN: path.join(dir, 'caffeinate'),
    SCREEN_SCREENCAPTURE_BIN: path.join(dir, 'screencapture'), SCREEN_SIPS_BIN: path.join(dir, 'sips'), SCREEN_SHOT_MIN_MS: '500',
    SCREEN_STREAM_BIN: path.join(dir, 'hm-screen-stream'), SCREEN_VIEW: '1', SCREEN_CONTROL: '1',
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json') };
  on = await bootBridge({ env: base });
});
after(async () => {
  if (on) await on.stop();
  for (const p of rd('helper.pid').split('\n').filter(Boolean).map(Number)) { try { process.kill(p, 'SIGKILL'); } catch (_) {} }
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

const post = async (b, p, body) => { const r = await fetch(b.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j }; };
function openStream(b, q) {
  return new Promise((resolve, reject) => {
    const u = new URL(b.base + '/cmux/screen/video?' + q);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'x-bridge-secret': SECRET } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode }); }
      let got = Buffer.alloc(0), done = false;
      res.on('data', (d) => { got = Buffer.concat([got, d]); if (!done && got.length >= 4 && got.length >= 4 + got.readUInt32BE(0)) { done = true; resolve({ status: 200, close: () => req.destroy() }); } });
    });
    req.on('error', (e) => { if (!/socket hang up|aborted|ECONNRESET/.test(String(e.message))) reject(e); });
  });
}
const capLines = () => rd('cap.log').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Runs JXA_INPUT's run() in a VM: every $ call answers a truthy stub, screens() is replaced by fake geometry.
function runJxa(P) {
  const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : stub), apply: () => stub });
  const ctx = { $: stub, ObjC: { import() {}, unwrap: (x) => x }, delay() {} };
  vm.createContext(ctx);
  vm.runInContext(JXA_INPUT + '\nvar PARAMS=' + JSON.stringify(P) + ';\nfunction screens(){return [{index:1,id:69733378,x:0,y:0,w:1512,h:982,scale:2},{index:2,id:4128836,x:1512,y:0,w:1920,h:1080,scale:1}];}', ctx);
  return vm.runInContext('run()', ctx);
}

test('JXA input: type/key with an absent displayId -> nodisplay (resolved at execution); present -> ok', () => {
  assert.equal(runJxa({ op: 'type', display: 1, text: 'hi', displayId: 12345 }), 'nodisplay');
  assert.equal(runJxa({ op: 'key', display: 1, code: 36, flags: 0, displayId: 12345 }), 'nodisplay');
  assert.equal(runJxa({ op: 'key', display: 1, code: 36, flags: 0, displayId: 4128836 }), 'ok');
  assert.equal(runJxa({ op: 'key', display: 1, code: 36, flags: 0 }), 'ok');   // old clients: no displayId, no check
});

test('type/key routes with an absent displayId -> 404 display_gone', async () => {
  const t = await post(on, '/cmux/screen/type', { text: 'hi', displayId: 12345 });
  assert.equal(t.status, 404, JSON.stringify(t.json)); assert.equal(t.json.error, 'display_gone');
  const k = await post(on, '/cmux/screen/key', { key: 'tab', displayId: 12345 });
  assert.equal(k.status, 404, JSON.stringify(k.json)); assert.equal(k.json.error, 'display_gone');
});

test('shot-returning input with displayId captures THAT display, not index 1', async () => {
  fs.writeFileSync(path.join(dir, 'cap.log'), '');
  const t = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5, displayId: 4128836, shot: true });
  assert.equal(t.status, 200, JSON.stringify(t.json)); assert.ok(t.json.image, 'frame returned');
  assert.deepEqual(capLines().map((a) => a[a.indexOf('-D') + 1]), ['2']);
  fs.writeFileSync(path.join(dir, 'cap.log'), '');
  await pause(600);
  const m = await post(on, '/cmux/screen/mouse', { type: 'up', fx: 0.5, fy: 0.5, displayId: 4128836, shot: true });
  assert.equal(m.status, 200, JSON.stringify(m.json)); assert.ok(m.json.image, 'frame returned');
  assert.deepEqual(capLines().map((a) => a[a.indexOf('-D') + 1]), ['2']);
  fs.writeFileSync(path.join(dir, 'cap.log'), '');
  await pause(600);
  const g = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5, displayId: 12345, shot: true });
  assert.equal(g.status, 404);
  assert.equal(capLines().length, 0);   // a removed display never captures another
});

test('AX denied at video open: JXA release retried every 1 s, video input blocked until it succeeds', async () => {
  fs.writeFileSync(path.join(dir, 'noax'), '');
  const r0 = releases();
  const s = await openStream(on, 'displayId=69733378&gen=1&epoch=1');
  assert.equal(s.status, 200);
  await pause(1400);
  assert.ok(releases() - r0 >= 2, 'release retried while AX denied: ' + (releases() - r0));
  const b = await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [{ seq: 1, t: 'mouse', kind: 'move', fx: 0.5, fy: 0.5 }] });
  assert.equal(b.status, 409); assert.equal(b.json.error, 'input_blocked');
  const tap = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5 });
  assert.equal(tap.status, 409); assert.equal(tap.json.error, 'control_busy');
  fs.rmSync(path.join(dir, 'noax'));
  await pause(2200);
  const ok = await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [{ seq: 2, t: 'mouse', kind: 'move', fx: 0.5, fy: 0.5 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  // helper dies holding a forwarded press while AX is denied -> release_pending, retried, cleared once AX is back
  assert.equal((await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [{ seq: 3, t: 'mouse', kind: 'down', fx: 0.5, fy: 0.5 }] })).status, 200);
  fs.writeFileSync(path.join(dir, 'noax'), '');
  const r1 = releases();
  assert.equal((await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [{ seq: 4, t: 'type', text: 'EXIT' }] })).status, 200);
  await pause(300);
  const p = await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [{ seq: 5, t: 'mouse', kind: 'up', fx: 0.5, fy: 0.5 }] });
  assert.equal(p.status, 409); assert.equal(p.json.error, 'input_blocked'); assert.equal(p.json.reason, 'release_pending');
  await pause(1200);
  assert.ok(releases() - r1 >= 2, 'pending release retried: ' + (releases() - r1));
  assert.equal((await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [] })).json.reason, 'release_pending');
  fs.rmSync(path.join(dir, 'noax'));
  await pause(2200);
  const q = await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [] });
  assert.notEqual(q.json && q.json.reason, 'release_pending', JSON.stringify(q.json));
  s.close();
});

test('bridge shutdown (SIGTERM) stops every stream helper', async () => {
  const b2 = await bootBridge({ env: base });
  try {
    fs.writeFileSync(path.join(dir, 'helper.pid'), '');
    const s = await openStream(b2, 'displayId=4128836&gen=1&epoch=1');
    assert.equal(s.status, 200);
    let t0 = 0; while (!rd('helper.pid').trim() && t0++ < 100) await pause(20);   // the bridge's 'started' meta can precede the helper's first write
    const pid = Number(rd('helper.pid').trim().split('\n')[0]);
    assert.ok(pid > 0 && alive(pid));
    await b2.stop();
    let t = 0; while (alive(pid) && t++ < 30) await pause(100);
    assert.equal(alive(pid), false, 'helper outlived the bridge');
  } finally { await b2.stop(); }
});
