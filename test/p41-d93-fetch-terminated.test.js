'use strict';
// p41 D93 — the server exits on an uncaught undici `TypeError: terminated` (cause UND_ERR_SOCKET
// "other side closed" from the local bridge, or ERR_HTTP2_STREAM_ERROR from the mini bridge via
// Cloudflare) when a bridge restarts mid-response. D52 guarded the SSE reader.cancel() rejection and
// added an unhandledRejection handler, yet the crash prints the default FATAL banner, so it is a
// thrown exception, not a rejection.
//
// On trial, against a REAL server.js child and a stub bridge that cuts the socket mid-body on EVERY
// route: after each cut, /healthz must still answer and no `TypeError: terminated` may reach stderr.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { bootServer, call } = require('./helpers/server-boot');

const SECRET = 'd93-secret-value';

// Every path: headers, a partial body, then the socket is destroyed (a bridge restart).
function cuttingBridge() {
  const sockets = new Set();
  const seen = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.url);
      const sse = /stream/.test(req.url);
      if (sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
        res.write('{"ok":true,"pad":"');
      }
      setTimeout(() => req.socket.destroy(), 60);
    });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    seen, base: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((c) => { for (const s of sockets) s.destroy(); srv.close(() => c()); }),
  })));
}

// Read the reply to the end (or to its error) and return the status; the client never leaves first.
const get = (base, path) => new Promise((resolve) => {
  http.get(`${base}${path}`, (res) => {
    res.on('data', () => {}); res.on('error', () => resolve(res.statusCode));
    res.on('end', () => resolve(res.statusCode)); res.on('close', () => resolve(res.statusCode));
  }).on('error', () => resolve(0));
});
const healthz = (base) => get(base, '/healthz');

const ROUTES = [
  // SSE relays (server.js getReader loops, sessions-proxy pipeThrough)
  '/api/cmux/stream?surface=s1',
  '/api/cmux/layout-stream?workspace=w1',
  '/api/cmux/panes-stream?surfaces=s1',
  '/api/cmux/grid-stream?surface=s1',
  '/api/cmux/browser/stream?surface=s1',
  '/api/sessions/mac-a:s1/thread-stream?machine=local',
  // JSON relays (r.json() of a body cut mid-way)
  '/api/cmux/tree',
  '/api/cmux/grid?surface=s1',
  '/api/cmux/browser/info?surface=s1',
  '/api/cmux/fleet',
  '/api/sessions/mac-a:s1/thread?machine=local',
  '/api/sessions?machine=local',
];

test('D93: a bridge cutting the socket mid-body on any route does not kill the server', async (t) => {
  const up = await cuttingBridge();
  const srv = await bootServer({ env: { CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0', RADAR_ENABLED: '0' }, nodeArgs: ['--trace-uncaught'] });
  t.after(async () => { await srv.stop(); await up.close(); });
  for (const r of ROUTES) {
    await get(srv.base, r);
    await new Promise((res) => setTimeout(res, 150));
    assert.ok(srv.alive(), `server died after ${r}:\n${srv.stderr()}`);
    assert.equal(await healthz(srv.base), 200, `healthz after ${r}`);
  }
  assert.doesNotMatch(srv.stderr(), /TypeError: terminated/);
  assert.doesNotMatch(srv.stderr(), new RegExp(SECRET));
});

// The live crash is a THROWN undici error raised inside an emit no relay can wrap (Fetch.onAborted ->
// controller.error from Socket 'close' / ClientHttp2Stream 'error'). A preload throws the exact
// shapes from server.err.log from a timer in the real server child: it must log + survive them, and
// still die on any other uncaught exception.
const fs = require('fs');
const os = require('os');
const path = require('path');
function preload(body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd93-')), 'throw.js');
  fs.writeFileSync(f, `setTimeout(() => { ${body} }, 400);\n`);
  return f;
}
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return fn(); };

for (const [name, body, cause] of [
  ['local bridge socket closed', "throw new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });", 'UND_ERR_SOCKET'],
  ['mini bridge h2 stream reset', "throw new TypeError('terminated', { cause: Object.assign(new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR'), { code: 'ERR_HTTP2_STREAM_ERROR' }) });", 'ERR_HTTP2_STREAM_ERROR'],
]) {
  test(`D93: an uncaught undici "terminated" (${name}) is logged and survived`, async (t) => {
    const srv = await bootServer({ env: { CMUX_MACHINE_URL: 'http://127.0.0.1:9', CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0', RADAR_ENABLED: '0' }, nodeArgs: ['--require', preload(body)] });
    t.after(() => srv.stop());
    assert.ok(await until(() => /uncaught_transport /.test(srv.stderr())), `no uncaught_transport line:\n${srv.stderr()}`);
    assert.ok(srv.alive(), `server must survive:\n${srv.stderr()}`);
    assert.equal(await healthz(srv.base), 200);
    assert.match(srv.stderr(), new RegExp(`uncaught_transport \\{"cause":"${cause}"\\}`));
    assert.doesNotMatch(srv.stderr(), /TypeError: terminated/);
  });
}

test('D93: any OTHER uncaught exception still exits the server (no blanket swallow)', async (t) => {
  const srv = await bootServer({ env: { CMUX_MACHINE_URL: 'http://127.0.0.1:9', CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0', RADAR_ENABLED: '0' }, nodeArgs: ['--require', preload("throw new TypeError('d93 genuine bug');")] });
  t.after(() => srv.stop());
  assert.ok(await until(() => !srv.alive()), 'a genuine bug must still exit');
  assert.match(srv.stderr(), /d93 genuine bug/);
});

test('D93: isTransportError names only connection-death classes', () => {
  const { isTransportError } = require('../lib/relay-fail');
  const wrap = (code) => new TypeError('terminated', { cause: Object.assign(new Error('x'), { code }) });
  assert.ok(isTransportError(wrap('UND_ERR_SOCKET')));
  assert.ok(isTransportError(wrap('ERR_HTTP2_STREAM_ERROR')));
  assert.ok(isTransportError(new TypeError('terminated')));
  assert.ok(isTransportError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
  assert.ok(!isTransportError(new TypeError('Cannot read properties of undefined')));
  assert.ok(!isTransportError(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })));
  assert.ok(!isTransportError(null));
});
