'use strict';
// Raw request body with a byte cap: cb(Buffer) or cb(null) when over the cap or on a stream error.
// Used by server.js (account + avatar relays) and bridge.js (k185 avatar routes).
function readRaw(req, cap, cb) {
  const chunks = []; let size = 0, over = false;
  req.on('data', (c) => { if (over) return; size += c.length; if (size > cap) { over = true; return; } chunks.push(c); });
  req.on('end', () => cb(over ? null : Buffer.concat(chunks)));
  req.on('error', () => cb(null));
}
module.exports = { readRaw };
