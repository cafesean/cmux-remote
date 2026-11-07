'use strict';
// p41 D148 — POST /cmux/move-to-workspace: move a WHOLE pane (every tab, order + active tab kept)
// into ANOTHER workspace as its own pane, split right of that workspace's focused (else last) pane. A REAL bridge.js child (ephemeral port, fake cmux, private HOME); the fake
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
const WS2 = 'ccccccc1-1111-4111-8111-111111111111';
const Q1 = 'ccccccc1-2222-4222-8222-222222222221';
const Q2 = 'ccccccc1-2222-4222-8222-222222222222';   // focused
const WS3 = 'ddddddd1-1111-4111-8111-111111111111';
const R1 = 'ddddddd1-2222-4222-8222-222222222221';
const R2 = 'ddddddd1-2222-4222-8222-222222222222';   // last (none focused)
const F = 'ccccccc1-3333-4333-8333-333333333331';
const G = 'ccccccc1-3333-4333-8333-333333333332';
const H = 'ddddddd1-3333-4333-8333-333333333331';
const I = 'ddddddd1-3333-4333-8333-333333333332';

const sf = (id, ref, sel) => ({ id, ref, title: ref, type: 'terminal', selected: sel, selected_in_pane: sel });
const pane = (id, ref, index, sel, sfs) => ({ id, ref, index, focused: false, selected_surface_id: sel, surfaces: sfs });
const TREE = { windows: [{ id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1', workspaces: [
  { id: WS_P, ref: 'workspace:1', title: 'Claude accounts', panes: [pane(PP, 'pane:1', 0, S1, [sf(S1, 'surface:1', true)])] },
  { id: WS, ref: 'workspace:2', title: 'acme', selected: true, panes: [
    pane(P1, 'pane:2', 0, B, [sf(A, 'surface:2', false), sf(B, 'surface:3', true), sf(C, 'surface:4', false)]),
    pane(P2, 'pane:3', 1, D, [sf(D, 'surface:5', true)]),
    pane(P3, 'pane:4', 2, E, [sf(E, 'surface:6', true)]),
  ] },
  { id: WS2, ref: 'workspace:3', title: 'beta', panes: [
    pane(Q1, 'pane:5', 0, F, [sf(F, 'surface:7', true)]),
    Object.assign(pane(Q2, 'pane:6', 1, G, [sf(G, 'surface:8', true)]), { focused: true }),
  ] },
  { id: WS3, ref: 'workspace:4', title: 'gamma', panes: [
    pane(R2, 'pane:8', 1, I, [sf(I, 'surface:10', true)]),
    pane(R1, 'pane:7', 0, H, [sf(H, 'surface:9', true)]),
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
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd148-move-ws-')));
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
  const r = await fetch(bridge.base + '/cmux/move-to-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j };
};
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ok = { workspace: WS, pane: P1, target: WS2 };

test('multi-tab pane: lands right of the target focused pane, rest join in order, active last, never focus', async () => {
  const r = await post(ok);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.workspace, WS2);
  assert.deepEqual(r.json.moved, [A, C, B]);
  assert.deepEqual(calls(), [
    ['move-surface', '--surface', A, '--pane', Q2, '--workspace', WS2, '--focus', 'false'],
    ['drag-surface-to-split', '--surface', A, 'right', '--workspace', WS2, '--focus', 'false'],
    ['move-surface', '--surface', C, '--workspace', WS2, '--after', A, '--focus', 'false'],
    ['move-surface', '--surface', B, '--workspace', WS2, '--after', A, '--focus', 'false'],
  ]);
  assert.ok(Array.isArray(r.json.workspaces));
});

test('no focused pane in target -> its last pane by index; refs accepted; single tab = the pair', async () => {
  const r = await post({ workspace: 'workspace:2', pane: 'pane:4', target: 'workspace:4' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(calls(), [
    ['move-surface', '--surface', E, '--pane', R2, '--workspace', WS3, '--focus', 'false'],
    ['drag-surface-to-split', '--surface', E, 'right', '--workspace', WS3, '--focus', 'false'],
  ]);
});

test('400s: bad_pane / bad_workspace / same workspace; nothing moved', async () => {
  assert.equal((await post({ ...ok, pane: 'nope' })).json.error, 'bad_pane');
  assert.equal((await post({ ...ok, target: '' })).json.error, 'bad_workspace');
  assert.equal((await post({ ...ok, workspace: 'x' })).json.error, 'bad_workspace');
  const same = await post({ ...ok, target: 'workspace:2' });
  assert.equal(same.status, 400); assert.equal(same.json.error, 'bad_workspace');
  assert.deepEqual(calls(), []);
});

test('404: unknown workspace / target / pane, pane of another workspace', async () => {
  const ghostWs = 'eeeeeee1-1111-4111-8111-111111111119';
  assert.equal((await post({ ...ok, target: ghostWs })).json.error, 'no_such_workspace');
  assert.equal((await post({ ...ok, workspace: ghostWs })).json.error, 'no_such_workspace');
  assert.equal((await post({ ...ok, pane: 'ccccccc1-2222-4222-8222-222222222229' })).json.error, 'no_such_pane');
  const other = await post({ ...ok, pane: Q1, target: WS3 });
  assert.equal(other.status, 404); assert.equal(other.json.error, 'no_such_pane');
  assert.deepEqual(calls(), []);
});

test('S2p: private source pane, source workspace or TARGET workspace -> 423, nothing moved', async () => {
  for (const body of [{ workspace: WS_P, pane: PP, target: WS2 }, { ...ok, target: WS_P }, { ...ok, pane: PP }]) {
    const r = await post(body);
    assert.equal(r.status, 423, JSON.stringify(body)); assert.deepEqual(r.json, { error: 'private' });
  }
  assert.deepEqual(calls(), []);
});

test('split refused -> parked tab goes back to the source workspace, 502 rolledBack', async () => {
  fs.writeFileSync(failFile, 'drag-surface-to-split ' + A);
  const r = await post(ok);
  assert.equal(r.status, 502); assert.equal(r.json.error, 'cmux_failed');
  assert.equal(r.json.rolledBack, true);
  assert.deepEqual(r.json.moved, []); assert.deepEqual(r.json.remaining, [A, B, C]);
  assert.deepEqual(calls().at(-1), ['move-surface', '--surface', A, '--workspace', WS, '--before', B, '--focus', 'false']);
});

test('a later tab refused -> 502 names moved / remaining; no more calls', async () => {
  fs.writeFileSync(failFile, 'move-surface ' + C);
  const r = await post(ok);
  assert.equal(r.status, 502);
  assert.deepEqual(r.json.moved, [A]); assert.deepEqual(r.json.remaining, [B, C]);
  assert.equal(r.json.rolledBack, false);
  assert.equal(calls().length, 3);
});

test('{ surface, target }: resolves the pane holding the tab + its workspace', async () => {
  const r = await post({ surface: B, target: WS2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.moved, [A, C, B]);
  assert.equal(calls()[0][4], Q2);
  fs.writeFileSync(log, '');
  assert.equal((await post({ surface: 'ccccccc1-3333-4333-8333-333333333339', target: WS2 })).json.error, 'no_such_pane');
  assert.equal((await post({ surface: 'nope', target: WS2 })).json.error, 'bad_surface');
  assert.equal((await post({ surface: S1, target: WS2 })).status, 423);
  assert.deepEqual(calls(), []);
});
