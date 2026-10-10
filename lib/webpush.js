'use strict';
// webpush.js — Web Push with no dependencies (p20 phone alerts).
//
// Two RFCs, both small enough to carry here rather than pull in a package:
//   RFC 8291  message encryption, aes128gcm content coding (one record, no padding)
//   RFC 8292  VAPID — an ES256 JWT that proves the push came from the key the browser subscribed with
//
// The push service (Apple / Google / Mozilla) sees only ciphertext and the endpoint; the payload
// key is derived from the subscriber's p256dh + auth secret, which never leave this server.
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

// ---- VAPID keys -----------------------------------------------------------------------------
// Stored as a private JWK (it carries x/y too), so one object round-trips through JSON.
function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'jwk' });
}

// The uncompressed P-256 point (0x04 || X || Y) that the browser's applicationServerKey expects.
function vapidPublicKey(jwk) {
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

function vapidAuth(jwk, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapidPublicKey(jwk)}`;
}

// ---- RFC 8291 encryption --------------------------------------------------------------------
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

function encrypt(subscription, payload) {
  const uaPublic = unb64u(subscription.keys && subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys && subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad_subscription_keys');

  const as = crypto.createECDH('prime256v1');
  const asPublic = as.generateKeys();
  const ecdhSecret = as.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = padding delimiter of the last (and only) record
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Send one push. Resolves {ok, status, gone} — `gone` (404/410) means the subscription is dead and
// the caller should drop it. Never throws on an HTTP failure; a network error resolves ok:false.
async function sendPush(subscription, payload, { vapid, subject, ttl = 3600, urgency = 'high', timeout = 10000 } = {}) {
  const body = encrypt(subscription, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuth(vapid, subscription.endpoint, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
      signal: ctrl.signal,
    });
    const text = r.ok ? '' : await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410, detail: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, gone: false, detail: (e && e.message) || 'fetch_failed' };
  } finally { clearTimeout(timer); }
}

module.exports = { generateVapidKeys, vapidPublicKey, vapidAuth, encrypt, sendPush };
