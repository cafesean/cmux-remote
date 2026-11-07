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
    util5h: 0.01, util7d: 0.42, reset5h: R5, reset7d: R7, checkedAt: '2026-11-07T03:00:00.000Z', source: 'cli-statusline' });
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
    for (const a of r.accounts) assert.deepEqual(Object.keys(a).sort(), ['lastUsedAt', 'limit', 'name', 'resetsAt', 'state']);
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
