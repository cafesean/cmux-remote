'use strict';
// p41 D206b — server/bridge log lines carry an ISO timestamp (lib/log-ts.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { install, stamp } = require('../lib/log-ts');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

test('stamp prefixes a string first arg and keeps %s formats; non-string gets its own ts arg', () => {
  const now = () => new Date('2026-11-08T12:00:00.000Z');
  assert.deepEqual(stamp(['push: %s', 'x'], now), ['2026-11-08T12:00:00.000Z push: %s', 'x']);
  assert.deepEqual(stamp([{ a: 1 }], now), ['2026-11-08T12:00:00.000Z', { a: 1 }]);
});

test('installed console: a logged line starts with an ISO timestamp (stdout and stderr); LOG_TS=0 is off', () => {
  const lib = path.join(__dirname, '..', 'lib', 'log-ts.js');
  const js = `require(${JSON.stringify(lib)}).install();require(${JSON.stringify(lib)}).install();console.log('hello %s','w');console.error('boom')`;
  const out = execFileSync(process.execPath, ['-e', js + ';'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOG_TS: '' } });
  assert.match(out, new RegExp(ISO.source + 'hello w\\n$'), 'one prefix even after two installs');
  const both = execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e "${js.replace(/"/g, '\\"')}" 2>&1 >/dev/null`], { encoding: 'utf8', env: { ...process.env, LOG_TS: '' } });
  assert.match(both, new RegExp(ISO.source + 'boom\\n$'));
  const off = execFileSync(process.execPath, ['-e', js], { encoding: 'utf8', env: { ...process.env, LOG_TS: '0' } });
  assert.equal(off, 'hello w\n');
});

test('server.js and bridge.js install it before anything logs', () => {
  for (const f of ['server.js', 'bridge.js']) {
    const s = require('fs').readFileSync(path.join(__dirname, '..', f), 'utf8');
    const i = s.indexOf("require('./lib/log-ts').install()");
    assert.ok(i > 0 && i < s.indexOf("require('./loadenv')"), f);
  }
});

test('web push network failure names the cause code and push HOST, never the endpoint path', async () => {
  const crypto = require('crypto');
  const webpush = require('../lib/webpush');
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://push.invalid/SECRETPATH', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const r = await webpush.sendPush(sub, { t: 1 }, { vapid: webpush.generateVapidKeys(), subject: 'mailto:x@example.com', timeout: 5000 });
  assert.equal(r.ok, false); assert.equal(r.status, 0);
  assert.match(r.detail, /^fetch failed \S+ host=push\.invalid$/);
  assert.ok(!r.detail.includes('SECRETPATH'));
});
