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

const PORT = Number(process.env.BRIDGE_PORT || 8799);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const SECRET = process.env.BRIDGE_SECRET || '';
const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX_ENV = { ...process.env, CMUX_QUIET: '1' };

const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
// A surface target: a surface ref (surface:N) or a raw UUID. This is what every terminal op addresses.
const SURFACE_RE = new RegExp(`^(surface:\\d+|${UUID})$`);
// A workspace target: a workspace ref (workspace:N) or a UUID. Used when creating a tab in a workspace.
const WORKSPACE_RE = new RegExp(`^(workspace:\\d+|${UUID})$`);
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
function cmux(args, cb, timeout = 8000) {
  execFile(CMUX_BIN, args, { timeout, env: CMUX_ENV, maxBuffer: 8 * 1024 * 1024 }, cb);
}
const cmuxP = (args, timeout) => new Promise((resolve) =>
  cmux(args, (err, stdout) => resolve(err ? null : (stdout || '')), timeout));
function cmuxReadBody(req, cb, cap = 256 * 1024) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > cap) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (_) { cb(null); } });
}

// ---------- tree: workspaces -> tabs (surfaces) ------------------------------
// One `tree --all --json --id-format both` call gives the whole hierarchy including UUIDs. We flatten
// each workspace's panes[].surfaces[] into a tab list so multi-pane / multi-surface workspaces expose
// every tab, and carry both the surface UUID (stable identity) and ref (what cmux ops address).
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
      for (const pane of (ws.panes || [])) {
        for (const sf of (pane.surfaces || [])) {
          tabs.push({
            id: sf.id || sf.ref,
            ref: sf.ref,
            title: (sf.title || sf.ref || '').trim(),
            type: sf.type || 'terminal',
            selected: !!sf.selected,
          });
        }
      }
      workspaces.push({
        ref: ws.ref,
        id: ws.id || ws.ref,
        title: (ws.title || ws.ref || '').trim(),
        selected: !!ws.selected,
        tabs,
      });
    }
  }
  return workspaces;
}

// Per-tab status ("claude_code=Running ..." -> "Running"). Best-effort; only terminal tabs, capped
// so a huge tree can't fan out into hundreds of cmux calls.
async function statusOfSurface(ref) {
  const st = await cmuxP(['list-status', '--surface', ref], 4000);
  const m = st && st.match(/=(\S+)/);
  return m ? m[1] : '';
}
async function attachStatuses(workspaces) {
  const terminalTabs = [];
  for (const ws of workspaces) for (const t of ws.tabs) if (t.type === 'terminal') terminalTabs.push(t);
  const capped = terminalTabs.slice(0, 60);
  // chunked, not one big Promise.all: 60 concurrent cmux spawns every tree poll starves
  // terminal.replay for the OPEN tab (same contention as the screenshot-cadence lesson)
  for (let i = 0; i < capped.length; i += 8)
    await Promise.all(capped.slice(i, i + 8).map(async (t) => { t.status = await statusOfSurface(t.ref); }));
  return workspaces;
}

async function cmuxTree(res) {
  const ws = await loadTree();
  if (ws == null) return send(res, 502, { error: 'cmux_failed' });
  await attachStatuses(ws);
  send(res, 200, { workspaces: ws });
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
const gridHash = (obj) => crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
function sendGrid(res, obj, ifHash) {
  const h = gridHash(obj);
  if (ifHash && ifHash === h) return send(res, 200, { same: 1 });
  send(res, 200, { ...obj, h });
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
  gridPayload(surface, (obj) => (obj ? sendGrid(res, obj, ifHash) : send(res, 502, { error: 'cmux_failed' })));
}

// GET /cmux/grid-stream?surface=&h= -> SSE of hash-deduped grid frames (push replaces client polling).
// Same payload + `h` semantics as /cmux/grid, but the request-per-frame round trip is gone: the bridge
// watches the surface on an adaptive cadence (fast while changing, backed off when idle) and pushes a
// frame ONLY when the grid hash moves. `?h=` (the client's cached hash) suppresses the initial frame
// when nothing changed since the tab was last shown.
function cmuxGridStream(req, res, surface, ifHash) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  let lastHash = ifHash || null, alive = true, timer = null, idle = 0;
  const delay = () => (idle > 3 ? 900 : 250);
  const schedule = () => { if (alive) timer = setTimeout(tick, delay()); };
  const tick = () => {
    if (!alive) return;
    gridPayload(surface, (obj) => {
      if (!alive) return;
      if (!obj) { res.write('event: error\ndata: cmux_failed\n\n'); return schedule(); }
      const h = gridHash(obj);
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

// POST /cmux/new-surface { workspace } — add a new tab (terminal surface) to a workspace.
function cmuxNewSurface(req, res) {
  cmuxReadBody(req, (b) => {
    if (!b) return send(res, 400, { error: 'bad_json' });
    const workspace = String(b.workspace || '');
    if (!WORKSPACE_RE.test(workspace)) return send(res, 400, { error: 'bad_workspace' });
    const before = new Set();
    (async () => {
      const pre = await loadTree();
      if (pre) for (const w of pre) for (const t of w.tabs) before.add(t.id);
      cmux(['new-surface', '--type', 'terminal', '--workspace', workspace, '--focus', 'false'], async (err, stdout, stderr) => {
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

// ---------- routing ---------------------------------------------------------
function handleCmux(req, res) {
  if (SECRET && req.headers['x-bridge-secret'] !== SECRET) return send(res, 403, { error: 'forbidden' });
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { return send(res, 400, { error: 'bad_url' }); }
  const p = u.pathname;
  const surfaceParam = () => u.searchParams.get('surface') || '';

  if (req.method === 'GET' && p === '/cmux/tree') return cmuxTree(res);

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

http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/cmux/')) return handleCmux(req, res);
  return send(res, 404, { error: 'not_found' });
}).listen(PORT, HOST, () => {
  console.log(`cmux-remote bridge on ${HOST}:${PORT}`);
  if (!SECRET) console.log('WARNING: BRIDGE_SECRET empty → /cmux/* is open. Only run on a trusted LAN.');
});
