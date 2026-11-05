'use strict';
// Per-key minimum-interval floor with an injectable clock (now defaults to Date.now).
function createShotLimiter({ minMs, now = Date.now, max = 256 } = {}) {
  const last = new Map();
  return {
    // -> { ok: true } and records the hit, or { ok: false, retryMs }
    take(key) {
      const t = now();
      const prev = last.get(key);
      if (prev != null && t - prev < minMs) return { ok: false, retryMs: minMs - (t - prev) };
      last.set(key, t);
      if (last.size > max) last.delete(last.keys().next().value);
      return { ok: true };
    },
    // p41 D88: record a hit now (a shot taken on another path) so the floor counts from it.
    mark(key) { last.set(key, now()); if (last.size > max) last.delete(last.keys().next().value); },
    // p41 D88: book the next slot -> ms to wait before shooting (0 = now); never refuses.
    reserve(key) {
      const t = now();
      const prev = last.get(key);
      const at = prev != null && t - prev < minMs ? prev + minMs : t;
      last.set(key, at);
      if (last.size > max) last.delete(last.keys().next().value);
      return at - t;
    },
  };
}
module.exports = { createShotLimiter };
