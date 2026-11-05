'use strict';
// p41 A11 — sessions survive a Claude account swap: stable id, title priority, swap transcript roots, dedupe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pickTitle, isVolatileTitle } = require('../sessions/titles.js');
const { transcriptFor, isAllowedTranscriptPath } = require('../sessions/join.js');
const { detectKind } = require('../sessions/detect.js');
const procs = require('../sessions/procs.js');
const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a11-')));
const row = (n, t) => JSON.stringify({ type: 'user', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: new Date(1e12 + n).toISOString(), message: { role: 'user', content: t } }) + '\n';

test('title priority: custom > tmux name > workspace+ref > non-volatile tab title', () => {
  const o = { workspaceTitle: 'CHIEF', surfaceRef: 'surface:235', tabTitle: 'cswap' };
  assert.equal(pickTitle({ ...o, customTitle: 'My chat', tmuxName: 'x-cmux-native-3' }), 'My chat');
  assert.equal(pickTitle({ ...o, tmuxName: 'x-cmux-native-3' }), 'x-cmux-native-3');
  assert.equal(pickTitle(o), 'CHIEF surface:235');
  assert.equal(pickTitle({ surfaceRef: 'surface:235', tabTitle: 'cswap' }), 'surface:235');
  assert.equal(pickTitle({ surfaceRef: 's', tabTitle: 'deploy notes' }), 'deploy notes');
  assert.equal(pickTitle({ ...o, tabTitle: 'vim x', preferTab: true }), 'vim x');
  assert.equal(pickTitle({ ...o, tmuxName: '0' }), 'CHIEF surface:235');
});

test('volatile titles are denylisted', () => {
  for (const t of ['cswap', 'claude', 'node', 'python3.13', 'zsh', 'bash', 'sh', 'fish', 'tmux', 'sean@mini:~/code', '']) assert.ok(isVolatileTitle(t), t);
  assert.ok(!isVolatileTitle('release plan'));
});

test('swap session root: transcript found, allowed; a path outside known roots is rejected', async () => {
  const home = mk();
  const dir = path.join(home, '.claude-swap-backup', 'sessions', '2-a-example-com', 'projects', '-work-x');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sw1.jsonl');
  fs.writeFileSync(f, row(1, 'hi'));
  assert.ok(await isAllowedTranscriptPath(f, { home }));
  const j = await transcriptFor({ id: 'S1' }, { home, now: () => Date.now(), readEvents: async () => ({ events: [], more: false }), cwdFor: async () => '/work/x' });
  assert.equal(j.sessionId, 'sw1');
  assert.equal(j.path, f);
  const other = path.join(home, '.claude-swap-backup', 'elsewhere', 'a.jsonl');
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '');
  const sibling = path.join(home, '.claude-swap-backup', 'sessions', '2-a', 'notprojects', 'a.jsonl');
  fs.mkdirSync(path.dirname(sibling), { recursive: true }); fs.writeFileSync(sibling, '');
  assert.equal(await isAllowedTranscriptPath(other, { home }), false);
  assert.equal(await isAllowedTranscriptPath(sibling, { home }), false);
  assert.equal(await isAllowedTranscriptPath('/etc/passwd.jsonl', { home }), false);
});

test('kind is claude from a swap transcript path and for a cswap wrapper with a claude child', () => {
  assert.equal(detectKind({ transcriptPath: '/h/.claude-swap-backup/sessions/2-a/projects/-w/s.jsonl' }), 'claude');
  assert.equal(detectKind({ foregroundCmd: 'claude --model opus', transcriptPath: null }), 'claude');
  const table = procs.parsePs([' 100 1 /bin/zsh', ' 101 100 /Users/s/.local/share/uv/tools/claude-swap/bin/python3 /Users/s/.local/bin/cswap run 2', ' 102 101 claude --resume'].join('\n'));
  const a = procs.findAgent(table, 100);
  assert.equal(a.kind, 'claude');
});

async function list(r) {
  return new Promise((resolve) => {
    const res = { writeHead() {}, end: (b) => resolve(JSON.parse(b)) };
    r.handle({ method: 'GET', headers: {} }, res, new URL('http://x/cmux/sessions'));
  });
}

test('session id is unchanged when tab title and transcript root change', async () => {
  const home = mk();
  const out = [];
  for (const [title, root] of [['cswap', '.claude'], ['claude', '.claude-swap-backup/sessions/2-a/']]) {
    const dir = path.join(home, ...root.split('/').filter(Boolean), 'projects', '-w');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'sA.jsonl'); fs.writeFileSync(f, row(1, 'hello'));
    const eventlog = [{ ts: Date.now() - 1000, sessionId: 'sA', event: 'Stop', transcriptPath: f, surfaceId: 'surface:235', cwd: '/w' }];
    const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home,
      loadTree: async () => [{ ref: 'workspace:1', title: 'CHIEF', tabs: [{ id: 'surface:235', ref: 'surface:235', title, type: 'terminal' }] }],
      readEvents: async () => ({ events: eventlog, more: false }), procSnapshot: async () => ({ table: [], sessions: [] }) });
    const l = await list(r);
    out.push(l.sessions[0]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(out[0].id, 'mini:surface:235');
  assert.equal(out[1].id, out[0].id);
  assert.equal(out[0].kind, 'claude');
  for (const s of out) assert.ok(!/cswap|claude$/i.test(s.title) || s.title.startsWith('CHIEF'), s.title);
});

test('dedupe: one tmux session + one cmux surface attached to it + same transcript -> one row (the cmux surface)', async () => {
  const home = mk();
  const dir = path.join(home, '.claude', 'projects', '-w');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sChief.jsonl'); fs.writeFileSync(f, row(1, 'hello'));
  const eventlog = [{ ts: Date.now() - 1000, sessionId: 'sChief', event: 'Stop', transcriptPath: f, surfaceId: 'surface:264', cwd: '/w' },
    { ts: Date.now() - 900, sessionId: 'sChief', event: 'Stop', transcriptPath: f, surfaceId: '%7', cwd: '/w' }];
  const snap = { table: [], sessions: [{ socket: '/s', name: 'x-chief-1103', attached: 1, epoch: 1, created: 1, surfaceId: 'surface:264', panes: [{ id: '%7', pid: 5, active: true, cwd: '/w' }] }] };
  const orphan = { id: 'surface:orphan', ref: '%7', title: 'x-chief-1103', type: 'terminal', tmuxPane: '%7', tmuxSocket: '/s' };
  const r2 = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home,
    loadTree: async () => [{ ref: 'workspace:1', title: 'CHIEF', tabs: [{ id: 'surface:264', ref: 'surface:264', title: 'tmux', type: 'terminal' }, orphan] }],
    readEvents: async () => ({ events: eventlog, more: false }), procSnapshot: async () => snap });
  const l = await list(r2);
  assert.equal(l.sessions.length, 1);
  assert.equal(l.sessions[0].surface, 'surface:264');
  assert.equal(l.sessions[0].title, 'x-chief-1103');
  assert.equal(l.sessions[0].reach, 'cmux');
  assert.deepEqual(l.sessions[0].aliases, ["mini:" + orphan.id]);
});

test('orphanTmuxTabs: a tmux session a cmux surface is attached to (client tty) is never an orphan, claude or not', async () => {
  const table = procs.parsePs([' 10 1 -zsh', ' 11 10 claude --resume', ' 20 1 -zsh', ' 21 20 codex'].join('\n'));
  const mkSession = (name, pid, tty) => ({ socket: '/s', name, attached: tty ? 1 : 0, epoch: 1, created: 1, surfaceId: null, clientTtys: tty ? [tty] : [],
    panes: [{ id: name === 'c' ? '%1' : name === 'x' ? '%2' : '%3', pid, active: true, cwd: '/w' }] });
  const snap = { table, sessions: [mkSession('c', 10, 'ttys007'), mkSession('x', 20, 'ttys008'), mkSession('free', 10, null)] };
  const tabs = await procs.orphanTmuxTabs(new Set(['surface:1', 'surface:2']), { liveTtys: ['/dev/ttys007', 'ttys008'], procSnapshot: async () => snap });
  assert.deepEqual(tabs.map((t) => t.title), ['free']);   // 'c' (claude) and 'x' (codex, no join) are shown by their surfaces
});

test('stale pid file in a swap dir (written before the process began) does not bind; newest valid wins', async () => {
  const files = {
    '/h/.claude/sessions/9.json': { pid: 9, sessionId: 'new', cwd: '/w', startedAt: 2_000_000 },
    '/h/.claude-swap-backup/sessions/2-a/sessions/9.json': { pid: 9, sessionId: 'stale', cwd: '/w', startedAt: 500_000 },
  };
  const d = { home: '/h', readdir: async () => ['2-a'], readFile: async (p) => { if (!files[p]) throw new Error('ENOENT'); return JSON.stringify(files[p]); }, procStartMs: async () => 1_999_000 };
  assert.equal((await procs.claudeTranscriptOf(9, d)).sessionId, 'new');
  delete files['/h/.claude/sessions/9.json'];
  assert.equal(await procs.claudeTranscriptOf(9, d), null);   // only the stale one: refused
  files['/h/.claude-swap-backup/sessions/2-a/sessions/9.json'].startedAt = 2_000_500;
  assert.equal((await procs.claudeTranscriptOf(9, d)).sessionId, 'stale');   // valid swap-dir file binds
});
