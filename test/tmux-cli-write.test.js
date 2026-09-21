'use strict';
// p18 STORY-003 — the emulator's write verbs against a REAL tmux server (specs.md §5.4, D6).
//
// Throwaway `tmux -u -D -S <mkdtemp>/s -f /dev/null` from test/helpers/tmux-server.js. The emulator's
// _run is wrapped to RECORD every tmux argv it spawns, which is how "typed text never appears on an
// argv" and "-p only for multi-line text" are proven, not assumed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ids = require('../lib/tmux-ids');
const { KEYMAP } = require('../lib/tmux-cli');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');

const HAVE_TMUX = !!tmuxBinary();
const skip = HAVE_TMUX ? false : 'tmux not installed';
const x = (cli, args) => new Promise((resolve) => {
  const h = cli.exec(args, { timeout: 8000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr, pid: h.pid }));
});

let srv, cli, epoch;
const spawned = [];
before(async () => {
  if (!HAVE_TMUX) return;
  srv = await startTmux({ cols: 120, rows: 40 });
  cli = srv.cli();
  const orig = cli._run;
  cli._run = (args, o) => { spawned.push({ args: args.slice(), input: o && o.input }); return orig(args, o); };
  await x(cli, ['tree', '--all', '--json', '--id-format', 'both']);     // ensure(): session main
  epoch = await srv.startTime();
});
after(async () => { if (srv) await srv.stop(); });

const S = (pane) => ids.mint(4, epoch, Number(String(pane).slice(1)));       // surface id of %N
const P = (pane) => ids.mint(3, epoch, Number(String(pane).slice(1)));       // pane id of %N
const W = (win) => ids.mint(2, epoch, Number(String(win).slice(1)));         // workspace id of @N
const newWindow = async (cmd) => {
  const out = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{window_id} #{pane_id}', ...(cmd ? [cmd] : [])])).trim();
  const [win, pane] = out.split(' ');
  return { win, pane };
};
const geometry = async (win) => (await srv.runOk(['list-panes', '-t', win, '-F', '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}']))
  .trim().split('\n').map((l) => { const [id, left, top, w, h] = l.split(' '); return { id, left: +left, top: +top, w: +w, h: +h }; });
const paneCount = async (win) => (await geometry(win)).length;

test('send: UTF-8 text lands in a cat pane, through stdin — no tmux argv ever carries it', { skip }, async () => {
  const { pane } = await newWindow('cat');
  const text = 'héllo wörld 日本';
  const from = spawned.length;
  const r = await x(cli, ['send', '--surface', S(pane), '--', text]);
  assert.equal(r.err, null, r.stderr);
  assert.equal(typeof r.pid, 'number');
  await waitFor(async () => (await srv.capture(pane)).includes(text), { what: 'the text in the pane' });
  const mine = spawned.slice(from);
  assert.ok(mine.some((s) => s.input === text), 'the text went in on stdin');
  for (const s of spawned) {
    for (const a of s.args) {
      for (const piece of ['héllo', 'wörld', '日本']) assert.ok(!String(a).includes(piece), `argv carried text: ${s.args.join(' ')}`);
    }
  }
  // and the one-shot buffer is gone
  assert.equal((await srv.runOk(['list-buffers', '-F', '#{buffer_name}'])).trim(), '');
});

test('paste-buffer -p only when the text contains a newline', { skip }, async () => {
  const { pane } = await newWindow('cat');
  const pasteArgs = async (text) => {
    const from = spawned.length;
    const r = await x(cli, ['send', '--surface', S(pane), '--', text]);
    assert.equal(r.err, null, r.stderr);
    const call = spawned.slice(from).find((s) => s.args.includes('paste-buffer'));
    const i = call.args.indexOf('paste-buffer');
    return call.args.slice(i);
  };
  const single = await pasteArgs('one line');
  assert.ok(!single.includes('-p'), single.join(' '));
  const multi = await pasteArgs('line one\nline two');
  assert.ok(multi.includes('-p'), multi.join(' '));
  assert.ok(multi.includes('-d'));
  await waitFor(async () => (await srv.capture(pane)).includes('line two'), { what: 'the multi-line paste' });
});

test('send: stale epoch -> error with handle.pid undefined; live id of a killed pane -> error with a pid', { skip }, async () => {
  const { pane } = await newWindow('cat');
  const stale = ids.mint(4, epoch - 3600, Number(pane.slice(1)));
  const from = spawned.length;
  const r1 = await x(cli, ['send', '--surface', stale, '--', 'must not type']);
  assert.ok(r1.err);
  assert.match(r1.stderr, /^not_found: stale id/);
  assert.equal(r1.pid, undefined);
  assert.ok(!spawned.slice(from).some((s) => s.args.includes('paste-buffer')), 'no paste child was spawned');
  assert.ok(!(await srv.capture(pane)).includes('must not type'));

  const { pane: gone } = await newWindow('cat');
  await srv.runOk(['kill-pane', '-t', gone]);
  const r2 = await x(cli, ['send', '--surface', S(gone), '--', 'into nothing']);
  assert.ok(r2.err);
  assert.equal(typeof r2.pid, 'number');                 // the side-effect child started: unproved, not "nothing typed"
  assert.equal((await srv.runOk(['list-buffers', '-F', '#{buffer_name}'])).trim(), '', 'failed paste buffer cleaned up');
});

test('send-key: the map is exactly bridge.js CMUX_KEYS, tmux accepts every name, enter makes a new line', { skip }, async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  const m = /const CMUX_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  const bridgeKeys = [...m[1].matchAll(/'([^']+)'/g)].map((k) => k[1]);
  assert.equal(bridgeKeys.length, 18);
  assert.deepEqual(Object.keys(KEYMAP).sort(), bridgeKeys.slice().sort());

  // every mapped name through tmux, into a raw-mode sink so C-c / C-d are plain bytes
  const { pane: sink } = await newWindow("sh -c 'trap \"\" INT QUIT TSTP; stty raw -echo; exec cat >/dev/null'");
  await new Promise((r) => setTimeout(r, 200));
  for (const k of bridgeKeys) {
    const r = await x(cli, ['send-key', '--surface', S(sink), '--', k]);
    assert.equal(r.err, null, `${k}: ${r.stderr}`);
    assert.equal(typeof r.pid, 'number');
  }
  assert.equal(await srv.display(sink, '#{pane_dead}'), '0');

  const { pane } = await newWindow('cat');
  await x(cli, ['send', '--surface', S(pane), '--', 'k1']);
  await x(cli, ['send-key', '--surface', S(pane), '--', 'enter']);
  await x(cli, ['send', '--surface', S(pane), '--', 'k2']);
  await waitFor(async () => (await srv.capture(pane)).includes('k2'), { what: 'k2' });
  const rows = (await srv.capture(pane)).split('\n');
  assert.deepEqual(rows.slice(0, 3), ['k1', 'k1', 'k2']);   // typed line, cat's echo of it, the next line
  const bad = await x(cli, ['send-key', '--surface', S(pane), '--', 'f13']);
  assert.match(bad.stderr, /^invalid_params/);
  assert.equal(bad.pid, undefined);
});

test('resize (F18): B left 40 shrinks A by 5 and leaves C; C right has no border; A right 4 is below one cell', { skip }, async () => {
  const { win, pane: A } = await newWindow();
  await srv.runOk(['split-window', '-d', '-h', '-t', A]);
  await srv.runOk(['split-window', '-d', '-h', '-t', A]);
  await srv.runOk(['select-layout', '-t', win, 'even-horizontal']);
  const g0 = await geometry(win);
  const [a, b, c] = g0.slice().sort((p, q) => p.left - q.left);
  const r = await x(cli, ['rpc', 'pane.resize', JSON.stringify({ pane_id: P(b.id), direction: 'left', amount: 40 })]);
  assert.equal(r.err, null, r.stderr);
  assert.equal(r.stdout, '{}');
  const g1 = await geometry(win);
  const w1 = (id) => g1.find((p) => p.id === id).w;
  assert.equal(w1(a.id), a.w - 5);
  assert.equal(w1(b.id), b.w + 5);
  assert.equal(w1(c.id), c.w);
  const r2 = await x(cli, ['rpc', 'pane.resize', JSON.stringify({ pane_id: P(c.id), direction: 'right', amount: 40 })]);
  assert.equal(r2.stderr, 'invalid_state: Pane has no adjacent border');
  const r3 = await x(cli, ['rpc', 'pane.resize', JSON.stringify({ pane_id: P(a.id), direction: 'right', amount: 4 })]);
  assert.equal(r3.stderr, 'invalid_state: below one cell');
  // right on A grows A into B; the ref form of the pane is accepted too
  const r4 = await x(cli, ['rpc', 'pane.resize', JSON.stringify({ pane: `pane:${a.id.slice(1)}`, direction: 'right', amount: 16 })]);
  assert.equal(r4.err, null, r4.stderr);
  const g2 = await geometry(win);
  assert.equal(g2.find((p) => p.id === a.id).w, a.w - 5 + 2);
  assert.equal(g2.find((p) => p.id === c.id).w, c.w);
  // vertical: the lower pane pushing its top border up shrinks the upper pane
  const { win: v, pane: top } = await newWindow();
  await srv.runOk(['split-window', '-d', '-v', '-t', top]);
  const gv = (await geometry(v)).sort((p, q) => p.top - q.top);
  const r5 = await x(cli, ['rpc', 'pane.resize', JSON.stringify({ pane_id: P(gv[1].id), direction: 'up', amount: 32 })]);
  assert.equal(r5.err, null, r5.stderr);
  const gv2 = await geometry(v);
  assert.equal(gv2.find((p) => p.id === gv[0].id).h, gv[0].h - 2);
  // stale pane id: refused before any tmux resize runs
  const from = spawned.length;
  const r6 = await x(cli, ['rpc', 'pane.resize', JSON.stringify({ pane_id: ids.mint(3, epoch - 9, Number(a.id.slice(1))), direction: 'right', amount: 40 })]);
  assert.match(r6.stderr, /^not_found: stale id/);
  assert.ok(!spawned.slice(from).some((s) => s.args.includes('resize-pane')));
});

test('equalize: three unequal columns end within one cell of each other', { skip }, async () => {
  const { win, pane: A } = await newWindow();
  await srv.runOk(['split-window', '-d', '-h', '-t', A]);
  await srv.runOk(['split-window', '-d', '-h', '-t', A]);
  await srv.runOk(['resize-pane', '-t', A, '-x', '70']);
  const before = (await geometry(win)).map((p) => p.w);
  assert.ok(Math.max(...before) - Math.min(...before) > 1, `set-up must be unequal: ${before}`);
  const r = await x(cli, ['rpc', 'workspace.equalize_splits', JSON.stringify({ workspace_id: W(win) })]);
  assert.equal(r.err, null, r.stderr);
  const widths = (await geometry(win)).map((p) => p.w);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `widths ${widths}`);
  // one tmux invocation chaining select-layout -E per pane
  const call = spawned.filter((s) => s.args.includes('select-layout')).pop();
  assert.equal(call.args.filter((a) => a === 'select-layout').length, 3);
  assert.equal(call.args.filter((a) => a === '-E').length, 3);
});

test('drop: centre stacks S under P in P\'s column; an edge drop puts S on that side of P', { skip }, async () => {
  // centre
  const { win: w1, pane: p1 } = await newWindow();
  const s1 = (await srv.runOk(['split-window', '-d', '-h', '-t', p1, '-P', '-F', '#{pane_id}'])).trim();
  const r1 = await x(cli, ['move-surface', '--surface', S(s1), '--pane', P(p1), '--workspace', W(w1), '--focus', 'false']);
  assert.equal(r1.err, null, r1.stderr);
  const g1 = await geometry(w1);
  const P1 = g1.find((p) => p.id === p1), S1 = g1.find((p) => p.id === s1);
  assert.equal(S1.left, P1.left);
  assert.equal(S1.top, P1.top + P1.h + 1);
  // edge: move-surface then drag-surface-to-split left
  const { win: w2, pane: p2 } = await newWindow();
  const s2 = (await srv.runOk(['split-window', '-d', '-h', '-t', p2, '-P', '-F', '#{pane_id}'])).trim();
  assert.equal((await x(cli, ['move-surface', '--surface', S(s2), '--pane', P(p2), '--workspace', W(w2), '--focus', 'false'])).err, null);
  const r2 = await x(cli, ['drag-surface-to-split', '--surface', S(s2), 'left', '--workspace', W(w2), '--focus', 'false']);
  assert.equal(r2.err, null, r2.stderr);
  const g2 = await geometry(w2);
  const P2 = g2.find((p) => p.id === p2), S2 = g2.find((p) => p.id === s2);
  assert.ok(S2.left < P2.left, JSON.stringify(g2));
  assert.equal(S2.top, P2.top);
  // an edge drop with no centre drop before it is refused, and uses the record only once
  const r3 = await x(cli, ['drag-surface-to-split', '--surface', S(s2), 'right', '--workspace', W(w2), '--focus', 'false']);
  assert.equal(r3.stderr, 'invalid_state: no drop target recorded');
});

test('close-surface: refused on a one-pane window, kills exactly that pane on a two-pane window', { skip }, async () => {
  const { win, pane } = await newWindow();
  const r1 = await x(cli, ['close-surface', '--surface', S(pane), '--workspace', W(win)]);
  assert.equal(r1.stderr, 'invalid_state: Cannot close the last surface');
  assert.equal(await paneCount(win), 1);
  const other = (await srv.runOk(['split-window', '-d', '-t', pane, '-P', '-F', '#{pane_id}'])).trim();
  const r2 = await x(cli, ['close-surface', '--surface', S(other), '--workspace', W(win)]);
  assert.equal(r2.err, null, r2.stderr);
  assert.deepEqual((await geometry(win)).map((p) => p.id), [pane]);
  // close-workspace kills the window
  const r3 = await x(cli, ['close-workspace', '--workspace', W(win)]);
  assert.equal(r3.err, null, r3.stderr);
  assert.ok(!(await srv.runOk(['list-windows', '-a', '-F', '#{window_id}'])).split('\n').includes(win));
});

test('rename sets window_name and automatic-rename 0; clear-name turns it back on', { skip }, async () => {
  const { win } = await newWindow();
  const r1 = await x(cli, ['workspace-action', '--action', 'rename', '--workspace', W(win), '--title', '-dash first title']);
  assert.equal(r1.err, null, r1.stderr);
  assert.equal(await srv.display(win, '#{window_name}'), '-dash first title');
  assert.equal(await srv.display(win, '#{automatic-rename}'), '0');
  const r2 = await x(cli, ['workspace-action', '--action', 'clear-name', '--workspace', W(win)]);
  assert.equal(r2.err, null, r2.stderr);
  assert.equal(await srv.display(win, '#{automatic-rename}'), '1');
});

test('new-workspace --command: a new window shows the command output and outlives the command', { skip }, async () => {
  const before = (await srv.runOk(['list-windows', '-a', '-F', '#{window_id}'])).trim().split('\n');
  const r = await x(cli, ['new-workspace', '--focus', 'true', '--cwd', srv.dir, '--command', 'printf P18OK']);
  assert.equal(r.err, null, r.stderr);
  const m = /^OK workspace:(\d+)$/.exec(r.stdout);
  assert.ok(m, r.stdout);
  const win = `@${m[1]}`;
  assert.ok(!before.includes(win));
  await waitFor(async () => (await srv.capture(win)).split('\n').some((l) => /P18OK/.test(l) && !/printf/.test(l)), { what: 'P18OK output' });
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(await srv.display(win, '#{pane_dead}'), '0');
  assert.match(await srv.display(win, '#{pane_current_command}'), /sh|bash|zsh/);
  assert.equal(await srv.display(win, '#{pane_current_path}'), srv.dir);
  assert.equal(await srv.display(win, '#{window_active}'), '1');             // --focus true
});

test('new-surface splits the pane across its longer side; new-pane follows the direction; focus verbs select', { skip }, async () => {
  const { win, pane } = await newWindow();                 // 120x40: wide -> -h
  const r = await x(cli, ['new-surface', '--type', 'terminal', '--workspace', W(win), '--pane', P(pane), '--focus', 'false']);
  assert.equal(r.err, null, r.stderr);
  const m = /^OK surface:(\d+)$/.exec(r.stdout);
  assert.ok(m, r.stdout);
  const g = await geometry(win);
  assert.equal(g.length, 2);
  assert.equal(g.find((p) => p.id === `%${m[1]}`).top, 0);   // side by side
  const r2 = await x(cli, ['new-pane', '--type', 'terminal', '--direction', 'down', '--workspace', W(win), '--focus', 'false']);
  assert.equal(r2.err, null, r2.stderr);
  assert.equal(await paneCount(win), 3);
  const newest = `%${m[1]}`;
  const r3 = await x(cli, ['focus-pane', '--pane', P(newest), '--workspace', W(win)]);
  assert.equal(r3.err, null, r3.stderr);
  assert.equal(await srv.display(newest, '#{pane_active}'), '1');
  const r4 = await x(cli, ['rpc', 'surface.focus', JSON.stringify({ surface_id: S(pane) })]);
  assert.equal(r4.stdout, '{}');
  assert.equal(await srv.display(pane, '#{pane_active}'), '1');
  // a pane from another workspace is refused, not split somewhere else
  const { win: w2 } = await newWindow();
  const r5 = await x(cli, ['new-surface', '--type', 'terminal', '--workspace', W(w2), '--pane', P(pane), '--focus', 'false']);
  assert.match(r5.stderr, /^not_found/);
  assert.equal(await paneCount(w2), 1);
});

test('split-off always refuses with cmux\'s own text; browser panes are unsupported', { skip }, async () => {
  const { win, pane } = await newWindow();
  const r = await x(cli, ['split-off', '--surface', S(pane), 'right', '--focus', 'false']);
  assert.equal(r.stderr, 'invalid_state: splitting off would leave the source pane empty');
  assert.equal(r.pid, undefined);
  const b = await x(cli, ['new-pane', '--type', 'browser', '--direction', 'right', '--workspace', W(win), '--focus', 'false']);
  assert.match(b.stderr, /^unsupported_backend/);
  assert.equal(await paneCount(win), 1);
  const br = await x(cli, ['browser', S(pane), 'url']);
  assert.match(br.stderr, /^unsupported_backend/);
});
