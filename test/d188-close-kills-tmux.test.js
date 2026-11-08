'use strict';
// p41 D188 — closing a tmux-hosted pane closes its tmux session; orphan listing never touches a live worker.
// Fixtures only: a fake ps table and fake tmux snapshot objects. No tmux, no cmux, no live machine state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const procs = require('../sessions/procs');
const tc = require('../sessions/tmux-close');

const HOSTED = '/fake/state/cmux-remote/tmux-501/default';
const OTHER = '/fake/tmp/tmux-501/default';
const SURF = 'aaaaaaa1-3333-4333-8333-333333333331';
const SURF2 = 'aaaaaaa1-3333-4333-8333-333333333332';

// pid ppid args — 100 = cmux app, 200 = attach client under it, 300/310 shells, 301 claude under 300.
const PS = [
  '100 1 /Applications/cmux.app/Contents/MacOS/cmux',
  '200 100 tmux -S x attach -t =m-live',
  '300 1 -zsh',
  '301 300 claude --model opus',
  '310 1 -zsh',
  '320 1 -zsh',
  '330 1 vim notes.md',
].join('\n');
const table = procs.parsePs(PS);

const pane = (id, pid, o = {}) => ({ id, pid, active: true, cwd: '/x', window: o.window || '@1', command: o.command || 'zsh', dead: !!o.dead });
const sess = (name, o = {}) => ({
  socket: o.socket || HOSTED, name, attached: o.attached || 0, epoch: 1, created: o.created || 1,
  panes: o.panes || [pane('%1', 310)], surfaceId: 'surfaceId' in o ? o.surfaceId : SURF2, clientPids: o.clientPids || [],
});
const snap = (...sessions) => ({ table, sessions });

// ---- orphans --------------------------------------------------------------------------------------

test('live tmux-only worker (claude running, detached) is NOT an orphan', () => {
  const s = sess('m-worker', { panes: [pane('%1', 300, { command: 'claude' })] });
  assert.deepEqual(tc.listOrphans(snap(s), HOSTED), []);
  // even when tmux reports the shell as the foreground command, the claude child keeps it live
  const s2 = sess('m-worker2', { panes: [pane('%2', 300, { command: 'zsh' })] });
  assert.deepEqual(tc.listOrphans(snap(s2), HOSTED), []);
});

test('dead shell (claude exited, zsh left) is an orphan; a dead pane too', () => {
  const a = sess('m-done', { panes: [pane('%1', 310, { command: 'zsh' })] });
  const b = sess('m-dead', { panes: [pane('%2', 999, { dead: true, command: 'claude' })] });
  assert.deepEqual(tc.listOrphans(snap(a, b), HOSTED).map((o) => o.name), ['m-done', 'm-dead']);
});

test('attached session is NOT an orphan (count or a client under the cmux app)', () => {
  const a = sess('m-att', { attached: 1 });
  const b = sess('m-cli', { clientPids: [200] });
  assert.deepEqual(tc.listOrphans(snap(a, b), HOSTED, { underCmuxApp: procs.underCmuxApp }), []);
});

test('not ours: another socket, or never hosted by a cmux pane (no CMUX_SURFACE_ID), is never listed', () => {
  const a = sess('mine', { socket: OTHER });
  const b = sess('handmade', { surfaceId: null });
  assert.deepEqual(tc.listOrphans(snap(a, b), HOSTED), []);
});

test('any non-shell program (vim) or one live pane among dead ones keeps the session', () => {
  const a = sess('m-vim', { panes: [pane('%1', 330, { command: 'vim' })] });
  const b = sess('m-mixed', { panes: [pane('%1', 310), pane('%2', 300, { command: 'claude', window: '@2' })] });
  assert.deepEqual(tc.listOrphans(snap(a, b), HOSTED), []);
});

test('no ps table = fail closed (nothing listed)', () => {
  assert.deepEqual(tc.listOrphans({ table: null, sessions: [sess('m-done')] }, HOSTED), []);
});

test('closeOrphans re-checks each name: kills only names still orphaned now', async () => {
  const ran = [];
  const run = async (socket, args) => { ran.push([socket, ...args]); return { code: 0 }; };
  const now = snap(sess('m-done'), sess('m-back', { attached: 1 }), sess('m-live', { panes: [pane('%1', 300, { command: 'claude' })] }));
  const r = await tc.closeOrphans(['m-done', 'm-back', 'm-live', 'm-gone'], now, HOSTED, run);
  assert.deepEqual(r, { closed: ['m-done'], skipped: ['m-back', 'm-live', 'm-gone'] });
  assert.deepEqual(ran, [[HOSTED, 'kill-session', '-t', '=m-done']]);
});

test('parseNames rejects malformed / oversized bodies and tmux target syntax', () => {
  assert.equal(tc.parseNames({}), null);
  assert.equal(tc.parseNames({ names: [] }), null);
  assert.equal(tc.parseNames({ names: ['a:b'] }), null);
  assert.equal(tc.parseNames({ names: ['-t'] }), null);
  assert.equal(tc.parseNames({ names: Array.from({ length: tc.LIMITS.orphansMax + 1 }, (_, i) => `n${i}`) }), null);
  assert.deepEqual(tc.parseNames({ names: ['m-a', 'm-a', 'x_1'] }), ['m-a', 'x_1']);
});

// ---- close plan -----------------------------------------------------------------------------------

test('close: sole client, one window -> kill-session =NAME (exact match)', () => {
  const s = sess('m-live', { surfaceId: SURF, attached: 1, panes: [pane('%1', 300, { command: 'claude' })] });
  assert.deepEqual(tc.closePlan(snap(s), SURF, HOSTED), { socket: HOSTED, session: 'm-live', action: 'kill-session', args: ['kill-session', '-t', '=m-live'] });
});

test('close: session with other windows -> kill only its active window', () => {
  const s = sess('m-multi', { surfaceId: SURF, attached: 1, panes: [
    { ...pane('%1', 300, { window: '@4' }), active: true }, { ...pane('%2', 310, { window: '@5' }), active: false }] });
  assert.deepEqual(tc.closePlan(snap(s), SURF, HOSTED).args, ['kill-window', '-t', '@4']);
});

test('close: other clients (other cmux surfaces) still show it -> keep tmux, close only the cmux pane', () => {
  const s = sess('m-shared', { surfaceId: SURF, attached: 2 });
  assert.equal(tc.closePlan(snap(s), SURF, HOSTED).action, 'keep');
});

test('close: plain cmux pane, a detached stale match, or a session on another socket -> no tmux action', () => {
  assert.equal(tc.closePlan(snap(sess('m-x', { surfaceId: SURF2, attached: 1 })), SURF, HOSTED), null);
  assert.equal(tc.closePlan(snap(sess('m-stale', { surfaceId: SURF, attached: 0 })), SURF, HOSTED), null);
  assert.equal(tc.closePlan(snap(sess('mine', { surfaceId: SURF, attached: 1, socket: OTHER })), SURF, HOSTED), null);
});

// ---- chief-of-staff stop (opt-in) -----------------------------------------------------------------

test('cos worker: off without the bin; task-file match; COS_WORKER env of the claude pid; argv only', async () => {
  const s = sess('m-live', { panes: [pane('%1', 300, { command: 'claude' })] });
  assert.equal(await tc.cosWorkerOf(snap(s), 'm-live', { taskExists: async () => true }), null);
  assert.equal(await tc.cosWorkerOf(snap(s), 'm-live', { stopBin: '/x/stop.sh', taskExists: async (n) => n === 'm-live' }), 'm-live');
  const envOf = async (pid) => (pid === 301 ? { COS_WORKER: 'm-real' } : {});
  assert.equal(await tc.cosWorkerOf(snap(s), 'm-live', { stopBin: '/x/stop.sh', taskExists: async () => false, envOf }), 'm-real');
  const bad = async () => ({ COS_WORKER: 'x; rm -rf /' });
  assert.equal(await tc.cosWorkerOf(snap(s), 'm-live', { stopBin: '/x/stop.sh', taskExists: async () => false, envOf: bad }), null);
  assert.deepEqual(tc.cosStopArgv('m-live'), ['m-live', 'STOPPED', '--force']);
  assert.equal(tc.cosStopArgv('M-Live'), null);
  assert.equal(tc.cosStopArgv('a b'), null);
});

test('snapshot parses the appended window/command/dead fields and still reads the old 9-field shape', async () => {
  const SEP = '|^|';
  const line = (extra) => ['m-a', '%1', '310', '1', '1', '0', '1', '/x', '1', ...extra].join(SEP);
  const tmuxAt = (fields) => async (socket, args) => (args[0] === 'list-panes' ? line(fields) : args[0] === 'show-environment' ? `CMUX_SURFACE_ID=${SURF}` : '');
  const n = await procs.snapshot({ psAll: async () => PS, tmuxSockets: [HOSTED], tmuxAt: tmuxAt(['@3', 'zsh', '1']) });
  assert.deepEqual({ w: n.sessions[0].panes[0].window, c: n.sessions[0].panes[0].command, d: n.sessions[0].panes[0].dead }, { w: '@3', c: 'zsh', d: true });
  const o = await procs.snapshot({ psAll: async () => PS, tmuxSockets: [HOSTED], tmuxAt: tmuxAt([]) });
  assert.deepEqual({ w: o.sessions[0].panes[0].window, c: o.sessions[0].panes[0].command, d: o.sessions[0].panes[0].dead }, { w: null, c: null, d: false });
});

// ---- D188b: closing a tmux-only row -----------------------------------------------------------------
const tmuxIds = require('../lib/tmux-ids');
test('D188b tmux-only close: minted id -> kill-session =NAME on the hosted socket only, live claude or not', () => {
  const live = { ...sess('m-live', { panes: [pane('%7', 300, { command: 'claude' })] }), epoch: 1789991468 };
  const id = tmuxIds.mint('surface', 1789991468, 7);
  assert.deepEqual(tc.tmuxOnlyPlan(snap(live), id, HOSTED), { socket: HOSTED, session: 'm-live', action: 'kill-session', args: ['kill-session', '-t', '=m-live'] });
  // same pane on another socket: never
  assert.equal(tc.tmuxOnlyPlan(snap({ ...live, socket: OTHER }), id, HOSTED), null);
  // pane gone / another server epoch / a cmux uuid: nothing
  assert.equal(tc.tmuxOnlyPlan(snap(live), tmuxIds.mint('surface', 1789991468, 8), HOSTED), null);
  assert.equal(tc.tmuxOnlyPlan(snap(live), tmuxIds.mint('surface', 1700000000, 7), HOSTED), null);
  assert.equal(tc.tmuxOnlyPlan(snap(live), SURF, HOSTED), null);
});
