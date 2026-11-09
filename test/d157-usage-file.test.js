'use strict';
// D157 (HMX-61) — optional per-Mac usage file merged into /cmux/accounts/usage. Offline fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib/accounts-usage');

const NOW = Date.parse('2026-11-07T04:00:00Z');
const R5 = Math.floor((NOW + 2 * 3600e3) / 1000), R7 = Math.floor((NOW + 50 * 3600e3) / 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd157-'));
const put = (name, v) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); return f; };
const mk = (usageFile) => lib.createUsage({ usageFile, now: () => NOW, readLaunches: () => [],
  accounts: { list: async () => ({ keychain: 'ok', accounts: ['mux2', 'gone', 'rej', 'bad'].map((name) => ({ name })) }) } });
const FILE = { updatedAt: '2026-11-07T03:59:00Z', accounts: [
  { name: 'mux2', status: 'allowed', util5h: 0.01, util7d: 42, reset5h: R5, reset7d: R7, checkedAt: '2026-11-07T03:00:00Z', source: 'cli-statusline' },
  { name: 'rej', status: 'rejected', util5h: 1, util7d: 0.5, reset5h: R5, reset7d: R7, checkedAt: '2026-11-07T03:59:00Z', source: 'estimate' },
  { name: 'bad', status: 'invalid' },
  { name: 'ghost', status: 'allowed' } ] };

test('merge: fractions + percent normalised, rejected -> limited, invalid, unknown->ok, extra account ignored', async () => {
  const r = await mk(put('a.json', FILE)).usage();
  const by = Object.fromEntries(r.accounts.map((a) => [a.name, a]));
  assert.equal(r.accounts.length, 4);
  assert.deepEqual(by.mux2, { name: 'mux2', state: 'ok', resetsAt: null, lastUsedAt: null, limit: null,
    util5h: 0.01, util7d: 0.42, reset5h: R5, reset7d: R7, checkedAt: '2026-11-07T03:00:00.000Z', source: 'cli-statusline', room: true });
  assert.equal(by.rej.state, 'limited'); assert.equal(by.rej.resetsAt, new Date(R5 * 1000).toISOString()); assert.equal(by.rej.limit, 'session');
  assert.equal(by.bad.state, 'invalid');
  assert.equal(by.bad.checkedAt, '2026-11-07T03:59:00.000Z', 'falls back to updatedAt');
  assert.equal(by.gone.state, 'unknown'); assert.equal('util5h' in by.gone, false, 'no file row = D154 shape');
});

test('merge: weekly rejection picks reset7d; a passed reset does not claim limited', async () => {
  const f = put('w.json', { accounts: [{ name: 'rej', status: 'rejected', util7d: 1, reset5h: R5, reset7d: R7 }, { name: 'bad', status: 'rejected', reset5h: 1000 }] });
  const by = Object.fromEntries((await mk(f).usage()).accounts.map((a) => [a.name, a]));
  assert.equal(by.rej.limit, 'weekly'); assert.equal(by.rej.resetsAt, new Date(R7 * 1000).toISOString());
  assert.equal(by.bad.state, 'unknown');
});

test('ignored: unset, relative, missing, bad JSON, wrong shape, over the size cap', async () => {
  const big = put('big.json', JSON.stringify({ accounts: [], pad: 'x'.repeat(lib.FILE_MAX_BYTES) }));
  for (const f of [undefined, 'rel.json', path.join(dir, 'nope.json'), put('bad.json', '{nope'), put('shape.json', '{"accounts":1}'), big]) {
    const r = await mk(f).usage();
    assert.equal(r.accounts.length, 4);
    for (const a of r.accounts) assert.deepEqual(Object.keys(a).sort(), ['lastUsedAt', 'limit', 'name', 'resetsAt', 'room', 'state']);
  }
});

test('cache: file re-read only after the 60 s usage cache expires', async () => {
  const f = put('c.json', FILE); let t = NOW;
  const u = lib.createUsage({ usageFile: f, now: () => t, readLaunches: () => [], accounts: { list: async () => ({ keychain: 'ok', accounts: [{ name: 'mux2' }] }) } });
  assert.equal((await u.usage()).accounts[0].util7d, 0.42);
  fs.writeFileSync(f, JSON.stringify({ accounts: [{ name: 'mux2', status: 'allowed', util7d: 0.9 }] }));
  t += lib.USAGE_CACHE_MS - 1; assert.equal((await u.usage()).accounts[0].util7d, 0.42);
  t += 2; assert.equal((await u.usage()).accounts[0].util7d, 0.9);
});

// D175 (HMX-61): the response says WHY there is no 5h / 7d reading, so the app can show it instead of a blank.
test('usageFile: unset / unreadable / no_readings / ok, with updatedAt + count of accounts that have a reading', async () => {
  assert.deepEqual((await mk(undefined).usage()).usageFile, { state: 'unset', updatedAt: null, withData: 0 });
  assert.deepEqual((await mk('rel.json').usage()).usageFile, { state: 'unset', updatedAt: null, withData: 0 });
  for (const f of [path.join(dir, 'nope2.json'), put('bad2.json', '{nope'), put('shape2.json', '{"accounts":1}')]) {
    assert.deepEqual((await mk(f).usage()).usageFile, { state: 'unreadable', updatedAt: null, withData: 0 }, f);
  }
  // the chief-of-staff producer before any status-line sample: every row present, every util null
  const empty = put('empty.json', { updatedAt: '2026-11-08T06:24:12+00:00', accounts: ['mux2', 'rej'].map((name) => ({ name, status: 'unknown', util5h: null, util7d: null, reset5h: null, reset7d: null, checkedAt: null, source: 'cli-statusline' })) });
  const e = await mk(empty).usage();
  assert.deepEqual(e.usageFile, { state: 'no_readings', updatedAt: '2026-11-08T06:24:12.000Z', withData: 0 });
  assert.equal(e.accounts.find((a) => a.name === 'mux2').util5h, null);
  assert.deepEqual((await mk(put('ok.json', FILE)).usage()).usageFile, { state: 'ok', updatedAt: '2026-11-07T03:59:00.000Z', withData: 2 });
});

test('usageFile: keychain locked still says nothing about the file', async () => {
  const u = lib.createUsage({ usageFile: put('l.json', FILE), now: () => NOW, readLaunches: () => [], accounts: { list: async () => ({ keychain: 'locked', accounts: [] }) } });
  assert.deepEqual(await u.usage(), { keychain: 'locked', accounts: [] });
});
