'use strict';
// Front door for the Bun-compiled runtime. Bun's node:http never answers a WebSocket upgrade with 101,
// so under Bun the public listener is Bun.serve (fetch + websocket) and the node:http handler moves to
// a private Unix socket in a fresh 0700 directory. Plain HTTP is proxied as streams, both ways.
//
// Trust boundary: the node handler no longer sees the client's socket, so the front door tells it the
// peer in x-hm-peer, vouched for by x-hm-front (a random secret made per process). Client copies of both
// headers are deleted first. A Unix-socket client has no address: x-hm-peer is omitted and the request
// is never local. Every other header (Host, X-Forwarded-*, Origin) passes unchanged.
//
// Under Node nothing here runs: peerAddress() reads the socket as before and server.js keeps 'upgrade'.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { safeEqual } = require('./safe-equal');
const bunWs = require('./bun-ws');

const WS_PATH = '/api/cmux/screen/ws';
const CLOSE_AFTER_MS = 5000;   // shutdown: open streams get this long after accepting stops
const SECRET = crypto.randomBytes(32).toString('hex');
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'];
let active = false;

const isBun = () => typeof Bun !== 'undefined' && !!(Bun && Bun.serve);

// The peer address the trust rules see, or '' when unknown. With the front door active only a request
// carrying the matching x-hm-front is believed; anything else (or a missing x-hm-peer) has no peer.
function peerAddress(req) {
  if (!active) return (req.socket && req.socket.remoteAddress) || '';
  const f = req.headers['x-hm-front'];
  if (typeof f !== 'string' || !safeEqual(f, SECRET)) return '';
  const p = req.headers['x-hm-peer'];
  return typeof p === 'string' ? p : '';
}

function forwardHeaders(req, peer) {
  const h = new Headers(req.headers);
  for (const k of HOP) h.delete(k);
  h.delete('x-hm-peer'); h.delete('x-hm-front');
  if (peer) h.set('x-hm-peer', peer);
  h.set('x-hm-front', SECRET);
  return h;
}

// The node response body as a pull-only JS stream (highWaterMark 0). The upstream IncomingMessage stays
// paused; each pull resumes it for exactly one chunk and pauses it again, so a slow client holds the node
// side back through the Unix socket instead of the front door buffering the file. (Bun's fetch reads its
// body ahead without bound, which is why the inner hop is node:http and not fetch.)
function pullFrom(res) {
  const q = [];
  let wake = null, ended = false, failed = null;
  const poke = () => { const w = wake; wake = null; if (w) w(); };
  res.on('data', (d) => { q.push(d); res.pause(); poke(); });
  res.on('end', () => { ended = true; poke(); });
  res.on('error', (e) => { failed = e; poke(); });
  res.on('close', () => { if (!ended && !failed) failed = new Error('upstream closed'); poke(); });
  res.pause();
  return new ReadableStream({
    async pull(c) {
      while (!q.length && !ended && !failed) await new Promise((r) => { wake = r; res.resume(); });
      if (q.length) { const d = q.shift(); c.enqueue(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)); return; }
      if (failed && !ended) c.error(failed); else c.close();
    },
    cancel() { res.destroy(); },
  }, { highWaterMark: 0 });
}

// One request to the node handler over its Unix socket. The request body (a web stream) is written with
// the socket's backpressure. Resolves the IncomingMessage; rejects on connect errors and on abort.
function innerRequest(sock, req, url, headers, hasBody) {
  return new Promise((resolve, reject) => {
    const h = {};
    for (const [k, v] of headers) h[k] = v;
    const r = http.request({ socketPath: sock, path: url.pathname + url.search, method: req.method, headers: h, agent: false });
    const abort = () => r.destroy(new Error('client gone'));
    if (req.signal) { if (req.signal.aborted) abort(); else req.signal.addEventListener('abort', abort, { once: true }); }
    r.once('response', resolve);
    r.on('error', reject);
    if (!hasBody || !req.body) return r.end();
    (async () => {
      const reader = req.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!r.write(value)) await new Promise((ok) => { r.once('drain', ok); r.once('close', ok); });
          if (r.destroyed) break;
        }
        r.end();
      } catch (e) { r.destroy(e); }
    })();
  });
}

// opts: { nodeServer, port, host } or { nodeServer, unix, listenUnix } (lib/unix-listen.listenUnix, so
// the public socket gets the same directory/stale/0600 checks as before). Optional websocket handlers.
// Resolves { port, result, shutdown }.
async function start(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-front-'));
  fs.chmodSync(dir, 0o700);
  const inner = path.join(dir, 'node.sock');
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  await new Promise((resolve, reject) => {
    opts.nodeServer.once('error', reject);
    opts.nodeServer.listen(inner, () => { opts.nodeServer.removeListener('error', reject); resolve(); });
  });
  fs.chmodSync(inner, 0o600);
  active = true;

  // Placeholder until the screen socket lands: echo, the first message standing in for the hello, so the
  // handshake, framing and the lib/ws.js limits can be proven on this adapter.
  const ws = opts.websocket || bunWs.websocket((conn) => {
    conn.on('message', (m) => { conn.markHello(); conn.send(m); });
  });
  const serveOpts = {
    idleTimeout: 0,   // SSE and WS keep their own heartbeats
    websocket: ws,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (String(req.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
        if (url.pathname === WS_PATH && server.upgrade(req, { data: { path: url.pathname } })) return undefined;
        return new Response('not found', { status: 404 });
      }
      const ip = server.requestIP(req);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      let up;
      try {
        up = await innerRequest(inner, req, url, forwardHeaders(req, ip && ip.address), hasBody);
      } catch (_) {
        return new Response('bad gateway', { status: 502 });
      }
      const h = new Headers();
      const raw = up.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) if (!HOP.includes(raw[i].toLowerCase())) h.append(raw[i], raw[i + 1]);
      const empty = req.method === 'HEAD' || up.statusCode === 204 || up.statusCode === 304;
      if (empty) up.resume();
      return new Response(empty ? null : pullFrom(up), { status: up.statusCode, statusText: up.statusMessage, headers: h });
    },
  };

  let bun = null;
  let result;
  if (opts.unix) {
    const adapter = {
      once() {}, removeListener() {},
      listen(p, cb) { bun = Bun.serve({ ...serveOpts, unix: p }); cb(); },
    };
    result = await opts.listenUnix(adapter, opts.unix);
  } else {
    bun = Bun.serve({ ...serveOpts, port: opts.port, hostname: opts.host });
  }

  let stopping = null;
  // Stop accepting at once; whatever is still open is closed CLOSE_AFTER_MS later.
  function shutdown() {
    if (stopping) return stopping;
    stopping = Promise.resolve(bun.stop(false)).catch(() => {});
    setTimeout(() => { try { bun.stop(true); } catch (_) {} }, CLOSE_AFTER_MS).unref();
    return stopping;
  }
  return { port: opts.unix ? null : bun.port, result, shutdown, innerSocket: inner };
}

module.exports = { isBun, start, peerAddress, WS_PATH, CLOSE_AFTER_MS };
