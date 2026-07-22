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

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || process.env.SERVER_HOST || '127.0.0.1';
const SERVER_TOKEN = process.env['SERVER_TOKEN'] || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

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
    const headers = {
      'content-type': CT[path.extname(fp)] || 'application/octet-stream',
      'cache-control': 'private, max-age=60',
      etag: tag,
    };
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function handleApi(req, res, u) {
  if (!authed(req, u)) return sendJson(res, 401, { error: 'unauthorized' });
  const p = u.pathname;

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
  // Colored grid / text screen for one surface (tab), addressed by surface ref.
  if (req.method === 'GET' && (p === '/api/cmux/grid' || p === '/api/cmux/screen')) {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '' });
    if (p === '/api/cmux/screen' && u.searchParams.get('lines')) qs.set('lines', u.searchParams.get('lines'));
    if (p === '/api/cmux/grid' && u.searchParams.get('h')) qs.set('h', u.searchParams.get('h'));   // conditional poll: unchanged → {same:1}
    return relay(res, bridge(m, `${p.replace('/api/cmux', '/cmux')}?${qs}`));
  }
  if (req.method === 'GET' && (p === '/api/cmux/stream' || p === '/api/cmux/grid-stream')) {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) { res.writeHead(404); return res.end(); }
    const surface = u.searchParams.get('surface') || '';
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    let qs = `surface=${encodeURIComponent(surface)}`;
    if (p === '/api/cmux/grid-stream' && u.searchParams.get('h')) qs += `&h=${encodeURIComponent(u.searchParams.get('h'))}`;
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
        body: JSON.stringify({ workspace: b.workspace }),
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

http.createServer((req, res) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end(); }
  if (u.pathname.startsWith('/api/')) return handleApi(req, res, u);
  if (u.pathname === '/' || u.pathname === '/index.html') return serveStatic(req, res, 'index.html');
  if (u.pathname === '/app.js') return serveStatic(req, res, 'app.js');
  if (u.pathname === '/sw.js') return serveStatic(req, res, 'sw.js');
  if (u.pathname === '/manifest.webmanifest') return serveStatic(req, res, 'manifest.webmanifest');
  if (u.pathname === '/icon-180.png') return serveStatic(req, res, 'icon-180.png');
  res.writeHead(404); res.end('not found');
}).listen(PORT, HOST, () => {
  console.log(`cmux-remote server on http://${HOST}:${PORT} with ${MACHINES.length} machine(s)`);
  if (!SERVER_TOKEN) console.log('WARNING: SERVER_TOKEN empty → UI/API open. Set it before exposing outside a trusted LAN.');
});
