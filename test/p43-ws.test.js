'use strict';
// p43 HMXV-002: lib/ws.js against Node's built-in WebSocket client and hand-made frames.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const ws = require('../lib/ws');

function server(onConn) {
  return new Promise((r) => { const s = http.createServer((q, res) => { res.writeHead(404); res.end(); });
    s.on('upgrade', (req, sock, head) => { const c = ws.accept(req, sock, head); if (c) onConn(c, req); });
    s.listen(0, '127.0.0.1', () => r(s)); });
}
const url = (s) => 'ws://127.0.0.1:' + s.address().port + '/api/cmux/screen/ws';

test('RFC 6455 accept key (spec example)', () => {
  assert.strictEqual(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshake checks: method, upgrade header, version, key', () => {
  const base = { method: 'GET', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
  assert.strictEqual(ws.checkHandshake(base), null);
  assert.strictEqual(ws.checkHandshake({ ...base, method: 'POST' }), 405);
  assert.strictEqual(ws.checkHandshake({ ...base, headers: { ...base.headers, 'sec-websocket-version': '8' } }), 426);
  assert.strictEqual(ws.checkHandshake({ ...base, headers: { ...base.headers, 'sec-websocket-key': 'short' } }), 400);
  assert.strictEqual(ws.checkHandshake({ ...base, headers: { ...base.headers, upgrade: 'h2c' } }), 400);
});

test('text + 1 MB binary echo with a real client; server ping gets a pong', { skip: typeof WebSocket !== 'function' }, async () => {
  let pong = false;
  const s = await server((c) => { c.on('message', (m) => c.send(m)); c.on('pong', () => { pong = true; }); setTimeout(() => c.ping('x'), 20); });
  const cl = new WebSocket(url(s)); cl.binaryType = 'arraybuffer';
  await new Promise((r, j) => { cl.onopen = r; cl.onerror = j; });
  assert.strictEqual(await new Promise((r) => { cl.onmessage = (e) => r(e.data); cl.send('hello'); }), 'hello');
  const big = Buffer.alloc(1 << 20, 7);
  const got = await new Promise((r) => { cl.onmessage = (e) => r(Buffer.from(e.data)); cl.send(big); });
  assert.ok(got.equals(big));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(pong, 'client answered the server ping');
  cl.close(); s.close();
});

function rawClient(s) {
  return new Promise((r) => { const sock = net.connect(s.address().port, '127.0.0.1', () => {
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    sock.once('data', () => r(sock)); }); });
}
const masked = (op, payload, fin = true) => { const m = Buffer.from([1, 2, 3, 4]); const p = Buffer.from(payload); const o = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) o[i] = p[i] ^ m[i & 3];
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), m, o]); };

test('fragmented text message is joined; close frame code reaches the server', async () => {
  const msgs = []; let closed = null;
  const s = await server((c) => { c.on('message', (m) => msgs.push(m)); c.on('close', (code) => { closed = code; }); });
  const sock = await rawClient(s);
  sock.write(Buffer.concat([masked(1, 'hel', false), masked(0, 'lo', true)]));
  const cp = Buffer.alloc(2); cp.writeUInt16BE(4000, 0);
  await new Promise((r) => setTimeout(r, 50));
  sock.write(masked(8, cp));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(msgs, ['hello']); assert.strictEqual(closed, 4000);
  sock.destroy(); s.close();
});

test('unmasked client frame -> 1002 protocol error close', async () => {
  let closed = null;
  const s = await server((c) => c.on('close', (code) => { closed = code; }));
  const sock = await rawClient(s);
  sock.write(Buffer.from([0x81, 2, 0x68, 0x69]));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(closed, 1002);
  sock.destroy(); s.close();
});

test('bufferedAmount reports queued bytes', async () => {
  let conn;
  const s = await server((c) => { conn = c; });
  const sock = await rawClient(s); sock.pause();
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 64; i++) conn.send(Buffer.alloc(1 << 20));
  assert.ok(conn.bufferedAmount > 0);
  sock.destroy(); s.close();
});
