'use strict';
// p41 D201 — Mac focused-field "is it a password field" (focusSecure). FAKE AX helper + FAKE osascript;
// nothing real is read. Proves: AX secure -> true, plain -> false, control off / helper error -> null,
// one helper run per SCREEN_FOCUS_CACHE_MS, a tap drops the cache, and the helper request carries no text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacScreen, LIMITS } = require('../lib/mac-screen');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd201-'));
const osa = path.join(dir, 'osa');
fs.writeFileSync(osa, '#!/bin/sh\nIN=$(cat)\ncase "$IN" in *canCapture*) echo \'{"displays":[{"index":1,"x":0,"y":0,"w":10,"h":10,"scale":1}],"canCapture":true,"canControl":true,"secureInput":true}\';; *) echo ok;; esac\n', { mode: 0o755 });

function mk({ control = true, answer = { secure: true } } = {}) {
  let t = 1000; const reqs = [];
  const ms = createMacScreen({ env: { SCREEN_VIEW: '1', ...(control ? { SCREEN_CONTROL: '1' } : {}), SCREEN_OSASCRIPT_BIN: osa },
    host: '127.0.0.1', now: () => t, log: () => {},
    axHelper: { run: async (r) => { reqs.push(r); return typeof answer === 'function' ? answer() : answer; } } });
  return { ms, reqs, tick: (ms2) => { t += ms2; } };
}

test('AX secure field focused -> info.focusSecure true; request is role-only (no text)', async () => {
  const { ms, reqs } = mk();
  const r = await ms.info();
  assert.equal(r.status, 200);
  assert.equal(r.body.focusSecure, true);
  assert.deepEqual(reqs, [{ op: 'focused' }]);
});

test('plain field -> false; SCREEN_CONTROL off -> null (unknown); helper error -> null', async () => {
  assert.equal((await mk({ answer: { secure: false } }).ms.info()).body.focusSecure, false);
  const off = mk({ control: false });
  assert.equal((await off.ms.info()).body.focusSecure, null);
  assert.equal(off.reqs.length, 0, 'no AX query without SCREEN_CONTROL');
  assert.equal((await mk({ answer: { error: 'not_trusted' } }).ms.info()).body.focusSecure, null);
});

test('cached for SCREEN_FOCUS_CACHE_MS; a tap drops the cache', async () => {
  assert.equal(LIMITS.SCREEN_FOCUS_CACHE_MS, 1000);
  let v = true; const { ms, reqs, tick } = mk({ answer: () => ({ secure: v }) });
  await ms.info(); await ms.info();
  assert.equal(reqs.length, 1, 'second read inside the window reuses the answer');
  v = false; tick(LIMITS.SCREEN_FOCUS_CACHE_MS);
  assert.equal((await ms.info()).body.focusSecure, false);
  assert.equal(reqs.length, 2);
  v = true; tick(10);
  assert.equal((await ms.input('tap', { fx: 0.5, fy: 0.5 })).status, 200);
  assert.equal((await ms.info()).body.focusSecure, true, 'tap moved focus -> re-read');
  assert.equal(reqs.length, 3);
});
