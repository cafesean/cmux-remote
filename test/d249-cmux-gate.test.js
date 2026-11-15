'use strict';
// p41 D249: the shared poll gate — coalesce, cap in-flight, back off on slow/timed-out reads.
const test = require('node:test');
const assert = require('node:assert');
const { createCmuxGate } = require('../lib/cmux-gate');

function fakeClock() { let t = 0; return { now: () => t, add: (ms) => { t += ms; } }; }

test('same key coalesces into one call; every caller gets the result', () => {
  const g = createCmuxGate();
  let starts = 0, finish;
  const got = [];
  const start = (done) => { starts++; finish = done; };
  g.run('replay:A', start, (e, out) => got.push(out));
  g.run('replay:A', start, (e, out) => got.push(out));
  finish(null, 'frame');
  assert.strictEqual(starts, 1);
  assert.deepStrictEqual(got, ['frame', 'frame']);
  assert.strictEqual(g.state().coalesced, 1);
});

test('at most maxInFlight run at once; the rest wait and start in order', () => {
  const g = createCmuxGate({ maxInFlight: 2 });
  const dones = {}, started = [];
  for (const k of ['a', 'b', 'c']) g.run(k, (d) => { started.push(k); dones[k] = d; }, () => {});
  assert.deepStrictEqual(started, ['a', 'b']);
  assert.strictEqual(g.state().queued, 1);
  dones.a(null, '');
  assert.deepStrictEqual(started, ['a', 'b', 'c']);
});

test('full queue fails fast with cmux_busy', async () => {
  const g = createCmuxGate({ maxInFlight: 1, maxQueue: 1 });
  g.run('a', () => {}, () => {});
  g.run('b', () => {}, () => {});
  const err = await new Promise((r) => g.run('c', () => {}, (e) => r(e)));
  assert.strictEqual(err.code, 'cmux_busy');
});

test('slow or timed-out reads double the backoff; fast reads halve it to zero', () => {
  const c = fakeClock();
  const logs = [];
  const g = createCmuxGate({ now: c.now, log: (m) => logs.push(m), slowMs: 1500, firstBackoffMs: 500, maxBackoffMs: 2000 });
  const call = (ms, err = null) => g.run('k', (d) => { c.add(ms); d(err, ''); }, () => {});
  call(2000);                                   // slow
  assert.strictEqual(g.extraDelay(), 500);
  call(10, Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }));   // timeout
  assert.strictEqual(g.extraDelay(), 1000);
  call(3000); call(3000);                       // capped
  assert.strictEqual(g.extraDelay(), 2000);
  call(10); assert.strictEqual(g.extraDelay(), 1000);
  call(10); call(10); call(10); call(10);
  assert.strictEqual(g.extraDelay(), 0);
  assert.ok(logs.some((m) => /backoff ON/.test(m)) && logs.some((m) => /backoff OFF/.test(m)));
});

test('a fast non-zero exit is an answer, not slowness', () => {
  const c = fakeClock();
  const g = createCmuxGate({ now: c.now });
  g.run('k', (d) => { c.add(20); d(Object.assign(new Error('exit 1'), { code: 1 }), '', 'surface not found'); }, () => {});
  assert.strictEqual(g.extraDelay(), 0);
});
