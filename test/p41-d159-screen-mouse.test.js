'use strict';
// p41 D159 — Mac screen mouse: hover move, press-drag-release, safety mouseUp. REAL bridge.js child,
// FAKE osascript (records each script's PARAMS) — no real event is ever posted to the Mac.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { JXA_INPUT } = require('../lib/mac-screen');

const FAKE_OSA = '#!' + process.execPath + '\n' + String.raw`'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;
let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{s+=d;});
process.stdin.on('end',()=>{const m=s.match(/var PARAMS=(\{.*\});\s*$/);
  if(m)fs.appendFileSync(D+'/params.log',m[1]+'\n');
  const slow=fs.existsSync(D+'/slow')?250:0;
  setTimeout(()=>process.stdout.write(fs.existsSync(D+'/deny-ax')?'noax\n':'ok\n'),slow);});
`;
let off, on, dir;
const params = () => { try { return fs.readFileSync(path.join(dir, 'params.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const reset = () => { try { fs.unlinkSync(path.join(dir, 'params.log')); } catch (_) {} };
const post = async (b, body) => { const r = await fetch(b.base + '/cmux/screen/mouse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd159-')));
  fs.writeFileSync(path.join(dir, 'osascript'), FAKE_OSA, { mode: 0o755 });
  const base = { FAKE_DIR: dir, NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'),
    SCREEN_CAFFEINATE_BIN: '/usr/bin/true', HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json') };
  off = await bootBridge({ env: { ...base } });
  on = await bootBridge({ env: { ...base, SCREEN_VIEW: '1', SCREEN_CONTROL: '1', TMPDIR: dir, SCREEN_OSA_TIMEOUT_MS: '3000', SCREEN_MOUSE_HOLD_MAX_MS: '400' } });
});
after(async () => { for (const b of [off, on]) if (b) await b.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

test('SCREEN_CONTROL off: 403, nothing spawned', async () => {
  const r = await post(off, { type: 'move', fx: 0.5, fy: 0.5 });
  assert.equal(r.status, 403); assert.equal(r.json.flag, 'SCREEN_CONTROL');
  assert.deepEqual(params(), []);
});

test('validation: bad type / coords / display; drag without down -> 409', async () => {
  assert.equal((await post(on, { type: 'click', fx: 0.5, fy: 0.5 })).json.error, 'bad_type');
  assert.equal((await post(on, { type: 'move', fx: 1.5, fy: 0.5 })).json.error, 'bad_coords');
  assert.equal((await post(on, { type: 'move', fx: 0.5, fy: 0.5, display: 9 })).json.error, 'bad_display');
  const d = await post(on, { type: 'drag', fx: 0.5, fy: 0.5 });
  assert.equal(d.status, 409); assert.equal(d.json.error, 'not_down');
});

test('move -> kind move; down/drag/up -> left down, dragged, up, in order', async () => {
  reset();
  for (const [type, fx] of [['move', 0.1], ['down', 0.2], ['drag', 0.3], ['move', 0.4], ['up', 0.5]]) {
    const r = await post(on, { type, fx, fy: 0.5 });
    assert.equal(r.status, 200, type);
  }
  assert.deepEqual(params().map((p) => [p.op, p.kind, p.fx]), [['mouse', 'move', 0.1], ['mouse', 'down', 0.2], ['mouse', 'drag', 0.3], ['mouse', 'drag', 0.4], ['mouse', 'up', 0.5]]);
});

test('JXA maps kinds to CGEvent types (move 5, down 1, dragged 6, up 2)', () => {
  assert.match(JXA_INPUT, /move:\$\.kCGEventMouseMoved\|\|5,down:\$\.kCGEventLeftMouseDown\|\|1,drag:\$\.kCGEventLeftMouseDragged\|\|6,up:\$\.kCGEventLeftMouseUp\|\|2/);
  assert.match(JXA_INPUT, /if\(P\.op==='mouse'\)return ptr\(P\)/);
});

test('moves coalesce latest-wins while osascript is busy', async () => {
  await pause(1100); reset();
  fs.writeFileSync(path.join(dir, 'slow'), '');
  try {
    const rs = [];
    for (let i = 1; i <= 6; i++) { rs.push(post(on, { type: 'move', fx: i / 10, fy: 0.5 })); await pause(15); }
    const out = await Promise.all(rs);
    assert.ok(out.every((r) => r.status === 200));
    assert.ok(out.some((r) => r.json.coalesced === true), 'some moves coalesced');
    const ps = params();
    assert.ok(ps.length < 6, `fewer runs than moves (${ps.length})`);
    assert.equal(ps[ps.length - 1].fx, 0.6, 'the latest move always lands');
  } finally { fs.unlinkSync(path.join(dir, 'slow')); }
});

test('move rate cap: over SCREEN_MOUSE_MOVE_MAX_PER_SEC in one rolling second -> 429 (clock pinned)', async () => {
  const { createMacScreen, LIMITS } = require('../lib/mac-screen');
  const sh = path.join(dir, 'osa-fast');
  fs.writeFileSync(sh, '#!/bin/sh\ncat >/dev/null\necho ok\n', { mode: 0o755 });
  const ms = createMacScreen({ env: { SCREEN_CONTROL: '1', SCREEN_OSASCRIPT_BIN: sh }, host: '127.0.0.1', now: () => 1000, log: () => {}, axHelper: { run: async () => ({}) } });
  const out = [];
  for (let i = 0; i < LIMITS.SCREEN_MOUSE_MOVE_MAX_PER_SEC + 2; i++) out.push(await ms.mouse({ type: 'move', fx: 0.5, fy: 0.5 }));
  assert.equal(out.filter((r) => r.status === 200).length, LIMITS.SCREEN_MOUSE_MOVE_MAX_PER_SEC);
  assert.equal(out[out.length - 1].status, 429); assert.equal(out[out.length - 1].body.error, 'rate_limited');
  // a release is never rate-limited away (it frees the button)
  assert.equal((await ms.mouse({ type: 'up', fx: 0.5, fy: 0.5 })).status, 200);
});

test('safety mouseUp: a down with no drag/up gets released at its last point', async () => {
  reset();
  assert.equal((await post(on, { type: 'down', fx: 0.25, fy: 0.75 })).status, 200);
  assert.equal((await post(on, { type: 'drag', fx: 0.3, fy: 0.7 })).status, 200);
  await pause(800);
  const ps = params();
  assert.deepEqual(ps[ps.length - 1], { op: 'mouse', kind: 'up', display: 1, fx: 0.3, fy: 0.7 });
  assert.equal((await post(on, { type: 'drag', fx: 0.3, fy: 0.7 })).status, 409, 'button no longer held');
});

test('no Accessibility -> 403 screen_permission; failed down does not stay held', async () => {
  fs.writeFileSync(path.join(dir, 'deny-ax'), '');
  try {
    const r = await post(on, { type: 'down', fx: 0.5, fy: 0.5 });
    assert.equal(r.status, 403); assert.equal(r.json.need, 'accessibility');
    assert.equal((await post(on, { type: 'drag', fx: 0.5, fy: 0.5 })).status, 409);
  } finally { fs.unlinkSync(path.join(dir, 'deny-ax')); }
});
