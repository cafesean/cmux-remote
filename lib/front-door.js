'use strict';
// Front door for the Bun-compiled runtime. Bun's node:http never answers a WebSocket upgrade with 101, and
// Bun.serve streams a response body without socket backpressure, so under Bun the public listener is a raw
// `net` server that only moves bytes. Per connection it peeks the first request head:
//  - an Upgrade to WS_PATH is piped to a private Bun.serve websocket server (loopback port in TCP mode, a
//    Unix socket in a 0700 dir otherwise), whose fetch runs the screen socket's gate before any 101;
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

const WS_PATH = '/api/cmux/screen/ws';
const CLOSE_AFTER_MS = 5000;   // shutdown: open connections get this long after accepting stops
const MAX_HEAD = 16 * 1024;    // first request head the front door will buffer before routing
const HEAD_TIMEOUT_MS = 30000; // a client that never finishes its first head is dropped
const peers = new Map();       // '<inner port>:<our outbound local port>' -> real peer address ('' never stored)
let active = false;
let innerPort = 0;             // node:http's loopback port
let wsPort = 0;                // the Bun.serve websocket's loopback port (TCP mode)

const isBun = () => typeof Bun !== 'undefined' && !!(Bun && Bun.serve);

// The peer address the trust rules see, or '' when unknown.
function peerAddress(req) {
  const s = req && req.socket;
  if (!active) return (s && s.remoteAddress) || '';
  if (!s || !s.localPort || (s.localPort !== innerPort && s.localPort !== wsPort)) return '';
  const a = s.remoteAddress;
  if (a !== '127.0.0.1' && a !== '::ffff:127.0.0.1') return '';
  return peers.get(s.localPort + ':' + s.remotePort) || '';
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

// p41 D303 ("slow to answer" while /healthz answers): behind this door, Bun's node:http emits neither req nor res
// 'close' when the client goes away; only req.destroyed and res.socket.destroyed flip. Every handler that frees
// something on 'close' leaked: thread-stream slots (cap 32, then 429 too_many_streams on every pane), their
// tail and join pollers, graceful's SSE set, proxy aborts. Node emits res 'close' after 'finish' or a lost
// socket, and req 'close' with it; this gives the handlers the same two events, once each.
const GONE_POLL_MS = 1000;
function watchGone(req, res, pollMs = GONE_POLL_MS) {
  let reqClosed = false, resClosed = false, done = false;
  req.once('close', () => { reqClosed = true; });
  res.once('close', () => { resClosed = true; });
  const gone = () => !!(req.destroyed || (res.socket && res.socket.destroyed));
  const fire = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (!resClosed) { resClosed = true; res.emit('close'); }
    if (!reqClosed) { reqClosed = true; req.emit('close'); }
  };
  const timer = setInterval(() => { if (resClosed && reqClosed) { done = true; clearInterval(timer); } else if (gone()) fire(); }, pollMs);
  if (timer.unref) timer.unref();
  res.once('finish', () => setImmediate(fire));
  return { fire, gone };
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

// The fetch Request a Bun.serve upgrade sees -> the node-like req the auth/plan gates read. The peer is the
// hop's socket (Bun's requestIP); peerAddress() maps it back through the port map like a node request.
function nodeLikeReq(req, server) {
  const u = new URL(req.url);
  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let ip = null; try { ip = server.requestIP(req); } catch (_) { ip = null; }
  return { method: req.method, url: u.pathname + u.search, headers,
    socket: { remoteAddress: (ip && ip.address) || '', remotePort: (ip && ip.port) || 0, localPort: wsPort || 0 } };
}

// opts: { nodeServer, port, host } or { nodeServer, unix, listenUnix } (lib/unix-listen.listenUnix, so
// the public socket gets the same directory/stale/0600 checks as before).
// The screen socket: { websocket, wsGate } together (lib/bun-ws.websocket handlers; wsGate(nodeLikeReq) ->
// { ctx } | { refusal: { status, body } }). ctx reaches the websocket's onConn as data.gate. Without them the
// screen path answers 404 like any other upgrade: there is no default handler.
// Resolves { port, result, shutdown, innerPort, innerSocket, wsPort }.
async function start(opts) {
  if (!!opts.websocket !== !!opts.wsGate) throw new Error('front-door: websocket and wsGate go together');
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
  opts.nodeServer.prependListener('request', (req, res) => watchGone(req, res));
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

  // The screen socket: a private Bun.serve. Every upgrade runs wsGate first (auth, plan, machine); a refusal
  // is an HTTP status before any 101. TCP mode listens on loopback so the hop's port names the real peer
  // (same port map as node); Unix mode has no peer and keeps a 0600 socket in the private dir.
  let bun = null, wsTarget = null;
  if (opts.websocket) {
    const gate = opts.wsGate;
    const conf = {
      idleTimeout: 0,
      websocket: opts.websocket,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname !== WS_PATH) return new Response('not found', { status: 404 });
        let r;
        try { r = await gate(nodeLikeReq(req, server)); } catch (_) { r = null; }
        if (!r || !r.ctx) {
          const ref = (r && r.refusal) || { status: 500, body: { error: 'internal' } };
          return new Response(JSON.stringify(ref.body || {}), { status: ref.status || 403, headers: { 'content-type': 'application/json', connection: 'close' } });
        }
        if (server.upgrade(req, { data: { path: url.pathname, gate: r.ctx } })) return undefined;
        return new Response(JSON.stringify({ error: 'upgrade_required' }), { status: 426, headers: { 'content-type': 'application/json' } });
      },
    };
    if (opts.unix) {
      const wsSock = path.join(dir, 'ws.sock');
      bun = Bun.serve({ ...conf, unix: wsSock });
      fs.chmodSync(wsSock, 0o600);
      wsTarget = { path: wsSock };
    } else {
      bun = Bun.serve({ ...conf, hostname: '127.0.0.1', port: 0 });
      wsPort = bun.port;
      wsTarget = { host: '127.0.0.1', port: wsPort };
    }
  }

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
      let where = route(buf.toString('latin1', 0, end));
      if (where === 'ws' && !wsTarget) where = 'notfound';
      if (where === 'notfound') { client.end(NOT_FOUND); client.resume(); return; }
      client.pause();
      const target = where === 'ws' ? wsTarget : nodeTarget;
      const up = net.connect(target);
      open.add(up);
      let port = 0, connected = false;
      up.once('connect', () => {
        connected = true;
        if (!opts.unix) { port = target.port + ':' + up.localPort; if (peer) peers.set(port, peer); }
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
      try { if (bun) bun.stop(true); } catch (_) {}
    }, CLOSE_AFTER_MS).unref();
    return stopping;
  }
  return { port: opts.unix ? null : front.address().port, result, shutdown, innerPort: innerPort || null, innerSocket: nodeTarget.path || null, wsPort: wsPort || null };
}

module.exports = { isBun, start, peerAddress, watchGone, WS_PATH, CLOSE_AFTER_MS, GONE_POLL_MS };
