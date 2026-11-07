'use strict';
// p41 D161: the app's 'Queued · Edit' cancels a send still in the server's queue (never typed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSendQueue, LIMITS } = require('../lib/send-queue');

const tick = () => new Promise((r) => setImmediate(r));
async function flush(n = 5) { for (let i = 0; i < n; i++) await tick(); }
function clock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    async advance(ms) {
      t += ms;
      for (const h of timers.splice(0).sort((a, b) => a.at - b.at)) { if (h.at <= t) h.fn(); else timers.push(h); }
      await flush();
    },
  };
}
const timeoutErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const transient = (out) => (out.error ? { retry: true, cause: 'timeout' } : { retry: false });

test('D161 cancel: a queued send behind a retrying head is dropped and never typed; head can be cancelled while waiting', async () => {
  const c = clock();
  const typed = [];
  let fails = 1;
  const q = createSendQueue({ now: c.now, setTimer: c.setTimer, transient, attempt: async (it) => {
    if (it.sendId === 'id-aaaaaaaa' && fails-- > 0) throw timeoutErr();
    typed.push(it.sendId);
    return { status: 200, body: { ok: true } };
  } });
  assert.deepEqual(await q.submit({ machine: 'm', surface: 's', sendId: 'id-aaaaaaaa', payload: {} }), { queued: true });
  assert.deepEqual(await q.submit({ machine: 'm', surface: 's', sendId: 'id-bbbbbbbb', payload: {} }), { queued: true });
  assert.equal(q.cancel('m', 'id-bbbbbbbb'), 'cancelled');
  assert.equal(q.get('m', 'id-bbbbbbbb').state, 'cancelled');
  assert.equal(q.cancel('m', 'id-bbbbbbbb'), 'cancelled');        // idempotent
  await c.advance(LIMITS.backoffMs[0]);                            // head retries and lands
  assert.deepEqual(typed, ['id-aaaaaaaa']);                        // b was never typed
  assert.equal(q.cancel('m', 'id-aaaaaaaa'), 'sent');              // too late once typed
  assert.equal(q.cancel('m', 'id-unknownx'), 'unknown');
});

test('D161 cancel: the head waiting on its backoff is dropped; nothing is typed after', async () => {
  const c = clock();
  const typed = [];
  const q = createSendQueue({ now: c.now, setTimer: c.setTimer, transient, attempt: async (it) => {
    if (it.attempts === 1) throw timeoutErr();
    typed.push(it.sendId);
    return { status: 200, body: {} };
  } });
  assert.deepEqual(await q.submit({ machine: 'm', surface: 's', sendId: 'id-cccccccc', payload: {} }), { queued: true });
  assert.equal(q.cancel('m', 'id-cccccccc'), 'cancelled');
  await c.advance(LIMITS.backoffMs[0] * 4);
  assert.deepEqual(typed, []);
  assert.equal(q.size('m', 's'), 0);
});

test('D161 cancel: an attempt typing right now cannot be cancelled', async () => {
  let release;
  const q = createSendQueue({ transient, attempt: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  const p = q.submit({ machine: 'm', surface: 's', sendId: 'id-dddddddd', payload: {} });
  await flush();
  assert.equal(q.cancel('m', 'id-dddddddd'), 'inflight');
  release();
  assert.equal((await p).result.status, 200);
});
