'use strict';
// p41 E1 — relay/server.js: the push relay.
//
// What is on trial is what the relay REFUSES and what it FORWARDS, so every test drives the real
// HTTP server on an ephemeral port with an injected fetch standing in for Expo — no network.
//   * an unknown serverKey gets nothing, and only the enrolment secret can mint a new one
//   * the Expo message is built from sessionId, kind and title alone — terminal text cannot ride along
//   * the rate limit is per serverKey and slides, it is not a fixed bucket that resets on the minute
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRelay, LIMITS } = require('../relay/server');

async function boot(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-relay-'));
  const dataPath = path.join(dir, 'data.json');
  const calls = [];
  let clock = 1_000_000;
  const fakeFetch = over.fetch || (async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  const server = createRelay({
    dataPath, enrolSecret: 'enrol-s3cret', fetch: fakeFetch,
    now: () => clock, log: () => {}, ...over.opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const enrol = (serverKey = 'key-A', deviceToken = 'ExponentPushToken[aaa]') =>
    post('/v1/register', { serverKey, deviceToken, platform: 'ios' }, { 'x-relay-enrol': 'enrol-s3cret' });
  return {
    base, calls, dataPath, post, enrol,
    tick: (ms) => { clock += ms; },
    close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('GET /healthz answers 200 {ok:true}', async () => {
  const r = await boot();
  try {
    const res = await fetch(r.base + '/healthz');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  } finally { r.close(); }
});

test('refuses unknown serverKey', async () => {
  const r = await boot();
  try {
    const res = await r.post('/v1/push', { serverKey: 'nobody', sessionId: 's1', kind: 'done', title: 't' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(r.calls.length, 0, 'nothing reaches Expo');
  } finally { r.close(); }
});

test('first registration needs the enrolment secret; later calls need only the serverKey', async () => {
  const r = await boot();
  try {
    const body = { serverKey: 'key-A', deviceToken: 'ExponentPushToken[aaa]', platform: 'ios' };
    assert.strictEqual((await r.post('/v1/register', body)).status, 401, 'no secret');
    assert.strictEqual((await r.post('/v1/register', body, { 'x-relay-enrol': 'wrong' })).status, 401, 'wrong secret');
    assert.strictEqual((await r.enrol()).status, 200);
    const second = await r.post('/v1/register', { ...body, deviceToken: 'ExponentPushToken[bbb]', platform: 'android' });
    assert.strictEqual(second.status, 200, 'known key adds a device with no secret');
  } finally { r.close(); }
});

test('an unset RELAY_ENROL_SECRET enrols nobody', async () => {
  const r = await boot({ opts: { enrolSecret: '' } });
  try {
    const res = await r.post('/v1/register', { serverKey: 'k', deviceToken: 't', platform: 'ios' }, { 'x-relay-enrol': '' });
    assert.strictEqual(res.status, 401);
  } finally { r.close(); }
});

test('the store holds sha256(serverKey) and never the raw key', async () => {
  const r = await boot();
  try {
    await r.enrol('key-A');
    const raw = fs.readFileSync(r.dataPath, 'utf8');
    assert.ok(!raw.includes('key-A'), 'raw key absent');
    const hash = require('crypto').createHash('sha256').update('key-A').digest('hex');
    assert.deepStrictEqual(Object.keys(JSON.parse(raw).servers), [hash]);
    assert.strictEqual(JSON.parse(raw).servers[hash].deviceTokens[0].platform, 'ios');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(r.dataPath)), ['data.json'], 'no tmp file left');
  } finally { r.close(); }
});

test('drops body fields beyond the allowed set', async () => {
  const r = await boot();
  try {
    await r.enrol();
    const res = await r.post('/v1/push', {
      serverKey: 'key-A', sessionId: 's1', kind: 'needs-you', title: 'Needs you',
      transcript: 'SECRET TRANSCRIPT', terminalText: 'SECRET TERMINAL', body: 'SECRET BODY', data: { leak: 1 },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(r.calls.length, 1);
    assert.strictEqual(r.calls[0].url, 'https://exp.host/--/api/v2/push/send');
    const wire = r.calls[0].init.body;
    assert.ok(!/SECRET|leak|key-A/.test(wire), 'nothing beyond the allowed fields is forwarded');
    assert.deepStrictEqual(r.calls[0].body, [{
      to: 'ExponentPushToken[aaa]', title: 'Needs you', sound: 'default', data: { sessionId: 's1', kind: 'needs-you' },
    }]);
  } finally { r.close(); }
});

test('truncates title to 120 chars and validates kind', async () => {
  const r = await boot();
  try {
    await r.enrol();
    await r.post('/v1/push', { serverKey: 'key-A', sessionId: 's1', kind: 'custom', title: 'x'.repeat(500) });
    assert.strictEqual(r.calls[0].body[0].title.length, LIMITS.titleMax);
    const bad = await r.post('/v1/push', { serverKey: 'key-A', sessionId: 's1', kind: 'chatter', title: 't' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(r.calls.length, 1);
  } finally { r.close(); }
});

test('rate limit 60 pushes/min per serverKey, sliding window', async () => {
  const r = await boot();
  try {
    await r.enrol('key-A');
    await r.enrol('key-B', 'ExponentPushToken[bbb]');
    const push = (k) => r.post('/v1/push', { serverKey: k, sessionId: 's1', kind: 'done', title: 't' });
    for (let i = 0; i < 60; i++) assert.strictEqual((await push('key-A')).status, 200, `push ${i}`);
    const over = await push('key-A');
    assert.strictEqual(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
    assert.strictEqual((await push('key-B')).status, 200, 'another key is unaffected');
    r.tick(59_000);
    assert.strictEqual((await push('key-A')).status, 429, 'still inside the window');
    r.tick(1_001);
    assert.strictEqual((await push('key-A')).status, 200, 'window slid past the first burst');
    assert.strictEqual(r.calls.length, 60 + 1 + 1, 'the 429s never reached Expo');
  } finally { r.close(); }
});

test('Expo failure returns 502, is not retried, and the fetch carries a timeout signal', async () => {
  let n = 0, signal;
  const r = await boot({ fetch: async (url, init) => { n++; signal = init.signal; return { ok: false, status: 500, json: async () => ({}) }; } });
  try {
    await r.enrol();
    const res = await r.post('/v1/push', { serverKey: 'key-A', sessionId: 's1', kind: 'done', title: 't' });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(n, 1, 'no retry');
    assert.ok(signal instanceof AbortSignal);
  } finally { r.close(); }
});

test('sends the Expo bearer token when configured and prunes DeviceNotRegistered tokens', async () => {
  let auth;
  const r = await boot({
    opts: { expoToken: 'expo-tok' },
    fetch: async (url, init) => {
      auth = init.headers.authorization;
      return { ok: true, status: 200, json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) };
    },
  });
  try {
    await r.enrol();
    await r.post('/v1/push', { serverKey: 'key-A', sessionId: 's1', kind: 'done', title: 't' });
    assert.strictEqual(auth, 'Bearer expo-tok');
    const rec = Object.values(JSON.parse(fs.readFileSync(r.dataPath, 'utf8')).servers)[0];
    assert.deepStrictEqual(rec.deviceTokens, []);
  } finally { r.close(); }
});
