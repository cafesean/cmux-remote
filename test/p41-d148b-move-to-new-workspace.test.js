'use strict';
// p41 D148b — POST /cmux/move-to-workspace { workspace, pane | surface, newWorkspace: { name } }: move a
// WHOLE pane into a brand-new workspace. A REAL bridge.js child (ephemeral port, fake cmux, private HOME).
// The fake is stateful: `new-workspace` prints `OK workspace:9` and adds that workspace (one pane, one
// fresh terminal) to the tree it serves. Offline: synthetic ids, no real cmux, no network.
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
const PP = 'aaaaaaa1-2222-4222-8222-222222222221';
const A = 'bbbbbbb1-3333-4333-8333-333333333331';
const B = 'bbbbbbb1-3333-4333-8333-333333333332';
const C = 'bbbbbbb1-3333-4333-8333-333333333333';
const D = 'bbbbbbb1-3333-4333-8333-333333333334';
const S1 = 'aaaaaaa1-3333-4333-8333-333333333331';
const NWS = 'eeeeeee1-1111-4111-8111-111111111111';    // the workspace new-workspace creates
const NP = 'eeeeeee1-2222-4222-8222-222222222221';
const NS = 'eeeeeee1-3333-4333-8333-333333333331';     // its fresh terminal

const sf = (id, ref, sel) => ({ id, ref, title: ref, type: 'terminal', selected: sel, selected_in_pane: sel });
const pane = (id, ref, index, sel, sfs) => ({ id, ref, index, focused: false, selected_surface_id: sel, surfaces: sfs });
const TREE = { windows: [{ id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1', workspaces: [
  { id: WS_P, ref: 'workspace:1', title: 'Claude accounts', panes: [pane(PP, 'pane:1', 0, S1, [sf(S1, 'surface:1', true)])] },
  { id: WS, ref: 'workspace:2', title: 'acme', selected: true, panes: [
    pane(P1, 'pane:2', 0, B, [sf(A, 'surface:2', false), sf(B, 'surface:3', true), sf(C, 'surface:4', false)]),
    pane(P2, 'pane:3', 1, D, [sf(D, 'surface:5', true)]),
  ] },
] }] };
const NEW_WS = (title) => ({ id: NWS, ref: 'workspace:9', title, panes: [pane(NP, 'pane:9', 0, NS, [sf(NS, 'surface:9', true)])] });

// FAKE_CMUX_FAIL: one line "<op> <arg>" — that exact call exits 1. FAKE_CMUX_NOWS=1: new-workspace
// prints OK but adds nothing to the tree.
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
  if (op === fop && (!fsf || args.includes(fsf))) { process.stderr.write('Error: invalid_state: refused\n', () => process.exit(1)); return; }
}
let out = 'OK\n';
if (op === 'tree') out = fs.readFileSync(process.env.FAKE_CMUX_TREE, 'utf8');
else if (op === 'new-workspace') {
  const t = JSON.parse(fs.readFileSync(process.env.FAKE_CMUX_TREE, 'utf8'));
  const name = args[args.indexOf('--name') + 1];
  const w = JSON.parse(process.env.FAKE_NEW_WS); w.title = name;
  if (!fs.existsSync(process.env.FAKE_CMUX_NOWS)) { t.windows[0].workspaces.push(w); fs.writeFileSync(process.env.FAKE_CMUX_TREE, JSON.stringify(t)); }
  out = 'OK workspace:9\n';
}
else if (op === 'list-status') out = '';
else if (op === 'list-notifications') out = '[]';
else if (op === 'rpc') out = '{}';
process.stdout.write(out, () => process.exit(0));
`;

let bridge, dir, log, failFile, treeFile, noWs;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd148b-new-ws-')));
  const bin = path.join(dir, 'fake-cmux');
  fs.writeFileSync(bin, FAKE_CMUX, { mode: 0o755 });
  treeFile = path.join(dir, 'tree.json');
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  log = path.join(dir, 'cmux.log'); failFile = path.join(dir, 'fail'); noWs = path.join(dir, 'nows');
  bridge = await bootBridge({ cwd: dir, env: {
    CMUX_BIN: bin, FAKE_CMUX_TREE: treeFile, FAKE_CMUX_LOG: log, FAKE_CMUX_FAIL: failFile, FAKE_CMUX_NOWS: noWs,
    FAKE_NEW_WS: JSON.stringify(NEW_WS('')),
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (bridge) await bridge.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });
beforeEach(() => {
  fs.writeFileSync(log, ''); fs.writeFileSync(failFile, ''); fs.rmSync(noWs, { force: true });
  fs.writeFileSync(treeFile, JSON.stringify(TREE));
});

const post = async (body) => {
  const r = await fetch(bridge.base + '/cmux/move-to-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j };
};
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('new workspace: create unfocused, move every tab into its pane (active last), close the fresh terminal', async () => {
  const r = await post({ workspace: WS, pane: P1, newWorkspace: { name: '  Deploys  ' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.workspace, { id: NWS, ref: 'workspace:9', title: 'Deploys' });
  assert.deepEqual(r.json.moved, [A, C, B]);
  assert.deepEqual(calls(), [
    ['new-workspace', '--name', 'Deploys', '--focus', 'false'],
    ['move-surface', '--surface', A, '--pane', NP, '--workspace', NWS, '--focus', 'false'],
    ['move-surface', '--surface', C, '--workspace', NWS, '--after', A, '--focus', 'false'],
    ['move-surface', '--surface', B, '--workspace', NWS, '--after', A, '--focus', 'false'],
    ['close-surface', '--surface', NS, '--workspace', NWS],
  ]);
  assert.ok(Array.isArray(r.json.workspaces));
});

test('name: default "<source title> 2"; capped at 60 chars; control chars dropped; { surface } form', async () => {
  let r = await post({ surface: D, newWorkspace: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.workspace.title, 'acme 2');
  assert.deepEqual(calls()[0], ['new-workspace', '--name', 'acme 2', '--focus', 'false']);
  assert.deepEqual(calls().slice(1), [
    ['move-surface', '--surface', D, '--pane', NP, '--workspace', NWS, '--focus', 'false'],
    ['close-surface', '--surface', NS, '--workspace', NWS],
  ]);
  fs.writeFileSync(log, ''); fs.writeFileSync(treeFile, JSON.stringify(TREE));
  r = await post({ workspace: WS, pane: P2, newWorkspace: { name: 'x'.repeat(80) + '\nrm' } });
  assert.equal(r.status, 200);
  assert.equal(calls()[0][2], 'x'.repeat(60));
});

test('400s: target + newWorkspace together, non-object newWorkspace, reserved/flag-like name; nothing runs', async () => {
  const WS2 = 'ccccccc1-1111-4111-8111-111111111111';
  assert.equal((await post({ workspace: WS, pane: P1, target: WS2, newWorkspace: { name: 'x' } })).json.error, 'bad_workspace');
  assert.equal((await post({ workspace: WS, pane: P1, newWorkspace: 'x' })).json.error, 'bad_name');
  assert.equal((await post({ workspace: WS, pane: P1, newWorkspace: { name: 'Claude accounts' } })).json.error, 'bad_name');
  assert.equal((await post({ workspace: WS, pane: P1, newWorkspace: { name: '--focus' } })).json.error, 'bad_name');
  assert.equal((await post({ workspace: WS, pane: 'nope', newWorkspace: {} })).json.error, 'bad_pane');
  assert.equal((await post({ workspace: WS, pane: 'ccccccc1-2222-4222-8222-222222222229', newWorkspace: {} })).json.error, 'no_such_pane');
  assert.deepEqual(calls(), []);
});

test('private source pane -> 423 before anything is created', async () => {
  const r = await post({ workspace: WS_P, pane: PP, newWorkspace: { name: 'x' } });
  assert.equal(r.status, 423);
  assert.deepEqual(calls(), []);
});

test('new-workspace refused -> 502, nothing moved, no further calls', async () => {
  fs.writeFileSync(failFile, 'new-workspace');
  const r = await post({ workspace: WS, pane: P1, newWorkspace: { name: 'x' } });
  assert.equal(r.status, 502); assert.equal(r.json.error, 'cmux_failed');
  assert.deepEqual(r.json.moved, []);
  assert.equal(calls().length, 1);
});

test('first move refused -> the new workspace is closed again, 502 rolledBack', async () => {
  fs.writeFileSync(failFile, 'move-surface ' + A);
  const r = await post({ workspace: WS, pane: P1, newWorkspace: { name: 'x' } });
  assert.equal(r.status, 502); assert.equal(r.json.rolledBack, true);
  assert.deepEqual(r.json.moved, []); assert.deepEqual(r.json.remaining, [A, B, C]);
  assert.deepEqual(calls().at(-1), ['close-workspace', '--workspace', NWS]);
  assert.ok(!calls().some((c) => c[0] === 'close-surface'));
});

test('a later tab refused -> 502 moved / remaining + the new workspace; fresh terminal not closed', async () => {
  fs.writeFileSync(failFile, 'move-surface ' + C);
  const r = await post({ workspace: WS, pane: P1, newWorkspace: { name: 'x' } });
  assert.equal(r.status, 502);
  assert.deepEqual(r.json.moved, [A]); assert.deepEqual(r.json.remaining, [B, C]);
  assert.equal(r.json.rolledBack, false); assert.equal(r.json.workspace.id, NWS);
  assert.equal(calls().length, 3);
});

test('new workspace missing from the tree -> closes it by the printed ref, 502', async () => {
  fs.writeFileSync(noWs, '1');
  const r = await post({ workspace: WS, pane: P1, newWorkspace: { name: 'x' } });
  assert.equal(r.status, 502); assert.equal(r.json.rolledBack, true);
  assert.deepEqual(calls().at(-1), ['close-workspace', '--workspace', 'workspace:9']);
  assert.ok(!calls().some((c) => c[0] === 'move-surface' || c[0] === 'close-surface'));
});

test('close of the fresh terminal refused -> still 200 (tabs moved), leftover named', async () => {
  fs.writeFileSync(failFile, 'close-surface ' + NS);
  const r = await post({ workspace: WS, pane: P1, newWorkspace: { name: 'x' } });
  assert.equal(r.status, 200); assert.equal(r.json.leftover, NS);
});
