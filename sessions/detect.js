'use strict';
// p41 session kind detection: does a pane show as a Claude chat, a Codex chat, a plain terminal or a
// browser. Two exports:
//
//   detectKind({surfaceType, foregroundCmd, transcriptPath}) -> 'claude'|'codex'|'terminal'|'browser'
//   foregroundCommand(surface, backend, deps) -> Promise<string|null>
//
// Signal per backend:
//   cmux  the tree's per-surface `tty` -> `ps -t <tty>`, foreground process group only. Current cmux
//         builds report `tty: null` for every surface (bridge.js loadTree does not even carry the
//         field), so without a tty the radar hook-event log is the signal: a surface that has a Claude
//         Code hook event under 6 h old (matched on the uuid), and no SessionEnd after it, is running claude.
//         Codex fires no hooks, so on cmux it is only seen when a tty is present.
//   tmux  `#{pane_current_command}`; when that is a runtime (node, bun...) the pane tty is read too
//         and `ps` widens it to the full command line, so `node .../claude` is still claude.
//
// ps, tmux and the event log are injected (deps), so tests never touch a real process table.
const { execFile } = require('child_process');
const path = require('path');

const eventlog = require('../radar/eventlog');
const tmuxCli = require('../lib/tmux-cli');

// Interpreters that front a CLI: for these the script path (not the interpreter) names the program.
const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno', 'npx', 'bunx', 'tsx', 'python', 'python3']);
const CLAUDE_RE = /^claude(-code)?(\.js|\.mjs|\.cjs)?$/;
const CODEX_RE = /^codex(\.js|\.mjs|\.cjs)?$/;
const CLAUDE_PKG = /@anthropic-ai[\\/]claude-code/;
const CODEX_PKG = /@openai[\\/]codex/;
// Where each agent keeps its transcripts: a hint only, used when the foreground command is unknown.
const CLAUDE_TRANSCRIPT = /[\\/]\.claude[\\/]projects[\\/]/;
const CODEX_TRANSCRIPT = /[\\/]\.codex[\\/]sessions[\\/]/;

const PS_TIMEOUT = 3000;
const TMUX_TIMEOUT = 3000;
// A pane whose newest hook event is older than this is treated as not running claude: a crash or kill
// leaves no SessionEnd, so without a bound a dead pane would read as claude for the whole retention.
const EVENT_LIVE_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_PAGES = 20;

const base = (tok) => path.basename(String(tok).replace(/^-+(?=[a-z])/i, ''));

function programKind(tok) {
  const b = base(tok);
  if (CLAUDE_RE.test(b)) return 'claude';
  if (CODEX_RE.test(b)) return 'codex';
  return null;
}

// "node /opt/homebrew/bin/claude --model opus" -> 'claude'. Only the program counts: the first word,
// or for an interpreter the first non-flag word after it. `vim claude.md` and `node server.js --claude`
// are terminals.
function kindOfCommand(cmd) {
  const s = String(cmd == null ? '' : cmd).trim();
  if (!s) return null;
  if (CLAUDE_PKG.test(s)) return 'claude';
  if (CODEX_PKG.test(s)) return 'codex';
  const words = s.split(/\s+/);
  const first = programKind(words[0]);
  if (first) return first;
  if (!RUNTIMES.has(base(words[0]))) return 'other';
  const script = words.slice(1).find((w) => !w.startsWith('-'));
  return (script && programKind(script)) || 'other';
}

function detectKind(info) {
  const o = info || {};
  if (o.surfaceType === 'browser') return 'browser';
  const k = kindOfCommand(o.foregroundCmd);
  if (k === 'claude' || k === 'codex') return k;
  if (k === 'other') return 'terminal';             // something else is in front: any old transcript is history
  const t = String(o.transcriptPath || '');         // command unknown: fall back on where the transcript lives
  if (CLAUDE_TRANSCRIPT.test(t)) return 'claude';
  if (CODEX_TRANSCRIPT.test(t)) return 'codex';
  return 'terminal';
}

// ---- foreground command ------------------------------------------------------------------------

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}
const defaultPs = (args) => run('/bin/ps', args, PS_TIMEOUT);
const defaultTmux = (args) => run(tmuxCli.resolveTmuxBin(process.env.TMUX_BIN || ''),
  ['-S', process.env.TMUX_SOCKET || tmuxCli.defaultSocket(), ...args], TMUX_TIMEOUT);

// `ps -t <tty> -o stat=,args=`: the foreground process group is the rows whose stat carries '+'.
// Claude Code shares that group with its MCP children (uv, python...), so no row position is safe:
// any row that is claude/codex wins, else the first row.
async function psForeground(ps, tty) {
  const dev = String(tty || '').replace(/^\/dev\//, '');
  if (!dev) return null;
  let out;
  try { out = await ps(['-t', dev, '-o', 'stat=,args=']); } catch (_) { return null; }
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^\s*(\S+)\s+(.*\S)\s*$/.exec(line);
    if (m && m[1].includes('+')) rows.push(m[2]);
  }
  return rows.find((r) => { const k = kindOfCommand(r); return k === 'claude' || k === 'codex'; }) || rows[0] || null;
}

// Every event from `since` on. readEvents pages ascending (MAX_PAGE rows) and flags `more`; stopping at
// the first page would drop the NEWEST events of a busy log, so follow it with since = last ts.
async function readAllEvents(readEvents, since) {
  const all = [];
  let from = since;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const r = await readEvents({ since: from });
    const evs = (r && r.events) || [];
    all.push(...evs);
    if (!r || !r.more || !evs.length) break;
    const next = evs[evs.length - 1].ts;
    if (!(next > from)) break;                      // no progress: do not spin
    from = next;
  }
  return all;
}

// The newest hook event naming the surface that `accept` takes (default: any), within EVENT_LIVE_MS.
// Match on the uuid; a short ref (`surface:12`) is reused after a cmux restart, so it is used only when
// the surface has no uuid. Shared with sessions/join.js, which asks the same question for a transcript.
async function latestSurfaceEvent(surface, deps, accept) {
  const id = surface.id || surface.ref;
  if (!id) return null;
  const now = (deps.now || Date.now)();
  let events;
  try { events = await readAllEvents(deps.readEvents || eventlog.readEvents, now - EVENT_LIVE_MS); } catch (_) { return null; }
  let last = null;
  for (const ev of events) {
    if (ev.surfaceId !== id || now - ev.ts > EVENT_LIVE_MS || (accept && !accept(ev))) continue;
    if (!last || ev.ts >= last.ts) last = ev;
  }
  return last;
}

// Claude Code is "live" on a surface when its newest hook event is recent and not a SessionEnd.
async function eventsForeground(surface, deps) {
  const last = await latestSurfaceEvent(surface, deps);
  return last && last.event !== 'SessionEnd' ? 'claude' : null;
}

async function tmuxForeground(surface, deps) {
  let out;
  try {
    out = await (deps.tmux || defaultTmux)(['display-message', '-p', '-t', surface.id || surface.ref,
      '#{pane_current_command}\x1f#{pane_tty}']);
  } catch (_) { return null; }
  const [cmd, tty] = String(out || '').replace(/\n$/, '').split('\x1f');
  if (!cmd) return null;
  if (!RUNTIMES.has(base(cmd))) return cmd;
  return (await psForeground(deps.ps || defaultPs, tty)) || cmd;
}

// surface: a loadTree tab ({id, ref, type, tty?}) on cmux, or {id: '%3'} (the pane id) on tmux.
// deps.agentFor (sessions/procs.js, injected by routes) walks tmux and wrapper processes down to a
// claude/codex descendant; when it finds one, that agent is the answer whatever is in front.
async function foregroundCommand(surface, backend, deps) {
  const d = deps || {};
  const s = surface || {};
  if (backend !== 'tmux' && backend !== 'cmux') throw new Error(`unknown backend ${JSON.stringify(backend)}`);
  if (d.agentFor) {
    let a = null;
    try { a = await d.agentFor(s); } catch (_) { a = null; }
    if (a && a.args) return a.args;
  }
  if (backend === 'tmux') return tmuxForeground(s, d);
  if (s.tty) return psForeground(d.ps || defaultPs, s.tty);
  return eventsForeground(s, d);
}

module.exports = { detectKind, foregroundCommand, kindOfCommand, latestSurfaceEvent };
