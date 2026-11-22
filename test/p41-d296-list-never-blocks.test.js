'use strict';
// p41 D296 — GET /cmux/sessions never waits on a live cmux read once a good snapshot exists:
// a failed or slow rebuild keeps the last good snapshot, an old snapshot answers at once (stale: true),
// and every answer carries snapshotAge (ms since the snapshot was built).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd296-')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TREE = (n) => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:1', ref: 'surface:1', title: 't' + n, type: 'terminal' }] }];

// mode.next: 'ok' | 'fail' (cmux tree read failed -> null) | 'throw' | 'slow' (6 s cmux read)
function routes() {
  const clock = { t: 1000 };
  const mode = { next: 'ok' };
  const builds = { n: 0 };
  const r = createSessionRoutes({
    machineId: 'mac', backend: 'cmux', home: mk(), now: () => clock.t,
    loadTree: async () => {
      builds.n++;
      const m = mode.next;
      if (m === 'slow') { await wait(6000); return TREE(builds.n); }
      if (m === 'fail') return null;
      if (m === 'throw') throw new Error('cmux exploded');
      return TREE(builds.n);
    },
    procSnapshot: async () => ({ table: [], sessions: [] }),
  });
  const get = () => new Promise((resolve) => {
    let code = 0;
    const t0 = Date.now();
    r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve({ code, body: JSON.parse(b), ms: Date.now() - t0 }) }, new URL('http://x/cmux/sessions'));
  });
  return { r, get, clock, mode, builds };
}

test('D296: a failed rebuild keeps the last good snapshot; the next GET answers it at once', async () => {
  const { get, clock, mode, builds } = routes();
  const a = await get();
  assert.equal(a.code, 200);
  assert.equal(a.body.snapshotAge, 0);
  clock.t += 5000;
  mode.next = 'fail';
  await get();                 // starts the rebuild that fails
  await wait(20);
  assert.equal(builds.n, 2);
  mode.next = 'slow';          // cmux now takes 6 s per read
  clock.t += 3000;
  const c = await get();
  assert.ok(c.ms < 300, 'answered in ' + c.ms + ' ms, not after the 6 s cmux read');
  assert.equal(c.code, 200);
  assert.equal(c.body.sessions.length, 1);
  assert.equal(c.body.snapshotAt, 1000);
  assert.equal(c.body.snapshotAge, 8000);
});

test('D296: a rebuild that throws keeps the last good snapshot', async () => {
  const { get, clock, mode } = routes();
  await get();
  clock.t += 5000;
  mode.next = 'throw';
  await get();
  await wait(20);
  const c = await get();
  assert.equal(c.code, 200);
  assert.equal(c.body.snapshotAt, 1000);
});

test('D296: with a cmux read stubbed to take 6 s, a snapshot older than listSnapshotMaxAgeMs answers < 300 ms (stale: true)', async () => {
  const { get, clock, mode, builds } = routes();
  await get();
  clock.t += 301000;
  mode.next = 'slow';
  const a = await get();
  assert.ok(a.ms < 300, 'answered in ' + a.ms + ' ms');
  assert.equal(a.code, 200);
  assert.equal(a.body.snapshotAt, 1000);
  assert.equal(a.body.snapshotAge, 301000);
  assert.equal(a.body.stale, true);
  assert.equal(builds.n, 2, 'one rebuild started behind the answer');
});

test('D296: a build stuck past listBuildStuckMs does not block every later rebuild', async () => {
  const { get, clock, mode, builds } = routes();
  await get();
  clock.t += 5000;
  mode.next = 'slow';
  await get();                 // build 2 starts and hangs (6 s)
  assert.equal(builds.n, 2);
  clock.t += 121000;           // build 2 is now "stuck"
  mode.next = 'ok';
  await get();                 // answers the old snapshot, starts build 3
  await wait(20);
  assert.equal(builds.n, 3);
  const c = await get();
  assert.equal(c.body.snapshotAt, clock.t, 'the newer build answered');
});

test('D296: cold (no good snapshot yet) and the build fails -> 502 as before', async () => {
  const { get, mode } = routes();
  mode.next = 'fail';
  const a = await get();
  assert.equal(a.code, 502);
  mode.next = 'ok';
  const b = await get();
  assert.equal(b.code, 200, 'a 502 is never kept: the next GET builds');
});
