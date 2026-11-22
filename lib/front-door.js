'use strict';
// Front door for the Bun-compiled runtime. Bun's node:http never answers a WebSocket upgrade with 101, and
// Bun.serve streams a response body without socket backpressure, so under Bun the public listener is a raw
// `net` server that only moves bytes. Per connection it peeks the first request head:
//  - an Upgrade to WS_PATH is piped to a private Bun.serve websocket server on a Unix socket (0700 dir);
//  - any other upgrade gets 404;
//  - everything else is piped to the node:http server, which listens on an internal port.
// Bytes move with stream pipe (pause/resume), so a slow client holds the node side back.
//
// Trust boundary: the node handler no longer sees the client's socket. In TCP mode node listens on a
// loopback port; the front door dials it and records its own outbound local port -> the real peer until
// that socket closes. peerAddress() looks up req.socket.remotePort: no entry (a direct local dialer, a
// Unix client) means no peer, so never local. Identity is per connection, so keep-alive keeps the peer,
// and no request header is trusted or added. In Unix-socket mode (no peer exists) node listens on a
// private Unix socket instead, so no TCP listener is opened at all.
//
// Under Node nothing here runs: peerAddress() reads the socket as before and server.js keeps 'upgrade'.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const bunWs = require('./bun-ws');

const WS_PATH = '/api/cmux/screen/ws';
const CLOSE_AFTER_MS = 5000;   // shutdown: open connections get this long after accepting stops
const MAX_HEAD = 16 * 1024;    // first request head the front door will buffer before routing
const HEAD_TIMEOUT_MS = 30000; // a client that never finishes its first head is dropped
const peers = new Map();       // our outbound local port -> real peer address ('' never stored)
let active = false;
let innerPort = 0;

const isBun = () => typeof Bun !== 'undefined' && !!(Bun && Bun.serve);

// The peer address the trust rules see, or '' when unknown.
function peerAddress(req) {
  const s = req && req.socket;
  if (!active) return (s && s.remoteAddress) || '';
  if (!s || !innerPort || s.localPort !== innerPort) return '';
  const a = s.remoteAddress;
  if (a !== '127.0.0.1' && a !== '::ffff:127.0.0.1') return '';
  return peers.get(s.remotePort) || '';
}

const NOT_FOUND = 'HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot found';
const TOO_BIG = 'HTTP/1.1 431 Request Header Fields Too Large\r\ncontent-length: 0\r\nconnection: close\r\n\r\n';
const BAD_GW = 'HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: 11\r\nconnection: close\r\n\r\nbad gateway';

// Route from the first request head: 'ws' | 'notfound' | 'node'.
function route(head) {
  const lines = head.split('\r\n');
  const m = /^[A-Z]+ (\S+) HTTP\/1\.[01]$/.exec(lines[0] || '');
  let upgrade = false;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c > 0 && lines[i].slice(0, c).trim().toLowerCase() === 'upgrade') upgrade = true;
  }
  if (!upgrade) return 'node';
  let p = '';
  try { p = m ? new URL(m[1], 'http://x').pathname : ''; } catch (_) { p = ''; }
  return p === WS_PATH ? 'ws' : 'notfound';
}

// Both directions with backpressure; either side closing tears down the other.
function splice(a, b) {
  a.pipe(b); b.pipe(a);
  const kill = () => { a.destroy(); b.destroy(); };
  a.on('error', kill); b.on('error', kill);
  a.on('close', kill); b.on('close', kill);
}

function privateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-front-'));
  fs.chmodSync(dir, 0o700);
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return dir;
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => { server.removeListener('error', reject); resolve(); });
  });
}

// opts: { nodeServer, port, host } or { nodeServer, unix, listenUnix } (lib/unix-listen.listenUnix, so
// the public socket gets the same directory/stale/0600 checks as before). Optional websocket handlers.
// Resolves { port, result, shutdown, innerPort, innerSocket }.
async function start(opts) {
  const dir = privateDir();
  let nodeTarget;
  if (opts.unix) {
    const inner = path.join(dir, 'node.sock');
    await listen(opts.nodeServer, inner);
    fs.chmodSync(inner, 0o600);
    nodeTarget = { path: inner };
  } else {
    await listen(opts.nodeServer, 0, '127.0.0.1');
    innerPort = opts.nodeServer.address().port;
    nodeTarget = { host: '127.0.0.1', port: innerPort };
  }
  active = true;
  // The front door routes on a connection's first request head only. A later Upgrade on a keep-alive
  // connection already piped here reaches node:http, which under Bun never answers it and cannot write
  // on the raw upgrade socket; a ServerResponse bound to that socket can, so it gets 404 and the socket ends.
  // Bun's node:http writes the body on a HEAD response, which breaks the client's next response on a
  // keep-alive connection; node suppresses it. Drop HEAD body bytes before they reach Bun.
  opts.nodeServer.prependListener('request', (req, res) => {
    if (req.method !== 'HEAD') return;
    const end = res.end;
    res.write = (chunk, enc, cb) => { const f = typeof enc === 'function' ? enc : cb; if (f) process.nextTick(f); return true; };
    res.end = (chunk, enc, cb) => {
      const f = typeof chunk === 'function' ? chunk : typeof enc === 'function' ? enc : cb;
      if (!res.headersSent && !res.hasHeader('content-length') && chunk && typeof chunk !== 'function') res.setHeader('content-length', Buffer.byteLength(chunk, typeof enc === 'string' ? enc : undefined));
      return f ? end.call(res, f) : end.call(res);
    };
  });
  opts.nodeServer.on('upgrade', (req, socket) => {
    const http = require('http');
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.shouldKeepAlive = false;
    res.writeHead(404, { 'content-type': 'text/plain', 'content-length': 9, connection: 'close' });
    res.end('not found', () => socket.end());
  });

  // Placeholder until the screen socket lands: echo, the first message standing in for the hello, so the
  // handshake, framing and the lib/ws.js limits can be proven on this adapter.
  const ws = opts.websocket || bunWs.websocket((conn) => {
    conn.on('message', (m) => { conn.markHello(); conn.send(m); });
  });
  const wsSock = path.join(dir, 'ws.sock');
  const bun = Bun.serve({
    unix: wsSock,
    idleTimeout: 0,
    websocket: ws,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === WS_PATH && server.upgrade(req, { data: { path: url.pathname } })) return undefined;
      return new Response('not found', { status: 404 });
    },
  });
  fs.chmodSync(wsSock, 0o600);

  const open = new Set();
  const front = net.createServer({ pauseOnConnect: false }, (client) => {
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => client.destroy());
    const peer = opts.unix ? '' : (client.remoteAddress || '');
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > MAX_HEAD) { clearTimeout(timer); client.removeListener('data', onData); client.end(TOO_BIG); }
        return;
      }
      clearTimeout(timer);
      client.removeListener('data', onData);
      const where = route(buf.toString('latin1', 0, end));
      if (where === 'notfound') { client.end(NOT_FOUND); client.resume(); return; }
      client.pause();
      const up = net.connect(where === 'ws' ? { path: wsSock } : nodeTarget);
      open.add(up);
      let port = 0, connected = false;
      up.once('connect', () => {
        connected = true;
        if (where === 'node' && !opts.unix) { port = up.localPort; if (peer) peers.set(port, peer); }
        up.write(buf); buf = null;
        splice(client, up);
        client.resume();
      });
      up.once('error', () => { if (!connected) client.end(BAD_GW); });
      up.on('close', () => { open.delete(up); if (port && peers.get(port) === peer) peers.delete(port); });
    };
    client.on('data', onData);
  });

  let result;
  if (opts.unix) result = await opts.listenUnix(front, opts.unix);
  else await listen(front, opts.port, opts.host);

  let stopping = null;
  // Stop accepting at once; whatever is still open is closed CLOSE_AFTER_MS later.
  function shutdown() {
    if (stopping) return stopping;
    stopping = new Promise((r) => front.close(() => r()));
    setTimeout(() => {
      for (const s of open) s.destroy();
      try { bun.stop(true); } catch (_) {}
    }, CLOSE_AFTER_MS).unref();
    return stopping;
  }
  return { port: opts.unix ? null : front.address().port, result, shutdown, innerPort: innerPort || null, innerSocket: nodeTarget.path || null };
}

module.exports = { isBun, start, peerAddress, WS_PATH, CLOSE_AFTER_MS };
