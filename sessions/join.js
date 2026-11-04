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

// ---- default injected pieces -------------------------------------------------------------------

const defaultFs = {
  readdir: (dir) => fsp.readdir(dir),
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
  const dir = path.join(deps.home || os.homedir(), '.claude', 'projects', slugOf(cwd));
  let best = null;
  for (const name of await list(fs, dir)) {
    if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;   // agent-*: sub-agent side threads
    const p = path.join(dir, name);
    const mtime = await mtimeOf(fs, p);
    if (mtime < since || (best && mtime <= best.mtime)) continue;
    best = { kind: 'claude', path: p, sessionId: name.slice(0, -'.jsonl'.length), mtime };
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

  const ev = await latestSurfaceEvent(s, d, (e) => e.transcriptPath);
  if (ev) return { kind: isCodexPath(ev.transcriptPath) ? 'codex' : 'claude', path: ev.transcriptPath, sessionId: ev.sessionId };

  let cwd = null;
  let since = 0;
  try {
    cwd = await (d.cwdFor || defaultCwdFor)(id);
    if (cwd) since = (await (d.startedAt || defaultStartedAt)(id)) || 0;
  } catch (_) { return null; }
  if (!cwd) return null;
  const [c, x] = await Promise.all([claudeByCwd(cwd, since, d), codexByCwd(cwd, since, d)]);
  const best = c && x ? (x.mtime > c.mtime ? x : c) : (c || x);
  return best ? { kind: best.kind, path: best.path, sessionId: best.sessionId } : null;
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
      if (!stopped && j && j.path !== last) { last = j.path; onChange(j); }
    } catch (_) { /* a failed resolve keeps the last join; the next tick retries */ } finally { busy = false; }
  }
  const timer = every(tick, WATCH_POLL_MS);
  if (timer && timer.unref) timer.unref();
  tick();
  return function stop() { stopped = true; stopTimer(timer); };
}

module.exports = { transcriptFor, watchJoin, WATCH_POLL_MS };
