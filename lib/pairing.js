'use strict';
// pairing.js — QR pairing for the native app (p41 B2). The host mints a one-time code (shown as a QR
// by bin/cmux-remote-pair.js), the app trades it once for a DEVICE KEY, and that key then works
// anywhere SERVER_TOKEN does. Many devices, each revocable on its own.
//
// Routes (all dispatched here, before server.js's SERVER_TOKEN gate, because each has its own rule):
//   POST   /api/pair/start          SERVER_TOKEN or a device key; only an OPEN server (no SERVER_TOKEN) accepts
//                                   a local-only request instead  -> { code, expiresAt, qr }
//   POST   /api/pair/claim          no credential: the code is the credential  { code, deviceName } -> { deviceKey }
//   GET    /api/pair/devices        server credential (SERVER_TOKEN or a device key)
//   DELETE /api/pair/devices/:id    same; revokes one device
//   GET    /api/pair/hello          no credential, local-only (D40): harmless facts for the desktop app's probe
//                                   -> { app, version, serverId, localMachine, hasPublicUrl, autoPair }
//
// A device key is 32 random bytes, base64url, shown once. Only its sha256 is stored, with
// { id, deviceName, createdAt, lastSeenAt }, in a 0600 file written atomically.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(os.homedir(), '.config', 'cmux-remote', 'devices.json');
const CODE_TTL_MS = 10 * 60 * 1000;
// No 0/O, 1/I, l: a code is read off a screen and typed if the camera fails.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
// 8 chars of this alphabet is ~39 bits; the throttle is what makes guessing one hopeless.
const CLAIM_MISSES = 10;
const CLAIM_WINDOW_MS = 60 * 1000;
const SEEN_WRITE_MS = 60 * 1000;     // lastSeenAt is persisted at most this often per device
const NAME_MAX = 64;
const ID_RE = /^[0-9a-f]{24}$/;
const PKG_VERSION = (() => { try { return String(require('../package.json').version || ''); } catch (_) { return ''; } })();

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

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

function readBody(req, cb, cap = 16 * 1024) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > cap) req.destroy(); });
  // Parse inside the try, call back outside it: an error thrown by the callback must not be caught
  // here and answered as a second, bogus "bad body" call.
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch (_) { /* null = bad body */ }
    cb(parsed);
  });
}

// A request that really came from this machine's own CLI: loopback peer, no sign of a proxy, a
// loopback Host, and not driven by a web page. Only used on an OPEN server (no SERVER_TOKEN); a server
// with a token always wants it.
//  - A tunnel (cloudflared, ngrok, Tailscale funnel) connects from 127.0.0.1 too, so the peer address
//    alone says nothing; it always adds a forwarding header.
//  - DNS rebinding points a web page's own hostname at 127.0.0.1, so the peer is loopback and nothing is
//    forwarded. The Host then names the attacker's domain, and the browser adds Origin and/or
//    Sec-Fetch-Site, which a CLI never sends.
const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
function localOnly(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  if (!loopback || FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) return false;
  if (req.headers.origin !== undefined) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'none';
}

// The credential a request presents, in the three forms server.js already accepts.
function presented(req, u) {
  const h = req.headers['authorization'] || '';
  return [h.startsWith('Bearer ') ? h.slice(7) : '', req.headers['x-app-token'] || '', u.searchParams.get('token') || ''];
}

function newCode(randomInt) {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// serverId: a random id made once and kept next to devices.json, so the desktop app can tell this is
// the same server it already paired through a tunnel. A missing or corrupt file gets a fresh id; a
// file that cannot be written still leaves a usable id for this run (logged), it just will not persist.
// Read (or made) on first use, not at createPairing(): a server that never answers hello writes nothing.
function loadServerId(idFile, log) {
  try {
    const t = fs.readFileSync(idFile, 'utf8').trim();
    if (ID_RE.test(t)) return t;
    log.error(`pairing: ${idFile} is not a server id, making a new one`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.error(`pairing: ${idFile} unreadable, making a new server id: ${e.message}`);
  }
  const id = crypto.randomBytes(12).toString('hex');
  try { writeAtomic(idFile, `${id}\n`); } catch (e) { log.error(`pairing: could not write ${idFile}, server id will not persist: ${e.message}`); }
  return id;
}

// `write(file, text)` is injectable so a test can make the disk fail.
// `localMachine` (id or () => id) and `autoPair` (bool or () => bool) feed /api/pair/hello; functions
// are read per request, so server.js can hand over values it builds after this module is created.
function createPairing({ file = process.env.DEVICES_FILE || DEFAULT_FILE, idFile, serverToken = '', publicUrl = '', now = Date.now, log = console, write = writeAtomic,
  version = PKG_VERSION, localMachine = null, autoPair = false } = {}) {
  const codes = new Map();               // code -> expiresAt
  let misses = [];                       // timestamps of recent failed claims
  let devices = load();
  let unsaved = false;                   // a revoke that is in memory but not yet on disk
  const serverIdFile = idFile || path.join(path.dirname(file), 'server-id');
  let serverIdCache = '';
  const serverId = () => serverIdCache || (serverIdCache = loadServerId(serverIdFile, log));

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(d.devices) ? d.devices.filter((x) => x && x.id && x.keyHash) : [];
    } catch (e) {
      if (e.code !== 'ENOENT') log.error(`pairing: ${file} unreadable, starting with no devices: ${e.message}`);
      return [];
    }
  }
  // Writes `list` (default: the current devices). Any successful write carries every in-memory change,
  // so it also settles a revoke that failed to persist earlier.
  function save(list = devices) {
    write(file, JSON.stringify({ devices: list }, null, 2));
    unsaved = false;
  }
  function saveQuietly() {
    try { save(); } catch (e) { log.error(`pairing: could not write ${file}: ${e.message}`); }
  }

  const sweep = () => { for (const [c, exp] of codes) if (exp + CODE_TTL_MS <= now()) codes.delete(c); };

  function start() {
    sweep();
    let code;
    do { code = newCode(crypto.randomInt); } while (codes.has(code));
    const expiresAt = now() + CODE_TTL_MS;
    codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  // -> { deviceKey, id } | { error: 'rate_limited' | 'invalid_code' | 'code_expired' }
  function claim(rawCode, deviceName) {
    const t = now();
    misses = misses.filter((m) => m > t - CLAIM_WINDOW_MS);
    if (misses.length >= CLAIM_MISSES) return { error: 'rate_limited' };
    const code = String(rawCode || '').trim().toUpperCase();
    const exp = codes.get(code);
    if (exp === undefined) { misses.push(t); return { error: 'invalid_code' }; }
    codes.delete(code);                                   // single use, whether or not it was still good
    if (exp <= t) { misses.push(t); return { error: 'code_expired' }; }
    const deviceKey = crypto.randomBytes(32).toString('base64url');
    const name = String(deviceName || '').trim().slice(0, NAME_MAX) || 'device';
    const dev = { id: crypto.randomBytes(6).toString('hex'), deviceName: name, keyHash: sha256(deviceKey), createdAt: t, lastSeenAt: t };
    // The device joins memory only once it is on disk: a key the app never received must not be a
    // credential, and the app can retry with the same code.
    try { save([...devices, dev]); } catch (e) {
      codes.set(code, exp);
      log.error(`pairing: could not write ${file}: ${e.message}`);
      return { error: 'storage_failed' };
    }
    devices.push(dev);
    return { deviceKey, id: dev.id };
  }

  // The device behind a key, or null. Never throws: this sits on the auth path of every request.
  function verifyKey(key) {
    if (!key || typeof key !== 'string') return null;
    const h = sha256(key);
    const dev = devices.find((d) => d.keyHash === h);
    if (!dev) return null;
    const t = now();
    if (t - dev.lastSeenAt >= SEEN_WRITE_MS) { dev.lastSeenAt = t; saveQuietly(); }
    return dev;
  }

  const list = () => devices.map(({ id, deviceName, createdAt, lastSeenAt }) => ({ id, deviceName, createdAt, lastSeenAt }));

  // -> true | false (no such device) | 'storage_failed'. The revocation takes effect in memory at once
  // and stays even if the write fails: a key someone asked to kill must not work again because the
  // disk hiccuped. The next successful write (or a retried DELETE) persists it.
  function revoke(id) {
    const i = devices.findIndex((d) => d.id === id);
    if (i < 0) { if (unsaved) saveQuietly(); return false; }     // a retried DELETE settles the held revoke
    devices.splice(i, 1);
    unsaved = true;
    try { save(); } catch (e) {
      log.error(`pairing: could not write ${file}, revoke of ${id} is held in memory: ${e.message}`);
      return 'storage_failed';
    }
    return true;
  }

  const isServerToken = (req, u) => !!serverToken && presented(req, u).includes(serverToken);
  const credentialOk = (req, u) => !serverToken || isServerToken(req, u) || presented(req, u).some((k) => verifyKey(k));

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host || 'localhost'}`;
  }

  function hello() {
    const lm = typeof localMachine === 'function' ? localMachine() : localMachine;
    return { app: 'cmux-remote', version: String(version || ''), serverId: serverId(), localMachine: lm || null,
      hasPublicUrl: !!publicUrl, autoPair: !!(typeof autoPair === 'function' ? autoPair() : autoPair) };
  }

  function handle(req, res, u) {
    const p = u.pathname;
    try {
      if (req.method === 'GET' && p === '/api/pair/hello') {
        // No credential on purpose, so localOnly is the whole gate: it refuses tunnels (forwarding
        // headers) and web pages (Origin / cross-site / non-loopback Host). Never loosened here.
        if (!localOnly(req)) return sendJson(res, 403, { error: 'local_only' });
        return sendJson(res, 200, hello());
      }
      if (req.method === 'POST' && p === '/api/pair/start') {
        // A server with a SERVER_TOKEN always wants a credential (the token or an existing device key):
        // "loopback" proves nothing against DNS rebinding or another local user. The local-only
        // exemption is for an OPEN server, where there is no token to ask for.
        if (serverToken) {
          if (!credentialOk(req, u)) return sendJson(res, 401, { error: 'unauthorized' });
        } else if (!localOnly(req)) {
          return sendJson(res, 403, { error: 'local_only' });
        }
        const { code, expiresAt } = start();
        return sendJson(res, 200, { code, expiresAt, qr: `cmuxremote://pair?u=${encodeURIComponent(baseUrl(req))}&c=${code}` });
      }
      if (req.method === 'POST' && p === '/api/pair/claim') {
        return readBody(req, (b) => {
          try {
            if (!b || typeof b.code !== 'string' || !b.code.trim()) return sendJson(res, 400, { error: 'bad_request' });
            const r = claim(b.code, b.deviceName);
            if (r.error === 'rate_limited') return sendJson(res, 429, { error: r.error });
            if (r.error === 'code_expired') return sendJson(res, 410, { error: r.error });
            if (r.error === 'storage_failed') return sendJson(res, 500, { error: r.error });
            if (r.error) return sendJson(res, 404, { error: r.error });
            return sendJson(res, 200, { deviceKey: r.deviceKey, id: r.id });
          } catch (e) {     // runs on a stream event, outside handle's try: an escape would kill the process
            log.error(`pairing: claim failed: ${(e && e.stack) || e}`);
            if (!res.headersSent) sendJson(res, 500, { error: 'pairing_error' });
          }
        });
      }
      if (p === '/api/pair/devices' || p.startsWith('/api/pair/devices/')) {
        if (!credentialOk(req, u)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET' && p === '/api/pair/devices') return sendJson(res, 200, { devices: list() });
        const m = /^\/api\/pair\/devices\/([^/]+)$/.exec(p);
        if (req.method === 'DELETE' && m) {
          let id;
          try { id = decodeURIComponent(m[1]); } catch (_) { return sendJson(res, 404, { error: 'not_found' }); }
          const r = revoke(id);
          if (r === 'storage_failed') return sendJson(res, 500, { error: r });
          return r ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not_found' });
        }
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error(`pairing: ${req.method} ${p} failed: ${(e && e.stack) || e}`);
      if (!res.headersSent) return sendJson(res, 500, { error: 'pairing_error' });
      try { return res.end(); } catch (_) { return undefined; }
    }
  }

  return { handle, start, claim, verifyKey, list, revoke, localOnly, file, idFile: serverIdFile, hello, get serverId() { return serverId(); } };
}

module.exports = { createPairing, localOnly, DEFAULT_FILE, CODE_TTL_MS };
