'use strict';
// HMX k110 step 2: the key tap runs only while a local viewer heartbeats; combos fan out to the stream; 3 s auto-off.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createKeyCapture, AUTO_OFF_MS } = require('../lib/key-capture');

function rig() {
  const timers = [];
  const kids = [];
  const kc = createKeyCapture({
    lookup: () => '/fake/hm-key-tap',
    spawn: () => {
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stdin = new PassThrough(); c.killed = false;
      c.kill = () => { c.killed = true; c.emit('exit', 0); }; kids.push(c); return c;
    },
    setTimeout: (f, ms) => { const t = { f, ms, on: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.on = false; },
  });
  const fire = () => { for (const t of timers) if (t.on) { t.on = false; t.f(); } };
  return { kc, kids, fire, timers };
}

test('on starts one helper; its combos reach every stream subscriber', () => {
  const { kc, kids } = rig();
  const got = [];
  kc.subscribe((o) => got.push(o));
  assert.deepStrictEqual(kc.capture(true), { on: true, ready: false });
  kc.capture(true);   // heartbeat: no second helper
  assert.strictEqual(kids.length, 1);
  kids[0].stdout.write('{"kind":"ready"}\n{"kind":"combo","combo":"cmd+tab"}\n');
  assert.deepStrictEqual(got, [{ kind: 'on' }, { kind: 'combo', combo: 'cmd+tab' }]);
  assert.deepStrictEqual(kc.capture(true), { on: true, ready: true });
});

test('no heartbeat for AUTO_OFF_MS = the helper is stopped (never left capturing)', () => {
  const { kc, kids, fire, timers } = rig();
  kc.capture(true);
  assert.strictEqual(timers.at(-1).ms, AUTO_OFF_MS);
  assert.strictEqual(AUTO_OFF_MS, 3000);
  fire();
  assert.strictEqual(kids[0].killed, true);
  assert.strictEqual(kc.state().on, false);
});

test('off stops at once; without Accessibility capture answers need:accessibility', () => {
  const { kc, kids } = rig();
  kc.capture(true);
  assert.deepStrictEqual(kc.capture(false), { on: false });
  assert.strictEqual(kids[0].killed, true);
  kc.capture(true);
  kids[1].stdout.write('{"kind":"error","need":"accessibility"}\n');
  kids[1].emit('exit', 2);
  assert.deepStrictEqual(kc.capture(true), { on: false, need: 'accessibility' });
  assert.strictEqual(kids.length, 2);   // no restart loop
  kc.retry();
  kc.capture(true);
  assert.strictEqual(kids.length, 3);   // an explicit retry tries again
});

test('no helper binary: capture says helper_missing', () => {
  const kc = createKeyCapture({ lookup: () => null, setTimeout: () => ({}), clearTimeout: () => {} });
  assert.deepStrictEqual(kc.capture(true), { on: false, need: 'helper_missing' });
});
