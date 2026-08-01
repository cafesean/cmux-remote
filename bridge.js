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
//   BRIDGE_SECRET  shared secret the server presents; empty = no auth (trusted LAN only)
//   CMUX_BIN       path to the cmux CLI (default: the macOS app bundle path)
require('./loadenv');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createFsBrowse, parseRange, contentDisposition } = require('./fsbrowse');
const eventlog = require('./radar/eventlog');
const { normalizeLayout } = require('./panelayout');

const PORT = Number(process.env.BRIDGE_PORT || 8799);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const SECRET = process.env.BRIDGE_SECRET || '';
// Machine identity (p5 radar). Radar's session identity is {machine, session_id} and NEVER cwd, so
// every response that carries session data carries the machine it came from.
const MACHINE_ID = process.env.RADAR_MACHINE_ID || os.hostname();
const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX_ENV = { ...process.env, CMUX_QUIET: '1' };

const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
// A surface target: a surface ref (surface:N) or a raw UUID. This is what every terminal op addresses.
const SURFACE_RE = new RegExp(`^(surface:\\d+|${UUID})$`);
// A workspace target: a workspace ref (workspace:N) or a UUID. Used when creating a tab in a workspace.
const WORKSPACE_RE = new RegExp(`^(workspace:\\d+|${UUID})$`);
// A pane target: a pane ref (pane:N) or a UUID. Clients send UUIDs — refs are window-relative and do
// not resolve from this detached process (same trap as surface refs).
const PANE_RE = new RegExp(`^(pane:\\d+|${UUID})$`);
const SPLIT_DIRS = new Set(['left', 'right', 'up', 'down']);
const MAX_STREAM_SURFACES = 6;   // panes mirrored at once — each costs one terminal.replay per round
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
  res.end(JSON.stringify(obj));
}
// Older cmux builds (e.g. 0.62.x) reject flags newer ones accept: `--id-format` is global-only there
// (must precede the subcommand), and `new-surface`/`new-workspace` have no `--focus`. Rather than pin a
// cmux version, retry once per rejected flag — relocate `--id-format`, drop anything else it doesn't know.
const FLAG_VALUES = new Set(['--id-format', '--focus', '--type', '--lines', '--surface', '--workspace', '--pane']);
function adaptArgs(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const take = FLAG_VALUES.has(flag) ? 2 : 1;
  const rest = args.slice(0, i).concat(args.slice(i + take));
  if (flag === '--id-format') return [flag, args[i + 1], ...rest];   // move to global position
  return rest;                                                       // unsupported flag: drop it
}
function cmux(args, cb, timeout = 8000, tries = 0) {
  execFile(CMUX_BIN, args, { timeout, env: CMUX_ENV, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
function cmuxReadBody(req, cb, cap = 256 * 1024) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > cap) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (_) { cb(null); } });
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
// OFF BY DEFAULT, and reads and writes have SEPARATE switches. Default-off on the panel buys
// nothing once the operator turns the panel on, and the honest position (§12.6) is that direct writes add
// untraced execution even though they add no authority a shell did not already have.
const GIT_PANEL_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.GIT_PANEL_ENABLED || '').trim());
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
async function loadTree() {
  // `cmux tree` can briefly stall while a surface tears down (e.g. closing a tab an agent was mid-prompt on).
  // Retry once with a longer timeout so a transient stall doesn't hard-fail the whole UI ("tree failed").
  let out = await cmuxP(['tree', '--all', '--json', '--id-format', 'both'], 12000);
  if (out == null) { await new Promise((r) => setTimeout(r, 400)); out = await cmuxP(['tree', '--all', '--json', '--id-format', 'both'], 12000); }
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
// So always pass UUIDs as *_id. Clients already address workspaces by UUID (ws.id).
const rpcTarget = (key, value) => (/^[0-9A-Fa-f-]{36}$/.test(value) ? { [key + '_id']: value } : { [key]: value });
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
function parseStatusLine(out) {
  if (!out) return '';
  const line = String(out).split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!line) return '';
  const m = line.match(STATUS_VALUE_RE);
  return m ? m[1].trim() : '';
}
async function statusOfWorkspace(ref) {
  return parseStatusLine(await cmuxP(['list-status', '--workspace', ref], 4000));
}
const STATUS_WS_CAP = 30;
async function attachStatuses(workspaces) {
  const withTerminals = workspaces.filter((ws) => (ws.tabs || []).some((t) => t.type === 'terminal'));
  const capped = withTerminals.slice(0, STATUS_WS_CAP);
  // chunked, not one big Promise.all: concurrent cmux spawns every tree poll starve
  // terminal.replay for the OPEN tab (same contention as the screenshot-cadence lesson)
  for (let i = 0; i < capped.length; i += 8) {
    await Promise.all(capped.slice(i, i + 8).map(async (ws) => {
      const status = await statusOfWorkspace(ws.ref);
      ws.status = status;
      for (const t of ws.tabs) if (t.type === 'terminal') { t.status = status; t.statusScope = 'workspace'; }
    }));
  }
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
  const ws = await loadTree();
  if (ws == null) return send(res, 502, { error: 'cmux_failed' });
  const cov = await attachStatuses(ws);
  send(res, 200, {
    workspaces: ws,
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
      if (h !== lastHash) { lastHash = h; idle = 0; res.write('data: ' + JSON.stringify({ ...l, h }) + '\n\n'); }
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
function gridPayload(surface, cb) {
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
      if (h !== lastHash) { lastHash = h; idle = 0; res.write('data: ' + JSON.stringify({ ...obj, h }) + '\n\n'); }
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
        res.write('data: ' + JSON.stringify({ surface, ...obj, h }) + '\n\n');
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
    : send(res, 200, { screen: stdout || '' })));
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
        res.write('data: ' + Buffer.from(screen, 'utf8').toString('base64') + '\n\n');
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
// POST /cmux/send { surface, text, submit } — type text into a tab, optionally press enter to submit.
function cmuxSend(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    const text = typeof b.text === 'string' ? b.text : '';
    const run = (args) => new Promise((resolve, reject) => cmux(args, (e) => (e ? reject(e) : resolve())));
    (async () => {
      try {
        if (text) await run(['send', '--surface', surface, '--', text]);   // argv (no shell) → no injection
        if (b.submit) await run(['send-key', '--surface', surface, '--', 'enter']);
        send(res, 200, { ok: true });
      } catch (e) { send(res, 502, { error: 'cmux_failed', detail: String((e && e.message) || e).slice(0, 200) }); }
    })();
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
    cmux(['send-key', '--surface', surface, '--', key], (e) => (e ? send(res, 502, { error: 'cmux_failed' }) : send(res, 200, { ok: true })));
  });
}

// ---------- lifecycle: new tab (surface) / new workspace / close tab --------
async function treePayload() {
  const ws = await loadTree();
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
    const before = new Set();
    (async () => {
      const pre = await loadTree();
      if (pre) for (const w of pre) for (const t of w.tabs) before.add(t.id);
      cmux(args, async (err, stdout, stderr) => {
        if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
        const workspaces = await treePayload();
        let created = null;
        if (workspaces) for (const w of workspaces) for (const t of w.tabs) if (!before.has(t.id)) created = t.id;
        send(res, 200, { ok: true, id: created, workspaces: workspaces || [] });
      }, 12000);
    })();
  });
}

// POST /cmux/new-workspace { cwd?, command? } — create a whole new workspace.
function cmuxNewWorkspace(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const args = ['new-workspace', '--focus', 'false'];
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

// POST /cmux/close-tab { surface } — close a tab (surface).
function cmuxCloseTab(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const surface = String(b.surface || '');
    if (!SURFACE_RE.test(surface)) return send(res, 400, { error: 'bad_surface' });
    cmux(['close-surface', '--surface', surface], async (err, stdout, stderr) => {
      if (err) return send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 400) });
      const workspaces = await treePayload();
      send(res, 200, { ok: true, closed: surface, workspaces: workspaces || [] });
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

// ---------- dropped files -----------------------------------------------------------------------
// Dragging an image onto a terminal on the Mac gives the agent a PATH to read. From a phone there is
// no path, so the file has to land on the Mac first: this writes the body to a directory and answers
// with the absolute path, which the client then types into the terminal.
//
// Deliberately narrow: one fixed directory (never a caller-supplied one), the name reduced to a
// basename with anything exotic stripped, a size cap, and no execute bit. It is reachable only with
// the bridge secret, i.e. only through the token-gated server.
const UPLOAD_DIR = process.env.UPLOAD_DIR || `${os.homedir()}/Downloads/cmux-remote`;
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 32 * 1024 * 1024);
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
// day folders keep the drop directory from turning into one flat pile
function uploadTarget(name) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = `${UPLOAD_DIR}/${day}`;
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(name);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let p = `${dir}/${base}`;
  for (let i = 1; fs.existsSync(p); i++) p = `${dir}/${stem}-${i}${ext}`;   // never clobber
  return p;
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
  req.on('end', () => {
    if (aborted) return;
    if (!size) return send(res, 400, { error: 'empty' });
    try {
      // the client percent-encodes the name (a header is latin-1 only, a photo can be named anything)
      let name = String(req.headers['x-file-name'] || 'file');
      try { name = decodeURIComponent(name); } catch (_) { /* keep the raw form; safeName still runs */ }
      const target = uploadTarget(name);
      fs.writeFileSync(target, Buffer.concat(chunks), { mode: 0o644 });
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
      for (const s of surfaces) {
        const out = await new Promise((resolve) => cmux(['close-surface', '--surface', s],
          (err, stdout, stderr) => resolve(err ? String(stderr || err.message || '') : null), 8000));
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
    cmux(['rpc', 'surface.focus', JSON.stringify({ surface_id: surface })], (err, stdout, stderr) => (err
      ? send(res, 502, { error: 'cmux_failed', detail: String(stderr || err.message || '').slice(0, 200) })
      : send(res, 200, { ok: true })), 8000);
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
const BROWSER_SHOT_JPEG_Q = '55';    // sips formatOptions: low|normal|high|best or 0-100
// Actions don't carry frames (they ack instantly); instead every action stamps its surface here and
// the SSE loop BURSTS (350ms ticks) for a short window after — visual feedback lands fast exactly
// when the user just did something, without paying a screenshot inside the action round-trip.
const browserLastAction = new Map();   // surface -> Date.now()
const noteAction = (surface) => browserLastAction.set(surface, Date.now());
function browserShot(surface) {   // -> Promise<{buf:Buffer, raw:number}|null>
  const out = browserShotPath(surface);
  const jpg = out.replace(/\.png$/, '.jpg');
  return new Promise((resolve) => cmux(['browser', surface, 'screenshot', '--out', out], (err) => {
    if (err) return resolve(null);
    fs.readFile(out, (e, png) => {
      if (e) return resolve(null);
      execFile('/usr/bin/sips', ['-Z', String(BROWSER_SHOT_MAX_DIM), '-s', 'format', 'jpeg',
        '-s', 'formatOptions', BROWSER_SHOT_JPEG_Q, out, '--out', jpg], { timeout: 8000 }, (se) => {
        if (se) return resolve({ buf: png, raw: png.length });   // sips failed → raw PNG fallback
        fs.readFile(jpg, (je, jbuf) => resolve(je ? { buf: png, raw: png.length } : { buf: jbuf, raw: png.length }));
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

// GET /cmux/browser/stream?surface= -> SSE of base64 PNG frames, emitted only when the shot changes.
// ADAPTIVE cadence — a screenshot of a big Retina pane costs the cmux app real CPU every tick, and an
// unbounded 900ms loop on a ~3MB pane starves terminal.replay for every OTHER tab (observed: terminal
// mirrors going from instant to ~10s). So: poll fast only while the page is actually changing, back off
// hard when it idles, and back off extra for huge panes.
function cmuxBrowserStream(req, res, surface) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  let lastHash = null, alive = true, busy = false, idleTicks = 0, lastRaw = 0, timer = null;
  const delay = () => {
    const since = Date.now() - (browserLastAction.get(surface) || 0);
    if (since < 2500) return lastRaw > 1536 * 1024 ? 500 : 350;   // just-acted burst: frames land fast
    let d = idleTicks > 4 ? 2500 : 1000;                    // idle page → 2.5s; active page → 1s
    if (lastRaw > 1536 * 1024) d = Math.max(d, 2000);       // huge SOURCE pane → snapshot cost on the
    return d;                                               // cmux app itself; never faster than 2s
  };
  const schedule = () => { if (alive) timer = setTimeout(tick, delay()); };
  const tick = () => {
    if (!alive) return;
    if (busy) return schedule();
    busy = true;
    browserShot(surface).then((shot) => {
      busy = false;
      if (!alive) return;
      if (!shot) { res.write('event: error\ndata: cmux_failed\n\n'); return schedule(); }
      lastRaw = shot.raw;
      const h = crypto.createHash('md5').update(shot.buf).digest('hex');
      if (h !== lastHash) { lastHash = h; idleTicks = 0; res.write('data: ' + shot.buf.toString('base64') + '\n\n'); }
      else idleTicks++;
      schedule();
    });
  };
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 15000);
  tick();
  const done = () => { if (!alive) return; alive = false; if (timer) clearTimeout(timer); clearInterval(hb); try { res.end(); } catch (_) {} };
  req.on('close', done); req.on('error', done);
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
    const js = `(function(fx,fy){var x=Math.round(fx*innerWidth),y=Math.round(fy*innerHeight);var el=document.elementFromPoint(x,y);if(!el)return JSON.stringify({hit:null,x:x,y:y});try{if(el.focus)el.focus();}catch(e){}var a=el.closest?el.closest('a[href]'):null;var href=(a&&a.href&&/^https?:/i.test(a.href)&&a.href!==location.href)?a.href:null;var ed=(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable===true);if(!href){['mousedown','mouseup','click'].forEach(function(t){el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,button:0}));});}var val=ed?String(el.value!==undefined?el.value:(el.textContent||'')).slice(0,2000):null;return JSON.stringify({hit:el.tagName,editable:ed,value:val,x:x,y:y,nav:href,loc:location.href});})(${fx},${fy})`;
    (async () => {
      const out = await browserEval(surface, js);
      let r = {}; try { r = JSON.parse(out) || {}; } catch (_) { r = { raw: String(out || '').slice(0, 300) }; }
      noteAction(surface);   // SSE bursts frames for the next 2.5s — no screenshot inside the response
      if (r.nav) {
        // Anchor tap → real navigation via cmux. Fire-and-forget; ack instantly with the target url.
        cmux(['browser', surface, 'goto', r.nav], () => {}, 20000);
        return send(res, 200, { ok: true, ...r, hit: r.hit || null, editable: false, url: r.nav });
      }
      send(res, 200, { ok: true, ...r, hit: r.hit || null, editable: !!r.editable });
    })();
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
    const text = typeof b.text === 'string' ? b.text.slice(0, 4096) : '';
    const js = `(function(t){var el=document.activeElement;if(!el)return'noactive';if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,'value').set;setter.call(el,t);try{el.selectionStart=el.selectionEnd=t.length;}catch(_){}el.dispatchEvent(new Event('input',{bubbles:true}));return'ok';}if(el.isContentEditable){el.textContent=t;el.dispatchEvent(new Event('input',{bubbles:true}));return'ok';}return'notinput';})(${JSON.stringify(text)})`;
    (async () => { const out = await browserEval(surface, js); noteAction(surface); send(res, 200, { ok: true, result: (out || '').trim() }); })();
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
    const args = ['browser', surface, 'scroll'];
    if (dy) args.push('--dy', String(dy));
    if (dx) args.push('--dx', String(dx));
    cmux(args, (err) => { if (err) return send(res, 502, { error: 'cmux_failed' }); noteAction(surface); send(res, 200, { ok: true }); });
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

// ---------- routing ---------------------------------------------------------
function handleCmux(req, res) {
  if (SECRET && req.headers['x-bridge-secret'] !== SECRET) return send(res, 403, { error: 'forbidden' });
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { return send(res, 400, { error: 'bad_url' }); }
  const p = u.pathname;
  const surfaceParam = () => u.searchParams.get('surface') || '';

  if (req.method === 'GET' && p === '/cmux/tree') return cmuxTree(res);
  if (req.method === 'GET' && p === '/cmux/completions') return cmuxCompletions(res, u);
  if (p.startsWith('/cmux/git/')) return cmuxGit(req, res, u, p.slice('/cmux/git/'.length));
  if (req.method === 'GET' && p === '/cmux/session-events') return cmuxSessionEvents(res, u);

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
  if (req.method === 'GET' && p === '/cmux/stream') {
    const s = surfaceParam();
    if (!SURFACE_RE.test(s)) return send(res, 400, { error: 'bad_surface' });
    return cmuxStream(req, res, s);
  }
  if (req.method === 'POST' && p === '/cmux/send') return cmuxSend(req, res);
  if (req.method === 'POST' && p === '/cmux/key') return cmuxKey(req, res);
  if (req.method === 'POST' && p === '/cmux/new-surface') return cmuxNewSurface(req, res);
  if (req.method === 'POST' && p === '/cmux/new-workspace') return cmuxNewWorkspace(req, res);
  if (req.method === 'POST' && p === '/cmux/close-tab') return cmuxCloseTab(req, res);
  if (req.method === 'POST' && p === '/cmux/close-workspace') return cmuxCloseWorkspace(req, res);
  if (req.method === 'POST' && p === '/cmux/new-pane') return cmuxNewPane(req, res);
  if (req.method === 'POST' && p === '/cmux/split-off') return cmuxSplitOff(req, res);
  if (req.method === 'POST' && p === '/cmux/drop-surface') return cmuxDropSurface(req, res);
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
    return cmuxBrowserStream(req, res, s);
  }
  if (req.method === 'POST' && p === '/cmux/browser/tap') return cmuxBrowserTap(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/type') return cmuxBrowserType(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/key') return cmuxBrowserKey(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/scroll') return cmuxBrowserScroll(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/nav') return cmuxBrowserNav(req, res);
  if (req.method === 'POST' && p === '/cmux/browser/zoom') return cmuxBrowserZoom(req, res);
  return send(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/cmux/')) return handleCmux(req, res);
  return send(res, 404, { error: 'not_found' });
});
server.listen(PORT, HOST, () => {
  // Report the BOUND port, not the requested one: BRIDGE_PORT=0 asks the OS for a free port, which
  // is how the test suite starts throwaway bridges without ever touching the live :8799.
  const bound = (server.address() && server.address().port) || PORT;
  console.log(`cmux-remote bridge on ${HOST}:${bound}`);
  if (!SECRET) console.log('WARNING: BRIDGE_SECRET empty → /cmux/* is open. Only run on a trusted LAN.');
});
