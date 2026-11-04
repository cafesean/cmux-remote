'use strict';
// pairing.js — QR pairing for the native app (p41 B2). The host mints a one-time code (shown as a QR
// by bin/cmux-remote-pair.js), the app trades it once for a DEVICE KEY, and that key then works
// anywhere SERVER_TOKEN does. Many devices, each revocable on its own.
//
// Routes (all dispatched here, before server.js's SERVER_TOKEN gate, because each has its own rule):
//   POST   /api/pair/start          SERVER_TOKEN, or a local-only request  -> { code, expiresAt, qr }
//   POST   /api/pair/claim          no credential: the code is the credential  { code, deviceName } -> { deviceKey }
//   GET    /api/pair/devices        server credential (SERVER_TOKEN or a device key)
//   DELETE /api/pair/devices/:id    same; revokes one device
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
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (_) { cb(null); } });
}

// Loopback peer AND no sign of a proxy. A tunnel (cloudflared, ngrok, Tailscale funnel) connects from
// 127.0.0.1 too, so the peer address alone says nothing; it always adds a forwarding header.
const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
function localOnly(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loopback && !FORWARD_HEADERS.some((h) => req.headers[h] !== undefined);
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

function createPairing({ file = process.env.DEVICES_FILE || DEFAULT_FILE, serverToken = '', publicUrl = '', now = Date.now, log = console } = {}) {
  const codes = new Map();               // code -> expiresAt
  let misses = [];                       // timestamps of recent failed claims
  let devices = load();

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(d.devices) ? d.devices.filter((x) => x && x.id && x.keyHash) : [];
    } catch (e) {
      if (e.code !== 'ENOENT') log.error(`pairing: ${file} unreadable, starting with no devices: ${e.message}`);
      return [];
    }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
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
    devices.push(dev);
    save();
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

  function revoke(id) {
    const i = devices.findIndex((d) => d.id === id);
    if (i < 0) return false;
    devices.splice(i, 1);
    save();
    return true;
  }

  const isServerToken = (req, u) => !!serverToken && presented(req, u).includes(serverToken);
  const credentialOk = (req, u) => !serverToken || isServerToken(req, u) || presented(req, u).some((k) => verifyKey(k));

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host || 'localhost'}`;
  }

  function handle(req, res, u) {
    const p = u.pathname;
    try {
      if (req.method === 'POST' && p === '/api/pair/start') {
        if (!isServerToken(req, u) && !localOnly(req)) {
          // An open server (no SERVER_TOKEN) would otherwise let anyone on the tunnel enrol a device.
          if (!serverToken) return sendJson(res, 403, { error: 'local_only' });
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const { code, expiresAt } = start();
        return sendJson(res, 200, { code, expiresAt, qr: `cmuxremote://pair?u=${encodeURIComponent(baseUrl(req))}&c=${code}` });
      }
      if (req.method === 'POST' && p === '/api/pair/claim') {
        return readBody(req, (b) => {
          if (!b || typeof b.code !== 'string' || !b.code.trim()) return sendJson(res, 400, { error: 'bad_request' });
          const r = claim(b.code, b.deviceName);
          if (r.error === 'rate_limited') return sendJson(res, 429, { error: r.error });
          if (r.error === 'code_expired') return sendJson(res, 410, { error: r.error });
          if (r.error) return sendJson(res, 404, { error: r.error });
          return sendJson(res, 200, { deviceKey: r.deviceKey, id: r.id });
        });
      }
      if (p === '/api/pair/devices' || p.startsWith('/api/pair/devices/')) {
        if (!credentialOk(req, u)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET' && p === '/api/pair/devices') return sendJson(res, 200, { devices: list() });
        const m = /^\/api\/pair\/devices\/([^/]+)$/.exec(p);
        if (req.method === 'DELETE' && m) {
          return revoke(decodeURIComponent(m[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not_found' });
        }
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error(`pairing: ${req.method} ${p} failed: ${(e && e.stack) || e}`);
      if (!res.headersSent) return sendJson(res, 500, { error: 'pairing_error' });
      try { return res.end(); } catch (_) { return undefined; }
    }
  }

  return { handle, start, claim, verifyKey, list, revoke, localOnly, file };
}

module.exports = { createPairing, localOnly, DEFAULT_FILE, CODE_TTL_MS };
