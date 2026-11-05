'use strict';
// p41 A18: graceful restart. Tracks every long-lived SSE response on an http.Server, and on
// SIGTERM/SIGINT tells each one `event: restarting` (+ SSE `retry:` hint), ends them cleanly so
// clients reconnect at once, lets short in-flight requests finish (drain), then exits.
const LIMITS = {
  drainMs: 3000,        // max wait for in-flight non-stream requests after streams are told
  retryHintMs: 500,     // reconnect hint sent to clients (SSE `retry:` and data.retryMs)
  forceExitGraceMs: 500, // extra after drain before hard exit (env RESTART_FORCE_GRACE_MS)
  exitCode: 75          // EX_TEMPFAIL: nonzero so launchd KeepAlive{SuccessfulExit=false} relaunches
};
function envInt(name, d) { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : d; }
function limitsFromEnv() {
  return { ...LIMITS, drainMs: envInt('RESTART_DRAIN_MS', LIMITS.drainMs), forceExitGraceMs: envInt('RESTART_FORCE_GRACE_MS', LIMITS.forceExitGraceMs), retryHintMs: envInt('RESTART_RETRY_MS', LIMITS.retryHintMs) };
}

function restartingFrame(retryMs) {
  return `retry: ${retryMs}\nevent: restarting\ndata: ${JSON.stringify({ retryMs })}\n\n`;
}

function createGraceful(server, opts = {}) {
  const limits = { ...limitsFromEnv(), ...(opts.limits || {}) };
  const streams = new Set();
  const state = { ready: false, draining: false };
  server.prependListener('request', (req, res) => {
    const wh = res.writeHead;
    res.writeHead = function (...a) {
      const h = a.find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {};
      const ct = String(h['Content-Type'] || h['content-type'] || (this.getHeader && this.getHeader('content-type')) || '');
      if (ct.startsWith('text/event-stream')) { streams.add(res); res.on('close', () => streams.delete(res)); }
      return wh.apply(this, a);
    };
  });
  function notifyStreams() {
    for (const res of [...streams]) {
      try { if (!res.writableEnded) { res.write(restartingFrame(limits.retryHintMs)); res.end(); } } catch (_) {}
      streams.delete(res);
    }
  }
  let started = null;
  // beforeExit: optional cleanup (radar.stop). exit: injectable for tests.
  function shutdown(beforeExit, exit = (c) => process.exit(c)) {
    if (started) return started;
    state.draining = true;
    started = new Promise((resolve) => {
      notifyStreams();
      try { if (beforeExit) beforeExit(); } catch (_) {}
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(t); resolve(); exit(limits.exitCode); };
      const t = setTimeout(fin, limits.drainMs + limits.forceExitGraceMs);
      try { server.close(fin); } catch (_) { fin(); }
      // idle keep-alive sockets would hold close() open; busy ones finish within the drain
      try { if (server.closeIdleConnections) server.closeIdleConnections(); } catch (_) {}
      setTimeout(() => { try { if (server.closeAllConnections) server.closeAllConnections(); } catch (_) {} }, limits.drainMs).unref();
    });
    return started;
  }
  function install(beforeExit) {
    const h = () => { shutdown(beforeExit); };
    process.on('SIGTERM', h); process.on('SIGINT', h);
  }
  // GET /healthz body: 200 once listening, 503 while draining.
  function health(res) {
    const code = state.draining ? 503 : (state.ready ? 200 : 503);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: code === 200, ready: state.ready, draining: state.draining }));
  }
  return { limits, state, streams, shutdown, install, health, markReady() { state.ready = true; } };
}
module.exports = { createGraceful, restartingFrame, LIMITS };
