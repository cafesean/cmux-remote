#!/usr/bin/env node
// cmux-remote server — serves the web UI and proxies /api/cmux/* to the per-machine bridges.
// Holds the machine registry (from env vars or a gitignored config file). The browser only ever
// receives machine LABELS — bridge URLs, secrets, and any tunnel/Access tokens stay on the server.
// No dependencies — plain `node server.js` (needs Node 18+ for global fetch).
//
// Env (a .env in the CWD is auto-loaded):
//   PORT           default 8080 — the UI/proxy port
//   SERVER_SOCKET  absolute path of a UNIX socket to listen on INSTEAD of a TCP port (p19, shared Macs):
//                  its directory must be 0700 and ours; PORT/HOST/SERVER_HOST are then ignored
//   SERVER_TOKEN   token the browser must present on /api/* (empty = open; trusted LAN only)
//   PUBLIC_URL     the address the native app should pair with (e.g. https://mux.example.test); unset = the request Host
//   DEVICES_FILE   paired-device store, default ~/.config/cmux-remote/devices.json (hashed keys only, 0600)
//   PAIR_LOCAL     'off' disables D40 local pairing (no Allow dialog; /api/pair/local answers 403 unavailable).
//                  Default on for macOS. Unsupported in SERVER_SOCKET mode (a unix peer is never local-only).
//
//   Machine registry (any of these, merged by id — nothing is committed to the repo):
//     CMUX_MACHINE_URL / CMUX_MACHINE_SECRET / CMUX_MACHINE_LABEL      — a single default machine
//       (a baseUrl is http(s)://host:port, or unix:/abs/path/bridge.sock for a bridge on a UNIX socket)
//     CMUX_MACHINE_ACCESS_ID / CMUX_MACHINE_ACCESS_SECRET             — optional Cloudflare Access token
//     CMUX_MACHINES   — JSON array [{id,label,baseUrl,secret,accessIdEnv?,accessSecretEnv?}] (extends/overrides)
//       accessIdEnv / accessSecretEnv are env var NAMES (^[A-Z][A-Z0-9_]{0,63}$) holding the Cloudflare
//       Access service token, e.g. "accessIdEnv":"CMUX_MINI_CF_ACCESS_ID". The name wins over raw
//       accessId/accessSecret (still accepted). Missing var -> no headers + a startup note naming the var.
//     CMUX_CONFIG     — path to a gitignored JSON file { "machines": [ ... ] } (extends/overrides)
const { emptyShadowed } = require('./loadenv');
// p62 S2: HYPERMUX_SECRETS_ON_STDIN=1 -> read the secrets line first, then run main()
// (main() runs once loaded, so every const in it sees them). Unset -> no-op, today's behaviour.
const secretsIn = require('./lib/secrets-stdin');
// D99: the D52 unhandledRejection + D93 uncaughtException guards go in FIRST, before the secrets wait
// and before main() builds anything, so no code path (stdin-secrets mode, a throw during startup, a
// relay that outlives a restart) can run unguarded. Idempotent per process (lib/relay-fail.js).
require('./lib/relay-fail').installProcessGuards();
// D62: the body is main(), not a top-level `return` + self re-require: `bun build --compile` drops a
// top-level return (the body ran before the secrets were read, so auth was open). Same order on node.
if (secretsIn.pending()) secretsIn.loadSecrets({ require: ['SERVER_TOKEN'] }).then(main);
else main();
function main() {
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || process.env.SERVER_HOST || '127.0.0.1';
const SERVER_TOKEN = secretsIn.get('SERVER_TOKEN');
const { safeEqual } = require('./lib/safe-equal');
const { redactTokens } = require('./lib/redact-tokens');
const PUBLIC_DIR = path.join(require('./lib/pkg-root').pkgRoot(), 'public');   // D62: not the baked build path under bun
// p19: SERVER_SOCKET set → listen on that UNIX socket and open NO TCP port, so no other local user
// can bind the endpoint first and collect SERVER_TOKEN from the tunnel. A bad value refuses to start
// here, before anything is bound — never a silent fall back to TCP. Unset = TCP exactly as before.
const unixListen = require('./lib/unix-listen');
// p41: QR pairing. Device keys are an equal credential to SERVER_TOKEN (see authed below).
// D40: /api/pair/hello names the machine on this Mac (unix: socket or loopback http bridge), read per
// request because MACHINES is built below.
// D40 W1: local pairing asks the person at this Mac with an Allow/Deny dialog (lib/confirm-dialog.js).
const confirmDialog = require('./lib/confirm-dialog');
const pairing = require('./lib/pairing').createPairing({ serverToken: SERVER_TOKEN, publicUrl: process.env.PUBLIC_URL || '',
  confirm: String(process.env.PAIR_LOCAL || '').toLowerCase() === 'off' ? confirmDialog.disabledConfirm : confirmDialog.createConfirm(),
  localMachine: () => { const m = MACHINES.find((x) => x.socketPath || loopbackHttp(x.baseUrl)); return m ? m.id : null; } });
const { parseUnixBaseUrl, unixFetch } = require('./lib/unix-fetch');
let SERVER_SOCKET = '';
try { SERVER_SOCKET = unixListen.socketSetting('SERVER_SOCKET', process.env, emptyShadowed); }
catch (e) { console.error(`refusing to start: ${e.code}: ${e.detail}`); process.exit(1); }

// Build the machine registry from env + optional config file. Later sources override earlier by id.
function loadMachines() {
  const byId = new Map();
  if (process.env.CMUX_MACHINE_URL) {
    byId.set('default', {
      id: 'default',
      label: process.env.CMUX_MACHINE_LABEL || 'My Mac',
      baseUrl: process.env.CMUX_MACHINE_URL,
      secret: secretsIn.get('CMUX_MACHINE_SECRET'),
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
  // p19: a `unix:<path>` baseUrl is a bridge on a UNIX socket. Its path gets the same rules as a
  // listener's, and its directory the same 0700/owner/ancestor check, before this server sends the
  // bridge secret there. Any bad one refuses to start — every bad machine is named, not just the first.
  const bad = [];
  const list = [...byId.values()].map((m) => {
    const baseUrl = String(m.baseUrl || '').replace(/\/$/, '');
    let socketPath;
    try { socketPath = parseUnixBaseUrl(baseUrl) || undefined; }
    catch (e) { bad.push(`${e.code}: machine "${m.id}": ${e.detail}`); }
    return { ...m, baseUrl, socketPath };
  });
  if (bad.length) { for (const b of bad) console.error(`refusing to start: ${b}`); process.exit(1); }
  for (const m of list) if (m.socketPath) {
    try { unixListen.prepareSocketDir(path.dirname(m.socketPath)); }
    catch (e) { console.error(`refusing to start: ${e.code}: machine "${m.id}": ${e.detail}`); process.exit(1); }
  }
  return list;
}
const MACHINES = loadMachines();

// p19: socket mode (SERVER_SOCKET set, or any unix: machine) exists because on a shared Mac another
// user can bind a loopback TCP port first. A bridge on THIS Mac still reached over http(s) — a stale
// CMUX_MACHINE_URL=http://127.0.0.1:<port>, or the default machine a mistyped CMUX_CONFIG leaves
// behind — would get BRIDGE_SECRET on exactly such a port, so that refuses to start: the local bridge
// must be unix:. Remote http(s) machines stay allowed; TCP mode is untouched.
const SOCKET_MODE = !!SERVER_SOCKET || MACHINES.some((m) => m.socketPath);
// '' unless baseUrl is http(s) to this Mac (127.0.0.0/8, localhost, ::1, 0.0.0.0); else scheme://host
function loopbackHttp(baseUrl) {
  let u; try { u = new URL(baseUrl); } catch (_) { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const local = h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '0.0.0.0'
    || h === '::1' || h === '::' || /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(h);
  return local ? `${u.protocol}//${u.host}` : '';
}
if (SOCKET_MODE) {
  const tcpLocal = MACHINES.filter((m) => !m.socketPath && loopbackHttp(m.baseUrl));
  for (const m of tcpLocal) {
    console.error(`refusing to start: loopback_tcp_machine: machine "${m.id}": ${loopbackHttp(m.baseUrl)} is a TCP port on this Mac — in socket mode a local bridge must be unix:<socket path>`);
  }
  if (tcpLocal.length) process.exit(1);
}

// ---- radar (p5) -------------------------------------------------------------
// OFF BY DEFAULT, and off means OFF: with RADAR_ENABLED unset, nothing under radar/ is required,
// no timer is installed, no handler is registered, and every /api/radar/* path 404s exactly as it
// did before radar was written. Rollback is `unset RADAR_ENABLED` + restart — there is no second
// switch to find. See README → "Radar (p5)".
//
// The load is inside a try/catch on purpose. Radar is an add-on to a terminal mirror people depend
// on: a broken collector has to degrade to "no radar", never to "no cmux".
//
// p19: radar is TCP-only and is NOT loaded in socket mode. Its reply/dispatch routes send the bridge
// secret to its own bridge URLs, which default to http://127.0.0.1:8799 — exactly the fixed loopback
// endpoint socket mode exists to retire. So with SERVER_SOCKET set or any unix: machine it stays off
// (and /api/radar/* 404s), on either backend.
const RADAR_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.RADAR_ENABLED || '').trim());
let radar = null;
if (RADAR_ENABLED && SOCKET_MODE) {
  console.error('radar: NOT started — radar is TCP-only and this server runs in socket mode (SERVER_SOCKET or a unix: machine); its bridge calls would default to 127.0.0.1:8799');
} else if (RADAR_ENABLED) {
  try {
    radar = require('./radar-server').createRadar();
    radar.start();
    console.log(`radar: enabled — ${radar.paths.dir}`);
  } catch (e) {
    radar = null;
    console.error(`radar: failed to start, continuing WITHOUT it: ${(e && e.message) || e}`);
  }
}
// BUG2: a registry id first (PWA, unchanged); else the bridge machineId the sessions list reports
// (the native app sends session.machine) via the map lib/sessions-proxy.js learns. Callers that can
// miss it await ensureMachine(id) first (readBody / handleApi below).
const findMachine = (id) => (id ? MACHINES.find((m) => m.id === id) || sessionsProxy.lookup(id) : MACHINES[0]) || null;
const ensureMachine = async (id) => { if (id && !MACHINES.some((m) => m.id === id)) await sessionsProxy.ensure(id); };

// Cloudflare Access service-token headers, for machines reached over a named tunnel gated by CF Access.
// Empty accessId/accessSecret → no headers (LAN / quick-tunnel machines).
// A row may name env vars (accessIdEnv / accessSecretEnv) instead of carrying values; lib/cf-access.js
// resolves either form and sends nothing to unix: socket bridges.
const cfAccess = require('./lib/cf-access');
const relayFail = require('./lib/relay-fail');   // p41 D52
const accessHeaders = (m) => cfAccess.accessHeadersFor(m, process.env);

// p19: the one way this file reaches a bridge. http(s): the global fetch, exactly as before.
// unix:<path>: lib/unix-fetch over the socket — Node's fetch cannot dial a UNIX socket.
function upstream(m, pathAndQuery, init) {
  return m.socketPath ? unixFetch(m.socketPath, pathAndQuery, init) : fetch(`${m.baseUrl}${pathAndQuery}`, init);
}

// p41 B1: /api/sessions* pass-through (mounted in handleApi next to the completions relay).
const sessionsProxy = require('./lib/sessions-proxy').createSessionsProxy({ machines: MACHINES, upstream, accessHeaders, findMachine });

// Fetch a bridge endpoint with its secret (+ CF Access token if set) and a hard timeout.
// D52: ONE retry when the connect itself was refused (no byte reached the bridge, so no double send;
// a bridge mid-restart looks exactly like this). Any other failure is not retried. A failure carries
// err.relay = { machine, path, cause, ms, attempts } for relay()'s log line and status choice.
async function bridgeOnce(m, pathAndQuery, opt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeout || 15000);
  try {
    return await upstream(m, pathAndQuery, {
      ...opt,
      headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m), ...(opt.headers || {}) },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}
async function bridge(m, pathAndQuery, opt = {}) {
  const t0 = Date.now();
  let attempts = 1;
  try {
    try { return await bridgeOnce(m, pathAndQuery, opt); } catch (e) {
      const replayable = opt.body == null || typeof opt.body === 'string' || Buffer.isBuffer(opt.body);
      if (!replayable || !relayFail.isConnectRefused(e)) throw e;
      await new Promise((r) => setTimeout(r, relayFail.LIMITS.connectRetryDelayMs));
      attempts = 2;
      return await bridgeOnce(m, pathAndQuery, opt);
    }
  } catch (e) {
    try { e.relay = { machine: m.id, path: pathAndQuery, cause: relayFail.classify(e), ms: Date.now() - t0, attempts }; } catch (_) {}
    throw e;
  }
}

// p20 phone alerts: cmux notifications -> Web Push. On by default; PUSH_ENABLED=0 turns it off.
// A broken state file must not take the terminal mirror down with it.
let alerts = null;
if (!/^(0|false|no|off)$/i.test(String(process.env.PUSH_ENABLED || '').trim())) {
  try {
    alerts = require('./lib/alerts').createAlerts({ machines: MACHINES, bridge,
      isDevice: (id) => pairing.list().some((d) => d.id === id) });   // D96: a revoked device's Expo token is dropped
    alerts.start();
  } catch (e) {
    alerts = null;
    console.error(`push: failed to start, continuing WITHOUT it: ${(e && e.message) || e}`);
  }
}

// p27: each machine's Chrome "Allow remote debugging?" dialog, polled every 8s. A dialog that appears
// pushes a phone alert; the page shows an Allow / Deny banner from /api/cmux/chrome-prompt.
const chromePrompts = new Map();
async function pollChromePrompt(m) {
  try {
    const r = await bridge(m, '/cmux/chrome-prompt', { timeout: 12000 });
    const d = await r.json().catch(() => ({}));
    const was = chromePrompts.get(m.id);
    if (d && d.present) {
      chromePrompts.set(m.id, { present: true, app: d.app || 'Google Chrome', text: String(d.text || '').slice(0, 300), buttons: d.buttons || [], since: (was && was.since) || Date.now() });
      if (!(was && was.present) && alerts) {
        alerts.notify({ title: '🔐 Chrome asks to allow remote debugging', body: (MACHINES.length > 1 ? m.label + ': ' : '') + 'Open cmux-remote to Allow or Deny.', tag: 'chrome-prompt-' + m.id, machine: m.id, surface: null })
          .catch(() => {});
      }
    } else chromePrompts.set(m.id, { present: false, error: d && d.error });
  } catch (_) { /* bridge down: keep the last answer */ }
}
if (process.platform === 'darwin' && process.env.NODE_ENV !== 'test' && !/^(0|false|no|off)$/i.test(String(process.env.CHROME_PROMPT_ENABLED || '').trim())) {
  const t = setInterval(() => { for (const m of MACHINES) pollChromePrompt(m); }, 8000);
  if (t.unref) t.unref();
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'surrogate-control': 'no-store',
  });
  res.end(redactTokens(JSON.stringify(obj)));   // S2r
}

// Pass a bridge JSON response straight through (status + body).
// D52: opt.restarting -> a connect-refused answers 503 bridge_restarting + Retry-After (send only; the
// other routes keep their 502 bridge_unreachable contract).
async function relay(res, upstreamPromise, opt = {}) {
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
    res.end(redactTokens(JSON.stringify(body)));   // S2r
  } catch (e) {
    // D52: say WHY (one structured line, no secret/body/query) and tell a restart apart from a fault.
    const info = (e && e.relay) || { cause: relayFail.classify(e) };
    relayFail.log(info);
    if (opt.restarting && relayFail.isConnectRefused(e)) {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      res.setHeader('retry-after', String(relayFail.LIMITS.retryAfterSec));
      return sendJson(res, 503, { error: 'bridge_restarting', retryAfterMs: relayFail.LIMITS.retryAfterSec * 1000 });
    }
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    sendJson(res, 502, { error: 'bridge_unreachable' });
  }
}

const readBody = require('./lib/read-body').createReadBody({ ensureMachine, sendJson });

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
    up = await upstream(m, `/cmux/fs/download?path=${encodeURIComponent(tk.path)}`,
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
  return safeEqual(bearer, SERVER_TOKEN) || safeEqual(alt, SERVER_TOKEN) || safeEqual(q, SERVER_TOKEN)
    || !!(pairing.verifyKey(bearer) || pairing.verifyKey(alt) || pairing.verifyKey(q));   // p41 device key
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

// p41 S2c: /api/cmux/accounts relay. 503 not_secured with an empty SERVER_TOKEN (the API would be
// open). Setup + delete: lib/accounts-limits.js (10/h per caller, 30/h per machine); `fresh=1` once
// per 3 s per caller, else the bridge's cached list is served. Bodies are relayed raw, 1 KiB cap.
const { createAccountLimits, callerKeyOf } = require('./lib/accounts-limits');
const accountLimits = createAccountLimits();
const ACCOUNT_BODY_MAX = 1024;                 // accountBodyMax
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9]{0,5}$/;
// Keyed on the credential that AUTHENTICATED (authed() accepts any one of three): a junk value in
// another slot must not mint a fresh caller key. Device key -> its device id; SERVER_TOKEN -> one key.
function accountCaller(req, u) {
  const h = req.headers['authorization'] || '';
  const slots = [h.startsWith('Bearer ') ? h.slice(7) : '', req.headers['x-app-token'] || '', u.searchParams.get('token') || ''];
  for (const c of slots) if (c && safeEqual(c, SERVER_TOKEN)) return callerKeyOf('server-token');
  for (const c of slots) { const dev = c && pairing.verifyKey(c); if (dev) return callerKeyOf('device:' + dev.id); }
  return null;
}
function readRaw(req, cap, cb) {
  const chunks = []; let size = 0, over = false;
  req.on('data', (c) => { if (over) return; size += c.length; if (size > cap) { over = true; return; } chunks.push(c); });
  req.on('end', () => cb(over ? null : Buffer.concat(chunks)));
  req.on('error', () => cb(null));
}
function accountsRelay(req, res, u, p) {
  if (!SERVER_TOKEN) return sendJson(res, 503, { error: 'not_secured' });
  const m = findMachine(u.searchParams.get('machine'));
  if (!m) return sendJson(res, 404, { error: 'no_machine' });
  const caller = accountCaller(req, u);
  if (!caller) return sendJson(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET' && p === '/api/cmux/accounts') {
    const fresh = u.searchParams.get('fresh') === '1' && accountLimits.fresh(caller);
    return relay(res, bridge(m, '/cmux/accounts' + (fresh ? '?fresh=1' : ''), { timeout: 20000 }));
  }
  if (req.method === 'POST' && p === '/api/cmux/accounts/setup') {
    return readRaw(req, ACCOUNT_BODY_MAX, (buf) => {
      if (!buf) return sendJson(res, 413, { error: 'too_large' });
      if (!accountLimits.mutation(caller, m.id)) return sendJson(res, 429, { error: 'rate_limited' });
      relay(res, bridge(m, '/cmux/accounts/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: buf, timeout: 30000 }));
    });
  }
  const dm = /^\/api\/cmux\/accounts\/([^/]+)$/.exec(p);
  if (req.method === 'DELETE' && dm) {
    let name = '';
    try { name = decodeURIComponent(dm[1]); } catch (_) { name = ''; }
    if (!ACCOUNT_NAME_RE.test(name) || name === 'a') return sendJson(res, 400, { error: 'bad_name' });
    if (!accountLimits.mutation(caller, m.id)) return sendJson(res, 429, { error: 'rate_limited' });
    return relay(res, bridge(m, '/cmux/accounts/' + name, { method: 'DELETE', timeout: 30000 }));
  }
  return sendJson(res, 404, { error: 'not_found' });
}

async function handleApi(req, res, u) {
  const p = u.pathname;
  // THE ONE ROUTE THAT IS NOT SERVER_TOKEN-GATED, because it is reached by navigation rather than
  // by fetch: it carries its own credential, a ticket minted below for a single path.
  if (req.method === 'GET' && p === '/api/cmux/fs/download') return relayDownload(req, res, u);
  // p41 pairing: each route has its own rule (start: SERVER_TOKEN or local-only; claim: the one-time
  // code is the credential), so it is dispatched before the SERVER_TOKEN gate and checks for itself.
  if (p.startsWith('/api/pair/')) return pairing.handle(req, res, u);
  if (!authed(req, u)) return sendJson(res, 401, { error: 'unauthorized' });
  req.cmuxRes = res;   // lib/read-body.js answers 500 through it if a body handler throws
  // BUG2: GET/query routes carry ?machine=; same bridge-machineId learning as readBody does for bodies.
  if (p.startsWith('/api/cmux/') && !p.startsWith('/api/cmux/fs/download')) {
    const qm = u.searchParams.get('machine');
    if (qm) await ensureMachine(qm).catch(() => {});
  }

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

  // ----- p41 S2c Claude accounts (names only; the token never passes through here) -----
  if (p === '/api/cmux/accounts' || p.startsWith('/api/cmux/accounts/')) return accountsRelay(req, res, u, p);

  // ----- p27 Chrome "Allow remote debugging?" -----
  if (req.method === 'GET' && p === '/api/cmux/chrome-prompt') {
    return sendJson(res, 200, { machines: MACHINES.map((m) => ({ id: m.id, label: m.label, ...(chromePrompts.get(m.id) || { present: false }) })) });
  }
  if (req.method === 'POST' && p === '/api/cmux/chrome-prompt') {
    return readBody(req, async (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      try {
        const r = await bridge(m, '/cmux/chrome-prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: b.action }), timeout: 15000 });
        const d = await r.json().catch(() => ({}));
        chromePrompts.delete(m.id);
        setTimeout(() => pollChromePrompt(m), 800);
        return sendJson(res, r.status, d);
      } catch (_) { return sendJson(res, 502, { error: 'bridge_unreachable' }); }
    });
  }

  // ----- p20 phone alerts -----
  if (p.startsWith('/api/push/')) {
    if (!alerts) return sendJson(res, 404, { error: 'push_disabled' });
    if (req.method === 'GET' && p === '/api/push/key') {
      return sendJson(res, 200, { publicKey: alerts.publicKey(), devices: alerts.count(),
        subscribed: alerts.has(u.searchParams.get('endpoint') || '') });
    }
    if (req.method === 'POST' && (p === '/api/push/subscribe' || p === '/api/push/unsubscribe' || p === '/api/push/test')) {
      return readBody(req, async (b) => {
        if (!b) return sendJson(res, 400, { error: 'bad_json' });
        try {
          if (p === '/api/push/subscribe') {
            return alerts.subscribe(b.subscription, req.headers.origin || '')
              ? sendJson(res, 200, { ok: true, devices: alerts.count() }) : sendJson(res, 400, { error: 'bad_subscription' });
          }
          if (p === '/api/push/unsubscribe') return sendJson(res, 200, { ok: alerts.unsubscribe(String(b.endpoint || '')), devices: alerts.count() });
          const results = await alerts.test(b.endpoint ? String(b.endpoint) : '');
          return sendJson(res, 200, { ok: results.length > 0 && results.every((x) => x.ok), results });
        } catch (e) { return sendJson(res, 500, { error: 'push_error', detail: (e && e.message) || String(e) }); }
      });
    }
    // D96: the native app's Expo push token. Device-key auth (the gate above); the token is tied to the
    // device that registered it, so revoking that device stops its pushes.
    if (p === '/api/push/register' && (req.method === 'POST' || req.method === 'DELETE')) {
      return readBody(req, (b) => {
        if (!b) return sendJson(res, 400, { error: 'bad_json' });
        if (req.method === 'DELETE') {
          return sendJson(res, 200, { ok: alerts.unregisterExpo({ installationId: String(b.installationId || ''), token: String(b.token || '') }), devices: alerts.expoCount() });
        }
        const dev = pairing.presentedDevice(req, u);
        return alerts.registerExpo({ token: b.token, installationId: b.installationId, platform: b.platform, deviceId: dev ? dev.id : null })
          ? sendJson(res, 200, { ok: true, devices: alerts.expoCount() }) : sendJson(res, 400, { error: 'bad_registration' });
      });
    }
    return sendJson(res, 404, { error: 'not_found' });
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
      return sendJson(res, 200, { machines, machine: m.id, workspaces: (d && d.workspaces) || [], error: (d && d.error) || undefined,
        capabilities: (d && d.capabilities) || undefined });
    } catch (_) { return sendJson(res, 200, { machines, machine: m.id, workspaces: [], error: 'bridge_unreachable' }); }
  }
  // p17: every machine's tree in one round trip, for the attention sidebar. The fan-out is parallel
  // and each bridge has its own timeout, so a dead machine costs the others nothing — it comes back
  // as {ok:false, error} in its own slot instead of failing the call. Labels and ids only.
  if (req.method === 'GET' && p === '/api/cmux/fleet') {
    const results = await Promise.allSettled(MACHINES.map(async (m) => {
      // Keep the fleet's bridge budget aligned with /tree. Under cmux contention the bridge can
      // answer after eight seconds; aborting sooner falsely marks a live local machine unreachable.
      const r = await bridge(m, '/cmux/tree', { timeout: 15000 });
      const d = await r.json().catch(() => ({ error: 'bad_upstream' }));
      if (!r.ok || (d && d.error)) {
        return { id: m.id, label: m.label, ok: false, error: (d && d.error) || ('http_' + r.status), workspaces: [] };
      }
      return { id: m.id, label: m.label, ok: true, workspaces: (d && d.workspaces) || [], capabilities: (d && d.capabilities) || undefined };
    }));
    const machines = results.map((x, i) => (x.status === 'fulfilled' ? x.value
      : { id: MACHINES[i].id, label: MACHINES[i].label, ok: false, error: 'bridge_unreachable', workspaces: [] }));
    return sendJson(res, 200, { at: Date.now(), machines });
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

  // Source-control READ routes (p8). A separate block beside the p7 one above, not an edit to it:
  // the p7 block's allowlist and body rebuilds are its CONTRACT, and p7 clients still depend on
  // them. This block states its own — `dir`-keyed reads, a probe whose client disconnect
  // propagates upstream, and a command body carrying `dir`. ('/api/cmux/gitread/x' does not
  // start with '/api/cmux/git/', so the two blocks never shadow each other.)
  if (p.startsWith('/api/cmux/gitread/')) {
    const sub = p.slice('/api/cmux/gitread/'.length);
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    if (req.method === 'GET') {
      if (!['probe', 'status', 'branches', 'worktrees', 'diff'].includes(sub)) return sendJson(res, 404, { error: 'not_found' });
      const qs = new URLSearchParams();
      for (const k of ['dir', 'path', 'staged']) {
        const v = u.searchParams.get(k);
        if (v != null && v !== '') qs.set(k, v);
      }
      const q = qs.toString();
      const pq = `/cmux/gitread/${sub}${q ? '?' + q : ''}`;
      if (sub !== 'probe') return relay(res, bridge(m, pq, { timeout: 25000 }));
      // The probe relay propagates CLIENT DISCONNECT upstream: the bridge's cancellation-aware
      // queue can only unlink an abandoned waiter if the abandonment is observable bridge-side.
      // bridge()'s own controller clobbers a passed signal, so the probe goes through a dedicated
      // fetch whose controller aborts on EITHER the timeout or the caller leaving. Disconnect is
      // observed on `res`, never `req`: since Node 16 a completed bodyless GET fires req 'close'
      // while its response is still pending — only res 'close' with !res.writableEnded means the
      // caller actually left. The timeout is an env seam so the timeout-fired settlement is
      // testable through a real child (default 25000, like every other knob here).
      // The knob is VALIDATED, not merely coerced: `Number('fast')` is NaN, `setTimeout(fn, NaN)`
      // fires on the next tick, and a typo in the env would silently turn every probe into a 502.
      // Anything that is not a positive finite number falls back to the default.
      const knob = Number(process.env.GITREAD_PROBE_TIMEOUT_MS);
      const probeTimeoutMs = Number.isFinite(knob) && knob > 0 ? knob : 25000;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);
      const onResClose = () => { if (!res.writableEnded) ctrl.abort(); };
      res.on('close', onResClose);
      return relay(res, (async () => {
        try {
          return await upstream(m, pq, {
            headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m) },
            signal: ctrl.signal,
          });
        } finally { clearTimeout(timer); res.removeListener('close', onResClose); }
      })());
    }
    if (req.method === 'POST' && sub === 'command') {
      return readBody(req, (b) => {
        if (!b) return sendJson(res, 400, { error: 'bad_json' });
        // Key-by-key rebuild, like every relay here — nothing the client sends reaches the
        // bridge unexamined, and `dir` (not `repo`) is this surface's addressing key.
        const body = { verb: b.verb, dir: b.dir, params: b.params || {} };
        return relay(res, bridge(m, '/cmux/gitread/command', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), timeout: 25000,
        }));
      });
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  // p41 B1: /api/sessions* pass-through to the bridges' /cmux/sessions* (lib/sessions-proxy.js).
  if (await sessionsProxy.handle(req, res, u)) return;

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
  // Deep scrollback for one surface: the rows ABOVE what terminal.replay can carry (capped at 240 by
  // cmux). A pane fetches this once when it attaches, so it never rides the streaming frames.
  if (req.method === 'GET' && p === '/api/cmux/history') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '' });
    if (u.searchParams.get('rows')) qs.set('rows', u.searchParams.get('rows'));
    return relay(res, bridge(m, `/cmux/history?${qs}`, { timeout: 25000 }));
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
      up = await upstream(m, `${p.replace('/api/cmux', '/cmux')}?${qs}`, {
        headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m) }, signal: ctrl.signal,
      });
    } catch (_) { res.writeHead(502); return res.end(); }
    if (!up.ok || !up.body) { res.writeHead(up.status || 502); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    try {
      const reader = up.body.getReader();
      res.on('close', () => { try { reader.cancel().catch(() => {}); } catch (_) {} });   // A18: graceful end / client gone. D52: cancel() of an errored upstream REJECTS; unhandled, it killed the server
      for (;;) { const { done, value } = await reader.read(); if (done || res.writableEnded) break; res.write(Buffer.from(value)); }
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
      }), { restarting: true });
    });
  }
  // p41 A14: answer a Session.choice atomically (the bridge re-reads and refuses a stale pick).
  if (req.method === 'POST' && p === '/api/cmux/choose') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/choose', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: b.surface, choiceId: b.choiceId, index: b.index, label: b.label, answers: b.answers }),
        timeout: Array.isArray(b.answers) ? require('./sessions/choice').LIMITS.askFormRelayTimeoutMs : 20000,   // A17 askForm walks every question with readback
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
      // p41 S2 final: a session on an account only through a secured server (spec §4.2 / §6.1)
      if (b.account != null && b.account !== 'terminal' && !SERVER_TOKEN) return sendJson(res, 503, { error: 'not_secured' });
      relay(res, bridge(m, '/cmux/new-surface', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // p41 S2d: `account` passes through when it is a short string; the bridge validates it
        body: JSON.stringify({ workspace: b.workspace, pane: b.pane, ...(typeof b.account === 'string' && b.account.length <= 16 ? { account: b.account } : {}) }),
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
  // "Rename workspace" — a name of its own, instead of the first tab's title.
  if (req.method === 'POST' && p === '/api/cmux/rename-workspace') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, '/cmux/rename-workspace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: b.workspace, title: b.title }),
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
  if (req.method === 'POST' && ['/api/cmux/new-pane', '/api/cmux/split-off', '/api/cmux/drop-surface', '/api/cmux/move-pane', '/api/cmux/reorder-tab', '/api/cmux/close-pane',
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
  // p41 D67: GET shot — one base64 frame for a polling client (bridge rate-limits + size-caps it).
  if (req.method === 'GET' && p === '/api/cmux/browser/shot') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '' });
    return relay(res, bridge(m, `/cmux/browser/shot?${qs}`, { timeout: 20000 }));
  }
  // p41 D97: no SERVER_TOKEN -> authed() lets everyone in, so the whole-desktop view/control would be
  // open to anyone who reaches this server (tunnel included). Refuse, like the accounts routes.
  if (p.startsWith('/api/cmux/screen/') && !SERVER_TOKEN) return sendJson(res, 503, { error: 'not_secured' });
  // p41 D97: Mac screen — info + one frame (bridge gates on SCREEN_VIEW, rate-limits, size-caps).
  if (req.method === 'GET' && (p === '/api/cmux/screen/info' || p === '/api/cmux/screen/shot')) {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const d = u.searchParams.get('display');
    const qs = new URLSearchParams(d ? { display: d } : {});
    return relay(res, bridge(m, `${p.slice(4)}${d ? '?' + qs : ''}`, { timeout: 20000 }));
  }
  // p41 D97: Mac screen input — body relayed (never logged); bridge gates on SCREEN_CONTROL.
  if (req.method === 'POST' && p.startsWith('/api/cmux/screen/')) {
    const sub = p.slice('/api/cmux/screen/'.length);
    if (!['tap', 'scroll', 'type', 'key'].includes(sub)) return sendJson(res, 404, { error: 'not_found' });
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: 'bad_json' });
      const m = findMachine(b.machine);
      if (!m) return sendJson(res, 404, { error: 'no_machine' });
      relay(res, bridge(m, `/cmux/screen/${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), timeout: 15000 }));
    });
  }
  // GET hits (clickable areas for the desktop hand cursor).
  if (req.method === 'GET' && p === '/api/cmux/browser/hits') {
    const m = findMachine(u.searchParams.get('machine'));
    if (!m) return sendJson(res, 404, { error: 'no_machine' });
    const qs = new URLSearchParams({ surface: u.searchParams.get('surface') || '' });
    return relay(res, bridge(m, `/cmux/browser/hits?${qs}`));
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
      const qs = new URLSearchParams({ surface });
      for (const k of ['vw', 'vh']) { const v = u.searchParams.get(k); if (v && /^\d{1,4}$/.test(v)) qs.set(k, v); }
      up = await upstream(m, `/cmux/browser/stream?${qs}`, {
        headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m) }, signal: ctrl.signal,
      });
    } catch (_) { res.writeHead(502); return res.end(); }
    if (!up.ok || !up.body) { res.writeHead(up.status || 502); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    try {
      const reader = up.body.getReader();
      res.on('close', () => { try { reader.cancel().catch(() => {}); } catch (_) {} });   // A18: graceful end / client gone. D52: cancel() of an errored upstream REJECTS; unhandled, it killed the server
      for (;;) { const { done, value } = await reader.read(); if (done || res.writableEnded) break; res.write(Buffer.from(value)); }
    } catch (_) { /* client or upstream closed */ }
    try { res.end(); } catch (_) {}
    return;
  }
  // POST actions: open / tap / type / key / scroll / nav / zoom — relay the body straight through
  // (bridge validates surface/coords/keys/url; the extra `machine` field is ignored downstream).
  if (req.method === 'POST' && p.startsWith('/api/cmux/browser/')) {
    const sub = p.slice('/api/cmux/browser/'.length);
    if (!['open', 'tap', 'type', 'key', 'scroll', 'nav', 'zoom', 'unhideframe'].includes(sub)) return sendJson(res, 404, { error: 'not_found' });
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
  if (req.url === '/healthz') return graceful.health(res);
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
  // p8. Exactly the failure the note above describes, caught by the browser proof: index.html
  // loads /gitbar.js, this allow-list did not, and the defensive mount in app.js turned the 404
  // into "Files browses with no bar" — silently, with GIT_PANEL_ENABLED reading on.
  if (u.pathname === '/gitbar.js') return serveStatic(req, res, 'gitbar.js');
  // p9 inbox. Served like radar.js — whether or not RADAR_ENABLED is set, because a static file that
  // answers 404 half the time is a confusing way to say "off". With radar disabled the tab simply
  // finds no /api/radar/inbox and says so. There is no fallback route here: without this line the
  // module 404s and the feature ships dark.
  if (u.pathname === '/inbox.js') return serveStatic(req, res, 'inbox.js');
  // p17 sidebar. The third time this allow-list has been the thing that shipped a feature dark, so
  // test/p17-static-routes.test.js now reads index.html and fails if any <script src> has no route
  // here — the note above is a reminder, that test is the control.
  if (u.pathname === '/sidebar.js') return serveStatic(req, res, 'sidebar.js');
  if (u.pathname === '/sw.js') return serveStatic(req, res, 'sw.js');
  if (u.pathname === '/manifest.webmanifest') return serveStatic(req, res, 'manifest.webmanifest');
  if (u.pathname === '/icon-180.png') return serveStatic(req, res, 'icon-180.png');
  // Vendored client libraries (marked / DOMPurify / highlight.js). The routes above are one line
  // per asset, so a directory needs its own prefix route; serveStatic's PUBLIC_DIR check contains
  // the traversal risk.
  if (u.pathname.startsWith('/vendor/')) return serveStatic(req, res, u.pathname.slice(1));
  res.writeHead(404); res.end('not found');
});

// What both listen paths print once the server is reachable.
function afterListen() {
  graceful.markReady();
  // id, label and host only — never the secret. This is the first place a two-Mac setup can be
  // checked: a machine missing here was never parsed out of CMUX_MACHINES / CMUX_CONFIG.
  for (const m of MACHINES) {
    let host = m.baseUrl;
    if (m.socketPath) host = `unix:${m.socketPath}`;
    else try { host = new URL(m.baseUrl).host; } catch (_) { /* print as given */ }
    console.log(`  machine "${m.id}" (${m.label}) → ${host}${cfAccess.statusLabel(m, process.env)}`);
  }
  if (!SERVER_TOKEN) console.log('WARNING: SERVER_TOKEN empty → UI/API open. Set it before exposing outside a trusted LAN.');
}
const graceful = require('./lib/graceful').createGraceful(httpServer);
if (SERVER_SOCKET) {
  // lib/unix-listen.js checks the directory (real path, 0700, ours, safe ancestors), refuses a live
  // socket at the path, removes a stale one, listens, then chmods the socket 0600.
  if (process.env.PORT || process.env.HOST || process.env.SERVER_HOST) console.log('note: SERVER_SOCKET is set — PORT/HOST/SERVER_HOST are ignored; no TCP port is opened');
  unixListen.listenUnix(httpServer, SERVER_SOCKET).then(
    (r) => {
      if (r === 'removed') console.log(`removed stale socket ${SERVER_SOCKET}`);
      console.log(`cmux-remote server on unix:${SERVER_SOCKET} with ${MACHINES.length} machine(s)`);
      afterListen();
    },
    (e) => { console.error(`refusing to start: ${e.code || 'listen_failed'}: ${e.detail || e.message}`); process.exit(1); });
} else {
  httpServer.listen(PORT, HOST, () => {
    // The BOUND port, not the requested one — they differ when PORT=0 (ephemeral), which is how the
    // tests boot a server without colliding with the real one on :8080.
    const bound = (httpServer.address() && httpServer.address().port) || PORT;
    console.log(`cmux-remote server on http://${HOST}:${bound} with ${MACHINES.length} machine(s)`);
    afterListen();
  });
}

// p41 A18: SIGTERM/SIGINT -> every open SSE stream gets `event: restarting`, then a short drain and
// exit. Radar's timers (if enabled) are stopped first.
graceful.install(() => { if (radar) radar.stop(); });
// D52/D93/D99 process guards: installed at the top of this file, before main() (see installProcessGuards).
}
