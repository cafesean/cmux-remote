'use strict';
// p41 BUG1 — claude found through tmux and wrapper processes, its transcript joined from the live
// process, and tmux sessions no cmux pane shows still listed. ps/tmux/fs are injected fixtures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const procs = require('../sessions/procs.js');
const { transcriptFor } = require('../sessions/join.js');
const { foregroundCommand, detectKind } = require('../sessions/detect.js');

const SOCK = '/s/tmux-501/default';
const SURF = '9FE4C843-DE93-46A9-A8D8-C98B0255429D';
const PS = [
  '  100     1 /opt/homebrew/bin/tmux -u -D',
  '12281   100 zsh -c bash /h/launch/x-cmux-native-2.sh; exec /bin/zsh -l',
  '12282 12281 /Users/s/.local/bin/claude --settings x.json -n x-cmux-native-2 --model opus',
  '12290 12282 uv run mcp',
  '70405   100 zsh -c bash /h/launch/x-chief.sh',
  '70406 70405 /Users/s/.local/bin/claude -n x-chief',
  '35931     1 -/bin/zsh',
  '80000 35931 /Users/s/.local/share/uv/tools/claude-swap/bin/python3 /Users/s/.local/bin/cswap',
  '80001 80000 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  '90000   100 zsh',
].join('\n');
const PANES = [
  ['x-cmux-native-2', '%53', '12281', '1', '1', '1', '1793000000', '/w', '1793000100'],
  ['x-chief', '%48', '70405', '1', '1', '0', '1793000000', '/m', '1793000050'],
  ['plain', '%60', '90000', '1', '1', '0', '1793000000', '/m', '1793000060'],
].map((r) => r.join('|^|')).join('\n');
const ENV = { 'x-cmux-native-2': SURF, 'x-chief': '29B341AB-0000-0000-0000-000000000000', plain: null };

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-procs-'));
  const write = (pid, sessionId, cwd) => {
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd }));
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
    return fs.realpathSync(path.join(dir, `${sessionId}.jsonl`));
  };
  const tmuxAt = async (sock, args) => {
    assert.strictEqual(sock, SOCK);
    if (args[0] === 'list-panes') return PANES + '\n';
    if (args[0] === 'show-environment') { const v = ENV[args[2].slice(1)]; return v ? `CMUX_SURFACE_ID=${v}\n` : '-CMUX_SURFACE_ID\n'; }
    throw new Error('unexpected ' + args[0]);
  };
  const snap = () => procs.snapshot({ psAll: async () => PS, tmuxAt, tmuxSockets: [SOCK] });
  const d = { home, procSnapshot: snap, readEvents: async () => ({ events: [] }), cwdFor: async () => null };
  d.agentFor = (s) => procs.agentFor(s, { home, procSnapshot: snap });
  return { home, write, d };
}

test('tmux-wrapped claude: cmux surface -> tmux session env -> pane -> claude, kind claude + transcript joined', async () => {
  const { write, d } = fixture();
  const p = write(12282, 'sess-native-2', '/Volumes/HD/code/ai');
  const fg = await foregroundCommand({ id: SURF }, 'cmux', d);
  const j = await transcriptFor({ id: SURF }, d);
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: fg, transcriptPath: j && j.path }), 'claude');
  assert.deepStrictEqual(j, { kind: 'claude', path: p, sessionId: 'sess-native-2' });
});

test('cswap-wrapped claude: claude is a child of the wrapper, found by the descendant search', async () => {
  const { write, home } = fixture();
  const p = write(80001, 'sess-chief', '/Users/s/Main');
  const table = procs.parsePs(PS);
  const snap = async () => ({ table, sessions: [] });
  const a = await procs.agentFor({ id: 'U-CHIEF', pid: 35931 }, { home, procSnapshot: snap });
  assert.strictEqual(a.kind, 'claude');
  assert.strictEqual(a.pid, 80001);
  assert.strictEqual(fs.realpathSync(a.transcriptPath), p);
  assert.strictEqual(procs.findAgent(table, 90000), null);   // a plain shell stays a terminal
});

test('missing-session case: a detached tmux session running claude is listed; shells and shown sessions are not', async () => {
  const { write, d } = fixture();
  const p = write(70406, 'sess-chief-1103', '/Users/s/Main');
  const tabs = await procs.orphanTmuxTabs(new Set([SURF]), d);
  assert.deepStrictEqual(tabs.map((t) => t.title), ['x-chief']);
  assert.strictEqual(tabs[0].tmuxPane, '%48');
  const j = await transcriptFor({ id: tabs[0].tmuxPane, socket: tabs[0].tmuxSocket }, d);
  assert.strictEqual(j.path, p);
});

test('stale sessions file (pid mismatch) and bounded depth are refused', async () => {
  const { home } = fixture();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '5.json'), JSON.stringify({ pid: 6, sessionId: 'x', cwd: '/a' }));
  assert.strictEqual(await procs.claudeTranscriptOf(5, { home }), null);
  const rows = []; for (let i = 1; i <= procs.LIMITS.procTreeDepth + 2; i++) rows.push(`${i + 1} ${i} sh`);
  rows.push(`${procs.LIMITS.procTreeDepth + 4} ${procs.LIMITS.procTreeDepth + 3} claude`);
  assert.strictEqual(procs.findAgent(procs.parsePs(rows.join('\n')), 1), null);
});

test('two tmux sessions naming one surface: the attached one owns it; the other is listed once as an orphan', async () => {
  const table = procs.parsePs(PS);
  const sessions = [
    { socket: SOCK, name: 'old', attached: 0, created: 5, epoch: 1, surfaceId: SURF, panes: [{ id: '%48', pid: 70405, active: true }] },
    { socket: SOCK, name: 'new', attached: 1, created: 3, epoch: 1, surfaceId: SURF, panes: [{ id: '%53', pid: 12281, active: true }] },
  ];
  const snap = async () => ({ table, sessions });
  const a = await procs.agentFor({ id: SURF }, { home: os.tmpdir(), procSnapshot: snap });
  assert.strictEqual(a.pid, 12282);
  const tabs = await procs.orphanTmuxTabs(new Set([SURF]), { procSnapshot: snap });
  assert.deepStrictEqual(tabs.map((t) => t.title), ['old']);
  // neither attached: newest owns it, the older one is the orphan
  sessions[1].attached = 0;
  assert.strictEqual(procs.ownerOf(sessions, SURF).name, 'old');
  assert.deepStrictEqual((await procs.orphanTmuxTabs(new Set([SURF]), { procSnapshot: snap })).map((t) => t.title), ['new']);
});

test('/clear: a fresher hook-event transcript beats the live sessions file (newest mtime wins)', async () => {
  const { write, d, home } = fixture();
  const oldP = write(12282, 'sess-before-clear', '/Volumes/HD/code/ai');
  const newP = path.join(home, '.claude', 'projects', '-Volumes-HD-code-ai', 'sess-after-clear.jsonl');
  fs.writeFileSync(newP, '{}\n');
  const t = Date.now() / 1000;
  fs.utimesSync(oldP, t - 60, t - 60);
  fs.utimesSync(newP, t, t);
  d.readEvents = async () => ({ events: [{ ts: Date.now(), sessionId: 'sess-after-clear', event: 'SessionStart', surfaceId: SURF, transcriptPath: newP }] });
  d.now = () => Date.now();
  assert.deepStrictEqual(await transcriptFor({ id: SURF }, d), { kind: 'claude', path: fs.realpathSync(newP), sessionId: 'sess-after-clear' });
  // and the other way: the sessions file is fresher than a stale event (tmux reattach case)
  fs.utimesSync(newP, t - 120, t - 120);
  assert.strictEqual((await transcriptFor({ id: SURF }, d)).path, oldP);
});

test('tmuxSend: text pasted, Enter after; key mapped; tmux target from a minted id', async () => {
  const calls = [];
  const tmuxRun = async (sock, args, input) => { calls.push([args[0], input || null, args.includes('Enter') ? 'Enter' : null]); return { code: 0 }; };
  assert.deepStrictEqual(await procs.tmuxSend({ socket: SOCK, pane: '%48' }, { text: 'hi', submit: true }, { tmuxRun, settleMs: 0 }), { ok: true });
  assert.deepStrictEqual(calls, [['load-buffer', 'hi', null], ['send-keys', null, 'Enter']]);
  assert.deepStrictEqual(await procs.tmuxSend({ socket: SOCK, pane: '%48' }, { press: 'nope' }, { tmuxRun }), { error: 'bad_key' });
  const { d } = fixture();
  const tabs = await procs.orphanTmuxTabs(new Set([SURF]), d);
  assert.deepStrictEqual(await procs.tmuxTargetFor(tabs[0].id, d), { socket: SOCK, pane: '%48', session: 'x-chief' });
  assert.strictEqual(await procs.tmuxTargetFor(SURF, d), null);
});

test('D140 tmuxKeyTargetFor: a cmux pane ATTACHED to a tmux session gets that session\'s active pane (keys go via tmux send-keys, never split into a lone Esc)', async () => {
  const { d } = fixture();
  assert.deepStrictEqual(await procs.tmuxKeyTargetFor(SURF, d), { socket: SOCK, pane: '%53', session: 'x-cmux-native-2' });
  assert.strictEqual(await procs.tmuxKeyTargetFor('29B341AB-0000-0000-0000-000000000000', d), null);   // x-chief: detached, not shown by that surface
  assert.strictEqual(await procs.tmuxKeyTargetFor('00000000-0000-0000-0000-000000000001', d), null);   // a plain cmux terminal
  const tabs = await procs.orphanTmuxTabs(new Set([SURF]), d);
  assert.deepStrictEqual(await procs.tmuxKeyTargetFor(tabs[0].id, d), { socket: SOCK, pane: '%48', session: 'x-chief' });   // minted id: as before
});

test('D163 tmuxSend: a long single line (or multi-line) is ONE bracketed paste; short text stays plain typing', async () => {
  const seen = [];
  const tmuxRun = async (sock, args, input) => { if (args[0] === 'load-buffer') seen.push([input, args.includes('-p')]); return { code: 0 }; };
  const long = 'Couple issues I\'ve found when you\'re deleting or closing panes from the app while busy';
  await procs.tmuxSend({ socket: SOCK, pane: '%48' }, { text: long }, { tmuxRun });
  await procs.tmuxSend({ socket: SOCK, pane: '%48' }, { text: 'a\nb' }, { tmuxRun });
  await procs.tmuxSend({ socket: SOCK, pane: '%48' }, { text: '/clear' }, { tmuxRun });
  assert.deepStrictEqual(seen, [[long, true], ['a\nb', true], ['/clear', false]]);
});

test('D238 direct cmux pane: claude started straight in the pane (no tmux, tty null) -> kind claude + transcript via its CMUX_SURFACE_ID', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-d238-'));
  const write = (pid, sessionId, cwd) => {
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd }));
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
  };
  const DIRECT = '627B9A7E-33D2-47BE-8D57-219D3B2268A4';
  const STALE = 'AAAAAAAA-0000-0000-0000-000000000001';
  const ps = [
    '  500     1 /Applications/cmux.app/Contents/MacOS/cmux',
    ' 1300   500 /usr/bin/login -flp seanliao /bin/zsh',
    ' 1374  1300 -zsh',
    ' 1375  1374 /Users/s/.local/bin/claude --settings chief.json -n m-chief',
    ' 1376  1375 /Users/s/.local/bin/claude --print sub',          // a child agent: never its own pane
    '  100     1 /opt/homebrew/bin/tmux -u -D',
    ' 2001   100 zsh',
    ' 2002  2001 /Users/s/.local/bin/claude -n worker',              // tmux-hosted: env surface is stale
    ' 1400  1300 -zsh',                                              // a plain shell pane
  ].join('\n');
  const envCalls = [];
  const psEnv = async (pids) => {
    envCalls.push(pids.slice().sort());
    return [
      ` 1375 /Users/s/.local/bin/claude --settings chief.json -n m-chief PATH=/bin CMUX_SURFACE_ID=${DIRECT} SECRET_X=1`,
      ` 2002 /Users/s/.local/bin/claude -n worker CMUX_SURFACE_ID=${STALE}`,
    ].join('\n');
  };
  const snapObj = { table: procs.parsePs(ps), sessions: [] };
  const deps = { home, procSnapshot: async () => snapObj, psEnv };
  write(1375, 'sess-chief-now', '/Volumes/General/s/Main');

  const a = await procs.agentFor({ id: DIRECT }, deps);
  assert.strictEqual(a.kind, 'claude');
  assert.strictEqual(a.pid, 1375);
  assert.strictEqual(a.sessionId, 'sess-chief-now');
  assert.deepStrictEqual(envCalls, [[1375]], 'only the top-level agent under the cmux app is read (not the child, not tmux)');

  const fg = await foregroundCommand({ id: DIRECT, type: 'terminal', tty: null }, 'cmux',
    { agentFor: (s) => procs.agentFor(s, deps), readEvents: async () => ({ events: [] }) });
  assert.strictEqual(detectKind({ surfaceType: 'terminal', foregroundCmd: fg, transcriptPath: null }), 'claude');

  assert.strictEqual(await procs.agentFor({ id: STALE }, deps), null, 'a tmux-hosted agent never claims a surface by its stale env');
  assert.strictEqual(await procs.agentFor({ id: 'BBBBBBBB-0000-0000-0000-000000000002' }, deps), null, 'a plain shell pane stays a terminal');
  assert.strictEqual(envCalls.length, 1, 'one env read per snapshot');
});
