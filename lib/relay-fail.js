'use strict';
// p41 D52: what a failed server -> bridge relay means, and the one line it leaves in the log.
//
// Before D52 every failure was a bare 502 `bridge_unreachable` with nothing logged, so "Not sent:
// /api/cmux/send 502" could not be traced to a cause. Now:
//   * classify(err) names the cause from the fetch error chain (ECONNREFUSED, UND_ERR_SOCKET,
//     ERR_HTTP2_STREAM_ERROR, timeout, ...).
//   * connect-refused means the TCP connect itself failed: not one byte of the request reached the
//     bridge, so ONE retry cannot double-send. That is also exactly what a bridge mid-restart looks
//     like, so after the retry the answer is 503 bridge_restarting + Retry-After, not 502.
//   * Any other failure (reset, socket terminated, h2 stream error, timeout) may have happened AFTER
//     the bridge read the body. Those are never retried here: the app keeps the text + Retry (D30).
//   * log(): one `relay_fail {json}` line on stderr — machine id, bridge path (no query string),
//     cause, ms, attempts. Never the secret, never the body, never the query.
const LIMITS = Object.freeze({
  connectRetryDelayMs: 600,   // one retry after this; a launchd bridge restart is usually longer, the
                              // retry catches the tail of a restart / a momentary listen backlog
  retryAfterSec: 2,           // Retry-After on 503 bridge_restarting
});

const REFUSED = new Set(['ECONNREFUSED', 'ENOENT']);   // ENOENT: unix: socket bridge not bound yet

function chain(err) {
  const out = [];
  for (let e = err, i = 0; e && i < 6; e = e.cause, i++) out.push(e);
  return out;
}

function classify(err) {
  const errs = chain(err);
  if (errs.some((e) => e && (e.name === 'AbortError' || e.name === 'TimeoutError'))) return 'timeout';
  for (const e of errs) if (e && typeof e.code === 'string') return e.code;
  for (const e of errs) if (e && e.message === 'terminated') return 'terminated';
  return (errs[0] && errs[0].name) || 'unknown';
}

const isConnectRefused = (err) => REFUSED.has(classify(err));

function log(rec, sink) {
  const line = {
    machine: String(rec.machine || ''),
    path: String(rec.path || '').split('?')[0],
    cause: rec.cause,
    ms: rec.ms,
    attempts: rec.attempts || 1,
  };
  (sink || console.error)(`relay_fail ${JSON.stringify(line)}`);
}

module.exports = { LIMITS, classify, isConnectRefused, log };
