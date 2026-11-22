'use strict';
// p43: the Bun.serve websocket side of the screen socket, shaped like lib/ws.js's WebSocketConn so the
// screen handler is written once for both runtimes. Client->server limits are lib/ws.js DEFAULTS:
// frame and reassembled message 64 KiB (1009, enforced by Bun's maxPayloadLength before buffering),
// invalid UTF-8 text (1007, Bun's own check), hello deadline 5 s after open (1008 unless markHello()).
const { EventEmitter } = require('events');
const { DEFAULTS } = require('./ws');

class BunWebSocketConn extends EventEmitter {
  constructor(sock, opts = {}) {
    super();
    this.sock = sock;
    this.open = true;
    this.limits = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) this.limits[k] = opts[k];
    this.helloTimer = null;
    if (this.limits.helloTimeoutMs > 0) {
      this.helloTimer = setTimeout(() => {
        this.helloTimer = null;
        if (!this.open) return;
        if (typeof opts.onHelloTimeout === 'function') opts.onHelloTimeout(this); else this.close(1008);
      }, this.limits.helloTimeoutMs);
      if (this.helloTimer.unref) this.helloTimer.unref();
    }
  }
  get bufferedAmount() { return this.sock.getBufferedAmount ? this.sock.getBufferedAmount() : 0; }
  /** Ends the hello deadline; the caller invokes it once a valid hello has arrived. */
  markHello() { if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; } }
  /** Sends one message (Bun fragments nothing; maxSendMessage still applies). Returns false under backpressure. */
  send(data) {
    if (!this.open) return false;
    const bin = typeof data !== 'string';
    const size = bin ? data.byteLength : Buffer.byteLength(data);
    if (size > this.limits.maxSendMessage) {
      const e = new RangeError(`WebSocket message of ${size} bytes exceeds ${this.limits.maxSendMessage}`);
      e.code = 'ERR_WS_MESSAGE_TOO_BIG';
      throw e;
    }
    return this.sock.send(data) > 0;
  }
  ping(data) { if (this.open) this.sock.ping(data); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.open = false;
    this._clearTimers();
    try { this.sock.close(code, reason); } catch (_) {}
    this.emit('close', code, reason);
  }
  _clearTimers() { if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; } }
  _message(msg) {
    if (!this.open) return;
    if (typeof msg === 'string') this.emit('message', msg, false);
    else this.emit('message', Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength), true);
  }
  _closed(code, reason) { if (!this.open) return; this.open = false; this._clearTimers(); this.emit('close', code, reason || ''); }
}

// Bun.serve `websocket` handlers. onConn(conn, data) runs once per socket at open; data is what
// server.upgrade() was given.
function websocket(onConn, opts = {}) {
  const limits = { ...DEFAULTS, ...opts };
  return {
    maxPayloadLength: Math.min(limits.maxFramePayload, limits.maxMessage),
    idleTimeout: 0,
    open(sock) { const c = new BunWebSocketConn(sock, opts); sock.data = { ...(sock.data || {}), conn: c }; onConn(c, sock.data); },
    message(sock, msg) { if (sock.data && sock.data.conn) sock.data.conn._message(msg); },
    close(sock, code, reason) { if (sock.data && sock.data.conn) sock.data.conn._closed(code, reason); },
    ping(sock) { if (sock.data && sock.data.conn) sock.data.conn.emit('ping'); },
    pong(sock) { if (sock.data && sock.data.conn) sock.data.conn.emit('pong'); },
  };
}

module.exports = { websocket, BunWebSocketConn };
