'use strict';
// p41 BUG1 — find the agent (claude/codex) a pane is running by walking the process tree, and its
// Claude transcript from the live process itself. Two reasons the older signals miss:
//
//   tmux  A Claude worker runs cmux pane -> `tmux attach` -> (tmux server) pane shell -> claude. The
//         claude process env keeps the CMUX_SURFACE_ID of the pane that CREATED the tmux session, so
//         after a reattach every hook event names a surface that no longer exists; the tmux SESSION
//         env (update-environment) is what follows the reattach. So: surface -> tmux session whose
//         CMUX_SURFACE_ID is that surface -> its active pane pid -> descendant claude/codex.
//   wrap  A wrapper (`cswap`, `bash launch.sh`, `zsh -c ...`) is the pane's own process; claude is a
//         child. The descendant search (bounded by LIMITS) finds it whatever the wrapper is called.
//
// Claude Code writes ~/.claude/sessions/<pid>.json ({sessionId, cwd}) for every live interactive
// process, so a found claude pid gives its transcript: ~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl.
// The caller still runs that path through join.js's containment check before serving it.
//
// ps, tmux and the file read are injected (deps), so tests never touch a real process table.
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { kindOfCommand } = require('./detect');
const tmuxCli = require('../lib/tmux-cli');
const tmuxIds = require('../lib/tmux-ids');

// Every limit this module adds (LIMITS.md rows).
const LIMITS = {
  procTreeDepth: 6,          // levels below the pane's own process searched for claude/codex
  procTreeNodes: 512,        // processes visited per search (a fork bomb cannot stall a list call)
  tmuxSessionsMax: 64,       // tmux sessions inspected per socket per request
  psTimeoutMs: 3000,
  tmuxTimeoutMs: 3000,
  sessionFileMaxBytes: 64 * 1024,
};

const slugOf = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
const defaultPsAll = () => run('/bin/ps', ['-axo', 'pid=,ppid=,args='], LIMITS.psTimeoutMs);
// The sockets a cmux-hosted bridge looks on: an explicit TMUX_SOCKET, tmux's default, and the
// cmux-remote state dir the chief-of-staff workers use.
function defaultSockets() {
  const uid = process.getuid ? process.getuid() : 0;
  const out = [process.env.TMUX_SOCKET, tmuxCli.defaultSocket(),
    path.join(os.homedir(), '.local', 'state', 'cmux-remote', `tmux-${uid}`, 'default')].filter(Boolean);
  return [...new Set(out)];
}
const defaultTmux = (socket, args) => run(tmuxCli.resolveTmuxBin(process.env.TMUX_BIN || ''), ['-S', socket, ...args], LIMITS.tmuxTimeoutMs);
const defaultReadFile = async (p) => {
  const fh = await fsp.open(p, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(LIMITS.sessionFileMaxBytes), 0, LIMITS.sessionFileMaxBytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await fh.close().catch(() => {}); }
};

// ---- process table -------------------------------------------------------------------------------

function parsePs(out) {
  const byPid = new Map();
  const kids = new Map();
  for (const line of String(out || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    byPid.set(pid, { pid, ppid, args: m[3] });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { byPid, kids };
}

// Breadth-first from rootPid (inclusive): the shallowest claude/codex process wins.
function findAgent(table, rootPid) {
  const root = Number(rootPid);
  if (!table || !Number.isFinite(root)) return null;
  let level = [root];
  let seen = 0;
  for (let depth = 0; depth <= LIMITS.procTreeDepth && level.length; depth++) {
    const next = [];
    for (const pid of level) {
      if (++seen > LIMITS.procTreeNodes) return null;
      const p = table.byPid.get(pid);
      if (p) {
        const k = kindOfCommand(p.args);
        if (k === 'claude' || k === 'codex') return { kind: k, pid, args: p.args };
      }
      for (const c of table.kids.get(pid) || []) next.push(c);
    }
    level = next;
  }
  return null;
}

// ---- tmux ----------------------------------------------------------------------------------------

const SEP = '\x1f';
// Every pane of every session on one socket, plus each session's CMUX_SURFACE_ID and attach count.
async function tmuxSocketState(tmux, socket) {
  let out;
  try {
    out = await tmux(socket, ['list-panes', '-a', '-F',
      ['#{session_name}', '#{pane_id}', '#{pane_pid}', '#{pane_active}', '#{window_active}', '#{session_attached}', '#{start_time}', '#{pane_current_path}'].join(SEP)]);
  } catch (_) { return null; }
  const sessions = new Map();
  for (const line of String(out || '').split('\n')) {
    const f = line.split(SEP);
    if (f.length < 8 || !f[0]) continue;
    let s = sessions.get(f[0]);
    if (!s) {
      if (sessions.size >= LIMITS.tmuxSessionsMax) continue;
      s = { socket, name: f[0], attached: Number(f[5]) || 0, epoch: Number(f[6]) || 0, panes: [], surfaceId: null };
      sessions.set(f[0], s);
    }
    s.panes.push({ id: f[1], pid: Number(f[2]), active: f[3] === '1' && f[4] === '1', cwd: f[7] || null });
  }
  await Promise.all([...sessions.values()].map(async (s) => {
    try {
      const env = await tmux(socket, ['show-environment', '-t', `=${s.name}`, 'CMUX_SURFACE_ID']);
      const m = /^CMUX_SURFACE_ID=(\S+)/m.exec(String(env || ''));
      s.surfaceId = m ? m[1] : null;
    } catch (_) { s.surfaceId = null; }
  }));
  return [...sessions.values()];
}

// One snapshot per request: the process table and every tmux session on every socket.
function snapshot(deps) {
  const d = deps || {};
  const psAll = d.psAll || defaultPsAll;
  const tmux = d.tmuxAt || defaultTmux;
  const sockets = d.tmuxSockets || defaultSockets();
  return Promise.all([
    psAll().then(parsePs, () => null),
    Promise.all(sockets.map((s) => tmuxSocketState(tmux, s))).then((all) => all.flat().filter(Boolean)),
  ]).then(([table, sessions]) => ({ table, sessions }));
}

const activePane = (s) => s.panes.find((p) => p.active) || s.panes[0] || null;

// ---- the agent a pane runs -----------------------------------------------------------------------

// surface: {id} — a cmux surface uuid (cmux backend) or a tmux pane id `%N` (tmux backend / a
// detached tmux session listed on cmux). -> {kind, pid, args, transcriptPath?, sessionId?} | null
async function agentFor(surface, deps) {
  const d = deps || {};
  const id = surface && surface.id;
  if (!id) return null;
  const snap = await (d.procSnapshot ? d.procSnapshot() : snapshot(d));
  if (!snap || !snap.table) return null;
  let pane = null;
  for (const s of snap.sessions || []) {
    if (/^%\d+$/.test(id)) {
      if (surface.socket && s.socket !== surface.socket) continue;
      pane = s.panes.find((p) => p.id === id) || null;
      if (pane) break;
      continue;
    }
    if (s.surfaceId === id) { pane = activePane(s); if (pane) break; }
  }
  const rootPid = pane ? pane.pid : surface.pid;
  if (!rootPid) return null;
  const agent = findAgent(snap.table, rootPid);
  if (!agent || agent.kind !== 'claude') return agent;
  const t = await claudeTranscriptOf(agent.pid, d);
  return t ? { ...agent, ...t } : agent;
}

// ~/.claude/sessions/<pid>.json -> {sessionId, transcriptPath}. The file names the pid it was written
// for; a mismatch (a recycled pid's stale file) is ignored.
async function claudeTranscriptOf(pid, deps) {
  const d = deps || {};
  const home = d.home || os.homedir();
  let j;
  try { j = JSON.parse(await (d.readFile || defaultReadFile)(path.join(home, '.claude', 'sessions', `${Number(pid)}.json`))); } catch (_) { return null; }
  if (!j || Number(j.pid) !== Number(pid) || typeof j.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(j.sessionId) || typeof j.cwd !== 'string') return null;
  return { sessionId: j.sessionId, transcriptPath: path.join(home, '.claude', 'projects', slugOf(j.cwd), `${j.sessionId}.jsonl`) };
}

// tmux sessions running an agent that no cmux surface in `liveIds` shows (detached, or whose cmux
// pane was closed): a cmux host lists them too, so a worker or chief living only in tmux is not lost.
async function orphanTmuxTabs(liveIds, deps) {
  const snap = await (deps && deps.procSnapshot ? deps.procSnapshot() : snapshot(deps));
  if (!snap || !snap.table) return [];
  const out = [];
  for (const s of snap.sessions || []) {
    if (s.surfaceId && liveIds.has(s.surfaceId) && s.attached > 0) continue;
    const p = activePane(s);
    if (!p || !findAgent(snap.table, p.pid)) continue;
    const n = Number(String(p.id).slice(1));
    out.push({ id: tmuxIds.mint('surface', s.epoch, n), ref: p.id, title: s.name, type: 'terminal', tmuxPane: p.id, tmuxSocket: s.socket });
  }
  return out;
}

module.exports = { agentFor, orphanTmuxTabs, snapshot, findAgent, parsePs, claudeTranscriptOf, LIMITS };
