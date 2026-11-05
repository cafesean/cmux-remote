'use strict';
// p41 D97 — Mac screen: whole-desktop view (screencapture) + control (JXA CGEventPost). REAL bridge.js
// children (one with the flags off, one on), FAKE screencapture / osascript / sips — this test never
// captures the real screen or injects real input. Proves: off-by-default 403s, the key allow-list,
// typed text rides osascript STDIN (never argv, never logged/echoed), rate floors, TCC-denied errors.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { parseKey, KEY_ALLOW, LIMITS } = require('../lib/mac-screen');

const SECRET = 'pw-SYNTHETIC-d97-5b1c';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 9)]);

const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
const FAKE_CAP = fake(String.raw`
fs.appendFileSync(D + '/cap.log', JSON.stringify(process.argv.slice(2)) + '\n');
const out = process.argv[process.argv.length - 1];
if (fs.existsSync(D + '/deny-cap')) { process.stderr.write('could not create image from display\n'); process.exit(1); }
fs.writeFileSync(out, Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60, 9)]));
try { fs.appendFileSync(D + '/mode.log', (fs.statSync(out).mode & 0o777).toString(8) + ' ' + (fs.statSync(require('path').dirname(out)).mode & 0o777).toString(8) + '\n'); } catch (_) {}
`);
const FAKE_SIPS = fake(String.raw`
const a = process.argv.slice(2); const o = a[a.indexOf('--out') + 1]; fs.copyFileSync(a[a.indexOf('--out') - 1], o);
`);
const FAKE_OSA = fake(String.raw`
fs.appendFileSync(D + '/osa-argv.log', JSON.stringify(process.argv.slice(2)) + '\n');
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(D + '/osa-stdin.log', s + '\n<<END>>\n');
  if (s.includes('canCapture')) return process.stdout.write(JSON.stringify({ displays: [{ index: 1, x: 0, y: 0, w: 1512, h: 982, scale: 2 }], canCapture: true, canControl: true }) + '\n');
  process.stdout.write(fs.existsSync(D + '/deny-ax') ? 'noax\n' : 'ok\n');
});
`);

let off, on, dir;
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd97-')));
  for (const [n, src] of [['screencapture', FAKE_CAP], ['sips', FAKE_SIPS], ['osascript', FAKE_OSA]]) fs.writeFileSync(path.join(dir, n), src, { mode: 0o755 });
  const base = { FAKE_DIR: dir, NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
    SCREEN_SCREENCAPTURE_BIN: path.join(dir, 'screencapture'), SCREEN_SIPS_BIN: path.join(dir, 'sips'), SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'),
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json') };
  off = await bootBridge({ env: { ...base } });
  on = await bootBridge({ env: { ...base, SCREEN_VIEW: '1', SCREEN_CONTROL: '1', TMPDIR: dir, SCREEN_SHOT_MIN_MS: '60000' } });
});
after(async () => { for (const b of [off, on]) if (b) await b.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

const get = async (b, p) => { const r = await fetch(b.base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t }; };
const post = async (b, p, body) => { const r = await fetch(b.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('flags off (default): every route 403 screen_disabled, nothing spawned', async () => {
  for (const p of ['/cmux/screen/info', '/cmux/screen/shot']) {
    const r = await get(off, p);
    assert.equal(r.status, 403); assert.equal(r.json.error, 'screen_disabled'); assert.equal(r.json.flag, 'SCREEN_VIEW');
  }
  for (const [p, b] of [['tap', { fx: 0.5, fy: 0.5 }], ['scroll', { dy: 10 }], ['type', { text: SECRET }], ['key', { key: 'return' }]]) {
    const r = await post(off, '/cmux/screen/' + p, b);
    assert.equal(r.status, 403); assert.equal(r.json.flag, 'SCREEN_CONTROL');
    assert.equal(r.text.includes(SECRET), false);
  }
  assert.equal(rd('cap.log'), ''); assert.equal(rd('osa-argv.log'), '');
});

test('info: displays + permission preflight + settings paths', async () => {
  const r = await get(on, '/cmux/screen/info');
  assert.equal(r.status, 200);
  assert.equal(r.json.displays[0].w, 1512);
  assert.equal(r.json.canControl, true);
  assert.match(r.json.settingsPath.accessibility, /Privacy & Security > Accessibility/);
});

test('shot: JPEG frame, -x -t jpg -D 1, 0600 file in 0700 dir, temp removed; 2nd inside the floor -> 429', async () => {
  const r = await get(on, '/cmux/screen/shot');
  assert.equal(r.status, 200); assert.equal(r.json.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(r.json.image, 'base64'), JPEG);
  const a = JSON.parse(rd('cap.log').trim().split('\n')[0]);
  assert.deepEqual(a.slice(0, 5), ['-x', '-t', 'jpg', '-D', '1']);
  assert.match(rd('mode.log'), /^600 700/);
  const r2 = await get(on, '/cmux/screen/shot');
  assert.equal(r2.status, 429); assert.ok(r2.json.retryMs > 0 && r2.json.retryMs <= 60000);
  await pause(50);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('hm-screen-')).length, 0, 'temp dir deleted');
  assert.equal((await get(on, '/cmux/screen/shot?display=99')).status, 400);
  assert.equal((await get(on, '/cmux/screen/shot?display=1;rm')).status, 400);
});

test('shot: Screen Recording denied -> 403 screen_permission with the System Settings path', async () => {
  fs.writeFileSync(path.join(dir, 'deny-cap'), '');
  try {
    const r = await get(on, '/cmux/screen/shot?display=2');
    assert.equal(r.status, 403); assert.equal(r.json.error, 'screen_permission'); assert.equal(r.json.need, 'screen_recording');
    assert.match(r.json.settingsPath, /Screen & System Audio Recording/);
  } finally { fs.unlinkSync(path.join(dir, 'deny-cap')); }
});

test('type: text rides osascript stdin, never argv, never logged or echoed; cap -> 413', async () => {
  const r = await post(on, '/cmux/screen/type', { text: SECRET });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text.includes(SECRET), false);
  assert.ok(rd('osa-stdin.log').includes(JSON.stringify(SECRET)), 'text delivered on stdin');
  assert.equal(rd('osa-argv.log').includes(SECRET), false, 'never in argv');
  for (const l of rd('osa-argv.log').trim().split('\n')) assert.deepEqual(JSON.parse(l), ['-l', 'JavaScript', '-']);
  assert.equal(on.stdout().includes(SECRET) || on.stderr().includes(SECRET), false, 'never logged');
  const big = await post(on, '/cmux/screen/type', { text: SECRET + 'x'.repeat(LIMITS.SCREEN_TYPE_MAX_CHARS) });
  assert.equal(big.status, 413); assert.equal(big.text.includes(SECRET), false);
});

test('key: allow-list only; mods canonicalised; others 400 before osascript', async () => {
  assert.equal((await post(on, '/cmux/screen/key', { key: 'v', mods: ['cmd'] })).status, 200);
  assert.ok(rd('osa-stdin.log').includes('"code":9,"flags":1048576'));
  for (const b of [{ key: 'q', mods: ['cmd'] }, { key: 'esc', mods: ['cmd', 'opt'] }, { key: 'k' }, { key: 'return', mods: ['hyper'] },
    { key: 'x' }, { key: '$(reboot)' }]) {
    const n = rd('osa-argv.log').length;
    const r = await post(on, '/cmux/screen/key', b);
    assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(r.json.error, 'bad_key');
    assert.equal(rd('osa-argv.log').length, n);
  }
  assert.equal(parseKey('z', ['shift', 'cmd']).combo, 'cmd+shift+z');
  assert.equal(KEY_ALLOW.has('cmd+q'), false);
});

test('tap/scroll: validation; Accessibility denied -> 403 accessibility', async () => {
  assert.equal((await post(on, '/cmux/screen/tap', { fx: 2, fy: 0.5 })).status, 400);
  assert.equal((await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5, button: 'middle' })).status, 400);
  assert.equal((await post(on, '/cmux/screen/scroll', { dy: 0 })).status, 400);
  await pause(1000);
  assert.equal((await post(on, '/cmux/screen/tap', { fx: 0.25, fy: 0.75, button: 'right', double: true })).status, 200);
  assert.ok(rd('osa-stdin.log').includes('"op":"tap","display":1,"fx":0.25,"fy":0.75,"button":"right","double":true'));
  await post(on, '/cmux/screen/scroll', { dy: 1e9 });
  assert.ok(rd('osa-stdin.log').includes(`"dy":${LIMITS.SCREEN_SCROLL_MAX}`));
  fs.writeFileSync(path.join(dir, 'deny-ax'), '');
  try {
    const r = await post(on, '/cmux/screen/tap', { fx: 0.5, fy: 0.5 });
    assert.equal(r.status, 403); assert.equal(r.json.need, 'accessibility'); assert.match(r.json.message, /Accessibility for the HyprMux server/);
  } finally { fs.unlinkSync(path.join(dir, 'deny-ax')); }
});

test('shot floor never below 500 ms', () => { assert.ok(LIMITS.SCREEN_SHOT_MIN_MS >= 500); });

test('input rate cap: > SCREEN_INPUT_MAX_PER_SEC in a second -> 429', async () => {
  await pause(1000);
  const rs = [];
  for (let i = 0; i < LIMITS.SCREEN_INPUT_MAX_PER_SEC + 3; i++) rs.push(post(on, '/cmux/screen/key', { key: 'down' }));
  const st = (await Promise.all(rs)).map((r) => r.status);
  assert.ok(st.filter((s) => s === 429).length >= 3, st.join(','));
});
