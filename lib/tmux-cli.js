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
    const hello = await api._run(['display', '-p', '#{start_time} #{version}']);
    if (hello.code !== 0) throw new VerbError(`tmux_unavailable: ${clean(hello.stderr.trim()) || `tmux exited ${hello.code}`}`);
    const [st, version] = hello.stdout.trim().split(/\s+/);
    if (!versionOk(version)) throw new VerbError(`tmux_too_old: need ≥ ${MIN_VERSION.join('.')}, have ${version}`);
    const epoch = Number(st);
    if (!Number.isFinite(epoch)) throw new VerbError(`tmux_unavailable: unreadable start_time ${JSON.stringify(st)}`);
    // FIRST, so the very first shell of this server already carries the epoch (radar identity, §8)
    const envSet = await api._run(['set-environment', '-g', 'CMUX_TMUX_EPOCH', String(epoch)]);
    if (envSet.code !== 0) throw tmuxFailure(envSet);
    const ls = await api._run(['list-sessions', '-F', '#{session_id}']);
    let created = false;
    if ((ls.code === 0 && !ls.stdout.trim()) || (ls.code !== 0 && /no sessions/i.test(ls.stderr))) {
      const ns = await api._run(['new-session', '-d', '-s', session, '-c', home]);
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

  // A target as the bridge names it -> the tmux target. UUIDs must be of the verb's kind; refs
  // resolve by number alone (specs.md §5.3).
  function target(value, kind) {
    const s = String(value || '');
    const k = ids.KIND[kind];
    const p = ids.parse(s);
    if (p) {
      if (p.kind !== k) fail(`not_found: ${s}`);
      return { tmux: SIGIL[k] + p.n, n: p.n, epoch: p.epoch, id: s };
    }
    const n = ids.parseRef(s, k);
    if (n == null) fail(`not_found: ${s || `no ${kind} given`}`);
    return { tmux: SIGIL[k] + n, n, epoch: null, id: s };
  }
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
      'capture-pane', '-p', '-e', '-t', sf.tmux, '-S', `-${REPLAY_HISTORY}`]);
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
      case 'browser': return fail('unsupported_backend: browser surfaces need cmux');
      case 'rpc':
        if (v1 === 'pane.list') return verbPaneList(ctx, a);
        if (v1 === 'terminal.replay') return verbReplay(ctx, a);
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

module.exports = { createTmuxCli, resolveTmuxBin, defaultSocket, parseArgs, TREE_FMT, PANE_FMT, HDR_FMT, CELL_W, CELL_H };

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
