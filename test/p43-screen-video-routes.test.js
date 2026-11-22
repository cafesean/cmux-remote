'use strict';
// p43 Video Remote Desktop, bridge routes: GET /cmux/screen/video (chunked helper packets) and
// POST /cmux/screen/video/in. REAL bridge.js children, FAKE helper / osascript / caffeinate: nothing here
// captures the screen or posts real input. Proves: secret gate, flags + insecure-LAN force-off, KEY_ALLOW +
// clamps on video items, the JPEG control_busy gate while video owns control, displayId -> display_gone.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootBridge } = require('./helpers/bridge-child');
const { displayIndexFor, videoItem } = require('../lib/mac-screen');

const SECRET = 'pw-SYNTHETIC-p43v-7d21';
const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
const FAKE_OSA = fake(String.raw`
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(D + '/osa-stdin.log', s + '\n<<END>>\n');
  if (s.includes('canCapture')) return process.stdout.write(JSON.stringify({ displays: [{ index: 1, id: 69733378, x: 0, y: 0, w: 1512, h: 982, scale: 2 }, { index: 2, id: 4128836, x: 1512, y: 0, w: 1920, h: 1080, scale: 1 }], canCapture: true, canControl: true }) + '\n');
  if (/"displayId":12345\b/.test(s)) return process.stdout.write('nodisplay\n');   // the JXA disp() lookup found no such id
  process.stdout.write('ok\n');
});
`);
const FAKE_CAFF = fake("fs.appendFileSync(D + '/caff.log', JSON.stringify(process.argv.slice(2)) + '\\n');");
const FAKE_CAP = fake("const out = process.argv[process.argv.length - 1]; fs.appendFileSync(D + '/cap.log', JSON.stringify(process.argv.slice(2)) + '\\n'); fs.writeFileSync(out, Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60, 9)]));");
const FAKE_SIPS = fake("const a = process.argv.slice(2); fs.copyFileSync(a[a.indexOf('--out') - 1], a[a.indexOf('--out') + 1]);");
// Helper: logs each stdin line; answers start with one meta packet and each input item with posted.
const FAKE_HELPER = fake(String.raw`
const pkt = (gen, obj) => { const p = Buffer.from(JSON.stringify(obj)); const b = Buffer.alloc(46 + p.length); b.writeUInt32BE(42 + p.length, 0); b[4] = 5; b.writeUInt32BE(gen >>> 0, 6); b.writeUInt32BE(p.length, 42); p.copy(b, 46); return b; };
let buf = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  fs.appendFileSync(D + '/helper.log', line + '\n'); let m = null; try { m = JSON.parse(line); } catch (_) {}
  if (m && m.op === 'start') process.stdout.write(pkt(m.gen, { kind: 'ready', displayId: m.displayId }));
  if (m && m.op === 'input') for (const it of m.items) process.stdout.write(pkt(m.gen, { kind: 'posted', seq: it.seq }));
  if (m && m.op === 'stop') process.exit(0); } });
setInterval(() => {}, 1000);
`);

let on, open, dir;
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// The fakes are separate node processes (caffeinate is spawned detached, osascript after jpegIdle): their
// log lines land on their own schedule, so poll for them instead of a fixed pause (fixed pauses flaked).
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; let v; while (!(v = fn()) && Date.now() < end) await pause(20); return v || fn(); }
const helperOps = () => rd('helper.log').split('\n').filter(Boolean).map((l) => JSON.parse(l));
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p43v-')));
  for (const [n, src] of [['osascript', FAKE_OSA], ['caffeinate', FAKE_CAFF], ['hm-screen-stream', FAKE_HELPER], ['screencapture', FAKE_CAP], ['sips', FAKE_SIPS]]) fs.writeFileSync(path.join(dir, n), src, { mode: 0o755 });
  const base = { FAKE_DIR: dir, NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', TMPDIR: dir,
    SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'), SCREEN_CAFFEINATE_BIN: path.join(dir, 'caffeinate'),
    SCREEN_SCREENCAPTURE_BIN: path.join(dir, 'screencapture'), SCREEN_SIPS_BIN: path.join(dir, 'sips'), SCREEN_SHOT_MIN_MS: '500',
    SCREEN_STREAM_BIN: path.join(dir, 'hm-screen-stream'), SCREEN_VIEW: '1', SCREEN_CONTROL: '1',
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json') };
  on = await bootBridge({ env: { ...base, BRIDGE_SECRET: SECRET } });
  // No secret + non-loopback host: the flags are forced off (the desktop never served to the LAN).
  open = await bootBridge({ env: { ...base, BRIDGE_HOST: '0.0.0.0' } });
});
after(async () => { for (const b of [on, open]) if (b) await b.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

const H = (secret) => (secret ? { 'x-bridge-secret': secret } : {});
const post = async (b, p, body, secret = SECRET) => { const r = await fetch(b.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...H(secret) }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j }; };
const get = async (b, p, secret = SECRET) => { const r = await fetch(b.base + p, { headers: H(secret) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j }; };
// Opens the chunked stream; resolves once the first framed packet arrived. -> { first, close }
function openStream(b, q) {
  return new Promise((resolve, reject) => {
    const u = new URL(b.base + '/cmux/screen/video?' + q);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: H(SECRET) }, (res) => {
      if (res.statusCode !== 200) { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); return; }
      let got = Buffer.alloc(0), done = false;
      res.on('data', (d) => { got = Buffer.concat([got, d]); if (!done && got.length >= 4 && got.length >= 4 + got.readUInt32BE(0)) { done = true; resolve({ status: 200, first: got, close: () => req.destroy() }); } });
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e.message))) reject(e); });
  });
}

test('route auth: no x-bridge-secret -> 403 forbidden on both video routes (as today)', async () => {
  assert.equal((await get(on, '/cmux/screen/video?displayId=1&gen=1', null)).status, 403);
  assert.equal((await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [] }, null)).status, 403);
  assert.equal((await post(on, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [] }, 'wrong')).status, 403);
});

test('insecure LAN (no secret, non-loopback host): video routes forced off -> 403 screen_disabled', async () => {
  const g = await get(open, '/cmux/screen/video?displayId=1&gen=1', null);
  assert.equal(g.status, 403); assert.equal(g.json.error, 'screen_disabled');
  const p = await post(open, '/cmux/screen/video/in', { gen: 1, epoch: 1, items: [] }, null);
  assert.equal(p.status, 403); assert.equal(p.json.error, 'screen_disabled');
  assert.equal(rd('helper.log'), '');   // the helper never started
});

test('GET video: bad displayId -> 400; stream -> framed helper packets, start op, display woken', async () => {
  assert.equal((await get(on, '/cmux/screen/video?displayId=abc&gen=1')).status, 400);
  const s = await openStream(on, 'displayId=69733378&gen=3&epoch=1');
  assert.equal(s.status, 200);
  try {   // the stream must close even on a failure, or video keeps control and the next test sees 409
  assert.equal(s.first[4], 5);   // type 5 meta
  const start = helperOps().find((m) => m.op === 'start');
  assert.equal(start.displayId, 69733378); assert.equal(start.gen, 3);
  assert.match(await waitFor(() => rd('caff.log')), /"-u"/);   // D103: display held awake while the stream runs
  // control opens after jpegIdle + one JXA release of both buttons + modifiers before video input opens
  assert.match(await waitFor(() => /kCGEventLeftMouseUp/.test(rd('osa-stdin.log')) && rd('osa-stdin.log')), /kCGEventLeftMouseUp/);

  // JPEG input while video owns control -> 409 control_busy
  const tap = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5 });
  assert.equal(tap.status, 409); assert.equal(tap.json.error, 'control_busy');
  const mouse = await post(on, '/cmux/screen/mouse', { type: 'move', fx: 0.5, fy: 0.5 });
  assert.equal(mouse.status, 409); assert.equal(mouse.json.error, 'control_busy');

  // video input: KEY_ALLOW + clamps applied before the helper sees an item
  const vin = (items) => post(on, '/cmux/screen/video/in', { gen: 3, epoch: 1, items });
  // control opens once the JXA release answer reaches the bridge; a 409 input_blocked forwards nothing, so retry
  let r = await vin([]); for (let i = 0; i < 100 && r.status === 409; i++) { await pause(20); r = await vin([]); }
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await post(on, '/cmux/screen/video/in', { gen: 3, epoch: 1, items: [
    { seq: 1, t: 'key', key: 'f13', mods: [] },                  // not allowed -> dropped
    { seq: 2, t: 'scroll', dy: 99999, dx: -99999 },              // clamped
    { seq: 3, t: 'mouse', kind: 'move', fx: 5, fy: 0.5 },        // bad coords -> dropped
    { seq: 4, t: 'key', key: 'tab', mods: ['cmd'] },
    { seq: 5, t: 'type', text: 'x'.repeat(5000) },               // over SCREEN_TYPE_MAX_CHARS -> dropped
    { seq: 6, t: 'evil', cmd: 'rm' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const inp = await waitFor(() => helperOps().find((m) => m.op === 'input' && m.items.length));   // skips the empty probe
  assert.deepEqual(inp.items.map((i) => i.seq), [2, 4]);
  assert.equal(inp.items[0].dy, 3000); assert.equal(inp.items[0].dx, -3000);
  assert.deepEqual(inp.items[1].mods, ['cmd']);
  } finally { s.close(); }
});

test('JPEG routes: displayId resolved per call; absent -> 404 display_gone', async () => {
  await pause(300);   // stream above closed -> control retired
  const gone = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5, displayId: 12345 });
  assert.equal(gone.status, 404); assert.equal(gone.json.error, 'display_gone');
  const ok = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5, displayId: 4128836 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const shot = await get(on, '/cmux/screen/shot?displayId=12345');
  assert.equal(shot.status, 404); assert.equal(shot.json.error, 'display_gone');
  const s2 = await get(on, '/cmux/screen/shot?displayId=4128836');
  assert.equal(s2.status, 200, JSON.stringify(s2.json));
  assert.match(rd('cap.log'), /"-D","2"/);   // id 4128836 -> index 2 at this execution
});

test('POST video/op: secret + flag gates, bad op 400, no stream 409; grant/keyframe reach the helper stdin as clean JSON', async () => {
  assert.strictEqual((await post(on, '/cmux/screen/video/op', { op: 'grant', gen: 1, grantId: 1 }, '')).status, 403);
  const off = await post(open, '/cmux/screen/video/op', { op: 'release', epoch: 1 }, '');
  assert.strictEqual(off.status, 403); assert.strictEqual(off.json.error, 'screen_disabled');
  assert.strictEqual((await post(on, '/cmux/screen/video/op', { op: 'nope' })).status, 400);
  assert.strictEqual((await post(on, '/cmux/screen/video/op', { op: 'grant', gen: 1 })).status, 400);
  assert.strictEqual((await post(on, '/cmux/screen/video/op', { op: 'grant', gen: 1, grantId: 1, displayId: 999 })).status, 409);
  const s = await openStream(on, 'displayId=4128836&gen=3&epoch=0');
  assert.strictEqual(s.status, 200);
  try {
    const g = await post(on, '/cmux/screen/video/op', { op: 'grant', gen: 3, grantId: 7, displayId: 4128836, junk: { x: 1 } });
    assert.deepStrictEqual([g.status, g.json.ok], [200, true]);
    const k = await post(on, '/cmux/screen/video/op', { op: 'keyframe', gen: 3, grantId: 8, emergency: true, reason: 'decode_error', displayId: 4128836 });
    assert.strictEqual(k.status, 200);
    await waitFor(() => helperOps().some((l) => l.op === 'keyframe'));
    const lines = helperOps();
    assert.ok(lines.some((l) => l.op === 'grant' && l.gen === 3 && l.grantId === 7 && !('junk' in l) && !('displayId' in l)), 'grant on helper stdin');
    assert.ok(lines.some((l) => l.op === 'keyframe' && l.grantId === 8 && l.emergency === true && l.reason === 'decode_error'), 'keyframe on helper stdin');
  } finally { s.close(); }
});

test('displayIndexFor: CGDirectDisplayID -> 1-based NSScreen index from fake geometry', () => {
  const ds = [{ index: 1, id: 1, w: 1512, h: 982 }, { index: 2, id: 77, w: 1920, h: 1080 }];
  assert.equal(displayIndexFor(ds, 77), 2);
  assert.equal(displayIndexFor(ds, 1), 1);
  assert.equal(displayIndexFor(ds, 5), null);
  assert.equal(displayIndexFor([], 1), null);
});

test('videoItem: allow-list + clamps', () => {
  assert.equal(videoItem({ seq: 1, t: 'key', key: 'f13' }), null);
  assert.deepEqual(videoItem({ seq: 1, t: 'tap', fx: 0.2, fy: 0.3, button: 'right', double: 1 }), { seq: 1, t: 'tap', fx: 0.2, fy: 0.3, button: 'right', double: false });
  assert.equal(videoItem({ seq: 1, t: 'mouse', kind: 'teleport', fx: 0, fy: 0 }), null);
  assert.equal(videoItem({ t: 'tap', fx: 0, fy: 0 }), null);   // no seq
});
