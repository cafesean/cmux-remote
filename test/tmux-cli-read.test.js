'use strict';
// p18 STORY-002 — the cmux CLI emulator's read verbs against a REAL tmux server (specs.md §5.2-§5.6).
//
// Every server here is a throwaway `tmux -u -D -S <mkdtemp>/s -f /dev/null` from
// test/helpers/tmux-server.js; the emulator is pinned to that socket by srv.cli(). Nothing is mocked:
// the argv under test goes through lib/tmux-cli.js to tmux and back.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ids = require('../lib/tmux-ids');
const { normalizeLayout } = require('../panelayout');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');

const HAVE_TMUX = !!tmuxBinary();
const skip = HAVE_TMUX ? false : 'tmux not installed';
const x = (cli, args) => new Promise((resolve) => {
  const h = cli.exec(args, { timeout: 8000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr, pid: h.pid }));
});
const TREE = ['tree', '--all', '--json', '--id-format', 'both'];
const treeOf = async (cli) => {
  const r = await x(cli, TREE);
  assert.equal(r.err, null, r.stderr);
  return JSON.parse(r.stdout);
};
const replay = async (cli, surface) => {
  const r = await x(cli, ['rpc', 'terminal.replay', JSON.stringify({ surface_id: surface })]);
  assert.equal(r.err, null, r.stderr);
  return JSON.parse(r.stdout);
};

let srv, cli, epoch;
before(async () => {
  if (!HAVE_TMUX) return;
  srv = await startTmux({ cols: 120, rows: 40 });
  cli = srv.cli();
});
after(async () => { if (srv) await srv.stop(); });

test('zero sessions: the first tree creates exactly one session "main" and sets CMUX_TMUX_EPOCH first', { skip }, async () => {
  assert.equal((await srv.runOk(['list-sessions', '-F', '#{session_name}'])).trim(), '');
  await treeOf(cli);
  assert.deepEqual((await srv.runOk(['list-sessions', '-F', '#{session_name}'])).trim().split('\n'), ['main']);
  epoch = await srv.startTime();
  assert.equal((await srv.runOk(['show-environment', '-g', 'CMUX_TMUX_EPOCH'])).trim(), `CMUX_TMUX_EPOCH=${epoch}`);
  // the first shell inherited it: set-environment ran BEFORE new-session
  await srv.type('main', 'printf "E=%s\\n" "$CMUX_TMUX_EPOCH"');
  await waitFor(async () => (await srv.capture('main')).includes(`E=${epoch}`), { what: 'the epoch inside the first pane' });
  const windowsBefore = (await srv.runOk(['list-windows', '-a', '-F', '#{window_id}'])).trim();
  await treeOf(cli);
  assert.deepEqual((await srv.runOk(['list-sessions', '-F', '#{session_name}'])).trim().split('\n'), ['main']);
  assert.equal((await srv.runOk(['list-windows', '-a', '-F', '#{window_id}'])).trim(), windowsBefore);
});

test('an existing session is left alone: no "main" is added beside it', { skip }, async () => {
  const other = await startTmux({ cols: 80, rows: 24 });
  try {
    await other.runOk(['new-session', '-d', '-s', 'mine']);
    const tree = await treeOf(other.cli());
    assert.deepEqual((await other.runOk(['list-sessions', '-F', '#{session_name}'])).trim().split('\n'), ['mine']);
    assert.equal(tree.windows.length, 1);
  } finally { await other.stop(); }
});

test('tree JSON: exact keys at every level, minted ids of the right kind and epoch, host titles replaced', { skip }, async () => {
  const tree = await treeOf(cli);
  assert.deepEqual(Object.keys(tree), ['windows']);
  const host = (await srv.display('main', '#{host}'));
  let panes = 0;
  for (const win of tree.windows) {
    assert.deepEqual(Object.keys(win).sort(), ['id', 'ref', 'workspaces']);
    assert.deepEqual(ids.parse(win.id), { kind: 1, epoch: epoch >>> 0, n: ids.parseRef(win.ref, 'window') });
    for (const ws of win.workspaces) {
      assert.deepEqual(Object.keys(ws).sort(), ['id', 'panes', 'ref', 'selected', 'title']);
      assert.deepEqual(ids.parse(ws.id), { kind: 2, epoch: epoch >>> 0, n: ids.parseRef(ws.ref, 'workspace') });
      for (const p of ws.panes) {
        panes++;
        assert.deepEqual(Object.keys(p).sort(), ['focused', 'id', 'index', 'ref', 'selected_surface_id', 'selected_surface_ref', 'surfaces']);
        assert.deepEqual(ids.parse(p.id), { kind: 3, epoch: epoch >>> 0, n: ids.parseRef(p.ref, 'pane') });
        assert.equal(p.surfaces.length, 1);
        const sf = p.surfaces[0];
        assert.deepEqual(Object.keys(sf).sort(), ['id', 'ref', 'selected', 'selected_in_pane', 'title', 'type']);
        assert.deepEqual(ids.parse(sf.id), { kind: 4, epoch: epoch >>> 0, n: ids.parseRef(sf.ref, 'surface') });
        assert.equal(p.selected_surface_id, sf.id);
        assert.equal(sf.type, 'terminal');
        assert.equal(sf.selected_in_pane, true);
        const tmuxPane = `%${ids.parseRef(p.ref, 'pane')}`;
        assert.equal(await srv.display(tmuxPane, '#{pane_title}'), host);        // tmux's default title
        assert.equal(sf.title, await srv.display(tmuxPane, '#{pane_current_command}'));
      }
    }
  }
  assert.ok(panes >= 1);
  // a real title wins over the command name
  await srv.runOk(['select-pane', '-t', 'main', '-T', 'my title']);
  const t2 = await treeOf(cli);
  assert.equal(t2.windows[0].workspaces[0].panes[0].surfaces[0].title, 'my title');
});

test('pane.list on a split -h window: cells x (8, 16) and exactly one x divider in normalizeLayout', { skip }, async () => {
  const win = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{window_id}'])).trim();
  await srv.runOk(['split-window', '-d', '-h', '-t', win]);
  const wsId = ids.mint(2, epoch, Number(win.slice(1)));
  const r = await x(cli, ['rpc', 'pane.list', JSON.stringify({ workspace_id: wsId })]);
  assert.equal(r.err, null, r.stderr);
  const raw = JSON.parse(r.stdout);
  const geo = (await srv.runOk(['list-panes', '-t', win, '-F', '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}']))
    .trim().split('\n').map((l) => l.split(' '));
  assert.equal(raw.panes.length, 2);
  for (const [pid, left, top, w, h] of geo) {
    const p = raw.panes.find((q) => q.ref === `pane:${pid.slice(1)}`);
    assert.deepEqual(p.pixel_frame, { x: left * 8, y: top * 16, width: w * 8, height: h * 16 });
    assert.equal(p.columns, Number(w));
    assert.equal(p.rows, Number(h));
    assert.deepEqual(p.surface_ids, [ids.mint(4, epoch, Number(pid.slice(1)))]);
  }
  const layout = normalizeLayout(raw, { workspace: wsId });
  assert.equal(layout.handles.length, 1);
  assert.equal(layout.handles[0].axis, 'x');
  // the same through the ref form the bridge may also send
  const r2 = await x(cli, ['rpc', 'pane.list', JSON.stringify({ workspace: `workspace:${win.slice(1)}` })]);
  assert.deepEqual(JSON.parse(r2.stdout), raw);
  await srv.runOk(['kill-window', '-t', win]);
});

test('terminal.replay: RGB colour arrives exact; 240-row scrollback cap; alternate screen has none', { skip }, async () => {
  const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}'])).trim();
  const sf = ids.mint(4, epoch, Number(pane.slice(1)));
  await srv.type(pane, "printf '\\033[38;2;177;185;249mSEL\\033[0m\\n'");
  const g1 = await waitFor(async () => {
    const d = await replay(cli, sf);
    return d.render_grid.styles.some((s) => s.foreground === '#B1B9F9') && d;
  }, { what: '#B1B9F9 in the replay' });
  const selSpan = g1.render_grid.row_spans.find((s) => s.text === 'SEL');
  assert.equal(g1.render_grid.styles.find((s) => s.id === selSpan.style_id).foreground, '#B1B9F9');
  assert.equal(g1.render_grid.columns, 120);
  assert.equal(g1.render_grid.rows, 40);
  assert.equal(g1.render_grid.active_screen, 'primary');

  await srv.type(pane, 'clear; seq 1 500');
  const g2 = await waitFor(async () => {
    const d = await replay(cli, sf);
    return d.render_grid.row_spans.some((s) => s.text === '500') && d;
  }, { what: 'seq output' });
  assert.equal(g2.render_grid.scrollback_rows, 240);
  assert.equal(new Set(g2.render_grid.scrollback_spans.map((s) => s.row)).size <= 240, true);

  await srv.type(pane, 'tput smcup; printf "ALT-ON"; sleep 30');
  const g3 = await waitFor(async () => {
    const d = await replay(cli, sf);
    return d.render_grid.active_screen === 'alternate' && d.render_grid.row_spans.some((s) => s.text.includes('ALT-ON')) && d;
  }, { what: 'the alternate screen' });
  assert.equal(g3.render_grid.scrollback_rows, 0);
  assert.equal(g3.render_grid.scrollback_spans.length, 0);
  assert.equal(Math.max(...g3.render_grid.row_spans.map((s) => s.row)) < 40, true);
  await srv.runOk(['kill-window', '-t', pane]);
});

test('seq: a finite integer, equal across reads of an unchanged pane, different after one more character', { skip }, async () => {
  const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}', 'cat'])).trim();
  const sf = ids.mint(4, epoch, Number(pane.slice(1)));
  await srv.runOk(['send-keys', '-t', pane, '-l', 'abc']);
  await waitFor(async () => (await srv.capture(pane)).includes('abc'), { what: 'abc echoed' });
  const a = await replay(cli, sf);
  const b = await replay(cli, sf);
  assert.ok(Number.isInteger(a.seq) && Number.isFinite(a.seq), String(a.seq));
  assert.equal(a.seq, b.seq);
  await srv.runOk(['send-keys', '-t', pane, '-l', 'd']);
  await waitFor(async () => (await srv.capture(pane)).includes('abcd'), { what: 'd echoed' });
  const c = await replay(cli, sf);
  assert.notEqual(c.seq, a.seq);
  await srv.runOk(['kill-window', '-t', pane]);
});

test('read-screen: no trailing blank lines; --scrollback --lines 50 = the last 50 lines of the whole buffer', { skip }, async () => {
  const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}'])).trim();
  const sf = ids.mint(4, epoch, Number(pane.slice(1)));
  await srv.type(pane, 'seq 1 500');
  await waitFor(async () => /^500$/m.test(await srv.capture(pane)), { what: 'seq output' });
  await waitFor(async () => /\$ ?$/m.test((await srv.capture(pane)).trimEnd()), { what: 'the prompt after seq' });
  const plain = await x(cli, ['read-screen', '--surface', sf]);
  assert.equal(plain.err, null, plain.stderr);
  assert.ok(plain.stdout.endsWith('\n'));
  assert.ok(!/\n\s*\n$/.test(plain.stdout), 'no trailing blank lines');
  const sb = await x(cli, ['read-screen', '--surface', sf, '--scrollback', '--lines', '50']);
  assert.equal(sb.err, null, sb.stderr);
  const got = sb.stdout.split('\n');
  const full = (await srv.capture(pane, ['-S', '-'])).replace(/\n$/, '').split('\n');
  while (full.length && !full[full.length - 1].trim()) full.pop();
  assert.equal(got.length, 50);
  assert.deepEqual(got, full.slice(-50));
  await srv.runOk(['kill-window', '-t', pane]);
});

test('stale ids are refused: another epoch -> "not_found: stale id"; a pane id where a surface belongs -> not_found', { skip }, async () => {
  const pane = Number((await srv.runOk(['display', '-p', '-t', 'main', '#{pane_id}'])).trim().slice(1));
  for (const n of [pane, 999]) {           // a live pane number, and one that no longer exists at all
    const stale = ids.mint(4, epoch - 3600, n);
    const r1 = await x(cli, ['rpc', 'terminal.replay', JSON.stringify({ surface_id: stale })]);
    assert.ok(r1.err);
    assert.match(r1.stderr, /^not_found: stale id/);
    const r2 = await x(cli, ['read-screen', '--surface', stale]);
    assert.match(r2.stderr, /^not_found: stale id/);
    const r3 = await x(cli, ['read-screen', '--surface', stale, '--scrollback', '--lines', '10']);
    assert.match(r3.stderr, /^not_found: stale id/);
  }
  const wrongKind = ids.mint(3, epoch, pane);
  const r4 = await x(cli, ['rpc', 'terminal.replay', JSON.stringify({ surface_id: wrongKind })]);
  assert.match(r4.stderr, /^not_found/);
  const r5 = await x(cli, ['read-screen', '--surface', wrongKind]);
  assert.match(r5.stderr, /^not_found/);
  const staleWs = ids.mint(2, epoch - 3600, 0);
  const r6 = await x(cli, ['rpc', 'pane.list', JSON.stringify({ workspace_id: staleWs })]);
  assert.match(r6.stderr, /^not_found: stale id/);
  // exec's contract: err.code 1, empty stdout, pid untouched by a read
  assert.equal(r4.err.code, 1);
  assert.equal(r4.stdout, '');
});

test('list-windows, workspace list (all and per window), list-status', { skip }, async () => {
  const lw = await x(cli, ['list-windows', '--json']);
  const wins = JSON.parse(lw.stdout);
  assert.ok(wins.length >= 1);
  for (const w of wins) { assert.deepEqual(Object.keys(w).sort(), ['id', 'ref']); assert.equal(ids.parse(w.id).kind, 1); }
  await srv.runOk(['rename-window', '-t', 'main:0', 'named']);
  const all = JSON.parse((await x(cli, ['workspace', 'list', '--json'])).stdout);
  const per = JSON.parse((await x(cli, ['workspace', 'list', '--json', '--window', wins[0].id])).stdout);
  assert.deepEqual(per.workspaces.map((w) => w.id).sort(), all.workspaces.map((w) => w.id).sort());
  const named = all.workspaces.find((w) => w.title === 'named');
  assert.ok(named);
  assert.deepEqual(Object.keys(named).sort(), ['current_directory', 'custom_title', 'id', 'ref', 'title']);
  assert.equal(named.custom_title, 'named');                  // rename-window turns automatic-rename off
  assert.equal(named.current_directory, srv.dir);
  const st = await x(cli, ['list-status', '--workspace', named.ref]);
  assert.equal(st.err, null);
  assert.equal(st.stdout, '');
  const un = await x(cli, ['frobnicate']);
  assert.match(un.stderr, /^unsupported_backend: frobnicate has no tmux mapping/);
});

test('exec never calls back synchronously and calls back exactly once', { skip }, async () => {
  let calls = 0;
  let sync = true;
  await new Promise((resolve) => {
    cli.exec(['list-status', '--workspace', 'workspace:0'], { timeout: 1000 }, () => { calls++; assert.equal(sync, false); resolve(); });
    sync = false;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
});

test('tmux down -> tmux_unavailable (and no pid)', { skip }, async () => {
  const dead = require('../lib/tmux-cli').createTmuxCli({ tmuxBin: srv.tmuxBin, socket: path.join(srv.dir, 'nobody-here'), home: srv.dir });
  const r = await x(dead, TREE);
  assert.match(r.stderr, /^tmux_unavailable: /);
  assert.equal(r.pid, undefined);
});

test('isolation scan: every tmux spawn in the p18 tests passes -S <a mkdtemp path under os.tmpdir()>', async () => {
  const testDir = __dirname;
  const helper = fs.readFileSync(path.join(testDir, 'helpers', 'tmux-server.js'), 'utf8');
  // the helper's socket is <mkdtemp(os.tmpdir())>/s …
  assert.match(helper, /const dir = fs\.realpathSync\(fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'p18-tmux-'\)\)\);/);
  assert.match(helper, /const socket = path\.join\(dir, 's'\);/);
  // … and every place it starts tmux passes it with -S
  const spawnSites = [...helper.matchAll(/\b(spawn|execFile|spawnSync|execFileSync)\(\s*bin\s*,\s*\[([^\]]*)/g)];
  assert.ok(spawnSites.length >= 2);
  for (const m of spawnSites) {
    if (/'-V'/.test(m[2])) continue;                           // the version probe opens no socket
    assert.match(m[2], /'-S',\s*socket/, `helper spawn without -S socket: ${m[0]}`);
  }
  // the emulator the tests drive is always pinned to that socket, last in the options
  assert.match(helper, /createTmuxCli\(\{[^}]*\.\.\.\(extra \|\| \{\}\), socket \}\)/);
  // p18 test files never spawn tmux themselves, never build an emulator without a socket, and never
  // boot a tmux bridge without TMUX_SOCKET
  const files = fs.readdirSync(testDir).filter((f) => /^(tmux-.*\.test\.js|radar-tmux-identity\.test\.js|p18-.*\.mjs)$/.test(f));
  assert.ok(files.includes('tmux-cli-read.test.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    for (const m of src.matchAll(/createTmuxCli\(\{([^}]*)\}\)/g)) assert.match(m[1], /socket:/, `${f}: createTmuxCli without socket`);
    for (const m of src.matchAll(/\b(?:spawn|execFile|spawnSync|execFileSync)\(\s*([^,)]+)/g)) {
      assert.ok(!/tmux/i.test(m[1]) || /srv|server|helper/.test(m[1]), `${f}: direct tmux spawn ${m[0]}`);
    }
    if (/BACKEND:\s*'tmux'/.test(src)) assert.match(src, /TMUX_SOCKET:\s*\w/, `${f}: tmux bridge without TMUX_SOCKET`);
  }
  // and at runtime the socket really is under os.tmpdir()
  if (HAVE_TMUX) {
    assert.ok(srv.socket.startsWith(fs.realpathSync(os.tmpdir()) + path.sep), srv.socket);
    assert.equal(cli.socket, srv.socket);
    assert.notEqual(cli.socket, `/tmp/tmux-${process.getuid()}/default`);
  }
});
