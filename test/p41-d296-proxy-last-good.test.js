'use strict';
// p41 D296 — GET /api/sessions never turns a failed or slow bridge read into an empty list: the machine's
// last good sessions answer, flagged stale: true with snapshotAge, so the app keeps its rows and pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionsProxy } = require('../lib/sessions-proxy.js');

const sess = (mid, n) => Array.from({ length: n }, (_, i) => ({ id: mid + ':surface:' + i, machine: mid, surface: 'surface:' + i, kind: 'claude', title: 't' + i }));

function proxy() {
  const mode = { a: 'ok' };
  const machines = [{ id: 'default', label: 'Mac', secret: 's' }];
  const p = createSessionsProxy({
    machines,
    accessHeaders: () => ({}),
    findMachine: (id) => machines.find((m) => m.id === id) || null,
    upstream: async (m, pq) => {
      if (mode.a === 'fail') return { ok: false, status: 502, json: async () => ({ error: 'cmux_failed' }) };
      if (mode.a === 'throw') throw new Error('ECONNRESET');
      return { ok: true, status: 200, json: async () => ({ machineId: 'mac-a', sessions: sess('mac-a', 5) }) };
    },
  });
  const get = () => new Promise((resolve) => {
    let code = 0;
    p.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve({ code, body: JSON.parse(b) }) }, new URL('http://x/api/sessions'));
  });
  return { get, mode };
}

for (const failure of ['fail', 'throw']) {
  test('D296: good poll (5 sessions) -> ' + failure + ' poll -> the list still has 5, stale', async () => {
    const { get, mode } = proxy();
    const a = await get();
    assert.equal(a.body.sessions.length, 5);
    assert.equal(a.body.machines[0].ok, true);
    mode.a = failure;
    const b = await get();
    assert.equal(b.code, 200);
    assert.equal(b.body.sessions.length, 5, 'last good sessions, not an empty list');
    assert.equal(b.body.machines[0].ok, false);
    assert.equal(b.body.machines[0].stale, true);
    assert.equal(b.body.machines[0].machineId, 'mac-a');
    assert.equal(typeof b.body.machines[0].snapshotAge, 'number');
    mode.a = 'ok';
    const c = await get();
    assert.equal(c.body.machines[0].ok, true);
    assert.equal(c.body.machines[0].stale, undefined);
  });
}

test('D296: never answered -> empty, ok:false, as before', async () => {
  const { get, mode } = proxy();
  mode.a = 'fail';
  const a = await get();
  assert.equal(a.body.sessions.length, 0);
  assert.equal(a.body.machines[0].ok, false);
  assert.equal(a.body.machines[0].stale, undefined);
});
