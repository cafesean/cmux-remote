'use strict';
// p18 review fixes — one real-tmux test per finding, each written to FAIL on the pre-fix code.
//
//   1  refs skip the epoch fence: after a tmux restart `surface:0` names the NEW server's %0, so every
//      write verb refuses refs (reads keep them), and radar dispatch tries the epoch-bound surfaceId
//      before the tabRef.
//   2  a tmux started from inside a pane inherits CMUX_TMUX_EPOCH; its own %0 must not mint the OUTER
//      %0's id. ensure() exports CMUX_TMUX_PID and surfaceFromEnv requires $TMUX's pid to match.
//   3  user text in format-expanded tmux arguments (-c, rename-window) is `#`-escaped.
//   4  the converter's widths are tmux's own (emoji, VS16, ZWJ, skin tones, flags).
//   5  replay captures with -N so a coloured fill to the end of a line survives.
//   6  close-surface decides "last pane?" and kills in ONE tmux command, so two racing closes can
//      never take the workspace down.
//
// Every server is a throwaway `tmux -u -D -S <mkdtemp>/s -f /dev/null` (test/helpers/tmux-server.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ids = require('../lib/tmux-ids');
const { charWidth, textWidth } = require('../lib/tmux-grid');
const receiver = require('../radar/hook-receiver');
const { createDispatcher } = require('../radar/dispatch');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');

const skip = tmuxBinary() ? false : 'tmux not installed';
const x = (cli, args) => new Promise((resolve) => {
  const h = cli.exec(args, { timeout: 8000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr, pid: h.pid }));
});
const TREE = ['tree', '--all', '--json', '--id-format', 'both'];

let srv, cli;
before(async () => {
  if (skip) return;
  srv = await startTmux({ cols: 120, rows: 40 });
  cli = srv.cli();
  await x(cli, TREE);
});
after(async () => { if (srv) await srv.stop(); });
const epochNow = () => srv.startTime();
const S = (e, pane) => ids.mint(4, e, Number(String(pane).slice(1)));

// ---- 1 -------------------------------------------------------------------------------------------
test('1a: after a tmux restart, write verbs refuse refs — `surface:0` never types into the new %0', { skip }, async () => {
  const own = await startTmux({ cols: 100, rows: 30 });
  try {
    const c = own.cli();
    await x(c, TREE);                                            // old server: main, %0
    await own.restart();
    await x(c, TREE);                                            // new server: a fresh main, %0 again
    assert.equal((await own.runOk(['display', '-p', '-t', 'main', '#{pane_id}'])).trim(), '%0');
    const r = await x(c, ['send', '--surface', 'surface:0', '--', 'echo P18-REF-WRITE']);
    assert.ok(r.err, 'a ref write must be refused');
    assert.match(r.stderr, /^not_found: surface:0/);
    assert.equal(r.pid, undefined, 'refused before any side-effect child');
    const k = await x(c, ['send-key', '--surface', 'surface:0', '--', 'enter']);
    assert.match(k.stderr, /^not_found/);
    await new Promise((res) => setTimeout(res, 150));
    assert.ok(!(await own.capture('%0')).includes('P18-REF-WRITE'));
    // every other write verb refuses refs too
    const refused = [
      ['close-workspace', '--workspace', 'workspace:0'],
      ['close-surface', '--surface', 'surface:0', '--workspace', 'workspace:0'],
      ['workspace-action', '--action', 'rename', '--workspace', 'workspace:0', '--title', 'x'],
      ['new-pane', '--type', 'terminal', '--direction', 'right', '--workspace', 'workspace:0', '--focus', 'false'],
      ['new-surface', '--type', 'terminal', '--workspace', 'workspace:0', '--focus', 'false'],
      ['focus-pane', '--pane', 'pane:0'],
      ['move-surface', '--surface', 'surface:0', '--pane', 'pane:0', '--focus', 'false'],
      ['rpc', 'surface.focus', JSON.stringify({ surface: 'surface:0' })],
      ['rpc', 'pane.resize', JSON.stringify({ pane: 'pane:0', direction: 'right', amount: 40 })],
      ['rpc', 'workspace.equalize_splits', JSON.stringify({ workspace: 'workspace:0' })],
    ];
    for (const args of refused) {
      const rr = await x(c, args);
      assert.match(rr.stderr, /^not_found: /, args.join(' '));
      assert.equal(rr.pid, undefined, args.join(' '));
    }
    assert.equal((await own.runOk(['list-panes', '-a', '-F', '#{pane_id}'])).trim(), '%0', 'nothing split, killed or moved');
    // reads keep accepting refs
    const rd = await x(c, ['read-screen', '--surface', 'surface:0']);
    assert.equal(rd.err, null, rd.stderr);
  } finally { await own.stop(); }
});

test('1b: radar dispatch sends the resume seed to the session\'s surfaceId, not its tabRef', { skip }, async () => {
  const e = await epochNow();
  const right = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}', 'cat'])).trim();
  const wrong = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}', 'cat'])).trim();
  const NOW = Date.parse('2026-09-21T12:00:00.000Z');
  const ago = (m) => new Date(NOW - m * 60000).toISOString();
  const session = {
    key: { machine: 'box', sessionId: 'sess-1' },
    // the ref is what a stale state.json carries; the id is epoch-bound
    surface: { tabRef: `surface:${wrong.slice(1)}`, surfaceId: S(e, right) }, surfaceReason: null,
    repo: 'r', worktree: 'feature/PROJ-1-x', epic: 'PROJ-1', status: 'idle', lastEventAt: ago(10), lastSubmitAt: ago(11),
  };
  const state = { collectorId: 'box', sessions: [session], workRefs: [{
    urn: 'urn:work:jira:PROJ-1', source: 'jira', sourceId: 'PROJ-1', kind: 'epic', title: 't',
    status: { native: 'In Progress', nativeCategory: 'indeterminate', canonical: 'active' },
    cluster: 'PROJ-1', links: ['urn:work:git:r/feature/PROJ-1-x'], selectable: true, route: null }] };
  const sent = [];
  const d = createDispatcher({
    config: () => ({ role: 'leader', repos: [{ id: 'r', path: '/repo/r' }], resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: true },
      dispatch: { enabled: false } }),
    readState: async () => state,
    now: () => NOW,
    // the bridge's /cmux/send, over the real emulator: text, then enter
    bridgeSend: async (a) => {
      sent.push(a.surface);
      const t = await x(cli, ['send', '--surface', a.surface, '--', a.text]);
      if (t.err) return { ok: false, error: t.stderr };
      const k = await x(cli, ['send-key', '--surface', a.surface, '--', 'enter']);
      return k.err ? { ok: false, error: k.stderr } : { ok: true };
    },
    spawn: async () => ({ sessionId: 'spawned', machine: 'box' }),
  });
  const r = await d.dispatch({ workRefUrns: ['urn:work:jira:PROJ-1'], authority: 'sean', runId: 'run-1' });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.route.kind, 'resume', JSON.stringify(r.payload));
  assert.deepEqual(sent, [S(e, right)]);
  await waitFor(async () => (await srv.capture(right)).includes('PROJ-1'), { what: 'the seed in the session pane' });
  assert.ok(!(await srv.capture(wrong)).includes('PROJ-1'), 'the tabRef pane got nothing');
});

// ---- 2 -------------------------------------------------------------------------------------------
test('2: a tmux started inside a pane does not inherit the outer identity; the outer pane still has it', { skip }, async () => {
  const e = await epochNow();
  const outer = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}'])).trim();
  const outerEnv = path.join(srv.dir, 'outer-env.txt');
  const innerEnv = path.join(srv.dir, 'inner-env.txt');
  const dump = (file) => `env | grep -E '^(TMUX|TMUX_PANE|CMUX_TMUX_EPOCH|CMUX_TMUX_PID)=' > '${file}'`;
  await srv.type(outer, dump(outerEnv));
  // a nested server on its own private socket; it exits by itself when its one command ends
  await srv.type(outer, `'${srv.tmuxBin}' -S '${path.join(srv.dir, 'inner')}' -f /dev/null new-session -d "${dump(innerEnv).replace(/"/g, '\\"')}"`);
  const read = async (f) => {
    await waitFor(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('TMUX_PANE='), { what: f });
    return Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  };
  const o = await read(outerEnv);
  const i = await read(innerEnv);
  assert.equal(o.TMUX_PANE, outer);
  assert.equal(i.TMUX_PANE, '%0');
  assert.equal(i.CMUX_TMUX_EPOCH, String(e), 'the nested server inherited the epoch — the trap is real');
  assert.equal(receiver.cmuxIdentity(i).surfaceId, '', 'nested pane: no identity');
  assert.equal(receiver.cmuxIdentity(o).surfaceId, S(e, outer), 'outer pane: its own tab id');
  const tree = JSON.parse((await x(cli, TREE)).stdout);
  const tab = tree.windows.flatMap((w) => w.workspaces).flatMap((w) => w.panes).find((p) => p.ref === `pane:${outer.slice(1)}`).surfaces[0];
  assert.equal(receiver.cmuxIdentity(o).surfaceId, tab.id);
  assert.equal((await srv.runOk(['show-environment', '-g', 'CMUX_TMUX_PID'])).trim(), `CMUX_TMUX_PID=${(await srv.runOk(['display', '-p', '#{pid}'])).trim()}`);
});

// ---- 3 -------------------------------------------------------------------------------------------
test('3: `#` in a title or a cwd reaches tmux literally, never as a format', { skip }, async () => {
  const e = await epochNow();
  const win = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{window_id}'])).trim();
  const title = '#D #H ## #{pane_id} end';
  const r = await x(cli, ['workspace-action', '--action', 'rename', '--workspace', ids.mint(2, e, Number(win.slice(1))), '--title', title]);
  assert.equal(r.err, null, r.stderr);
  assert.equal(await srv.display(win, '#{window_name}'), title);
  const dir = path.join(srv.dir, 'a#Db #{host}');
  fs.mkdirSync(dir);
  const nw = await x(cli, ['new-workspace', '--focus', 'true', '--cwd', dir]);
  assert.equal(nw.err, null, nw.stderr);
  const w2 = `@${/^OK workspace:(\d+)$/.exec(nw.stdout)[1]}`;
  assert.equal(await srv.display(w2, '#{pane_current_path}'), dir);
});

// ---- 4 -------------------------------------------------------------------------------------------
// The wrap trick: in an 11-column pane `x` + ten copies + `|` stays on one row for width 0, pushes `|`
// to the next row for width 1, and splits five-and-five for width 2.
async function tmuxWidths(strings) {
  const own = await startTmux({ cols: 11, rows: 4 });
  try {
    await own.runOk(['set-option', '-g', 'history-limit', '100000']);
    const file = path.join(own.dir, 'w.txt');
    fs.writeFileSync(file, strings.map((s) => 'x' + s.repeat(10) + '|\n').join('') + 'DONE\n');
    const pane = (await own.runOk(['new-session', '-d', '-s', 'w', '-x', '11', '-y', '4', '-P', '-F', '#{pane_id}', `cat '${file}'; exec sleep 1000`])).trim();
    await waitFor(async () => (await own.capture(pane, ['-S', '-'])).includes('DONE'), { timeout: 20000, what: 'the width sheet' });
    const lines = (await own.capture(pane, ['-S', '-'])).split('\n');
    const out = [];
    let i = 0;
    for (const s of strings) {
      if (lines[i].endsWith('|')) { out.push(0); i += 1; } else if (lines[i + 1] === '|') { out.push(1); i += 2; } else { out.push(2); i += 2; }
    }
    return out;
  } finally { await own.stop(); }
}
test('4a: every code point in the emoji blocks has the width tmux gives it', { skip }, async () => {
  const cps = [];
  for (const [lo, hi] of [[0x2300, 0x23FF], [0x2600, 0x27BF], [0x2B00, 0x2BFF], [0x3000, 0x303F], [0x1F000, 0x1FAFF]]) {
    for (let c = lo; c <= hi; c++) if (c < 0x1F1E6 || c > 0x1F1FF) cps.push(c);   // flags are clusters: 4b
  }
  const got = await tmuxWidths(cps.map((c) => String.fromCodePoint(c)));
  const wrong = cps.filter((c, k) => charWidth(c) !== got[k]).map((c, k) => c.toString(16));
  assert.deepEqual(wrong, [], `converter widths differ from tmux for ${wrong.length} code points`);
  for (const ch of ['🚀', '✅', '🟢', '⚡', '☕']) assert.equal(charWidth(ch.codePointAt(0)), 2, ch);
});
test('4b: clusters — VS16, keycaps, ZWJ, skin tones, flags — are as wide as tmux draws them', { skip }, async () => {
  const seqs = ['⚠️', '❤️', '✈️', '1️⃣', '🏳️‍🌈', '🧑🏻‍💻', '👍🏽', '🇺🇸', '🇺', 'a‍b', 'é', 'é', '日本', '❯', '─'];
  const own = await startTmux({ cols: 40, rows: seqs.length + 2 });
  try {
    // tmux's width for each cluster: print `x<cluster>` alone and read the cursor
    const truth = [];
    for (const s of seqs) {
      const f = path.join(own.dir, 'one.txt');
      fs.writeFileSync(f, 'x' + s);
      const p = (await own.runOk(['new-session', '-d', '-x', '40', '-y', '4', '-P', '-F', '#{pane_id}', `cat '${f}'; exec sleep 1000`])).trim();
      await waitFor(async () => (await own.capture(p)).startsWith('x'), { what: 'x' });
      await new Promise((res) => setTimeout(res, 50));
      truth.push(Number(await own.display(p, '#{cursor_x}')) - 1);
      await own.runOk(['kill-session', '-t', p]);
    }
    seqs.forEach((s, k) => assert.equal(textWidth(s), truth[k], `${JSON.stringify(s)}: converter ${textWidth(s)} vs tmux ${truth[k]}`));
    // and the converter lays a sheet of them out where tmux does: `x<cluster>|` per row, '|' at 1 + width
    const file = path.join(own.dir, 'sheet.txt');
    fs.writeFileSync(file, seqs.map((s, k) => `\x1b[${k + 1};1Hx${s}|`).join('') + `\x1b[${seqs.length + 2};1HDONE`);
    const pane = (await own.runOk(['new-session', '-d', '-x', '40', '-y', String(seqs.length + 2), '-P', '-F', '#{pane_id}', `cat '${file}'; exec sleep 1000`])).trim();
    await waitFor(async () => (await own.capture(pane)).includes('DONE'), { what: 'the cluster sheet' });
    const { ansiToGrid } = require('../lib/tmux-grid');
    const g = ansiToGrid(await own.runOk(['capture-pane', '-p', '-e', '-N', '-t', pane]), { columns: 40, rows: seqs.length + 2 });
    seqs.forEach((s, k) => {
      const row = g.row_spans.filter((sp) => sp.row === k);
      const end = row.reduce((m, sp) => Math.max(m, sp.column + sp.cell_width), 0);
      assert.equal(end, 1 + truth[k] + 1, `row ${k} ${JSON.stringify(s)}: ${JSON.stringify(row)}`);
    });
  } finally { await own.stop(); }
});
test('4c: through terminal.replay, a span after wide emoji starts where tmux put it', { skip }, async () => {
  const e = await epochNow();
  const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}',
    "printf '🚀 ✅ 🟢 ⚡ ☕ ⚠️ 🧑🏻‍💻 \\033[31mEND\\033[0m'; exec sleep 1000"])).trim();
  await waitFor(async () => (await srv.capture(pane)).includes('END'), { what: 'END' });
  const cx = Number(await srv.display(pane, '#{cursor_x}'));
  const d = JSON.parse((await x(cli, ['rpc', 'terminal.replay', JSON.stringify({ surface_id: S(e, pane) })])).stdout);
  const end = d.render_grid.row_spans.find((sp) => sp.text === 'END');
  assert.ok(end, JSON.stringify(d.render_grid.row_spans));
  assert.equal(end.column, cx - 3, `END at ${end.column}, tmux cursor after it at ${cx}`);
});

// ---- 5 -------------------------------------------------------------------------------------------
test('5: a background fill to the end of the line survives the capture; trailing default blanks do not', { skip }, async () => {
  const e = await epochNow();
  const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}',
    "printf 'plain   \\n\\033[44mAB\\033[K\\033[0m\\nX'; exec sleep 1000"])).trim();
  await waitFor(async () => (await srv.capture(pane)).includes('X'), { what: 'the fill' });
  const d = JSON.parse((await x(cli, ['rpc', 'terminal.replay', JSON.stringify({ surface_id: S(e, pane) })])).stdout);
  const rg = d.render_grid;
  const blue = rg.styles.filter((st) => st.background === '#0000EE').map((st) => st.id);
  const row1 = rg.row_spans.filter((sp) => sp.row === 1);
  const filled = row1.filter((sp) => blue.includes(sp.style_id)).reduce((n, sp) => n + sp.cell_width, 0);
  assert.equal(filled, rg.columns, `blue cells on row 1: ${filled} of ${rg.columns} — ${JSON.stringify(row1)}`);
  assert.deepEqual(rg.row_spans.filter((sp) => sp.row === 0).map((sp) => sp.text), ['plain']);
  for (const sp of rg.row_spans) assert.ok(!(sp.style_id === 0 && /^ +$/.test(sp.text)), `a default blank span survived: ${JSON.stringify(sp)}`);
  assert.equal(rg.row_spans.filter((sp) => sp.row > 2).length, 0, 'empty rows stay empty');
});

// ---- 6 -------------------------------------------------------------------------------------------
test('6: two racing close-surface calls on a two-pane window close one pane, never the workspace', { skip }, async () => {
  const e = await epochNow();
  for (let round = 0; round < 6; round++) {
    const out = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{window_id} #{pane_id}'])).trim();
    const [win, p1] = out.split(' ');
    const p2 = (await srv.runOk(['split-window', '-d', '-t', p1, '-P', '-F', '#{pane_id}'])).trim();
    const ws = ids.mint(2, e, Number(win.slice(1)));
    const [a, b] = await Promise.all([
      x(cli, ['close-surface', '--surface', S(e, p1), '--workspace', ws]),
      x(cli, ['close-surface', '--surface', S(e, p2), '--workspace', ws]),
    ]);
    const oks = [a, b].filter((r) => !r.err).length;
    assert.equal(oks, 1, `round ${round}: ${a.stderr || 'OK'} / ${b.stderr || 'OK'}`);
    assert.match((a.err ? a : b).stderr, /^invalid_state: Cannot close the last surface/);
    const panes = (await srv.run(['list-panes', '-t', win, '-F', '#{pane_id}'])).stdout.trim().split('\n').filter(Boolean);
    assert.equal(panes.length, 1, `round ${round}: the workspace survives with one pane`);
  }
});
