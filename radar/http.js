'use strict';
// The one HTTP client radar has. Zero dependencies: global `fetch` (node >= 18) behind an
// AbortController timeout.
//
// REACHABILITY IS AN HTTP GET, NEVER A BARE TCP PROBE (spec §9 trap 6). The sandbox this runs in
// reports connect() success for ports that nothing is listening on, so "the socket opened" proves
// nothing at all. Only a response proves a service.
//
// The timeout is not optional and has no default of Infinity: an unattended collector that blocks
// forever on one dead endpoint stops publishing, and a collector that stops publishing is worse
// than one reporting `stale`.

// Returns one of:
//   { ok, status, body }              the request completed (body null if it was not JSON)
//   { ok: false, kind: 'stale', error } the request never completed (timeout, DNS, reset)
// It never throws and never rejects — a failed probe is a fact to report, not an exception.
async function getJson(url, headers, timeoutMs, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, kind: 'stale', error: 'no fetch implementation (node >= 18 required)' };
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: ac ? ac.signal : undefined });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e && e.message ? e.message : String(e));
    return { ok: false, kind: 'stale', error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { getJson };
