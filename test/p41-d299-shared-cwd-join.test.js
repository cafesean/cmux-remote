'use strict';
// p41 D299 — two claude panes in one cwd: the cwd fallback never hands one pane another pane's transcript,
// and two live cmux panes are never folded into one list row (A11 folds only a cmux surface + its tmux orphan).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { transcriptFor } = require('../sessions/join.js');
const procs = require('../sessions/procs.js');
const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd299-')));
const row = (n, t) => JSON.stringify({ type: 'user', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: new Date(1e12 + n).toISOString(), message: { role: 'user', content: t } }) + '\n';
const T_OLD = 1_700_000_000;   // seconds (utimes)
const T_NEW = 1_700_000_500;

// ~/.claude/projects/-w/{X,Y}.jsonl: X (the busy pane's session) is the newest file in the dir.
function twoTranscripts(home) {
  const dir = path.join(home, '.claude', 'projects', '-w');
  fs.mkdirSync(dir, { recursive: true });
  const x = path.join(dir, 'sessX.jsonl');
  const y = path.join(dir, 'sessY.jsonl');
  fs.writeFileSync(x, row(1, 'worker'));
  fs.writeFileSync(y, row(2, 'chief'));
  fs.utimesSync(y, T_OLD, T_OLD);
  fs.utimesSync(x, T_NEW, T_NEW);
  return { dir, x, y };
}

const noEvents = async () => ({ events: [], more: false });

test('D299 transcriptFor: cwd fallback skips excludeSessionIds and takes the next newest; via names the source', async () => {
  const home = mk();
  const { x, y } = twoTranscripts(home);
  const base = { home, now: () => Date.now(), readEvents: noEvents, cwdFor: async () => '/w' };
  const plain = await transcriptFor({ id: 'S1' }, base);
  assert.equal(plain.path, x);
  assert.equal(plain.via, 'cwd');
  const j = await transcriptFor({ id: 'S1' }, { ...base, excludeSessionIds: new Set(['sessX']) });
  assert.equal(j && j.sessionId, 'sessY');
  assert.equal(j.path, y);
  assert.equal(j.via, 'cwd');
  assert.equal(await transcriptFor({ id: 'S1' }, { ...base, excludeSessionIds: new Set(['sessX', 'sessY']) }), null);
  // A join found from a hook event says so.
  const ev = { ts: Date.now() - 1000, sessionId: 'sessY', event: 'Stop', transcriptPath: y, surfaceId: 'S1', cwd: '/w' };
  const e = await transcriptFor({ id: 'S1' }, { ...base, readEvents: async () => ({ events: [ev], more: false }) });
  assert.equal(e.sessionId, 'sessY');
  assert.equal(e.via, 'event');
});

async function list(r) {
  return new Promise((resolve) => {
    let code = 0;
    const res = { writeHead(c) { code = c; }, end: (b) => resolve({ code, ...JSON.parse(b) }) };
    r.handle({ method: 'GET', headers: {} }, res, new URL('http://x/cmux/sessions'));
  });
}

const PID = 990001;
test('D299 routes: pane A resolved by process to X; pane B (same cwd, no process/event hit) never takes X and is never folded into A', async () => {
  const home = mk();
  const { y } = twoTranscripts(home);
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${PID}.json`), JSON.stringify({ pid: PID, sessionId: 'sessX', cwd: '/w', startedAt: Date.now() }));
  const table = procs.parsePs([' 1 0 /sbin/launchd', ` ${PID - 1} 1 -zsh`, ` ${PID} ${PID - 1} claude`].join('\n'));
  const snap = { table, sessions: [{ socket: '/s', name: 'm-hyprmux-mini-2', attached: 1, epoch: 1, created: 1, surfaceId: 'surface:A', clientPids: [],
    panes: [{ id: '%1', pid: PID - 1, active: true, cwd: '/w' }] }] };
  // B: an idle pane whose only recent hook event carries its cwd but no transcript path.
  const events = [{ ts: Date.now() - 1000, event: 'Notification', surfaceId: 'surface:B', cwd: '/w' }];
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0,
    loadTree: async () => [
      { ref: 'workspace:1', title: 'WORKERS', tabs: [{ id: 'surface:A', ref: 'surface:1', title: 'tmux', type: 'terminal' }] },
      { ref: 'workspace:2', title: 'CHIEF', tabs: [{ id: 'surface:B', ref: 'surface:2', title: 'claude', type: 'terminal' }] },
    ],
    readEvents: async () => ({ events, more: false }), procSnapshot: async () => snap });
  for (let i = 0; i < 2; i++) {   // a second build (kind memo warm) answers the same
    const l = await list(r);
    assert.equal(l.code, 200);
    const surfaces = l.sessions.map((s) => s.surface).sort();
    assert.deepEqual(surfaces, ['surface:A', 'surface:B'], `build ${i}: ${JSON.stringify(l.sessions.map((s) => [s.surface, s.aliases]))}`);
    const a = l.sessions.find((s) => s.surface === 'surface:A');
    const b = l.sessions.find((s) => s.surface === 'surface:B');
    assert.equal(a.aliases, undefined);
    assert.equal(b.aliases, undefined);
    assert.equal(a.kind, 'claude');
    assert.equal(a.lastActivity, T_NEW * 1000);       // A shows X
    assert.equal(b.lastActivity, T_OLD * 1000, 'B must show its own transcript (Y), not X');
    assert.ok(fs.existsSync(y));
  }
});

test('D299 fold: two live cmux panes resolving to one sessionId are still two rows; a tmux orphan of the same session still folds', async () => {
  const home = mk();
  const { x } = twoTranscripts(home);
  const now = Date.now();
  const events = [
    { ts: now - 3000, sessionId: 'sessX', event: 'Stop', transcriptPath: x, surfaceId: 'surface:A', cwd: '/w' },
    { ts: now - 2000, sessionId: 'sessX', event: 'Stop', transcriptPath: x, surfaceId: 'surface:B', cwd: '/w' },
    { ts: now - 1000, sessionId: 'sessX', event: 'Stop', transcriptPath: x, surfaceId: '%7', cwd: '/w' },
  ];
  const snap = { table: [], sessions: [{ socket: '/s', name: 'x-orph', attached: 0, epoch: 1, created: 1, surfaceId: null, clientPids: [], panes: [{ id: '%7', pid: 5, active: true, cwd: '/w' }] }] };
  const orphan = { id: 'surface:orphan', ref: '%7', title: 'x-orph', type: 'terminal', tmuxPane: '%7', tmuxSocket: '/s' };
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [
      { id: 'surface:A', ref: 'surface:1', title: 'a', type: 'terminal' },
      { id: 'surface:B', ref: 'surface:2', title: 'b', type: 'terminal' }, orphan] }],
    readEvents: async () => ({ events, more: false }), procSnapshot: async () => snap });
  const l = await list(r);
  assert.deepEqual(l.sessions.map((s) => s.surface).sort(), ['surface:A', 'surface:B']);
  const aliases = l.sessions.flatMap((s) => s.aliases || []);
  assert.deepEqual(aliases, ['mini:surface:orphan']);
});
