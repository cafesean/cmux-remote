'use strict';
// S2-0: constant-time string compare for secrets. Hashing both sides first gives equal-length
// buffers, so neither the length check nor the compare leaks how much of the secret matched.
const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/** True only when both are non-empty strings with the same content; constant time in the content. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(digest(a), digest(b));
}

module.exports = { safeEqual };
