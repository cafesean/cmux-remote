'use strict';
// p41 D262 — other agent CLIs (pi, gemini, hermes…) in a pane: the session stays kind 'terminal' (the terminal
// view is their chat) and carries `harness` so the app can name it. Claude/codex still win; `vim pi.md` is no harness.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harnessOf, detectKind, kindOfCommand } = require('../sessions/detect');
const procs = require('../sessions/procs');

test('harnessOf: program name, interpreter script, npm package; not an argument', () => {
  assert.equal(harnessOf('node /Users/s/Library/pnpm/pi --model sonnet'), 'pi');
  assert.equal(harnessOf('/opt/homebrew/bin/gemini'), 'gemini');
  assert.equal(harnessOf('node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js'), 'gemini');
  assert.equal(harnessOf('node /x/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'), 'pi');
  assert.equal(harnessOf('python3 /Users/s/.local/bin/hermes chat'), 'hermes');
  assert.equal(harnessOf('cursor-agent'), 'cursor');
  assert.equal(harnessOf('vim pi.md'), null);
  assert.equal(harnessOf('zsh'), null);
  assert.equal(harnessOf('node server.js --gemini'), null);
  assert.equal(harnessOf(null), null);
  assert.equal(detectKind({ foregroundCmd: 'node /Users/s/Library/pnpm/pi' }), 'terminal');
  assert.equal(kindOfCommand('/opt/homebrew/bin/claude'), 'claude');
});

const PS = [
  '  100     1 /opt/homebrew/bin/tmux -u -D',
  '  200   100 -zsh',
  '  201   200 node /Users/s/Library/pnpm/pi',
  '  300   100 -zsh',
  '  301   300 /opt/homebrew/bin/claude -n x',
  '  302   301 node /Users/s/Library/pnpm/pi',
  '  400   100 zsh',
].join('\n');

test('agentFor: pi under the pane -> {kind terminal, harness pi}; claude above pi stays claude; plain shell null', async () => {
  const table = procs.parsePs(PS);
  const snap = async () => ({ table, sessions: [] });
  const a = await procs.agentFor({ id: 'U-PI', pid: 200 }, { home: '/nonexistent', procSnapshot: snap });
  assert.deepEqual([a.kind, a.harness, a.pid], ['terminal', 'pi', 201]);
  const c = await procs.agentFor({ id: 'U-CL', pid: 300 }, { home: '/nonexistent', procSnapshot: snap });
  assert.equal(c.kind, 'claude');
  assert.equal(await procs.agentFor({ id: 'U-SH', pid: 400 }, { home: '/nonexistent', procSnapshot: snap }), null);
  assert.equal(procs.findAgent(table, 200), null, 'findAgent (tmux-close, transcripts) still sees claude/codex only');
});
