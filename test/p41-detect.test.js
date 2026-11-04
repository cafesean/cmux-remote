'use strict';
// p41 A1 — which kind a pane shows as (claude chat, codex chat, terminal, browser). ps, tmux and the
// hook-event log are injected, so no test touches the real process table.
const test = require('node:test');
const assert = require('node:assert');

const { detectKind, foregroundCommand } = require('../sessions/detect.js');

test('browser surface is a browser whatever else is known', () => {
  assert.strictEqual(detectKind({ surfaceType: 'browser', foregroundCmd: 'claude' }), 'browser');
  assert.strictEqual(detectKind({ surfaceType: 'browser' }), 'browser');
});

test('claude in the foreground is claude', () => {
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'claude' }), 'claude');
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: '/Users/s/.local/bin/claude --resume' }), 'claude');
});

test('node running the claude cli (comm=node, args name claude) is claude', () => {
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'node /opt/homebrew/bin/claude --model opus' }), 'claude');
  assert.strictEqual(detectKind({ surfaceType: 'terminal',
    foregroundCmd: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' }), 'claude');
});

test('codex, bare or under node, is codex', () => {
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'codex' }), 'codex');
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'node /opt/homebrew/bin/codex exec' }), 'codex');
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'node /x/@openai/codex/bin/codex.js' }), 'codex');
});

test('shells, editors and look-alikes are terminal', () => {
  for (const cmd of ['zsh', '-zsh', 'vim notes.md', 'vim claude.md', 'node server.js --claude', 'node /p/claude-dashboard/index.js', 'tail -f codex.log']) {
    assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: cmd }), 'terminal', cmd);
  }
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: null }), 'terminal');
  assert.strictEqual(detectKind({}), 'terminal');
});

test('claude with no transcript yet is still claude', () => {
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'claude', transcriptPath: null }), 'claude');
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'claude' }), 'claude');
});

test('transcript path only decides when the foreground command is unknown', () => {
  const claudeT = '/Users/s/.claude/projects/-x/abc.jsonl';
  const codexT = '/Users/s/.codex/sessions/2026/11/04/rollout-1.jsonl';
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: null, transcriptPath: claudeT }), 'claude');
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: null, transcriptPath: codexT }), 'codex');
  // a shell is in front now: the old transcript is history, not a live agent
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: 'zsh', transcriptPath: claudeT }), 'terminal');
});

// ---- foregroundCommand -------------------------------------------------------------------------

const psOut = (rows) => async () => rows.join('\n') + '\n';

test('cmux: tty from the tree, foreground process group only', async () => {
  const calls = [];
  const ps = async (args) => { calls.push(args); return [
    'Ss   -zsh',
    'S+   node /opt/homebrew/bin/claude --resume',
  ].join('\n') + '\n'; };
  const cmd = await foregroundCommand({ id: 'U1', ref: 'surface:12', type: 'terminal', tty: '/dev/ttys004' }, 'cmux', { ps });
  assert.strictEqual(cmd, 'node /opt/homebrew/bin/claude --resume');
  assert.deepStrictEqual(calls, [['-t', 'ttys004', '-o', 'stat=,args=']]);
});

test('cmux: shell only in the foreground returns the shell', async () => {
  const cmd = await foregroundCommand({ ref: 'surface:1', tty: 'ttys001' }, 'cmux', { ps: psOut(['Ss+  -zsh']) });
  assert.strictEqual(cmd, '-zsh');
});

test('cmux: no tty -> falls back to the hook events (live claude session on that surface)', async () => {
  const events = [
    { ts: 1, sessionId: 's1', event: 'SessionStart', surfaceId: 'surface:12' },
    { ts: 2, sessionId: 's1', event: 'Stop', surfaceId: 'surface:12' },
    { ts: 3, sessionId: 's2', event: 'Stop', surfaceId: 'surface:99' },
  ];
  const readEvents = async () => ({ events });
  const ps = async () => { throw new Error('ps must not run without a tty'); };
  assert.strictEqual(await foregroundCommand({ id: 'U12', ref: 'surface:12', tty: null }, 'cmux', { ps, readEvents, now: () => 10 }), 'claude');
  assert.strictEqual(await foregroundCommand({ id: 'U7', ref: 'surface:7', tty: null }, 'cmux', { ps, readEvents, now: () => 10 }), null);
});

test('cmux: events match by uuid too, and a SessionEnd means claude is gone', async () => {
  const ps = async () => { throw new Error('no ps'); };
  const live = async () => ({ events: [{ ts: 2, sessionId: 's', event: 'Stop', surfaceId: 'U12' }] });
  const ended = async () => ({ events: [
    { ts: 2, sessionId: 's', event: 'Stop', surfaceId: 'U12' }, { ts: 3, sessionId: 's', event: 'SessionEnd', surfaceId: 'U12' }] });
  const s = { id: 'U12', ref: 'surface:12', tty: null };
  assert.strictEqual(await foregroundCommand(s, 'cmux', { ps, readEvents: live, now: () => 10 }), 'claude');
  assert.strictEqual(await foregroundCommand(s, 'cmux', { ps, readEvents: ended, now: () => 10 }), null);
});

test('cmux: events older than the retention window are ignored', async () => {
  const readEvents = async () => ({ events: [{ ts: 1, sessionId: 's', event: 'Stop', surfaceId: 'surface:12' }] });
  const cmd = await foregroundCommand({ ref: 'surface:12', tty: null }, 'cmux',
    { ps: async () => '', readEvents, now: () => 1 + 49 * 3600 * 1000 });
  assert.strictEqual(cmd, null);
});

test('cmux: ps failing or empty -> null, never throws', async () => {
  const s = { ref: 'surface:1', tty: 'ttys001' };
  assert.strictEqual(await foregroundCommand(s, 'cmux', { ps: async () => { throw new Error('boom'); } }), null);
  assert.strictEqual(await foregroundCommand(s, 'cmux', { ps: async () => '' }), null);
});

test('tmux: plain command is pane_current_command', async () => {
  const calls = [];
  const tmux = async (args) => { calls.push(args); return 'zsh\x1f/dev/ttys009\n'; };
  const cmd = await foregroundCommand({ id: '%3' }, 'tmux', { tmux, ps: async () => { throw new Error('no ps'); } });
  assert.strictEqual(cmd, 'zsh');
  assert.deepStrictEqual(calls, [['display-message', '-p', '-t', '%3', '#{pane_current_command}\x1f#{pane_tty}']]);
});

test('tmux: a runtime command (node) is widened with ps args on the pane tty', async () => {
  const tmux = async () => 'node\x1f/dev/ttys009\n';
  const ps = async (args) => { assert.deepStrictEqual(args.slice(0, 2), ['-t', 'ttys009']); return 'S+   node /opt/homebrew/bin/codex\n'; };
  assert.strictEqual(await foregroundCommand({ id: '%3' }, 'tmux', { tmux, ps }), 'node /opt/homebrew/bin/codex');
});

test('tmux: node with ps unavailable stays "node"; tmux failing -> null', async () => {
  const tmux = async () => 'node\x1f/dev/ttys009\n';
  assert.strictEqual(await foregroundCommand({ id: '%3' }, 'tmux', { tmux, ps: async () => { throw new Error('x'); } }), 'node');
  assert.strictEqual(await foregroundCommand({ id: '%3' }, 'tmux', { tmux: async () => { throw new Error('no server'); } }), null);
});

test('unknown backend throws', async () => {
  await assert.rejects(() => foregroundCommand({ id: 'x' }, 'screen', {}), /backend/);
});
