'use strict';
// p41 D179 (HMX-67) — Claude Code option menus in a tmux-only session (a cos worker no cmux pane shows)
// become answer buttons, and a pick drives tmux keys. Fixture = a REAL capture (Claude Code 2.1.318,
// `tmux capture-pane -p -e`, session name scrubbed): a hook-confirmation permission prompt "❯ 1. Yes / 2. No".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const procs = require('../sessions/procs.js');
const tmuxIds = require('../lib/tmux-ids.js');
const menuparse = require('../public/menuparse.js');
const { createSessionRoutes } = require('../sessions/routes.js');

const ANSI = fs.readFileSync(path.join(__dirname, 'fixtures', 'tmux', 'd179-permission-2opt.ansi'), 'utf8');
// The same screen after one Down: the marker (and its colour) moved from Yes to No.
const ANSI_NO = ANSI
  .replace('\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.\x1b[39m \x1b[38;5;153mYes\x1b[39m', '  \x1b[38;5;246m1.\x1b[39m Yes')
  .replace('  \x1b[38;5;246m2.\x1b[39m No', '\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m2.\x1b[39m \x1b[38;5;153mNo\x1b[39m');
const HDR = (cy) => ['CMUXR1', '1', '48', '16', '1', String(cy), '0', '0', '0'].join('\x1f');
const fakeRun = (ansi) => async (args) => { fakeRun.calls.push(args); return `${HDR(10)}\n${ansi}`; };
fakeRun.calls = [];

test('tmuxGrid: display + capture-pane -e on the pane -> a grid menuparse reads as the live permission prompt', async () => {
  fakeRun.calls = [];
  const g = await procs.tmuxGrid({ socket: '/s', pane: '%7' }, { run: fakeRun(ANSI) });
  assert.ok(Number.isFinite(g.seq));
  const args = fakeRun.calls[0];
  assert.deepEqual(args.slice(0, 5), ['-S', '/s', 'display', '-p', '-t']);
  assert.ok(args.includes('capture-pane') && args.includes('-e'), 'read-only capture, coloured');
  assert.ok(!args.includes('send-keys'));
  const m = menuparse.menuChoice(g.grid, { tailRows: 40 });
  assert.equal(m.question, 'Do you want to proceed?');
  assert.deepEqual(m.options.map((o) => [o.label, o.send.keys]), [['Yes', ['enter']], ['No', ['down', 'enter']]]);
  const g2 = await procs.tmuxGrid({ socket: '/s', pane: '%7' }, { run: fakeRun(ANSI_NO) });
  assert.notEqual(g2.seq, g.seq, 'a changed screen is a newer frame');
  assert.equal(menuparse.parseNumberedMenu(g2.grid).markedIndex, 1);
  assert.equal(await procs.tmuxGrid({ socket: '/s', pane: 'x;rm' }, { run: fakeRun(ANSI) }), null, 'pane id validated');
  assert.equal(await procs.tmuxGrid({ socket: '/s', pane: '%7' }, { run: async () => { throw new Error('no tmux'); } }), null);
});

// A tmux-only claude session waiting on a permission prompt (Notification permission_prompt after the prompt).
function setup(frames) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd179-')));
  const dir = path.join(home, '.claude', 'projects', '-w');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sW.jsonl');
  const t = Date.now() - 5000;
  fs.writeFileSync(f, JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date(t).toISOString(), message: { role: 'user', content: 'go' } }) + '\n');
  const events = [
    { ts: t, sessionId: 'sW', event: 'UserPromptSubmit', transcriptPath: f, surfaceId: '%7', cwd: '/w' },
    { ts: t + 1000, sessionId: 'sW', event: 'Notification', notificationType: 'permission_prompt', transcriptPath: f, surfaceId: '%7', cwd: '/w' },
  ];
  const epoch = 1789991468;
  const id = tmuxIds.mint(4, epoch, 7);
  const snap = { table: [], sessions: [{ socket: '/s', name: 'x-worker', attached: 0, epoch, created: 1, panes: [{ id: '%7', pid: 5, active: true, cwd: '/w' }] }] };
  const tab = { id, ref: '%7', title: 'x-worker', type: 'terminal', tmuxPane: '%7', tmuxSocket: '/s' };
  const reads = [];
  let k = 0;
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home,
    loadTree: async () => [{ ref: 'tmux', title: 'tmux', tabs: [tab] }],
    readEvents: async () => ({ events, more: false }), procSnapshot: async () => snap,
    readGrid: async () => { throw new Error('a tmux-only id must not be read through cmux'); },
    tmuxGrid: async (tgt) => { reads.push(tgt); return procs.tmuxGrid(tgt, { run: fakeRun(frames[Math.min(k++, frames.length - 1)]) }); } });
  return { r, id, reads, home };
}
const list = (r) => new Promise((resolve) => {
  r.handle({ method: 'GET', headers: {} }, { writeHead() {}, end: (b) => resolve(JSON.parse(b)) }, new URL('http://x/cmux/sessions'));
});

test('tmux-only session at a permission prompt lists Session.choice from its live screen (was: no buttons)', async () => {
  const { r, id, reads } = setup([ANSI]);
  const l = await list(r);
  const s = l.sessions.find((x) => x.surface === id);
  assert.ok(s, JSON.stringify(l.sessions));
  assert.equal(s.reach, 'tmux');
  assert.equal(s.status, 'needs-you');
  assert.ok(s.choice, 'choice present');
  assert.equal(s.choice.source, 'menu');
  assert.deepEqual(s.choice.options.map((o) => o.label), ['Yes', 'No']);
  assert.deepEqual(reads[0], { socket: '/s', pane: '%7', session: 'x-worker' });
});

test('choose on a tmux-only session: Yes = Enter; No = Down, readback shows No highlighted, then Enter', async () => {
  const yes = setup([ANSI]);
  const ch = (await list(yes.r)).sessions[0].choice;
  const keysYes = [];
  const io = (keys) => ({ pressKey: async (k) => { keys.push(k); return { ok: true }; }, sendText: async () => ({ ok: false }) });
  const a = await yes.r.choose({ surface: yes.id, choiceId: ch.choiceId, index: 0, label: 'Yes' }, io(keysYes));
  assert.deepEqual(a, { code: 200, body: { ok: true } });
  assert.deepEqual(keysYes, ['enter']);

  // frames: list read, choose's describe read, commit's first read (Yes marked), then the readback (No marked)
  const no = setup([ANSI, ANSI, ANSI, ANSI_NO]);
  const ch2 = (await list(no.r)).sessions[0].choice;
  const keysNo = [];
  const b = await no.r.choose({ surface: no.id, choiceId: ch2.choiceId, index: 1, label: 'No' }, io(keysNo));
  assert.deepEqual(b, { code: 200, body: { ok: true } });
  assert.deepEqual(keysNo, ['down', 'enter']);

  // The Down never lands (screen unchanged): no Enter is sent.
  const lost = setup([ANSI]);
  const ch3 = (await list(lost.r)).sessions[0].choice;
  const keysLost = [];
  const c = await lost.r.choose({ surface: lost.id, choiceId: ch3.choiceId, index: 1, label: 'No' }, io(keysLost));
  assert.equal(c.code, 409);
  assert.deepEqual(keysLost, ['down']);
});
