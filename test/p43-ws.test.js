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

test('text + 60 KiB binary echo and a 4 MiB server message with a real client; server ping gets a pong', { skip: typeof WebSocket !== 'function' }, async () => {
  let pong = false;
  const s = await server((c) => { c.markHello(); c.on('message', (m) => c.send(m === 'big' ? Buffer.alloc(4 << 20, 9) : m)); c.on('pong', () => { pong = true; }); setTimeout(() => c.ping('x'), 20); });
  const cl = new WebSocket(url(s)); cl.binaryType = 'arraybuffer';
  await new Promise((r, j) => { cl.onopen = r; cl.onerror = j; });
  assert.strictEqual(await new Promise((r) => { cl.onmessage = (e) => r(e.data); cl.send('hello'); }), 'hello');
  const big = Buffer.alloc(60 << 10, 7);
  const got = await new Promise((r) => { cl.onmessage = (e) => r(Buffer.from(e.data)); cl.send(big); });
  assert.ok(got.equals(big));
  const huge = await new Promise((r) => { cl.onmessage = (e) => r(Buffer.from(e.data)); cl.send('big'); });
  assert.ok(huge.equals(Buffer.alloc(4 << 20, 9)), '4 MiB fragmented message reassembled by the client');
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

// ---- client->server limits and server->client fragmentation ----
const KiB = 1024, MiB = 1024 * 1024;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Masked client frame of any length (16- and 64-bit length forms). withPayload false sends the header only. */
function mframe(op, payload, { fin = true, withPayload = true, len } = {}) {
  const p = Buffer.from(payload); const n = len === undefined ? p.length : len; const m = Buffer.from([9, 8, 7, 6]);
  let head;
  if (n < 126) head = Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | op; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
  if (!withPayload) return Buffer.concat([head, m]);
  const o = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) o[i] = p[i] ^ m[i & 3];
  return Buffer.concat([head, m, o]);
}
/** Server whose connections record messages and the close code; opts go to ws.accept. */
async function limited(opts, onConn = (c) => c.markHello()) {
  const st = { msgs: [], closed: null, conn: null };
  st.s = await new Promise((r) => { const s = http.createServer(); s.on('upgrade', (req, sock, head) => { const c = ws.accept(req, sock, head, opts);
    if (!c) return; st.conn = c; onConn(c); c.on('message', (m) => st.msgs.push(m)); c.on('close', (code) => { st.closed = code; }); }); s.listen(0, '127.0.0.1', () => r(s)); });
  st.sock = await rawClient(st.s);
  st.sock.on('error', () => {});   // the server may reset while the client is still writing an over-limit frame
  st.end = () => { st.sock.destroy(); st.s.close(); };
  return st;
}
/** Parses server->client frames (unmasked) from a raw socket. */
function frameReader(sock) {
  const frames = []; let buf = Buffer.alloc(0);
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]);
    for (;;) { if (buf.length < 2) return; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      frames.push({ fin: (buf[0] & 0x80) !== 0, op: buf[0] & 0x0f, payload: buf.subarray(off, off + len) }); buf = buf.subarray(off + len); } });
  return frames;
}

test('limit defaults match the contract', () => {
  assert.deepStrictEqual(ws.DEFAULTS, { maxFramePayload: 64 * KiB, maxMessage: 64 * KiB, fragmentTimeoutMs: 2000, helloTimeoutMs: 5000,
    maxSendMessage: 4 * MiB, sendFragment: 1 * MiB });
});

test('client frame payload: 64 KiB accepted, 64 KiB + 1 -> 1009 from the header alone', async () => {
  const st = await limited();
  st.sock.write(mframe(2, Buffer.alloc(64 * KiB, 1)));
  await wait(50);
  assert.strictEqual(st.msgs.length, 1); assert.strictEqual(st.msgs[0].length, 64 * KiB); assert.strictEqual(st.closed, null);
  st.sock.write(mframe(2, Buffer.alloc(0), { len: 64 * KiB + 1, withPayload: false }));
  await wait(50);
  assert.strictEqual(st.closed, 1009, 'refused before any payload is buffered');
  st.end();
});

test('reassembled client message: 64 KiB over fragments accepted, one byte more -> 1009', async () => {
  const st = await limited();
  st.sock.write(Buffer.concat([mframe(2, Buffer.alloc(32 * KiB), { fin: false }), mframe(0, Buffer.alloc(32 * KiB))]));
  await wait(50);
  assert.strictEqual(st.msgs.length, 1); assert.strictEqual(st.msgs[0].length, 64 * KiB); assert.strictEqual(st.closed, null);
  st.sock.write(Buffer.concat([mframe(2, Buffer.alloc(40 * KiB), { fin: false }), mframe(0, Buffer.alloc(24 * KiB + 1))]));
  await wait(50);
  assert.strictEqual(st.msgs.length, 1); assert.strictEqual(st.closed, 1009);
  st.end();
});

test('reassembled limit is checked from the continuation header, before its payload', async () => {
  const st = await limited();
  st.sock.write(Buffer.concat([mframe(2, Buffer.alloc(60 * KiB), { fin: false }), mframe(0, Buffer.alloc(0), { len: 8 * KiB, withPayload: false })]));
  await wait(50);
  assert.strictEqual(st.closed, 1009);
  st.end();
});

test('fragment set lifetime: unfinished fragments past the limit -> 1002', async () => {
  const st = await limited({ fragmentTimeoutMs: 80 });
  st.sock.write(mframe(1, 'par', { fin: false }));
  await wait(30); assert.strictEqual(st.closed, null);
  st.sock.write(mframe(0, 't', { fin: false }));   // progress does not extend the lifetime
  await wait(120);
  assert.strictEqual(st.closed, 1002); assert.deepStrictEqual(st.msgs, []);
  st.end();
});

test('fragment set finished inside the lifetime is delivered and the timer does not fire later', async () => {
  const st = await limited({ fragmentTimeoutMs: 80 });
  st.sock.write(Buffer.concat([mframe(1, 'ab', { fin: false }), mframe(0, 'cd')]));
  await wait(150);
  assert.deepStrictEqual(st.msgs, ['abcd']); assert.strictEqual(st.closed, null);
  st.end();
});

test('invalid UTF-8 text -> 1007; a code point split across fragments is valid', async () => {
  const st = await limited();
  const euro = Buffer.from('\u20ac', 'utf8');      // 3 bytes, split 1 + 2
  st.sock.write(Buffer.concat([mframe(1, euro.subarray(0, 1), { fin: false }), mframe(0, euro.subarray(1))]));
  await wait(50);
  assert.deepStrictEqual(st.msgs, ['\u20ac']); assert.strictEqual(st.closed, null);
  st.sock.write(mframe(1, Buffer.from([0x68, 0xc3, 0x28])));
  await wait(50);
  assert.strictEqual(st.msgs.length, 1); assert.strictEqual(st.closed, 1007);
  st.end();
});

test('invalid UTF-8 in a fragmented text message -> 1007', async () => {
  const st = await limited();
  st.sock.write(Buffer.concat([mframe(1, 'ok', { fin: false }), mframe(0, Buffer.from([0xed, 0xa0, 0x80]))]));   // UTF-16 surrogate
  await wait(50);
  assert.strictEqual(st.closed, 1007); assert.deepStrictEqual(st.msgs, []);
  st.end();
});

test('hello deadline: no markHello() within the limit -> 1008', async () => {
  const st = await limited({ helloTimeoutMs: 80 }, () => {});
  await wait(30); assert.strictEqual(st.closed, null);
  await wait(100);
  assert.strictEqual(st.closed, 1008);
  st.end();
});

test('hello deadline: markHello() in time keeps the socket open; the onHelloTimeout hook can replace the close', async () => {
  const st = await limited({ helloTimeoutMs: 80 }, (c) => setTimeout(() => c.markHello(), 20));
  await wait(150);
  assert.strictEqual(st.closed, null); st.end();
  let hooked = 0;
  const st2 = await limited({ helloTimeoutMs: 50, onHelloTimeout: (c) => { hooked++; c.close(1008, 'hello'); } }, () => {});
  await wait(120);
  assert.strictEqual(hooked, 1); assert.strictEqual(st2.closed, 1008);
  st2.end();
});

test('server message over 1 MiB goes out as 1 MiB fragments; 4 MiB is the max, more throws', async () => {
  const st = await limited();
  const frames = frameReader(st.sock);
  const msg = Buffer.alloc(4 * MiB); for (let i = 0; i < msg.length; i++) msg[i] = i & 0xff;
  st.conn.send(msg);
  await wait(200);
  assert.strictEqual(frames.length, 4);
  assert.deepStrictEqual(frames.map((f) => [f.op, f.fin, f.payload.length]), [[2, false, MiB], [0, false, MiB], [0, false, MiB], [0, true, MiB]]);
  assert.ok(Buffer.concat(frames.map((f) => f.payload)).equals(msg));
  st.conn.send('x'.repeat(MiB + 1));
  await wait(100);
  assert.deepStrictEqual(frames.slice(4).map((f) => [f.op, f.fin, f.payload.length]), [[1, false, MiB], [0, true, 1]]);
  assert.throws(() => st.conn.send(Buffer.alloc(4 * MiB + 1)), (e) => e instanceof RangeError && e.code === 'ERR_WS_MESSAGE_TOO_BIG');
  assert.strictEqual(st.closed, null);
  st.end();
});
