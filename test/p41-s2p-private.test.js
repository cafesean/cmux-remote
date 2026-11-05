'use strict';
// p41 S2p — private-surface gate. A surface is private when it sits in the workspace titled
// "Claude accounts", or is listed (unexpired) in the private-surfaces mark file. The bridge answers
// 423 `private` for any request addressing one, and multi-surface replies drop them.
//
// Unit tests for lib/private-surfaces.js, then a REAL bridge.js child (ephemeral port, fake cmux,
// private HOME) for the gate. Offline: synthetic ids only, no real cmux, no network.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const priv = require('../lib/private-surfaces');

const WS_P = 'aaaaaaa1-1111-4111-8111-111111111111';   // "Claude accounts"
const WS_N = 'bbbbbbb1-1111-4111-8111-111111111111';   // normal
const PANE_P = 'aaaaaaa1-2222-4222-8222-222222222221';
const PANE_N1 = 'bbbbbbb1-2222-4222-8222-222222222221';
const PANE_N2 = 'bbbbbbb1-2222-4222-8222-222222222222';
const S1 = 'aaaaaaa1-3333-4333-8333-333333333331';     // in "Claude accounts"
const S2 = 'bbbbbbb1-3333-4333-8333-333333333331';     // normal
const S3 = 'bbbbbbb1-3333-4333-8333-333333333332';     // normal workspace, marked in some tests

const surface = (id, ref) => ({ id, ref, title: ref, type: 'terminal', selected: true, selected_in_pane: true });
const pane = (id, ref, index, sf) => ({ id, ref, index, focused: index === 0, selected_surface_id: sf.id, surfaces: [sf] });
const RAW_TREE = () => ({
  windows: [{
    id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1',
    workspaces: [
      { id: WS_P, ref: 'workspace:1', title: 'Claude accounts', selected: false, panes: [pane(PANE_P, 'pane:1', 0, surface(S1, 'surface:1'))] },
      { id: WS_N, ref: 'workspace:2', title: 'acme', selected: true, panes: [
        pane(PANE_N1, 'pane:2', 0, surface(S2, 'surface:2')),
        pane(PANE_N2, 'pane:3', 1, surface(S3, 'surface:3')),
      ] },
    ],
  }],
});
// bridge.js loadTree shape (what createPrivacy's loadTree returns)
function bridgeTree() {
  return RAW_TREE().windows[0].workspaces.map((ws) => {
    const tabs = []; const panes = [];
    for (const p of ws.panes) {
      const ids = [];
      for (const sf of p.surfaces) { tabs.push({ id: sf.id, ref: sf.ref, title: sf.title, type: sf.type, pane: p.id, paneRef: p.ref }); ids.push(sf.id); }
      panes.push({ ref: p.ref, id: p.id, index: p.index, selected: ids[0], tabs: ids });
    }
    return { ref: ws.ref, id: ws.id, title: ws.title, tabs, panes };
  });
}

let tmp;
before(async () => { tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2p-'))); });
after(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
const fresh = (name) => path.join(tmp, name + '-' + Math.random().toString(36).slice(2), 'private-surfaces.json');

// ---------------------------------------------------------------- unit: lib/private-surfaces.js
test('title constant is verbatim', () => {
  assert.equal(priv.PRIVATE_WORKSPACE_TITLE, 'Claude accounts');
});

test('title rule: every surface, pane and the workspace titled "Claude accounts" is private', async () => {
  const p = priv.createPrivacy({ loadTree: async () => bridgeTree(), file: fresh('title') });
  assert.equal(await p.isPrivateSurface(S1), true);
  assert.equal(await p.isPrivateSurface('surface:1'), true);
  assert.equal(await p.isPrivatePane(PANE_P), true);
  assert.equal(await p.isPrivateWorkspace(WS_P), true);
  assert.equal(await p.isPrivateWorkspace('workspace:1'), true);
  assert.equal(await p.isPrivateSurface(S2), false);
  assert.equal(await p.isPrivatePane(PANE_N1), false);
  assert.equal(await p.isPrivateWorkspace(WS_N), false);
  assert.equal(await p.isPrivateSurface('surface:99'), false, 'unknown ref is not private');
});

test('mark file: marked surface in a normal workspace is private (by id or ref), its pane too; file is 0600', async () => {
  const file = fresh('mark');
  let t = 1000;
  priv.mark({ surface: S3, workspace: WS_N, ttlMs: 500 }, { file, now: () => t });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const p = priv.createPrivacy({ loadTree: async () => bridgeTree(), file, now: () => t });
  assert.equal(await p.isPrivateSurface(S3), true);
  assert.equal(await p.isPrivateSurface('surface:3'), true, 'ref of a marked id resolves through the tree');
  assert.equal(await p.isPrivatePane(PANE_N2), true);
  assert.equal(await p.isPrivateSurface(S2), false);
  assert.equal(await p.isPrivateWorkspace(WS_N), false, 'a marked surface does not make its whole workspace private');
});

test('expiry: marked() drops expired entries; an expired mark is not private', async () => {
  const file = fresh('exp');
  let t = 1000;
  priv.mark({ surface: S3, workspace: WS_N, ttlMs: 500 }, { file, now: () => t });
  assert.equal(priv.marked(1200, { file }).length, 1);
  assert.equal(priv.marked(1600, { file }).length, 0);
  const p = priv.createPrivacy({ loadTree: async () => bridgeTree(), file, now: () => t });
  assert.equal(await p.isPrivateSurface(S3), true);
  t = 1501;
  assert.equal(await p.isPrivateSurface(S3), false);
});

test('unmark removes the entry', async () => {
  const file = fresh('unmark');
  priv.mark({ surface: S3, ttlMs: 60000 }, { file });
  priv.unmark(S3, { file });
  assert.equal(priv.marked(Date.now(), { file }).length, 0);
});

test('restart: a NEW instance reads the mark file written by an earlier one', async () => {
  const file = fresh('restart');
  priv.mark({ surface: S3, workspace: WS_N, ttlMs: 60000 }, { file });
  const p2 = priv.createPrivacy({ loadTree: async () => bridgeTree(), file });
  assert.equal(await p2.isPrivateSurface(S3), true);
});

test('unreadable mark file: title rule still applies (fail closed on the private workspace), logged once', async () => {
  const file = fresh('bad');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json', { mode: 0o600 });
  const logs = [];
  const p = priv.createPrivacy({ loadTree: async () => bridgeTree(), file, log: (m) => logs.push(m) });
  assert.equal(await p.isPrivateSurface(S1), true);
  assert.equal(await p.isPrivateWorkspace(WS_P), true);
  assert.equal(await p.isPrivateSurface(S2), false);
  await p.isPrivateSurface(S3);
  assert.equal(logs.length, 1);
});

test('filterTree drops the private workspace and marked surfaces (and a pane left empty)', async () => {
  const file = fresh('filter');
  priv.mark({ surface: S3, ttlMs: 60000 }, { file });
  const p = priv.createPrivacy({ loadTree: async () => bridgeTree(), file });
  const out = p.filterTree(bridgeTree());
  assert.deepEqual(out.map((w) => w.id), [WS_N]);
  assert.deepEqual(out[0].tabs.map((t) => t.id), [S2]);
  assert.deepEqual(out[0].panes.map((x) => x.id), [PANE_N1]);
  assert.equal(JSON.stringify(out).includes(S3), false);
});

test('tree is cached (<= 1 s) but a ref missing from the cache forces one reload', async () => {
  let calls = 0; let t = 0;
  let tree = bridgeTree().filter((w) => w.id !== WS_P);
  const p = priv.createPrivacy({ loadTree: async () => { calls++; return tree; }, file: fresh('cache'), now: () => t });
  assert.equal(await p.isPrivateSurface(S2), false);
  assert.equal(await p.isPrivateSurface(S2), false);
  assert.equal(calls, 1);
  tree = bridgeTree();               // the private workspace appears on the Mac
  t = 200;                           // past FORCE_MIN_MS, inside the 1 s cache
  assert.equal(await p.isPrivateSurface(S1), true, 'unknown-in-cache ref reloads instead of answering stale');
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------- bridge: the one gate
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const op = args[0] || '';
fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(args) + '\n');
let out = 'OK\n';
if (op === 'tree') out = fs.readFileSync(process.env.FAKE_CMUX_TREE, 'utf8');
else if (op === 'list-status') out = '';
else if (op === 'read-screen') out = 'hello\n';
else if (op === 'list-notifications') out = JSON.stringify(JSON.parse(process.env.FAKE_CMUX_NOTES));
else if (op === 'rpc') out = '{}';
process.stdout.write(out, () => process.exit(0));
`;

const NOTES = [
  { id: 'n1', title: 'secret', body: 'x', surface_id: S1, workspace_id: WS_P, is_read: false },
  { id: 'n2', title: 'fine', body: 'y', surface_id: S2, workspace_id: WS_N, is_read: false },
  { id: 'n3', title: 'marked', body: 'z', surface_id: S3, workspace_id: WS_N, is_read: false },
];

let bridge, dir, markFile, cmuxLog;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2p-bridge-')));
  const bin = path.join(dir, 'fake-cmux');
  fs.writeFileSync(bin, FAKE_CMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(RAW_TREE()));
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  cmuxLog = path.join(dir, 'cmux.log');
  markFile = path.join(dir, 'cfg', 'private-surfaces.json');
  bridge = await bootBridge({ cwd: dir, env: {
    CMUX_BIN: bin, FAKE_CMUX_TREE: path.join(dir, 'tree.json'), FAKE_CMUX_LOG: cmuxLog,
    FAKE_CMUX_NOTES: JSON.stringify(NOTES), HYPERMUX_PRIVATE_FILE: markFile,
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), CMUX_SUBMIT_SETTLE_MS: '0', NODE_ENV: 'test',
    COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (bridge) await bridge.stop(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(bridge.base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t }; };
const post = async (p, body) => { const r = await fetch(bridge.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t }; };
const cmuxCalls = () => { try { return fs.readFileSync(cmuxLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const typedInto = (s) => cmuxCalls().some((a) => (a[0] === 'send' || a[0] === 'send-key' || a[0] === 'read-screen') && a.includes(s));

test('bridge: GET /cmux/screen on the private surface -> 423 private, cmux never asked', async () => {
  const r = await get('/cmux/screen?surface=' + S1);
  assert.equal(r.status, 423);
  assert.deepEqual(r.json, { error: 'private' });
  assert.equal(typedInto(S1), false);
  const r2 = await get('/cmux/screen?surface=surface:1');
  assert.equal(r2.status, 423, 'the ref form is gated too');
});

test('bridge: grid/history/stream/browser routes on the private surface -> 423', async () => {
  for (const p of ['/cmux/grid', '/cmux/history', '/cmux/browser/info', '/cmux/browser/hits']) {
    const r = await get(p + '?surface=' + S1);
    assert.equal(r.status, 423, p);
  }
  const lay = await get('/cmux/layout?workspace=' + WS_P);
  assert.equal(lay.status, 423, 'layout of the private workspace');
});

test('bridge: POST /cmux/send {surface: private} -> 423, nothing typed', async () => {
  const r = await post('/cmux/send', { surface: S1, text: 'hi', submit: true });
  assert.equal(r.status, 423);
  assert.deepEqual(r.json, { error: 'private' });
  assert.equal(typedInto(S1), false);
});

test('bridge: body routes addressing the private workspace or pane -> 423', async () => {
  assert.equal((await post('/cmux/key', { surface: S1, key: 'enter' })).status, 423);
  assert.equal((await post('/cmux/new-surface', { workspace: WS_P })).status, 423);
  assert.equal((await post('/cmux/close-pane', { workspace: WS_N, pane: PANE_P })).status, 423);
  assert.equal((await post('/cmux/browser/tap', { surface: S1, x: 1, y: 1 })).status, 423);
});

test('bridge: tree omits the private workspace; S2 routes unchanged', async () => {
  const t = await get('/cmux/tree');
  assert.equal(t.status, 200);
  assert.equal(t.text.includes(S1), false);
  assert.equal(t.text.includes('Claude accounts'), false);
  assert.ok(t.json.workspaces.some((w) => w.id === WS_N));
  const s = await get('/cmux/screen?surface=' + S2);
  assert.equal(s.status, 200);
  assert.equal(s.json.screen, 'hello\n');
  const sd = await post('/cmux/send', { surface: S2, text: 'hi' });
  assert.equal(sd.status, 200);
  assert.equal(typedInto(S2), true);
});

test('bridge: notifications and sessions list drop the private surface; its thread -> 423', async () => {
  const n = await get('/cmux/notifications');
  assert.equal(n.status, 200);
  assert.deepEqual(n.json.notifications.map((x) => x.id).sort(), ['n2', 'n3']);
  const l = await get('/cmux/sessions');
  assert.equal(l.status, 200);
  assert.equal(l.text.includes(S1), false);
  assert.ok(l.json.sessions.some((x) => x.surface === S2));
  const machine = l.json.machineId;
  const th = await get(`/cmux/sessions/${encodeURIComponent(machine + ':' + S1)}/thread`);
  assert.equal(th.status, 423);
});

test('bridge: panes-stream drops private surfaces; only-private -> 423', async () => {
  const r = await get('/cmux/panes-stream?surfaces=' + S1);
  assert.equal(r.status, 423);
});

test('bridge: a marked surface in a normal workspace -> 423; after expiry -> not private', async () => {
  priv.mark({ surface: S3, workspace: WS_N, ttlMs: 1500 }, { file: markFile });
  const r = await get('/cmux/screen?surface=' + S3);
  assert.equal(r.status, 423);
  assert.equal((await post('/cmux/send', { surface: S3, text: 'x' })).status, 423);
  const t = await get('/cmux/tree');
  assert.equal(t.text.includes(S3), false);
  const n = await get('/cmux/notifications');
  assert.deepEqual(n.json.notifications.map((x) => x.id), ['n2']);
  await new Promise((res) => setTimeout(res, 1700));
  const r2 = await get('/cmux/screen?surface=' + S3);
  assert.equal(r2.status, 200);
});
