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
  };
}
module.exports = { createShotLimiter };
