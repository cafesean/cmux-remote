'use strict';
// p41 D133: sends survive a load spike on the bridge machine. Seen: mac-mini at load 9-10/core, the
// server -> bridge /cmux/send relay hits its 15 s timeout (48 relay_fail in one day) while a normal
// send is 0.15 s. Before D133 the app got a 502 and the user retyped / re-tapped.
//
// Only sends WITH a sendId (D121) use this; no sendId = the old one-shot relay.
// Per (machine, surface) FIFO, ONE attempt in flight. A send whose attempt fails TRANSIENTLY (timeout,
// reset/refused, a gateway 502/503/504 that is not a bridge write-phase answer) stays at the head and
// is retried on LIMITS.backoffMs; the HTTP request then answers 202 { queued, sendId } and the app
// polls GET /api/cmux/send/status. Sends behind a retrying head answer 202 at once (order is kept).
// A send not delivered LIMITS.maxAgeMs after it was submitted is `failed` (error 'expired').
// Never typed twice: every attempt carries the same sendId to the bridge, which remembers executed
// ids (bridge.js SEND_SEEN) and answers a repeat without typing; the server's D121 store records the
// first 2xx.
// In memory only: a server restart drops queued items -> status 404 -> the app treats it as failed.
const LIMITS = Object.freeze({
  backoffMs: Object.freeze([2000, 4000, 8000, 16000, 30000]),   // then 30000 repeating
  maxAgeMs: 120 * 1000,          // from submit; then 'failed' / 'expired'
  perSurfaceMax: 20,             // queued + in flight per (machine, surface); overflow -> 429 queue_full
  statusMax: 500,                // finished statuses kept for GET .../status
  statusTtlMs: 10 * 60 * 1000,
});

const k2 = (a, b) => `${a}\u0000${b}`;

// attempt(item) -> Promise<{ status, body, duplicate? }> (or throws); item = { machine (id), target (machine obj), surface, sendId, payload, attempts }
// transient({ error } | { result }) -> { retry: true, cause } | { retry: false }
function createSendQueue({ attempt, transient, now = Date.now, setTimer = setTimeout, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const lanes = new Map();    // k2(machine, surface) -> { items: [], running, timer, waiting }
  const status = new Map();   // k2(machine, sendId) -> item (live or finished); insertion order = age

  function prune() {
    const t = now();
    for (const [k, it] of status) if (it.done && t - it.at > L.statusTtlMs) status.delete(k);
    if (status.size <= L.statusMax) return;
    for (const [k, it] of status) { if (status.size <= L.statusMax) break; if (it.done) status.delete(k); }
  }
  function answer(item, r) { if (!item.answered) { item.answered = true; item.resolve(r); } }
  function markQueued(item) { if (!item.done) item.state = 'queued'; answer(item, { queued: true }); }
  function finish(item, state, error) { item.state = state; item.error = error; item.done = true; item.at = now(); }
  const backoff = (n) => L.backoffMs[Math.min(Math.max(n, 1), L.backoffMs.length) - 1];

  function pump(lk, lane) {
    if (lane.running || lane.timer) return;
    const item = lane.items[0];
    if (!item) { lanes.delete(lk); return; }
    if (now() - item.submittedAt >= L.maxAgeMs) {   // waited too long behind a stuck head
      finish(item, 'failed', 'expired');
      markQueued(item);
      lane.items.shift();
      return pump(lk, lane);
    }
    lane.running = true;
    item.attempts++;
    Promise.resolve()
      .then(() => attempt(item))
      .then((result) => ({ result }), (error) => ({ error }))
      .then((out) => {
        lane.running = false;
        const tr = transient(out) || { retry: false };
        if (!tr.retry) {
          lane.waiting = false;
          if (out.error) finish(item, 'failed', tr.cause || 'error');
          else {
            const ok = out.result.status >= 200 && out.result.status < 300;
            finish(item, ok ? 'sent' : 'failed', ok ? undefined : String((out.result.body && out.result.body.error) || 'http_' + out.result.status));
          }
          answer(item, out);
          lane.items.shift();
          return pump(lk, lane);
        }
        item.error = tr.cause;
        const delay = Math.min(backoff(item.attempts), L.maxAgeMs - (now() - item.submittedAt));
        if (delay <= 0) {
          finish(item, 'failed', 'expired');
          markQueued(item);
          lane.items.shift();
          return pump(lk, lane);
        }
        lane.waiting = true;
        for (const it of lane.items) markQueued(it);
        lane.timer = setTimer(() => { lane.timer = null; pump(lk, lane); }, delay);
        if (lane.timer && lane.timer.unref) lane.timer.unref();
      })
      .catch(() => { lane.running = false; });
  }

  // -> Promise of { queued: true } | { full: true } | { result } | { error } (the first attempt's outcome)
  function submit({ machine, target, surface, sendId, payload }) {
    prune();
    const sk = k2(machine, sendId);
    const live = status.get(sk);
    if (live && !live.done) {
      if (live.answered) return Promise.resolve({ queued: true });
      return live.promise.then((r) => (r.result && r.result.status >= 200 && r.result.status < 300 ? { result: { ...r.result, duplicate: true } } : r));
    }
    const lk = k2(machine, surface);
    let lane = lanes.get(lk);
    if (!lane) lanes.set(lk, (lane = { items: [], running: false, timer: null, waiting: false }));
    if (lane.items.length >= L.perSurfaceMax) return Promise.resolve({ full: true });
    const item = { machine, target, surface, sendId, payload, attempts: 0, state: 'pending', submittedAt: now(), answered: false, done: false };
    item.promise = new Promise((r) => { item.resolve = r; });
    status.delete(sk);
    status.set(sk, item);
    lane.items.push(item);
    if (lane.waiting) markQueued(item);
    pump(lk, lane);
    return item.promise;
  }

  function get(machine, sendId) {
    prune();
    const it = status.get(k2(machine, sendId));
    if (!it) return null;
    const out = { state: it.state === 'pending' ? 'queued' : it.state, attempts: it.attempts };
    if (it.error && it.state !== 'sent') out.error = it.error;
    return out;
  }

  // p41 D161 (Sean: recall a message that has not reached Claude yet): drop a queued send before it is
  // typed. 'cancelled' = removed, it will never be typed; 'inflight' = an attempt is typing it right now
  // (too late); 'sent' / 'failed' = already finished; 'unknown' = never queued here (or expired).
  function cancel(machine, sendId) {
    prune();
    const it = status.get(k2(machine, sendId));
    if (!it) return 'unknown';
    if (it.done) return it.state;
    const lk = k2(machine, it.surface);
    const lane = lanes.get(lk);
    const idx = lane ? lane.items.indexOf(it) : -1;
    if (idx < 0) return 'unknown';
    if (idx === 0 && lane.running) return 'inflight';
    lane.items.splice(idx, 1);
    finish(it, 'cancelled');
    answer(it, { queued: true });
    if (!lane.items.length) {
      if (lane.timer) clearTimeout(lane.timer);
      lanes.delete(lk);
    }
    return 'cancelled';
  }

  return { submit, get, cancel, size: (machine, surface) => ((lanes.get(k2(machine, surface)) || { items: [] }).items.length) };
}

module.exports = { createSendQueue, LIMITS };
