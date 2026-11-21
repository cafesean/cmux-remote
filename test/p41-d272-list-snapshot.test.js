'use strict';
// p41 D272 — the sessions list is a local heartbeat: one build serves every client in the window,
// a stale snapshot answers at once while one rebuild runs, a write drops the snapshot, 0 turns it off.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd272-')));

function routes(opts = {}) {
  const clock = { t: 1000 };
  const builds = { n: 0 };
  const r = createSessionRoutes({
    machineId: 'mini', backend: 'cmux', home: mk(), now: () => clock.t,
    loadTree: async () => {
      builds.n++;
      if (opts.slow) await new Promise((res) => setTimeout(res, 30));
      return [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:1', ref: 'surface:1', title: `t${builds.n}`, type: 'terminal' }] }];
    },
    procSnapshot: async () => ({ table: [], sessions: [] }),
    ...(opts.listSnapshotMs !== undefined ? { listSnapshotMs: opts.listSnapshotMs } : {}),
  });
  const get = () => new Promise((resolve) => {
    let code = 0;
    r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve({ code, body: JSON.parse(b) }) }, new URL('http://x/cmux/sessions'));
  });
  return { r, get, clock, builds };
}

test('D272: many clients in one window share ONE build; answer carries snapshotAt', async () => {
  const { get, builds } = routes();
  const all = await Promise.all([get(), get(), get(), get()]);
  assert.equal(builds.n, 1);
  for (const a of all) { assert.equal(a.code, 200); assert.equal(a.body.snapshotAt, 1000); assert.equal(a.body.sessions.length, 1); }
  await get();
  assert.equal(builds.n, 1, 'a GET inside listSnapshotMs reuses the snapshot');
});

test('D272: an aged snapshot answers at once; one rebuild runs behind it', async () => {
  const { get, clock, builds } = routes({ slow: true });
  await get();
  clock.t += 5000;   // older than listSnapshotMs, younger than listSnapshotMaxAgeMs
  const started = Date.now();
  const a = await get();
  assert.ok(Date.now() - started < 25, 'did not wait for the slow build');
  assert.equal(a.body.snapshotAt, 1000);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(builds.n, 2);
  assert.equal((await get()).body.snapshotAt, 6000);
});

test('D272: a snapshot older than listSnapshotMaxAgeMs is never served', async () => {
  const { get, clock, builds } = routes();
  await get();
  clock.t += 61000;
  const a = await get();
  assert.equal(builds.n, 2);
  assert.equal(a.body.snapshotAt, 62000);
});

test('D272: invalidateList drops the snapshot; the next GET builds fresh', async () => {
  const { r, get, builds } = routes();
  await get();
  r.invalidateList();
  await get();
  assert.equal(builds.n, 2);
});

test('D272: listSnapshotMs 0 builds on every GET (pre-D272 behaviour)', async () => {
  const { get, builds } = routes({ listSnapshotMs: 0 });
  await get(); await get();
  assert.equal(builds.n, 2);
});
