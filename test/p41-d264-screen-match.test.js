'use strict';
// p41 D264 — after a cmux.app restart the re-attached tmux clients carry no CMUX_SURFACE_ID, so neither
// the session env nor the client env (D241) names a pane. The surface is matched to its tmux session by
// what it shows. ps/tmux/screen are injected fixtures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const procs = require('../sessions/procs.js');

const SURF_A = 'AAAA0000-0000-0000-0000-000000000001';
const SURF_B = 'BBBB0000-0000-0000-0000-000000000002';
const PLAIN = 'CCCC0000-0000-0000-0000-000000000003';

const PS = [
  '  500     1 /Applications/cmux.app/Contents/MacOS/cmux',
  '  510   500 /usr/bin/login -flp s /bin/zsh',
  '  511   510 -zsh',
  '  512   511 /opt/homebrew/bin/tmux -S /s/default attach -t =w1',
  '  520   500 /usr/bin/login -flp s /bin/zsh',
  '  521   520 -zsh',
  '  522   521 /opt/homebrew/bin/tmux -S /s/default attach -t =w2',
  '  100     1 /opt/homebrew/bin/tmux -S /s/default new -d -s w1',
  '  101   100 zsh',
  '  102   101 /Users/s/.local/bin/claude -n w1',
  '  201   100 zsh',
  '  202   201 /Users/s/.local/bin/claude -n w2',
].join('\n');

const COMMON = ['────────────────────────────────', '> ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
const W1 = ['⏺ Reading sessions/procs.js for the join', '  Found clientOwners in procs', '⏺ Bash(npm test)', '  ⎿ 1879 passed', ...COMMON];
const W2 = ['⏺ The CRM attachments flow now sends as Yobo', '  Edited src/send.ts', '⏺ Bash(pnpm tsc)', '  ⎿ 0 errors', ...COMMON];

function fixture() {
  const sessions = [
    { socket: '/s/default', name: 'w1', attached: 1, epoch: 1, created: 1, surfaceId: null, clientPids: [512], panes: [{ id: '%1', pid: 101, active: true }] },
    { socket: '/s/default', name: 'w2', attached: 1, epoch: 1, created: 2, surfaceId: null, clientPids: [522], panes: [{ id: '%2', pid: 201, active: true }] },
  ];
  const snapObj = { table: procs.parsePs(PS), sessions };
  const reads = [];
  const caps = [];
  const screens = { [SURF_A]: W1, [SURF_B]: W2, [PLAIN]: ['s@mac ~ % ls', 'Desktop Documents', 's@mac ~ %'] };
  const deps = {
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'p41-d264-')),
    procSnapshot: async () => snapObj,
    // The env-less clients: TAB/WORKSPACE only (as on the mini after the restart).
    psEnv: async () => ' 512 /opt/homebrew/bin/tmux attach -t =w1 CMUX_TAB_ID=X CMUX_WORKSPACE_ID=X\n 522 /opt/homebrew/bin/tmux attach -t =w2 CMUX_TAB_ID=X CMUX_WORKSPACE_ID=X',
    tmuxAt: async (socket, args) => { caps.push(args[args.length - 1]); return (args[args.length - 1] === '%1' ? W1 : W2).join('\n'); },
    surfaceLines: async (id) => { reads.push(id); return screens[id] || null; },
  };
  return { deps, reads, caps, snapObj };
}

test('D264 a tmux client with no CMUX_SURFACE_ID is matched to its cmux surface by screen', async () => {
  procs.resetScreenCache();
  const { deps } = fixture();
  const a = await procs.agentFor({ id: SURF_A }, deps);
  assert.strictEqual(a && a.kind, 'claude');
  assert.strictEqual(a.pid, 102);
  const b = await procs.agentFor({ id: SURF_B }, deps);
  assert.strictEqual(b && b.pid, 202);
});

test('D264 a plain shell surface stays a terminal and is not re-read while nothing changes', async () => {
  procs.resetScreenCache();
  const { deps, reads } = fixture();
  assert.strictEqual(await procs.agentFor({ id: PLAIN }, deps), null);
  assert.strictEqual(await procs.agentFor({ id: PLAIN }, deps), null);
  assert.deepStrictEqual(reads, [PLAIN], 'one screen read, then the miss is remembered');
});

test('D264 a match is remembered: no second screen read while the client stays attached; the name and key target follow', async () => {
  procs.resetScreenCache();
  const { deps, reads, snapObj } = fixture();
  await procs.agentFor({ id: SURF_A }, deps);
  await procs.agentFor({ id: SURF_A }, deps);
  assert.deepStrictEqual(reads, [SURF_A]);
  assert.strictEqual(procs.tmuxNameFor(snapObj, { id: SURF_A }), 'w1');
  const t = await procs.tmuxKeyTargetFor(SURF_A, { procSnapshot: async () => snapObj });
  assert.deepStrictEqual(t, { socket: '/s/default', pane: '%1', session: 'w1' });
});

test('D264 lines common to every session (borders, footer) never decide a match', () => {
  assert.strictEqual(procs.matchScreen(COMMON, [W1, W2]), -1);
  assert.strictEqual(procs.matchScreen(W1, [W1, W2]), 0);
  assert.strictEqual(procs.matchScreen(W2, [W1, W2]), 1);
  assert.strictEqual(procs.matchScreen([...W1, ...W2], [W1, W2]), -1, 'a screen showing both is ambiguous');
});

test('D264 a client WITH a surface id keeps the D241 path; no screen is read', async () => {
  procs.resetScreenCache();
  const { deps, reads } = fixture();
  deps.psEnv = async () => ` 512 /opt/homebrew/bin/tmux attach -t =w1 CMUX_SURFACE_ID=${SURF_A}\n 522 /opt/homebrew/bin/tmux attach -t =w2 CMUX_SURFACE_ID=${SURF_B}`;
  const a = await procs.agentFor({ id: SURF_A }, deps);
  assert.strictEqual(a && a.pid, 102);
  assert.deepStrictEqual(reads, []);
});

test('D264 no surfaceLines dependency (tmux backend, tests) = old behaviour', async () => {
  procs.resetScreenCache();
  const { deps } = fixture();
  delete deps.surfaceLines;
  assert.strictEqual(await procs.agentFor({ id: SURF_A }, deps), null);
});

test('D264 gridLines places positioned spans by column (cmux row_spans and bridge spans)', () => {
  const g = { row_spans: [{ row: 0, column: 2, text: 'b' }, { row: 0, column: 0, text: 'a' }, { row: 1, column: 0, text: 'xy' }] };
  assert.deepStrictEqual(procs.gridLines(g), ['a b', 'xy']);
  assert.deepStrictEqual(procs.gridLines({ spans: [{ row: 3, column: 0, text: 'z' }] }), ['z']);
});
