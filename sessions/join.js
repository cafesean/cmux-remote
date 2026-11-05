'use strict';
// p41 pane <-> transcript join: which transcript file a pane is showing. Two exports:
//
//   transcriptFor(surfaceId, deps) -> Promise<{kind:'claude'|'codex', path, sessionId}|null>
//   watchJoin(surfaceId, onChange, deps) -> stop()
//
// Primary signal is the radar hook-event log: the newest event for the surface that carries a
// transcriptPath (the same lookup detect.js uses, so a /clear or /resume, which starts a new
// sessionId and file under the same pane, shows up as soon as its hook fires). Without events:
//   Claude  the pane's cwd slugged like Claude Code does (every non-alphanumeric -> '-', so / and .
//           both become -) -> ~/.claude/projects/<slug>/*.jsonl, newest mtime at or after the
//           process start.
//   Codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, newest first; line 1 is a `session_meta`
//           record whose payload carries {id, cwd}. Only that first line is read, per candidate.
// When both agents have a candidate the newer file wins.
//
// The event log, the clock, the file system and the pane cwd/start time are injected (deps), so tests
// never touch a real disk. cwdFor/startedAt are the bridge's to supply on cmux (its workspace cwd);
// the defaults only know tmux panes (`%N`).
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { latestSurfaceEvent } = require('./detect');
const tmuxCli = require('../lib/tmux-cli');

// How often watchJoin re-resolves. A hook-driven switch lands in the log within a poll; the fallback
// (no hooks) needs the poll anyway. LIMITS.md row.
const WATCH_POLL_MS = 5000;
// Codex files are walked newest day first; this bounds how many first lines one resolve reads.
const MAX_CODEX_CANDIDATES = 200;
const TMUX_TIMEOUT = 3000;

const slugOf = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
const isCodexPath = (p) => /[\\/]\.codex[\\/]sessions[\\/]/.test(String(p));

// ---- path containment ----------------------------------------------------------------------------
// A transcript path is served to the phone later, and a hook event is just a line in a log any local
// writer can append to. So a path is used only when it is a `.jsonl` file that, once symlinks and
// `..` are resolved, sits inside the agents' own transcript roots.
// A11: also the per-account config dirs `cswap run` makes: ~/.claude-swap-backup/sessions/<n-email>/projects.
// Nothing else is added to the allow-list.
const SWAP = { dir: ['.claude-swap-backup', 'sessions'], maxAccounts: 64 };   // LIMITS.md row: maxAccounts
const rootsOf = (home) => [path.join(home, '.claude', 'projects'), path.join(home, '.codex', 'sessions')];
const swapBase = (home) => path.join(home, ...SWAP.dir);
const isSwapProjects = (home, r) => {
  const b = swapBase(home) + path.sep;
  if (!r.startsWith(b)) return false;
  const parts = r.slice(b.length).split(path.sep);
  return parts.length > 2 && parts[0] && parts[1] === 'projects';
};
async function swapRoots(home, fs) {
  let names = [];
  try { names = await fs.readdir(swapBase(home)); } catch (_) { return []; }
  return names.slice(0, SWAP.maxAccounts).map((n) => path.join(swapBase(home), n, 'projects'));
}
const within = (root, p) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// Cheap lexical screen (no disk): string, absolute, `.jsonl`, inside a root after `..` is collapsed.
function lexicallyAllowed(p, home) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  const r = path.resolve(p);
  return rootsOf(home).some((root) => within(root, r)) || isSwapProjects(home, r);
}

// The real, symlink-free path when `p` is allowed, else null. A missing file or root is not allowed.
async function allowedRealPath(p, deps) {
  const d = deps || {};
  const home = d.home || os.homedir();
  const fs = d.fs || defaultFs;
  if (!lexicallyAllowed(p, home)) return null;
  try {
    const real = await fs.realpath(path.resolve(p));
    if (!real.endsWith('.jsonl')) return null;
    for (const root of [...rootsOf(home), ...(await swapRoots(home, fs))]) {
      let realRoot;
      try { realRoot = await fs.realpath(root); } catch (_) { continue; }
      if (within(realRoot, real)) return real;
    }
  } catch (_) { /* unresolvable: not allowed */ }
  return null;
}

const isAllowedTranscriptPath = async (p, deps) => (await allowedRealPath(p, deps)) !== null;

// ---- default injected pieces -------------------------------------------------------------------

const defaultFs = {
  readdir: (dir) => fsp.readdir(dir),
  realpath: (p) => fsp.realpath(p),
  stat: (p) => fsp.stat(p),
  async firstLine(p) {
    let fh;
    try {
      fh = await fsp.open(p, 'r');
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
      const s = buffer.toString('utf8', 0, bytesRead);
      const nl = s.indexOf('\n');
      return nl < 0 ? s : s.slice(0, nl);
    } catch (_) { return null; } finally { if (fh) await fh.close().catch(() => {}); }
  },
};

function tmuxDisplay(paneId, format) {
  return new Promise((resolve) => {
    execFile(tmuxCli.resolveTmuxBin(process.env.TMUX_BIN || ''),
      ['-S', process.env.TMUX_SOCKET || tmuxCli.defaultSocket(), 'display-message', '-p', '-t', paneId, format],
      { timeout: TMUX_TIMEOUT }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}
const isPane = (id) => /^%\d+$/.test(String(id));
const defaultCwdFor = async (id) => (isPane(id) ? tmuxDisplay(id, '#{pane_current_path}') : null);
// tmux knows when the pane's process began; cmux gives no equivalent, so there the bound is unknown.
const defaultStartedAt = async (id) => {
  if (!isPane(id)) return null;
  const s = Number(await tmuxDisplay(id, '#{pane_start_time}'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
};

// ---- fallbacks -----------------------------------------------------------------------------------

async function list(fs, dir) { try { return await fs.readdir(dir); } catch (_) { return []; } }
async function mtimeOf(fs, p) { try { return (await fs.stat(p)).mtimeMs; } catch (_) { return 0; } }

async function claudeByCwd(cwd, since, deps) {
  const fs = deps.fs || defaultFs;
  const home = deps.home || os.homedir();
  // ~/.claude plus every `cswap run` account dir; the newest matching transcript across them wins.
  const dirs = [path.join(home, '.claude', 'projects', slugOf(cwd))];
  for (const r of await swapRoots(home, fs)) dirs.push(path.join(r, slugOf(cwd)));
  let best = null;
  for (const dir of dirs) {
    for (const name of await list(fs, dir)) {
      if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;   // agent-*: sub-agent side threads
      const p = path.join(dir, name);
      const mtime = await mtimeOf(fs, p);
      if (mtime < since || (best && mtime <= best.mtime)) continue;
      best = { kind: 'claude', path: p, sessionId: name.slice(0, -'.jsonl'.length), mtime };
    }
  }
  return best;
}

const desc = (a) => a.slice().sort().reverse();

async function codexByCwd(cwd, since, deps) {
  const fs = deps.fs || defaultFs;
  const root = path.join(deps.home || os.homedir(), '.codex', 'sessions');
  let seen = 0;
  for (const y of desc(await list(fs, root))) {
    for (const m of desc(await list(fs, path.join(root, y)))) {
      for (const d of desc(await list(fs, path.join(root, y, m)))) {
        const dayDir = path.join(root, y, m, d);
        for (const name of desc(await list(fs, dayDir))) {   // names embed the start time: newest first
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          if (++seen > MAX_CODEX_CANDIDATES) return null;
          const p = path.join(dayDir, name);
          const mtime = await mtimeOf(fs, p);
          if (mtime < since) continue;
          let meta = null;
          try { meta = JSON.parse(await fs.firstLine(p)); } catch (_) { continue; }
          const pl = meta && meta.payload;
          if (pl && pl.cwd === cwd && pl.id) return { kind: 'codex', path: p, sessionId: String(pl.id), mtime };
        }
      }
    }
  }
  return null;
}

// ---- join ----------------------------------------------------------------------------------------

// surface: an id string, or a loadTree tab {id, ref}.
async function transcriptFor(surface, deps) {
  const d = deps || {};
  const s = typeof surface === 'string' ? { id: surface } : (surface || {});
  const id = s.id || s.ref;
  if (!id) return null;

  // Two candidates, newest file wins (both pass the containment check): the live process's own
  // sessions file (sessions/procs.js, injected by routes as deps.agentFor: it sees through tmux and
  // wrappers, where hook events can carry a stale surface after a reattach) and the newest hook event
  // for the surface (which follows a /clear or /resume as soon as its hook fires).
  const home = d.home || os.homedir();
  const fsx = d.fs || defaultFs;
  const cands = [];
  if (d.agentFor) {
    let a = null;
    try { a = await d.agentFor(s); } catch (_) { a = null; }
    const real = a && a.transcriptPath && await allowedRealPath(a.transcriptPath, d);
    if (real) cands.push({ kind: 'claude', path: real, sessionId: a.sessionId });
  }
  // The lexical screen runs inside the event lookup, so a bad newest event falls back to the next
  // good one; the realpath check then decides on the winner, and a failure falls to the cwd path.
  const ev = await latestSurfaceEvent(s, d, (e) => lexicallyAllowed(e.transcriptPath, home));
  if (ev) {
    const real = await allowedRealPath(ev.transcriptPath, d);
    if (real) cands.push({ kind: isCodexPath(real) ? 'codex' : 'claude', path: real, sessionId: ev.sessionId });
  }
  if (cands.length) {
    let best = null;
    for (const c of cands) { const m = await mtimeOf(fsx, c.path); if (!best || m > best.m) best = { c, m }; }
    return best.c;
  }

  let cwd = null;
  let since = 0;
  try {
    cwd = await (d.cwdFor || defaultCwdFor)(id);
    if (cwd) since = (await (d.startedAt || defaultStartedAt)(id)) || 0;
  } catch (_) { return null; }
  if (!cwd) return null;
  const [c, x] = await Promise.all([claudeByCwd(cwd, since, d), codexByCwd(cwd, since, d)]);
  const best = c && x ? (x.mtime > c.mtime ? x : c) : (c || x);
  const real = best && await allowedRealPath(best.path, d);   // a symlinked file in a root can point out
  return real ? { kind: best.kind, path: real, sessionId: best.sessionId } : null;
}

// Re-resolve the join every WATCH_POLL_MS and call onChange(join) when the transcript path differs
// from the last one reported (the first resolution counts: from nothing to a path). A pane that
// resolves to nothing reports nothing, so the open thread stays on screen. Returns stop().
function watchJoin(surface, onChange, deps) {
  const d = deps || {};
  const every = d.setInterval || setInterval;
  const stopTimer = d.clearInterval || clearInterval;
  let last = null;
  let busy = false;
  let stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const j = await transcriptFor(surface, d);
      if (!stopped && j && j.path !== last) { onChange(j); last = j.path; }   // a throwing consumer sees it again
    } catch (_) { /* a failed resolve keeps the last join; the next tick retries */ } finally { busy = false; }
  }
  const timer = every(tick, WATCH_POLL_MS);
  if (timer && timer.unref) timer.unref();
  tick();
  return function stop() { stopped = true; stopTimer(timer); };
}

module.exports = { SWAP, transcriptFor, watchJoin, isAllowedTranscriptPath, WATCH_POLL_MS };
