'use strict';
// p41 D287 — a Claude Code "Code Mode" pilot build (program under ~/.local/share/claude/pilot/<version>)
// is a claude session flagged codeMode; the normal claude binary is not. Detection reads argv only.
const test = require('node:test');
const assert = require('node:assert');

const { detectKind, foregroundCommand, kindOfCommand, isCodeMode } = require('../sessions/detect.js');

const PILOT = '/Users/u/.local/share/claude/pilot/2.1.329 --settings /tmp/h.json -n w1';
const NORMAL = '/Users/u/.local/bin/claude --resume';

test('pilot build path is claude and code mode', () => {
  assert.strictEqual(kindOfCommand(PILOT), 'claude');
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: PILOT }), 'claude');
  assert.strictEqual(isCodeMode(PILOT), true);
  assert.strictEqual(isCodeMode('node /Users/u/.local/share/claude/pilot/cli.js'), true);
});

test('normal claude, shells and look-alike arguments are not code mode', () => {
  assert.strictEqual(isCodeMode(NORMAL), false);
  assert.strictEqual(isCodeMode('claude'), false);
  assert.strictEqual(isCodeMode('vim /Users/u/.local/share/claude/pilot/notes.md'), false);
  assert.strictEqual(isCodeMode(null), false);
  assert.strictEqual(isCodeMode(''), false);
});

test('fake ps -t output: pilot in the foreground group is found and flagged', async () => {
  const ps = async () => `Ss   -zsh\nS+   ${PILOT}\nS+   uv run mcp-server\n`;
  const fg = await foregroundCommand({ id: 'S1', tty: 'ttys004' }, 'cmux', { ps });
  assert.strictEqual(fg, PILOT);
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: fg }), 'claude');
  assert.strictEqual(isCodeMode(fg), true);
});

test('fake ps -t output: ~/.local/bin/claude is claude without code mode', async () => {
  const ps = async () => `Ss   -zsh\nS+   ${NORMAL}\n`;
  const fg = await foregroundCommand({ id: 'S1', tty: 'ttys004' }, 'cmux', { ps });
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: fg }), 'claude');
  assert.strictEqual(isCodeMode(fg), false);
});

test('CODE_MODE_BIN_RE overrides the pattern; an invalid one falls back to the default', () => {
  const prev = process.env.CODE_MODE_BIN_RE;
  try {
    process.env.CODE_MODE_BIN_RE = '/opt/cc-codemode/';
    assert.strictEqual(isCodeMode('/opt/cc-codemode/bin/run'), true);
    assert.strictEqual(isCodeMode(PILOT), false);
    process.env.CODE_MODE_BIN_RE = '(';
    assert.strictEqual(isCodeMode(PILOT), true);
  } finally {
    if (prev === undefined) delete process.env.CODE_MODE_BIN_RE; else process.env.CODE_MODE_BIN_RE = prev;
  }
});

// Session row: the bridge's /sessions list carries codeMode only for a pilot build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionRoutes } = require('../sessions/routes.js');
const { parsePs } = require('../sessions/procs.js');

function rowFor(args) {
  const r = createSessionRoutes({
    machineId: 'mini', backend: 'cmux', home: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd287-'))), listSnapshotMs: 0,
    // a tmux-hosted pane: shell 300 -> claude 301 (the procs.js process-tree walk, argv only)
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:t', ref: '%7', title: 'x-w', type: 'terminal', tmuxPane: '%7', tmuxSocket: '/s' }] }],
    procSnapshot: async () => ({ table: parsePs(`300 1 -zsh\n301 300 ${args}\n`),
      sessions: [{ socket: '/s', name: 'x-w', panes: [{ id: '%7', pid: 300, active: true }] }] }),
    readEvents: async () => ({ events: [], more: false }),
  });
  return new Promise((resolve) => {
    let code = 0;
    r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve(code === 200 ? JSON.parse(b).sessions[0] : { code }) }, new URL('http://x/cmux/sessions'));
  });
}

test('session row: pilot build -> codeMode true; ~/.local/bin/claude -> field absent', async () => {
  const pilot = await rowFor(PILOT);
  assert.strictEqual(pilot.kind, 'claude');
  assert.strictEqual(pilot.codeMode, true);
  const normal = await rowFor(NORMAL);
  assert.strictEqual(normal.kind, 'claude');
  assert.ok(!('codeMode' in normal));
});
