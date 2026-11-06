'use strict';
// p41 D135 — Mac dialogs: detect + alert (never clicks). Pure parse/mapping, the REAL bridge route with a
// FAKE osascript (403 when SCREEN_VIEW unset, nothing spawned), and the server-side watch pushing once
// per new dialog id. This test never reads the real window list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { parseDialogs, mapToDisplay, labelFor, createDialogWatch, LIMITS } = require('../lib/mac-dialogs');

// Two displays: main 1512x982 at 0,0; a 3008x1692 one above-left at -3008,-710 (this Mac's real layout).
const DISPLAYS = [{ index: 1, x: 0, y: 0, w: 1512, h: 982, scale: 2 }, { index: 2, x: -3008, y: -710, w: 3008, h: 1692, scale: 1 }];
const WINDOWS = [
  { owner: 'universalAccessAuthWarn', layer: 0, x: 525, y: 226, w: 461, h: 181, titled: true },
  { owner: 'SecurityAgent', layer: 1000, x: -1654, y: 100, w: 300, h: 200, titled: false },
  { owner: 'Google Chrome', layer: 0, x: 448, y: 34, w: 1038, h: 948, titled: true },   // a browser window: not a dialog
  { owner: 'Google Chrome', layer: 0, x: 600, y: 300, w: 420, h: 180, titled: false },  // the remote-debugging sheet shape
  { owner: 'Finder', layer: 0, x: 0, y: 0, w: 100, h: 100, titled: false },
];
const OUT = JSON.stringify({ displays: DISPLAYS, windows: WINDOWS });

test('parse: known owners only, plain labels, display + fractional rect', () => {
  const l = parseDialogs(OUT);
  assert.deepEqual(l.map((d) => [d.owner, d.label, d.display]), [
    ['universalAccessAuthWarn', 'macOS permission request', 1],
    ['SecurityAgent', 'Password prompt', 2],
    ['Google Chrome', 'Chrome permission', 1],
  ]);
  assert.deepEqual(l[0].rect, { fx: 0.3472, fy: 0.2301, fw: 0.3049, fh: 0.1843 });
  assert.deepEqual(l[1].rect, { fx: Math.round((1354 / 3008) * 1e4) / 1e4, fy: Math.round((810 / 1692) * 1e4) / 1e4, fw: Math.round((300 / 3008) * 1e4) / 1e4, fh: Math.round((200 / 1692) * 1e4) / 1e4 });
  for (const d of l) assert.match(d.id, /^[0-9a-f]{12}$/);
  assert.equal(new Set(l.map((d) => d.id)).size, 3);
  assert.equal(parseDialogs('not json'), null);
  assert.equal(parseDialogs(JSON.stringify({ windows: [] })), null);
});

test('mapping: off-screen centre falls to biggest overlap, fractions clamped to 0..1', () => {
  const m = mapToDisplay({ x: 1400, y: 900, w: 300, h: 300 }, DISPLAYS);   // centre off every display, overlaps display 1
  assert.equal(m.display, 1);
  for (const k of ['fx', 'fy', 'fw', 'fh']) assert.ok(m.rect[k] >= 0 && m.rect[k] <= 1, k);
  assert.ok(m.rect.fx + m.rect.fw <= 1.0001 && m.rect.fy + m.rect.fh <= 1.0001);
  assert.equal(labelFor({ owner: 'Google Chrome', titled: false, w: 1038, h: 948 }), null);
  assert.equal(labelFor({ owner: 'Google Chrome', titled: true, w: 400, h: 200 }), null);
});

// ---- the real bridge route, fake osascript ----
const FAKE_OSA = '#!' + process.execPath + '\n' + String.raw`'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;
fs.appendFileSync(D + '/osa-argv.log', JSON.stringify(process.argv.slice(2)) + '\n');
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => { fs.appendFileSync(D + '/osa-stdin.log', s + '\n<<END>>\n'); process.stdout.write(fs.readFileSync(D + '/windows.json', 'utf8') + '\n'); });
`;
let off, on, dir;
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd135-')));
  fs.writeFileSync(path.join(dir, 'osascript'), FAKE_OSA, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'windows.json'), OUT);
  const base = { FAKE_DIR: dir, NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'),
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json') };
  off = await bootBridge({ env: { ...base } });
  on = await bootBridge({ env: { ...base, SCREEN_VIEW: '1' } });
});
after(async () => { for (const b of [off, on]) if (b) await b.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });
const get = async (b, p) => { const r = await fetch(b.base + p); return { status: r.status, json: await r.json().catch(() => null) }; };

test('route: 403 screen_disabled when SCREEN_VIEW unset, nothing spawned', async () => {
  const r = await get(off, '/cmux/screen/dialogs');
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'screen_disabled');
  assert.equal(r.json.flag, 'SCREEN_VIEW');
  assert.equal(rd('osa-argv.log'), '');
});

test('route: SCREEN_VIEW=1 -> dialogs with since; script on stdin; one run per cache window', async () => {
  const a = await get(on, '/cmux/screen/dialogs');
  assert.equal(a.status, 200);
  assert.equal(a.json.dialogs.length, 3);
  for (const d of a.json.dialogs) { assert.equal(typeof d.since, 'number'); assert.ok(d.rect && d.display >= 1); }
  const b = await get(on, '/cmux/screen/dialogs');
  assert.deepEqual(b.json, a.json);
  assert.equal(rd('osa-argv.log').trim().split('\n').length, 1, 'cached inside MAC_DIALOG_CACHE_MS');
  assert.deepEqual(JSON.parse(rd('osa-argv.log').trim()), ['-l', 'JavaScript', '-']);
  assert.match(rd('osa-stdin.log'), /CGWindowListCopyWindowInfo/);
  assert.doesNotMatch(rd('osa-stdin.log'), /CGEventPost\(|\.click\(|keystroke/, 'detection script never posts input');
});

// ---- server-side watch: one push per new dialog id ----
test('watch: seeds first, then exactly one push per new dialog id; 403 Mac pushes nothing', async () => {
  let answer = { dialogs: [{ id: 'aaa', label: 'Password prompt', display: 1, rect: {} }] };
  const pushes = [];
  let t = 1000;
  const machines = [{ id: 'max', label: 'Max' }, { id: 'mini', label: 'Mini' }];
  const bridge = async (m) => (m.id === 'mini'
    ? { status: 403, json: async () => ({ error: 'screen_disabled' }) }
    : { status: 200, json: async () => answer });
  let calls = 0;
  const counted = async (m, p, o) => { if (m.id === 'mini') calls++; return bridge(m, p, o); };
  const w = createDialogWatch({ machines, bridge: counted, notify: async (p) => { pushes.push(p); }, now: () => t, log: { error() {} } });
  await w.tick();                       // seed: 'aaa' was already open
  assert.equal(pushes.length, 0);
  answer = { dialogs: [{ id: 'aaa', label: 'Password prompt' }, { id: 'bbb', label: 'macOS permission request' }] };
  t += 5000; await w.tick();
  t += 5000; await w.tick();
  t += 5000; await w.tick();
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], { title: 'Max needs you', body: 'macOS permission request on Max', tag: 'mac-dialog-max-bbb',
    machine: 'max', surface: null, kind: 'mac-dialog', id: 'bbb' });
  assert.equal(calls, 1, `403 Mac re-asked only after MAC_DIALOG_OFF_RECHECK_MS (${LIMITS.MAC_DIALOG_OFF_RECHECK_MS})`);
  const idle = createDialogWatch({ machines, bridge: async () => { throw new Error('polled'); }, notify: async () => {}, active: () => false });
  await idle.tick();                    // no phone subscribed -> no bridge call at all
});
