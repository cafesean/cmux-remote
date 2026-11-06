'use strict';
// D96: native-app push. Expo token register/unregister (device-key gate), batching to the Expo
// Push API (<=100 per POST), DeviceNotRegistered + revoked-device pruning. fetch to exp.host is mocked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAlerts } = require('../lib/alerts');
const expoPush = require('../lib/expo-push');
const { bootServer, call } = require('./helpers/server-boot');

const quiet = { error() {}, log() {} };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd96-')), 'push.json');
const tok = (i) => `ExponentPushToken[tok${i}]`;

// Fake Expo: records each POST body; `verdict(token)` decides the ticket.
function fakeExpo(verdict = () => ({ status: 'ok', id: 'x' })) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    assert.strictEqual(url, expoPush.EXPO_PUSH_URL);
    const msgs = JSON.parse(init.body);
    posts.push(msgs);
    return { ok: true, status: 200, json: async () => ({ data: msgs.map((m) => verdict(m.to)) }) };
  };
  return { posts, fetchImpl };
}

test('expo: register validates, replaces per installation, persists 0600', () => {
  const file = tmpFile();
  const a = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge: async () => ({ ok: false }), file, pollMs: 1e9, log: quiet });
  assert.strictEqual(a.registerExpo({ token: 'not-a-token', installationId: 'i1' }), false);
  assert.strictEqual(a.registerExpo({ token: tok(1), installationId: '' }), false);
  assert.ok(a.registerExpo({ token: tok(1), installationId: 'i1', platform: 'ios' }));
  assert.ok(a.registerExpo({ token: tok(2), installationId: 'i1', platform: 'ios' }));   // rotated token
  a.stop();
  assert.strictEqual(a.expoCount(), 1);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(s.expo.map((x) => x.token), [tok(2)]);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(a.unregisterExpo({ installationId: 'i1' }));
  assert.strictEqual(a.expoCount(), 0);
});

test('expo: sends in batches of <=100 with title/body + session data', async () => {
  const file = tmpFile();
  const { posts, fetchImpl } = fakeExpo();
  const a = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge: async () => ({ ok: false }), file, pollMs: 1e9, log: quiet, fetchImpl });
  // bypass the per-server cap: write the state file directly with 230 tokens
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.expo = Array.from({ length: 230 }, (_, i) => ({ token: tok(i), installationId: `i${i}`, platform: 'ios', deviceId: null }));
  fs.writeFileSync(file, JSON.stringify(s));
  const b = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge: async () => ({ ok: false }), file, pollMs: 1e9, log: quiet, fetchImpl });
  const r = await b.notify({ title: '⛔ NEEDS YOU — x', body: 'Pick 1', tag: 'S2', machine: 'default', surface: 'S2' });
  a.stop(); b.stop();
  assert.deepStrictEqual(posts.map((p) => p.length), [100, 100, 30]);
  assert.strictEqual(r.length, 230);
  assert.ok(r.every((x) => x.ok));
  assert.strictEqual(posts[0][0].title, '⛔ NEEDS YOU — x');
  assert.deepStrictEqual(posts[0][0].data, { machine: 'default', surface: 'S2', tag: 'S2' });
});

test('expo: a new cmux alert reaches Expo tokens even with no Web Push subscriber', async () => {
  const file = tmpFile();
  let list = [{ id: 'old', title: 'Claude Code', is_read: false, surface_id: 'S1' }];
  const bridge = async () => ({ ok: true, json: async () => ({ notifications: list }) });
  const { posts, fetchImpl } = fakeExpo();
  const a = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge, file, pollMs: 1e9, log: quiet, fetchImpl });
  a.registerExpo({ token: tok(1), installationId: 'i1' });   // starts polling (seed tick)
  await a.tick();
  assert.strictEqual(posts.length, 0);
  list = [...list, { id: 'b', title: '⛔ NEEDS YOU — m-x', body: 'Pick 1', is_read: false, surface_id: 'S2' }];
  await a.tick();
  a.stop();
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0][0].data.surface, 'S2');
});

test('expo: DeviceNotRegistered and revoked devices are pruned', async () => {
  const file = tmpFile();
  const { posts, fetchImpl } = fakeExpo((to) => (to === tok(2)
    ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' }));
  const live = new Set(['d1', 'd2']);
  const a = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge: async () => ({ ok: false }), file, pollMs: 1e9, log: quiet,
    fetchImpl, isDevice: (id) => live.has(id) });
  a.registerExpo({ token: tok(1), installationId: 'i1', deviceId: 'd1' });
  a.registerExpo({ token: tok(2), installationId: 'i2', deviceId: 'd2' });
  a.registerExpo({ token: tok(3), installationId: 'i3', deviceId: 'd3' });   // d3 already revoked
  await a.notify({ title: 't', body: 'b', tag: 'x', machine: 'default', surface: null });
  a.stop();
  assert.deepStrictEqual(posts[0].map((m) => m.to), [tok(1), tok(2)]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).expo.map((x) => x.token), [tok(1)]);
});

test('expo: a failed or slow batch is reported, never thrown, tokens kept', async () => {
  const r1 = await expoPush.sendExpo([tok(1)], { title: 't' }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.deepStrictEqual(r1, [{ token: tok(1), ok: false, gone: false, error: 'http_500' }]);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  const r2 = await expoPush.sendExpo([tok(1)], { title: 't' }, { fetchImpl: hang, timeoutMs: 20 });
  assert.strictEqual(r2[0].error, 'timeout');
});

test('route: POST/DELETE /api/push/register needs the server credential', async (t) => {
  const s = await bootServer({ env: { SERVER_TOKEN: 'test-token-d96', MACHINES: '' } });
  t.after(() => s.stop());
  const body = { token: tok(9), platform: 'ios', installationId: 'inst-1' };
  assert.strictEqual((await call(s.base, 'POST', '/api/push/register', { body })).status, 401);
  assert.strictEqual((await call(s.base, 'POST', '/api/push/register', { body, token: 'wrong' })).status, 401);
  const ok = await call(s.base, 'POST', '/api/push/register', { body, token: 'test-token-d96' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json, { ok: true, devices: 1 });
  assert.strictEqual((await call(s.base, 'POST', '/api/push/register', { body: { token: 'nope', installationId: 'x' }, token: 'test-token-d96' })).status, 400);
  const del = await call(s.base, 'DELETE', '/api/push/register', { body: { installationId: 'inst-1' }, token: 'test-token-d96' });
  assert.deepStrictEqual(del.json, { ok: true, devices: 0 });
});

test('D120: only NEEDS YOU pushes; a finished turn stays silent unless pushDone', async () => {
  for (const pushDone of [false, true]) {
    const file = tmpFile();
    let list = [{ id: 'old', title: 'Claude Code', is_read: false, surface_id: 'S1' }];
    const bridge = async () => ({ ok: true, json: async () => ({ notifications: list }) });
    const { posts, fetchImpl } = fakeExpo();
    const a = createAlerts({ machines: [{ id: 'default', label: 'Mac' }], bridge, file, pollMs: 1e9, log: quiet, fetchImpl, pushDone });
    a.registerExpo({ token: tok(1), installationId: 'i1' });
    await a.tick();
    list = [...list,
      { id: 'd', title: 'Completed in /repo', body: 'turn done', is_read: false, surface_id: 'S3' },
      { id: 'n', title: '⛔ NEEDS YOU — m-x', body: 'Pick 1', is_read: false, surface_id: 'S4' }];
    await a.tick();
    a.stop();
    const surfaces = posts.map((p) => p[0].data.surface).sort();
    assert.deepStrictEqual(surfaces, pushDone ? ['S3', 'S4'] : ['S4']);
  }
});
