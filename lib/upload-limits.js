'use strict';
// p41 D116: one place for the upload cap (server.js before the tunnel, bridge.js again).
// A phone video is commonly 50-500 MB, so the default is 512 MB (was 32 MB); UPLOAD_MAX_BYTES overrides.
const DEFAULT_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

function uploadMaxBytes(env = process.env) {
  const n = Number(env.UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UPLOAD_MAX_BYTES;
}

// The server -> bridge relay of a buffered upload: 60 s floor, plus 1 s per MB (a 512 MB video ~ 9.5 min).
function uploadRelayTimeoutMs(bytes) {
  return 60000 + Math.ceil(Math.max(0, Number(bytes) || 0) / (1024 * 1024)) * 1000;
}

module.exports = { DEFAULT_UPLOAD_MAX_BYTES, uploadMaxBytes, uploadRelayTimeoutMs };
