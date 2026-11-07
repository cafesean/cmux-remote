'use strict';
// D154 (HMX-56) — PASSIVE account limit status: read only what the official claude CLI wrote in its
// own transcripts. No network, no token. Offline fixtures, synthetic names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootServer } = require('./helpers/server-boot');
const usageLib = require('../lib/accounts-usage');
const launches = require('../lib/accounts-launches');

const NOW = Date.parse('2026-11-07T04:00:00Z');
const iso = (t) => new Date(t).toISOString();
const ok = (at) => JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { model: 'claude-opus-4', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
const limited = (at, resetsAt, type = 'seven_day') => JSON.stringify({ type: 'assistant', timestamp: iso(at), isApiErrorMessage: true, error: 'rate_limit',
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 8 at 3pm (Asia/Kuala_Lumpur)" }] },
  quotaLimits: { status: 'rejected', resetsAt, rateLimitType: type } });
const dead = (at) => JSON.stringify({ type: 'assistant', timestamp: iso(at), isApiErrorMessage: true, error: 'authentication_failed', message: { model: '<synthetic>', content: [] } });
const revoked = (at) => JSON.stringify({ type: 'assistant', timestamp: iso(at), isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 401 OAuth token revoked · Please run /login' }] } });
const user = (at) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: 'go' } });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'd154-home-'));
  const write = (cwd, sid, rows) => {
    const d = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, sid + '.jsonl'), rows.join('\n') + '\n');
  };
  return { home, write };
}
const sid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const H = 3600e3;

test('lastEvent: newest relevant assistant row wins; user rows / sidechain / synthetic skipped', () => {
  assert.deepEqual(usageLib.lastEvent([ok(NOW - 2 * H), limited(NOW - H, 1794121200), user(NOW)].join('\n')),
    { kind: 'limited', at: NOW - H, resetAt: 1794121200e3, limit: 'weekly' });
  assert.deepEqual(usageLib.lastEvent([limited(NOW - 2 * H, 1794121200), ok(NOW - H)].join('\n')), { kind: 'ok', at: NOW - H });
  assert.deepEqual(usageLib.lastEvent(dead(NOW)), { kind: 'dead', at: NOW });
  assert.equal(usageLib.lastEvent(limited(NOW, 1, 'five_hour')).limit, 'session');
  assert.equal(usageLib.lastEvent([user(NOW), '{bad json "assistant"'].join('\n')), null);
});

test('usage: per account limited / ok-recently / dead / unknown from launched sessions only', async () => {
  const f = fixture();
  const reset = Math.floor((NOW + 30 * H) / 1000);
  f.write('/w/garda', sid(1), [ok(NOW - 3 * H), limited(NOW - 2 * H, reset)]);
  f.write('/w/jet', sid(2), [ok(NOW - 5 * H)]);
  f.write('/w/jet', sid(3), [ok(NOW - H)]);
  f.write('/w/viky', sid(4), [dead(NOW - H)]);
  f.write('/w/old', sid(5), [limited(NOW - 3 * H, Math.floor((NOW - H) / 1000))]);       // reset passed
  f.write('/w/x', sid(6), [limited(NOW - H, reset)]);                                      // not launched on any account
  f.write('/w/rev', sid(8), [ok(NOW - 3 * H), revoked(NOW - H)]);
  const L = [
    { account: 'garda', pid: 11, cwd: '/w/garda', at: NOW - 4 * H, sessionId: sid(1) },
    { account: 'jet', pid: 12, cwd: '/w/jet', at: NOW - 6 * H, sessionId: sid(2) },
    { account: 'jet', pid: 13, cwd: '/w/jet', at: NOW - 2 * H, sessionId: sid(3) },
    { account: 'viky', pid: 14, cwd: '/w/viky', at: NOW - 2 * H, sessionId: sid(4) },
    { account: 'old', pid: 15, cwd: '/w/old', at: NOW - 4 * H, sessionId: sid(5) },
    { account: 'rev', pid: 17, cwd: '/w/rev', at: NOW - 4 * H, sessionId: sid(8) },
    { account: 'stale', pid: 16, cwd: '/w/x', at: NOW - 9 * 24 * H, sessionId: sid(6) },  // outside the 8-day window
  ];
  const names = ['garda', 'jet', 'none', 'old', 'rev', 'stale', 'viky'];
  const u = usageLib.createUsage({ home: f.home, now: () => NOW, readLaunches: () => L,
    accounts: { list: async () => ({ keychain: 'ok', accounts: names.map((name) => ({ name })) }) },
    transcriptOfPid: async () => { throw new Error('not needed'); } });
  const r = await u.usage();
  const by = Object.fromEntries(r.accounts.map((a) => [a.name, a]));
  assert.deepEqual(by.garda, { name: 'garda', state: 'limited', resetsAt: iso(reset * 1000), lastUsedAt: iso(NOW - 3 * H), limit: 'weekly' });
  assert.deepEqual(by.jet, { name: 'jet', state: 'ok', resetsAt: null, lastUsedAt: iso(NOW - H), limit: null });
  assert.equal(by.viky.state, 'invalid');
  assert.equal(by.rev.state, 'invalid');
  for (const n of ['none', 'old', 'stale']) assert.equal(by[n].state, 'unknown', n);
  for (const a of r.accounts) assert.deepEqual(Object.keys(a).sort(), ['lastUsedAt', 'limit', 'name', 'resetsAt', 'state'], 'no extra fields');
  assert.equal(r.keychain, 'ok');
});

test('usage: a launch without a session id resolves via the live pid; locked -> []; cached 60 s', async () => {
  const f = fixture();
  f.write('/w/a', sid(7), [ok(NOW - H)]);
  let lists = 0, pidCalls = 0, t = NOW;
  const u = usageLib.createUsage({ home: f.home, now: () => t,
    readLaunches: () => [{ account: 'aa', pid: 77, cwd: '/w/a', at: NOW - 2 * H }],
    accounts: { list: async () => { lists++; return { keychain: 'ok', accounts: [{ name: 'aa' }] }; } },
    transcriptOfPid: async (pid) => { pidCalls++; return pid === 77 ? { transcriptPath: path.join(f.home, '.claude', 'projects', '-w-a', sid(7) + '.jsonl') } : null; } });
  assert.equal((await u.usage()).accounts[0].state, 'ok');
  t += usageLib.USAGE_CACHE_MS - 1; await u.usage(); assert.equal(lists, 1, 'cached');
  t += 2; await u.usage(); assert.equal(lists, 2); assert.equal(pidCalls, 1, 'pid resolved once');
  const lk = usageLib.createUsage({ accounts: { list: async () => ({ keychain: 'locked', accounts: [] }) }, readLaunches: () => [] });
  assert.deepEqual(await lk.usage(), { keychain: 'locked', accounts: [] });
});

test('usage module makes no network call and reads no token', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accounts-usage.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'lib', 'accounts-launches.js'), 'utf8');
  for (const bad of ['anthropic.com', 'require(\'https\')', 'require(\'http\')', 'fetch(', 'curl', 'find-generic-password', '-w']) assert.equal(src.includes(bad), false, bad);
});

test('launches: add/read round trip, 0600, invalid rejected, capped', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd154-l-'));
  const file = path.join(d, 'sub', 'l.jsonl');
  launches.add({ account: 'jet', pid: 5, cwd: '/w', at: 1, sessionId: sid(1) }, file);
  assert.throws(() => launches.add({ account: 'BAD', pid: 5, cwd: '/w' }, file));
  assert.throws(() => launches.add({ account: 'jet', pid: 5, cwd: '/w', sessionId: 'x;rm' }, file));
  assert.deepEqual(launches.read(file), [{ account: 'jet', pid: 5, cwd: '/w', at: 1, sessionId: sid(1) }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const big = '/' + 'p'.repeat(1000);
  for (let i = 0; i < 600; i++) launches.add({ account: 'jet', pid: i + 1, cwd: big, at: i }, file);
  const r = launches.read(file);
  assert.ok(r.length <= launches.MAX_LINES && fs.statSync(file).size <= launches.MAX_BYTES + 2000);
  assert.equal(r[r.length - 1].pid, 600);
});

test('server: GET /api/cmux/accounts/usage relays to the bridge; needs auth', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"keychain":"ok","accounts":[]}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: `http://127.0.0.1:${srv.address().port}`, secret: 'sb' }]) } });
  try {
    let r = await fetch(s.base + '/api/cmux/accounts/usage?machine=m1', { headers: { authorization: 'Bearer tok' } });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ['/cmux/accounts/usage']);
    r = await fetch(s.base + '/api/cmux/accounts/usage?machine=m1');
    assert.equal(r.status, 401); assert.equal(seen.length, 1);
  } finally { await s.stop(); await new Promise((c) => srv.close(c)); }
});
