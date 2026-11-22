'use strict';
// A GET over a raw net/tls socket, for the download relay under the Bun-compiled runtime.
//
// Bun's node:http client reads a response body ahead without bound: a paused IncomingMessage kept
// taking bytes off the socket (measured ~40 MB buffered for a slow 50 MB reader), and Bun's fetch does
// the same. A net/tls socket does stop reading while paused, so this sends one HTTP/1.1 request with
// `connection: close` and hands back the body as a Readable whose _read resumes the socket, so a slow
// client holds the bridge back. Body framing: chunked, content-length, or until EOF.
// Resolves { statusCode, headers (lower-case keys), ...Readable }, the slice of IncomingMessage the
// download relay uses. Abort before the head rejects; after it the body errors.
const net = require('net');
const tls = require('tls');
const { Readable } = require('stream');

const MAX_HEAD = 64 * 1024;
const MAX_CHUNK_LINE = 4096;
const HIGH_WATER = 256 * 1024;

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

function parseHead(text) {
  const lines = text.split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0] || '');
  if (!m) return null;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c <= 0) return null;
    const k = lines[i].slice(0, c).trim().toLowerCase();
    const v = lines[i].slice(c + 1).trim();
    headers[k] = k in headers ? headers[k] + ', ' + v : v;
  }
  return { statusCode: Number(m[1]), headers };
}

// where: { socketPath } or { url }. pathAndQuery is used for a socket; a url carries its own path.
function rawGet(where, pathAndQuery, init = {}) {
  const signal = init.signal;
  if (signal && signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let sock, host, reqPath;
    try {
      if (where.socketPath) {
        sock = net.connect({ path: where.socketPath });
        host = 'localhost'; reqPath = pathAndQuery;
      } else {
        const u = new URL(where.url);
        const hn = u.hostname.replace(/^\[|\]$/g, '');
        const secure = u.protocol === 'https:';
        const port = Number(u.port) || (secure ? 443 : 80);
        sock = secure ? tls.connect({ host: hn, port, servername: net.isIP(hn) ? undefined : hn }) : net.connect({ host: hn, port });
        host = u.host; reqPath = u.pathname + u.search;
      }
    } catch (e) { return reject(e); }
    let head = 'GET ' + reqPath + ' HTTP/1.1\r\nhost: ' + host + '\r\nconnection: close\r\n';
    for (const [k, v] of Object.entries(init.headers || {})) {
      const s = String(v);
      if (/[\r\n:]/.test(k) || /[\r\n]/.test(s)) { sock.destroy(); return reject(new Error('bad header')); }
      head += k + ': ' + s + '\r\n';
    }
    sock.write(head + '\r\n');

    let body = null, settled = false;
    let buf = Buffer.alloc(0);
    // body framing state
    let mode = 'eof', left = 0, chunkState = 'size', done = false;
    const fail = (e) => {
      sock.destroy();
      if (!settled) { settled = true; reject(e); } else if (body && !body.destroyed) body.destroy(e);
    };
    const onAbort = () => fail(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const finish = () => {
      if (done) return; done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      body.push(null); sock.destroy();
    };
    const put = (b) => { if (b.length && !body.push(b)) sock.pause(); };
    // Feed body bytes through the framing.
    const feed = (d) => {
      if (done) return;
      if (mode === 'eof') return put(d);
      if (mode === 'length') {
        const take = d.subarray(0, left); left -= take.length; put(take);
        if (left === 0) finish();
        return;
      }
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (chunkState === 'size') {
          const e = buf.indexOf('\r\n');
          if (e < 0) { if (buf.length > MAX_CHUNK_LINE) fail(new Error('bad chunk')); return; }
          const n = parseInt(buf.toString('latin1', 0, e).split(';')[0].trim(), 16);
          if (!Number.isFinite(n) || n < 0) return fail(new Error('bad chunk'));
          buf = buf.subarray(e + 2);
          if (n === 0) { chunkState = 'trailer'; continue; }
          left = n; chunkState = 'data';
        } else if (chunkState === 'data') {
          if (!buf.length) return;
          const take = buf.subarray(0, left); left -= take.length; buf = buf.subarray(take.length); put(take);
          if (left === 0) chunkState = 'crlf';
        } else if (chunkState === 'crlf') {
          if (buf.length < 2) return;
          if (buf[0] !== 13 || buf[1] !== 10) return fail(new Error('bad chunk'));
          buf = buf.subarray(2); chunkState = 'size';
        } else {   // trailer lines until an empty one
          const e = buf.indexOf('\r\n');
          if (e < 0) { if (buf.length > MAX_HEAD) fail(new Error('bad chunk')); return; }
          buf = buf.subarray(e + 2);
          if (e === 0) return finish();
        }
      }
    };
    const onData = (d) => {
      if (body) return feed(d);
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      const e = buf.indexOf('\r\n\r\n');
      if (e < 0) { if (buf.length > MAX_HEAD) fail(new Error('response head too large')); return; }
      const h = parseHead(buf.toString('latin1', 0, e));
      if (!h) return fail(new Error('bad response head'));
      const rest = buf.subarray(e + 4); buf = Buffer.alloc(0);
      if (h.statusCode >= 100 && h.statusCode < 200) { if (rest.length) onData(rest); return; }
      body = new Readable({ highWaterMark: HIGH_WATER, read() { sock.resume(); },
        destroy(err, cb) { sock.destroy(); if (signal) signal.removeEventListener('abort', onAbort); cb(err); } });
      body.statusCode = h.statusCode; body.headers = h.headers;
      const te = (h.headers['transfer-encoding'] || '').toLowerCase();
      if (te.includes('chunked')) mode = 'chunked';
      else if (h.headers['content-length'] != null) {
        left = Number(h.headers['content-length']);
        if (!Number.isSafeInteger(left) || left < 0) return fail(new Error('bad content-length'));
        mode = 'length';
      }
      settled = true; resolve(body);
      if (h.statusCode === 204 || h.statusCode === 304 || (mode === 'length' && left === 0)) return finish();
      if (rest.length) feed(rest);
    };
    sock.on('data', onData);
    sock.on('end', () => {
      if (!settled) return fail(new Error('connection closed before the response head'));
      if (mode === 'eof') return finish();
      if (!done) fail(new Error('connection closed mid-body'));
    });
    sock.on('error', (e) => fail(e));
    sock.on('close', () => { if (!settled) fail(new Error('connection closed')); });
  });
}

module.exports = { rawGet };
