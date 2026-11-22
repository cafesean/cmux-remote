'use strict';
// p43 Video Remote Desktop, end to end: a REAL server.js child and a REAL bridge.js child, a fake
// hm-screen-stream helper (a node script set via SCREEN_STREAM_BIN) and Node's built-in WebSocket client.
// Proves the whole grant path: client ready{gen} -> server grant ledger -> bridge POST /cmux/screen/video/op
// -> helper stdin {op:'grant'} -> helper type-1 packet carrying that grantId -> bridge chunked body ->
// server -> binary WebSocket frame on /api/cmux/screen/ws. Nothing here captures the screen or posts input.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootServer } = require('./helpers/server-boot');
const { bootBridge } = require('./helpers/bridge-child');
const S = require('../lib/screen-stream');

const SECRET = 'pw-SYNTHETIC-p43e-41c9';
const TOKEN = 'tok-SYNTHETIC-p43e-8b02';
const LIB = path.join(__dirname, '..', 'lib', 'screen-stream.js');
const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
// Display probe: one display, capture + control granted.
const FAKE_OSA = fake(String.raw`
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  if (s.includes('canCapture')) return process.stdout.write(JSON.stringify({ displays: [{ index: 1, id: 69733378, x: 0, y: 0, w: 1512, h: 982, scale: 2 }], canCapture: true, canControl: true }) + '\n');
  process.stdout.write('ok\n');
});
`);
const FAKE_CAFF = fake('');
// Helper: logs each stdin line; start -> ready meta; grant -> one type-1 video packet carrying that grantId.
const FAKE_HELPER = fake(String.raw`
const { encodePacket } = require(process.env.SCREEN_LIB);
const out = (p) => { const b = Buffer.alloc(4); b.writeUInt32BE(p.length, 0); process.stdout.write(Buffer.concat([b, p])); };
let buf = ''; process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  fs.appendFileSync(D + '/helper.log', line + '\n'); let m = null; try { m = JSON.parse(line); } catch (_) {}
  if (!m) continue;
  if (m.op === 'start') out(encodePacket({ type: 5, gen: m.gen }, Buffer.from(JSON.stringify({ kind: 'ready', displayId: m.displayId }))));
  if (m.op === 'grant') out(encodePacket({ type: 1, flags: 1, gen: m.gen, seq: m.grantId, grantId: m.grantId }, Buffer.from('frame-' + m.grantId)));
  if (m.op === 'stop') process.exit(0); } });
setInterval(() => {}, 1000);
`);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Separate processes answer on their own schedule: poll, never a fixed sleep.
async function waitFor(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms; let v;
  while (!(v = fn()) && Date.now() < end) await pause(20);
  v = v || fn();
  if (!v) throw new Error('timed out waiting for ' + what);
  return v;
}

test('e2e: hello -> welcome/reset, ready{gen} -> helper grant ops -> binary type-1 frames carrying those grantIds; ack replenishes', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p43e-')));
  let br = null, sv = null, ws = null;
  const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
  const helperOps = () => rd('helper.log').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    for (const [n, src] of [['osascript', FAKE_OSA], ['caffeinate', FAKE_CAFF], ['hm-screen-stream', FAKE_HELPER]]) fs.writeFileSync(path.join(dir, n), src, { mode: 0o755 });
    br = await bootBridge({ env: { FAKE_DIR: dir, SCREEN_LIB: LIB, NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', TMPDIR: dir, BRIDGE_SECRET: SECRET,
      SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'), SCREEN_CAFFEINATE_BIN: path.join(dir, 'caffeinate'),
      SCREEN_SCREENCAPTURE_BIN: path.join(dir, 'no-screencapture'), SCREEN_SIPS_BIN: path.join(dir, 'no-sips'),
      SCREEN_STREAM_BIN: path.join(dir, 'hm-screen-stream'), SCREEN_VIEW: '1', SCREEN_CONTROL: '0',
      HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json') } });
    sv = await bootServer({ env: { NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', SERVER_TOKEN: TOKEN, TMPDIR: dir,
      CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: br.base, secret: SECRET }]) } });

    const texts = [], bins = [];
    ws = new WebSocket(sv.base.replace(/^http/, 'ws') + '/api/cmux/screen/ws?machine=m1&display=1&token=' + TOKEN);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => { if (typeof e.data === 'string') texts.push(JSON.parse(e.data)); else bins.push(Buffer.from(e.data)); };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed\n' + sv.stdout() + sv.stderr())); });
    ws.send(JSON.stringify({ t: 'hello', v: 1, codecs: ['h264'], maxW: 1920, maxH: 1080, maxFps: 30, clientTs: 1 }));

    const welcome = await waitFor(() => texts.find((m) => m.t === 'welcome'), 8000, 'welcome');
    assert.equal(welcome.gen, 1); assert.equal(welcome.display, 1);
    assert.equal(welcome.w, 3024); assert.equal(welcome.h, 1964);            // 1512x982 pt at scale 2
    await waitFor(() => texts.find((m) => m.t === 'reset' && m.gen === 1), 5000, 'reset{gen:1}');
    // The helper exists once the bridge spawned it for this display; only then can a grant reach it.
    const start = await waitFor(() => helperOps().find((o) => o.op === 'start'), 8000, 'helper start');
    assert.equal(start.displayId, 69733378);

    ws.send(JSON.stringify({ t: 'ready', gen: 1 }));
    const grants = await waitFor(() => { const g = helperOps().filter((o) => o.op === 'grant'); return g.length >= 2 && g; }, 5000, 'two grant ops');
    assert.deepEqual(grants.map((g) => g.grantId), [1, 2]);                  // window of 2
    for (const g of grants) assert.equal(g.gen, 1);

    await waitFor(() => bins.length >= 2, 5000, 'two binary frames');
    const hs = bins.map((b) => S.parseHeader(b));
    for (const h of hs) { assert.equal(h.type, 1); assert.equal(h.gen, 1); }
    assert.deepEqual(hs.map((h) => h.grantId).sort(), [1, 2]);
    assert.equal(bins[0].subarray(42).toString(), 'frame-' + hs[0].grantId);

    // Ack the highest seq sent -> both grants retire -> two new grants -> two new frames.
    ws.send(JSON.stringify({ t: 'ack', gen: 1, seq: 2 }));
    await waitFor(() => bins.length >= 4, 5000, 'frames for replenished grants');
    assert.deepEqual(bins.slice(2).map((b) => S.parseHeader(b).grantId).sort(), [3, 4]);
    assert.ok(!texts.some((m) => m.t === 'fallback'), 'no fallback: ' + JSON.stringify(texts));
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
    if (sv) await sv.stop();
    if (br) await br.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
