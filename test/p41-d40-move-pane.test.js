'use strict';
// p41 D40 W3 — POST /cmux/move-pane: move a WHOLE pane (every tab, order + active tab kept) to one
// side of another pane. A REAL bridge.js child (ephemeral port, fake cmux, private HOME); the fake
// logs every argv and can be told to fail one call. Offline: synthetic ids, no real cmux, no network.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const WS = 'bbbbbbb1-1111-4111-8111-111111111111';
const WS_P = 'aaaaaaa1-1111-4111-8111-111111111111';   // "Claude accounts" (private)
const P1 = 'bbbbbbb1-2222-4222-8222-222222222221';     // tabs A, B (active), C
const P2 = 'bbbbbbb1-2222-4222-8222-222222222222';     // tab D
const P3 = 'bbbbbbb1-2222-4222-8222-222222222223';     // tab E (single-tab pane)
const PP = 'aaaaaaa1-2222-4222-8222-222222222221';
const A = 'bbbbbbb1-3333-4333-8333-333333333331';
const B = 'bbbbbbb1-3333-4333-8333-333333333332';
const C = 'bbbbbbb1-3333-4333-8333-333333333333';
const D = 'bbbbbbb1-3333-4333-8333-333333333334';
const E = 'bbbbbbb1-3333-4333-8333-333333333335';
const S1 = 'aaaaaaa1-3333-4333-8333-333333333331';

const sf = (id, ref, sel) => ({ id, ref, title: ref, type: 'terminal', selected: sel, selected_in_pane: sel });
const pane = (id, ref, index, sel, sfs) => ({ id, ref, index, focused: false, selected_surface_id: sel, surfaces: sfs });
const TREE = { windows: [{ id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1', workspaces: [
  { id: WS_P, ref: 'workspace:1', title: 'Claude accounts', panes: [pane(PP, 'pane:1', 0, S1, [sf(S1, 'surface:1', true)])] },
  { id: WS, ref: 'workspace:2', title: 'acme', selected: true, panes: [
    pane(P1, 'pane:2', 0, B, [sf(A, 'surface:2', false), sf(B, 'surface:3', true), sf(C, 'surface:4', false)]),
    pane(P2, 'pane:3', 1, D, [sf(D, 'surface:5', true)]),
    pane(P3, 'pane:4', 2, E, [sf(E, 'surface:6', true)]),
  ] },
] }] };

// FAKE_CMUX_FAIL file: one line "<op> <surface>" — that exact call exits 1 with a cmux-style error.
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const op = args[0] || '';
let failSpec = ''; try { failSpec = fs.readFileSync(process.env.FAKE_CMUX_FAIL, 'utf8').trim(); } catch (_) {}
if (op !== '--version' && op !== 'tree' && op !== 'rpc' && op !== 'list-status' && op !== 'list-notifications')
  fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(args) + '\n');
if (failSpec) {
  const [fop, fsf] = failSpec.split(' ');
  if (op === fop && args.includes(fsf)) { process.stderr.write('Error: invalid_state: refused\n', () => process.exit(1)); return; }
}
let out = 'OK\n';
if (op === 'tree') out = fs.readFileSync(process.env.FAKE_CMUX_TREE, 'utf8');
else if (op === 'list-status') out = '';
else if (op === 'list-notifications') out = '[]';
else if (op === 'rpc') out = '{}';
process.stdout.write(out, () => process.exit(0));
`;

let bridge, dir, log, failFile;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'w3-move-pane-')));
  const bin = path.join(dir, 'fake-cmux');
  fs.writeFileSync(bin, FAKE_CMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(TREE));
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  log = path.join(dir, 'cmux.log');
  failFile = path.join(dir, 'fail');
  bridge = await bootBridge({ cwd: dir, env: {
    CMUX_BIN: bin, FAKE_CMUX_TREE: path.join(dir, 'tree.json'), FAKE_CMUX_LOG: log, FAKE_CMUX_FAIL: failFile,
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (bridge) await bridge.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });
beforeEach(() => { fs.writeFileSync(log, ''); fs.writeFileSync(failFile, ''); });

const post = async (body) => {
  const r = await fetch(bridge.base + '/cmux/move-pane', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j };
};
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ok = { workspace: WS, pane: P1, target: P2, edge: 'left' };

test('multi-tab pane: first tab splits off the target edge, the rest join in order, active tab last', async () => {
  const r = await post(ok);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.moved, [A, C, B]);
  assert.deepEqual(calls(), [
    ['move-surface', '--surface', A, '--pane', P2, '--workspace', WS, '--focus', 'false'],
    ['drag-surface-to-split', '--surface', A, 'left', '--workspace', WS, '--focus', 'false'],
    ['move-surface', '--surface', C, '--workspace', WS, '--after', A, '--focus', 'false'],
    ['move-surface', '--surface', B, '--workspace', WS, '--after', A, '--focus', 'false'],
  ]);
  assert.ok(Array.isArray(r.json.workspaces));
});

test('single-tab pane: exactly the drop-surface pair; refs accepted', async () => {
  for (const edge of ['right', 'up', 'down']) {
    fs.writeFileSync(log, '');
    const r = await post({ workspace: 'workspace:2', pane: 'pane:4', target: 'pane:3', edge });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(calls(), [
      ['move-surface', '--surface', E, '--pane', P2, '--workspace', 'workspace:2', '--focus', 'false'],
      ['drag-surface-to-split', '--surface', E, edge, '--workspace', 'workspace:2', '--focus', 'false'],
    ]);
  }
});

test('400s: bad_pane / bad_edge / bad_workspace / same pane; nothing moved', async () => {
  assert.equal((await post({ ...ok, pane: 'nope' })).json.error, 'bad_pane');
  assert.equal((await post({ ...ok, target: '' })).json.error, 'bad_pane');
  assert.equal((await post({ ...ok, edge: 'center' })).json.error, 'bad_edge');
  assert.equal((await post({ ...ok, edge: undefined })).json.error, 'bad_edge');
  assert.equal((await post({ ...ok, workspace: 'x' })).json.error, 'bad_workspace');
  const same = await post({ ...ok, target: P1 });
  assert.equal(same.status, 400); assert.equal(same.json.error, 'bad_pane');
  assert.deepEqual(calls(), []);
});

test('404 no_such_pane: unknown pane, unknown target, pane of another workspace', async () => {
  const ghost = 'ccccccc1-2222-4222-8222-222222222229';
  for (const body of [{ ...ok, pane: ghost }, { ...ok, target: ghost }, { ...ok, workspace: 'workspace:7' }]) {
    const r = await post(body);
    assert.equal(r.status, 404, JSON.stringify(body)); assert.equal(r.json.error, 'no_such_pane');
  }
  assert.deepEqual(calls(), []);
});

test('S2p: a private pane, target or workspace -> 423 private, nothing moved', async () => {
  for (const body of [{ ...ok, pane: PP }, { ...ok, target: PP }, { workspace: WS_P, pane: PP, target: P2, edge: 'left' }]) {
    const r = await post(body);
    assert.equal(r.status, 423, JSON.stringify(body)); assert.deepEqual(r.json, { error: 'private' });
  }
  assert.deepEqual(calls(), []);
});

test('first move refused -> 502, nothing moved', async () => {
  fs.writeFileSync(failFile, 'move-surface ' + A);
  const r = await post(ok);
  assert.equal(r.status, 502); assert.equal(r.json.error, 'cmux_failed');
  assert.match(r.json.detail, /invalid_state/);
  assert.deepEqual(r.json.moved, []); assert.deepEqual(r.json.remaining, [A, B, C]);
  assert.equal(calls().length, 1);
});

test('split refused -> the parked tab goes back beside its old neighbour, 502 rolledBack', async () => {
  fs.writeFileSync(failFile, 'drag-surface-to-split ' + A);
  const r = await post(ok);
  assert.equal(r.status, 502);
  assert.equal(r.json.rolledBack, true);
  assert.deepEqual(r.json.moved, []); assert.deepEqual(r.json.remaining, [A, B, C]);
  assert.deepEqual(calls().at(-1), ['move-surface', '--surface', A, '--workspace', WS, '--before', B, '--focus', 'false']);
});

test('a later tab refused -> 502 names what moved and what stayed; no more calls', async () => {
  fs.writeFileSync(failFile, 'move-surface ' + C);
  const r = await post(ok);
  assert.equal(r.status, 502);
  assert.deepEqual(r.json.moved, [A]); assert.deepEqual(r.json.remaining, [B, C]);
  assert.equal(r.json.rolledBack, false);
  assert.equal(calls().length, 3);
});
