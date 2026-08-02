'use strict';
// p6 S-003 — the nesting regression, ISOLATED IN ITS OWN FILE ON PURPOSE.
//
// Proving the deadlock wedges store.js's module-level promise chain permanently: every later
// store call in the same process hangs. That is exactly what the bullet asserts, so the assertion
// cannot share a process with any other store test. node --test runs each FILE in its own process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../radar/store.js');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-nest-'));

test('S-003: NESTING REGRESSION — unqueued completes inside a slot, queued deadlocks', async () => {
  const d = tmpdir(); const f = path.join(d, 'ledger.jsonl');
  const within = (p, ms) => Promise.race([
    p.then(() => 'done', () => 'threw'),
    new Promise((r) => setTimeout(() => r('timeout'), ms)),
  ]);

  const unqueued = await within(store.enqueue(async () => { await store.appendLineUnqueued(f, { n: 1 }); }), 1000);
  assert.strictEqual(unqueued, 'done', 'appendLineUnqueued works inside a queue slot');

  // The point of the pair. `enqueue` sets chain = p.then(...) where p is the RUNNING slot, so a
  // nested enqueue awaits its own caller. No error, no timeout — it simply never settles.
  const queued = within(store.enqueue(async () => { await store.appendLine(f, { n: 2 }); }), 1000);
  assert.strictEqual(await queued, 'timeout', 'appendLine inside a slot must NOT complete');
});

