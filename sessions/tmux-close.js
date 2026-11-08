'use strict';
// p41 D188 — "closing a pane does not really close it".
//
// A chief-of-staff worker's cmux pane runs `tmux attach -t =NAME` on the hosted socket
// (~/.local/state/cmux-remote/tmux-<uid>/default). Closing that cmux surface only killed the
// attach client: the tmux session (claude, or the `exec zsh -l` left after it) lived on detached,
// procs.orphanTmuxTabs listed it as a tmux-only row, and the menu kept a trail of entries.
//
// Close is now ONE action: the surface's tmux session goes with it — or only its window when the
// session has other windows, or nothing when other clients (other cmux surfaces) still show it.
// Only sessions on the hosted socket are touched: HyprMux / the chief layout made those; a tmux
// session on any other socket is the user's own.
//
// Orphans (one-time cleanup): a hosted-socket session that some cmux pane once hosted
// (CMUX_SURFACE_ID in its env), 0 attached clients, no client under the cmux app, and EVERY pane
// dead or idle at a shell with no claude/codex in its process tree. A tmux-only worker that still
// runs claude is detached BY DESIGN (D179) and is never an orphan.
//
// Pure planning over a procs.snapshot(); the caller runs the argv (execFile, never a shell).
const { ownerOf, findAgent } = require('./procs');

const LIMITS = {
  orphansMax: 64,          // names listed / accepted per request
  cosStopTimeoutMs: 30000, // HYPERMUX_COS_STOP_BIN run
};

// tmux session names we accept from a client (tmux itself forbids ':' and '.').
const SESSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_@+=-]{0,63}$/;
// chief-of-staff worker names (stop.sh NAME).
const COS_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login']);
const isShell = (cmd) => SHELLS.has(String(cmd || '').replace(/^-/, '').replace(/^.*\//, ''));

const windowsOf = (s) => new Set(s.panes.map((p) => p.window).filter(Boolean));
const activePane = (s) => s.panes.find((p) => p.active) || s.panes[0] || null;

/**
 * What closing cmux `surfaceId` does to tmux.
 * -> null (not tmux-hosted on the hosted socket) | { socket, session, action, args }
 *    action: 'kill-session' | 'kill-window' | 'keep' (other clients still show it)
 */
function closePlan(snap, surfaceId, hostedSocket) {
  if (!snap || !surfaceId || !hostedSocket) return null;
  const sessions = (snap.sessions || []).filter((s) => s.socket === hostedSocket);
  const o = ownerOf(sessions, surfaceId);
  if (!o || !(o.attached > 0)) return null;   // this surface does not show a tmux session
  const base = { socket: o.socket, session: o.name };
  if (o.attached > 1) return { ...base, action: 'keep', args: null };
  const wins = windowsOf(o);
  if (wins.size > 1) {
    const p = activePane(o);
    if (p && p.window) return { ...base, action: 'kill-window', args: ['kill-window', '-t', p.window] };
  }
  return { ...base, action: 'kill-session', args: ['kill-session', '-t', `=${o.name}`] };
}

/** True when no pane of `s` runs anything but an idle shell (or is dead). Unknown table = false. */
function idle(s, table) {
  if (!table || !s.panes.length) return false;
  return s.panes.every((p) => p.dead || (isShell(p.command) && !findAgent(table, p.pid)));
}

/** Orphaned hosted-socket sessions -> [{ name, socket, panes }]. Fail closed: no ps table = []. */
function listOrphans(snap, hostedSocket, deps) {
  const d = deps || {};
  if (!snap || !snap.table || !hostedSocket) return [];
  const underCmux = d.underCmuxApp || (() => false);
  const out = [];
  for (const s of snap.sessions || []) {
    if (out.length >= LIMITS.orphansMax) break;
    if (s.socket !== hostedSocket) continue;               // not a HyprMux/chief tmux session
    if (!s.surfaceId) continue;                             // never hosted in a cmux pane: not ours
    if (s.attached > 0) continue;                           // someone is looking at it
    if ((s.clientPids || []).some((pid) => underCmux(snap.table, pid))) continue;
    if (!SESSION_RE.test(s.name)) continue;
    if (!idle(s, snap.table)) continue;                     // claude/codex (or any program) still runs
    out.push({ name: s.name, socket: s.socket, panes: s.panes.length });
  }
  return out;
}

/** Validated, de-duplicated names from a request body; null when malformed. */
function parseNames(body) {
  const n = body && body.names;
  if (!Array.isArray(n) || n.length === 0 || n.length > LIMITS.orphansMax) return null;
  if (!n.every((x) => typeof x === 'string' && SESSION_RE.test(x))) return null;
  return [...new Set(n)];
}

/**
 * Kill only the names that are STILL orphans in a fresh snapshot.
 * run(socket, args) -> Promise<{code}>. -> { closed: [], skipped: [] }
 */
async function closeOrphans(names, snap, hostedSocket, run, deps) {
  const now = new Map(listOrphans(snap, hostedSocket, deps).map((o) => [o.name, o]));
  const closed = [], skipped = [];
  for (const name of names) {
    const o = now.get(name);
    if (!o) { skipped.push(name); continue; }
    const r = await run(o.socket, ['kill-session', '-t', `=${name}`]).catch(() => ({ code: 1 }));
    (r && r.code === 0 ? closed : skipped).push(name);
  }
  return { closed, skipped };
}

/**
 * The chief-of-staff worker name for a tmux session, or null. Opt-in: needs both
 * HYPERMUX_COS_STOP_BIN (absolute) and a match — the session name has a task file in
 * HYPERMUX_TASKS_DIR, or the claude process env says COS_WORKER=<name> (envOf(pid) -> {}).
 */
async function cosWorkerOf(snap, sessionName, opts) {
  const o = opts || {};
  if (!o.stopBin || !sessionName) return null;
  if (COS_NAME_RE.test(sessionName) && o.taskExists && await o.taskExists(sessionName)) return sessionName;
  if (o.envOf && snap && snap.table) {
    const s = (snap.sessions || []).find((x) => x.name === sessionName && (!o.socket || x.socket === o.socket));
    for (const p of (s && s.panes) || []) {
      const a = findAgent(snap.table, p.pid);
      if (!a) continue;
      let env = {};
      try { env = (await o.envOf(a.pid)) || {}; } catch (_) { env = {}; }
      const n = String(env.COS_WORKER || '');
      if (COS_NAME_RE.test(n)) return n;
    }
  }
  return null;
}

/** The stop argv for execFile(bin, argv). Never a shell string. */
const cosStopArgv = (name) => (COS_NAME_RE.test(String(name)) ? [String(name), 'STOPPED', '--force'] : null);

module.exports = { closePlan, listOrphans, parseNames, closeOrphans, cosWorkerOf, cosStopArgv, isShell, LIMITS, SESSION_RE, COS_NAME_RE };
