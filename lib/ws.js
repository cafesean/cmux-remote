'use strict';
// p43 HMXV-002: zero-dependency RFC 6455 server side for node:http 'upgrade' (the Node path; the Bun-compiled
// server cannot use 'upgrade', see test/p43-bun-ws.test.js). Text + binary messages, fragmentation, ping/pong,
// close codes, and bufferedAmount for backpressure. Clients must mask; the server never masks.
// Limits (options, defaults in DEFAULTS): client->server frame payload and reassembled message 64 KiB (1009, checked
// from the header before buffering), fragment set lifetime 2 s (1002), invalid UTF-8 text (1007), hello deadline 5 s
// after the 101 (1008; the caller ends it with markHello()). Server->client messages up to 4 MiB, sent as 1 MiB fragments.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const { TextDecoder } = require('util');

const KiB = 1024, MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  maxFramePayload: 64 * KiB,   // one client frame
  maxMessage: 64 * KiB,        // one reassembled client message
  fragmentTimeoutMs: 2000,     // first fragment -> final fragment
  helloTimeoutMs: 5000,        // 101 -> markHello(); 0 disables
  maxSendMessage: 4 * MiB,     // one server message
  sendFragment: 1 * MiB,       // server fragment size
});
const MAX_MESSAGE = DEFAULTS.maxMessage;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeUtf8(buf) { try { return utf8.decode(buf); } catch (_) { return null; } }

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

function frame(op, payload, fin = true) {
  const len = payload.length, b0 = (fin ? 0x80 : 0) | op;
  let head;
  if (len < 126) head = Buffer.from([b0, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = b0; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = b0; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

class WebSocketConn extends EventEmitter {
  /** opts: DEFAULTS overrides, plus onHelloTimeout(conn) to replace the default 1008 close at the hello deadline. */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.parts = null; // fragmented message in progress: { op, chunks, size }
    this.limits = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) this.limits[k] = opts[k];
    this.fragTimer = null;
    this.helloTimer = null;
    if (this.limits.helloTimeoutMs > 0) {
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        if (!this.open) return;
        if (typeof opts.onHelloTimeout === 'function') opts.onHelloTimeout(this); else this._fail(1008);
      }, this.limits.helloTimeoutMs);
      if (this.helloTimer.unref) this.helloTimer.unref();
    }
    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed(1006));
    socket.on('error', () => this._closed(1006));
  }
  get bufferedAmount() { return this.socket.writableLength; }
  /** Ends the hello deadline; the caller invokes it once a valid hello has arrived. */
  markHello() { if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; } }
  /** Sends one message; above sendFragment it goes out as fragments. Throws RangeError above maxSendMessage. */
  send(data) {
    if (!this.open) return false;
    const bin = Buffer.isBuffer(data) || data instanceof Uint8Array;
    const payload = bin ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data), 'utf8');
    if (payload.length > this.limits.maxSendMessage) {
      const e = new RangeError(`WebSocket message of ${payload.length} bytes exceeds ${this.limits.maxSendMessage}`);
      e.code = 'ERR_WS_MESSAGE_TOO_BIG';
      throw e;
    }
    const op = bin ? 2 : 1, step = this.limits.sendFragment;
    if (payload.length <= step) return this.socket.write(frame(op, payload));
    let ok = true;
    for (let at = 0; at < payload.length; at += step) {
      const last = at + step >= payload.length;
      ok = this.socket.write(frame(at === 0 ? op : 0, payload.subarray(at, Math.min(at + step, payload.length)), last)) && ok;
    }
    return ok;
  }
  ping(data = Buffer.alloc(0)) { if (this.open) this.socket.write(frame(9, Buffer.from(data))); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code, 0); p.write(reason, 2);
    this.open = false;
    this._clearTimers();
    try { this.socket.end(frame(8, p)); } catch (_) {}
    this.emit('close', code, reason);
  }
  _clearTimers() {
    if (this.fragTimer) { clearTimeout(this.fragTimer); this.fragTimer = null; }
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
  }
  _closed(code) { if (!this.open) return; this.open = false; this._clearTimers(); try { this.socket.destroy(); } catch (_) {} this.emit('close', code, ''); }
  _fail(code) { this.close(code); try { this.socket.destroy(); } catch (_) {} }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(this.limits.maxFramePayload)) return this._fail(1009); len = Number(big); off = 10; }
      if (!masked) return this._fail(1002);           // RFC 6455 §5.1: client frames are masked
      if (len > this.limits.maxFramePayload) return this._fail(1009);   // checked from the header, before buffering
      if (op === 0 && this.parts && this.parts.size + len > this.limits.maxMessage) return this._fail(1009);
      if (op !== 0 && op < 8 && len > this.limits.maxMessage) return this._fail(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op >= 8) {                                   // control frames: never fragmented, <= 125 bytes
        if (!fin || len > 125) return this._fail(1002);
        if (op === 8) {
          if (payload.length === 1) return this._fail(1002);
          if (payload.length > 2 && decodeUtf8(payload.subarray(2)) === null) return this._fail(1007);
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; this.close(code === 1005 ? 1000 : code); return;
        }
        if (op === 9) { this.socket.write(frame(10, payload)); this.emit('ping', payload); continue; }
        if (op === 10) { this.emit('pong', payload); continue; }
        return this._fail(1002);
      }
      if (op === 0) {
        if (!this.parts) return this._fail(1002);
        this.parts.chunks.push(payload); this.parts.size += payload.length;
        if (fin) { const p = this.parts; this.parts = null; clearTimeout(this.fragTimer); this.fragTimer = null; this._message(p.op, Buffer.concat(p.chunks)); }
        continue;
      }
      if (op !== 1 && op !== 2) return this._fail(1002);
      if (this.parts) return this._fail(1002);
      if (fin) this._message(op, payload);
      else {
        this.parts = { op, chunks: [payload], size: payload.length };
        this.fragTimer = setTimeout(() => { this.fragTimer = null; if (this.open && this.parts) this._fail(1002); }, this.limits.fragmentTimeoutMs);
        if (this.fragTimer.unref) this.fragTimer.unref();
      }
    }
  }
  _message(op, payload) {
    if (op === 1) {
      const text = decodeUtf8(payload);
      if (text === null) return this._fail(1007);
      return this.emit('message', text, false);
    }
    this.emit('message', payload, true);
  }
}

/** Completes the handshake on (req, socket, head) from node:http 'upgrade'; returns a WebSocketConn or null (refused).
 *  opts: limit overrides (see DEFAULTS) and onHelloTimeout; the hello deadline starts with the 101. */
function accept(req, socket, head, opts = {}) {
  const bad = checkHandshake(req);
  if (bad) { refuse(socket, bad); return null; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`);
  const ws = new WebSocketConn(socket, opts);
  if (head && head.length) ws._data(head);
  return ws;
}

module.exports = { accept, refuse, checkHandshake, acceptKey, WebSocketConn, DEFAULTS, MAX_MESSAGE };
