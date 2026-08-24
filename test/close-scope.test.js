'use strict';
// Closing a pane or a tab under cmux >= 0.64.22.
//
// The CLI changed under the bridge: `close-surface` now REFUSES a bare `--surface` and demands
// `--workspace` or `--window` alongside it, and it refuses to close a workspace's LAST surface at
// all. The bridge runs detached under launchd, so it has none of the window context an interactive
// shell hands the CLI for free — every close it issued came back
// `Error: close-surface requires --workspace or --window with explicit --surface`, which the phone
// surfaced as a close failure on every single tap.
//
// Tested against a REAL bridge.js child on an ephemeral port with `CMUX_BIN` pointed at a fake cmux
// that reproduces BOTH refusals and keeps a live tree on disk, so the assertions are about the
// argv the bridge actually spawns, not about a re-implementation of it.
//
// Offline: one node child and localhost HTTP. No cmux, no network, no live-machine state.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const WS_A = 'aaaaaaa1-1111-4111-8111-111111111111';
const WS_B = 'bbbbbbb1-1111-4111-8111-111111111111';
const PANE_A1 = 'aaaaaaa1-2222-4222-8222-222222222221';
const PANE_A2 = 'aaaaaaa1-2222-4222-8222-222222222222';
const PANE_B1 = 'bbbbbbb1-2222-4222-8222-222222222221';
const SURF_A1 = 'aaaaaaa1-3333-4333-8333-333333333331';
const SURF_A2 = 'aaaaaaa1-3333-4333-8333-333333333332';
const SURF_B1 = 'bbbbbbb1-3333-4333-8333-333333333331';

const surface = (id, ref) => ({ id, ref, title: ref, type: 'terminal', selected: true, selected_in_pane: true });
const pane = (id, ref, index, sf) => ({ id, ref, index, focused: index === 0, selected_surface_id: sf.id, surfaces: [sf] });
const TREE = () => ({
  windows: [{
    id: 'ffffffff-1111-4111-8111-111111111111',
    ref: 'window:1',
    workspaces: [
      // two panes: closing one leaves the workspace alive
      { id: WS_A, ref: 'workspace:1', title: 'two panes', selected: true, panes: [
        pane(PANE_A1, 'pane:1', 0, surface(SURF_A1, 'surface:1')),
        pane(PANE_A2, 'pane:2', 1, surface(SURF_A2, 'surface:2')),
      ] },
      // one pane holding the workspace's only surface: cmux refuses close-surface here
      { id: WS_B, ref: 'workspace:2', title: 'one pane', selected: false, panes: [
        pane(PANE_B1, 'pane:3', 0, surface(SURF_B1, 'surface:3')),
      ] },
    ],
  }],
});

// A fake cmux that speaks 0.64.22's rules. It keeps the tree on disk and mutates it, so a close
// the bridge issues is visible to the tree read that follows it.
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const op = args[0] || '';
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const TREE_FILE = process.env.FAKE_CMUX_TREE;
const read = () => JSON.parse(fs.readFileSync(TREE_FILE, 'utf8'));
const write = (t) => fs.writeFileSync(TREE_FILE, JSON.stringify(t));
const rec = (o) => fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(o) + '\n');
const die = (msg) => { process.stderr.write('Error: ' + msg + '\n'); process.exit(1); };

if (op === 'tree') { process.stdout.write(JSON.stringify(read())); process.exit(0); }
if (op === 'list-status') { process.exit(0); }

if (op === 'close-surface') {
  rec({ op: op, args: args });
  const sf = flag('--surface'), ws = flag('--workspace'), win = flag('--window');
  // 0.64.22 refusal #1 — a bare --surface carries no scope for a detached caller.
  if (sf && !ws && !win) die('close-surface requires --workspace or --window with explicit --surface');
  const t = read();
  let owner = null;
  for (const w of t.windows) for (const x of w.workspaces)
    for (const p of x.panes) if (p.surfaces.some((s) => s.id === sf)) owner = x;
  if (!owner) die('Surface not found: ' + sf);
  const total = owner.panes.reduce((n, p) => n + p.surfaces.length, 0);
  // 0.64.22 refusal #2 — the last surface of a workspace cannot be closed this way at all.
  if (total <= 1) die('invalid_state: Cannot close the last surface');
  for (const p of owner.panes) p.surfaces = p.surfaces.filter((s) => s.id !== sf);
  owner.panes = owner.panes.filter((p) => p.surfaces.length);
  write(t);
  process.stdout.write('OK\n');
  process.exit(0);
}

if (op === 'close-workspace') {
  rec({ op: op, args: args });
  const ws = flag('--workspace');
  const t = read();
  let found = false;
  for (const w of t.windows) {
    const before = w.workspaces.length;
    w.workspaces = w.workspaces.filter((x) => x.id !== ws && x.ref !== ws);
    if (w.workspaces.length !== before) found = true;
  }
  if (!found) die('not_found: Workspace not found');
  write(t);
  process.stdout.write('OK\n');
  process.exit(0);
}

process.exit(1);
`;

let bridge = null, cwd = null, logFile = null, treeFile = null;

async function reset() {
  await fsp.writeFile(treeFile, JSON.stringify(TREE()));
  await fsp.writeFile(logFile, '');
}
const calls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function post(p, body) {
  const r = await fetch(`${bridge.base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

before(async () => {
  cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cmux-close-')));
  const bin = path.join(cwd, 'fake-cmux');
  await fsp.writeFile(bin, FAKE_CMUX, { mode: 0o755 });
  logFile = path.join(cwd, 'calls.jsonl');
  treeFile = path.join(cwd, 'tree.json');
  await reset();
  bridge = await bootBridge({ cwd, env: { CMUX_BIN: bin, FAKE_CMUX_LOG: logFile, FAKE_CMUX_TREE: treeFile } });
});
after(async () => { if (bridge) await bridge.stop(); });

test('close-pane scopes close-surface to the workspace, so the CLI accepts it', async () => {
  await reset();
  const r = await post('/cmux/close-pane', { workspace: WS_A, pane: PANE_A2 });
  assert.equal(r.status, 200, `close-pane answered ${r.status}: ${r.text}`);
  assert.equal(r.json.ok, true);
  const c = calls();
  assert.equal(c.length, 1, 'exactly one cmux close call');
  assert.equal(c[0].op, 'close-surface');
  const i = c[0].args.indexOf('--workspace');
  assert.ok(i >= 0, `close-surface was spawned without --workspace: ${c[0].args.join(' ')}`);
  assert.equal(c[0].args[i + 1], WS_A, 'scoped to the pane\'s own workspace');
});

test('closing the only pane of a workspace closes the WORKSPACE, which is the one thing cmux still allows', async () => {
  await reset();
  const r = await post('/cmux/close-pane', { workspace: WS_B, pane: PANE_B1 });
  assert.equal(r.status, 200, `close-pane answered ${r.status}: ${r.text}`);
  assert.equal(r.json.ok, true);
  const c = calls();
  assert.deepEqual(c.map((x) => x.op), ['close-workspace'],
    'the last surface is not closable, so the workspace goes instead of erroring');
  assert.ok(c[0].args.includes(WS_B));
  const left = JSON.parse(fs.readFileSync(treeFile, 'utf8')).windows[0].workspaces.map((w) => w.id);
  assert.deepEqual(left, [WS_A], 'the workspace is gone and the other one is untouched');
});

test('close-tab scopes close-surface to the workspace it found the surface in', async () => {
  await reset();
  const r = await post('/cmux/close-tab', { surface: SURF_A1 });
  assert.equal(r.status, 200, `close-tab answered ${r.status}: ${r.text}`);
  assert.equal(r.json.ok, true);
  const c = calls();
  assert.equal(c.length, 1);
  assert.equal(c[0].op, 'close-surface');
  const i = c[0].args.indexOf('--workspace');
  assert.ok(i >= 0, `close-surface was spawned without --workspace: ${c[0].args.join(' ')}`);
  assert.equal(c[0].args[i + 1], WS_A);
});

test('closing a workspace\'s last tab closes the workspace', async () => {
  await reset();
  const r = await post('/cmux/close-tab', { surface: SURF_B1 });
  assert.equal(r.status, 200, `close-tab answered ${r.status}: ${r.text}`);
  assert.equal(r.json.ok, true);
  assert.deepEqual(calls().map((x) => x.op), ['close-workspace']);
});

test('a surface that is in no workspace is a 404, not a spawn', async () => {
  await reset();
  const r = await post('/cmux/close-tab', { surface: 'ccccccc1-3333-4333-8333-333333333339' });
  assert.equal(r.status, 404);
  assert.equal(calls().length, 0, 'nothing was spawned for a surface the tree does not carry');
});
