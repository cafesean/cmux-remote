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
const { execFile, spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { kindOfCommand } = require('./detect');
const tmuxCli = require('../lib/tmux-cli');
const tmuxIds = require('../lib/tmux-ids');
const { SWAP } = require('./join');

// Every limit this module adds (LIMITS.md rows).
const LIMITS = {
  procTreeDepth: 6,          // levels below the pane's own process searched for claude/codex
  procTreeNodes: 512,        // processes visited per search (a fork bomb cannot stall a list call)
  tmuxSessionsMax: 64,       // tmux sessions inspected per socket per request
  psTimeoutMs: 3000,
  tmuxTimeoutMs: 3000,
  sessionFileMaxBytes: 64 * 1024,
  pidFileSkewMs: 30 * 1000,  // a pid file may predate its process start by this much (clock/rounding) before it is called stale
  tmuxSubmitSettleMs: 150,   // pause between pasted text and Enter (same paste-burst rule as cmuxSend)
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

// Printable: tmux escapes control characters (\x1f) in format output when the locale is not UTF-8,
// which a launchd-started bridge's is not.
const SEP = '|^|';
// Every pane of every session on one socket, plus each session's CMUX_SURFACE_ID and attach count.
async function tmuxSocketState(tmux, socket) {
  let out;
  try {
    out = await tmux(socket, ['list-panes', '-a', '-F',
      ['#{session_name}', '#{pane_id}', '#{pane_pid}', '#{pane_active}', '#{window_active}', '#{session_attached}', '#{start_time}', '#{pane_current_path}', '#{session_created}'].join(SEP)]);
  } catch (_) { return null; }
  const sessions = new Map();
  for (const line of String(out || '').split('\n')) {
    const f = line.split(SEP);
    if (f.length < 8 || !f[0]) continue;
    let s = sessions.get(f[0]);
    if (!s) {
      if (sessions.size >= LIMITS.tmuxSessionsMax) continue;
      s = { socket, name: f[0], attached: Number(f[5]) || 0, epoch: Number(f[6]) || 0, created: Number(f[8]) || 0, panes: [], surfaceId: null, clientTtys: [] };
      sessions.set(f[0], s);
    }
    s.panes.push({ id: f[1], pid: Number(f[2]), active: f[3] === '1' && f[4] === '1', cwd: f[7] || null });
  }
  // Client ttys per session (`tmux attach` clients): a session a cmux surface is attached to is shown by it.
  try {
    const cl = await tmux(socket, ['list-clients', '-F', ['#{session_name}', '#{client_tty}'].join(SEP)]);
    for (const line of String(cl || '').split('\n')) {
      const f = line.split(SEP);
      const s = f.length >= 2 && sessions.get(f[0]);
      if (s && f[1]) s.clientTtys.push(f[1].replace(/^\/dev\//, ''));
    }
  } catch (_) { /* no clients / old tmux: attached count still stands */ }
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

// A detached session keeps the CMUX_SURFACE_ID of the last surface that attached it, so two sessions
// can name one surface. The one that surface shows is the attached one; among equals, the newest.
function ownerOf(sessions, surfaceId) {
  let best = null;
  for (const s of sessions || []) {
    if (s.surfaceId !== surfaceId) continue;
    const a = s.attached > 0; const b = best && best.attached > 0;
    if (!best || (a && !b) || (a === b && s.created > best.created)) best = s;
  }
  return best;
}

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
  if (/^%\d+$/.test(id)) {
    for (const s of snap.sessions || []) {
      if (surface.socket && s.socket !== surface.socket) continue;
      pane = s.panes.find((p) => p.id === id) || null;
      if (pane) break;
    }
  } else {
    const owner = ownerOf(snap.sessions, id);
    pane = owner ? activePane(owner) : null;
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
  // ~/.claude plus each `cswap run` account dir (its CLAUDE_CONFIG_DIR); the process env is never read.
  // Config: join.SWAP (dir, maxAccounts). The pid file is validated and the newest valid one wins, so a
  // stale file left by a recycled pid in some other config dir cannot bind the wrong transcript.
  const configDirs = [path.join(home, '.claude')];
  try {
    const base = path.join(home, ...SWAP.dir);
    for (const n of (await (d.readdir || ((p) => fsp.readdir(p)))(base)).slice(0, SWAP.maxAccounts)) configDirs.push(path.join(base, n));
  } catch (_) { /* no swap dirs */ }
  let procStart = null;
  try { procStart = await (d.procStartMs || defaultProcStartMs)(pid); } catch (_) { procStart = null; }
  let best = null;
  for (const cfg of configDirs) {
    let j;
    try { j = JSON.parse(await (d.readFile || defaultReadFile)(path.join(cfg, 'sessions', `${Number(pid)}.json`))); } catch (_) { continue; }
    if (!j || Number(j.pid) !== Number(pid) || typeof j.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(j.sessionId) || typeof j.cwd !== 'string') continue;
    const at = Number(j.startedAt) || 0;
    if (procStart && at && at < procStart - LIMITS.pidFileSkewMs) continue;   // written before this process began: a recycled pid's leftover
    if (!best || at > best.at) best = { at, sessionId: j.sessionId, transcriptPath: path.join(cfg, 'projects', slugOf(j.cwd), `${j.sessionId}.jsonl`) };
  }
  return best ? { sessionId: best.sessionId, transcriptPath: best.transcriptPath } : null;
}
// `ps -o lstart=` of the live pid -> epoch ms (null when unknown: the check then does not apply).
async function defaultProcStartMs(pid) {
  const out = await run('/bin/ps', ['-o', 'lstart=', '-p', String(Number(pid))], LIMITS.psTimeoutMs);
  const t = Date.parse(String(out).trim());
  return Number.isFinite(t) ? t : null;
}

// The tmux session name a surface lives in: a pane id `%N`, or a cmux surface id (its attached
// owner session). null when not tmux-hosted.
function tmuxNameFor(snap, surface) {
  const id = surface && surface.id;
  if (!id || !snap || !snap.sessions) return null;
  if (/^%\d+$/.test(id)) {
    for (const s of snap.sessions) {
      if (surface.socket && s.socket !== surface.socket) continue;
      if (s.panes.some((p) => p.id === id)) return s.name;
    }
    return null;
  }
  const o = ownerOf(snap.sessions, id);
  return o ? o.name : null;
}

// tmux sessions running an agent that no cmux surface in `liveIds` shows (detached, or whose cmux
// pane was closed): a cmux host lists them too, so a worker or chief living only in tmux is not lost.
async function orphanTmuxTabs(liveIds, deps) {
  const snap = await (deps && deps.procSnapshot ? deps.procSnapshot() : snapshot(deps));
  if (!snap || !snap.table) return [];
  const out = [];
  const liveTtys = new Set([...((deps && deps.liveTtys) || [])].map((t) => String(t).replace(/^\/dev\//, '')));
  for (const s of snap.sessions || []) {
    if (s.surfaceId && liveIds.has(s.surfaceId) && ownerOf(snap.sessions, s.surfaceId) === s) continue;   // shown by that cmux pane
    // Attached by a cmux surface (its tty is a client tty of this session): that surface is the row.
    if (liveTtys.size && (s.clientTtys || []).some((t) => liveTtys.has(t))) continue;
    const p = activePane(s);
    if (!p || !findAgent(snap.table, p.pid)) continue;
    const n = Number(String(p.id).slice(1));
    out.push({ id: tmuxIds.mint('surface', s.epoch, n), ref: p.id, title: s.name, type: 'terminal', tmuxPane: p.id, tmuxSocket: s.socket });
  }
  return out;
}

// A minted tmux-only surface id (orphanTmuxTabs) -> {socket, pane} when that pane still exists on a
// server with the id's epoch; anything else (a cmux uuid, a stale id) -> null.
async function tmuxTargetFor(surfaceId, deps) {
  const p = tmuxIds.parse(surfaceId);
  if (!p || p.kind !== 4) return null;
  const snap = await (deps && deps.procSnapshot ? deps.procSnapshot() : snapshot(deps));
  for (const s of (snap && snap.sessions) || []) {
    if (!tmuxIds.sameEpoch(p.epoch, s.epoch)) continue;
    const pane = s.panes.find((x) => x.id === `%${p.n}`);
    if (pane) return { socket: s.socket, pane: pane.id, session: s.name };
  }
  return null;
}

// Type into a tmux pane the way lib/tmux-cli.js verbSend does (load-buffer + paste-buffer, bracketed
// only for multi-line text), then Enter after a settle; or press one KEYMAP key. argv only, no shell.
function tmuxRun(socket, args, input) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(tmuxCli.resolveTmuxBin(process.env.TMUX_BIN || ''), ['-S', socket, ...args], { stdio: ['pipe', 'ignore', 'pipe'] }); } catch (e) { return resolve({ code: -1, dispatched: false, detail: String(e.message) }); }
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), LIMITS.tmuxTimeoutMs);
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, dispatched: child.pid !== undefined, detail: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, dispatched: true, detail: err.slice(0, 200) }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
// opts: {text, submit} or {press: '<KEYMAP name>'}
async function tmuxSend(target, opts, deps) {
  const run = (deps && deps.tmuxRun) || tmuxRun;
  const o = opts || {};
  if (o.press) {
    const mapped = tmuxCli.KEYMAP[String(o.press).toLowerCase()];
    if (!mapped) return { error: 'bad_key' };
    const r = await run(target.socket, ['send-keys', '-t', target.pane, mapped]);
    return r.code === 0 ? { ok: true } : { error: 'tmux_failed', detail: r.detail };
  }
  if (o.text) {
    const buf = `cmuxr-${process.pid}-${Date.now().toString(36)}`;
    const r = await run(target.socket, ['load-buffer', '-b', buf, '-', ';', 'paste-buffer', '-d',
      ...(o.text.includes('\n') ? ['-p'] : []), '-b', buf, '-t', target.pane], o.text);
    if (r.code !== 0) return { error: r.dispatched ? 'text_command_unconfirmed' : 'send_failed', detail: r.detail };
  }
  if (o.submit) {
    if (o.text) await new Promise((res) => setTimeout(res, (deps && deps.settleMs != null) ? deps.settleMs : LIMITS.tmuxSubmitSettleMs));
    const r = await run(target.socket, ['send-keys', '-t', target.pane, 'Enter']);
    if (r.code !== 0) return { error: 'submit_failed_text_inserted', detail: r.detail };
  }
  return { ok: true };
}

module.exports = { tmuxNameFor, agentFor, orphanTmuxTabs, tmuxTargetFor, tmuxSend, snapshot, findAgent, parsePs, claudeTranscriptOf, defaultSockets, ownerOf, LIMITS };
