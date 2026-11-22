'use strict';
// pairing.js — QR pairing for the native app (p41 B2). The host mints a one-time code (shown as a QR
// by bin/cmux-remote-pair.js), the app trades it once for a DEVICE KEY, and that key then works
// anywhere SERVER_TOKEN does. Many devices, each revocable on its own.
//
// Routes (all dispatched here, before server.js's SERVER_TOKEN gate, because each has its own rule):
//   POST   /api/pair/start          SERVER_TOKEN or a device key with canInvite (D40 W2: the desktop app paired on
//                                   the Mac); only an OPEN server (no SERVER_TOKEN) accepts a local-only request
//                                   instead -> { code, expiresAt, qr }. 403 not_allowed (a key without canInvite),
//                                   409 no_public_address (no PUBLIC_URL and a loopback Host: the phone could not
//                                   reach the link), 429 rate_limited (per credential) | too_many_codes (server-wide)
//   POST   /api/pair/claim          no credential: the code is the credential  { code, deviceName } -> { deviceKey }
//   GET    /api/pair/devices        server credential (SERVER_TOKEN or a device key)
//   DELETE /api/pair/devices/:id    same; revokes one device
//   GET    /api/pair/hello          no credential, local-only (D40): harmless facts for the desktop app's probe
//                                   -> { app, version, serverId, localMachine, hasPublicUrl, autoPair }
//   POST   /api/pair/local          no credential, local-only (D40 W1) { deviceName } -> 202 { requestId, number }
//                                   pops an Allow/Deny dialog on this Mac showing `number`; 409 pending, 429 rate_limited,
//                                   403 local_only | unavailable
//   POST   /api/pair/local/wait     local-only { requestId } -> 200 { deviceKey, id, serverId, localMachine } after the
//                                   Allow click; 403 denied | timeout | unavailable; 404 unknown/used requestId
//
// Local pairing needs a TCP loopback peer. In SERVER_SOCKET mode (p19) the peer is a unix socket with no address,
// localOnly() refuses it, and local pairing is unsupported (403): a shared Mac pairs by QR instead.
// serverId is an identity, never a credential: nothing here trusts a caller because it knows it.
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
// Local pairing (D40 W1): one dialog at a time, a few per window, and a fixed time to click.
const LOCAL_PENDING_MAX = 1;
const LOCAL_ATTEMPTS = 3;
const LOCAL_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_WAIT_MS = 60 * 1000;
const LOCAL_KEEP_MS = 30 * 1000;      // a decided-but-uncollected result is kept this long for a late /wait
const REQ_ID_RE = /^[0-9a-f]{32}$/;
// Invite gate (D40 W2): starts per credential per window, and unclaimed live codes server-wide.
const INVITE_STARTS = 5;
const INVITE_WINDOW_MS = 60 * 1000;
const LIVE_CODES_MAX = 20;
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

// p41 D199 (HMX-86): a local pair request comes from this same Mac (localOnly: loopback peer), but the iOS-on-Mac
// build reports an iPad model ("iPad Pro (12.9-inch) (3rd generation)"), and the dialog read "Device: iPad Pro".
// An iOS hardware label, or none, from loopback is this Mac's own app; any other label (the app's own
// "This Mac (HyprMux app)", a Mac's name) is kept as sent.
const THIS_MAC_LABEL = 'This Mac (HyprMux app)';
const IOS_MODEL_RE = /^(iPad|iPhone|iPod)\b/i;
function thisMacName(deviceName) {
  const n = String(deviceName || '').trim().slice(0, NAME_MAX);
  return !n || n === 'device' || IOS_MODEL_RE.test(n) ? THIS_MAC_LABEL : n;
}

// A request that really came from this machine's own CLI: loopback peer, no sign of a proxy, a
// loopback Host, and not driven by a web page. Only used on an OPEN server (no SERVER_TOKEN); a server
// with a token always wants it.
//  - A tunnel (cloudflared, ngrok, Tailscale funnel) connects from 127.0.0.1 too, so the peer address
//    alone says nothing; it always adds a forwarding header.
//  - DNS rebinding points a web page's own hostname at 127.0.0.1, so the peer is loopback and nothing is
//    forwarded. The Host then names the attacker's domain, and the browser adds Origin and/or
//    Sec-Fetch-Site, which a CLI never sends.
const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'];
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
  version = PKG_VERSION, localMachine = null, autoPair, confirm = null, localWaitMs = LOCAL_WAIT_MS, policy = null } = {}) {
  // p42: plan policy (lib/plan-policy.js), awaited for start, claim and devices*. null = no plan checks.
  const { respond } = require('./plan-policy');
  // A key revoked or replaced closes its open sessions at once (R5).
  const changed = () => { if (policy && policy.recheck) { try { policy.recheck(); } catch (_) {} } };
  // autoPair defaults to "a confirm mechanism exists here". available() is cached by the confirm module, so
  // hello never spawns a process however often it is probed.
  const autoPairNow = () => (autoPair === undefined ? !!(confirm && confirm.available()) : !!(typeof autoPair === 'function' ? autoPair() : autoPair));
  const codes = new Map();               // code -> { exp, by } (by = minting device id | 'token' | 'local')
  const inviteStarts = new Map();        // credential (device id | 'token' | 'local') -> recent start timestamps
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

  const sweep = () => { for (const [c, e] of codes) if (e.exp + CODE_TTL_MS <= now()) codes.delete(c); };

  // -> { code, expiresAt } | { error: 'rate_limited' | 'too_many_codes' }. `by` is the credential: the minting
  // device id, 'token' or 'local'. Only a mint uses up the per-credential budget.
  function start(by = 'token') {
    sweep();
    const t = now();
    const recent = (inviteStarts.get(by) || []).filter((s) => s > t - INVITE_WINDOW_MS);
    inviteStarts.set(by, recent);
    if (recent.length >= INVITE_STARTS) return { error: 'rate_limited' };
    let live = 0;
    for (const e of codes.values()) if (e.exp > t) live++;
    if (live >= LIVE_CODES_MAX) return { error: 'too_many_codes' };
    let code;
    do { code = newCode(crypto.randomInt); } while (codes.has(code));
    const expiresAt = t + CODE_TTL_MS;
    codes.set(code, { exp: expiresAt, by });
    recent.push(t);
    return { code, expiresAt };
  }

  // -> { deviceKey, id } | { error: 'rate_limited' | 'invalid_code' | 'code_expired' }
  // p42: is this code reservable (exists, not expired)? Checked before the awaited policy so a refusal never consumes it.
  function peekCode(rawCode) {
    const e = codes.get(String(rawCode || '').trim().toUpperCase());
    if (e === undefined) return 'invalid_code';
    return e.exp <= now() ? 'code_expired' : null;
  }

  function claim(rawCode, deviceName, extra = {}) {
    const t = now();
    misses = misses.filter((m) => m > t - CLAIM_WINDOW_MS);
    if (misses.length >= CLAIM_MISSES) return { error: 'rate_limited' };
    const code = String(rawCode || '').trim().toUpperCase();
    const entry = codes.get(code);
    if (entry === undefined) { misses.push(t); return { error: 'invalid_code' }; }
    codes.delete(code);                                   // single use, whether or not it was still good
    if (entry.exp <= t) { misses.push(t); return { error: 'code_expired' }; }
    const deviceKey = crypto.randomBytes(32).toString('base64url');
    const name = String(deviceName || '').trim().slice(0, NAME_MAX) || 'device';
    // A device paired by code is never local and never invites (D40 W2): only the Allow click makes an inviter.
    const dev = { id: crypto.randomBytes(6).toString('hex'), deviceName: name, keyHash: sha256(deviceKey), createdAt: t, lastSeenAt: t,
      local: false, canInvite: false, invitedBy: entry.by };
    if (extra.hubDeviceId) Object.assign(dev, { hubDeviceId: String(extra.hubDeviceId), ownerSub: extra.ownerSub || null, ownerEpoch: Number(extra.ownerEpoch) || 0 });
    // p42 T2: one key per hubDeviceId; a new claim for the same id replaces (revokes) the older key.
    const older = dev.hubDeviceId ? devices.filter((d) => d.hubDeviceId === dev.hubDeviceId) : [];
    // The device joins memory only once it is on disk: a key the app never received must not be a
    // credential, and the app can retry with the same code.
    try { save([...devices.filter((d) => !older.includes(d)), dev]); } catch (e) {
      codes.set(code, entry);
      log.error(`pairing: could not write ${file}: ${e.message}`);
      return { error: 'storage_failed' };
    }
    for (const o of older) devices.splice(devices.indexOf(o), 1);
    devices.push(dev);
    if (older.length) changed();
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

  // A device saved before W2 has no flags: it is not local and cannot invite.
  // p42: a bound key also lists hubDeviceId (+ owner), so the Bridge maps a hub device to the local key it revokes.
  const list = () => devices.map(({ id, deviceName, createdAt, lastSeenAt, local, canInvite, invitedBy, hubDeviceId, ownerSub, ownerEpoch }) => ({ id, deviceName, createdAt, lastSeenAt,
    local: local === true, canInvite: canInvite === true, invitedBy: typeof invitedBy === 'string' && invitedBy ? invitedBy : null,
    ...(typeof hubDeviceId === 'string' && hubDeviceId ? { hubDeviceId, ownerSub: ownerSub || null, ownerEpoch: Number(ownerEpoch) || 0 } : {}) }));
  // Credential context for the plan policy.
  const credOf = (req, u) => (isServerToken(req, u) ? { kind: 'server' } : (() => { const d = presentedDevice(req, u); return d ? { kind: 'device', dev: d } : {}; })());

  // -> true | false (no such device) | 'storage_failed'. The revocation takes effect in memory at once
  // and stays even if the write fails: a key someone asked to kill must not work again because the
  // disk hiccuped. The next successful write (or a retried DELETE) persists it.
  function revoke(id) {
    const i = devices.findIndex((d) => d.id === id);
    if (i < 0) { if (unsaved) saveQuietly(); return false; }     // a retried DELETE settles the held revoke
    devices.splice(i, 1);
    unsaved = true;
    changed();
    try { save(); } catch (e) {
      log.error(`pairing: could not write ${file}, revoke of ${id} is held in memory: ${e.message}`);
      return 'storage_failed';
    }
    return true;
  }

  const isServerToken = (req, u) => !!serverToken && presented(req, u).includes(serverToken);
  const credentialOk = (req, u) => !serverToken || isServerToken(req, u) || presented(req, u).some((k) => verifyKey(k));
  // The device behind the first valid key presented, or null.
  const presentedDevice = (req, u) => { for (const k of presented(req, u)) { const d = verifyKey(k); if (d) return d; } return null; };

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host || 'localhost'}`;
  }

  function hello() {
    const lm = typeof localMachine === 'function' ? localMachine() : localMachine;
    return { app: 'cmux-remote', version: String(version || ''), serverId: serverId(), localMachine: lm || null,
      hasPublicUrl: !!publicUrl, autoPair: autoPairNow() };
  }

  // ---- local pairing (D40 W1) ----------------------------------------------------------------------
  // requestId -> { number, deviceName, state: 'pending'|'allow'|'deny'|'timeout'|'unavailable', settle: Promise,
  //               decidedAt, waiting }. The device is minted only when a waiter collects an 'allow', so a key
  //               nobody received is never a credential.
  const localReqs = new Map();
  let localAttempts = [];
  const lmNow = () => { const lm = typeof localMachine === 'function' ? localMachine() : localMachine; return lm || null; };
  function sweepLocal() {
    const t = now();
    for (const [id, r] of localReqs) if (r.state !== 'pending' && r.decidedAt + LOCAL_KEEP_MS <= t) localReqs.delete(id);
  }
  const pendingCount = () => [...localReqs.values()].filter((r) => r.state === 'pending').length;

  // -> { requestId, number } | { error: 'unavailable' | 'pending' | 'rate_limited' }
  // Only reached through localOnly (loopback peer), so the asking app runs on this same Mac (D199).
  function localStart(deviceName) {
    sweepLocal();
    if (!confirm || !confirm.available()) return { error: 'unavailable' };
    if (pendingCount() >= LOCAL_PENDING_MAX) return { error: 'pending' };
    const t = now();
    localAttempts = localAttempts.filter((a) => a > t - LOCAL_WINDOW_MS);
    if (localAttempts.length >= LOCAL_ATTEMPTS) return { error: 'rate_limited' };
    localAttempts.push(t);
    const requestId = crypto.randomBytes(16).toString('hex');
    const number = String(crypto.randomInt(10000)).padStart(4, '0');
    const name = thisMacName(deviceName);
    const r = { number, deviceName: name, state: 'pending', decidedAt: 0, waiting: false };
    let timer;
    // The server's deadline also closes the dialog (W1 review 3): a dialog nobody can still answer must not linger.
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const decide = (a) => {
      if (r.state !== 'pending') return;           // first answer wins; a late click after the cut-off does nothing
      clearTimeout(timer);
      r.state = ['allow', 'deny', 'timeout', 'unavailable'].includes(a) ? a : 'unavailable';
      r.decidedAt = now();
    };
    r.settle = new Promise((resolve) => {
      timer = setTimeout(() => { decide('timeout'); if (ac) ac.abort(); resolve(); }, localWaitMs + 2000);
      if (timer.unref) timer.unref();
      let p;
      try { p = Promise.resolve(confirm.ask({ number, deviceName: name, timeoutMs: localWaitMs, signal: ac ? ac.signal : undefined })); } catch (e) { p = Promise.reject(e); }
      p.then((a) => { decide(a); resolve(); }, (e) => { log.error(`pairing: local confirm failed: ${(e && e.message) || e}`); decide('unavailable'); resolve(); });
    });
    localReqs.set(requestId, r);
    return { requestId, number };
  }

  // Mints the device for an allowed request. -> { deviceKey, id } | { error: 'storage_failed' }
  function mintLocal(r) {
    const t = now();
    const deviceKey = crypto.randomBytes(32).toString('base64url');
    const dev = { id: crypto.randomBytes(6).toString('hex'), deviceName: r.deviceName, keyHash: sha256(deviceKey), createdAt: t, lastSeenAt: t,
      local: true, canInvite: true, invitedBy: 'local' };
    try { save([...devices, dev]); } catch (e) {
      log.error(`pairing: could not write ${file}: ${e.message}`);
      return { error: 'storage_failed' };
    }
    devices.push(dev);
    return { deviceKey, id: dev.id };
  }

  function localWait(req, res, requestId) {
    sweepLocal();
    const r = localReqs.get(requestId);
    if (!r || r.waiting) return sendJson(res, 404, { error: 'not_found' });
    r.waiting = true;
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) gone = true; });
    r.settle.then(() => {
      try {
        if (gone) { r.waiting = false; return; }              // the app went away: keep the result for a retried wait
        if (r.state !== 'allow') { localReqs.delete(requestId); return sendJson(res, 403, { error: r.state === 'deny' ? 'denied' : r.state }); }
        const m = mintLocal(r);
        // A failed save keeps the Allow (W1 review 2): the app retries the wait, not the dialog, and no attempt is spent.
        if (m.error) { r.waiting = false; r.decidedAt = now(); return sendJson(res, 500, { error: m.error }); }
        localReqs.delete(requestId);                           // single use from here
        return sendJson(res, 200, { deviceKey: m.deviceKey, id: m.id, serverId: serverId(), localMachine: lmNow() });
      } catch (e) {
        log.error(`pairing: local wait failed: ${(e && e.stack) || e}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'pairing_error' });
      }
    });
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
      if (req.method === 'POST' && (p === '/api/pair/local' || p === '/api/pair/local/wait')) {
        // No credential on purpose: the Allow click on this Mac's screen is the credential, and localOnly keeps
        // tunnels and web pages from even popping the dialog. Never loosened here.
        if (!localOnly(req)) return sendJson(res, 403, { error: 'local_only' });
        return readBody(req, (b) => {
          try {
            if (!b || typeof b !== 'object') return sendJson(res, 400, { error: 'bad_request' });
            if (p === '/api/pair/local') {
              const r = localStart(typeof b.deviceName === 'string' ? b.deviceName : '');
              if (r.error === 'pending') return sendJson(res, 409, { error: r.error });
              if (r.error === 'rate_limited') return sendJson(res, 429, { error: r.error });
              if (r.error) return sendJson(res, 403, { error: r.error });
              return sendJson(res, 202, r);
            }
            if (typeof b.requestId !== 'string' || !REQ_ID_RE.test(b.requestId)) return sendJson(res, 400, { error: 'bad_request' });
            return localWait(req, res, b.requestId);
          } catch (e) {     // runs on a stream event, outside handle's try
            log.error(`pairing: ${p} failed: ${(e && e.stack) || e}`);
            if (!res.headersSent) sendJson(res, 500, { error: 'pairing_error' });
          }
        });
      }
      if (req.method === 'POST' && p === '/api/pair/start') {
        // A server with a SERVER_TOKEN always wants a credential (the token or an existing device key):
        // "loopback" proves nothing against DNS rebinding or another local user. The local-only
        // exemption is for an OPEN server, where there is no token to ask for.
        // D40 W2: a device key invites only with canInvite === true (the Mac's own app); a phone paired by QR
        // cannot mint codes for more phones. A pre-W2 device has no flag, so it cannot.
        let by;
        if (serverToken) {
          if (isServerToken(req, u)) by = 'token';
          else {
            const dev = presentedDevice(req, u);
            if (!dev) return sendJson(res, 401, { error: 'unauthorized' });
            if (dev.canInvite !== true) return sendJson(res, 403, { error: 'not_allowed' });
            by = dev.id;
          }
        } else if (!localOnly(req)) {
          return sendJson(res, 403, { error: 'local_only' });
        } else by = 'local';
        // With no PUBLIC_URL the link carries the request Host; a loopback one is unreachable from the phone.
        if (!publicUrl && LOOPBACK_HOST.test(String(req.headers.host || ''))) return sendJson(res, 409, { error: 'no_public_address' });
        if (policy) {
          return policy.authorize(req, u, { op: 'start', cred: credOf(req, u), local: localOnly(req) }).then((refusal) => {
            if (refusal) return respond(res, refusal);
            const s2 = start(by);
            if (s2.error) return sendJson(res, 429, { error: s2.error });
            return sendJson(res, 200, { code: s2.code, expiresAt: s2.expiresAt, qr: `cmuxremote://pair?u=${encodeURIComponent(baseUrl(req))}&c=${s2.code}` });
          }).catch((e) => { log.error(`pairing: start failed: ${(e && e.stack) || e}`); respond(res, e, 'pairing_error'); });
        }
        const s = start(by);
        if (s.error) return sendJson(res, 429, { error: s.error });
        const { code, expiresAt } = s;
        return sendJson(res, 200, { code, expiresAt, qr: `cmuxremote://pair?u=${encodeURIComponent(baseUrl(req))}&c=${code}` });
      }
      if (policy && req.method === 'GET' && p === '/api/pair/nonce') return nonceRoute(req, res, u);
      if (policy && req.method === 'POST' && p === '/api/pair/bind') {
        return readBody(req, (b) => { bindRoute(req, res, u, b).catch((e) => { log.error(`pairing: bind failed: ${(e && e.stack) || e}`); respond(res, e, 'pairing_error'); }); });
      }
      if (req.method === 'POST' && p === '/api/pair/claim') {
        return readBody(req, (b) => {
          try {
            if (!b || typeof b.code !== 'string' || !b.code.trim()) return sendJson(res, 400, { error: 'bad_request' });
            if (policy) return policedClaim(req, res, u, b);
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
        if (policy) {
          return policy.authorize(req, u, { op: 'devices', cred: credOf(req, u), local: localOnly(req), keys: list() })
            .then((refusal) => (refusal ? respond(res, refusal) : devicesRoute(req, res, p)))
            .catch((e) => { log.error(`pairing: ${p} failed: ${(e && e.stack) || e}`); respond(res, e, 'pairing_error'); });
        }
        return devicesRoute(req, res, p);
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error(`pairing: ${req.method} ${p} failed: ${(e && e.stack) || e}`);
      if (!res.headersSent) return sendJson(res, 500, { error: 'pairing_error' });
      try { return res.end(); } catch (_) { return undefined; }
    }
  }

  function devicesRoute(req, res, p) {
    if (req.method === 'GET' && p === '/api/pair/devices') return sendJson(res, 200, { devices: list() });
    const m = /^\/api\/pair\/devices\/([^/]+)$/.exec(p);
    if (req.method === 'DELETE' && m) {
      let id;
      try { id = decodeURIComponent(m[1]); } catch (_) { return sendJson(res, 404, { error: 'not_found' }); }
      const r = revoke(id);
      if (r === 'storage_failed') return sendJson(res, 500, { error: r });
      return r ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not_found' });
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  // p42 claim under the plan policy: peek the code (404/410/429 unchanged, never consumed by a refusal), await
  // authorize, then commit synchronously (F re-counts the local key list inside the commit).
  function policedClaim(req, res, u, b) {
    const miss = peekCode(b.code);
    if (miss) { const r = claim(b.code, b.deviceName); return sendClaim(res, r); }
    const hubDeviceId = typeof b.hubDeviceId === 'string' && b.hubDeviceId ? b.hubDeviceId : null;
    return policy.authorize(req, u, { op: 'claim', hubDeviceId, local: localOnly(req) }).then(async (refusal) => {
      if (refusal) return respond(res, refusal);
      if (policy.decide().mode === 'E') {                     // E: identity needs the R4 proof (nonce tied to this code)
        const pr = proofRefusal(await policy.deviceAnswer(hubDeviceId), { ...b, hubDeviceId }, 'code:' + String(b.code).trim().toUpperCase());
        if (pr) return respond(res, pr);
      }
      if (peekCode(b.code)) return sendClaim(res, claim(b.code, b.deviceName));
      if (!policy.claimAllowed(list())) return respond(res, require('./plan-policy').planLimit('devices'));
      const o = hubDeviceId ? policy.owner() : {};
      return sendClaim(res, claim(b.code, b.deviceName, hubDeviceId ? { hubDeviceId, ownerSub: o.ownerSub, ownerEpoch: o.ownerEpoch } : {}));
    }).catch((e) => { log.error(`pairing: claim failed: ${(e && e.stack) || e}`); respond(res, e, 'pairing_error'); });
  }
  // ---- p42 proof (Ed25519) --------------------------------------------------------------------------------
  // GET /api/pair/nonce: tied to the presenting key id (any valid key, bound or not) or to a reservable code
  // (checked, never reserved or consumed). 32 random bytes, 60 s, single use, <= 100 outstanding. Never 402.
  const nonces = new Map();
  const NONCE_TTL_MS = 60 * 1000, NONCE_MAX = 100, PROOF_SLUG = 'hyprmux';
  const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
  function issueNonce(tie) {
    const t = now();
    for (const [k, v] of nonces) if (v.exp <= t) nonces.delete(k);
    if (nonces.size >= NONCE_MAX) return null;
    const nonce = crypto.randomBytes(32).toString('base64url');
    nonces.set(nonce, { exp: t + NONCE_TTL_MS, tie });
    return { nonce, exp: t + NONCE_TTL_MS, bridgeInstallId: policy.installId() };
  }
  // -> true | false. The nonce is spent whatever the outcome.
  function verifyProof({ nonce, signature, hubDeviceId, ownerSub, publicKey, tie }) {
    const n = typeof nonce === 'string' && nonces.get(nonce);
    if (n) nonces.delete(nonce);
    if (!n || n.exp <= now() || n.tie !== tie || typeof signature !== 'string' || typeof publicKey !== 'string') return false;
    try {
      const raw = Buffer.from(publicKey, 'base64url');
      if (raw.length !== 32) return false;
      const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
      const msg = ['hmx-bind-v1', PROOF_SLUG, ownerSub || '', policy.installId(), hubDeviceId, nonce].join('\n');
      return crypto.verify(null, Buffer.from(msg), key, Buffer.from(signature, 'base64url'));
    } catch (_) { return false; }
  }
  const { PolicyRefusal: PR, planLimit: PL } = require('./plan-policy');
  const BUSY = () => new PR(503, { error: 'BUSY', code: 'BUSY' });
  const BAD_PROOF = () => new PR(401, { error: 'bad_proof' });
  // E-mode identity check shared by claim and bind -> null | PolicyRefusal.
  function proofRefusal(a, b, tie) {
    if (!a.fresh) return BUSY();
    if (!a.row) return PL('devices', 'not_in_plan');
    if (a.row.status !== 'active') return PL('devices', 'paused');
    if (!a.row.publicKey) return PL('devices', 'key_required');
    if (!verifyProof({ nonce: b.nonce, signature: b.signature, hubDeviceId: b.hubDeviceId, ownerSub: a.owner.ownerSub, publicKey: a.row.publicKey, tie })) return BAD_PROOF();
    return null;
  }

  function nonceRoute(req, res, u) {
    const dev = presentedDevice(req, u);
    if (dev) return sendJson(res, 200, issueNonce('key:' + dev.id) || { error: 'rate_limited' });
    const code = u.searchParams.get('code');
    if (!code) return sendJson(res, 401, { error: 'unauthorized' });
    const miss = peekCode(code);
    if (miss === 'code_expired') return sendJson(res, 410, { error: miss });
    if (miss) return sendJson(res, 404, { error: miss });
    const n = issueNonce('code:' + String(code).trim().toUpperCase());
    return n ? sendJson(res, 200, n) : sendJson(res, 429, { error: 'rate_limited' });
  }

  // POST /api/pair/bind {hubDeviceId, nonce, signature}: identity for an existing key (bound, unbound or stale-epoch).
  async function bindRoute(req, res, u, b) {
    const dev = presentedDevice(req, u);
    if (!dev) return sendJson(res, 401, { error: 'unauthorized' });
    if (!b || typeof b.hubDeviceId !== 'string' || !b.hubDeviceId) return sendJson(res, 400, { error: 'bad_request' });
    const o0 = policy.owner();
    if (!o0.ownerSub) return sendJson(res, 200, { bound: false });          // D/F owner-null: no-op, no hub call
    const a = await policy.deviceAnswer(b.hubDeviceId);
    if (a.mode === 'D') {                                                    // migration binding: best effort, never 503
      if (!a.fresh || !a.row || a.row.status !== 'active' || !a.row.publicKey) return sendJson(res, 200, { bound: false });
    }
    const refusal = proofRefusal(a, b, 'key:' + dev.id);
    if (refusal) return a.mode === 'D' ? sendJson(res, refusal.status === 401 ? 401 : 200, refusal.status === 401 ? refusal.body : { bound: false }) : respond(res, refusal);
    // Sync commit: owner re-read after the awaited hub work.
    const o = policy.owner();
    if (o.ownerSub !== a.owner.ownerSub || o.ownerEpoch !== a.owner.ownerEpoch) return respond(res, BUSY());
    if (!devices.includes(dev)) return sendJson(res, 401, { error: 'unauthorized' });
    if (dev.hubDeviceId === b.hubDeviceId && dev.ownerSub === o.ownerSub && Number(dev.ownerEpoch) === o.ownerEpoch) return sendJson(res, 200, { bound: true });
    if (dev.hubDeviceId && dev.hubDeviceId !== b.hubDeviceId && dev.ownerSub === o.ownerSub && Number(dev.ownerEpoch) === o.ownerEpoch) return sendJson(res, 409, { error: 'already_bound' });
    const others = devices.filter((d) => d !== dev && d.hubDeviceId === b.hubDeviceId);
    const next = devices.filter((d) => !others.includes(d)).map((d) => (d === dev ? { ...d, hubDeviceId: b.hubDeviceId, ownerSub: o.ownerSub, ownerEpoch: o.ownerEpoch } : d));
    try { save(next); } catch (e) { log.error(`pairing: could not write ${file}: ${e.message}`); return sendJson(res, 500, { error: 'storage_failed' }); }
    Object.assign(dev, { hubDeviceId: b.hubDeviceId, ownerSub: o.ownerSub, ownerEpoch: o.ownerEpoch });
    for (const x of others) devices.splice(devices.indexOf(x), 1);
    changed();
    return sendJson(res, 200, { bound: true });
  }

  function sendClaim(res, r) {
    if (r.error === 'rate_limited') return sendJson(res, 429, { error: r.error });
    if (r.error === 'code_expired') return sendJson(res, 410, { error: r.error });
    if (r.error === 'storage_failed') return sendJson(res, 500, { error: r.error });
    if (r.error) return sendJson(res, 404, { error: r.error });
    return sendJson(res, 200, { deviceKey: r.deviceKey, id: r.id });
  }

  // p42: the stored record for a key id (download-ticket re-check), or null. Never a credential by itself.
  const byId = (id) => devices.find((d) => d.id === id) || null;

  return { handle, start, claim, byId, verifyKey, presentedDevice, list, revoke, localOnly, file, idFile: serverIdFile, hello, get serverId() { return serverId(); } };
}

module.exports = { createPairing, localOnly, thisMacName, THIS_MAC_LABEL, DEFAULT_FILE, CODE_TTL_MS, LOCAL_PENDING_MAX, LOCAL_ATTEMPTS, LOCAL_WINDOW_MS, LOCAL_WAIT_MS,
  INVITE_STARTS, INVITE_WINDOW_MS, LIVE_CODES_MAX };
