#!/usr/bin/env node
// cmux-remote bridge — runs on the machine where cmux is installed.
// Exposes the local cmux tabs over HTTP so the cmux-remote server can view + drive them. Shells out
// to the cmux CLI; a same-user process inherits cmux's socket, so no cmux password is needed.
// Secret-gated: the header  x-bridge-secret  must equal BRIDGE_SECRET (skipped if BRIDGE_SECRET is
// empty — only safe on a trusted LAN). No dependencies — plain `node bridge.js`.
//
// Model (v2): cmux's hierarchy is Window > Workspace > Pane > Surface. A "tab" in this mirror IS a
// cmux *surface* (a terminal). We enumerate the full tree so a workspace with several tabs exposes
// ALL of them, and we address every read/write by a specific surface ref (surface:N) — NOT by
// workspace, which only ever resolves to the focused surface and hides the siblings.
//
// Model (v3, multi-pane): the tree keeps the PANE grouping (it used to be flattened away), and
// /cmux/layout reports each pane's geometry so the mirror can reproduce the desktop's split layout
// instead of showing one surface at a time. Splits created or resized on either side stay in sync.
//
// Env (a .env in the CWD is auto-loaded):
//   BRIDGE_PORT    default 8799
//   BRIDGE_SOCKET  absolute path of a UNIX socket to listen on INSTEAD of a TCP port (p19, shared Macs):
//                  its directory must be 0700 and ours; BRIDGE_PORT/BRIDGE_HOST are then ignored
//   BRIDGE_SECRET  shared secret the server presents; empty = no auth (trusted LAN only)
//   CMUX_BIN       path to the cmux CLI (default: the macOS app bundle path)
//   BACKEND        cmux (default) | tmux — tmux drives a headless tmux server through lib/tmux-cli.js
//   TMUX_BIN / TMUX_SOCKET / TMUX_SESSION   the tmux backend's binary, server socket, default session
const { emptyShadowed } = require('./loadenv');
// p62 S2: see server.js: stdin secrets first, then main() runs. Unset -> no-op.
const secretsIn = require('./lib/secrets-stdin');
// D62: the body is main(), not a top-level `return` + self re-require: `bun build --compile` drops a
// top-level return (the body ran before the secrets were read, so auth was open). Same order on node.
if (secretsIn.pending()) secretsIn.loadSecrets({ require: ['BRIDGE_SECRET'] }).then(main);
else main();
function main() {
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createFsBrowse, parseRange, contentDisposition } = require('./fsbrowse');
const eventlog = require('./radar/eventlog');
const { normalizeLayout } = require('./panelayout');

const PORT = Number(process.env.BRIDGE_PORT || 8799);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const SECRET = secretsIn.get('BRIDGE_SECRET');
const { safeEqual } = require('./lib/safe-equal');
const { redactTokens, redactText, redactRows, redactGrid } = require('./lib/redact-tokens');
// p19: BRIDGE_SOCKET set → listen on that UNIX socket and open NO TCP port. On a shared Mac any user
// can bind a free loopback port before we do and collect BRIDGE_SECRET from the server; a socket in a
// 0700 directory of ours cannot be bound or reached by them. A bad value refuses to start here, before
// anything is bound — never a silent fall back to TCP. Unset = TCP exactly as before.
const unixListen = require('./lib/unix-listen');
let SOCKET = '';
try { SOCKET = unixListen.socketSetting('BRIDGE_SOCKET', process.env, emptyShadowed); }
catch (e) { console.error(`refusing to start: ${e.code}: ${e.detail}`); process.exit(1); }
// Machine identity (p5 radar). Radar's session identity is {machine, session_id} and NEVER cwd, so
// every response that carries session data carries the machine it came from.
const MACHINE_ID = process.env.RADAR_MACHINE_ID || os.hostname();
const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX_ENV = secretsIn.cmuxChildEnv({ CMUX_QUIET: '1' });   // p62 S2/D83: no secret but the cmux socket password (cmux CLI only)
// p18: which program answers the cmux argv this file builds. `cmux` (the default) is the cmux CLI,
// exactly as before. `tmux` is lib/tmux-cli.js — an in-process emulator that takes the same argv and
// answers in cmux's shapes from a headless tmux server, so every handler below runs unchanged. A typo
// must not silently pick a backend, so anything else refuses to start, before a port is bound.
const BACKEND = String(process.env.BACKEND || 'cmux').trim().toLowerCase();
if (BACKEND !== 'cmux' && BACKEND !== 'tmux') {
  console.error(`BACKEND must be "cmux" or "tmux" (got ${JSON.stringify(process.env.BACKEND)}) — refusing to start`);
  process.exit(1);
}
const tmuxCli = BACKEND === 'tmux' ? require('./lib/tmux-cli').createTmuxCli({
  tmuxBin: process.env.TMUX_BIN || '',            // '' → Homebrew tmux, then PATH
  socket: process.env.TMUX_SOCKET || '',          // '' → ${TMUX_TMPDIR||/tmp}/tmux-${uid}/default
  session: process.env.TMUX_SESSION || 'main',
  home: os.homedir(),
  log: (m) => console.log(`tmux: ${m}`),
}) : null;
// What this machine can do, for the page to gate on (additive key in /cmux/tree).
const CAPABILITIES = Object.freeze({
  backend: BACKEND, browser: BACKEND === 'cmux', sidebarStatus: BACKEND === 'cmux', tabsInPane: BACKEND === 'cmux',
  radar: BACKEND === 'cmux',   // radar types into panes and starts sessions; not supported on tmux (owner, p18)
});
// Which cmux this is, and whether it is at least the version this code was verified against
// (lib/cmux-version.js says why the floor is where it is). Probed once at boot and refreshed lazily —
// cmux auto-updates under a running bridge. Below the floor is a WARNING, never a refusal: the page
// shows it next to the connection status so "history is short" can be read against the cmux version.
const cmuxVersion = require('./lib/cmux-version');
const CMUX_VERSION_TTL_MS = 10 * 60 * 1000;
let cmuxCompat = null, cmuxCompatAt = 0;
function probeCmuxVersion(cb) {
  if (tmuxCli) { if (cb) cb(null); return; }
  cmuxCompatAt = Date.now();                     // set before the spawn: concurrent callers don't pile up
  cli(['--version'], { timeout: 5000 }, (err, stdout) => {
    cmuxCompat = cmuxVersion.assessCmuxVersion(err ? '' : stdout);
    if (cb) cb(cmuxCompat);
  });
}
// CAPABILITIES plus, on the cmux backend, `cmux: {version, min, supported}` (additive, p18 path: the
// server relays `capabilities` whole). `supported: null` = not probed yet / version unreadable.
function capabilities() {
  if (tmuxCli) return { ...CAPABILITIES, ...rdScreenCap() };
  if (Date.now() - cmuxCompatAt > CMUX_VERSION_TTL_MS) probeCmuxVersion();
  return { ...CAPABILITIES, cmux: cmuxCompat || { version: null, min: cmuxVersion.MIN_CMUX_VERSION, supported: null }, ...rdScreenCap() };
}
// p41 D189: `screen` = Remote Desktop TCC setup status (lib/rd-setup.js), last cached probe. rdSetup is
// built further down (after macScreen); capabilities() only runs on requests, the try covers the gap.
function rdScreenCap() {
  try { const s = rdSetup.cached(); return s ? { screen: s } : {}; } catch (_) { return {}; }
}
// One spawn point for both backends. cmux: the exact execFile cmux() always made.
function cli(args, opts, cb) {
  if (tmuxCli) return tmuxCli.exec(args, opts, cb);
  return execFile(CMUX_BIN, args, { timeout: opts.timeout, env: CMUX_ENV, maxBuffer: 8 * 1024 * 1024 }, cb);
}

const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
// A surface target: a surface ref (surface:N) or a raw UUID. This is what every terminal op addresses.
const SURFACE_RE = new RegExp(`^(surface:\\d+|${UUID})$`);
const UUID_ONLY_RE = new RegExp(`^${UUID}$`);
// A workspace target: a workspace ref (workspace:N) or a UUID. Used when creating a tab in a workspace.
const WORKSPACE_RE = new RegExp(`^(workspace:\\d+|${UUID})$`);
// A pane target: a pane ref (pane:N) or a UUID. Clients send UUIDs — refs are window-relative and do
// not resolve from this detached process (same trap as surface refs).
const PANE_RE = new RegExp(`^(pane:\\d+|${UUID})$`);
const SPLIT_DIRS = new Set(['left', 'right', 'up', 'down']);
const MAX_STREAM_SURFACES = 16;  // panes mirrored at once — each costs one terminal.replay per round; = app.js MAX_PANES (LIMITS.md row)
const CMUX_KEYS = new Set(['enter', 'escape', 'tab', 'shift+tab', 'up', 'down', 'left', 'right',
  'ctrl+c', 'ctrl+d', 'ctrl+l', 'ctrl+r', 'backspace', 'space', 'pageup', 'pagedown', 'home', 'end']);
// Browser-surface keys: client token -> Playwright/W3C name for `cmux browser <sf> press <key>`.
const BROWSER_KEYMAP = { enter: 'Enter', backspace: 'Backspace', tab: 'Tab', escape: 'Escape',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: 'Space',
  delete: 'Delete', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
const CMUX_GRID_MAX_ROWS = 2000;   // scrollback + viewport rows to mirror (was 300 — the scroll-history ceiling)
const CMUX_SCROLLBACK_MAX = 5000;  // hard cap for on-demand history paging

function send(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'surrogate-control': 'no-store',
  });
  res.end(redactTokens(JSON.stringify(obj)));   // S2r: no sk-ant- token leaves the Mac
}
// Older cmux builds (e.g. 0.62.x) reject flags newer ones accept: `--id-format` is global-only there
// (must precede the subcommand), and `new-surface`/`new-workspace` have no `--focus`. Rather than pin a
// cmux version, retry once per rejected flag — relocate `--id-format`, drop anything else it doesn't know.
const FLAG_VALUES = new Set(['--id-format', '--focus', '--type', '--lines', '--surface', '--workspace', '--pane', '--working-directory']);
function adaptArgs(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const take = FLAG_VALUES.has(flag) ? 2 : 1;
  const rest = args.slice(0, i).concat(args.slice(i + take));
  if (flag === '--id-format') return [flag, args[i + 1], ...rest];   // move to global position
  return rest;                                                       // unsupported flag: drop it
}
function cmux(args, cb, timeout = 8000, tries = 0) {
  cli(args, { timeout }, (err, stdout, stderr) => {
    const m = err && tries < 3 && String(stderr || '').match(/unknown flag '(--[a-z-]+)'/);
    if (m) {
      const next = adaptArgs(args, m[1]);
      if (next) return cmux(next, cb, timeout, tries + 1);
    }
    cb(err, stdout, stderr);
  });
}
const cmuxP = (args, timeout) => new Promise((resolve) =>
  cmux(args, (err, stdout) => resolve(err ? null : (stdout || '')), timeout));
// Same call, inverted: the cmux STDERR text when it refused, null when it worked. Every close path
// wants the refusal verbatim — the CLI's own wording is what tells an operator which rule it hit.
const cmuxErr = (args, timeout = 8000) => new Promise((resolve) =>
  cmux(args, (err, stdout, stderr) => resolve(err ? String(stderr || err.message || '') : null), timeout));
// p41 S2p: every JSON body passes the private-surface gate here. handleCmux records each request's
// `res` (privateRes) so a body naming a private surface/pane/workspace answers 423 `private` before
// any route sees it — no caller changes, and a route added later is covered by construction.
function cmuxReadBody(req, cb, cap = 256 * 1024) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > cap) req.destroy(); });
  req.on('end', () => {
    let b;
    try { b = JSON.parse(body || '{}'); } catch (_) { return cb(null); }
    const run = () => { try { cb(b); } catch (_) { cb(null); } };
    const refs = privateBodyRefs(b);
    const res = privateRes.get(req);
    if (!refs.length || !res) return run();
    privateGate(refs).catch(() => 503)   // a gate that cannot decide refuses
      .then((code) => (code ? gateRefuse(res, code) : run()));
  });
}

// ---------- filesystem browse (p4) ------------------------------------------
// Roots come from cmux's OPEN WORKSPACES when FS_ROOTS is `workspace-cwds` (the default).
// `cmux tree --json` does NOT carry a cwd — verified. `cmux workspace list --json` does, as
// `current_directory`, but it is PER WINDOW: a bare call and a --window call were observed
// returning different workspace counts, so always enumerate windows explicitly and merge.
async function cmuxWorkspaceCwds() {
  const winOut = await cmuxP(['list-windows', '--json'], 6000);
  let windows = [];
  try { windows = JSON.parse(winOut || '[]'); } catch (_) { windows = []; }
  if (!Array.isArray(windows) || windows.length === 0) windows = [{ id: null }];
  const out = [];
  for (const w of windows) {
    const args = ['workspace', 'list', '--json'];
    if (w && w.id) args.push('--window', w.id);
    const raw = await cmuxP(args, 8000);
    let data; try { data = JSON.parse(raw || '{}'); } catch (_) { continue; }
    for (const ws of (data.workspaces || [])) {
      if (!ws || !ws.current_directory) continue;
      out.push({ label: (ws.custom_title || ws.title || '').trim() || ws.ref, path: ws.current_directory });
    }
  }
  return out;
}

const fsBrowse = createFsBrowse({ workspaceCwds: cmuxWorkspaceCwds });

// ---------- p41 sessions (native app) ---------------------------------------
// /cmux/sessions* (sessions/routes.js). Additive: no existing route changes.
// P41_JOIN_POLL_MS is a test knob (default sessions/join.js WATCH_POLL_MS).
// P41_PROCS_FIXTURE is a test knob: a JSON file {ps, tmuxSockets} — the process table comes from the
// file and tmux is only asked on those sockets, so tests never read this host's real ps or tmux.
function p41ProcSnapshotKnob() {
  const f = process.env.P41_PROCS_FIXTURE;
  if (!f) return undefined;
  const procs = require('./sessions/procs');
  return () => {
    let fx = {};
    try { fx = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { fx = {}; }
    return procs.snapshot({ psAll: async () => String(fx.ps || ''), tmuxSockets: Array.isArray(fx.tmuxSockets) ? fx.tmuxSockets : [] });
  };
}
// ---------- p41 S2p private surfaces (one gate) ------------------------------
// lib/private-surfaces.js: the "Claude accounts" workspace + the mark file. Gate: handleCmux (query
// params) and cmuxReadBody (JSON bodies) answer 423 `private`; tree, notifications, panes-stream and
// the sessions list drop private surfaces.
const privateSurfaces = require('./lib/private-surfaces');
const PRIVATE_GATE_TREE_MS = privateSurfaces.GATE_TIMEOUT_MS;
const privacy = privateSurfaces.createPrivacy({ loadTree: () => loadTree(true) });
const privateRes = new WeakMap();   // req -> res, for the body gate in cmuxReadBody
const PRIVATE_QUERY_KEYS = ['surface', 'pane', 'workspace', 'target', 'id', 'tab'];
const PRIVATE_BODY_KEYS = ['surface', 'pane', 'paneA', 'paneB', 'workspace', 'target', 'tab'];
function privateBodyRefs(b) {
  if (!b || typeof b !== 'object') return [];
  const out = [];
  // Routes coerce with String(b.x), and String(['id']) === 'id' — so any non-string value is gated in
  // its coerced form (and an array element by element too).
  const add = (v) => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) v.forEach((x) => { if (x != null && typeof x !== 'object') out.push(String(x)); });
    out.push(String(v));
  };
  for (const k of PRIVATE_BODY_KEYS) add(b[k]);
  add(b.surfaces);
  return out.filter(Boolean);
}
// -> null (clear) | 423 (a ref IS private) | 503 (a ref cannot be proven either way: the gate's tree
// read failed or stalled, and no recent good tree knows the ref). A tmux-only session
// id (minted, never in the cmux tree) is exempt from 503 when tmux resolves it: it is not a cmux pane.
// A ref in none of the addressable formats (surface / pane / workspace; browser targets are surfaces)
// skips the gate: every route validates with these same regexes and answers 400 for it, so it can
// reach nothing — and a stalled tree read must not turn that 400 into a 503.
const GATEABLE_REF = (r) => SURFACE_RE.test(r) || PANE_RE.test(r) || WORKSPACE_RE.test(r);
async function privateGate(allRefs) {
  const refs = allRefs.filter(GATEABLE_REF);
  if (!refs.length) return null;
  const v = await privacy.verdict(refs);
  const vs = refs.map(v);
  if (vs.includes('private')) return 423;
  const unsure = refs.filter((r, i) => vs[i] === 'unavailable');
  if (!unsure.length) return null;
  if (tmuxCli) return 503;
  for (const r of unsure) {
    if (!SURFACE_RE.test(r)) return 503;
    let tgt = null;
    try { tgt = await sessionRoutes.tmuxTarget(r); } catch (_) { tgt = null; }
    if (!tgt) return 503;
  }
  return null;
}
const gateRefuse = (res, code) => send(res, code, code === 423 ? { error: 'private' } : { error: 'gate_unavailable' });
const sessionRoutes = require('./sessions/routes').createSessionRoutes({
  machineId: MACHINE_ID,
  screenStatus: () => rdSetup.cached() || rdSetup.status(),   // p41 D189: stale-while-revalidate; awaits only the first probe (rdSetup is built below; per request only)
  privateCheck: (refs) => privacy.verdict(refs),
  backend: BACKEND,
  loadTree: () => loadTree(),
  unreadBySurface: () => (tmuxCli ? Promise.resolve(null) : unreadBySurface()),
  sseHead: (res) => sseHead(res),
  uploadRoot: () => UPLOAD_DIR,   // D57: inline images typed as upload paths (read lazily: defined below)
  joinPollMs: Number(process.env.P41_JOIN_POLL_MS) || undefined,
  procSnapshot: p41ProcSnapshotKnob(),
  statusPollMs: Number(process.env.P41_JOIN_POLL_MS) || undefined,
  // A14: Session.choice reads the live screen through the same path as the grid mirror.
  readGrid: (surface) => new Promise((resolve) => gridPayload(surface, (obj) => resolve(obj && obj.grid ? { seq: obj.seq, grid: obj.grid } : null))),
});

// ---------- compose-box completions (p7 §6.2) --------------------------------
// Off unless switched on, and off means off: no module required, no route registered.
const COMPLETIONS_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.COMPLETIONS_ENABLED ?? '1').trim());
let completions = null;
if (COMPLETIONS_ENABLED) {
  try {
    // A surface's cwd is its WORKSPACE's cwd. `tree --json` carries none, and `workspace list
    // --json` is per WINDOW — so the two are correlated by workspace ref, which is the only key
    // both sides publish. (p4 learned this the hard way; cmuxWorkspaceCwds already does the
    // per-window enumeration.)
    const cwdForSurface = async (surface) => {
      if (!SURFACE_RE.test(String(surface || ''))) return null;
      const [workspaces, cwds] = await Promise.all([loadTree(), cmuxWorkspaceCwds()]);
      if (!workspaces) return null;
      const ws = workspaces.find((w) => (w.tabs || []).some((t) => t.id === surface));
      if (!ws) return null;
      const byLabel = cwds.find((c) => c.label && (c.label === ws.title || c.label === ws.ref));
      return (byLabel && byLabel.path) || (cwds[0] && cwds[0].path) || null;
    };
    completions = require('./completions').createCompletions({ cwdForSurface });
  } catch (e) {
    completions = null;
    console.error(`completions: failed to load, continuing without it: ${(e && e.message) || e}`);
  }
}
// ---------- source control (p7 Track C) --------------------------------------
// Reads and writes have SEPARATE switches, and the asymmetry is deliberate.
//
// THE PANEL IS ON BY DEFAULT (opt-out, same shape as COMPLETIONS_ENABLED above). p7 shipped it
// default-off and it stayed off for its whole life, because the switch does not live where anyone
// looks: `loadenv.js` reads a `.env` from the process CWD, and the plists set CWD to the release
// directory — so "the flag" is a file that a deploy replaces. A default that is only ever reached
// through a file nobody edits is not a safety property, it is a feature nobody has.
//
// WRITES STAY OPT-OUT-OF-NOTHING — off unless explicitly set. §12.6's position is unchanged and is
// the reason this line is not symmetric with the one above: direct writes add UNTRACED execution.
// They grant no authority a shell did not already have, but a commit made through the panel is not
// in the terminal scrollback. Reads are bounded by authorizeRead's pinned tuple and were hardened
// against five measured escapes; writes are a different bet. This file is public, and a clone with
// no `.env` also has no SERVER_TOKEN — an open UI (see server.js) that can read git in the open
// workspaces is a very different thing from an open UI that can commit and push.
const GIT_PANEL_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.GIT_PANEL_ENABLED ?? '1').trim());
const GIT_WRITES_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.GIT_WRITES_ENABLED || '').trim());
let gitPanel = null;
if (GIT_PANEL_ENABLED) {
  try {
    gitPanel = require('./gitpanel').createGitPanel({
      workspaceCwds: cmuxWorkspaceCwds,
      writesEnabled: GIT_WRITES_ENABLED,
      log: (rec) => console.log(`git-write ${JSON.stringify(rec)}`),
    });
    console.log(`git panel: enabled (writes ${GIT_WRITES_ENABLED ? 'ON' : 'off'})`);
  } catch (e) {
    gitPanel = null;
    console.error(`git panel: failed to load, continuing without it: ${(e && e.message) || e}`);
  }
}
function sendGitError(res, e) {
  if (e && e.name === 'GitPanelError') return send(res, e.status || 400, { error: e.code });
  send(res, 500, { error: 'git_failed' });
}
// Source-control READ routes (p8). A separate module and a separate construction — gitpanel.js and
// its block above are never edited (specs.md §2.2). Same defensive shape: a broken gitread must
// degrade to "no bar", never to "no mirror".
let gitRead = null;
if (GIT_PANEL_ENABLED) {
  try {
    gitRead = require('./gitread').createGitRead({
      workspaceCwds: cmuxWorkspaceCwds,
      jail: (p) => fsBrowse._jail(p),
      assertRepo: (p) => (gitPanel ? gitPanel.assertRepo(p) : Promise.reject(new Error('git_panel_disabled'))),
      writesEnabled: GIT_WRITES_ENABLED,
      log: (rec) => console.log(`gitread ${JSON.stringify(rec)}`),
    });
    console.log('gitread: enabled');
  } catch (e) {
    gitRead = null;
    console.error(`gitread: failed to load, continuing without it: ${(e && e.message) || e}`);
  }
}
function cmuxGitRead(req, res, u, sub) {
  if (!gitRead) return send(res, 404, { error: 'git_panel_disabled' });
  const dir = u.searchParams.get('dir') || '';
  const done = (p) => p.then((r) => send(res, 200, r)).catch((e) => sendGitError(res, e));
  if (req.method === 'GET') {
    // probe (specs.md §5.2): the ONLY route behind the admission semaphore, and the only one whose
    // waiter must die with its caller. The binding is to THIS request's RESPONSE stream — `res`
    // 'close' with `!res.writableEnded` is the sole predicate that means the caller actually left.
    // Since Node 16 a completed bodyless GET fires `req` 'close' while its response is still
    // pending, so a `req` binding would mark EVERY ordinary queued probe dead. onCancel returns the
    // detach, which gitread runs on admission or settlement — no listener outlives its waiter.
    if (sub === 'probe') {
      return done(gitRead.probe(dir, {
        onCancel: (cancel) => {
          const onResClose = () => { if (!res.writableEnded) cancel(); };
          res.on('close', onResClose);
          return () => res.removeListener('close', onResClose);
        },
      }));
    }
    if (sub === 'status') return done(gitRead.status(dir));
    if (sub === 'branches') return done(gitRead.branches(dir));
    if (sub === 'worktrees') return done(gitRead.worktrees(dir));
    if (sub === 'diff') return done(gitRead.diff(dir, u.searchParams.get('path') || '', u.searchParams.get('staged') === '1'));
  }
  // Generated command TEXT (p8). A NEW handler, async from its first line — never the p7 shape
  // `send(res, 200, { text: gitPanel.command(...) })`, which is synchronous and would serialise a
  // Promise as {"text":{}} and turn the now-normal 403 into an unhandled rejection, fatal on
  // Node ≥ 15 and taking the BRIDGE down with it (specs.md §4.1). Every rejection — refusal,
  // bad_ref, not_on_branch — travels the promise chain into sendGitError; nothing escapes.
  // The text is NOT executed here: it is handed back for the operator to read and decide.
  if (req.method === 'POST' && sub === 'command') {
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      done(gitRead.command(String(b.verb || ''), b.dir, b.params || {}));
    });
  }
  return send(res, 404, { error: 'not_found' });
}
function cmuxGit(req, res, u, sub) {
  if (!gitPanel) return send(res, 404, { error: 'git_panel_disabled' });
  const repo = u.searchParams.get('repo') || '';
  const done = (p) => p.then((r) => send(res, 200, r)).catch((e) => sendGitError(res, e));
  if (req.method === 'GET') {
    if (sub === 'repos') return done(gitPanel.repos().then((repos) => ({ repos })));
    if (sub === 'status') return done(gitPanel.status(repo));
    if (sub === 'branches') return done(gitPanel.branches(repo));
    if (sub === 'worktrees') return done(gitPanel.worktrees(repo));
    if (sub === 'diff') return done(gitPanel.diff(repo, u.searchParams.get('path') || '', u.searchParams.get('staged') === '1'));
    return send(res, 404, { error: 'not_found' });
  }
  if (req.method === 'POST' && (sub === 'stage' || sub === 'unstage')) {
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      // Unknown keys are REJECTED, not ignored: a body that carries something we do not understand
      // is a request we do not understand.
      const keys = Object.keys(b).sort().join(',');
      if (keys !== 'paths,repo') return send(res, 400, { error: 'bad_body' });
      done(gitPanel.write(sub, b.repo, b.paths));
    });
  }
  // Generated command TEXT. It is NOT executed here — it is handed to the client to put in a
  // composer, where the operator reads it and decides.
  if (req.method === 'POST' && sub === 'command') {
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      try { send(res, 200, { text: gitPanel.command(String(b.verb || ''), b.params || {}) }); }
      catch (e) { sendGitError(res, e); }
    });
  }
  return send(res, 404, { error: 'not_found' });
}

function cmuxCompletions(res, u) {
  if (!completions) return send(res, 404, { error: 'completions_disabled' });
  const surface = u.searchParams.get('surface') || '';
  const text = u.searchParams.get('text') || '';
  const caret = Number(u.searchParams.get('caret'));
  if (text.length > 4096) return send(res, 413, { error: 'text_too_long' });
  completions.complete({ surface, text, caret: Number.isFinite(caret) ? caret : text.length })
    .then((r) => send(res, 200, r || { token: null, candidates: [], truncated: false, total: 0 }))
    .catch((e) => send(res, e && e.code === 'no_cwd' ? 409 : 400, { error: (e && e.code) || 'completion_failed' }));
}
const fsHash = (obj) => crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');

// One error shape for every FS failure — no stack traces, no raw errno strings on the wire.
function sendFsError(res, e) {
  if (e && e.name === 'FsError') return send(res, e.status, { error: e.code });
  send(res, 500, { error: 'read_failed' });
}

// GET /cmux/fs/download?path= — the original bytes, as an attachment. The only fs endpoint that
// does not answer JSON, and the only one whose response can be gigabytes: it STREAMS (never
// readFile — a 4 GB VM image would otherwise be pulled into memory first) and honours a single
// Range so an interrupted download can resume instead of starting over.
function cmuxFsDownload(req, res, rawPath) {
  return fsBrowse.download(rawPath).then((info) => {
    const range = parseRange(req.headers['range'], info.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'content-range': `bytes */${info.size}`, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad_range' }));
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : info.size - 1;
    const len = info.size === 0 ? 0 : end - start + 1;
    const headers = {
      'content-type': info.contentType,
      'content-length': String(len),
      'content-disposition': contentDisposition(info.name),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (len === 0) return res.end();
    const stream = fs.createReadStream(info.path, { start, end });
    // Past writeHead there is no way to send a JSON error, so a mid-stream failure can only cut
    // the connection. That is deliberate: a short body against a declared content-length reads as
    // a failed download, where an HTTP 200 carrying an error page would be a corrupt file.
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }).catch((e) => sendFsError(res, e));
}

// ---------- tree: workspaces -> panes -> tabs (surfaces) ---------------------
// One `tree --all --json --id-format both` call gives the whole hierarchy including UUIDs. Every
// workspace exposes BOTH shapes: the flat `tabs` list (every surface in the workspace — what the tab
// strip and every surface-addressed op use) and `panes` (the split grouping, each carrying the ids of
// the tabs that live in it). The flat list is the same array of objects, so a tab object is shared,
// not copied — `pane` on a tab and `tabs` on a pane are two views of one thing.
// `gate` (p41 S2p): the private-surface gate's read — short timeout, no retry; a stall must refuse
// fast rather than hold every send/screen behind a 24 s tree read.
async function loadTree(gate) {
  // `cmux tree` can briefly stall while a surface tears down (e.g. closing a tab an agent was mid-prompt on).
  // Retry once with a longer timeout so a transient stall doesn't hard-fail the whole UI ("tree failed").
  let out = await cmuxP(['tree', '--all', '--json', '--id-format', 'both'], gate ? PRIVATE_GATE_TREE_MS : 12000);
  if (out == null && !gate) { await new Promise((r) => setTimeout(r, 400)); out = await cmuxP(['tree', '--all', '--json', '--id-format', 'both'], 12000); }
  if (out == null) return null;
  let data;
  try { data = JSON.parse(out); } catch (_) { return null; }
  const workspaces = [];
  for (const win of (data.windows || [])) {
    for (const ws of (win.workspaces || [])) {
      const tabs = [];
      const panes = [];
      for (const pane of (ws.panes || [])) {
        const paneId = pane.id || pane.ref;
        const ids = [];
        for (const sf of (pane.surfaces || [])) {
          const tab = {
            id: sf.id || sf.ref,
            ref: sf.ref,
            title: (sf.title || sf.ref || '').trim(),
            type: sf.type || 'terminal',
            selected: !!sf.selected,
            pane: paneId,
            paneRef: pane.ref,
            // selected_in_pane is what the pane actually SHOWS; `selected` is workspace-wide, so on a
            // 3-pane workspace two panes would otherwise report nothing selected at all.
            inPane: sf.selected_in_pane != null ? !!sf.selected_in_pane : !!sf.selected,
          };
          tabs.push(tab);
          ids.push(tab.id);
        }
        panes.push({
          ref: pane.ref,
          id: paneId,
          index: Number.isFinite(pane.index) ? pane.index : panes.length,
          focused: !!pane.focused,
          selected: pane.selected_surface_id || pane.selected_surface_ref || (ids[0] || null),
          tabs: ids,
        });
      }
      workspaces.push({
        ref: ws.ref,
        id: ws.id || ws.ref,
        title: (ws.title || ws.ref || '').trim(),
        selected: !!ws.selected,
        window: win.id || win.ref,
        tabs,
        panes,
      });
    }
  }
  if (!gate) privacy.prime(workspaces);   // S2p: a fresh full tree keeps the gate's cache current
  return workspaces;
}

// ---------- pane layout (geometry) ------------------------------------------
// `cmux rpc pane.list` is the ONLY source of split geometry — the socket exposes no split tree, no
// divider list and no directions. panelayout.js turns its desktop pixel frames into bbox fractions
// plus the derived dividers; see that file for why container_frame is not the reference box.
//
// TARGETING TRAP: the rpc methods take `<thing>_id` (a UUID) — a `workspace` ref param is accepted and
// then SILENTLY IGNORED, answering for whatever workspace is currently selected. Verified on 0.64.20:
// `pane.list {"workspace":"workspace:8"}` returned the panes of workspace:19 once :19 became selected.
// The same trap bit `pane.resize`: divider handles carry pane REFS (panelayout.js uses p.ref), so
// `{"pane":"pane:28"}` was ignored and cmux resized the FOCUSED pane instead — "no adjacent border"
// on one side, the wrong divider moving on the other, and the drag snapping back. Verified on 0.64.25:
// `*_id` accepts a short ref as well as a UUID, so always send `*_id`.
const rpcTarget = (key, value) => ({ [key + '_id']: value });
async function loadLayout(workspace) {
  const out = await cmuxP(['rpc', 'pane.list', JSON.stringify(rpcTarget('workspace', workspace))], 8000);
  if (out == null) return null;
  let raw; try { raw = JSON.parse(out); } catch (_) { return null; }
  return normalizeLayout(raw, { workspace });
}

// Per-tab status ("claude_code=Running ..." -> "Running"). Best-effort; only terminal tabs, capped
// so a huge tree can't fan out into hundreds of cmux calls.
// `cmux list-status` is a WORKSPACE command — `--surface` is not one of its flags (see its --help:
// "List all sidebar status entries for a workspace"). Passing a surface ref was silently ignored,
// so every tab in a workspace reported whatever the workspace reported, and a per-tab read of that
// value is always wrong. Ask once per workspace and label the scope, so no consumer can mistake it
// for per-tab truth. This also drops up to 60 cmux spawns per tree poll to one per workspace.
//
// Value parsing: the line is `claude_code=Needs input icon=bolt.fill color=#4C8DFF`. The old
// /=(\S+)/ stopped at the first space and turned "Needs input" into "Needs" — the status that
// matters most, silently mangled. The value runs to the next `key=` token or end of line.
const STATUS_VALUE_RE = /^[^=\s]+=(.*?)(?=\s+[A-Za-z_][\w.-]*=|$)/;
// p23: list-status returns EVERY sidebar entry for the workspace, and other hooks add their own (a
// NEEDS YOU banner writes `needs_you_<id>=⛔ NEEDS YOU · …` at priority 100, one per session, and they
// sort first). Reading only line one turned the status into banner text, so every tab classified as
// idle — no sidebar indicators and no tab rows. Prefer the agent's own `claude_code=` entry; else the
// first entry that reads as Running / Needs input; else nothing.
const AGENT_STATUS_RE = /^(running|needs input)/i;
function parseStatusLine(out) {
  if (!out) return '';
  const lines = String(out).split('\n').map((l) => l.trim()).filter(Boolean);
  const valueOf = (line) => { const m = line.match(STATUS_VALUE_RE); return m ? m[1].trim() : ''; };
  const agent = lines.find((l) => l.startsWith('claude_code='));
  if (agent) return valueOf(agent);
  for (const l of lines) { const v = valueOf(l); if (AGENT_STATUS_RE.test(v)) return v; }
  return lines.length && !/^needs_you_/.test(lines[0]) ? valueOf(lines[0]) : '';
}
async function statusOfWorkspace(ref) {
  const out = await cmuxP(['list-status', '--workspace', ref], 4000);
  return { status: parseStatusLine(out), needs: needsYouNames(out) };
}
// p24: the NEEDS YOU hook (plugins tools/hooks/needs-you.py) writes one workspace status entry per
// waiting session — `needs_you_<id>=⛔ NEEDS YOU · <session name>: <ask> icon=… color=… priority=100`
// — and clears it when the user answers. The session name is the tab's title, so it pins the wait to
// one tab. Entries for sessions that have since closed match no tab and are ignored.
function needsYouNames(out) {
  const names = new Set();
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().match(/^needs_you_[^=]*=.*?NEEDS YOU\s*·\s*(.+?):\s/);
    if (m) names.add(m[1].trim().toLowerCase());
  }
  return names;
}
const TITLE_SPINNER_RE = /^[\s⠀-⣿✳✶✻✽✢·◐◑◒◓]+/;
const STATUS_WS_CAP = 30;

// p24: PER-TAB attention. Status above is a workspace fact, so every tab in a busy workspace read the
// same green "running". cmux's notification list is per SURFACE: the newest UNREAD one says whether
// that tab is waiting on the user (a NEEDS YOU banner, a permission/input prompt) or finished a turn
// nobody has looked at. One list-notifications call per tree, not one per tab.
const WAITING_RE = /NEEDS YOU|needs (your )?input|waiting for (your )?(input|response|approval)|permission/i;
function attentionOf(n) {
  return WAITING_RE.test([n.title, n.subtitle, n.body].join(' ')) ? 'waiting' : 'done';
}
async function unreadBySurface() {
  if (tmuxCli) return new Map();
  const out = await cmuxP(['list-notifications', '--json'], 4000);
  let list = [];
  try { list = JSON.parse(out || '[]'); } catch (_) { list = []; }
  const by = new Map();
  for (const n of Array.isArray(list) ? list : []) {
    if (!n || n.is_read || !n.surface_id) continue;
    const prev = by.get(n.surface_id);
    // a waiting notification outranks a done one; within a rank the newest wins
    const a = attentionOf(n);
    if (!prev || (a === 'waiting' && prev.attention !== 'waiting')
      || (a === prev.attention && String(n.created_at) > String(prev.at))) {
      by.set(n.surface_id, { attention: a, at: n.created_at || '', title: n.title || '' });
    }
  }
  return by;
}
async function attachAttention(workspaces) {
  let by;
  try { by = await unreadBySurface(); } catch (_) { return; }
  for (const ws of workspaces) for (const t of ws.tabs || []) {
    const hit = t.type === 'terminal' && by.get(String(t.id).toUpperCase());
    if (hit && t.attention !== 'waiting') t.attention = hit.attention;   // a NEEDS YOU entry already won
  }
}
// Viewing a tab from the phone reads its notifications, exactly as visiting it on the Mac does —
// otherwise a tab answered from the phone would stay "waiting" until someone opened it on the Mac.
async function markSurfaceRead(surface) {
  if (tmuxCli) return;
  const out = await cmuxP(['list-notifications', '--json'], 4000);
  let list = []; try { list = JSON.parse(out || '[]'); } catch (_) { return; }
  const want = String(surface).toUpperCase();
  for (const n of Array.isArray(list) ? list : []) {
    if (n && !n.is_read && n.id && String(n.surface_id || '').toUpperCase() === want) {
      await cmuxP(['mark-notification-read', '--id', n.id], 4000);
    }
  }
}
async function attachStatuses(workspaces) {
  const withTerminals = workspaces.filter((ws) => (ws.tabs || []).some((t) => t.type === 'terminal'));
  const capped = withTerminals.slice(0, STATUS_WS_CAP);
  // chunked, not one big Promise.all: concurrent cmux spawns every tree poll starve
  // terminal.replay for the OPEN tab (same contention as the screenshot-cadence lesson)
  for (let i = 0; i < capped.length; i += 8) {
    await Promise.all(capped.slice(i, i + 8).map(async (ws) => {
      const { status, needs } = await statusOfWorkspace(ws.ref);
      ws.status = status;
      for (const t of ws.tabs) if (t.type === 'terminal') {
        t.status = status; t.statusScope = 'workspace';
        if (needs.size && needs.has(String(t.title || '').replace(TITLE_SPINNER_RE, '').trim().toLowerCase())) t.attention = 'waiting';
      }
    }));
  }
  await attachAttention(workspaces);
  // p5 radar coverage metadata (additive). A tab in a workspace past the cap has no status because
  // nobody ASKED, which is a different fact from "cmux reported nothing" — radar renders the first
  // as `unknown` and must never render either as a green.
  const terminalTabs = [];
  for (const ws of workspaces) {
    const covered = capped.indexOf(ws) !== -1;
    for (const t of ws.tabs) if (t.type === 'terminal') { t.statusCovered = covered; terminalTabs.push(t); }
  }
  return {
    workspaces,
    statusTruncated: withTerminals.length > STATUS_WS_CAP,
    covered: terminalTabs.filter((t) => t.statusCovered).length,
    terminalTabs: terminalTabs.length,
  };
}

async function cmuxTree(res) {
  const ws = privacy.filterTree(await loadTree());
  if (ws == null) return send(res, 502, { error: 'cmux_failed' });
  const cov = await attachStatuses(ws);
  send(res, 200, {
    workspaces: ws,
    capabilities: capabilities(),   // p18 (additive): what the page may offer for this machine (+ cmux version)
    // ---- p5 radar (additive keys; `workspaces` is untouched) ----
    machineId: MACHINE_ID,
    statusTruncated: cov.statusTruncated,
    // `cap` now counts WORKSPACES, not tabs — status is a workspace fact, so that is the unit that
    // can be truncated. `capScope` says so explicitly rather than leaving a consumer to assume tabs.
    statusCoverage: { covered: cov.covered, terminalTabs: cov.terminalTabs, cap: STATUS_WS_CAP, capScope: 'workspace' },
  });
}

// GET /cmux/layout?workspace=&h= -> normalized pane geometry (hash-deduped like /cmux/grid).
function cmuxLayout(res, workspace, ifHash) {
  loadLayout(workspace).then((l) => (l ? sendHashed(res, l, ifHash) : send(res, 502, { error: 'cmux_failed' })));
}

// GET /cmux/layout-stream?workspace=&h= -> SSE of layout frames, pushed only when the geometry moves.
// This is what makes a split created (or dragged) ON THE MAC appear on the phone: one cheap cmux call
// per tick, no per-surface fan-out, backed off hard while the layout sits still.
function cmuxLayoutStream(req, res, workspace, ifHash) {
  sseHead(res);
  let lastHash = ifHash || null, alive = true, timer = null, idle = 0;
  const delay = () => (idle > 4 ? 2500 : 700);
  const schedule = () => { if (alive) timer = setTimeout(tick, delay()); };
  const tick = () => {
    if (!alive) return;
    loadLayout(workspace).then((l) => {
      if (!alive) return;
      if (!l) { res.write('event: error\ndata: cmux_failed\n\n'); return schedule(); }
      const h = payloadHash(l);
      if (h !== lastHash) { lastHash = h; idle = 0; res.write('data: ' + redactTokens(JSON.stringify({ ...l, h })) + '\n\n'); }
      else idle++;
      schedule();
    });
  };
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 15000);
  tick();
  const done = () => { if (!alive) return; alive = false; if (timer) clearTimeout(timer); clearInterval(hb); try { res.end(); } catch (_) {} };
  req.on('close', done); req.on('error', done);
}

// ---------- colored grid + text screen (addressed by surface) ---------------
// Paint cmux's render-grid for one surface. We address by surface UUID via `surface_id` — a REF
// (surface:N) is window-context-relative and does NOT resolve from this detached (launchd) process,
// so every op here must use the stable UUID the client carries. Styles carry hex fg/bg + attrs;
// row_spans are positioned runs. Falls back to plain read-screen text when replay is briefly missing.
//
// Conditional polling: every grid response carries an `h` (md5 of the payload). The client echoes it
// back as ?h= on the next poll; if the grid hasn't changed we answer `{same:1}` (~10 bytes) instead
// of re-shipping the whole scrollback (100KB+ for a long session, twice a second, over a tunnel).
const payloadHash = (obj) => crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
function sendHashed(res, obj, ifHash) {
  const h = payloadHash(obj);
  if (ifHash && ifHash === h) return send(res, 200, { same: 1 });
  send(res, 200, { ...obj, h });
}
// Every SSE endpoint here opens the same way: no caching, no proxy buffering, a first comment so the
// client's onopen fires before the first real frame.
function sseHead(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
}
// Build the grid payload for one surface (replay → plain-text fallback). cb(obj) or cb(null) on failure.
function gridPayload(surface, done) {
  // S2r: every grid that leaves here is token-masked, wrap-aware (a token can span rows and spans).
  const cb = (o) => done(o && o.grid ? { ...o, grid: redactGrid(o.grid) } : o);
  cmux(['rpc', 'terminal.replay', JSON.stringify({ surface_id: surface })], (err, stdout) => {
    if (!err) {
      try {
        const d = JSON.parse(stdout);
        const rg = d && d.render_grid;
        if (rg && Array.isArray(rg.styles) && Array.isArray(rg.row_spans)) {
          const sbRows = rg.scrollback_rows || 0;
          const sbSpans = Array.isArray(rg.scrollback_spans) ? rg.scrollback_spans : [];
          let rows = sbRows + (rg.rows || 0);
          const cut = Math.max(0, rows - CMUX_GRID_MAX_ROWS);
          rows -= cut;
          const spans = [];
          for (const s of sbSpans) { const r = s.row - cut; if (r >= 0) spans.push(r === s.row ? s : { ...s, row: r }); }
          for (const s of rg.row_spans) spans.push({ ...s, row: s.row + sbRows - cut });
          return cb({ seq: d.seq, grid: { columns: rg.columns, rows, styles: rg.styles, spans, cursor: rg.cursor } });
        }
      } catch (_) { /* fall through to plain text */ }
    }
    cmux(['read-screen', '--surface', surface, '--scrollback', '--lines', String(CMUX_GRID_MAX_ROWS)], (e2, txt) => {
      if (e2) return cb(null);
      const lines = (txt || '').split('\n');
      const spans = lines.map((t, r) => ({ row: r, column: 0, style_id: 0, text: t }));
      cb({ grid: { columns: 0, rows: lines.length, styles: [], spans, cursor: null, plain: true } });
    });
  });
}
function cmuxGrid(res, surface, ifHash) {
  gridPayload(surface, (obj) => (obj ? sendHashed(res, obj, ifHash) : send(res, 502, { error: 'cmux_failed' })));
}

// GET /cmux/grid-stream?surface=&h= -> SSE of hash-deduped grid frames (push replaces client polling).
// Same payload + `h` semantics as /cmux/grid, but the request-per-frame round trip is gone: the bridge
// watches the surface on an adaptive cadence (fast while changing, backed off when idle) and pushes a
// frame ONLY when the grid hash moves. `?h=` (the client's cached hash) suppresses the initial frame
// when nothing changed since the tab was last shown.
function cmuxGridStream(req, res, surface, ifHash) {
  sseHead(res);
  let lastHash = ifHash || null, alive = true, timer = null, idle = 0;
  const delay = () => (idle > 3 ? 900 : 250);
  const schedule = () => { if (alive) timer = setTimeout(tick, delay()); };
  const tick = () => {
    if (!alive) return;
    gridPayload(surface, (obj) => {
      if (!alive) return;
      if (!obj) { res.write('event: error\ndata: cmux_failed\n\n'); return schedule(); }
      const h = payloadHash(obj);
      if (h !== lastHash) { lastHash = h; idle = 0; res.write('data: ' + redactTokens(JSON.stringify({ ...obj, h })) + '\n\n'); }
      else idle++;
      schedule();
    });
  };
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 15000);
  tick();
  const done = () => { if (!alive) return; alive = false; if (timer) clearTimeout(timer); clearInterval(hb); try { res.end(); } catch (_) {} };
  req.on('close', done); req.on('error', done);
}

// GET /cmux/panes-stream?surfaces=a,b,c&h=h1,h2,h3 -> ONE SSE carrying every visible pane's grid.
// Frames are `{surface, grid, seq, h}` — same payload as /cmux/grid-stream plus which surface it is.
//
// Why one stream and not N: a grid frame costs a `terminal.replay` spawn against the cmux app, and
// concurrent replays starve each other (the same contention that once made browser screenshots push
// terminal mirrors to ~10s). So the surfaces are walked STRICTLY one at a time, round robin, and the
// cadence is global: quick while any pane is moving, backed off hard when the whole set is idle.
function cmuxPanesStream(req, res, surfaces, hashes) {
  sseHead(res);
  const last = new Map();
  surfaces.forEach((s, i) => last.set(s, (hashes && hashes[i]) || null));
  let alive = true, timer = null, i = 0, quietRounds = 0;
  // per-surface round: a 3-pane workspace refreshes each pane every 3 ticks, so keep ticks short
  // while anything is changing — the per-PANE rate is what the eye sees, not the tick rate.
  const delay = () => (quietRounds > surfaces.length * 3 ? 700 : 160);
  const schedule = () => { if (alive) timer = setTimeout(tick, delay()); };
  const tick = () => {
    if (!alive) return;
    const surface = surfaces[i % surfaces.length];
    i++;
    gridPayload(surface, (obj) => {
      if (!alive) return;
      if (!obj) { res.write('event: error\ndata: ' + JSON.stringify({ surface, error: 'cmux_failed' }) + '\n\n'); return schedule(); }
      const h = payloadHash(obj);
      if (h !== last.get(surface)) {
        last.set(surface, h); quietRounds = 0;
        res.write('data: ' + redactTokens(JSON.stringify({ surface, ...obj, h })) + '\n\n');
      } else quietRounds++;
      schedule();
    });
  };
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 15000);
  tick();
  const done = () => { if (!alive) return; alive = false; if (timer) clearTimeout(timer); clearInterval(hb); try { res.end(); } catch (_) {} };
  req.on('close', done); req.on('error', done);
}

// GET /cmux/screen?surface=&lines= -> { screen }  (plain-text snapshot / scrollback paging)
function cmuxScreen(res, surface, lines) {
  const args = ['read-screen', '--surface', surface];
  const n = parseInt(lines, 10);
  if (Number.isFinite(n) && n > 0) args.push('--scrollback', '--lines', String(Math.min(n, CMUX_SCROLLBACK_MAX)));
  cmux(args, (err, stdout, stderr) => (err
    ? send(res, 502, { error: 'cmux_failed', detail: String(stderr || (err && err.message) || '').slice(0, 400) })
    : send(res, 200, { screen: redactText(stdout || '') })));   // S2r: wrap-aware
}

// ---------- deep scrollback: the rows ABOVE the replay window -----------------
// `terminal.replay` is capped at 240 scrollback rows BY CMUX. Verified on 0.64.19 against a
// 3000-line buffer: `scrollback_rows`, `max_scrollback_rows`, `lines` and `scrollback:true` all come
// back with scrollback_rows === 240, and `mobile.terminal.replay` agrees. So the styled grid alone can
// NEVER carry the history a pane is supposed to remember — CMUX_GRID_MAX_ROWS above is a ceiling the
// replay path cannot reach, not a promise it keeps. `read-screen --scrollback --lines N` can: it
// returns the last N lines of the same buffer as plain text (measured: 2000 asked, 2000 returned).
//
// This route hands back the rows that sit strictly ABOVE the replay window, so the client can paint
// them as unstyled history on top of the styled grid and read one continuous 2000-row pane.
//
// THE SEAM IS FOUND BY CONTENT, NOT BY ARITHMETIC. read-screen trims the buffer's trailing blank rows
// and replay does not, so counting rows in from either end drifts by however many blank rows happen to
// sit below the cursor in the desktop viewport — and a drift of one duplicates or swallows a line at
// the join, which reads as corruption. Instead: take the oldest styled row that has content as an
// anchor and find it (plus its successor, so a repeated line can't match the wrong copy) scanning the
// plain text from the END backwards, which is the most recent occurrence.
//
// ALT-SCREEN SURFACES ARE EXCLUDED. cmux defines an alternate screen as having zero scrollback, and the
// history read-screen still reports there is the PRIMARY buffer sitting behind the full-screen TUI —
// prepending it would invent a past the reader never saw. `altScreen: true` says so, so the client can
// tell "no history exists" from "history not fetched yet".
//
// THE REPLAY CAP IS LEARNED, NOT ASSUMED. 240 is what 0.64.19–0.64.25 measured, but nothing promises
// every cmux build caps replay at that number. The old shortcut — `scrollback_rows < 240` means the
// replay already reaches the top of the buffer — answers `complete` for EVERY pane on a build whose
// cap is lower, and the pane then shows one screen plus that cap forever. So the shortcut is only taken
// once this bridge has SEEN the cap: the scrollback_rows of replays that read-screen proved had rows
// above them. Every such observation must agree (a fixed row cap); if they disagree, the cap is not a
// row count on this build and the shortcut is never taken — the read is always paid. Until then too.
// Limit, stated: once a cap is learned, a window SMALLER than it takes the shortcut, so a build whose
// cap varied downward per surface would not be caught. Every measured build caps at one fixed number,
// and the learned cap lives only as long as the bridge process (a cmux update + bridge restart relearns).
//
// WHEN THE CONTENT JOIN FAILS, SPLICE BY COUNT. A seam that cannot be found (row text formatted
// differently by an older cmux: wide-char spacers, soft-wrap joins, trailing-space handling) used to
// drop the whole history silently — `rows: []` — which is exactly "a pane shows very few lines". Now
// the join first retries whitespace-blind on several anchors, and failing that splices by row count
// (read-screen trims trailing blank rows, so the styled window's trailing blanks are discounted). That
// answer is marked `aligned: false, approx: true`: a row may be duplicated or lost at the seam, which
// beats losing all ~1700 of them.
const HISTORY_MAX_ROWS = 2000;     // rows a pane is expected to remember
const replayCap = { n: 0, min: 0, max: 0 };   // saturated replay scrollback_rows seen by this bridge
function learnReplayCap(cap, sbRows) {
  if (!(sbRows > 0)) return;
  cap.min = cap.n ? Math.min(cap.min, sbRows) : sbRows;
  cap.max = cap.n ? Math.max(cap.max, sbRows) : sbRows;
  cap.n++;
}
// True when this replay provably reaches the top of the buffer, without reading it.
function replayReachesTop(cap, sbRows) {
  return cap.n > 0 && cap.min === cap.max && sbRows < cap.min;
}

// Row text as the client paints it: positioned runs, gaps padded with spaces. Map row -> text.
function spansToText(spans) {
  const byRow = new Map();
  for (const sp of (spans || [])) {
    if (!byRow.has(sp.row)) byRow.set(sp.row, []);
    byRow.get(sp.row).push(sp);
  }
  const out = new Map();
  for (const [row, list] of byRow) {
    list.sort((a, b) => a.column - b.column);
    let text = '';
    for (const sp of list) {
      if (sp.column > text.length) text += ' '.repeat(sp.column - text.length);
      text += sp.text || '';
    }
    out.set(row, text);
  }
  return out;
}
// Whitespace-blind row identity: a wide char's spacer column, NBSP vs space, trailing padding and
// control bytes are formatting, not content.
function normRow(s) {
  return String(s == null ? '' : s).replace(/[\s\u0000-\u001f\u007f ​]+/g, '');
}
// Index in `lines` where the replay window's first row sits, or -1 when it can't be located.
// `styled` is the replay window's rows in order (scrollback first, then viewport).
// Passes, strictest first; within each, anchors are the first few non-blank styled rows and matches
// are scanned from the END (the replay window is the most recent copy of a repeated line):
//   1. trailing whitespace ignored, anchor + its successor must match
//   2. all whitespace ignored, anchor + successor
//   3. all whitespace ignored, anchor alone — only if it occurs exactly ONCE in the text
// A match with fewer rows above it than the anchor has above it in the window means the buffer's top
// is inside the window: 0, nothing above.
function alignHistory(lines, styled) {
  const anchors = [];                                   // a blank anchor would match everywhere
  for (let i = 0; i < styled.length && i < 40 && anchors.length < 5; i++) if (normRow(styled[i])) anchors.push(i);
  if (!anchors.length) return -1;
  const trimmed = (x) => String(x == null ? '' : x).trimEnd();
  for (const f of [trimmed, normRow]) {
    const L = lines.map(f);
    for (const k of anchors) {
      const a0 = f(styled[k]);
      const a1 = k + 1 < styled.length ? f(styled[k + 1]) : null;
      for (let i = L.length - 1; i >= 0; i--) {
        if (L[i] !== a0) continue;
        if (a1 !== null && i + 1 < L.length && L[i + 1] !== a1) continue;
        return Math.max(0, i - k);
      }
    }
  }
  const L = lines.map(normRow);
  for (const k of anchors) {
    const a0 = normRow(styled[k]);
    const hits = [];
    for (let i = 0; i < L.length && hits.length < 2; i++) if (L[i] === a0) hits.push(i);
    if (hits.length === 1) return Math.max(0, hits[0] - k);
  }
  return -1;
}
// Count-based seam, for when the content join fails: the plain text ends where the styled window
// ends, less the window's trailing blank rows (read-screen trims those). Approximate by construction.
function spliceByCount(lines, styled) {
  let trailing = 0;
  for (let r = styled.length - 1; r >= 0 && !normRow(styled[r]); r--) trailing++;
  return Math.max(0, lines.length - (styled.length - trailing));
}

// ---------- tmux-hosted surfaces: the history lives in tmux, not in the cmux pane -----------------
// A cmux pane that runs `tmux attach` (chief-of-staff workers since 2026-10-18) shows only tmux's
// current screen. tmux drew it on the ALTERNATE screen, which cmux reports with zero scrollback, so
// the pane had one screen of history while tmux held thousands of lines (measured: m-cad-onboard-3,
// cmux 68 lines, tmux history_size 3046). Even with the alternate screen switched off, the cmux
// scrollback only starts at the last attach. So for these surfaces the plain text comes from
// `tmux capture-pane` instead of read-screen; the content seam and the splice below are unchanged.
//
// WHICH SURFACE IS WHICH SESSION: the workers' tmux.conf lists CMUX_SURFACE_ID in update-environment,
// so every attach writes the attaching pane's surface id into that session's environment. A session
// whose id matches the asked surface is the one on screen. Read-only: list-sessions,
// show-environment and capture-pane never touch a pane. No socket, no match, or any tmux error =
// the surface is treated as a plain cmux surface, exactly as before.
// The socket is the cmux-remote headless tmux layout; TMUX_SOCKET overrides it.
const HOSTED_TMUX_SOCKET = process.env.TMUX_SOCKET
  || path.join(os.homedir(), '.local', 'state', 'cmux-remote', `tmux-${process.getuid()}`, 'default');
const hostedTmux = !tmuxCli ? require('./lib/tmux-cli').createTmuxCli({
  tmuxBin: process.env.TMUX_BIN || '', socket: HOSTED_TMUX_SOCKET, log: () => {},
}) : null;
// surface uuid -> tmux session name, or null when no session on the hosted socket shows it.
async function hostedTmuxSession(surface) {
  if (!hostedTmux || !new RegExp(`^${UUID}$`).test(surface) || !fs.existsSync(HOSTED_TMUX_SOCKET)) return null;
  const ls = await hostedTmux._run(['list-sessions', '-F', '#{session_name}']);
  if (ls.code !== 0) return null;
  const want = surface.toLowerCase();
  for (const name of ls.stdout.split('\n').filter(Boolean)) {
    const env = await hostedTmux._run(['show-environment', '-t', `=${name}`, 'CMUX_SURFACE_ID']);
    const id = env.code === 0 ? env.stdout.trim().replace(/^CMUX_SURFACE_ID=/, '') : '';
    if (id.toLowerCase() === want) return name;
  }
  return null;
}
// The last `want` rows of the session's history plus its visible screen, as read-screen would print
// them: plain text, trailing blank rows trimmed (read-screen trims them; spliceByCount relies on it).
async function hostedTmuxText(name, want) {
  const r = await hostedTmux._run(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${want}`]);
  if (r.code !== 0) return null;
  const lines = r.stdout.replace(/\n$/, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

// GET /cmux/history?surface=&rows=
//   -> { rows: [text…], aligned, approx?, complete?, altScreen?, tmux?, styledRows, scrollbackRows, bufferRows? }
// `complete: true` = nothing exists above the styled window (the client stops asking).
function cmuxHistory(res, surface, rowsParam) {
  const asked = parseInt(rowsParam, 10);
  const want = Math.min(Number.isFinite(asked) && asked > 0 ? asked : HISTORY_MAX_ROWS, CMUX_SCROLLBACK_MAX);
  cmux(['rpc', 'terminal.replay', JSON.stringify({ surface_id: surface })], (err, stdout) => {
    if (err) return send(res, 502, { error: 'cmux_failed' });
    let rg = null;
    try { rg = (JSON.parse(stdout) || {}).render_grid || null; } catch (_) { rg = null; }
    if (!rg || !Array.isArray(rg.row_spans)) return send(res, 502, { error: 'cmux_failed' });
    const sbRows = rg.scrollback_rows || 0;
    const styledRows = sbRows + (rg.rows || 0);
    const base = { styledRows, scrollbackRows: sbRows };
    hostedTmuxSession(surface).catch(() => null).then((tmuxName) => {
    if (!tmuxName && rg.active_screen && rg.active_screen !== 'primary') {
      return send(res, 200, { rows: [], aligned: false, altScreen: true, ...base });
    }
    // The replay window provably reaches the top of the buffer (see the learned cap above), so there
    // is nothing above it — and no reason to pay for a 2000-line read to prove it. Not for tmux: the
    // cmux buffer's top is the last attach, not the top of tmux's history.
    if (!tmuxName && replayReachesTop(replayCap, sbRows)) return send(res, 200, { rows: [], aligned: true, complete: true, ...base });
    const sbText = spansToText(rg.scrollback_spans);
    const vpText = spansToText(rg.row_spans);
    const styled = [];
    for (let r = 0; r < sbRows; r++) styled.push(sbText.get(r) || '');
    for (let r = 0; r < (rg.rows || 0); r++) styled.push(vpText.get(r) || '');
    const readText = (cb) => {
      if (!tmuxName) return cmux(['read-screen', '--surface', surface, '--scrollback', '--lines', String(want)], cb, 15000);
      hostedTmuxText(tmuxName, want).then((l) => cb(l ? null : new Error('tmux_failed'), l ? l.join('\n') : ''), (e) => cb(e, ''));
    };
    readText((e2, txt) => {
      if (e2) return send(res, 502, { error: tmuxName ? 'tmux_failed' : 'cmux_failed' });
      const lines = String(txt || '').replace(/\n$/, '').split('\n');
      const bufferRows = lines.length;
      const tmuxTag = tmuxName ? { tmux: tmuxName } : {};
      let start = alignHistory(lines, styled);
      const aligned = start >= 0;
      if (!aligned) start = spliceByCount(lines, styled);
      const approx = aligned ? {} : { approx: true };
      if (start <= 0) return send(res, 200, { rows: [], aligned, ...approx, complete: true, ...tmuxTag, ...base, bufferRows });
      // Rows exist above this replay window, so its scrollback_rows IS the cap. Only a content-proved
      // seam teaches it — a count-based guess is not evidence. tmux text says nothing about cmux's cap.
      if (aligned && !tmuxName) learnReplayCap(replayCap, sbRows);
      const room = Math.max(0, want - styledRows);
      send(res, 200, { rows: redactRows(lines).slice(Math.max(0, start - room), start), aligned, ...approx, ...tmuxTag, ...base, bufferRows });
    });
    });
  }, 10000);
}

// GET /cmux/stream?surface= -> SSE of base64(screen) frames. Poll read-screen, emit only on change.
function cmuxStream(req, res, surface) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  let last = null, alive = true, busy = false;
  const tick = () => {
    if (!alive || busy) return;
    busy = true;
    cmux(['read-screen', '--surface', surface], (err, stdout) => {
      busy = false;
      if (!alive) return;
      if (err) { res.write('event: error\ndata: cmux_failed\n\n'); return; }
      const screen = stdout || '';
      if (screen !== last) {
        last = screen;
        res.write('data: ' + Buffer.from(redactText(screen), 'utf8').toString('base64') + '\n\n');
      }
    }, 5000);
  };
  const iv = setInterval(tick, 400);
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 15000);
  tick();
  const done = () => { if (!alive) return; alive = false; clearInterval(iv); clearInterval(hb); try { res.end(); } catch (_) {} };
  req.on('close', done); req.on('error', done);
}

// ---------- input (addressed by surface) ------------------------------------
// POST /cmux/send { surface, text, submit, expect_seq?, sendId? } — type text into a tab, optionally press
// enter to submit. Typing into a terminal is a BLIND WRITE, so this route owes its callers three
// things the first version did not give them:
//
//  1. PER-SURFACE SERIALIZATION OF EVERY SEND. All /cmux/send work for one surface — with or
//     without expect_seq — queues through one promise chain, so a check-then-write pair can never
//     be interleaved by another send for the same surface. Serializing only the preconditioned
//     sends would leave an unguarded legacy call free to land between a check and its write, which
//     is exactly the race the precondition exists to close.
//  2. A SEQ PRECONDITION THAT FAILS CLOSED. expect_seq is compared, inside the serialized section,
//     against the ENVELOPE seq of a fresh grid read taken through the same gridPayload path
//     /cmux/grid serves. (`grid.state_seq` is a phantom field that is never present on real data;
//     it is never read here.) A seq that cannot be re-read is answered `seq_unavailable`, never
//     waved through — an unverifiable precondition is not a satisfied one.
//  3. PHASE-DISTINCT WRITE FAILURES. "Nothing was typed" may only be claimed when it is provable,
//     and it is provable in exactly one case: the text command's child never started. Every later
//     failure — timeout, signal, nonzero exit, late error — leaves the terminal side effect
//     unproved and must say so instead of lying to the operator. The blanket `cmux_failed` is gone
//     from this route.
// Flags that say WHERE a send goes. `runSendCommand` refuses to adapt these away — see the comment
// on the retry branch there.
const TARGETING_FLAGS = new Set(['--surface', '--workspace', '--pane']);
const SEND_CHAINS = new Map();
// The per-surface queue. `fn` runs only once every earlier send for this surface has settled; a
// rejection never poisons the chain, and the key is dropped when the queue drains so a long-lived
// bridge does not accumulate one entry per surface it has ever written to.
function serializeSend(surface, fn) {
  // KEYED CASE-INSENSITIVELY, because SURFACE_RE accepts either casing of a uuid. Two callers
  // spelling the same surface differently must not land on two different chains — that would let
  // one caller's send interleave another's check/write and defeat the whole precondition.
  const key = String(surface).toLowerCase();
  const prev = SEND_CHAINS.get(key) || Promise.resolve();
  const done = prev.then(fn);
  const settled = done.then(() => {}, () => {});
  SEND_CHAINS.set(key, settled);
  settled.then(() => { if (SEND_CHAINS.get(key) === settled) SEND_CHAINS.delete(key); });
  return done;
}
// The same 8 s budget the shared cmux() runner applies. Overridable ONLY so the post-dispatch
// timeout branch is exercisable in milliseconds rather than eight seconds; unset in production.
const SEND_CMD_TIMEOUT_MS = Number(process.env.CMUX_SEND_TIMEOUT_MS) || 8000;
// Run one cmux command for this route and report WHICH PHASE a failure belongs to.
//
// The discriminator is structural, never a match on the error message: Node assigns
// `subprocess.pid` synchronously when uv_spawn succeeds and leaves it `undefined` when the spawn
// itself fails (the ENOENT/EACCES class), and the callback always fires after execFile() has
// returned. So `pid === undefined` is the one state that PROVES no child ever ran; anything else is
// a child that started and may have written before it died. A flag retry (adaptArgs, mirroring
// cmux()) carries `dispatched` forward — once any attempt has started a child, no later attempt is
// allowed to claim nothing happened. cb(null) on success, cb({dispatched, detail}) on failure.
function runSendCommand(args, cb, dispatched, tries) {
  const child = cli(args, { timeout: SEND_CMD_TIMEOUT_MS },
    (err, stdout, stderr) => {
      const started = dispatched || child.pid !== undefined;
      const m = err && (tries || 0) < 3 && String(stderr || '').match(/unknown flag '(--[a-z-]+)'/);
      // THE TARGETING FLAG IS NEVER ADAPTED AWAY. `adaptArgs` drops an unknown flag AND its value
      // and retries, which is right for `--focus` and `--id-format` and catastrophic for
      // `--surface`: the retry would be an UNTARGETED send, and cmux would type this text into
      // whatever it considers the default target. That is the wrong-pane write every gate upstream
      // exists to prevent, arrived at by a retry nobody asked for. If cmux ever rejects the flag
      // that says WHERE, the answer is to stop, not to send somewhere else. The first attempt did
      // dispatch, so this reports as post-dispatch and the route maps it to `send_unconfirmed` —
      // the conservative direction, never a false "nothing was typed".
      if (m && TARGETING_FLAGS.has(m[1])) {
        return cb({ dispatched: started, detail: `cmux rejected ${m[1]}; refusing to retry untargeted` });
      }
      if (m) {
        const next = adaptArgs(args, m[1]);
        if (next) return runSendCommand(next, cb, started, (tries || 0) + 1);
      }
      cb(err ? { dispatched: started, detail: String(stderr || err.message || err).slice(0, 200) } : null);
    });
}
const runSendCommandP = (args) => new Promise((resolve) => runSendCommand(args, resolve, false, 0));

const SUBMIT_SETTLE_MS = Number(process.env.CMUX_SUBMIT_SETTLE_MS ?? 150);
// p41 D133: optional sendId (the app's D121 uuid, passed through by the server on EVERY attempt,
// including the server's D133 queue retries). The case it closes: attempt 1 typed the text but its
// reply was slow (load spike, 15 s relay timeout), the server retries -> without this it types twice.
// An executed id is remembered per surface (LRU, SEND_SEEN_LIMITS); a repeat answers the FIRST
// outcome with duplicate: true and types nothing. A repeat that arrives while the first is still
// running waits for it. Only outcomes where text MAY have landed are remembered (2xx and the
// unproved-write 502s); a provably-untyped failure (400s, 409 seq, send_failed) is forgotten so the
// retry really sends. In memory only: a bridge restart forgets them (the server's D121 store still
// dedupes a send it saw succeed).
const SEND_SEEN_LIMITS = Object.freeze({ max: 500, ttlMs: 10 * 60 * 1000 });
const SEND_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SEND_SEEN = new Map();       // key -> { at, code, body }; insertion order = age
const SEND_INFLIGHT = new Map();   // key -> Promise<{ code, body }>
const SEND_FORGET = new Set(['send_failed', 'bad_json', 'bad_surface', 'seq_unavailable', 'seq_changed']);
function pruneSendSeen() {
  const t = Date.now();
  for (const [k, v] of SEND_SEEN) { if (t - v.at > SEND_SEEN_LIMITS.ttlMs) SEND_SEEN.delete(k); else break; }
  while (SEND_SEEN.size > SEND_SEEN_LIMITS.max) SEND_SEEN.delete(SEND_SEEN.keys().next().value);
}
const dupBody = (body) => (body && typeof body === 'object' ? { ...body, duplicate: true } : { ok: true, duplicate: true });
function cmuxSend(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    // OWN-PROPERTY presence, not truthiness (expect_seq 0 is a legitimate precondition). A PRESENT
    // expect_seq that is not a finite JSON number — string, null, object, array, NaN, and the
    // Infinity a 1e999 literal parses to — is rejected HERE: before any grid read and before the
    // queue. Treating invalid-present as absent would silently drop the precondition; comparing it
    // would fabricate a seq_changed. bad_json is the code the reply route already reads as
    // provably-pre-typing.
    const wants = Object.prototype.hasOwnProperty.call(b, 'expect_seq');
    if (wants && !Number.isFinite(b.expect_seq)) return send(res, 400, { error: 'bad_json' });
    const text = typeof b.text === 'string' ? b.text : '';
    // D133: dedupe by sendId BEFORE the queue, so a retry never queues a second typing.
    let sidKey = null;
    let settle = null;
    if (b.sendId != null) {
      if (typeof b.sendId !== 'string' || !SEND_ID_RE.test(b.sendId)) return send(res, 400, { error: 'bad_send_id' });
      sidKey = surface.toLowerCase() + '\u0000' + b.sendId;
      pruneSendSeen();
      const hit = SEND_SEEN.get(sidKey);
      if (hit) return send(res, hit.code, dupBody(hit.body));
      const pending = SEND_INFLIGHT.get(sidKey);
      if (pending) return pending.then((r) => send(res, r.code, dupBody(r.body)));
      SEND_INFLIGHT.set(sidKey, new Promise((r) => { settle = r; }));
    }
    let replied = false;
    const answer = (code, body) => {
      if (replied) return; replied = true;
      if (sidKey) {
        SEND_INFLIGHT.delete(sidKey);
        if (!(code >= 400 && code < 500) && !(body && SEND_FORGET.has(body.error))) {
          SEND_SEEN.set(sidKey, { at: Date.now(), code, body });
          pruneSendSeen();
        }
        settle({ code, body });
      }
      send(res, code, body);
    };
    serializeSend(surface, async () => {
      // A tmux-only session (p41: a detached tmux worker no cmux pane shows) is typed into with tmux.
      const tgt = tmuxCli ? null : await sessionRoutes.tmuxTarget(surface);
      if (tgt) {
        if (wants) return answer(409, { error: 'seq_unavailable' });   // no grid seq for a tmux-only pane
        const r = await require('./sessions/procs').tmuxSend(tgt, { text, submit: !!b.submit });
        return r.ok ? answer(200, { ok: true }) : answer(502, { error: r.error, detail: r.detail });
      }
      if (wants) {
        const cur = await new Promise((resolve) => gridPayload(surface, resolve));
        // gridPayload's real failure shapes are `null` and the plain-text fallback, which carries no
        // envelope seq at all. Neither can verify the precondition, so neither may pass it.
        if (!cur || !Number.isFinite(cur.seq)) return answer(409, { error: 'seq_unavailable' });
        if (cur.seq !== b.expect_seq) return answer(409, { error: 'seq_changed', seq: cur.seq });
      }
      // p41 D163: a cmux pane ATTACHED to tmux gets its text (and the Enter) through tmux
      // paste-buffer, bracketed when long — `cmux send` there types raw bytes through `tmux attach`
      // and Claude Code splits a long message into typing + a "[Pasted text]" paste (two inputs).
      const att = text && !tmuxCli ? await sessionRoutes.tmuxKeyTarget(surface) : null;
      if (att) {
        const r = await require('./sessions/procs').tmuxSend(att, { text, submit: !!b.submit });
        return r.ok ? answer(200, { ok: true }) : answer(502, { error: r.error, detail: r.detail });
      }
      if (text) {
        const e = await runSendCommandP(['send', '--surface', surface, '--', text]);   // argv (no shell) → no injection
        // The one provable case, and everything else. Enter is never attempted after either.
        if (e) return answer(502, { error: e.dispatched ? 'text_command_unconfirmed' : 'send_failed', detail: e.detail });
      }
      if (b.submit) {
        // Enter fired right on the heels of the text lands inside the TUI's paste-burst window and
        // is read as a newline, not a submit (a separate soft-key Enter, seconds later, works).
        // Let the text settle first — only when there was text to settle.
        if (text) await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS));
        const e = await runSendCommandP(['send-key', '--surface', surface, '--', 'enter']);
        if (e) return answer(502, { error: 'submit_failed_text_inserted', detail: e.detail });
      }
      answer(200, { ok: true });
    }).catch((e) => {
      // An unexpected throw cannot prove where it landed, so it takes the unproved answer — the
      // conservative direction, since the caller treats it as "check the tab", never as a retry.
      answer(502, { error: 'text_command_unconfirmed', detail: String((e && e.message) || e).slice(0, 200) });
    });
  });
}

// POST /cmux/choose { surface, choiceId, index, label } (p41 A14) — answer a Session.choice atomically.
// The bridge recomputes the choice NOW; a different choiceId or label is 409 {error:'stale', choice}
// and nothing is sent. Menu picks walk from the CURRENT highlight and read back before Enter
// (sessions/choice.js commit). The app never sends raw keys for a choice.
function pressKeyP(surface, key) {
  return new Promise((resolve) => {
    const viaCmux = () => cmux(['send-key', '--surface', surface, '--', key], (e) => resolve(e ? { ok: false, error: 'cmux_failed' } : { ok: true }));
    if (tmuxCli) return viaCmux();
    // D140: keys for a tmux-hosted pane (attached or not) go to tmux directly — never split into a lone Esc.
    sessionRoutes.tmuxKeyTarget(surface).then(async (tgt) => {
      if (!tgt) return viaCmux();
      resolve(await require('./sessions/procs').tmuxSend(tgt, { press: key }));
    }).catch(() => resolve({ ok: false, error: 'cmux_failed' }));
  });
}
function sendTextP(surface, text, submit) {
  return new Promise((resolve) => {
    serializeSend(surface, async () => {
      const tgt = tmuxCli ? null : await sessionRoutes.tmuxTarget(surface);
      if (tgt) return resolve(await require('./sessions/procs').tmuxSend(tgt, { text, submit }));
      const att = text && !tmuxCli ? await sessionRoutes.tmuxKeyTarget(surface) : null;   // D163
      if (att) return resolve(await require('./sessions/procs').tmuxSend(att, { text, submit }));
      if (text) {
        const e = await runSendCommandP(['send', '--surface', surface, '--', text]);
        if (e) return resolve({ ok: false, error: e.dispatched ? 'text_command_unconfirmed' : 'send_failed' });
      }
      if (submit) {
        if (text) await new Promise((r) => setTimeout(r, SUBMIT_SETTLE_MS));
        const e = await runSendCommandP(['send-key', '--surface', surface, '--', 'enter']);
        if (e) return resolve({ ok: false, error: 'submit_failed_text_inserted' });
      }
      resolve({ ok: true });
    }).catch(() => resolve({ ok: false, error: 'text_command_unconfirmed' }));
  });
}
function cmuxChoose(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    sessionRoutes.choose(b, { pressKey: (k) => pressKeyP(surface, k), sendText: (t, sub) => sendTextP(surface, t, sub) })
      .then((r) => send(res, r.code, r.body))
      .catch(() => send(res, 500, { error: 'choose_failed' }));
  });
}

// POST /cmux/session-name { sessionId, name } (p41 A16) — set/clear the user's name for a session.
function cmuxSessionName(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    sessionRoutes.rename(b).then((r) => send(res, r.code, r.body)).catch(() => send(res, 500, { error: 'rename_failed' }));
  });
}

// POST /cmux/key { surface, key } — press a single (allow-listed) key on a specific surface.
// Addressing the SURFACE (not the workspace) is what makes arrows/tab actually reach the mirrored tab
// instead of the workspace's focused surface — the root cause of "up-arrow acts like escape".
function cmuxKey(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const key = String(b.key || '').toLowerCase();
    if (!CMUX_KEYS.has(key)) return send(res, 400, { error: 'bad_key' });
    const viaCmux = () => cmux(['send-key', '--surface', surface, '--', key], (e) => (e ? send(res, 502, { error: 'cmux_failed' }) : send(res, 200, { ok: true })));
    if (tmuxCli) return viaCmux();
    sessionRoutes.tmuxKeyTarget(surface).then(async (tgt) => {   // D140: attached tmux panes too
      if (!tgt) return viaCmux();
      const r = await require('./sessions/procs').tmuxSend(tgt, { press: key });
      send(res, r.ok ? 200 : (r.error === 'bad_key' ? 400 : 502), r.ok ? { ok: true } : { error: r.error });
    }).catch(() => send(res, 502, { error: 'cmux_failed' }));
  });
}

// ---------- lifecycle: new tab (surface) / new workspace / close tab --------
async function treePayload() {
  const ws = privacy.filterTree(await loadTree());
  if (ws == null) return null;
  await attachStatuses(ws);
  return ws;
}

// POST /cmux/new-surface { workspace, pane? } — add a new tab (terminal surface). With `pane` the tab
// lands in THAT pane; without it, cmux puts it in the workspace's focused pane as before.
function cmuxNewSurface(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    const pane = String(b.pane || '');
    if (pane && !PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
    const args = ['new-surface', '--type', 'terminal', '--workspace', workspace, '--focus', 'false'];
    if (pane) args.push('--pane', pane);
    // D176/D177: `cwd` = the folder to start in (the clicked pane's, or the sheet's pick). Absent = cmux's
    // default (before D176 that was always cmux's own folder, never the clicked pane's).
    let cwd = null;
    if (b.cwd != null && b.cwd !== '') {
      cwd = startDir.validStartDir(b.cwd);
      if (!cwd) return send(res, 400, { error: 'bad_cwd' });
    }
    const surface = String(b.surface || '');
    if (surface && !SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    // p41 S2d: `account` — absent / "terminal" = today's terminal; "default" = the launcher on the
    // Mac's own login (`a`); <name> = validated + present in the Keychain. The command is built only
    // from validated values; the launcher reads the token itself, the bridge never does.
    const account = b.account == null || b.account === 'terminal' ? null : b.account;
    const before = new Set();
    (async () => {
      // D176 follow-up: no cwd sent (a terminal-only pane: Claude exited, no status line) -> the clicked
      // pane's own folder, resolved here; still nothing known -> cmux's default as before.
      // (tmux needs none: its split already starts in the split pane's #{pane_current_path})
      if (!cwd && !tmuxCli) cwd = (await paneCwd({ workspace, pane, surface })).path;
      if (cwd) args.push('--working-directory', cwd);
      if (account !== null) {
        // spec §4.2 / §6.1: sessions on an account only through a secured bridge
        if (!SECRET) return send(res, 503, { error: 'not_secured' });
        // tmux's new-surface ignores --command: an account session there would be a bare shell
        if (tmuxCli) return send(res, 501, { error: 'unsupported_backend', backend: 'tmux' });
        if (!ACCOUNT_BIN_DIR_OK) return send(res, 503, { error: 'accounts_disabled' });
        if (account !== 'default') {
          if (typeof account !== 'string' || !ACCOUNT_NAME_RE.test(account) || account === 'a') return send(res, 400, { error: 'bad_account' });
          if ((await accountsLib.keychainStatus()) !== 'ok') return send(res, 409, { error: 'keychain_locked' });
          if (!(await accountsLib.exists(account))) return send(res, 400, { error: 'bad_account' });
        }
        // the launcher checks $PWD's .claude settings, so it must start IN the folder: cd first too (a cmux
        // without --working-directory then fails loudly rather than starting in the wrong folder)
        args.push('--command', `${cwd ? `cd ${shq(cwd)} && ` : ''}${SKIP_PERMS_PREFIX}${shq(ACCOUNT_BIN_DIR + '/hypermux-claude')} ${account === 'default' ? 'a' : account}`);
      }
      const pre = await loadTree();
      if (pre) for (const w of pre) for (const t of w.tabs) before.add(t.id);
      const done = async (err, stdout, stderr) => {
        // a named account never falls back to a plain terminal; its failure carries no cmux text
        if (err) return send(res, 502, account !== null ? { error: 'cmux_failed' } : { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
        if (cwd) startDirsLast.add(cwd);
        const workspaces = await treePayload();
        let created = null;
        if (workspaces) for (const w of workspaces) for (const t of w.tabs) if (!before.has(t.id)) created = t.id;
        send(res, 200, { ok: true, id: created, account, workspaces: workspaces || [] });
      };
      // account: plain cli — cmux()'s retry would drop an "unknown" --command and open a bare shell
      if (account !== null) cli(args, { timeout: 12000 }, done);
      else cmux(args, done, 12000);
    })().catch(() => { if (!res.headersSent) send(res, 502, { error: 'cmux_failed' }); });
  });
}

// D177: GET /cmux/start-dirs — folders the "+" sheet offers: last used, open workspaces' folders,
// HYPERMUX_START_DIRS (':'-separated), ~/Main, $HOME. Each one exists and is a directory right now.
const startDir = require('./lib/start-dir');
const { latestSurfaceEvent } = require('./sessions/detect');
const startDirsLast = startDir.lastUsedStore(process.env.HYPERMUX_START_DIRS_FILE
  || require('./lib/hm-home').statePath('start-dirs.json', path.join(os.homedir(), '.config', 'cmux-remote', 'start-dirs.json')));
// The folder a pane is in, best signal first: the newest hook event (cwd) of any tab in that pane
// (Claude may have exited; its events stay for EVENT_LIVE_MS), on tmux the pane's pane_current_path,
// then its workspace's current_directory. -> { path, source } ({ path: null } when nothing is known).
// Every answer passes validStartDir. cmux's tree carries no per-pane cwd and its tty is null.
async function paneCwd({ workspace, pane, surface }) {
  const none = { path: null, source: null };
  if (!workspace && !pane && !surface) return none;
  const tree = await loadTree().catch(() => null);
  if (!tree) return none;
  const ws = tree.find((w) => w.id === workspace || w.ref === workspace)
    || tree.find((w) => (w.tabs || []).some((t) => (surface && t.id === surface) || (pane && (t.pane === pane || t.paneRef === pane))));
  if (!ws) return none;
  const tabs = (ws.tabs || []).filter((t) => (surface && t.id === surface) || (pane && (t.pane === pane || t.paneRef === pane)));
  if (tabs.length && !tmuxCli) {
    const evs = await Promise.all(tabs.map((t) => latestSurfaceEvent({ id: t.id }, { readEvents: eventlog.readEvents }, (e) => !!e.cwd).catch(() => null)));
    const best = evs.filter(Boolean).sort((a, b2) => b2.ts - a.ts)[0];
    const p = best && startDir.validStartDir(best.cwd);
    if (p) return { path: p, source: 'pane' };
  }
  if (tabs.length && tmuxCli) {
    const t = tabs.find((x) => x.inPane) || tabs[0];
    const out = await new Promise((resolve) => require('child_process').execFile(process.env.TMUX_BIN || 'tmux',
      [...(t.tmuxSocket ? ['-S', t.tmuxSocket] : []), 'display-message', '-p', '-t', String(t.tmuxPane || t.ref || t.id), '#{pane_current_path}'],
      { timeout: 3000 }, (e, so) => resolve(e ? '' : String(so).trim())));
    const p = startDir.validStartDir(out);
    if (p) return { path: p, source: 'pane' };
  }
  if (!tmuxCli) {
    const cwds = await cmuxWorkspaceCwds().catch(() => []);
    const hit = cwds.find((c) => c.label && (c.label === ws.title || c.label === ws.ref));
    const p = hit && startDir.validStartDir(hit.path);
    if (p) return { path: p, source: 'workspace' };
  }
  return none;
}

// ?workspace=&pane=&surface= (all optional): `current` = that pane's folder, also listed first.
async function cmuxStartDirs(req, res, u) {
  const q = (k) => String((u && u.searchParams.get(k)) || '');
  const workspace = q('workspace'), pane = q('pane'), surface = q('surface');
  if (workspace && !WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
  if (pane && !PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
  if (surface && !SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
  const current = await paneCwd({ workspace, pane, surface }).catch(() => ({ path: null, source: null }));
  let workspaceCwds = [];
  try { workspaceCwds = tmuxCli ? [] : (await cmuxWorkspaceCwds()).map((c) => c.path); } catch (_) { workspaceCwds = []; }
  const dirs = startDir.startDirs({ current: current.path, lastUsed: startDirsLast.read(), workspaceCwds, extras: startDir.extrasFromEnv(process.env.HYPERMUX_START_DIRS) });
  send(res, 200, { current: current.path, currentSource: current.source, dirs });
}

// POST /cmux/new-workspace { cwd?, command? } — create a whole new workspace.
function cmuxNewWorkspace(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    // A detached caller can create an unfocused workspace before Ghostty has initialized its
    // terminal surface. The mirror selects the returned workspace anyway, so focus it here and
    // make the surface readable before replying.
    const args = ['new-workspace', '--focus', 'true'];
    const cwd = typeof b.cwd === 'string' ? b.cwd.trim() : '';
    const command = typeof b.command === 'string' ? b.command.trim() : '';
    if (cwd) args.push('--cwd', cwd);
    if (command) args.push('--command', command);
    const before = new Set();
    (async () => {
      const pre = await loadTree();
      if (pre) for (const w of pre) before.add(w.ref);
      cmux(args, async (err, stdout, stderr) => {
        if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
        const workspaces = await treePayload();
        let createdWs = null, firstTab = null;
        if (workspaces) for (const w of workspaces) if (!before.has(w.ref)) { createdWs = w.ref; firstTab = (w.tabs[0] && w.tabs[0].id) || null; }
        send(res, 200, { ok: true, workspace: createdWs, id: firstTab, workspaces: workspaces || [] });
      }, 12000);
    })();
  });
}

// ---------- p41 D188: close kills the pane's tmux session; orphan cleanup (sessions/tmux-close.js) ----------
const tmuxClose = require('./sessions/tmux-close');
const d188Snapshot = () => { const k = p41ProcSnapshotKnob(); return k ? k() : require('./sessions/procs').snapshot(); };
// Opt-in (public repo): HYPERMUX_COS_STOP_BIN = absolute path to the chief-of-staff stop.sh. Unset = off.
const COS_STOP_BIN = (() => { const b = process.env.HYPERMUX_COS_STOP_BIN; return b && path.isAbsolute(b) ? b : null; })();
async function d188ClosePlan(surfaceId) {
  if (tmuxCli || !surfaceId) return null;
  const snap = await d188Snapshot();
  const plan = tmuxClose.closePlan(snap, surfaceId, HOSTED_TMUX_SOCKET);
  if (!plan) return null;
  const tdir = require('./lib/tasks').tasksDir();
  const cos = await tmuxClose.cosWorkerOf(snap, plan.session, {
    stopBin: COS_STOP_BIN, socket: HOSTED_TMUX_SOCKET,
    taskExists: async (n) => !!tdir && fs.existsSync(path.join(tdir, `${n}.md`)),
    envOf: d188EnvOf,
  }).catch(() => null);
  return { plan, cos };
}
// A live pid's environment (`ps eww`, own user only) -> { COS_WORKER } when present.
function d188EnvOf(pid) {
  return new Promise((resolve) => require('child_process').execFile('/bin/ps', ['eww', '-o', 'command=', '-p', String(Number(pid))], { timeout: 3000 },
    (e, so) => { const m = !e && /(?:^|\s)COS_WORKER=([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/.exec(String(so)); resolve(m ? { COS_WORKER: m[1] } : {}); }));
}
function d188CosStop(name) {
  const argv = tmuxClose.cosStopArgv(name);
  if (!COS_STOP_BIN || !argv) return Promise.resolve(null);
  return new Promise((resolve) => require('child_process').execFile(COS_STOP_BIN, argv, { timeout: tmuxClose.LIMITS.cosStopTimeoutMs },
    (e, so, se) => {
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
      if (code) console.log(`d188: cos stop ${name} exited ${code}: ${String(se || '').slice(0, 200)}`);
      resolve({ code });
    }));
}
// Kill what the plan says, once the cmux pane is gone. Already gone (stop.sh did it) = ok.
async function d188TmuxClose(plan) {
  if (!plan.args || !hostedTmux) return { session: plan.session, action: plan.action, ok: true };
  if (plan.action === 'kill-session') {
    const has = await hostedTmux._run(['has-session', '-t', `=${plan.session}`]);
    if (has.code !== 0) return { session: plan.session, action: plan.action, ok: true, already: true };
  }
  const r = await hostedTmux._run(plan.args);
  return { session: plan.session, action: plan.action, ok: r.code === 0 };
}
// D188b: Close on a tmux-only row (minted id, no cmux pane): the chief stop first (it kills the pid
// itself), then kill-session =NAME on the hosted socket. Re-resolved at request time; other sockets never.
async function d188bCloseTmuxOnly(res, surface) {
  if (tmuxCli || !hostedTmux) return send(res, 404, { error: 'no_such_surface' });
  const snap = await d188Snapshot().catch(() => null);
  const plan = tmuxClose.tmuxOnlyPlan(snap, surface, HOSTED_TMUX_SOCKET);
  if (!plan) return send(res, 404, { error: 'no_such_surface' });
  const tdir = require('./lib/tasks').tasksDir();
  const name = await tmuxClose.cosWorkerOf(snap, plan.session, {
    stopBin: COS_STOP_BIN, socket: HOSTED_TMUX_SOCKET,
    taskExists: async (n) => !!tdir && fs.existsSync(path.join(tdir, `${n}.md`)),
    envOf: d188EnvOf,
  }).catch(() => null);
  const cos = name ? await d188CosStop(name) : null;
  const tmux = await d188TmuxClose(plan);
  if (!tmux.ok) return send(res, 502, { error: 'tmux_failed' });
  const workspaces = await treePayload();
  send(res, 200, { ok: true, closed: surface, tmux, ...(cos ? { cos: { name, code: cos.code } } : {}), workspaces: workspaces || [] });
}
// GET /cmux/orphans · POST /cmux/orphans/close {names:[…]} — idle tmux sessions no cmux pane shows.
async function d188Orphans() {
  const snap = await d188Snapshot();
  return { snap, list: tmuxClose.listOrphans(snap, HOSTED_TMUX_SOCKET, { underCmuxApp: require('./sessions/procs').underCmuxApp }) };
}
function cmuxOrphans(req, res, p) {
  if (tmuxCli || !hostedTmux) return send(res, 200, { orphans: [] });
  if (req.method === 'GET' && p === '/cmux/orphans') {
    return d188Orphans().then(({ list }) => send(res, 200, { orphans: list.map((o) => ({ name: o.name, panes: o.panes })) }),
      () => send(res, 502, { error: 'tmux_failed' }));
  }
  if (req.method === 'POST' && p === '/cmux/orphans/close') {
    return cmuxReadBody(req, (b) => {
      const names = tmuxClose.parseNames(b);
      if (!names) return send(res, 400, { error: 'bad_names' });
      d188Snapshot().then((snap) => tmuxClose.closeOrphans(names, snap, HOSTED_TMUX_SOCKET,
        (socket, args) => (socket === HOSTED_TMUX_SOCKET ? hostedTmux._run(args) : Promise.resolve({ code: 1 })),
        { underCmuxApp: require('./sessions/procs').underCmuxApp }))
        .then((r) => send(res, 200, r), () => send(res, 502, { error: 'tmux_failed' }));
    });
  }
  return send(res, 404, { error: 'not_found' });
}

// POST /cmux/close-tab { surface } — close a tab (surface).
//
// SCOPE IS MANDATORY (cmux >= 0.64.22): `close-surface` refuses a bare `--surface` with
// `close-surface requires --workspace or --window with explicit --surface`. An interactive shell
// gets that scope from its own cmux window; this bridge is detached under launchd and has none, so
// every close it issued failed until the workspace was passed explicitly. It is read from the live
// tree rather than trusted from the client — the client only ever knew the surface.
function cmuxCloseTab(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    (async () => {
      const tree = await loadTree();
      if (tree == null) return send(res, 502, { error: 'cmux_failed', detail: 'tree unavailable' });
      let ws = tree.find((w) => (w.tabs || []).some((t) => t.id === surface || t.ref === surface));
      if (!ws) return d188bCloseTmuxOnly(res, surface);
      // D188: what this close does to the tmux session the pane shows (planned BEFORE the attach client goes).
      const tab = ws.tabs.find((t) => t.id === surface || t.ref === surface);
      const d188 = await d188ClosePlan(tab && tab.id).catch(() => null);
      const cos = d188 && d188.cos ? await d188CosStop(d188.cos) : null;
      if (cos && cos.code === 0) {
        // stop.sh closes the worker's cmux pane itself: never close it twice.
        const t2 = await loadTree();
        ws = t2 && t2.find((w) => (w.tabs || []).some((t) => t.id === surface || t.ref === surface));
      }
      if (ws) {
        // And cmux will not close a workspace's LAST surface at all (`invalid_state: Cannot close the
        // last surface`). Closing that tab used to take the workspace with it, so it still does.
        const args = (ws.tabs || []).length <= 1
          ? ['close-workspace', '--workspace', ws.id]
          : ['close-surface', '--surface', surface, '--workspace', ws.id];
        const out = await cmuxErr(args);
        if (out) return send(res, 502, { error: 'cmux_failed', detail: out.slice(0, 400) });
      }
      const tmux = d188 && d188.plan ? await d188TmuxClose(d188.plan) : null;
      const workspaces = await treePayload();
      send(res, 200, { ok: true, closed: surface, ...(tmux ? { tmux } : {}), ...(cos ? { cos: { name: d188.cos, code: cos.code } } : {}), workspaces: workspaces || [] });
    })();
  });
}

// POST /cmux/rename-workspace { workspace, title } — give a workspace a name of its own.
// Without one, cmux labels a workspace after whatever tab happens to be in front of it, so a new
// workspace is named after its first tab and three of them read "Claude Code". An empty title is not a
// no-op: it CLEARS the custom name and hands the label back to cmux's derived default (verified —
// clear-name on a /tmp workspace went back to "/tmp").
function cmuxRenameWorkspace(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    // Newlines/tabs would corrupt the sidebar row and could not have been typed on purpose.
    const title = String(b.title == null ? '' : b.title).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
    const args = title
      ? ['workspace-action', '--action', 'rename', '--workspace', workspace, '--title', title]
      : ['workspace-action', '--action', 'clear-name', '--workspace', workspace];
    cmux(args, async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
      const workspaces = await treePayload();
      send(res, 200, { ok: true, workspace, title, workspaces: workspaces || [] });
    }, 8000);
  });
}

// POST /cmux/close-workspace { workspace } — close a whole workspace (and all its tabs).
function cmuxCloseWorkspace(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    cmux(['close-workspace', '--workspace', workspace], async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
      const workspaces = await treePayload();
      send(res, 200, { ok: true, closed: workspace, workspaces: workspaces || [] });
    }, 8000);
  });
}

// ---------- panes: split / focus / resize -----------------------------------
// Everything here addresses panes by UUID (refs are window-relative — see PANE_RE).
async function layoutPayload(workspace) {
  const l = await loadLayout(workspace);
  return l || null;
}

// POST /cmux/new-pane { workspace, direction, type?, pane? } — split, creating a new pane.
//
// `new-pane --direction` always splits the **focused** pane (verified 0.64.20: focusing pane:55 and
// then splitting `left` inserted the new pane at index 0, directly before it). There is no
// `--relative-to`, so a split requested from a particular pane's header focuses that pane first —
// which is also what cmux itself does when you split from a pane.
function cmuxNewPane(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    const direction = String(b.direction || '');
    if (!SPLIT_DIRS.has(direction)) return send(res, 400, { error: 'bad_direction' });
    const type = b.type === 'browser' ? 'browser' : 'terminal';
    const pane = String(b.pane || '');
    if (pane && !PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
    const split = () => cmux(['new-pane', '--type', type, '--direction', direction,
      '--workspace', workspace, '--focus', 'false'], async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
      const [workspaces, layout] = await Promise.all([treePayload(), layoutPayload(workspace)]);
      send(res, 200, { ok: true, workspaces: workspaces || [], layout });
    }, 15000);
    if (!pane) return split();
    cmux(['focus-pane', '--pane', pane, '--workspace', workspace], (err, stdout, stderr) => (err
      ? send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) })
      : split()), 8000);
  });
}

// POST /cmux/split-off { surface, direction } — move an EXISTING tab into a new pane beside its own.
function cmuxSplitOff(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const direction = String(b.direction || '');
    if (!SPLIT_DIRS.has(direction)) return send(res, 400, { error: 'bad_direction' });
    const workspace = String(b.workspace || '');
    cmux(['split-off', '--surface', surface, direction, '--focus', 'false'], async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
      const [workspaces, layout] = await Promise.all([
        treePayload(),
        WORKSPACE_RE.test(workspace) ? layoutPayload(workspace) : Promise.resolve(null),
      ]);
      send(res, 200, { ok: true, workspaces: workspaces || [], layout });
    }, 15000);
  });
}

// POST /cmux/drop-surface { workspace, surface, pane, edge } — the drag-and-drop arrange move: pick a
// pane (or one of its tabs) up and drop it somewhere else in the workspace.
//
//   edge 'center'            → the tab joins the target pane as a tab
//   edge left|right|up|down  → the tab becomes a new pane on that side of the target
//
// cmux has no move-pane, so both are expressed through the surface, in two steps for an edge drop:
// `move-surface` into the target pane, then `drag-surface-to-split` back out to the chosen side of it
// (verified 0.64.20: the split lands adjacent to the pane the surface currently lives in, and the new
// pane takes index order accordingly).
//
// Moving the LAST surface out of a pane collapses that pane — which is exactly what dragging a
// single-tab pane elsewhere should look like. `split-off` cannot be used for this: it refuses with
// `invalid_state: splitting off would leave the source pane empty`, and since every pane in a
// one-tab-per-pane workspace is that case, the old "move this tab out" buttons could only ever error.
const DROP_EDGES = new Set(['center', 'left', 'right', 'up', 'down']);
function cmuxDropSurface(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const pane = String(b.pane || '');
    if (!PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
    const edge = String(b.edge || 'center');
    if (!DROP_EDGES.has(edge)) return send(res, 400, { error: 'bad_edge' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });

    const fail = (err, stderr) => send(res, 502, {
      error: 'cmux_failed', detail: String(stderr || (err && err.message) || '').slice(0, 400),
    });
    const finish = async () => {
      const [workspaces, layout] = await Promise.all([treePayload(), layoutPayload(workspace)]);
      send(res, 200, { ok: true, workspaces: workspaces || [], layout });
    };
    cmux(['move-surface', '--surface', surface, '--pane', pane, '--workspace', workspace, '--focus', 'false'],
      (err, stdout, stderr) => {
        if (err) return fail(err, stderr);
        if (edge === 'center') return finish();
        cmux(['drag-surface-to-split', '--surface', surface, edge, '--workspace', workspace, '--focus', 'false'],
          (err2, stdout2, stderr2) => (err2 ? fail(err2, stderr2) : finish()), 15000);
      }, 15000);
  });
}

// POST /cmux/move-pane { workspace, pane, target, edge } — move a WHOLE pane (every tab) to one side
// of another pane: the native app's Move left/right/up/down, which re-orients panes the way cmux's own
// drag does. cmux has no move-pane, so it is built from the drop-surface path above:
//
//   1. the first tab: `move-surface` into the target pane, then `drag-surface-to-split <edge>` — this
//      creates the new pane on that side of the target
//   2. every other tab: `move-surface --after|--before <a tab already moved>` — joins the new pane
//      (the pane is found through its tab, so the new pane's id is never needed), in original order
//
// The pane's ACTIVE tab is moved last (placed at its original position), because cmux selects the
// tab it just moved — so the moved pane shows the same tab it showed before.
//
// Failure: 502 cmux_failed with `moved` / `remaining` (surface ids). If the split itself failed, the
// one tab already parked in the target pane is moved back beside its old neighbours (best effort;
// `rolledBack` says whether that worked). A failure after the split leaves two intact panes — the
// moved tabs in the new pane, the rest where they were — never a half-moved tab.
//
// The private-surface gate runs in cmuxReadBody (pane / target / workspace keys); a pane holding a
// private surface is itself private, so its tabs can never be moved by this route.
const MOVE_EDGES = new Set(['left', 'right', 'up', 'down']);
function cmuxMovePane(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    movePane(res, b).catch((e) => { if (!res.headersSent) send(res, 502, { error: 'cmux_failed', detail: String(e && e.message || e).slice(0, 400) }); });
  });
}
async function movePane(res, b) {
  const pane = String(b.pane || ''), target = String(b.target || '');
  if (!PANE_RE.test(pane) || !PANE_RE.test(target)) return send(res, 400, { error: 'bad_pane' });
  const edge = String(b.edge || '');
  if (!MOVE_EDGES.has(edge)) return send(res, 400, { error: 'bad_edge' });
  const workspace = String(b.workspace || '');
  if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });

  const tree = await loadTree();
  if (!tree) return send(res, 502, { error: 'cmux_failed', detail: 'tree unavailable' });
  const ws = tree.find((w) => w.id === workspace || w.ref === workspace);
  const find = (ref) => ws && (ws.panes || []).find((pn) => pn.id === ref || pn.ref === ref);
  const src = find(pane), dst = find(target);
  if (!src || !dst || !(src.tabs || []).length) return send(res, 404, { error: 'no_such_pane' });
  if (src.id === dst.id) return send(res, 400, { error: 'bad_pane', detail: 'pane and target are the same pane' });

  const tabs = src.tabs.slice();
  const active = tabs.includes(src.selected) ? src.selected : null;
  const order = tabs.filter((t) => t !== active).concat(active ? [active] : []);
  const moved = [];
  const call = (args) => new Promise((resolve) =>
    cmux(args, (err, stdout, stderr) => resolve(err ? String(stderr || err.message || 'failed') : null), 15000));
  const fail = (detail, extra) => send(res, 502, Object.assign({
    error: 'cmux_failed', detail: String(detail || '').slice(0, 400),
    moved: moved.slice(), remaining: tabs.filter((t) => !moved.includes(t)),
  }, extra || {}));
  // Where a tab goes, relative to tabs in `pool`: after its nearest original predecessor in the pool,
  // else before its nearest original successor.
  const placement = (sf, pool) => {
    const i = tabs.indexOf(sf);
    for (let j = i - 1; j >= 0; j--) if (pool.includes(tabs[j])) return ['--after', tabs[j]];
    for (let j = i + 1; j < tabs.length; j++) if (pool.includes(tabs[j])) return ['--before', tabs[j]];
    return null;
  };

  const first = order[0];
  let e = await call(['move-surface', '--surface', first, '--pane', dst.id, '--workspace', workspace, '--focus', 'false']);
  if (e) return fail(e);
  e = await call(['drag-surface-to-split', '--surface', first, edge, '--workspace', workspace, '--focus', 'false']);
  if (e) {
    // the tab sits in the target pane as a tab: put it back beside its old neighbours
    const home = placement(first, tabs.filter((t) => t !== first));
    const back = home && !(await call(['move-surface', '--surface', first, '--workspace', workspace, ...home, '--focus', 'false']));
    return fail(e, { moved: [], remaining: tabs.slice(), rolledBack: !!back, ...(back ? {} : { strayed: [first] }) });
  }
  moved.push(first);
  for (const sf of order.slice(1)) {
    const at = placement(sf, moved);
    e = await call(['move-surface', '--surface', sf, '--workspace', workspace, ...at, '--focus', 'false']);
    if (e) return fail(e, { rolledBack: false });
    moved.push(sf);
  }
  const [workspaces, layout] = await Promise.all([treePayload(), layoutPayload(workspace)]);
  send(res, 200, { ok: true, moved, workspaces: workspaces || [], layout });
}

// POST /cmux/move-to-workspace { workspace, pane, target } | { surface, target } — p41 D148: move a WHOLE pane (every tab,
// order + active tab kept) out of `workspace` into workspace `target`, as its own new pane split to the
// RIGHT of the target's focused pane (else its last pane). The sidebar row menu's "Move to workspace".
// Same two-step as move-pane above, with the target workspace on every call:
//
//   1. the first tab: `move-surface --pane <target's pane> --workspace <target>`, then
//      `drag-surface-to-split right --workspace <target>` — the new pane in the target workspace
//   2. every other tab: `move-surface --workspace <target> --after|--before <a tab already moved>`
//
// Never focus-steals (--focus false on every call). Failure shape = move-pane's (502 cmux_failed with
// moved / remaining; a refused split puts the parked tab back in the source pane, `rolledBack`).
// The private gate runs in cmuxReadBody: a private source pane, source workspace or TARGET workspace
// (the `target` key) answers 423 before anything moves.
function cmuxMoveToWorkspace(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    moveToWorkspace(res, b).catch((e) => { if (!res.headersSent) send(res, 502, { error: 'cmux_failed', detail: String(e && e.message || e).slice(0, 400) }); });
  });
}
async function moveToWorkspace(res, b) {
  // `surface` instead of pane + workspace: the pane holding that tab (the app's session rows know
  // their surface, not their pane).
  const surface = b.surface != null && b.surface !== '' ? String(b.surface) : '';
  if (surface && !SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
  let pane = String(b.pane || '');
  if (!surface && !PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
  let workspace = String(b.workspace || '');
  const target = String(b.target || '');
  // D148b: `newWorkspace: { name }` in place of `target` — move into a NEW workspace instead.
  const fresh = b.newWorkspace != null && (b.target == null || b.target === '');
  if (b.newWorkspace != null && !fresh) return send(res, 400, { error: 'bad_workspace', detail: 'target and newWorkspace are exclusive' });
  if (fresh && (typeof b.newWorkspace !== 'object' || Array.isArray(b.newWorkspace))) return send(res, 400, { error: 'bad_name' });
  if ((!surface && !WORKSPACE_RE.test(workspace)) || (!fresh && !WORKSPACE_RE.test(target))) return send(res, 400, { error: 'bad_workspace' });

  const tree = await loadTree();
  if (!tree) return send(res, 502, { error: 'cmux_failed', detail: 'tree unavailable' });
  if (surface) {
    const hit = tree.flatMap((w) => (w.panes || []).map((pn) => ({ w, pn })))
      .find(({ pn }) => (pn.tabs || []).includes(surface));
    if (!hit) return send(res, 404, { error: 'no_such_pane' });
    pane = hit.pn.id; workspace = hit.w.id;
  }
  const wsOf = (ref) => tree.find((w) => w.id === ref || w.ref === ref);
  if (fresh) return moveToNewWorkspace(res, b, tree, wsOf(workspace), pane);
  const from = wsOf(workspace), to = wsOf(target);
  if (!from || !to) return send(res, 404, { error: 'no_such_workspace' });
  if (from.id === to.id) return send(res, 400, { error: 'bad_workspace', detail: 'workspace and target are the same workspace' });
  const src = (from.panes || []).find((pn) => pn.id === pane || pn.ref === pane);
  if (!src || !(src.tabs || []).length) return send(res, 404, { error: 'no_such_pane' });
  const dstPanes = (to.panes || []).slice().sort((x, y) => x.index - y.index);
  const dst = dstPanes.find((pn) => pn.focused) || dstPanes[dstPanes.length - 1];
  if (!dst) return send(res, 404, { error: 'no_such_pane', detail: 'target workspace has no pane' });
  const into = to.id;

  const tabs = src.tabs.slice();
  const active = tabs.includes(src.selected) ? src.selected : null;
  const order = tabs.filter((t) => t !== active).concat(active ? [active] : []);
  const moved = [];
  const call = (args) => new Promise((resolve) =>
    cmux(args, (err, stdout, stderr) => resolve(err ? String(stderr || err.message || 'failed') : null), 15000));
  const fail = (detail, extra) => send(res, 502, Object.assign({
    error: 'cmux_failed', detail: String(detail || '').slice(0, 400),
    moved: moved.slice(), remaining: tabs.filter((t) => !moved.includes(t)),
  }, extra || {}));
  const placement = (sf, pool) => {
    const i = tabs.indexOf(sf);
    for (let j = i - 1; j >= 0; j--) if (pool.includes(tabs[j])) return ['--after', tabs[j]];
    for (let j = i + 1; j < tabs.length; j++) if (pool.includes(tabs[j])) return ['--before', tabs[j]];
    return null;
  };

  const first = order[0];
  let e = await call(['move-surface', '--surface', first, '--pane', dst.id, '--workspace', into, '--focus', 'false']);
  if (e) return fail(e);
  e = await call(['drag-surface-to-split', '--surface', first, 'right', '--workspace', into, '--focus', 'false']);
  if (e) {
    // the tab sits in the target workspace's pane as a tab: put it back beside its old neighbours
    const home = placement(first, tabs.filter((t) => t !== first));
    const back = home && !(await call(['move-surface', '--surface', first, '--workspace', from.id, ...home, '--focus', 'false']));
    return fail(e, { moved: [], remaining: tabs.slice(), rolledBack: !!back, ...(back ? {} : { strayed: [first] }) });
  }
  moved.push(first);
  for (const sf of order.slice(1)) {
    const at = placement(sf, moved);
    e = await call(['move-surface', '--surface', sf, '--workspace', into, ...at, '--focus', 'false']);
    if (e) return fail(e, { rolledBack: false });
    moved.push(sf);
  }
  const [workspaces, layout] = await Promise.all([treePayload(), layoutPayload(into)]);
  send(res, 200, { ok: true, moved, workspace: into, workspaces: workspaces || [], layout });
}

// D148b — the `newWorkspace: { name }` form of move-to-workspace: move the WHOLE pane into a brand-new
// workspace. `cmux new-workspace --name <name> --focus false` prints `OK workspace:N`; that workspace
// starts with ONE pane holding one fresh terminal surface. Every tab of the source pane then
// `move-surface`s into that pane (first: --pane <its pane>; the rest --after|--before a moved tab, order
// + active tab kept), and finally the fresh empty terminal is closed (close-surface, scoped to the new
// workspace, never with an empty --surface). Name: trimmed, control chars dropped, <= 60 chars,
// default '<source title> 2'. Rollback: the FIRST move refused -> the new (still empty) workspace is
// closed again, 502 rolledBack; a later tab refused -> 502 moved / remaining (the new workspace keeps
// what already moved, like D148). 200 { ok, moved, workspace: { id, ref, title }, workspaces, layout }.
const NEW_WS_NAME_MAX = 60;
function newWorkspaceName(raw, fallback) {
  const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const name = clean(raw) || (clean(fallback) + ' 2').trim();
  return Array.from(name).slice(0, NEW_WS_NAME_MAX).join('').trim();
}
async function moveToNewWorkspace(res, b, tree, from, pane) {
  if (!from) return send(res, 404, { error: 'no_such_workspace' });
  const src = (from.panes || []).find((pn) => pn.id === pane || pn.ref === pane);
  if (!src || !(src.tabs || []).length) return send(res, 404, { error: 'no_such_pane' });
  const name = newWorkspaceName(b.newWorkspace.name, from.title || 'Workspace');
  if (!name || name.startsWith('-')) return send(res, 400, { error: 'bad_name' });
  // the private workspace is recognised by its title: never mint a second one through this route
  if (name === privateSurfaces.PRIVATE_WORKSPACE_TITLE) return send(res, 400, { error: 'bad_name', detail: 'reserved name' });

  const tabs = src.tabs.slice();
  const active = tabs.includes(src.selected) ? src.selected : null;
  const order = tabs.filter((t) => t !== active).concat(active ? [active] : []);
  const moved = [];
  const run = (args) => new Promise((resolve) =>
    cmux(args, (err, stdout, stderr) => resolve(err ? { err: String(stderr || err.message || 'failed') } : { out: String(stdout || '') }), 15000));
  const call = async (args) => (await run(args)).err || null;
  const fail = (detail, extra) => send(res, 502, Object.assign({
    error: 'cmux_failed', detail: String(detail || '').slice(0, 400),
    moved: moved.slice(), remaining: tabs.filter((t) => !moved.includes(t)),
  }, extra || {}));
  const placement = (sf, pool) => {
    const i = tabs.indexOf(sf);
    for (let j = i - 1; j >= 0; j--) if (pool.includes(tabs[j])) return ['--after', tabs[j]];
    for (let j = i + 1; j < tabs.length; j++) if (pool.includes(tabs[j])) return ['--before', tabs[j]];
    return null;
  };

  const before = new Set(tree.map((w) => w.id));
  const made = await run(['new-workspace', '--name', name, '--focus', 'false']);
  if (made.err) return fail(made.err);
  const m = made.out.match(/\b(workspace:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  const after = await loadTree();
  const ws = after && ((m && after.find((w) => w.id === m[1] || w.ref === m[1]))
    || after.filter((w) => !before.has(w.id)).pop());
  if (!ws) {
    const gone = m && !(await call(['close-workspace', '--workspace', m[1]]));
    return fail('new workspace not found in tree', { rolledBack: !!gone });
  }
  const dst = (ws.panes || []).slice().sort((x, y) => x.index - y.index)[0];
  const blank = dst && (dst.tabs || [])[0] ? String(dst.tabs[0]) : '';
  if (!dst) {
    const gone = !(await call(['close-workspace', '--workspace', ws.id]));
    return fail('new workspace has no pane', { rolledBack: gone });
  }

  const first = order[0];
  let e = await call(['move-surface', '--surface', first, '--pane', dst.id, '--workspace', ws.id, '--focus', 'false']);
  if (e) {
    const gone = !(await call(['close-workspace', '--workspace', ws.id]));
    return fail(e, { rolledBack: gone, ...(gone ? {} : { strayed: [ws.id] }) });
  }
  moved.push(first);
  for (const sf of order.slice(1)) {
    const at = placement(sf, moved);
    e = await call(['move-surface', '--surface', sf, '--workspace', ws.id, ...at, '--focus', 'false']);
    if (e) return fail(e, { rolledBack: false, workspace: { id: ws.id, ref: ws.ref, title: name } });
    moved.push(sf);
  }
  // the terminal the new workspace was born with — never close-surface with an empty --surface
  let leftover = null;
  if (blank && !tabs.includes(blank)) {
    const ce = await call(['close-surface', '--surface', blank, '--workspace', ws.id]);
    if (ce) leftover = blank;
  }
  const [workspaces, layout] = await Promise.all([treePayload(), layoutPayload(ws.id)]);
  send(res, 200, Object.assign({ ok: true, moved, workspace: { id: ws.id, ref: ws.ref, title: name }, workspaces: workspaces || [], layout },
    leftover ? { leftover } : {}));
}

// POST /cmux/reorder-tab { workspace, surface, target, place } — p23: drag a tab left/right in the
// strip. `place` is 'before' | 'after' the target tab. move-surface (not reorder-surface) so a target
// in another pane also works; cmux selects the moved tab in its pane. Answers the fresh tree.
function cmuxReorderTab(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || ''), target = String(b.target || '');
    if (!SURFACE_RE.test(surface) || !SURFACE_RE.test(target) || surface === target) return send(res, 400, { error: 'bad_surface' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    const place = b.place === 'after' ? '--after' : '--before';
    cmux(['move-surface', '--surface', surface, '--workspace', workspace, place, target, '--focus', 'false'],
      async (err, stdout, stderr) => {
        if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
        send(res, 200, { ok: true, workspaces: (await treePayload()) || [] });
      }, 15000);
  });
}

// GET  /cmux/chrome-prompt               -> { present, app, text, buttons } | { present:false, error? }
// POST /cmux/chrome-prompt { action }    -> presses Allow / Cancel on Chrome's "Allow remote debugging?"
// p27: lib/chrome-prompt.js (macOS Accessibility). One osascript at a time; a GET inside 3s reuses
// the last answer so several pollers cost one scan.
const { chromePrompt } = require('./lib/chrome-prompt');
let cpLast = null, cpAt = 0, cpBusy = null;
function cpScan() {
  if (cpBusy) return cpBusy;
  cpBusy = chromePrompt('find').then((r) => { cpLast = r; cpAt = Date.now(); return r; }).finally(() => { cpBusy = null; });
  return cpBusy;
}
function cmuxChromePrompt(req, res) {
  // never under tests: a test must not scan, let alone press, a real dialog on the dev's Mac
  if (process.platform !== 'darwin' || tmuxCli || process.env.NODE_ENV === 'test') return send(res, 200, { present: false, unsupported: true });
  if (req.method === 'GET') {
    if (cpLast && Date.now() - cpAt < 3000) return send(res, 200, cpLast);
    return cpScan().then((r) => send(res, 200, r));
  }
  cmuxReadBody(req, async (b) => {
    const action = b && (b.action === 'allow' || b.action === 'deny') ? b.action : null;
    if (!action) return send(res, 400, { error: 'bad_action' });
    if (cpBusy) await cpBusy.catch(() => {});
    const r = await chromePrompt(action);
    cpLast = null;
    console.log(`chrome-prompt: ${action} → ${r.clicked ? 'pressed ' + r.clicked + ' (' + r.via + ')' : (r.error || 'no dialog')}`);
    send(res, r.clicked ? 200 : (r.present === false ? 404 : 502), r);
  });
}

// ---------- dropped files -----------------------------------------------------------------------
// Dragging an image onto a terminal on the Mac gives the agent a PATH to read. From a phone there is
// no path, so the file has to land on the Mac first: this writes the body to a directory and answers
// with the absolute path, which the client then types into the terminal.
//
// Deliberately narrow: one fixed directory (never a caller-supplied one), the name reduced to a
// basename with anything exotic stripped, a size cap, and no execute bit. It is reachable only with
// the bridge secret, i.e. only through the token-gated server.
const UPLOAD_DIR = require('./lib/hm-home').uploadDir();   // p62 S1: UPLOAD_DIR, else $HYPERMUX_HOME/uploads, else ~/Downloads/cmux-remote
const UPLOAD_MAX_BYTES = require('./lib/upload-limits').uploadMaxBytes();   // p41 D116: 512 MB default (phone videos)
function safeName(raw) {
  let n = String(raw || '').split(/[\\/]/).pop() || '';        // basename: no traversal, no directories
  // control chars out, then an allow-list: a leading dot would make it hidden, and nothing a
  // shell treats as syntax may survive into a path that gets typed at a prompt
  n = n.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^A-Za-z0-9._ ()+-]/g, "_").replace(/^\.+/, "");
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 ? n.slice(dot, dot + 12) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || 'file';
}
// day folders keep the drop directory from turning into one flat pile.
// All filesystem work stays asynchronous: a stalled upload volume must not stop
// terminal streaming, unrelated HTTP requests, or child-process timeout callbacks.
async function writeUpload(name, body) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = `${UPLOAD_DIR}/${day}`;
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });   // p62 G1 L3
  const base = safeName(name);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 0; ; i++) {
    const target = `${dir}/${i ? `${stem}-${i}${ext}` : base}`;
    try {
      // Atomic no-clobber creation also refuses pre-existing symlinks/FIFOs;
      // exists-then-write had a race between checking and opening the path.
      await fs.promises.writeFile(target, body, { mode: 0o644, flag: 'wx' });
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
// POST /cmux/upload  (raw body, name in the x-file-name header) -> { path, name, bytes }
function cmuxUpload(req, res) {
  const chunks = [];
  let size = 0, aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > UPLOAD_MAX_BYTES) {
      aborted = true;
      send(res, 413, { error: 'too_large', limit: UPLOAD_MAX_BYTES });
      return req.destroy();
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    if (!size) return send(res, 400, { error: 'empty' });
    try {
      // the client percent-encodes the name (a header is latin-1 only, a photo can be named anything)
      let name = String(req.headers['x-file-name'] || 'file');
      try { name = decodeURIComponent(name); } catch (_) { /* keep the raw form; safeName still runs */ }
      const target = await writeUpload(name, Buffer.concat(chunks));
      send(res, 200, { ok: true, path: target, name: target.split('/').pop(), bytes: size });
    } catch (e) {
      send(res, 500, { error: 'write_failed', detail: String((e && e.message) || e).slice(0, 200) });
    }
  });
}

// POST /cmux/close-pane { workspace, pane } — kill a whole pane, tabs and all.
//
// cmux has no close-pane either: a pane exists only while it holds surfaces, so closing every
// surface in it IS closing the pane (the same collapse that a drag out of a single-tab pane causes).
// The surface list is read from the live tree rather than trusted from the client, so a tab opened
// in that pane a moment ago is not left behind keeping the pane alive.
function cmuxClosePane(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const pane = String(b.pane || '');
    if (!PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    (async () => {
      const tree = await loadTree();
      const ws = (tree || []).find((w) => w.id === workspace);
      const surfaces = ((ws && ws.tabs) || []).filter((t) => t.pane === pane).map((t) => t.id);
      if (!surfaces.length) return send(res, 404, { error: 'no_such_pane' });
      // A pane holding every surface in its workspace cannot be emptied surface-by-surface: cmux
      // refuses the last one (`invalid_state: Cannot close the last surface`). Closing that pane
      // always did take the workspace with it, so close the workspace and say so.
      if (surfaces.length >= ((ws && ws.tabs) || []).length) {
        const out = await cmuxErr(['close-workspace', '--workspace', workspace]);
        if (out) return send(res, 502, { error: 'cmux_failed', detail: out.slice(0, 400) });
        const workspaces = await treePayload();
        return send(res, 200, { ok: true, closed: surfaces, closedWorkspace: workspace,
          workspaces: workspaces || [], layout: null });
      }
      for (const s of surfaces) {
        // `--workspace` is REQUIRED, not decoration — see cmuxCloseTab for why the bridge never
        // gets the implicit scope an interactive shell does.
        const out = await cmuxErr(['close-surface', '--surface', s, '--workspace', workspace]);
        if (out) return send(res, 502, { error: 'cmux_failed', detail: out.slice(0, 400) });
      }
      const [workspaces, layout] = await Promise.all([treePayload(), layoutPayload(workspace)]);
      send(res, 200, { ok: true, closed: surfaces, workspaces: workspaces || [], layout });
    })();
  });
}

// POST /cmux/focus-pane { pane, workspace? } — make a pane the focused one (the Mac follows).
function cmuxFocusPane(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const pane = String(b.pane || '');
    if (!PANE_RE.test(pane)) return send(res, 400, { error: 'bad_pane' });
    const args = ['focus-pane', '--pane', pane];
    const workspace = String(b.workspace || '');
    if (WORKSPACE_RE.test(workspace)) args.push('--workspace', workspace);
    cmux(args, (err, stdout, stderr) => (err
      ? send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 200) })
      : send(res, 200, { ok: true })), 8000);
  });
}

// POST /cmux/focus-surface { surface } — select a tab INSIDE its pane (what a pane's tab chip does).
// `surface.focus` takes surface_id; the CLI has no equivalent that selects without moving anything.
function cmuxFocusSurface(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    cmux(['rpc', 'surface.focus', JSON.stringify({ surface_id: surface })], (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 200) });
      send(res, 200, { ok: true });
      if (UUID_ONLY_RE.test(surface)) markSurfaceRead(surface).catch(() => {});   // p24
    }, 8000);
  });
}

// POST /cmux/resize-pane { workspace, paneA, paneB, axis, target } — drag a divider.
//   paneA  = the pane LEFT of (axis 'x') / ABOVE (axis 'y') the divider   — handle.a[0]
//   paneB  = the pane RIGHT of / BELOW it                                 — handle.b[0]
//   target = where the divider should land, as a fraction of the layout box (0..1)
//
// `pane.resize` takes a DIRECTION and an amount in DESKTOP PIXELS (verified: amount 40 moved the
// divider exactly 40px), and a direction only ever pushes the named pane's border OUTWARD — asking a
// pane to move a border it doesn't touch fails with `invalid_state: Pane has no adjacent border`.
// So growing the divider one way is a resize of A, and the other way is a resize of B. Both panes are
// required for that reason.
//
// Amount being real pixels means one call normally lands it; the loop exists for the cases cmux clamps
// (minimum pane width, a nested split absorbing part of the move) and closes on pane.list — the
// ground truth — rather than trusting the estimate.
const RESIZE_MAX_STEPS = 4;
const RESIZE_TOL_PX = 3;
async function resizePane(workspace, paneA, paneB, axis, target) {
  let layout = await loadLayout(workspace);
  if (!layout) return null;
  const find = (l, id) => l.panes.find((p) => p.id === id || p.ref === id);
  if (!find(layout, paneA) || !find(layout, paneB)) return layout;
  for (let step = 0; step < RESIZE_MAX_STEPS; step++) {
    const a = find(layout, paneA);
    if (!a) break;
    const edge = axis === 'x' ? a.x + a.w : a.y + a.h;
    const span = axis === 'x' ? layout.box.w : layout.box.h;
    const errPx = (target - edge) * span;
    if (Math.abs(errPx) <= RESIZE_TOL_PX) break;
    // grow A outward, or grow B backward — never a negative amount (cmux rejects those)
    const grow = errPx > 0;
    const pane = grow ? paneA : paneB;
    const direction = axis === 'x' ? (grow ? 'right' : 'left') : (grow ? 'down' : 'up');
    const amount = Math.min(2000, Math.max(1, Math.round(Math.abs(errPx))));
    const out = await cmuxP(['rpc', 'pane.resize', JSON.stringify({ ...rpcTarget('pane', pane), direction, amount })], 6000);
    if (out == null) break;    // clamped at a minimum size, or the split vanished — stop, don't spin
    const next = await loadLayout(workspace);
    if (!next) break;
    layout = next;
  }
  return layout;
}
function cmuxResizePane(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    const paneA = String(b.paneA || ''), paneB = String(b.paneB || '');
    if (!PANE_RE.test(paneA) || !PANE_RE.test(paneB)) return send(res, 400, { error: 'bad_pane' });
    const axis = b.axis === 'y' ? 'y' : b.axis === 'x' ? 'x' : null;
    if (!axis) return send(res, 400, { error: 'bad_axis' });
    const target = Number(b.target);
    // never let a drag collapse a pane to nothing — cmux would keep a sliver pane on the desktop
    if (!Number.isFinite(target) || target < 0.05 || target > 0.95) return send(res, 400, { error: 'bad_target' });
    resizePane(workspace, paneA, paneB, axis, target)
      .then((layout) => (layout ? send(res, 200, { ok: true, layout }) : send(res, 502, { error: 'cmux_failed' })))
      .catch(() => send(res, 502, { error: 'cmux_failed' }));
  });
}

// POST /cmux/equalize { workspace } — even out every split (the "reset layout" escape hatch).
function cmuxEqualize(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    cmux(['rpc', 'workspace.equalize_splits', JSON.stringify(rpcTarget('workspace', workspace))], async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 200) });
      send(res, 200, { ok: true, layout: await layoutPayload(workspace) });
    }, 8000);
  });
}

// ---------- browser surfaces: screenshot mirror + eval-driven input ----------
// A browser "tab" is a cmux browser surface (type:'browser'). We can't screencast or send native
// mouse/keyboard on WKWebView, and viewport emulation is unsupported — so the mirror is a screenshot
// that refreshes (SSE, on change), and every input is composed here as a `cmux browser` command:
//   tap  -> `eval` dispatches a real mousedown/up/click at (fx*innerWidth, fy*innerHeight)
//   type -> `eval` inserts into document.activeElement (React-safe native value setter)
//   key  -> `browser press <PlaywrightKey>`   scroll -> `browser scroll --dy`   nav -> goto/back/...
// The CLIENT never sends JS or selectors: coords are validated numbers, text is JSON.stringify'd into a
// safe literal, keys/actions are allow-listed. Scripts reach cmux via argv (no shell).
const isHttpUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch (_) { return false; } };
const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
const clampInt = (v, lim) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(lim, Math.max(-lim, n)) : 0; };
const browserShotPath = (surface) => `${os.tmpdir()}/cmux-remote-shot-${surface.replace(/[^0-9A-Za-z-]/g, '_')}.png`;
// A raw screenshot of a big Retina pane is megabytes of PNG — unusable over a tunnel to a phone
// (multi-second frames). Recompress every frame with macOS's built-in `sips` (still zero npm deps):
// downscale to ≤1000px and JPEG it → a ~2.8MB PNG becomes ~100KB. Falls back to the raw PNG if sips
// fails. browserShot returns { buf, raw } — raw = source PNG bytes (drives the big-pane cadence brake).
const BROWSER_SHOT_MAX_DIM = 800;    // px, longest edge after downscale (phone-width retina-ish)
// Two JPEG qualities (p31): while the user is acting (scroll/tap burst) frames go out at LOW — about
// half the bytes of HIGH, still readable — and once the page settles the same picture is re-sent
// once at HIGH. Measured on a 1016x1064 text page: q55 250KB, q35 ~160KB, q30 143KB. (WebP was
// tried: sips can't write it and cwebp is not a zero-dep option; at equal legibility it saved ~7%.)
const BROWSER_SHOT_JPEG_Q = '60';      // settled frame (sips formatOptions 0-100)
const BROWSER_SHOT_JPEG_Q_MOVING = '35';
// Actions don't carry frames (they ack instantly); instead every action stamps its surface here and
// the SSE loop BURSTS (350ms ticks) for a short window after — visual feedback lands fast exactly
// when the user just did something, without paying a screenshot inside the action round-trip.
const browserLastAction = new Map();   // surface -> Date.now()
// Each open stream registers a wake fn here, so an action paints its result NOW instead of after the
// stream's next scheduled tick (that wait was up to a full cadence step of pure dead time per action).
const browserWakers = new Map();       // surface -> Set<fn>
const noteAction = (surface) => {
  browserLastAction.set(surface, Date.now());
  const ws = browserWakers.get(surface);
  if (ws) for (const fn of ws) fn();
};
// Phone viewport (p28). cmux's WKWebView keeps the pane's own CSS size (a hidden workspace is 800x600),
// so a phone got a desktop layout shrunk to ~half — unreadable text, tiny tap targets. `browser
// viewport W H` (supported since cmux 0.64.23) makes the page lay out at the phone's CSS size, so the
// frame is 1:1 on the phone. The Mac pane shows that layout aspect-fitted while a phone watches; the
// last viewer leaving resets it (after a grace period, so a stream reconnect doesn't flap the layout).
const browserViewers = new Map();      // surface -> open stream count
const browserViewportReset = new Map(); // surface -> pending reset timer
const VIEWPORT_RESET_GRACE_MS = 4000;
const viewportDim = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
// shrink=false keeps the frame at its native size: `sips -Z` UPSCALES a smaller image to the cap
// (a 390x698 phone frame became 2288x4096 / 640KB), so a phone-viewport frame must skip it.
// One screenshot at a time PER SURFACE (p39). cmux refuses a second concurrent shot ("Another browser
// screenshot is already in progress") and every stream of a surface writes the same PNG path, so two
// viewers of one tab (phone + desktop) made each other's frames fail or read a half-written file —
// after switching back to the tab no frame arrived at all and scrolling looked dead. Shots now queue.
const browserShotQueue = new Map();   // surface -> tail Promise
function browserShot(surface, shrink = true, q = BROWSER_SHOT_JPEG_Q) {
  const prev = browserShotQueue.get(surface) || Promise.resolve();
  const run = prev.then(() => browserShotNow(surface, shrink, q));
  const tail = run.catch(() => null);
  browserShotQueue.set(surface, tail);
  tail.then(() => { if (browserShotQueue.get(surface) === tail) browserShotQueue.delete(surface); });
  return run;
}
function browserShotNow(surface, shrink, q) {   // -> Promise<{buf, raw, src}|null>
  const out = browserShotPath(surface);
  const jpg = out.replace(/\.png$/, '.jpg');
  return new Promise((resolve) => cmux(['browser', surface, 'screenshot', '--out', out], (err) => {
    if (err) return resolve(null);
    fs.readFile(out, (e, png) => {
      if (e) return resolve(null);
      execFile('/usr/bin/sips', [...(shrink ? ['-Z', String(BROWSER_SHOT_MAX_DIM)] : []), '-s', 'format', 'jpeg',
        '-s', 'formatOptions', q, out, '--out', jpg], { timeout: 8000, env: secretsIn.childEnv() }, (se) => {
        // src = hash of the SOURCE pixels, so the same picture at two qualities counts as unchanged
        const src = crypto.createHash('md5').update(png).digest('hex');
        if (se) return resolve({ buf: png, raw: png.length, src });   // sips failed → raw PNG fallback
        fs.readFile(jpg, (je, jbuf) => resolve(je ? { buf: png, raw: png.length, src } : { buf: jbuf, raw: png.length, src }));
      });
    });
  }, 12000));
}
const browserEval = (surface, js) => new Promise((resolve) =>
  cmux(['browser', surface, 'eval', '--script', js], (err, stdout) => resolve(err ? null : (stdout || '').trim()), 10000));
// Current URL truth = the live DOM (eval location.href). NEVER `browser get url` — after a synthetic
// click's dead navigation it reports the phantom history entry of a page that never loaded.
const browserLoc = (surface) => browserEval(surface, 'location.href')
  .then((s) => (s || '').replace(/^"|"$/g, '').trim());

// POST /cmux/browser/open { workspace, url? } — create a browser surface (a new browser tab).
function cmuxBrowserOpen(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    if (url && !isHttpUrl(url)) return send(res, 400, { error: 'bad_url' });
    const args = ['browser', 'open'];
    if (url) args.push(url);
    args.push('--workspace', workspace, '--focus', 'false');
    const before = new Set();
    (async () => {
      const pre = await loadTree();
      if (pre) for (const w of pre) for (const t of w.tabs) before.add(t.id);
      cmux(args, async (err, stdout, stderr) => {
        if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
        const workspaces = await treePayload();
        let created = null;
        if (workspaces) for (const w of workspaces) for (const t of w.tabs) if (!before.has(t.id) && t.type === 'browser') created = t.id;
        send(res, 200, { ok: true, id: created, workspaces: workspaces || [] });
      }, 15000);
    })();
  });
}

// GET /cmux/browser/info?surface= -> { url, title, w, h, dpr }
function cmuxBrowserInfo(res, surface) {
  browserEval(surface, 'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,dpr:devicePixelRatio})')
    .then((out) => { let info = null; try { info = JSON.parse(out); } catch (_) {} return info ? send(res, 200, { ok: true, ...info }) : send(res, 502, { error: 'cmux_failed' }); });
}

// p41 D67: GET /cmux/browser/shot?surface= -> { ok, mime, image: base64 } — ONE frame for a client that
// polls (the native Workspace browser tile; RN has no SSE reader). Same queued, sips-shrunk shot as the
// stream. A per-surface floor (BROWSER_SHOT_MIN_MS, 429 + retryMs) keeps a fast poller from starving
// terminal.replay (the cadence lesson above); a byte cap (BROWSER_SHOT_MAX_BYTES, 413) bounds the reply.
const BROWSER_SHOT_MIN_MS = Math.max(0, Number(process.env.BROWSER_SHOT_MIN_MS) || 1500);
const BROWSER_SHOT_MAX_BYTES = Math.max(1, Number(process.env.BROWSER_SHOT_MAX_BYTES) || 1536 * 1024);
const browserShotLimiter = require('./lib/shot-limiter').createShotLimiter({ minMs: BROWSER_SHOT_MIN_MS });
// p41 D97: Mac screen — lib/mac-screen.js owns flags, TCC errors, limits; text rides osascript stdin.
const macScreen = require('./lib/mac-screen').createMacScreen({ childEnv: () => secretsIn.childEnv(),
  secret: SECRET, host: HOST, socket: SOCKET });
// p41 D189: Remote Desktop setup (TCC grants the Mac screen needs) — probe cached, reminder flag.
const rdSetup = require('./lib/rd-setup').createRdSetup({ childEnv: () => secretsIn.childEnv(), flags: () => macScreen.flags, observed: () => macScreen.observed() });
function cmuxBrowserShot(res, surface) {
  const gate = browserShotLimiter.take(surface);
  if (!gate.ok) return send(res, 429, { error: 'rate_limited', retryMs: gate.retryMs });
  browserShot(surface).then((shot) => {
    if (!shot || !shot.buf || !shot.buf.length) return send(res, 502, { error: 'cmux_failed' });
    if (shot.buf.length > BROWSER_SHOT_MAX_BYTES) return send(res, 413, { error: 'too_large', limit: BROWSER_SHOT_MAX_BYTES });
    const png = shot.buf[0] === 0x89 && shot.buf[1] === 0x50;
    const jpg = shot.buf[0] === 0xff && shot.buf[1] === 0xd8;
    send(res, 200, { ok: true, mime: jpg ? 'image/jpeg' : 'image/png', image: shot.buf.toString('base64') });
  }, () => send(res, 502, { error: 'cmux_failed' }));
}

// p41 D88: POST /cmux/browser/scroll {shot:true} answers with a fresh frame so a polling client sees
// the scroll land without waiting out its poll. Scroll frames have their own, shorter per-surface
// floor (BROWSER_SCROLL_SHOT_MIN_MS, same as the SSE burst tick): a frame inside it WAITS out the rest
// (never skipped — the last scroll of a burst must paint) and every scroll frame re-arms the poll
// floor, so scroll + poll together never shoot faster than the floor allows.
const BROWSER_SCROLL_SHOT_MIN_MS = Math.max(0, Number(process.env.BROWSER_SCROLL_SHOT_MIN_MS) || 350);
const browserScrollShotLimiter = require('./lib/shot-limiter').createShotLimiter({ minMs: BROWSER_SCROLL_SHOT_MIN_MS });
const BROWSER_TYPE_MAX_CHARS = 4096;   // one field's value per /cmux/browser/type (was the silent slice)
const cmuxSocket = require('./lib/cmux-socket').createCmuxSocket({ auth: secretsIn.cmuxSocketAuth });
function scrollFrame(surface) {   // -> Promise<{mime,image}|{}> (never rejects)
  const wait = browserScrollShotLimiter.reserve(surface);
  return new Promise((r) => setTimeout(r, wait)).then(() => {
    browserShotLimiter.mark(surface);
    return browserShot(surface);
  }).then((shot) => {
    if (!shot || !shot.buf || !shot.buf.length || shot.buf.length > BROWSER_SHOT_MAX_BYTES) return {};
    return { mime: shot.buf[0] === 0xff && shot.buf[1] === 0xd8 ? 'image/jpeg' : 'image/png', image: shot.buf.toString('base64') };
  }, () => ({}));
}

// GET /cmux/browser/stream?surface=[&vw=&vh=] -> SSE of base64 JPEG frames, emitted only on change.
// vw/vh = the viewer's CSS size: the page is laid out at exactly that size (see Phone viewport above).
// ADAPTIVE cadence — a screenshot of a big Retina pane costs the cmux app real CPU every tick, and an
// unbounded 900ms loop on a ~3MB pane starves terminal.replay for every OTHER tab (observed: terminal
// mirrors going from instant to ~10s). So: shoot back-to-back only right after an action, poll
// moderately while the page changes, back off hard when it idles, and back off extra for huge panes.
// A phone-sized viewport frame is small (~140KB PNG, ~200ms to shoot), so its burst is cheap.
function cmuxBrowserStream(req, res, surface, vw, vh) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  let lastHash = null, alive = true, busy = false, again = false, idleTicks = 0, lastRaw = 0, timer = null, sentLow = false;
  const phone = !!(vw && vh);
  browserViewers.set(surface, (browserViewers.get(surface) || 0) + 1);
  const pending = browserViewportReset.get(surface);
  if (pending) { clearTimeout(pending); browserViewportReset.delete(surface); }
  const delay = () => {
    const since = Date.now() - (browserLastAction.get(surface) || 0);
    const huge = lastRaw > 1536 * 1024;
    if (since < 3000) return huge ? 500 : 40;               // just acted: frames back-to-back
    let d = idleTicks > 4 ? 2000 : 600;                     // idle page → 2s; changing page → 0.6s
    if (huge) d = Math.max(d, 2000);                        // huge SOURCE pane → snapshot cost on the
    return d;                                               // cmux app itself; never faster than 2s
  };
  const schedule = () => { if (alive) timer = setTimeout(tick, delay()); };
  const tick = () => {
    if (!alive) return;
    timer = null;
    if (busy) { again = true; return; }
    busy = true;
    // A phone frame is already phone-sized: JPEG it, never resample it.
    const moving = Date.now() - (browserLastAction.get(surface) || 0) < 3000;
    browserShot(surface, !phone, moving ? BROWSER_SHOT_JPEG_Q_MOVING : BROWSER_SHOT_JPEG_Q).then((shot) => {
      busy = false;
      if (!alive) return;
      if (!shot) { res.write('event: error\ndata: cmux_failed\n\n'); return schedule(); }
      lastRaw = shot.raw;
      if (shot.src !== lastHash || (sentLow && !moving)) {   // new picture, or the sharp re-send
        if (shot.src !== lastHash) idleTicks = 0;
        lastHash = shot.src; sentLow = moving;
        res.write('data: ' + shot.buf.toString('base64') + '\n\n');
      } else idleTicks++;
      if (again) { again = false; return tick(); }          // an action landed mid-shot: shoot again now
      schedule();
    });
  };
  const wake = () => { if (!alive) return; if (timer) { clearTimeout(timer); timer = null; } tick(); };
  if (!browserWakers.has(surface)) browserWakers.set(surface, new Set());
  browserWakers.get(surface).add(wake);
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 15000);
  // (also clears any leftover WebKit page zoom: before p37 A+/A- called `browser zoom`, which under
  // viewport emulation only shifts devicePixelRatio and makes frames look oddly sharp or soft)
  if (phone) cmux(['browser', surface, 'viewport', String(vw), String(vh)], () => {
    cmux(['browser', surface, 'zoom', 'reset'], () => { if (alive) tick(); }, 8000);
  }, 8000);
  else tick();
  const done = () => {
    if (!alive) return; alive = false; if (timer) clearTimeout(timer); clearInterval(hb);
    const ws = browserWakers.get(surface); if (ws) { ws.delete(wake); if (!ws.size) browserWakers.delete(surface); }
    const n = (browserViewers.get(surface) || 1) - 1;
    if (n > 0) browserViewers.set(surface, n);
    else {
      browserViewers.delete(surface);
      if (phone) browserViewportReset.set(surface, setTimeout(() => {
        browserViewportReset.delete(surface);
        if (!browserViewers.has(surface)) cmux(['browser', surface, 'viewport', 'reset'], () => {}, 8000);
      }, VIEWPORT_RESET_GRACE_MS));
    }
    try { res.end(); } catch (_) {}
  };
  req.on('close', done); req.on('error', done);
}

// GET /cmux/browser/hits?surface= -> { w, h, r: [[x,y,w,h,kind]...] } — the visible clickable areas
// (kind 0 = click/hand, 1 = text field), in page CSS px. The mirror is an image, so a desktop mouse
// gets no hand cursor over links; the client fetches this once per changed frame and picks the
// cursor locally on every move (no round-trip per mouse move). Read-only eval; capped.
const BROWSER_HITS_JS = `(function(){var W=innerWidth,H=innerHeight,out=[],all=document.getElementsByTagName('*'),n=Math.min(all.length,8000);var TAG=/^(A|BUTTON|SELECT|SUMMARY|LABEL)$/;for(var i=0;i<n&&out.length<1500;i++){var el=all[i],t=el.tagName;var r=el.getBoundingClientRect();if(r.width<2||r.height<2||r.bottom<=0||r.right<=0||r.top>=H||r.left>=W)continue;var c=getComputedStyle(el).cursor,k=-1;if(t==='TEXTAREA'||el.isContentEditable===true||(t==='INPUT'&&!/^(button|submit|reset|checkbox|radio|image|file|range|color|hidden)$/i.test(el.type)))k=1;else if(t==='INPUT'||c==='pointer'||(TAG.test(t)&&(t!=='A'||el.hasAttribute('href')))||el.getAttribute('role')==='button'||el.getAttribute('role')==='link'||el.hasAttribute('onclick'))k=0;else if(c==='text'&&t!=='BODY'&&t!=='HTML')k=-1;if(k<0)continue;out.push([Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height),k]);}return JSON.stringify({w:W,h:H,r:out});})()`;
function cmuxBrowserHits(res, surface) {
  browserEval(surface, BROWSER_HITS_JS).then((out) => {
    let d = null; try { d = JSON.parse(out); } catch (_) {}
    return d && Array.isArray(d.r) ? send(res, 200, { ok: true, w: d.w, h: d.h, r: d.r }) : send(res, 502, { error: 'cmux_failed' });
  });
}

// POST /cmux/browser/tap { surface, fx, fy } — click the page at a fraction of the viewport.
function cmuxBrowserTap(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const fx = clamp01(b.fx), fy = clamp01(b.fy);
    if (fx == null || fy == null) return send(res, 400, { error: 'bad_coords' });
    // Page-initiated navigation is POISON on cmux's WKWebView: a synthetic click on a link (and even
    // location.assign / driver-level click) never truly loads the target — it leaves a detached
    // phantom webview that SPLITS the surface's state (eval answers from one page, the screenshot
    // shows another; `get url` reports the phantom URL). Only cmux-driven navs (`goto`/back/reload)
    // are real. So a tap on an ANCHOR never dispatches the click at all — the eval only reports the
    // href (nav) and the handler drives a `goto`. Everything else gets the full synthetic click:
    // DOM interaction (buttons, inputs, SPA handlers) works fine.
    const js = `(function(fx,fy){var x=Math.round(fx*innerWidth),y=Math.round(fy*innerHeight);var el=document.elementFromPoint(x,y);if(!el)return JSON.stringify({hit:null,x:x,y:y});try{if(el.focus)el.focus();}catch(e){}if(el.tagName==='IFRAME'){var xo=false;try{xo=!el.contentDocument;}catch(e){xo=true;}if(xo){var fl=null;for(var n=el;n&&n!==document.body&&n!==document.documentElement;n=n.parentElement){var ps=getComputedStyle(n).position;if(ps==='fixed'||ps==='sticky'){fl=n;}}if(fl){fl.setAttribute('data-cmr-hidden','1');fl.style.setProperty('display','none','important');return JSON.stringify({hit:'IFRAME',xframe:true,closed:true,x:x,y:y,loc:location.href});}try{el.focus();}catch(e){}return JSON.stringify({hit:'IFRAME',xframe:true,closed:false,x:x,y:y,loc:location.href});}}var a=el.closest?el.closest('a[href]'):null;var href=(a&&a.href&&/^https?:/i.test(a.href)&&a.href!==location.href)?a.href:null;var ed=(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable===true);if(!href){['mousedown','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0}));});}var sec=el.tagName==='INPUT'&&String(el.type).toLowerCase()==='password';var val=ed&&!sec?String(el.value!==undefined?el.value:(el.textContent||'')).slice(0,2000):(sec?'':null);return JSON.stringify({hit:el.tagName,editable:ed,secure:sec,value:val,x:x,y:y,nav:href,loc:location.href});})(${fx},${fy})`;
    (async () => {
      const out = await browserEval(surface, js);
      let r = {}; try { r = JSON.parse(out) || {}; } catch (_) { r = { raw: String(out || '').slice(0, 300) }; }
      noteAction(surface);   // SSE bursts frames for the next 2.5s — no screenshot inside the response
      if (r.nav) {
        // Anchor tap → real navigation via cmux. Fire-and-forget; ack instantly with the target url.
        cmux(['browser', surface, 'goto', r.nav], () => {}, 20000);
        return send(res, 200, { ok: true, ...r, hit: r.hit || null, editable: false, url: r.nav });
      }
      send(res, 200, { ok: true, ...r, hit: r.hit || null, editable: !!r.editable, secure: !!r.secure });
    })();
  });
}

// Cross-origin frames: cmux refuses script inside them ("Cross-origin iframe control is not
// supported"), so a tap can never reach e.g. the X on Google's "Sign in with Google" popup. So a tap
// on a FLOATING cross-origin frame (it or an ancestor is position:fixed/sticky — popups, cookie
// banners, chat bubbles) closes it outright: the outermost floating ancestor is hidden and marked
// data-cmr-hidden. An in-page frame (card field, video) is never hidden — it only gets focus, so the
// ⇥ / ⏎ keys act inside it.
// POST /cmux/browser/unhideframe { surface } — undo: show every frame the mirror hid on this page.
function cmuxBrowserUnhideFrame(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const js = `(function(){var l=document.querySelectorAll('[data-cmr-hidden]');for(var i=0;i<l.length;i++){l[i].style.removeProperty('display');l[i].removeAttribute('data-cmr-hidden');}return l.length;})()`;
    (async () => { const out = await browserEval(surface, js); noteAction(surface); send(res, 200, { ok: true, restored: Number(out) || 0 }); })();
  });
}

// POST /cmux/browser/type { surface, text } — REPLACE the focused element's value (React-safe).
// The client types with LOCAL echo and syncs the whole field in debounced batches — so this sets the
// value wholesale (handles backspaces/edits for free) and returns immediately WITHOUT a frame: a
// screenshot per keystroke is what made typing feel seconds-slow; the SSE stream paints the catch-up.
function cmuxBrowserType(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    if (typeof b.text === 'string' && b.text.length > BROWSER_TYPE_MAX_CHARS) return send(res, 413, { error: 'too_long', limit: BROWSER_TYPE_MAX_CHARS });
    const text = typeof b.text === 'string' ? b.text : '';
    const js = `(function(t){var el=document.activeElement;if(!el)return'noactive';if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(el,t);try{el.selectionStart=el.selectionEnd=t.length;}catch(_){}el.dispatchEvent(new Event('input',{bubbles:true}));return'ok';}if(el.isContentEditable){el.textContent=t;el.dispatchEvent(new Event('input',{bubbles:true}));return'ok';}return'notinput';})(${JSON.stringify(text)})`;
    // p41 D88: the script carries the typed text (passwords) — so it goes over the cmux socket, never
    // `cmux browser eval --script` argv (ps-visible). No socket (tmux backend / no path) -> 502, no
    // argv fallback. Neither the text nor the script is ever logged or echoed in an error.
    if (tmuxCli) return send(res, 501, { error: 'unsupported' });
    cmuxSocket.call('browser.eval', { surface_id: surface, script: js }, { timeoutMs: 10000 }).then((r) => {
      noteAction(surface);
      const v = r && r.result && typeof r.result === 'object' ? (r.result.value ?? r.result.result) : r && r.result;
      send(res, 200, { ok: true, result: typeof v === 'string' ? v.replace(/^"|"$/g, '').slice(0, 40) : 'ok' });
    }, () => send(res, 502, { error: 'cmux_failed' }));
  });
}

// POST /cmux/browser/key { surface, key } — press one allow-listed key on the page.
function cmuxBrowserKey(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const pw = BROWSER_KEYMAP[String(b.key || '').toLowerCase()];
    if (!pw) return send(res, 400, { error: 'bad_key' });
    cmux(['browser', surface, 'press', pw], (err) => { if (err) return send(res, 502, { error: 'cmux_failed' }); noteAction(surface); send(res, 200, { ok: true }); });
  });
}

// POST /cmux/browser/scroll { surface, dy, dx? } — scroll the page.
function cmuxBrowserScroll(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const dy = clampInt(b.dy, 5000), dx = clampInt(b.dx, 5000);
    if (!dy && !dx) return send(res, 400, { error: 'no_delta' });
    // p38: `cmux browser scroll` moves only the WINDOW, so apps that scroll inside a panel (muse.ai:
    // an overflow:auto div 8459px tall in a 1408px window) never moved. Scroll the innermost
    // scrollable ancestor of the element under the gesture point (fx,fy; default centre) that can
    // still move in that direction, else the document.
    const fx = b.fx == null ? 0.5 : clamp01(b.fx), fy = b.fy == null ? 0.5 : clamp01(b.fy);
    if (fx == null || fy == null) return send(res, 400, { error: 'bad_coords' });
    const js = `(function(fx,fy,dx,dy){var el=document.elementFromPoint(Math.round(fx*innerWidth),Math.round(fy*innerHeight));function can(e){var cs=getComputedStyle(e);var oy=cs.overflowY,ox=cs.overflowX;var vy=dy&&(oy==='auto'||oy==='scroll'||oy==='overlay')&&e.scrollHeight>e.clientHeight+1&&(dy>0?e.scrollTop+e.clientHeight<e.scrollHeight-1:e.scrollTop>0);var vx=dx&&(ox==='auto'||ox==='scroll'||ox==='overlay')&&e.scrollWidth>e.clientWidth+1;return vy||vx;}for(var e=el;e&&e!==document.body&&e!==document.documentElement;e=e.parentElement){if(can(e)){var t0=e.scrollTop;e.scrollBy({left:dx,top:dy,behavior:'instant'});return 'el:'+(e.scrollTop-t0);}}var d=document.scrollingElement||document.documentElement;var y0=d.scrollTop;window.scrollBy({left:dx,top:dy,behavior:'instant'});return 'doc:'+(d.scrollTop-y0);})(${fx},${fy},${dx},${dy})`;
    browserEval(surface, js).then((out) => {
      if (out == null) return send(res, 502, { error: 'cmux_failed' });
      noteAction(surface);
      const moved = String(out).replace(/"/g, '');
      if (!b.shot) return send(res, 200, { ok: true, moved });
      scrollFrame(surface).then((f) => send(res, 200, { ok: true, moved, ...f }));
    });
  });
}

// POST /cmux/browser/nav { surface, action, url? } — goto/back/forward/reload.
function cmuxBrowserNav(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const action = String(b.action || '');
    if (!['goto', 'back', 'forward', 'reload'].includes(action)) return send(res, 400, { error: 'bad_action' });
    let args;
    if (action === 'goto') {
      const url = String(b.url || '').trim();
      if (!isHttpUrl(url)) return send(res, 400, { error: 'bad_url' });
      args = ['browser', surface, 'goto', url];
    } else { args = ['browser', surface, action]; }
    cmux(args, async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 300) });
      noteAction(surface);
      const url = await browserLoc(surface);
      send(res, 200, { ok: true, url });
    }, 15000);
  });
}

// POST /cmux/browser/zoom { surface, dir } — page zoom in/out/reset (for small tap targets).
function cmuxBrowserZoom(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const dir = String(b.dir || '');
    if (!['in', 'out', 'reset'].includes(dir)) return send(res, 400, { error: 'bad_dir' });
    cmux(['browser', surface, 'zoom', dir], (err) => { if (err) return send(res, 502, { error: 'cmux_failed' }); noteAction(surface); send(res, 200, { ok: true }); });
  });
}

// ---------- p5 radar: session events ----------------------------------------
// GET /cmux/session-events?since=<ms>[&limit=<n>]  ->  { machineId, events[], more }
//
// Serves THIS machine's ~/.radar/events/*.ndjson (written by radar/hook-receiver.js) so the radar
// leader can fold every machine's Claude sessions into one attention queue. Contract (specs §M2):
//
//   since   EXCLUSIVE lower bound on ts (ms epoch); absent = everything retained (48 h)
//   order   ascending ts
//   limit   max 5000 per page; `more: true` -> re-request with the last ts you saw
//   dupes   allowed across pages and restarts — consumers are idempotent on (sessionId, ts, event)
//
// Read-only and cmux-free: it touches no cmux process and shares no state with any other route, so
// a radar poll cannot slow or break the terminal mirroring this bridge exists for.
function cmuxSessionEvents(res, u) {
  const sinceRaw = u.searchParams.get('since');
  const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw);
  if (since !== null && !Number.isFinite(since)) return send(res, 400, { error: 'bad_since' });
  const limitRaw = u.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  return eventlog.readEvents({ since, limit })
    .then((r) => send(res, 200, { machineId: MACHINE_ID, events: r.events, more: r.more, skipped: r.skipped }))
    // An unreadable event directory is a degraded source, not a 500 with a stack trace on the wire.
    .catch(() => send(res, 200, { machineId: MACHINE_ID, events: [], more: false, error: 'events_unreadable' }));
}

// GET /cmux/notifications -> {notifications:[{id,title,subtitle,body,created_at,is_read,surface_id,workspace_id,tab_title}]}
// p20: the server polls this and turns each NEW unread one into a phone push. cmux raises these itself
// (Claude Code "Completed in …", the NEEDS YOU banner, `cmux notify`). tmux has no notification list.
function cmuxNotifications(res) {
  if (tmuxCli) return send(res, 200, { notifications: [], unsupported: 'tmux' });
  cli(['list-notifications', '--json'], { timeout: 8000 }, (err, stdout) => {
    if (err) return send(res, 502, { error: 'cmux_failed' });
    let list;
    try { list = JSON.parse(stdout); } catch (_) { return send(res, 502, { error: 'bad_cmux_output' }); }
    if (!Array.isArray(list)) list = [];
    const str = (v) => (typeof v === 'string' ? v : '');
    const items = list.filter((n) => n && n.id).map((n) => ({
      id: str(n.id), title: str(n.title), subtitle: str(n.subtitle), body: str(n.body), created_at: str(n.created_at),
      is_read: !!n.is_read, surface_id: str(n.surface_id) || null, workspace_id: str(n.workspace_id) || null, tab_title: str(n.tab_title),
    }));
    // S2p: a private surface's notifications never leave the Mac.
    const refs = items.flatMap((n) => [n.surface_id, n.workspace_id]).filter(Boolean);
    privacy.snapshot(refs).then((isPriv) => send(res, 200, {
      notifications: items.filter((n) => !isPriv(n.surface_id) && !isPriv(n.workspace_id)) }),
    () => send(res, 502, { error: 'cmux_failed' }));
  });
}

// ---------- p41 S2c: Claude accounts -------------------------------------------
// Names only: the bridge never reads a token. Setup / remove run in a pane on THIS Mac, in the
// private "Claude accounts" workspace (S2p gate: the phone can neither see nor type into it), and the
// person at the Mac confirms there. Every refusal is a code; no stderr, no Keychain output.
const accountsLib = require('./lib/accounts').createAccounts();
const ACCOUNT_BIN_DIR = process.env.HYPERMUX_BIN_DIR || path.join(require('./lib/pkg-root').pkgRoot(), 'bin');   // D62
// D154: passive limit status per account from the official CLI's own transcripts (no network, no token)
const accountUsage = require('./lib/accounts-usage').createUsage({ accounts: accountsLib, usageFile: process.env.HYPERMUX_ACCOUNT_USAGE_FILE });   // D157 opt-in file
// The pane command is shell-quoted (shq), so spaces are fine — releases live under
// "~/Library/Application Support/…". Quotes, backslashes and control chars are still refused as a
// second line of defence (no legitimate install path has them).
// D178: server setting HYPERMUX_SKIP_PERMISSIONS=1 (default off). The pane env comes from cmux, not the
// bridge, so the launcher gets the switch as a fixed literal prefix; only the exact value "1" enables it.
const SKIP_PERMS_PREFIX = process.env.HYPERMUX_SKIP_PERMISSIONS === '1' ? 'HYPERMUX_SKIP_PERMISSIONS=1 ' : '';
const ACCOUNT_BIN_DIR_OK = /^[^\x00-\x1f\x7f'"\\]+$/.test(ACCOUNT_BIN_DIR);
// POSIX single-quote: 'a'\''b' — same as gitpanel shellQuote.
const shq = (v) => "'" + String(v).split("'").join("'\\''") + "'";
const ACCOUNTS_MAX = 32;                     // accountsMax
// accountSetupTimeoutMs: the setup script's own capture limit (lib/account-setup.js). The pane guard and
// the private mark both use ACCOUNT_MARK_TTL_MS, which covers confirm (30 s) + this + grace + close delay.
const ACCOUNT_SETUP_TIMEOUT_MS = 600000;
const ACCOUNT_MARK_TTL_MS = 660000;          // private mark: setup timeout + kill grace + close delay
const ACCOUNT_BODY_MAX = 1024;               // accountBodyMax
const ACCOUNT_LABEL_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const ACCOUNT_NAME_RE = require('./lib/accounts').NAME_RE;
let accountPane = null;      // { surface, until } — accountSetupOpen: 1 per Mac at a time
let accountOpening = false;  // a setup/remove request is between its checks and its pane
if (!ACCOUNT_BIN_DIR_OK) console.log('WARNING: bridge path has a quote, backslash or control character — Claude account setup/remove disabled');

async function accountPaneOpen() {
  if (!accountPane) return false;
  if (Date.now() > accountPane.until) { accountPane = null; return false; }
  const ws = await loadTree();
  if (ws && accountPane.surface && !ws.some((w) => (w.tabs || []).some((t) => t.id === accountPane.surface))) { accountPane = null; return false; }
  return true;   // still in the tree, or the tree is unreadable: keep refusing
}

// Open `<bin>/<script> <args…>` in the "Claude accounts" workspace. cmdline is built ONLY from
// validated values. Uses cli (not cmux): flag adaptation must never drop --name or --command.
async function openAccountPane(cmdline) {
  const pre = await loadTree();
  if (!pre) return null;
  const before = new Set(pre.flatMap((w) => (w.tabs || []).map((t) => t.id)));
  const beforeWs = new Set(pre.map((w) => w.id));
  const ws = pre.find((w) => privateSurfaces.isPrivateTitle(w.title));
  const args = ws
    ? ['new-surface', '--type', 'terminal', '--workspace', ws.ref || ws.id, '--focus', 'false', '--command', cmdline]
    // focus true: a detached caller's unfocused new workspace may not have a live terminal yet
    : ['new-workspace', '--name', privateSurfaces.PRIVATE_WORKSPACE_TITLE, '--focus', 'true', '--command', cmdline];
  const out = await new Promise((resolve) => cli(args, { timeout: 12000 }, (err, stdout) => resolve(err ? null : String(stdout || ''))));
  if (out == null) return null;
  // Only a NEW tab inside the targeted "Claude accounts" workspace (or the new workspace with that
  // title) can be ours — a tab opened elsewhere at the same moment must never be marked or tracked.
  // cmux's own `surface:N` in stdout, when it prints one, picks among them.
  const post = await loadTree();
  const said = (/\bsurface:\d+\b/.exec(out) || [])[0] || null;
  const mine = [];
  for (const w of post || []) {
    const target = ws ? w.id === ws.id : (!beforeWs.has(w.id) && privateSurfaces.isPrivateTitle(w.title));
    if (!target) continue;
    for (const t of w.tabs || []) if (!before.has(t.id)) mine.push({ t, w });
  }
  const pick = (said && mine.find((x) => x.t.ref === said)) || (mine.length === 1 ? mine[0] : null);
  if (!pick) return { surface: null };
  privateSurfaces.mark({ surface: pick.t.id, workspace: pick.w.id, ttlMs: ACCOUNT_MARK_TTL_MS });
  await showAccountPane(pick.w.ref || pick.w.id, pick.t.ref || pick.t.id);
  return { surface: pick.t.id };
}

// D160 (Sean: "it says it continues on the Mac, but on the Mac nothing happens, no pane opens"): the pane
// was opened with --focus false in the hidden "Claude accounts" workspace, so the person at the Mac never
// saw it. Setup is always asked for by that person, so bring the workspace + pane to the front. Best
// effort: a cmux without these commands leaves it where it is (the reply still names the workspace).
async function showAccountPane(wsRef, surfaceRef) {
  const run = (args) => new Promise((resolve) => cli(args, { timeout: 5000 }, () => resolve()));
  await run(['select-workspace', '--workspace', wsRef]);
  await run(['focus-panel', '--panel', surfaceRef, '--workspace', wsRef]);
}

async function accountOpen(res, cmdline) {
  const r = await openAccountPane(cmdline);
  // surface unknown: no guard (it could never clear by the tree); the title rule still hides the pane
  if (!r || !r.surface) return send(res, 502, { error: 'cmux_failed' });
  // guard = mark TTL: the pane (30 s confirm + 600 s capture + grace + close delay) never outlives either
  accountPane = { surface: r.surface, until: Date.now() + ACCOUNT_MARK_TTL_MS };
  send(res, 200, { ok: true, surface: r.surface, workspace: privateSurfaces.PRIVATE_WORKSPACE_TITLE });
}

function cmuxAccounts(req, res, u, p) {
  if (!SECRET) return send(res, 503, { error: 'not_secured' });
  if (tmuxCli) return send(res, 501, { error: 'unsupported_backend', backend: 'tmux' });
  const fail = (code, error) => () => { if (!res.headersSent) send(res, code, { error }); };
  if (req.method === 'GET' && p === '/cmux/accounts') {
    return accountsLib.list({ fresh: u.searchParams.get('fresh') === '1' })
      .then((r) => send(res, 200, r), fail(502, 'keychain_read_failed'));
  }
  if (req.method === 'GET' && p === '/cmux/accounts/usage') {
    return accountUsage.usage().then((r) => send(res, 200, r), fail(502, 'usage_read_failed'));
  }
  // setup / remove share one guard: one account pane per Mac at a time
  const guarded = async (name, body) => {
    if (accountOpening) return send(res, 429, { error: 'setup_open' });
    accountOpening = true;
    try { await body(); } finally { accountOpening = false; }
  };
  // listing never runs a script; only setup/remove need a safe bin path
  if (req.method !== 'GET' && !ACCOUNT_BIN_DIR_OK) return send(res, 503, { error: 'accounts_disabled' });
  if (req.method === 'POST' && p === '/cmux/accounts/setup') {
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      const name = b.name;
      if (typeof name !== 'string' || !ACCOUNT_NAME_RE.test(name) || name === 'a') return send(res, 400, { error: 'bad_name' });
      const alsoOn = b.alsoOn == null || b.alsoOn === '' ? null : b.alsoOn;
      if (alsoOn !== null && (typeof alsoOn !== 'string' || !ACCOUNT_LABEL_RE.test(alsoOn))) return send(res, 400, { error: 'bad_label' });
      const replace = b.replace === true;
      // D128 (Sean: "I have the long-lived token. We just need to store it"): paste mode — the pane asks for the
      // token with a hidden read on the Mac; the token is never in this request, argv or any log.
      if (b.paste != null && typeof b.paste !== 'boolean') return send(res, 400, { error: 'bad_paste' });
      const paste = b.paste === true;
      guarded(name, async () => {
        if ((await accountsLib.keychainStatus()) !== 'ok') return send(res, 409, { error: 'keychain_locked' });
        if (!replace && await accountsLib.exists(name)) return send(res, 409, { error: 'exists' });
        if (await accountPaneOpen()) return send(res, 429, { error: 'setup_open' });
        const names = await accountsLib.listNames();
        if (!names.includes(name) && names.length >= ACCOUNTS_MAX) return send(res, 409, { error: 'too_many' });
        let cmd = `${shq(ACCOUNT_BIN_DIR + '/hypermux-account-setup')} ${name}`;
        if (replace) cmd += ' --replace';
        if (alsoOn !== null) cmd += ` --also-on ${shq(alsoOn)}`;
        if (paste) cmd += ' --paste';
        await accountOpen(res, cmd);
      }).catch(fail(502, 'accounts_failed'));
    }, ACCOUNT_BODY_MAX);
  }
  const dm = /^\/cmux\/accounts\/([^/]+)$/.exec(p);
  if (req.method === 'DELETE' && dm) {
    let name = '';
    try { name = decodeURIComponent(dm[1]); } catch (_) { name = ''; }
    if (!ACCOUNT_NAME_RE.test(name) || name === 'a') return send(res, 400, { error: 'bad_name' });
    return guarded(name, async () => {
      if (!(await accountsLib.exists(name))) return send(res, 404, { error: 'not_found' });
      if (await accountPaneOpen()) return send(res, 429, { error: 'setup_open' });
      await accountOpen(res, `${shq(ACCOUNT_BIN_DIR + '/hypermux-account-remove')} ${name}`);
    }).catch(fail(502, 'accounts_failed'));
  }
  return send(res, 404, { error: 'not_found' });
}

// ---------- p41 D152 task file (opt-in HYPERMUX_TASKS_DIR; lib/tasks.js) ----------
const tasksLib = require('./lib/tasks');
const tasks = tasksLib.createTasks();
function cmuxTasks(req, res, u, p) {
  const done = (pr) => pr.then((r) => send(res, r.code, r.body), () => { if (!res.headersSent) send(res, 500, { error: 'tasks_failed' }); });
  if (!tasks.enabled) return send(res, 404, { error: 'disabled' });
  if (req.method === 'GET' && p === '/cmux/tasks') return done(tasks.read(u.searchParams.get('name') || ''));
  if ((req.method === 'POST' || req.method === 'PATCH') && p === '/cmux/tasks/item') {
    return cmuxReadBody(req, (b) => {
      if (!b || typeof b !== 'object') return send(res, 400, { error: 'bad_json' });
      if (req.method === 'POST') return done(tasks.add(b.name, b.text));
      return done(tasks.patch(b.name, { id: b.id, done: b.done, text: b.text }));
    }, tasksLib.LIMITS.bodyMax);
  }
  return send(res, 404, { error: 'not_found' });
}

// ---------- routing ---------------------------------------------------------
function handleCmux(req, res) {
  if (SECRET && !safeEqual(req.headers['x-bridge-secret'], SECRET)) return send(res, 403, { error: 'forbidden' });
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { return send(res, 400, { error: 'bad_url' }); }
  // tmux has no browser surfaces: answered before the gate, nothing is reached either way
  if (tmuxCli && u.pathname.startsWith('/cmux/browser/')) return send(res, 501, { error: 'unsupported_backend', backend: 'tmux' });
  // p41 S2p — the one private-surface gate (spec §4.5). Query params here; JSON bodies in cmuxReadBody.
  privateRes.set(req, res);
  const refs = PRIVATE_QUERY_KEYS.flatMap((k) => u.searchParams.getAll(k)).filter(Boolean);
  const multi = (u.searchParams.get('surfaces') || '').split(',').map((s) => s.trim());
  const hasMulti = multi.some(Boolean);
  if (!refs.length && !hasMulti) return dispatchCmux(req, res, u);
  const multiRefs = multi.filter(Boolean);
  Promise.all([refs.length ? privateGate(refs) : null, hasMulti ? privacy.verdict(multiRefs) : null]).then(([code, mv]) => {
    if (code) return gateRefuse(res, code);
    if (hasMulti && multiRefs.some(mv)) {
      // multi-surface reads (panes-stream) drop private/unproven surfaces; `h` is positional, so it follows
      const keep = multi.map((s) => !mv(s));
      const kept = multi.filter((_, i) => keep[i]).filter(Boolean);
      if (!kept.length) return gateRefuse(res, multiRefs.some((s) => mv(s) === 'private') ? 423 : 503);
      u.searchParams.set('surfaces', multi.filter((_, i) => keep[i]).join(','));
      const h = u.searchParams.get('h');
      if (h != null) { const hs = h.split(','); if (hs.length === multi.length) u.searchParams.set('h', hs.filter((_, i) => keep[i]).join(',')); }
    }
    dispatchCmux(req, res, u);
  }, () => gateRefuse(res, 503));   // a gate that cannot decide refuses
}

function dispatchCmux(req, res, u) {
  const p = u.pathname;
  // tmux has no browser surfaces: say so plainly (the page hides these from capabilities anyway)
  if (tmuxCli && p.startsWith('/cmux/browser/')) return send(res, 501, { error: 'unsupported_backend', backend: 'tmux' });
  const surfaceParam = () => u.searchParams.get('surface') || '';

  if (req.method === 'GET' && p === '/cmux/tree') return cmuxTree(res);
  if (req.method === 'GET' && p === '/cmux/completions') return cmuxCompletions(res, u);
  if (p.startsWith('/cmux/git/')) return cmuxGit(req, res, u, p.slice('/cmux/git/'.length));
  if (p.startsWith('/cmux/gitread/')) return cmuxGitRead(req, res, u, p.slice('/cmux/gitread/'.length));
  if (req.method === 'GET' && p === '/cmux/session-events') return cmuxSessionEvents(res, u);
  if (req.method === 'GET' && p === '/cmux/notifications') return cmuxNotifications(res);
  if ((p === '/cmux/sessions' || p.startsWith('/cmux/sessions/')) && sessionRoutes.handle(req, res, u)) return;

  // ----- pane layout (multi-pane mirror) -----
  if (req.method === 'GET' && (p === '/cmux/layout' || p === '/cmux/layout-stream')) {
    const w = u.searchParams.get('workspace') || '';
    if (!WORKSPACE_RE.test(w)) {
      if (p === '/cmux/layout') return send(res, 400, { error: 'bad_workspace' });
      res.writeHead(400); return res.end();
    }
    const h = u.searchParams.get('h') || '';
    return p === '/cmux/layout' ? cmuxLayout(res, w, h) : cmuxLayoutStream(req, res, w, h);
  }
  if (req.method === 'GET' && p === '/cmux/panes-stream') {
    const list = (u.searchParams.get('surfaces') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.length > MAX_STREAM_SURFACES || !list.every((s) => SURFACE_RE.test(s))) {
      res.writeHead(400); return res.end();
    }
    const hashes = (u.searchParams.get('h') || '').split(',');
    return cmuxPanesStream(req, res, list, hashes);
  }

  // ----- filesystem browse (p4) — read-only, realpath-jailed in fsbrowse.js -----
  if (req.method === 'GET' && p === '/cmux/fs/roots') {
    return fsBrowse.roots()
      .then((r) => send(res, 200, r))
      .catch((e) => sendFsError(res, e));
  }
  if (req.method === 'GET' && p === '/cmux/fs/list') {
    return fsBrowse.list(u.searchParams.get('path') || '', u.searchParams.get('offset'), u.searchParams.get('limit'),
      { hidden: u.searchParams.get('hidden') !== '0' })
      .then((r) => {
        const h = fsHash(r);
        if (u.searchParams.get('h') === h) return send(res, 200, { same: 1 });
        send(res, 200, { ...r, h });
      })
      .catch((e) => sendFsError(res, e));
  }
  if (req.method === 'GET' && p === '/cmux/fs/read') {
    return fsBrowse.read(u.searchParams.get('path') || '')
      .then((r) => send(res, 200, r))
      .catch((e) => sendFsError(res, e));
  }
  if (req.method === 'GET' && p === '/cmux/fs/download') {
    return cmuxFsDownload(req, res, u.searchParams.get('path') || '');
  }

  if (req.method === 'GET' && p === '/cmux/grid') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxGrid(res, s, u.searchParams.get('h') || '');
  }
  if (req.method === 'GET' && p === '/cmux/grid-stream') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxGridStream(req, res, s, u.searchParams.get('h') || '');
  }
  if (req.method === 'GET' && p === '/cmux/screen') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxScreen(res, s, u.searchParams.get('lines'));
  }
  if (req.method === 'GET' && p === '/cmux/history') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxHistory(res, s, u.searchParams.get('rows'));
  }
  if (req.method === 'GET' && p === '/cmux/stream') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxStream(req, res, s);
  }
  if (req.method === 'POST' && p === '/cmux/send') return cmuxSend(req, res);
  if (req.method === 'POST' && p === '/cmux/choose') return cmuxChoose(req, res);
  if (req.method === 'POST' && p === '/cmux/session-name') return cmuxSessionName(req, res);
  if (req.method === 'POST' && p === '/cmux/key') return cmuxKey(req, res);
  if (req.method === 'POST' && p === '/cmux/new-surface') return cmuxNewSurface(req, res);
  if (req.method === 'GET' && p === '/cmux/start-dirs') return cmuxStartDirs(req, res, u);
  if (req.method === 'POST' && p === '/cmux/new-workspace') return cmuxNewWorkspace(req, res);
  if (req.method === 'POST' && p === '/cmux/close-tab') return cmuxCloseTab(req, res);
  if (p === '/cmux/orphans' || p === '/cmux/orphans/close') return cmuxOrphans(req, res, p);
  if (req.method === 'POST' && p === '/cmux/rename-workspace') return cmuxRenameWorkspace(req, res);
  if (req.method === 'POST' && p === '/cmux/close-workspace') return cmuxCloseWorkspace(req, res);
  if (req.method === 'POST' && p === '/cmux/new-pane') return cmuxNewPane(req, res);
  if (req.method === 'POST' && p === '/cmux/split-off') return cmuxSplitOff(req, res);
  if (req.method === 'POST' && p === '/cmux/drop-surface') return cmuxDropSurface(req, res);
  if (req.method === 'POST' && p === '/cmux/move-pane') return cmuxMovePane(req, res);
  if (req.method === 'POST' && p === '/cmux/move-to-workspace') return cmuxMoveToWorkspace(req, res);
  if (req.method === 'POST' && p === '/cmux/reorder-tab') return cmuxReorderTab(req, res);
  if (p === '/cmux/chrome-prompt' && (req.method === 'GET' || req.method === 'POST')) return cmuxChromePrompt(req, res);
  if (req.method === 'POST' && p === '/cmux/close-pane') return cmuxClosePane(req, res);
  if (req.method === 'POST' && p === '/cmux/upload') return cmuxUpload(req, res);
  if (req.method === 'POST' && p === '/cmux/focus-pane') return cmuxFocusPane(req, res);
  if (req.method === 'POST' && p === '/cmux/focus-surface') return cmuxFocusSurface(req, res);
  if (req.method === 'POST' && p === '/cmux/resize-pane') return cmuxResizePane(req, res);
  if (req.method === 'POST' && p === '/cmux/equalize') return cmuxEqualize(req, res);

  // ----- browser surfaces -----
  if (req.method === 'POST' && p === '/cmux/browser/open') return cmuxBrowserOpen(req, res);
  if (req.method === 'GET' && p === '/cmux/browser/info') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxBrowserInfo(res, s);
  }
  if (req.method === 'GET' && p === '/cmux/browser/stream') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxBrowserStream(req, res, s, viewportDim(u.searchParams.get('vw'), 200, 2000),
      viewportDim(u.searchParams.get('vh'), 200, 3000));
  }
  if (req.method === 'GET' && p === '/cmux/browser/shot') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxBrowserShot(res, s);
  }
  if (req.method === 'GET' && p === '/cmux/browser/hits') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxBrowserHits(res, s);
  }
  if (req.method === 'POST' && p === '/cmux/browser/tap') return cmuxBrowserTap(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/unhideframe') return cmuxBrowserUnhideFrame(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/type') return cmuxBrowserType(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/key') return cmuxBrowserKey(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/scroll') return cmuxBrowserScroll(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/nav') return cmuxBrowserNav(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/zoom') return cmuxBrowserZoom(req, res);

  // ----- p41 D97 Mac screen (whole desktop; off unless SCREEN_VIEW / SCREEN_CONTROL) -----
  // p41 D189: Remote Desktop setup status (?fresh=1 re-probes, floor 2 s) + the phone's "Remind on Mac" flag.
  if (req.method === 'GET' && p === '/cmux/rd-setup') {
    return rdSetup.status({ fresh: u.searchParams.get('fresh') === '1' }).then((s) => send(res, s ? 200 : 404, s ? { ok: true, screen: s } : { error: 'not_mac' }), () => send(res, 502, { error: 'probe_failed' }));
  }
  if (req.method === 'POST' && p === '/cmux/rd-setup/remind') {
    return cmuxReadBody(req, (b) => send(res, 200, rdSetup.setRemind(!!(b && b.clear))), 1024);
  }
  if (req.method === 'GET' && p === '/cmux/screen/info') return macScreen.info().then((r) => send(res, r.status, r.body), () => send(res, 502, { error: 'screen_failed' }));
  if (req.method === 'GET' && p === '/cmux/screen/dialogs') return macScreen.dialogs().then((r) => send(res, r.status, r.body), () => send(res, 502, { error: 'screen_failed' }));   // p41 D135
  if (req.method === 'GET' && p === '/cmux/screen/shot') return macScreen.shot(u.searchParams.get('display')).then((r) => send(res, r.status, r.body), () => send(res, 502, { error: 'screen_failed' }));
  if (req.method === 'POST' && (p === '/cmux/screen/dialogs/press' || p === '/cmux/screen/dialogs/type')) {   // p41 D136 (body never logged)
    const fn = p.endsWith('/press') ? macScreen.dialogPress : macScreen.dialogType;
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      fn(b).then((r) => send(res, r.status, r.body), () => send(res, 502, { error: 'screen_failed' }));
    }, require('./lib/mac-dialogs').LIMITS.DIALOG_BODY_MAX_BYTES);
  }
  if (req.method === 'POST' && p === '/cmux/screen/mouse') {   // p41 D159 move|down|drag|up
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      macScreen.mouse(b).then((r) => send(res, r.status, r.body), () => send(res, 502, { error: 'screen_failed' }));
    }, 4 * 1024);
  }
  if (req.method === 'POST' && /^\/cmux\/screen\/(tap|scroll|type|key)$/.test(p)) {
    const op = p.slice('/cmux/screen/'.length);
    return cmuxReadBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad_json' });
      macScreen.input(op, b).then((r) => send(res, r.status, r.body), () => send(res, 502, { error: 'screen_failed' }));
    }, 16 * 1024);
  }

  // ----- p41 S2c Claude accounts -----
  if (p === '/cmux/accounts' || p.startsWith('/cmux/accounts/')) return cmuxAccounts(req, res, u, p);
  if (p === '/cmux/tasks' || p === '/cmux/tasks/item') return cmuxTasks(req, res, u, p);   // p41 D152
  return send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return graceful.health(res);
  if (req.url && req.url.startsWith('/cmux/')) {
    // p41 D133: capability flag. The server queues + retries /cmux/send ONLY for a bridge that
    // advertises sendId dedupe, so a new server relaying to an old bridge never double-types.
    res.setHeader('x-cmux-send-idem', '1');
    return handleCmux(req, res);
  }
  return send(res, 404, { error: 'not_found' });
});
// p41 A18: SIGTERM -> `event: restarting` on every open SSE stream, short drain, exit.
const graceful = require('./lib/graceful').createGraceful(server);
graceful.install();
// What both listen paths print and do once the bridge is reachable.
function afterListen() {
  graceful.markReady();
  if (!SECRET) console.log('WARNING: BRIDGE_SECRET empty → /cmux/* is open. Only run on a trusted LAN.');
  console.log(`backend: ${BACKEND}`);
  if (!tmuxCli) {
    probeCmuxVersion((c) => {
      if (!c || !c.version) console.log(`WARNING: could not read the cmux version (${CMUX_BIN} --version) — cmux-remote is verified on cmux >= ${cmuxVersion.MIN_CMUX_VERSION}`);
      else if (!c.supported) console.log(`WARNING: cmux ${c.version} is older than ${c.min}, the earliest version cmux-remote is verified on — expect gaps (e.g. short pane history). Update cmux.`);
      else console.log(`cmux: ${c.version} (>= ${c.min})`);
    });
  }
  // Contact the tmux server once at boot so `main` exists before the first page load. A failure is
  // only logged: every later request runs ensure() again, so a tmux that comes up late is picked up.
  if (tmuxCli) {
    tmuxCli.ensure().then(
      (r) => console.log(`tmux: ready (epoch ${r.epoch}, tmux ${r.version})`),
      (e) => console.log(`tmux: not ready yet — ${(e && e.message) || e}`));
  }
}
if (SOCKET) {
  // lib/unix-listen.js checks the directory (real path, 0700, ours, safe ancestors), refuses a live
  // socket at the path, removes a stale one, listens, then chmods the socket 0600.
  if (process.env.BRIDGE_PORT || process.env.BRIDGE_HOST) console.log('note: BRIDGE_SOCKET is set — BRIDGE_PORT/BRIDGE_HOST are ignored; no TCP port is opened');
  unixListen.listenUnix(server, SOCKET).then(
    (r) => {
      if (r === 'removed') console.log(`removed stale socket ${SOCKET}`);
      console.log(`cmux-remote bridge on unix:${SOCKET}`);
      afterListen();
    },
    (e) => { console.error(`refusing to start: ${e.code || 'listen_failed'}: ${e.detail || e.message}`); process.exit(1); });
} else {
  server.listen(PORT, HOST, () => {
    // Report the BOUND port, not the requested one: BRIDGE_PORT=0 asks the OS for a free port, which
    // is how the test suite starts throwaway bridges without ever touching the live :8799.
    const bound = (server.address() && server.address().port) || PORT;
    console.log(`cmux-remote bridge on ${HOST}:${bound}`);
    if (HOST === '127.0.0.1' || HOST === 'localhost') {
      console.log(`note: bound to loopback — only a server on THIS Mac can reach it. To register this Mac on a server elsewhere, set BRIDGE_HOST=0.0.0.0 (LAN, secret-gated) or point a tunnel at :${bound}.`);
    }
    afterListen();
  });
}
}
