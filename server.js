#!/usr/bin/env node
// cmux-remote server — serves the web UI and proxies /api/cmux/* to the per-machine bridges.
// Holds the machine registry (from env vars or a gitignored config file). The browser only ever
// receives machine LABELS — bridge URLs, secrets, and any tunnel/Access tokens stay on the server.
// No dependencies — plain `node server.js` (needs Node 18+ for global fetch).
//
// Env (a .env in the CWD is auto-loaded):
//   PORT           default 8080 — the UI/proxy port
//   SERVER_TOKEN   token the browser must present on /api/* (empty = open; trusted LAN only)
//
//   Machine registry (any of these, merged by id — nothing is committed to the repo):
//     CMUX_MACHINE_URL / CMUX_MACHINE_SECRET / CMUX_MACHINE_LABEL      — a single default machine
//     CMUX_MACHINE_ACCESS_ID / CMUX_MACHINE_ACCESS_SECRET             — optional Cloudflare Access token
//     CMUX_MACHINES   — JSON array [{id,label,baseUrl,secret,accessId?,accessSecret?}] (extends/overrides)
//     CMUX_CONFIG     — path to a gitignored JSON file { "machines": [ ... ] } (extends/overrides)
require('./loadenv');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || process.env.SERVER_HOST || '127.0.0.1';
const SERVER_TOKEN = process.env['SERVER_TOKEN'] || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- radar (p5) -------------------------------------------------------------
// OFF BY DEFAULT, and off means OFF: with RADAR_ENABLED unset, nothing under radar/ is required,
// no timer is installed, no handler is registered, and every /api/radar/* path 404s exactly as it
// did before radar was written. Rollback is `unset RADAR_ENABLED` + restart — there is no second
// switch to find. See README → "Radar (p5)".
//
// The load is inside a try/catch on purpose. Radar is an add-on to a terminal mirror people depend
// on: a broken collector has to degrade to "no radar", never to "no cmux".
const RADAR_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.RADAR_ENABLED || '').trim());
let radar = null;
if (RADAR_ENABLED) {
  try {
    radar = require('./radar-server').createRadar();
    radar.start();
    console.log(`radar: enabled — ${radar.paths.dir}`);
  } catch (e) {
    radar = null;
    console.error(`radar: failed to start, continuing WITHOUT it: ${(e && e.message) || e}`);
  }
}

// Build the machine registry from env + optional config file. Later sources override earlier by id.
function loadMachines() {
  const byId = new Map();
  if (process.env.CMUX_MACHINE_URL) {
    byId.set('default', {
      id: 'default',
      label: process.env.CMUX_MACHINE_LABEL || 'My Mac',
      baseUrl: process.env.CMUX_MACHINE_URL,
      secret: process.env.CMUX_MACHINE_SECRET || '',
      accessId: process.env.CMUX_MACHINE_ACCESS_ID || '',
      accessSecret: process.env.CMUX_MACHINE_ACCESS_SECRET || '',
    });
  }
  if (process.env.CMUX_MACHINES) {
    try {
      const arr = JSON.parse(process.env.CMUX_MACHINES);
      if (Array.isArray(arr)) for (const m of arr) if (m && m.id) byId.set(m.id, m);
    } catch (_) { console.error('CMUX_MACHINES: invalid JSON — ignored'); }
  }
  if (process.env.CMUX_CONFIG) {
    try {
      const j = JSON.parse(fs.readFileSync(process.env.CMUX_CONFIG, 'utf8'));
      if (j && Array.isArray(j.machines)) for (const m of j.machines) if (m && m.id) byId.set(m.id, m);
    } catch (_) { console.error(`CMUX_CONFIG (${process.env.CMUX_CONFIG}): unreadable / invalid JSON — ignored`); }
  }
  return [...byId.values()].map((m) => ({ ...m, baseUrl: String(m.baseUrl || '').replace(/\/$/, '') }));
}
const MACHINES = loadMachines();
const findMachine = (id) => (id ? MACHINES.find((m) => m.id === id) : MACHINES[0]) || null;

// Cloudflare Access service-token headers, for machines reached over a named tunnel gated by CF Access.
// Empty accessId/accessSecret → no headers (LAN / quick-tunnel machines).
const accessHeaders = (m) => (m.accessId && m.accessSecret)
  ? { 'CF-Access-Client-Id': m.accessId, 'CF-Access-Client-Secret': m.accessSecret }
  : {};

// Fetch a bridge endpoint with its secret (+ CF Access token if set) and a hard timeout.
async function bridge(m, pathAndQuery, opt = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeout || 15000);
  try {
    return await fetch(`${m.baseUrl}${pathAndQuery}`, {
      ...opt,
      headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m), ...(opt.headers || {}) },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'surrogate-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// Pass a bridge JSON response straight through (status + body).
async function relay(res, upstreamPromise) {
  try {
    const r = await upstreamPromise;
    const body = await r.json().catch(() => ({ error: 'bad_upstream' }));
    res.writeHead(r.status, {
      'content-type': 'application/json',
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      pragma: 'no-cache',
      expires: '0',
      'surrogate-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  } catch (_) { sendJson(res, 502, { error: 'bridge_unreachable' }); }
}

function readBody(req, cb, cap = 256 * 1024) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > cap) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (_) { cb(null); } });
}

// ---- download tickets -------------------------------------------------------
// A file download is a NAVIGATION (an <a download> click), and a navigation cannot carry an
// Authorization header. The obvious shortcut — SERVER_TOKEN in the download URL — would put the
// key to the whole UI into browser history, the share sheet, and every log that records query
// strings. So the client trades its token, over an authenticated request, for a short-lived ticket
// bound to ONE machine and ONE path. The ticket is the only credential the download URL carries,
// and it can do nothing except fetch that one file.
//
// Deliberately NOT single-use: iOS Safari sometimes probes a download before fetching it, and a
// resumed byte-range is a second request for the same file. The TTL is the bound instead.
const DL_TICKET_TTL = 120000;
const DL_TICKET_MAX = 64;
const dlTickets = new Map();

function mintDlTicket(machineId, filePath) {
  const now = Date.now();
  for (const [k, v] of dlTickets) if (now - v.at > DL_TICKET_TTL) dlTickets.delete(k);
  const ticket = crypto.randomBytes(24).toString('base64url');
  dlTickets.set(ticket, { machine: machineId, path: filePath, at: now });
  while (dlTickets.size > DL_TICKET_MAX) dlTickets.delete(dlTickets.keys().next().value);
  return ticket;
}

function readDlTicket(ticket) {
  const hit = ticket && dlTickets.get(ticket);
  if (!hit) return null;
  if (Date.now() - hit.at > DL_TICKET_TTL) { dlTickets.delete(ticket); return null; }
  return hit;
}

// Byte passthrough for /api/cmux/fs/download. Everything else here relays JSON; this one relays a
// body that can be gigabytes, so it differs in two ways that matter:
//   * NO fetch timeout. The JSON endpoints abort at 15–20s; a large file legitimately takes longer,
//     and an aborted body is not a slow download, it is a corrupt file.
//   * pipeline(), so backpressure is respected. Looping over the reader and calling res.write()
//     while ignoring its return value — as the SSE relays do, safely, for tiny frames — would
//     buffer the whole file in this process's memory.
async function relayDownload(req, res, u) {
  const tk = readDlTicket(u.searchParams.get('ticket'));
  if (!tk) return sendJson(res, 403, { error: 'bad_ticket' });
  const m = findMachine(tk.machine);
  if (!m) return sendJson(res, 404, { error: 'no_machine' });
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const headers = { 'x-bridge-secret': m.secret, ...accessHeaders(m) };
  if (req.headers['range']) headers.range = req.headers['range'];
  let up;
  try {
    up = await fetch(`${m.baseUrl}/cmux/fs/download?path=${encodeURIComponent(tk.path)}`,
      { headers, signal: ctrl.signal });
  } catch (_) { return sendJson(res, 502, { error: 'bridge_unreachable' }); }
  const out = { 'cache-control': 'no-store' };
  for (const h of ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'content-range']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  try { await pipeline(Readable.fromWeb(up.body), res); } catch (_) { /* client left, or upstream cut */ }
  try { res.end(); } catch (_) {}
}

// Client -> server auth. If SERVER_TOKEN is empty, the UI is open (only safe on a trusted LAN).
function authed(req, u) {
  if (!SERVER_TOKEN) return true;
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const alt = req.headers['x-app-token'] || '';
  const q = u.searchParams.get('token') || '';   // for EventSource, which can't set headers
  return bearer === SERVER_TOKEN || alt === SERVER_TOKEN || q === SERVER_TOKEN;
}

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
// Static assets: short max-age + ETag revalidation (was no-store — every cold load re-shipped
// index.html and app.js through the tunnel, two full round trips before boot could even start).
function serveStatic(req, res, file) {
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end('not found'); }
    const tag = '"' + crypto.createHash('md5').update(data).digest('hex') + '"';
    const noStoreShell = file === '/' || file === 'index.html' || file === 'app.js' || file === 'sw.js';
    const headers = {
      'content-type': CT[path.extname(fp)] || 'application/octet-stream',
      'cache-control': noStoreShell ? 'no-store, no-cache, must-revalidate' : 'private, max-age=60',
      etag: tag,
    };
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function handleApi(req, res, u) {
  const p = u.pathname;
  // THE ONE ROUTE THAT IS NOT SERVER_TOKEN-GATED, because it is reached by navigation rather than
  // by fetch: it carries its own credential, a ticket minted below for a single path.
  if (req.method === 'GET' && p === '/api/cmux/fs/download') return relayDownload(req, res, u);
  if (!authed(req, u)) return sendJson(res, 401, { error: 'unauthorized' });

  // ----- radar (p5) — mounted only when RADAR_ENABLED is set; `radar &&` is the whole switch -----
  // Wrapped here even though radar-server.js has its own error boundary, because handleApi is
  // async: an escaped rejection would surface as an unhandled rejection, and Node kills the process
  // on those. The terminal mirror is not allowed to die because a git scan threw.
  if (radar && p.startsWith('/api/radar/')) {
    try {
      return await radar.handle(req, res, u);
    } catch (e) {
      console.error(`radar: dispatch ${req.method} ${p} failed: ${(e && e.stack) || e}`);
      if (!res.headersSent) return sendJson(res, 500, { error: 'radar_error' });
      try { return res.end(); } catch (_) { return; }
    }
  }

  if (req.method === 'GET' && p === '/api/cmux/machines') {
    return sendJson(res, 200, { machines: MACHINES.map((m) => ({ id: m.id, label: m.label })) });
  }
  // One-round-trip boot: machines + the (default) machine's tree together. Cold load over a tunnel is
  // RTT-bound — the old machines→tree serial chain cost two full round trips before the UI could pick a tab.
  if (req.method === 'GET' && p === '/api/cmux/bootstrap') {
    const machines = MACHINES.map((m) => ({ id: m.id, label: m.label }));
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 200, { machines, machine: null, workspaces: [] });
    try {
      const r = await bridge(m, '/cmux/tree');
      const d = await r.json().catch(() => ({}));
      return sendJson(res, 200, { machines, machine: m.id, workspaces: (d && d.workspaces) || [], error: (d && d.error) || undefined });
    } catch (_) { return sendJson(res, 200, { machines, machine: m.id, workspaces: [], error: 'bridge_unreachable' }); }
  }
  // Full workspace > tab tree (replaces the old workspace-as-tab /tabs).
  if (req.method === 'GET' && p === '/api/cmux/tree') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    return relay(res, bridge(m, '/cmux/tree'));
  }
  // Trade the caller's SERVER_TOKEN for a ticket the download navigation can carry in its URL.
  // The path is NOT validated here — the bridge's realpath jail is the authority on what may be
  // read, and duplicating that check on this side would only create a second, weaker copy of it.
  if (req.method === 'GET' && p === '/api/cmux/fs/download-ticket') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const fp = u.searchParams.get('path') || '';
    if (!fp) return sendJson(res, 400, { error: 'bad_path' });
    return sendJson(res, 200, { ticket: mintDlTicket(m.id, fp), ttl: DL_TICKET_TTL });
  }
  // ----- filesystem browse (p4): relay to the bridge, allow-listed params only -----
  if (req.method === 'GET' && p.startsWith('/api/cmux/fs/')) {
    const sub = p.slice('/api/cmux/fs/'.length);
    if (!['roots', 'list', 'read'].includes(sub)) return sendJson(res, 404, { error: 'not_found' });
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    // Re-serialise rather than forwarding the raw query string — the client cannot smuggle
    // extra parameters through to the bridge.
    const qs = new URLSearchParams();
    for (const k of ['path', 'offset', 'limit', 'h', 'hidden']) {
      const v = u.searchParams.get(k);
      if (v != null && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    return relay(res, bridge(m, `/cmux/fs/${sub}${q ? '?' + q : ''}`, { timeout: 20000 }));
  }

  // Source control (p7 Track C). Re-serialised like every other relay, and the POST bodies are
  // rebuilt key by key so nothing the client sends reaches the bridge unexamined.
  if (p.startsWith('/api/cmux/git/')) {
    const sub = p.slice('/api/cmux/git/'.length);
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    if (req.method === 'GET') {
      if (!['repos', 'status', 'branches', 'worktrees', 'diff'].includes(sub)) return sendJson(res, 404, { error: 'not_found' });
      const qs = new URLSearchParams();
      for (const k of ['repo', 'path', 'staged']) {
        const v = u.searchParams.get(k);
        if (v != null && v !== '') qs.set(k, v);
      }
      const q = qs.toString();
      return relay(res, bridge(m, `/cmux/git/${sub}${q ? '?' + q : ''}`, { timeout: 25000 }));
    }
    if (req.method === 'POST' && ['stage', 'unstage', 'command'].includes(sub)) {
      return readBody(req, (b) => {
        if (!b) return sendJson(res, 400, { error: 'bad_json' });
        const body = sub === 'command'
          ? { verb: b.verb, params: b.params || {} }
          : { repo: b.repo, paths: Array.isArray(b.paths) ? b.paths.slice(0, 200) : [] };
        return relay(res, bridge(m, `/cmux/git/${sub}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), timeout: 25000,
        }));
      });
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  // Compose-box completions (p7). Re-serialised, like the fs relay: the client cannot smuggle extra
  // parameters through to the bridge, and the caret text is length-capped on both sides.
  if (req.method === 'GET' && p === '/api/cmux/completions') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const text = u.searchParams.get('text') || '';
    if (text.length > 4096) return sendJson(res, 413, { error: 'text_too_long' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '', text });
    const caret = u.searchParams.get('caret');
    if (caret != null && caret !== '') qs.set('caret', caret);
    return relay(res, bridge(m, `/cmux/completions?${qs.toString()}`, { timeout: 10000 }));
  }

  // Colored grid / text screen for one surface (tab), addressed by surface ref.
  if (req.method === 'GET' && (p === '/api/cmux/grid' || p === '/api/cmux/screen')) {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '' });
    if (p === '/api/cmux/screen' && u.searchParams.get('lines')) qs.set('lines', u.searchParams.get('lines'));
    if (p === '/api/cmux/grid' && u.searchParams.get('h')) qs.set('h', u.searchParams.get('h'));   // conditional poll: unchanged → {same:1}
    return relay(res, bridge(m, `${p.replace('/api/cmux', '/cmux')}?${qs}`));
  }
  // Pane geometry for the multi-pane mirror (one cheap cmux call; hash-deduped like /grid).
  if (req.method === 'GET' && p === '/api/cmux/layout') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ workspace: u.searchParams.get('workspace') || '' });
    if (u.searchParams.get('h')) qs.set('h', u.searchParams.get('h'));
    return relay(res, bridge(m, `/cmux/layout?${qs}`));
  }
  // SSE passthrough. Re-serialised per endpoint — the client cannot smuggle extra params upstream.
  if (req.method === 'GET' && ['/api/cmux/stream', '/api/cmux/grid-stream', '/api/cmux/layout-stream',
    '/api/cmux/panes-stream'].includes(p)) {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) { res.writeHead(404); return res.end(); }
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const keep = p === '/api/cmux/layout-stream' ? ['workspace', 'h']
      : p === '/api/cmux/panes-stream' ? ['surfaces', 'h']
      : p === '/api/cmux/grid-stream' ? ['surface', 'h']
      : ['surface'];
    const q = new URLSearchParams();
    for (const k of keep) { const v = u.searchParams.get(k); if (v) q.set(k, v); }
    const qs = q.toString();
    let up;
    try {
      up = await fetch(`${m.baseUrl}${p.replace('/api/cmux', '/cmux')}?${qs}`, {
        headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m) }, signal: ctrl.signal,
      });
    } catch (_) { res.writeHead(502); return res.end(); }
    if (!up.ok || !up.body) { res.writeHead(up.status || 502); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    try {
      const reader = up.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    } catch (_) { /* client or upstream closed */ }
    try { res.end(); } catch (_) {}
    return;
  }
  if (req.method === 'POST' && p === '/api/cmux/send') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      // This proxy re-serializes an allowlisted body, so any field it does not name is DROPPED.
      // `expect_seq` is a safety precondition, and a silently dropped precondition is worse than a
      // rejected one: the caller believes the send was guarded and it was not. Refuse it loudly
      // instead. The p9 reply route talks to the bridge directly and never comes through here.
      if (Object.prototype.hasOwnProperty.call(b, 'expect_seq')) {
        return sendJson(res, 400, { error: 'expect_seq_unsupported' });
      }
      relay(res, bridge(m, '/cmux/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: b.surface, text: b.text, submit: b.submit }),
      }));
    });
  }
  if (req.method === 'POST' && p === '/api/cmux/key') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/key', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: b.surface, key: b.key }),
      }));
    });
  }
  // "+ Tab" — new tab (surface) inside a workspace.
  if (req.method === 'POST' && p === '/api/cmux/new-surface') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/new-surface', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: b.workspace, pane: b.pane }),
        timeout: 20000,
      }));
    });
  }
  // "+ New workspace".
  if (req.method === 'POST' && p === '/api/cmux/new-workspace') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/new-workspace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: b.cwd || '', command: b.command || '' }),
        timeout: 20000,
      }));
    });
  }
  if (req.method === 'POST' && p === '/api/cmux/close-tab') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/close-tab', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: b.surface }),
        timeout: 20000,
      }));
    });
  }
  // "Close workspace" — remove a whole workspace and its tabs.
  if (req.method === 'POST' && p === '/api/cmux/close-workspace') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/close-workspace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: b.workspace }),
        timeout: 20000,
      }));
    });
  }

  // ----- panes: split / focus / resize (multi-pane mirror) -----
  // The bridge validates every field (pane/surface/workspace shape, direction allow-list, target
  // clamp), so these relay the body straight through like the browser actions do.
  if (req.method === 'POST' && ['/api/cmux/new-pane', '/api/cmux/split-off', '/api/cmux/drop-surface', '/api/cmux/close-pane',
    '/api/cmux/focus-pane', '/api/cmux/focus-surface', '/api/cmux/resize-pane',
    '/api/cmux/equalize'].includes(p)) {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, p.replace('/api/cmux', '/cmux'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
        timeout: 25000,   // a drag converges over several cmux round trips
      }));
    });
  }

  // ----- dropped files: raw body straight through to the bridge -----
  // The only non-JSON POST in the API. The body is a file, so it is buffered (with the same cap the
  // bridge enforces, so an oversized upload dies here rather than crossing the tunnel) and forwarded
  // as-is; the machine comes from the query string because there is no JSON body to carry it.
  if (req.method === 'POST' && p === '/api/cmux/upload') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const cap = Number(process.env.UPLOAD_MAX_BYTES || 32 * 1024 * 1024);
    const chunks = []; let size = 0, dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > cap) { dead = true; sendJson(res, 413, { error: 'too_large', limit: cap }); return req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      relay(res, bridge(m, '/cmux/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream',
          'x-file-name': String(req.headers['x-file-name'] || 'file') },
        body: Buffer.concat(chunks),
        timeout: 60000,
      }));
    });
    return;
  }

  // ----- browser surfaces: mirror + drive a cmux browser tab -----
  // GET info (one-shot url/title/dims).
  if (req.method === 'GET' && p === '/api/cmux/browser/info') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '' });
    return relay(res, bridge(m, `/cmux/browser/info?${qs}`));
  }
  // GET stream — SSE of base64 PNG frames (same passthrough as /api/cmux/stream).
  if (req.method === 'GET' && p === '/api/cmux/browser/stream') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) { res.writeHead(404); return res.end(); }
    const surface = u.searchParams.get('surface') || '';
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    let up;
    try {
      up = await fetch(`${m.baseUrl}/cmux/browser/stream?surface=${encodeURIComponent(surface)}`, {
        headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m) }, signal: ctrl.signal,
      });
    } catch (_) { res.writeHead(502); return res.end(); }
    if (!up.ok || !up.body) { res.writeHead(up.status || 502); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    try {
      const reader = up.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    } catch (_) { /* client or upstream closed */ }
    try { res.end(); } catch (_) {}
    return;
  }
  // POST actions: open / tap / type / key / scroll / nav / zoom — relay the body straight through
  // (bridge validates surface/coords/keys/url; the extra `machine` field is ignored downstream).
  if (req.method === 'POST' && p.startsWith('/api/cmux/browser/')) {
    const sub = p.slice('/api/cmux/browser/'.length);
    if (!['open', 'tap', 'type', 'key', 'scroll', 'nav', 'zoom'].includes(sub)) return sendJson(res, 404, { error: 'not_found' });
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, `/cmux/browser/${sub}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
        timeout: 20000,
      }));
    });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

const httpServer = http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
  if (u.pathname.startsWith('/api/')) return handleApi(req, res, u);
  if (u.pathname === '/' || u.pathname === '/index.html') return serveStatic(req, res, 'index.html');
  if (u.pathname === '/app.js') return serveStatic(req, res, 'app.js');
  // radar.js is served whether or not RADAR_ENABLED is set: the flag governs the API and the
  // collector, and a static file that answers 404 half the time is a confusing way to say "off".
  // With radar disabled the tab simply finds no /api/radar/state and says so.
  if (u.pathname === '/radar.js') return serveStatic(req, res, 'radar.js');
  // p7: this handler is an ALLOW-LIST, not a directory. A new client module without a route here
  // 404s, the defensive load path skips the feature, and it ships dark with its flag reading on.
  if (u.pathname === '/menuparse.js') return serveStatic(req, res, 'menuparse.js');
  if (u.pathname === '/git.js') return serveStatic(req, res, 'git.js');
  // p9 inbox. Served like radar.js — whether or not RADAR_ENABLED is set, because a static file that
  // answers 404 half the time is a confusing way to say "off". With radar disabled the tab simply
  // finds no /api/radar/inbox and says so. There is no fallback route here: without this line the
  // module 404s and the feature ships dark.
  if (u.pathname === '/inbox.js') return serveStatic(req, res, 'inbox.js');
  if (u.pathname === '/sw.js') return serveStatic(req, res, 'sw.js');
  if (u.pathname === '/manifest.webmanifest') return serveStatic(req, res, 'manifest.webmanifest');
  if (u.pathname === '/icon-180.png') return serveStatic(req, res, 'icon-180.png');
  // Vendored client libraries (marked / DOMPurify / highlight.js). The routes above are one line
  // per asset, so a directory needs its own prefix route; serveStatic's PUBLIC_DIR check contains
  // the traversal risk.
  if (u.pathname.startsWith('/vendor/')) return serveStatic(req, res, u.pathname.slice(1));
  res.writeHead(404); res.end('not found');
});

httpServer.listen(PORT, HOST, () => {
  // The BOUND port, not the requested one — they differ when PORT=0 (ephemeral), which is how the
  // tests boot a server without colliding with the real one on :8080.
  const bound = (httpServer.address() && httpServer.address().port) || PORT;
  console.log(`cmux-remote server on http://${HOST}:${bound} with ${MACHINES.length} machine(s)`);
  if (!SERVER_TOKEN) console.log('WARNING: SERVER_TOKEN empty → UI/API open. Set it before exposing outside a trusted LAN.');
});

// Radar's timers go when the process is asked to leave. Installing a signal handler REPLACES the
// default terminate-on-SIGTERM, so this exits explicitly — and it is installed ONLY when radar is
// enabled, so with radar off the process's signal behaviour is byte-for-byte what it always was.
if (radar) {
  const shutdown = () => {
    try { radar.stop(); } catch (_) { /* leaving anyway */ }
    try { httpServer.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
