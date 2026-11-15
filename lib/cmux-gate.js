'use strict';
// p41 D249: one gate for the bridge's POLL reads into cmux (terminal.replay, read-screen, pane.list).
//
// Why: every `cmux` CLI call is a new socket connection, and cmux does the per-connection work on its
// MAIN thread: socket password lookup, a peer process-ancestry walk (sysctl/proc_info), then the replay
// frame build + JSON conversion. Hang samples from 2026-11-15 (x and the mini, cmux 0.64.25) show the
// main thread in SocketTransport.isProcessDescendant / SocketControlPasswordStore / ControlCommand-
// Coordinator.handle → JSONValue.init. The bridge's streams poll on a FIXED cadence (160–900 ms after the
// previous reply) per stream, with no shared limit: N clients × M panes keep cmux busy, and when cmux
// slows the loops do not slow with it — a timed-out replay even falls straight into a 2000-row
// read-screen. This gate:
//   1. coalesces: two streams asking for the same read (same args) share one cmux call;
//   2. caps how many poll reads run at once (maxInFlight), extra callers wait in a bounded queue;
//   3. backs off: a slow (> slowMs) or failed read doubles a shared extra delay (cap maxBackoffMs),
//      every fast read halves it; stream schedulers add `extraDelay()` to their own cadence.
// Interactive calls (send, key, focus, close …) never pass through here: they stay immediate.
// Limits: LIMITS.md rows "cmux-remote poll gate …" (D249).

const DEFAULTS = {
  maxInFlight: 2,        // poll reads running against cmux at once
  maxQueue: 64,          // waiting reads beyond this fail fast with `cmux_busy`
  slowMs: 1500,          // a read slower than this counts as "cmux is slow"
  firstBackoffMs: 500,   // extra delay after the first slow/failed read
  maxBackoffMs: 8000,    // extra delay ceiling
  floorMs: 100,          // halving below this clears the backoff
};

// execFile kills the child at its timeout: err.killed + err.signal. tmux-cli mirrors that shape.
function isTimeout(err) {
  return !!(err && (err.killed || err.signal || err.code === 'ETIMEDOUT'));
}

function createCmuxGate(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now || Date.now;
  const log = o.log || (() => {});
  const inflight = new Map();   // key -> [cb, …] waiting on the one running call
  const queue = [];             // { key, start } not started yet
  let running = 0, backoffMs = 0, slowStreak = 0;
  const stats = { calls: 0, coalesced: 0, queuedPeak: 0, slow: 0, failed: 0, rejected: 0 };

  function settle(key, startedAt, err, stdout, stderr) {
    running--;
    const dur = now() - startedAt;
    // A fast non-zero exit (surface gone, unknown flag) is an answer, not slowness: only a read that
    // was slow or got killed by its timeout moves the backoff.
    const timedOut = isTimeout(err);
    const slow = timedOut || dur > o.slowMs;
    if (slow) {
      if (timedOut) stats.failed++; else stats.slow++;
      slowStreak++;
      const was = backoffMs;
      backoffMs = Math.min(o.maxBackoffMs, backoffMs ? backoffMs * 2 : o.firstBackoffMs);
      if (!was) log(`cmux poll gate: backoff ON ${backoffMs}ms (${timedOut ? 'timeout' : `${dur}ms read`}, running=${running} queued=${queue.length})`);
    } else if (backoffMs) {
      slowStreak = 0;
      backoffMs = backoffMs / 2 < o.floorMs ? 0 : Math.round(backoffMs / 2);
      if (!backoffMs) log(`cmux poll gate: backoff OFF (slow=${stats.slow} failed=${stats.failed} coalesced=${stats.coalesced})`);
    }
    const cbs = inflight.get(key) || [];
    inflight.delete(key);
    for (const cb of cbs) { try { cb(err, stdout, stderr); } catch (e) { log(`cmux poll gate: callback threw ${e && e.message}`); } }
    pump();
  }

  function startCall(key, start) {
    running++;
    stats.calls++;
    const t0 = now();
    let once = false;
    start((err, stdout, stderr) => { if (once) return; once = true; settle(key, t0, err, stdout, stderr); });
  }

  function pump() {
    while (running < o.maxInFlight && queue.length) {
      const q = queue.shift();
      startCall(q.key, q.start);
    }
  }

  // run(key, start, cb): start(done) makes the real call; cb(err, stdout, stderr) gets the shared result.
  function run(key, start, cb) {
    const waiting = inflight.get(key);
    if (waiting) { stats.coalesced++; waiting.push(cb); return; }
    if (running >= o.maxInFlight && queue.length >= o.maxQueue) {
      stats.rejected++;
      const e = new Error('cmux_busy'); e.code = 'cmux_busy';
      return void setImmediate(() => cb(e, '', ''));
    }
    inflight.set(key, [cb]);
    if (running < o.maxInFlight) startCall(key, start);
    else { queue.push({ key, start }); stats.queuedPeak = Math.max(stats.queuedPeak, queue.length); }
  }

  return {
    run,
    extraDelay: () => backoffMs,
    slow: () => backoffMs > 0,
    state: () => ({ running, queued: queue.length, inflightKeys: inflight.size, backoffMs, slowStreak, ...stats }),
  };
}

module.exports = { createCmuxGate, isTimeout, DEFAULTS };
