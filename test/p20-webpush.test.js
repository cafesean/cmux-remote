'use strict';
// p20: Web Push encryption round-trips as a browser would decrypt it (RFC 8291), the VAPID JWT
// verifies against the advertised public key (RFC 8292), and the alert picker prefers NEEDS YOU.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const webpush = require('../lib/webpush');
const { createAlerts } = require('../lib/alerts');

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// The user-agent side of RFC 8291 §3–4.
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = ua.getPublicKey();
  const ecdhSecret = ua.computeSecret(asPublic);
  const ikm = hkdf(authSecret, ecdhSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(pt[pt.length - 1], 2, 'last-record delimiter');
  return pt.subarray(0, pt.length - 1).toString();
}

test('encrypt round-trips through the browser-side decrypt', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const msg = JSON.stringify({ title: '⛔ NEEDS YOU — m-test', body: 'pick 1' });
  const body = webpush.encrypt(sub, msg);
  assert.strictEqual(body.readUInt32BE(16), 4096);
  assert.strictEqual(decrypt(body, ua, auth), msg);
});

test('VAPID JWT verifies against the advertised public key', () => {
  const jwk = webpush.generateVapidKeys();
  const auth = webpush.vapidAuth(jwk, 'https://web.push.apple.com/abc', 'https://cmux.example');
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m, auth);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.strictEqual(claims.aud, 'https://web.push.apple.com');
  assert.strictEqual(claims.sub, 'https://cmux.example');
  const raw = Buffer.from(m[4], 'base64url');
  assert.strictEqual(raw.length, 65);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('alerts: seeds silently, pushes only new unread, prefers NEEDS YOU per surface', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p20-')), 'push.json');
  let list = [{ id: 'old', title: 'Claude Code', is_read: false, surface_id: 'S1' }];
  const bridge = async () => ({ ok: true, json: async () => ({ notifications: list }) });
  const alerts = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge, file, pollMs: 1e9, log: { error() {}, log() {} } });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const sent = [];
  // stub the network edge: capture payloads instead of POSTing
  require('../lib/webpush').sendPush = async (s, p) => { sent.push(p); return { ok: true, status: 201 }; };
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  assert.ok(alerts.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }, 'https://x'));
  await alerts.tick();                       // seed
  assert.strictEqual(sent.length, 0);
  list = [...list,
    { id: 'a', title: 'Claude Code', subtitle: 'Completed in yobo', body: 'done', is_read: false, surface_id: 'S2', tab_title: 'WORKERS' },
    { id: 'b', title: '⛔ NEEDS YOU — m-x', body: 'Pick 1', is_read: false, surface_id: 'S2', tab_title: 'WORKERS' },
    { id: 'c', title: 'Claude Code', subtitle: 'Completed in ai', body: 'ok', is_read: true, surface_id: 'S3' }];
  await alerts.tick();
  alerts.stop();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, '⛔ NEEDS YOU — m-x');
  assert.strictEqual(sent[0].surface, 'S2');
  assert.strictEqual(sent[0].machine, 'default');
});
