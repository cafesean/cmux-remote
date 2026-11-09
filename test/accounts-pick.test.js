'use strict';
// D228 slice A — lib/accounts-pick.js: room cutoffs, pick order, pool, all-limited soonest.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { room, pick, poolFile, readPool, ROOM_MAX } = require('../lib/accounts-pick');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const S = (iso) => Math.floor(Date.parse(iso) / 1000);
const row = (name, o = {}) => ({ name, state: 'ok', resetsAt: null, lastUsedAt: null, limit: null, util5h: null, util7d: null, reset5h: null, reset7d: null, ...o });

test('room: cutoff 0.90 on 5h and 7d; unknown util and unknown state count as room', () => {
  assert.equal(ROOM_MAX, 0.9);
  assert.equal(room(row('w')), true);
  assert.equal(room(row('w', { state: 'unknown' })), true);
  assert.equal(room(row('w', { util5h: 0.899, util7d: 0.899 })), true);
  assert.equal(room(row('w', { util5h: 0.9 })), false);
  assert.equal(room(row('w', { util7d: 0.9 })), false);
  assert.equal(room(row('w', { state: 'limited' })), false);
  assert.equal(room(row('w', { state: 'invalid' })), false);
  assert.equal(room(null), false);
});

test('order: lowest 7d, then 5h, then oldest lastUsedAt, then fewest live, then name', () => {
  assert.equal(pick([row('aa', { util7d: 0.5 }), row('bb', { util7d: 0.2 })], [], NOW).pick, 'bb');
  assert.equal(pick([row('aa', { util7d: 0.2, util5h: 0.6 }), row('bb', { util7d: 0.2, util5h: 0.1 })], [], NOW).pick, 'bb');
  // known 7d beats unknown 7d
  assert.equal(pick([row('aa'), row('bb', { util7d: 0.8 })], [], NOW).pick, 'bb');
  // LRU tie: never used first, then the oldest
  const lru = [row('aa', { lastUsedAt: '2026-11-09T11:00:00Z' }), row('bb', { lastUsedAt: '2026-11-09T09:00:00Z' })];
  assert.equal(pick(lru, [], NOW).pick, 'bb');
  assert.equal(pick([...lru, row('cc')], [], NOW).pick, 'cc');
  // fewest live, then name
  assert.equal(pick([row('aa'), row('bb')], [{ account: 'aa' }], NOW).pick, 'bb');
  assert.equal(pick([row('bb'), row('aa')], [], NOW).pick, 'aa');
  assert.match(pick([row('aa', { util7d: 0.12, util5h: 0.3 })], [], NOW).why, /7d 12%, 5h 30%/);
});

test('skips accounts without room; `a` and `auto` never win', () => {
  assert.equal(pick([row('a', { util7d: 0 }), row('auto', { util7d: 0 }), row('ww', { util7d: 0.5 })], [], NOW).pick, 'ww');
  assert.equal(pick([row('aa', { util7d: 0.1, state: 'limited' }), row('bb', { util7d: 0.95 }), row('cc', { util7d: 0.6 })], [], NOW).pick, 'cc');
  assert.equal(pick([row('a')], [], NOW).pick, null);
});

test('pool respected when non-empty; empty pool = all', () => {
  const rows = [row('aa', { util7d: 0.1 }), row('bb', { util7d: 0.5 })];
  assert.equal(pick(rows, [], NOW, new Set(['bb'])).pick, 'bb');
  assert.equal(pick(rows, [], NOW, new Set()).pick, 'aa');
  assert.equal(pick(rows, [], NOW, null).pick, 'aa');
  const r = pick(rows, [], NOW, new Set(['zz']));
  assert.equal(r.pick, null); assert.equal(r.soonest, null);
});

test('all limited -> pick null + soonest reset (limited resetsAt, or the util window reset)', () => {
  const r = pick([
    row('aa', { state: 'limited', resetsAt: '2026-11-09T15:10:00Z' }),
    row('bb', { util5h: 0.95, reset5h: S('2026-11-09T13:30:00Z'), util7d: 0.4, reset7d: S('2026-11-12T00:00:00Z') }),
    row('cc', { state: 'invalid' }),
  ], [], NOW);
  assert.equal(r.pick, null);
  assert.equal(r.soonest, '2026-11-09T13:30:00.000Z');
  assert.equal(r.why, 'all at limit');
  // a reset already passed is not "soonest"
  assert.equal(pick([row('aa', { state: 'limited', resetsAt: '2026-11-09T11:00:00Z' })], [], NOW).soonest, null);
});

test('pool file: env override, else next to the chief usage file / COS_DIR, prefix default m', () => {
  assert.equal(poolFile({ HYPERMUX_ACCOUNT_POOL_FILE: '/p/x' }), '/p/x');
  assert.equal(poolFile({ HYPERMUX_ACCOUNT_POOL_FILE: 'rel' }), null);
  assert.equal(poolFile({ HYPERMUX_ACCOUNT_USAGE_FILE: '/c/account-usage.json' }), '/c/ACCOUNT_POOL.m');
  assert.equal(poolFile({ COS_DIR: '/d', COS_MACHINE_PREFIX: 'x', HYPERMUX_ACCOUNT_USAGE_FILE: '/c/u.json' }), '/d/ACCOUNT_POOL.x');
  assert.equal(poolFile({}), null);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const f = path.join(d, 'ACCOUNT_POOL.m');
  assert.equal(readPool(f), null);
  fs.writeFileSync(f, '  \n'); assert.equal(readPool(f), null);
  fs.writeFileSync(f, 'work personal\nb\n'); assert.deepEqual([...readPool(f)].sort(), ['b', 'personal', 'work']);
});
