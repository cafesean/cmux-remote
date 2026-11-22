'use strict';
// p43 HMXV-001: node:http 'upgrade' + raw socket writes work in a `bun build --compile` binary (the shipped
// server is Bun-compiled). A tiny RFC 6455 echo server is compiled and driven by Node's WebSocket client.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const BUN = [process.env.BUN_BIN, path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun'].find((p) => p && fs.existsSync(p));

const SERVER = String.raw`
const http = require('http'); const crypto = require('crypto');
const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
srv.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15; let len = buf[1] & 127; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); const body = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
      let h;
      if (body.length < 126) h = Buffer.from([0x80 | op, body.length]);
      else if (body.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(body.length, 2); }
      else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(body.length), 2); }
      sock.write(Buffer.concat([h, body]));
    }
  });
});
srv.listen(0, '127.0.0.1', () => console.log('PORT ' + srv.address().port));
`;

async function echoRoundTrip(cmd, args, d) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((res, rej) => { child.stdout.on('data', (b) => { const m = /PORT (\d+)/.exec(String(b)); if (m) res(Number(m[1])); }); child.on('exit', rej); });
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/cmux/screen/ws');
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no 101')); });
    const big = Buffer.alloc(1024 * 1024); for (let i = 0; i < big.length; i++) big[i] = i & 255;
    const got = await new Promise((res) => { ws.onmessage = (e) => res(Buffer.from(e.data)); ws.send(big); });
    assert.strictEqual(got.length, big.length); assert.ok(got.equals(big));
    const txt = await new Promise((res) => { ws.onmessage = (e) => res(e.data); ws.send('{"t":"ping"}'); });
    assert.strictEqual(txt, '{"t":"ping"}');
    ws.close();
  } finally { child.kill(); fs.rmSync(d, { recursive: true, force: true }); }
}
const fixture = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p43-bunws-')); fs.writeFileSync(path.join(d, 'ws-echo.js'), SERVER); return d; };

test('node: node:http upgrade + 1 MB binary echo (control)', { skip: typeof WebSocket !== 'function' }, async () => {
  const d = fixture(); await echoRoundTrip(process.execPath, [path.join(d, 'ws-echo.js')], d);
});

// HMXV-001 finding (2026-11-22, Bun 1.3.11): under Bun the 'upgrade' handshake never completes (client times out),
// compiled or not. The shipped Bridge server is Bun-compiled, so the video socket cannot ride node:http 'upgrade'
// there; see the p43 implementation.md decision. Kept as a todo probe so a Bun upgrade that fixes it shows up.
test('bun-compiled: node:http upgrade + 1 MB binary echo', { skip: !BUN || typeof WebSocket !== 'function', todo: 'Bun 1.3.11: node:http upgrade does not complete', timeout: 60000 }, async () => {
  const d = fixture();
  execFileSync(BUN, ['build', '--compile', path.join(d, 'ws-echo.js'), '--outfile', path.join(d, 'ws-echo')], { stdio: 'pipe' });
  await Promise.race([echoRoundTrip(path.join(d, 'ws-echo'), [], d), new Promise((_, rej) => setTimeout(() => rej(new Error('no 101 within 10 s')), 10000))]);
});
