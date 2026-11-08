'use strict';
// p41 D52 — "Not sent: /api/cmux/send 502". Evidence (2026-11-05): server.err.log held five
// uncaught `TypeError: terminated` crashes (3x local bridge "other side closed", 2x mini HTTP/2
// NGHTTP2_INTERNAL_ERROR), each followed by a launchd restart; cloudflared logged "Unable to reach
// the origin service" in the same seconds, which the app shows as a 502. Root cause: the SSE relays
// call reader.cancel() inside a sync try/catch, so the REJECTED promise of cancelling an errored
// upstream body is unhandled and Node exits the whole server.
//
// On trial here, against a REAL server.js child and a stub bridge:
//   1. an SSE upstream dying mid-stream no longer kills the server;
//   2. /api/cmux/send retries ONCE on connect-refused (no byte reached the bridge, so no double
//      send), then answers 503 bridge_restarting + Retry-After instead of 502;
//   3. every relay failure writes one structured `relay_fail` line (machine, path, cause, ms) with
//      no secret in it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { bootServer, call } = require('./helpers/server-boot');
const { LIMITS } = require('../lib/relay-fail');

const SECRET = 'd52-secret-value';
const until = async (fn, ms = 4000, step = 25) => {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, step)); }
};
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function stubBridge(port) {
  const seen = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ path: req.url, body, rid: req.headers['x-request-id'] || null });
      if (req.url.startsWith('/cmux/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        return setTimeout(() => req.socket.destroy(), 80);   // die mid-stream, like a bridge restart
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((r) => srv.listen(port || 0, '127.0.0.1', () => r({
    seen, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((c) => { for (const s of sockets) s.destroy(); srv.close(() => c()); }),
  })));
}

test('D52: an SSE upstream dying mid-stream does not crash the server', async (t) => {
  const up = await stubBridge();
  const srv = await bootServer({ env: { CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0' } });
  t.after(async () => { await srv.stop(); await up.close(); });
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => {
      http.get(`${srv.base}/api/cmux/stream?surface=s1`, (res) => {
        res.once('data', () => setTimeout(() => res.destroy(), 120));   // client leaves after upstream died
        res.on('error', () => {}); res.on('close', resolve);
      }).on('error', resolve);
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(srv.alive(), `server must survive:\n${srv.stderr()}`);
  assert.doesNotMatch(srv.stderr(), /TypeError: terminated/);
  const r = await call(srv.base, 'POST', '/api/cmux/send', { body: { surface: 's1', text: 'hi', submit: true } });
  assert.equal(r.status, 200);
});

test('D52: send to a bridge that is restarting retries once, then 503 bridge_restarting', async (t) => {
  const port = await freePort();
  const srv = await bootServer({ env: { CMUX_MACHINE_URL: `http://127.0.0.1:${port}`, CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0' } });
  t.after(async () => { await srv.stop(); });

  // nothing listening: one retry, then 503 + Retry-After
  const t0 = Date.now();
  const r = await fetch(`${srv.base}/api/cmux/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ surface: 's1', text: 'hi' }) });
  const body = await r.json();
  assert.equal(r.status, 503);
  assert.equal(body.error, 'bridge_restarting');
  assert.equal(r.headers.get('retry-after'), String(LIMITS.retryAfterSec));
  assert.ok(Date.now() - t0 >= LIMITS.connectRetryDelayMs, 'waited for the one retry');
  assert.ok(await until(() => /relay_fail /.test(srv.stderr())), 'structured log line written');
  // D206b: lines carry an ISO timestamp prefix (lib/log-ts.js)
  const line = srv.stderr().split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '')).find((l) => l.startsWith('relay_fail '));
  const rec = JSON.parse(line.slice('relay_fail '.length));
  assert.equal(rec.path, '/cmux/send');
  assert.equal(rec.machine, 'default');
  assert.equal(rec.cause, 'ECONNREFUSED');
  assert.equal(rec.attempts, 2);
  assert.equal(typeof rec.ms, 'number');
  assert.ok(!srv.stderr().includes(SECRET), 'no secret in logs');

  // bridge comes back inside the retry window: the send lands exactly once
  const p = fetch(`${srv.base}/api/cmux/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ surface: 's1', text: 'once' }) });
  await new Promise((res) => setTimeout(res, Math.floor(LIMITS.connectRetryDelayMs / 4)));
  const up = await stubBridge(port);
  t.after(() => up.close());
  const r2 = await p;
  assert.equal(r2.status, 200);
  assert.equal(up.seen.filter((s) => s.path === '/cmux/send').length, 1, 'delivered once, never twice');
});
