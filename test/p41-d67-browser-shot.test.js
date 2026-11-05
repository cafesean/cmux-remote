'use strict';
// p41 D67 — GET /cmux/browser/shot?surface= : one JPEG (or raw PNG fallback) of a cmux browser surface
// for the app's Workspace browser tile, polled while the tile is visible. Gated like every surface
// route (423 private), rate limited per surface (429), size capped (413). REAL bridge.js child, fake
// cmux, synthetic ids, offline.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const WS_P = 'aaaaaaa1-1111-4111-8111-111111111111';
const WS_N = 'bbbbbbb1-1111-4111-8111-111111111111';
const S1 = 'aaaaaaa1-3333-4333-8333-333333333331';   // in "Claude accounts" (private)
const S2 = 'bbbbbbb1-3333-4333-8333-333333333331';
const S3 = 'bbbbbbb1-3333-4333-8333-333333333332';
const sf = (id, ref) => ({ id, ref, title: ref, type: 'browser', selected: true, selected_in_pane: true });
const pn = (id, ref, index, s) => ({ id, ref, index, focused: index === 0, selected_surface_id: s.id, surfaces: [s] });
const TREE = { windows: [{ id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1', workspaces: [
  { id: WS_P, ref: 'workspace:1', title: 'Claude accounts', selected: false, panes: [pn('aaaaaaa1-2222-4222-8222-222222222221', 'pane:1', 0, sf(S1, 'surface:1'))] },
  { id: WS_N, ref: 'workspace:2', title: 'acme', selected: true, panes: [
    pn('bbbbbbb1-2222-4222-8222-222222222221', 'pane:2', 0, sf(S2, 'surface:2')),
    pn('bbbbbbb1-2222-4222-8222-222222222222', 'pane:3', 1, sf(S3, 'surface:3')),
  ] },
] }] };

// screenshot writes FAKE_SHOT_BYTES bytes to --out (sips then fails on the junk → raw fallback)
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(args) + '\n');
let out = 'OK\n';
if (args[0] === 'tree') out = fs.readFileSync(process.env.FAKE_CMUX_TREE, 'utf8');
else if (args[0] === 'list-status' || args[0] === 'list-notifications') out = args[0] === 'list-notifications' ? '[]' : '';
else if (args[0] === 'rpc') out = '{}';
else if (args[0] === 'browser' && args[2] === 'screenshot') {
  const n = args[1] === process.env.FAKE_BIG_SURFACE ? 4096 : 64;
  fs.writeFileSync(args[args.indexOf('--out') + 1], Buffer.alloc(n, 7));
}
process.stdout.write(out, () => process.exit(0));
`;

let bridge, dir, log;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd67-')));
  const bin = path.join(dir, 'fake-cmux');
  fs.writeFileSync(bin, FAKE_CMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(TREE));
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  log = path.join(dir, 'cmux.log');
  bridge = await bootBridge({ cwd: dir, env: {
    CMUX_BIN: bin, FAKE_CMUX_TREE: path.join(dir, 'tree.json'), FAKE_CMUX_LOG: log, FAKE_BIG_SURFACE: S3,
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
    BROWSER_SHOT_MIN_MS: '3600000', BROWSER_SHOT_MAX_BYTES: '1024',
  } });
});
after(async () => { if (bridge) await bridge.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(bridge.base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j }; };
const shots = (s) => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === 'browser' && a[1] === s && a[2] === 'screenshot').length; } catch (_) { return 0; } };

test('shot: 200 with a base64 image + mime', async () => {
  const r = await get('/cmux/browser/shot?surface=' + S2);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.mime, /^image\/(jpeg|png)$/);
  assert.equal(Buffer.from(r.json.image, 'base64').length > 0, true);
});

test('shot: a second shot of the same surface inside the min interval -> 429, cmux not asked', async () => {
  const before = shots(S2);
  const r = await get('/cmux/browser/shot?surface=' + S2);
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.equal(typeof r.json.retryMs, 'number');
  assert.equal(shots(S2), before);
});

test('shot: over the size cap -> 413', async () => {
  const r = await get('/cmux/browser/shot?surface=' + S3);
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'too_large');
});

test('shot: private surface -> 423, never shot; bad surface -> 400', async () => {
  const r = await get('/cmux/browser/shot?surface=' + S1);
  assert.equal(r.status, 423);
  assert.equal(shots(S1), 0);
  assert.equal((await get('/cmux/browser/shot?surface=bad;rm')).status, 400);
});

test('shot limiter: floor honours an injected clock (no real timing)', () => {
  const { createShotLimiter } = require('../lib/shot-limiter');
  let t = 1000;
  const l = createShotLimiter({ minMs: 1500, now: () => t });
  assert.equal(l.take('a').ok, true);
  t += 100;
  const r = l.take('a');
  assert.equal(r.ok, false);
  assert.equal(r.retryMs, 1400);
  assert.equal(l.take('b').ok, true);
  t += 1400;
  assert.equal(l.take('a').ok, true);
});
