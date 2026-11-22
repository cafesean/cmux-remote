'use strict';
// p43 HMXV-002: zero-dependency RFC 6455 server side for node:http 'upgrade' (the Node path; the Bun-compiled
// server cannot use 'upgrade', see test/p43-bun-ws.test.js). Text + binary messages, fragmentation, ping/pong,
// close codes, and bufferedAmount for backpressure. Clients must mask; the server never masks.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

function acceptKey(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }

/** Validates the upgrade request; returns null when it is a usable RFC 6455 handshake, else an HTTP status. */
function checkHandshake(req) {
  if (req.method !== 'GET') return 405;
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return 400;
  if (!/\bupgrade\b/i.test(String(req.headers.connection || ''))) return 400;
  if (String(req.headers['sec-websocket-version'] || '') !== '13') return 426;
  const key = String(req.headers['sec-websocket-key'] || '');
  if (Buffer.from(key, 'base64').length !== 16) return 400;
  return null;
}

/** Refuses an upgrade with a plain HTTP status on the raw socket. */
function refuse(socket, status, body = '') {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 426: 'Upgrade Required', 503: 'Service Unavailable' }[status] || 'Error';
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); } catch (_) {}
}

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

class WebSocketConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.parts = null; // fragmented message in progress: { op, chunks, size }
    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed(1006));
    socket.on('error', () => this._closed(1006));
  }
  get bufferedAmount() { return this.socket.writableLength; }
  send(data) {
    if (!this.open) return false;
    const bin = Buffer.isBuffer(data) || data instanceof Uint8Array;
    return this.socket.write(frame(bin ? 2 : 1, bin ? Buffer.from(data) : Buffer.from(String(data), 'utf8')));
  }
  ping(data = Buffer.alloc(0)) { if (this.open) this.socket.write(frame(9, Buffer.from(data))); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code, 0); p.write(reason, 2);
    this.open = false;
    try { this.socket.end(frame(8, p)); } catch (_) {}
    this.emit('close', code, reason);
  }
  _closed(code) { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch (_) {} this.emit('close', code, ''); }
  _fail(code) { this.close(code); try { this.socket.destroy(); } catch (_) {} }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) return this._fail(1009); len = Number(big); off = 10; }
      if (!masked) return this._fail(1002);           // RFC 6455 §5.1: client frames are masked
      if (len > MAX_MESSAGE) return this._fail(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op >= 8) {                                   // control frames: never fragmented, <= 125 bytes
        if (!fin || len > 125) return this._fail(1002);
        if (op === 8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; this.close(code === 1005 ? 1000 : code); return; }
        if (op === 9) { this.socket.write(frame(10, payload)); this.emit('ping', payload); continue; }
        if (op === 10) { this.emit('pong', payload); continue; }
        return this._fail(1002);
      }
      if (op === 0) {
        if (!this.parts) return this._fail(1002);
        this.parts.chunks.push(payload); this.parts.size += payload.length;
        if (this.parts.size > MAX_MESSAGE) return this._fail(1009);
        if (fin) { const p = this.parts; this.parts = null; this._message(p.op, Buffer.concat(p.chunks)); }
        continue;
      }
      if (op !== 1 && op !== 2) return this._fail(1002);
      if (this.parts) return this._fail(1002);
      if (fin) this._message(op, payload);
      else this.parts = { op, chunks: [payload], size: payload.length };
    }
  }
  _message(op, payload) { this.emit('message', op === 1 ? payload.toString('utf8') : payload, op === 2); }
}

/** Completes the handshake on (req, socket, head) from node:http 'upgrade'; returns a WebSocketConn or null (refused). */
function accept(req, socket, head) {
  const bad = checkHandshake(req);
  if (bad) { refuse(socket, bad); return null; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`);
  const ws = new WebSocketConn(socket);
  if (head && head.length) ws._data(head);
  return ws;
}

module.exports = { accept, refuse, checkHandshake, acceptKey, WebSocketConn, MAX_MESSAGE };
