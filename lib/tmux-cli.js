'use strict';
// cmux CLI emulator over tmux — the BACKEND=tmux adapter (p18 specs.md §5).
//
// bridge.js builds cmux argv and parses cmux-shaped stdout. On a host with no cmux (a headless Mac
// whose users are never logged in to a desktop) this module takes that SAME argv and answers with
// cmux-shaped stdout/stderr/exit, driving a tmux server instead. Every bridge handler therefore runs
// unchanged, and the page receives the same JSON from both backends.
//
// Model (specs.md §4): cmux window = tmux session, cmux workspace = tmux window, cmux pane = tmux
// pane, and each pane holds exactly one surface (tab), which is that same tmux pane.
//
// Ids are minted by lib/tmux-ids.js from the tmux server's start_time. A UUID from another server
// epoch is refused as `not_found: stale id …` — a tmux restart renumbers panes from %0, and a cached
// id must never type into whichever pane now has that number.
//
//   createTmuxCli({ tmuxBin, socket, session, home, log }) -> { exec, ensure, _run }
//   node lib/tmux-cli.js <cmux argv…>     prints what exec would print (debug aid; TMUX_BIN,
//                                          TMUX_SOCKET and TMUX_SESSION from the environment)
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const ids = require('./tmux-ids');
const { ansiToGrid } = require('./tmux-grid');

const SEP = '\x1f';                 // unit separator between -F fields
const DEFAULT_TIMEOUT = 8000;
const REPLAY_HISTORY = 240;         // cmux's own terminal.replay scrollback cap (bridge.js REPLAY_SB_CAP)
const MIN_VERSION = [3, 2];         // -D (foreground server) and select-layout -E
const SIGIL = { 1: '$', 2: '@', 3: '%', 4: '%' };

// -F formats (specs.md §5.5). start_time rides along on every read so the epoch check is atomic
// with the data it guards.
const TREE_FMT = ['#{start_time}', '#{session_id}', '#{window_id}', '#{window_index}', '#{window_name}',
  '#{window_active}', '#{pane_id}', '#{pane_index}', '#{pane_active}', '#{pane_title}',
  '#{pane_current_command}', '#{host}'].join(SEP);
const PANE_FMT = ['#{start_time}', '#{window_width}', '#{window_height}', '#{pane_id}', '#{pane_index}',
  '#{pane_active}', '#{pane_left}', '#{pane_top}', '#{pane_width}', '#{pane_height}'].join(SEP);
const HDR_FMT = ['CMUXR1', '#{start_time}', '#{pane_width}', '#{pane_height}', '#{cursor_x}', '#{cursor_y}',
  '#{cursor_flag}', '#{alternate_on}', '#{history_size}'].join(SEP);
const WS_FMT = ['#{start_time}', '#{window_id}', '#{window_name}', '#{automatic-rename}',
  '#{pane_current_path}'].join(SEP);
const SESSION_FMT = ['#{start_time}', '#{session_id}'].join(SEP);
// Desktop pixels per tmux cell. The page only ever uses ratios, and panelayout's divider tolerances
// (EDGE_TOL = SPAN_MIN = 24 px) then see tmux's one-cell border as an 8 px / 16 px gap.
const CELL_W = 8;
const CELL_H = 16;
// The 18 keys bridge.js allows (CMUX_KEYS) -> tmux key names.
const KEYMAP = Object.freeze({
  enter: 'Enter', escape: 'Escape', tab: 'Tab', 'shift+tab': 'BTab', up: 'Up', down: 'Down', left: 'Left',
  right: 'Right', 'ctrl+c': 'C-c', 'ctrl+d': 'C-d', 'ctrl+l': 'C-l', 'ctrl+r': 'C-r', backspace: 'BSpace',
  space: 'Space', pageup: 'PPage', pagedown: 'NPage', home: 'Home', end: 'End',
});
// split / join flags per side: the new (or moved) pane lands on that side of its target
const SIDE_FLAGS = Object.freeze({ right: ['-h'], left: ['-h', '-b'], down: ['-v'], up: ['-v', '-b'] });
const DROP_TTL_MS = 15000;          // move-surface -> drag-surface-to-split pairing window

function resolveTmuxBin(explicit) {
  if (explicit) return explicit;
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) if (fs.existsSync(p)) return p;
  return 'tmux';
}
function defaultSocket() {
  return `${process.env.TMUX_TMPDIR || '/tmp'}/tmux-${process.getuid()}/default`;
}

class VerbError extends Error {}
const fail = (msg) => { throw new VerbError(msg); };
const clean = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '');
// tmux expands formats in some arguments (-c directories, window and session names): `#D` becomes a
// pane id, `#H` the host name. Caller text in those places must reach tmux literally.
const literal = (s) => String(s == null ? '' : s).replace(/#/g, '##');
const num = (tmuxId) => Number(String(tmuxId).replace(/^[$@%]/, ''));
const lines = (s) => String(s || '').split('\n').filter((l) => l.length);
const isBlank = (l) => !String(l).trim();

function versionOk(v) {
  const m = /(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return true;                       // unparseable (a dev build): let the server speak for itself
  const maj = Number(m[1]), min = Number(m[2]);
  return maj > MIN_VERSION[0] || (maj === MIN_VERSION[0] && min >= MIN_VERSION[1]);
}

// cmux argv -> { pos, flags, rest }. `rest` is everything after a bare `--` (typed text, a key).
const VALUE_FLAGS = new Set(['--surface', '--workspace', '--pane', '--window', '--type', '--direction',
  '--focus', '--cwd', '--command', '--action', '--title', '--lines', '--id-format']);
function parseArgs(args) {
  const flags = {};
  const pos = [];
  let rest = null;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { rest = args.slice(i + 1).map(String); break; }
    if (VALUE_FLAGS.has(a)) { flags[a.slice(2)] = args[i + 1] == null ? '' : String(args[i + 1]); i++; continue; }
    if (a.startsWith('--')) { flags[a.slice(2)] = true; continue; }
    pos.push(a);
  }
  return { pos, flags, rest };
}
function parseJson(s) {
  try { const v = JSON.parse(String(s || '{}')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

function createTmuxCli(opts) {
  const o = opts || {};
  const bin = resolveTmuxBin(o.tmuxBin || '');
  const socket = o.socket || defaultSocket();
  const session = o.session || 'main';
  const home = o.home || os.homedir();
  const log = typeof o.log === 'function' ? o.log : () => {};
  // The tmux client must never pick a target from an enclosing tmux: $TMUX names the caller's own
  // server and pane, which is exactly the wrong default for a detached bridge.
  const env = { ...process.env, LANG: 'en_US.UTF-8' };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const api = { exec, ensure, _run, socket, tmuxBin: bin, session };

  // ---- the one spawn point ----------------------------------------------------------------------
  function _run(tmuxArgs, runOpts) {
    const ro = runOpts || {};
    const timeout = Number(ro.timeout) > 0 ? Number(ro.timeout) : DEFAULT_TIMEOUT;
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(bin, ['-u', '-S', socket, ...tmuxArgs], { timeout, maxBuffer: 8 * 1024 * 1024, env },
          (err, stdout, stderr) => {
            let se = String(stderr || '');
            if (err && !se.trim()) se = err.killed ? `timed out after ${timeout}ms` : String(err.message || err);
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: se, pid: child.pid });
          });
      } catch (e) {
        resolve({ code: 1, stdout: '', stderr: String((e && e.message) || e), pid: undefined });
        return;
      }
      if (child.stdin) {
        child.stdin.on('error', () => {});   // tmux may exit before reading stdin
        if (typeof ro.input === 'string') child.stdin.end(ro.input); else child.stdin.end();
      }
    });
  }

  const unavailable = (stderr) => /no server running|error connecting|failed to connect|server exited|ENOENT|EACCES|No such file or directory|timed out after/i.test(stderr);
  const tmuxFailure = (r) => {
    const msg = clean(String(r.stderr || '').trim()) || `tmux exited ${r.code}`;
    return new VerbError(unavailable(r.stderr) ? `tmux_unavailable: ${msg}` : msg);
  };

  // ---- ensure(): server contact, the epoch variable, the default session (specs.md §5.6) --------
  let memo = null;
  let inflight = null;
  function ensure() {
    if (memo) return Promise.resolve(memo);
    if (inflight) return inflight;
    inflight = doEnsure().then(
      (m) => { memo = m; inflight = null; return m; },
      (e) => { inflight = null; throw e; });
    return inflight;
  }
  function resetEnsure() { memo = null; }
  async function doEnsure() {
    const hello = await api._run(['display', '-p', '#{start_time} #{version} #{pid}']);
    if (hello.code !== 0) throw new VerbError(`tmux_unavailable: ${clean(hello.stderr.trim()) || `tmux exited ${hello.code}`}`);
    const [st, version, serverPid] = hello.stdout.trim().split(/\s+/);
    if (!versionOk(version)) throw new VerbError(`tmux_too_old: need ≥ ${MIN_VERSION.join('.')}, have ${version}`);
    const epoch = Number(st);
    if (!Number.isFinite(epoch)) throw new VerbError(`tmux_unavailable: unreadable start_time ${JSON.stringify(st)}`);
    // FIRST, so the very first shell of this server already carries its identity (radar, §8). The
    // pid lets a hook tell THIS server's panes from those of a tmux started inside one of them.
    const envSet = await api._run(['set-environment', '-g', 'CMUX_TMUX_EPOCH', String(epoch), ';',
      'set-environment', '-g', 'CMUX_TMUX_PID', String(serverPid || '')]);
    if (envSet.code !== 0) throw tmuxFailure(envSet);
    const ls = await api._run(['list-sessions', '-F', '#{session_id}']);
    let created = false;
    if ((ls.code === 0 && !ls.stdout.trim()) || (ls.code !== 0 && /no sessions/i.test(ls.stderr))) {
      const ns = await api._run(['new-session', '-d', '-s', literal(session), '-c', literal(home)]);
      if (ns.code !== 0 && !/duplicate session/i.test(ns.stderr)) throw tmuxFailure(ns);
      created = ns.code === 0;
    } else if (ls.code !== 0) {
      throw tmuxFailure(ls);
    }
    log(`server epoch ${epoch}, tmux ${version}${created ? `, created session ${session}` : ''}`);
    return { epoch, version, created };
  }

  // ---- per-call plumbing ------------------------------------------------------------------------
  async function run(ctx, tmuxArgs, ro) {
    const left = ctx.deadline - Date.now();
    if (left <= 0) fail('tmux_unavailable: timed out');
    const r = await api._run(tmuxArgs, { timeout: left, input: ro && ro.input });
    if (ro && ro.effect && r.pid !== undefined) ctx.handle.pid = r.pid;
    return r;
  }
  async function must(ctx, tmuxArgs, ro) {
    const r = await run(ctx, tmuxArgs, ro);
    if (r.code !== 0) throw tmuxFailure(r);
    return r;
  }

  // A target as the bridge names it -> the tmux target. UUIDs must be of the verb's kind (specs.md
  // §5.3). Refs (`surface:12`) carry no epoch: after a tmux restart `surface:0` names the NEW server's
  // %0, a fresh shell. So a ref is accepted for a READ, and refused for anything that WRITES — the
  // page always writes by id, and a caller holding only a ref (radar's snapshot) must not type blind.
  function target(value, kind, write) {
    const s = String(value || '');
    const k = ids.KIND[kind];
    const p = ids.parse(s);
    if (p) {
      if (p.kind !== k) fail(`not_found: ${s}`);
      return { tmux: SIGIL[k] + p.n, n: p.n, epoch: p.epoch, id: s };
    }
    const n = ids.parseRef(s, k);
    if (n == null) fail(`not_found: ${s || `no ${kind} given`}`);
    if (write) fail(`not_found: ${s} (the tmux backend writes only by id: a ref carries no server epoch)`);
    return { tmux: SIGIL[k] + n, n, epoch: null, id: s };
  }
  const wtarget = (value, kind) => target(value, kind, true);
  const STALE = 'not_found: stale id (tmux server restarted)';
  function checkEpoch(live, ...targets) {
    for (const t of targets) if (t && t.epoch !== null && !ids.sameEpoch(t.epoch, live)) fail(STALE);
  }
  async function liveEpoch(ctx) {
    const r = await must(ctx, ['display', '-p', '#{start_time}']);
    return Number(r.stdout.trim());
  }
  // Writes: one epoch read BEFORE the side-effect child, so a stale id fails with handle.pid still
  // undefined — runSendCommand's proof that nothing was typed (bridge.js runSendCommand).
  async function preCheck(ctx, ...targets) {
    if (targets.some((t) => t && t.epoch !== null)) checkEpoch(await liveEpoch(ctx), ...targets);
  }
  // A read invocation failed: if the id is from another epoch say so, otherwise pass tmux's refusal on.
  async function readFailure(ctx, r, ...targets) {
    if (targets.some((t) => t && t.epoch !== null)) {
      const e = await run(ctx, ['display', '-p', '#{start_time}']);
      if (e.code === 0) checkEpoch(Number(e.stdout.trim()), ...targets);
    }
    throw tmuxFailure(r);
  }

  // ---- read verbs -------------------------------------------------------------------------------
  async function listTreeRows(ctx) {
    const r = await run(ctx, ['list-panes', '-a', '-F', TREE_FMT]);
    if (r.code !== 0) {
      if (/no current target|no sessions/i.test(r.stderr)) return [];
      throw tmuxFailure(r);
    }
    return lines(r.stdout).map((l) => l.split(SEP)).filter((f) => {
      if (f.length === 12) return true;
      log(`tree: skipped a row with ${f.length} fields`);
      return false;
    });
  }
  async function verbTree(ctx) {
    let e = await ensure();
    let rows = await listTreeRows(ctx);
    // A new server epoch, or a server whose last session was closed: ensure() again (it sets the
    // epoch variable and makes `main` if nothing is left), then read once more.
    if (!rows.length || Number(rows[0][0]) !== e.epoch) {
      resetEnsure();
      e = await ensure();
      rows = await listTreeRows(ctx);
    }
    const windows = [];
    const wins = new Map();
    const workspaces = new Map();
    for (const f of rows) {
      const [st, sid, wid, , wname, wact, pid, pidx, pact, ptitle, pcmd, host] = f;
      const epoch = Number(st);
      let win = wins.get(sid);
      if (!win) {
        win = { id: ids.mint(1, epoch, num(sid)), ref: ids.ref(1, num(sid)), workspaces: [] };
        wins.set(sid, win);
        windows.push(win);
      }
      let ws = workspaces.get(wid);
      if (!ws) {
        ws = { id: ids.mint(2, epoch, num(wid)), ref: ids.ref(2, num(wid)), title: clean(wname), selected: wact === '1', panes: [] };
        workspaces.set(wid, ws);
        win.workspaces.push(ws);
      }
      const sfId = ids.mint(4, epoch, num(pid));
      const sfRef = ids.ref(4, num(pid));
      // tmux's default pane title is the host name, which says nothing about the tab
      const title = ptitle && ptitle !== host ? clean(ptitle) : clean(pcmd);
      ws.panes.push({
        id: ids.mint(3, epoch, num(pid)),
        ref: ids.ref(3, num(pid)),
        index: Number(pidx),
        focused: pact === '1',
        selected_surface_id: sfId,
        selected_surface_ref: sfRef,
        surfaces: [{ id: sfId, ref: sfRef, title, type: 'terminal', selected: pact === '1', selected_in_pane: true }],
      });
    }
    return JSON.stringify({ windows });
  }

  async function verbListWindows(ctx) {
    await ensure();
    const r = await must(ctx, ['list-sessions', '-F', SESSION_FMT]);
    return JSON.stringify(lines(r.stdout).map((l) => {
      const [st, sid] = l.split(SEP);
      return { id: ids.mint(1, Number(st), num(sid)), ref: ids.ref(1, num(sid)) };
    }));
  }

  async function verbWorkspaceList(ctx, a) {
    await ensure();
    const win = a.flags.window ? target(a.flags.window, 'window') : null;
    const r = await run(ctx, win ? ['list-windows', '-t', win.tmux, '-F', WS_FMT] : ['list-windows', '-a', '-F', WS_FMT]);
    if (r.code !== 0) {
      if (!win && /no current target|no sessions/i.test(r.stderr)) return JSON.stringify({ workspaces: [] });
      await readFailure(ctx, r, win);
    }
    const rows = lines(r.stdout).map((l) => l.split(SEP));
    if (rows.length) checkEpoch(Number(rows[0][0]), win);
    return JSON.stringify({
      workspaces: rows.map(([st, wid, name, autoRename, cwd]) => ({
        id: ids.mint(2, Number(st), num(wid)),
        ref: ids.ref(2, num(wid)),
        title: clean(name),
        custom_title: autoRename === '0' || autoRename === 'off' ? clean(name) : '',
        current_directory: cwd || '',
      })),
    });
  }

  async function verbPaneList(ctx, a) {
    await ensure();
    const p = parseJson(a.pos[2]);
    const ws = target(p.workspace_id || p.workspace, 'workspace');
    const r = await run(ctx, ['list-panes', '-t', ws.tmux, '-F', PANE_FMT]);
    if (r.code !== 0) await readFailure(ctx, r, ws);
    const rows = lines(r.stdout).map((l) => l.split(SEP));
    if (!rows.length) fail(`not_found: ${ws.id}`);
    checkEpoch(Number(rows[0][0]), ws);
    const [, winW, winH] = rows[0].map(Number);
    return JSON.stringify({
      container_frame: { x: 0, y: 0, width: winW * CELL_W, height: winH * CELL_H },
      panes: rows.map((f) => {
        const [st, , , pid, pidx, pact, left, top, width, height] = f;
        const epoch = Number(st);
        const n = num(pid);
        return {
          id: ids.mint(3, epoch, n),
          ref: ids.ref(3, n),
          index: Number(pidx),
          focused: pact === '1',
          columns: Number(width),
          rows: Number(height),
          pixel_frame: { x: Number(left) * CELL_W, y: Number(top) * CELL_H, width: Number(width) * CELL_W, height: Number(height) * CELL_H },
          selected_surface_id: ids.mint(4, epoch, n),
          selected_surface_ref: ids.ref(4, n),
          surface_ids: [ids.mint(4, epoch, n)],
          surface_refs: [ids.ref(4, n)],
        };
      }),
    });
  }

  // `seq` is only ever compared for equality (expect_seq), so any value that is equal exactly when
  // the screen and cursor are equal keeps the precondition's meaning (specs.md §6).
  const replaySeq = (capture, h) => parseInt(crypto.createHash('md5')
    .update(`${capture}${SEP}${h.cx},${h.cy},${h.cflag},${h.alt}`).digest('hex').slice(0, 12), 16);

  async function verbReplay(ctx, a) {
    await ensure();
    const p = parseJson(a.pos[2]);
    const sf = target(p.surface_id || p.surface, 'surface');
    // ONE invocation: the header and the capture describe the same instant. The alternate screen
    // keeps the primary history behind it (F17), so its capture is cut to the visible rows below.
    const r = await run(ctx, ['display', '-p', '-t', sf.tmux, HDR_FMT, ';',
      'capture-pane', '-p', '-e', '-N', '-t', sf.tmux, '-S', `-${REPLAY_HISTORY}`]);
    if (r.code !== 0) await readFailure(ctx, r, sf);
    const nl = r.stdout.indexOf('\n');
    const hdr = r.stdout.slice(0, nl < 0 ? undefined : nl).split(SEP);
    if (hdr[0] !== 'CMUXR1' || hdr.length !== 9) fail(`tmux_unavailable: unexpected replay header`);
    const [, st, w, hgt, cx, cy, cflag, alt] = hdr;
    checkEpoch(Number(st), sf);
    const rows = Number(hgt);
    let capture = nl < 0 ? '' : r.stdout.slice(nl + 1);
    if (alt === '1') capture = capture.replace(/\n$/, '').split('\n').slice(-rows).join('\n') + '\n';
    const renderGrid = ansiToGrid(capture, {
      columns: Number(w), rows, alt: alt === '1',
      cursor: { column: Number(cx), row: Number(cy), visible: cflag === '1' },
    });
    return JSON.stringify({ seq: replaySeq(capture, { cx, cy, cflag, alt }), render_grid: renderGrid });
  }

  async function verbReadScreen(ctx, a) {
    await ensure();
    const sf = target(a.flags.surface, 'surface');
    const n = parseInt(a.flags.lines, 10);
    const scroll = !!a.flags.scrollback;
    const range = scroll ? ['-S', Number.isFinite(n) && n > 0 ? `-${n}` : '-'] : [];
    const r = await run(ctx, ['display', '-p', '-t', sf.tmux, '#{start_time}', ';', 'capture-pane', '-p', '-t', sf.tmux, ...range]);
    if (r.code !== 0) await readFailure(ctx, r, sf);
    const nl = r.stdout.indexOf('\n');
    checkEpoch(Number(r.stdout.slice(0, nl)), sf);
    const out = r.stdout.slice(nl + 1).replace(/\n$/, '').split('\n');
    while (out.length && isBlank(out[out.length - 1])) out.pop();
    if (scroll) return (Number.isFinite(n) && n > 0 ? out.slice(-n) : out).join('\n');
    return out.length ? out.join('\n') + '\n' : '';
  }

  // ---- write verbs (specs.md §5.4) --------------------------------------------------------------
  // Every write resolves its ids, runs preCheck (the epoch read) and only then spawns the child that
  // changes something — marked `effect`, which is what sets handle.pid.
  let bufSeq = 0;
  const moves = new Map();          // surface id -> { pane, at }: the centre drop an edge drop refines

  // Typed text travels on stdin (load-buffer -), never on an argv another local user could read with
  // ps, and the buffer is deleted by the paste that uses it (D6, F20).
  async function pasteInto(ctx, pane, text, bracketed) {
    const buf = `cmuxr-${process.pid}-${++bufSeq}`;
    const r = await run(ctx, ['load-buffer', '-b', buf, '-', ';',
      'paste-buffer', '-d', ...(bracketed ? ['-p'] : []), '-b', buf, '-t', pane], { input: text, effect: true });
    if (r.code !== 0) {
      await api._run(['delete-buffer', '-b', buf], { timeout: 2000 });   // a paste that failed left it behind
      throw tmuxFailure(r);
    }
  }

  async function verbSend(ctx, a) {
    await ensure();
    const sf = wtarget(a.flags.surface, 'surface');
    const text = (a.rest || []).join(' ');
    await preCheck(ctx, sf);
    if (!text) return '';
    // bracketed paste only for multi-line text: Claude Code then takes a compose as ONE paste
    await pasteInto(ctx, sf.tmux, text, text.includes('\n'));
    return '';
  }

  async function verbSendKey(ctx, a) {
    await ensure();
    const sf = wtarget(a.flags.surface, 'surface');
    const key = String((a.rest && a.rest[0]) || a.pos[1] || '').toLowerCase();
    const mapped = KEYMAP[key];
    if (!mapped) fail(`invalid_params: unknown key ${JSON.stringify(key)}`);
    await preCheck(ctx, sf);
    await must(ctx, ['send-keys', '-t', sf.tmux, mapped], { effect: true });
    return '';
  }

  // A new TAB in a pane: tmux panes hold one surface each, so it becomes a split of that pane
  // (specs.md §4.3), across the pane's longer side.
  async function verbNewSurface(ctx, a) {
    await ensure();
    if (a.flags.type && a.flags.type !== 'terminal') fail('unsupported_backend: browser surfaces need cmux');
    const ws = wtarget(a.flags.workspace, 'workspace');
    const pane = a.flags.pane ? wtarget(a.flags.pane, 'pane') : null;
    await preCheck(ctx, ws, pane);
    const g = await must(ctx, ['display', '-p', '-t', pane ? pane.tmux : ws.tmux,
      ['#{pane_id}', '#{pane_width}', '#{pane_height}', '#{window_id}'].join(SEP)]);
    const [pid, w, h, wid] = g.stdout.trim().split(SEP);
    if (wid !== ws.tmux) fail(`not_found: ${pane ? pane.id : ws.id} is not in ${ws.id}`);
    const r = await must(ctx, ['split-window', '-d', '-t', pid, Number(w) >= 2 * Number(h) ? '-h' : '-v',
      '-c', '#{pane_current_path}', '-P', '-F', '#{pane_id}'], { effect: true });
    return `OK ${ids.ref(4, num(r.stdout.trim()))}`;
  }

  async function verbNewWorkspace(ctx, a) {
    await ensure();
    const cwd = typeof a.flags.cwd === 'string' ? a.flags.cwd : '';
    const command = typeof a.flags.command === 'string' ? a.flags.command : '';
    const ls = await must(ctx, ['list-sessions', '-F', `#{session_id}${SEP}#{session_name}`]);
    const sessions = lines(ls.stdout).map((l) => l.split(SEP));
    const pick = sessions.find(([, name]) => name === session) || sessions[0];
    const fmt = `#{window_id}${SEP}#{pane_id}`;
    const dir = cwd ? ['-c', literal(cwd)] : [];
    // new-window without -d: the new workspace becomes its session's current window (--focus true)
    const r = pick
      ? await must(ctx, ['new-window', '-t', `${pick[0]}:`, '-P', '-F', fmt, ...dir], { effect: true })
      : await must(ctx, ['new-session', '-d', '-s', literal(session), '-P', '-F', fmt, ...dir], { effect: true });
    const [wid, pid] = r.stdout.trim().split(SEP);
    if (command) {
      await pasteInto(ctx, pid, command, false);
      await must(ctx, ['send-keys', '-t', pid, 'Enter'], { effect: true });
    }
    return `OK ${ids.ref(2, num(wid))}`;
  }

  // "Is this the last pane?" and the kill are ONE tmux command (if-shell -F runs in the server,
  // with no shell and nothing between the test and the kill), so two closes racing on a two-pane
  // window can never both pass the check and take the workspace down.
  async function verbCloseSurface(ctx, a) {
    await ensure();
    const sf = wtarget(a.flags.surface, 'surface');
    const ws = a.flags.workspace ? wtarget(a.flags.workspace, 'workspace') : null;
    await preCheck(ctx, sf, ws);
    if (ws) {
      const g = await must(ctx, ['display', '-p', '-t', sf.tmux, '#{window_id}']);
      if (g.stdout.trim() !== ws.tmux) fail(`not_found: ${sf.id} is not in ${ws.id}`);
    }
    const r = await must(ctx, ['if-shell', '-F', '-t', sf.tmux, '#{==:#{window_panes},1}',
      'display-message -p CMUXR-LAST', `kill-pane -t ${sf.tmux}`], { effect: true });
    if (r.stdout.trim() === 'CMUXR-LAST') fail('invalid_state: Cannot close the last surface');
    return 'OK';
  }

  async function verbCloseWorkspace(ctx, a) {
    await ensure();
    const ws = wtarget(a.flags.workspace, 'workspace');
    await preCheck(ctx, ws);
    await must(ctx, ['kill-window', '-t', ws.tmux], { effect: true });
    return 'OK';
  }

  async function verbWorkspaceAction(ctx, a) {
    await ensure();
    const action = a.flags.action;
    const ws = wtarget(a.flags.workspace, 'workspace');
    if (action === 'rename') {
      await preCheck(ctx, ws);
      await must(ctx, ['rename-window', '-t', ws.tmux, '--', literal(a.flags.title || '')], { effect: true });
      return 'OK';
    }
    if (action === 'clear-name') {
      await preCheck(ctx, ws);
      await must(ctx, ['set-option', '-w', '-t', ws.tmux, 'automatic-rename', 'on'], { effect: true });
      return 'OK';
    }
    return unsupported(`workspace-action ${action || ''}`.trim());
  }

  // Splits the workspace's ACTIVE pane — the bridge focuses the chosen pane first, as with cmux.
  async function verbNewPane(ctx, a) {
    await ensure();
    if (a.flags.type === 'browser') fail('unsupported_backend: browser surfaces need cmux');
    const side = SIDE_FLAGS[a.flags.direction];
    if (!side) fail(`invalid_params: direction must be left, right, up or down`);
    const ws = wtarget(a.flags.workspace, 'workspace');
    await preCheck(ctx, ws);
    await must(ctx, ['split-window', '-d', '-t', ws.tmux, ...side, '-c', '#{pane_current_path}'], { effect: true });
    return 'OK';
  }

  async function verbFocusPane(ctx, a) {
    await ensure();
    const pane = wtarget(a.flags.pane, 'pane');
    const ws = a.flags.workspace ? wtarget(a.flags.workspace, 'workspace') : null;
    await preCheck(ctx, pane, ws);
    await must(ctx, ['select-pane', '-t', pane.tmux], { effect: true });
    return 'OK';
  }

  async function verbSurfaceFocus(ctx, a) {
    await ensure();
    const p = parseJson(a.pos[2]);
    const sf = wtarget(p.surface_id || p.surface, 'surface');
    await preCheck(ctx, sf);
    await must(ctx, ['select-pane', '-t', sf.tmux], { effect: true });
    return '{}';
  }

  // Centre drop: the dragged pane moves into the target's cell, stacked below it; the cell it left
  // collapses. Remembered so a following edge drop knows where the drop happened.
  async function verbMoveSurface(ctx, a) {
    await ensure();
    const sf = wtarget(a.flags.surface, 'surface');
    const pane = wtarget(a.flags.pane, 'pane');
    const ws = a.flags.workspace ? wtarget(a.flags.workspace, 'workspace') : null;
    await preCheck(ctx, sf, pane, ws);
    await must(ctx, ['join-pane', '-d', '-v', '-s', sf.tmux, '-t', pane.tmux], { effect: true });
    moves.set(sf.id.toLowerCase(), { pane: pane.tmux, at: Date.now() });
    return 'OK';
  }

  // Edge drop = move-surface, then this: re-join the dragged pane on the requested side of the pane
  // it was dropped on.
  async function verbDragToSplit(ctx, a) {
    await ensure();
    const edge = a.pos[1];
    const side = SIDE_FLAGS[edge];
    if (!side) fail('invalid_params: edge must be left, right, up or down');
    const sf = wtarget(a.flags.surface, 'surface');
    const ws = a.flags.workspace ? wtarget(a.flags.workspace, 'workspace') : null;
    const key = sf.id.toLowerCase();
    const rec = moves.get(key);
    if (!rec || Date.now() - rec.at > DROP_TTL_MS) { moves.delete(key); fail('invalid_state: no drop target recorded'); }
    await preCheck(ctx, sf, ws);
    await must(ctx, ['join-pane', '-d', ...side, '-s', sf.tmux, '-t', rec.pane], { effect: true });
    moves.delete(key);
    return 'OK';
  }

  // pane.resize (specs.md §5.4 "Resize", the F18 trap). The bridge asks to push ONE border of the
  // named pane outward by `amount` desktop px. tmux's resize-pane on a pane with a sibling on its
  // right/below moves THAT side, so a push of the right/lower border is a resize of the pane itself
  // and a push of the left/upper border is a resize of the neighbour across it.
  async function verbPaneResize(ctx, a) {
    await ensure();
    const p = parseJson(a.pos[2]);
    const me = wtarget(p.pane_id || p.pane, 'pane');
    const dir = String(p.direction || '');
    if (!SIDE_FLAGS[dir]) fail('invalid_params: direction must be left, right, up or down');
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount <= 0) fail('invalid_params: amount must be a positive number');
    await preCheck(ctx, me);
    const cellPx = dir === 'left' || dir === 'right' ? CELL_W : CELL_H;
    const cells = Math.floor((amount + cellPx / 2 - 1) / cellPx);
    if (cells < 1) fail('invalid_state: below one cell');
    const g = await must(ctx, ['list-panes', '-t', me.tmux, '-F', '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}']);
    const panes = lines(g.stdout).map((l) => {
      const [id, left, top, w, h] = l.split(' ');
      return { id, left: Number(left), top: Number(top), w: Number(w), h: Number(h) };
    });
    const X = panes.find((q) => q.id === me.tmux);
    if (!X) fail(`not_found: ${me.id}`);
    const rowsOverlap = (q) => q.top < X.top + X.h && X.top < q.top + q.h;
    const colsOverlap = (q) => q.left < X.left + X.w && X.left < q.left + q.w;
    const facing = {
      right: (q) => q.left === X.left + X.w + 1 && rowsOverlap(q),
      left: (q) => q.left + q.w + 1 === X.left && rowsOverlap(q),
      down: (q) => q.top === X.top + X.h + 1 && colsOverlap(q),
      up: (q) => q.top + q.h + 1 === X.top && colsOverlap(q),
    }[dir];
    const N = panes.find((q) => q !== X && facing(q));
    if (!N) fail('invalid_state: Pane has no adjacent border');
    const args = {
      right: ['-t', X.id, '-R'], down: ['-t', X.id, '-D'], left: ['-t', N.id, '-L'], up: ['-t', N.id, '-U'],
    }[dir];
    await must(ctx, ['resize-pane', ...args, String(cells)], { effect: true });
    return '{}';
  }

  async function verbEqualize(ctx, a) {
    await ensure();
    const p = parseJson(a.pos[2]);
    const ws = wtarget(p.workspace_id || p.workspace, 'workspace');
    await preCheck(ctx, ws);
    const g = await must(ctx, ['list-panes', '-t', ws.tmux, '-F', '#{pane_id}']);
    const chain = [];
    for (const pid of lines(g.stdout)) chain.push(...(chain.length ? [';'] : []), 'select-layout', '-t', pid, '-E');
    if (chain.length) await must(ctx, chain, { effect: true });
    return '{}';
  }

  // ---- dispatch ---------------------------------------------------------------------------------
  const unsupported = (verb) => fail(`unsupported_backend: ${verb} has no tmux mapping`);
  async function dispatch(args, ctx) {
    const a = parseArgs(args);
    const [v0, v1] = a.pos;
    switch (v0) {
      case 'tree': return verbTree(ctx, a);
      case 'list-windows': return verbListWindows(ctx, a);
      case 'workspace': return v1 === 'list' ? verbWorkspaceList(ctx, a) : unsupported(`workspace ${v1 || ''}`.trim());
      case 'list-status': return '';        // no sidebar status source on tmux (specs.md §7.3)
      case 'read-screen': return verbReadScreen(ctx, a);
      case 'send': return verbSend(ctx, a);
      case 'send-key': return verbSendKey(ctx, a);
      case 'new-surface': return verbNewSurface(ctx, a);
      case 'new-workspace': return verbNewWorkspace(ctx, a);
      case 'close-surface': return verbCloseSurface(ctx, a);
      case 'close-workspace': return verbCloseWorkspace(ctx, a);
      case 'workspace-action': return verbWorkspaceAction(ctx, a);
      case 'new-pane': return verbNewPane(ctx, a);
      case 'focus-pane': return verbFocusPane(ctx, a);
      case 'move-surface': return verbMoveSurface(ctx, a);
      case 'drag-surface-to-split': return verbDragToSplit(ctx, a);
      // every tmux pane holds exactly one surface — cmux's own refusal for that case, verbatim
      case 'split-off': return fail('invalid_state: splitting off would leave the source pane empty');
      case 'browser': return fail('unsupported_backend: browser surfaces need cmux');
      case 'rpc':
        if (v1 === 'pane.list') return verbPaneList(ctx, a);
        if (v1 === 'terminal.replay') return verbReplay(ctx, a);
        if (v1 === 'surface.focus') return verbSurfaceFocus(ctx, a);
        if (v1 === 'pane.resize') return verbPaneResize(ctx, a);
        if (v1 === 'workspace.equalize_splits') return verbEqualize(ctx, a);
        return unsupported(`rpc ${v1 || ''}`.trim());
      default: return unsupported(v0 || '(none)');
    }
  }

  // exec(args, { timeout }, cb) — execFile's contract as bridge.js uses it: returns a handle at
  // once, calls cb(err, stdout, stderr) exactly once and never synchronously. handle.pid is the pid
  // of the tmux child that performed the side effect, and stays undefined when the verb failed
  // before any such child was spawned (stale id, bad arguments, tmux down).
  function exec(args, execOpts, cb) {
    if (typeof execOpts === 'function') { cb = execOpts; execOpts = {}; }
    const timeout = Number(execOpts && execOpts.timeout) > 0 ? Number(execOpts.timeout) : DEFAULT_TIMEOUT;
    const handle = { pid: undefined };
    const ctx = { deadline: Date.now() + timeout, handle };
    Promise.resolve()
      .then(() => dispatch(Array.isArray(args) ? args.map(String) : [], ctx))
      .then((out) => ({ out }), (e) => ({ e }))
      .then(({ out, e }) => setImmediate(() => {
        if (!e) return cb(null, out == null ? '' : String(out), '');
        const msg = e instanceof VerbError ? e.message : `internal_error: ${(e && e.message) || e}`;
        cb(Object.assign(new Error(msg), { code: 1 }), '', msg);
      }));
    return handle;
  }

  return api;
}

module.exports = { createTmuxCli, resolveTmuxBin, defaultSocket, parseArgs, KEYMAP, TREE_FMT, PANE_FMT, HDR_FMT, CELL_W, CELL_H };

if (require.main === module) {
  const cli = createTmuxCli({
    tmuxBin: process.env.TMUX_BIN || '',
    socket: process.env.TMUX_SOCKET || '',
    session: process.env.TMUX_SESSION || 'main',
    log: (m) => console.error(`tmux: ${m}`),
  });
  cli.exec(process.argv.slice(2), { timeout: 15000 }, (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n');
    if (err) { process.stderr.write(`${stderr}\n`); process.exitCode = 1; }
  });
}
