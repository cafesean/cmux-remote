'use strict';
// p43 HMXV-013: the Bun.serve front door on the compiled runtime. server.js is built with
// `bun build --compile` and driven over TCP and over SERVER_SOCKET; a stub bridge stands in for cmux.
// P43_QUIET_SSE_MS shortens the quiet-SSE hold (default 120000, the contract value); P43_SLOW_MS shortens
// the slow-upstream first-byte delay (default 30000, the contract value).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUN = [process.env.BUN_BIN, path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun'].find((p) => p && fs.existsSync(p));
const QUIET_MS = Number(process.env.P43_QUIET_SSE_MS) || 120000;
const SLOW_MS = Number(process.env.P43_SLOW_MS) || 30000;
const BIG = 50 * 1024 * 1024;
const net = require('net');
const crypto = require('crypto');

function stubBridge() {
  const s = { closes: [] };
  s.server = http.createServer((req, res) => {
    if (req.url.startsWith('/cmux/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hi\n\n');
      req.on('close', () => s.closes.push(Date.now()));
      return;
    }
    if (req.url.startsWith('/cmux/fs/download')) {
      const p = new URL(req.url, 'http://x').searchParams.get('path');
      if (p === 'slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('slow-ok'); }, SLOW_MS); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BIG) });
      const chunk = Buffer.alloc(64 * 1024, 7); let sent = 0;
      const pump = () => { while (sent < BIG) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
      return pump();
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.base = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
}

function boot(cmd, args, env, socket) {
  const child = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: env.HOME, TMPDIR: os.tmpdir(), HYPERMUX_PKG_ROOT: ROOT, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no listen line\n' + out)), 15000);
    child.stdout.on('data', () => {
      const m = socket ? /server on unix:(\S+) with/.exec(out) : /server on http:\/\/[^:\s]+:(\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve({ child, port: Number(m[1]), log: () => out }); }
    });
    child.on('exit', (c) => reject(new Error(`exited ${c}\n${out}`)));
  });
}

// One request over TCP or a unix socket; resolves { status, body, headers }.
function req(where, p, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const o = typeof where === 'number' ? { host: '127.0.0.1', port: where } : { socketPath: where };
    const r = http.request({ ...o, path: p, method, headers: { host: '127.0.0.1', ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject); r.end();
  });
}

// Raw RFC 6455 client: handshake, then the given masked frames; resolves the server's close code
// (or 'end' when the socket closed without one) and the ms it took.
function rawWs(port, frames, { wait = 8000 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const t0 = Date.now(); let buf = Buffer.alloc(0), up = false, done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve({ ...v, ms: Date.now() - t0 }); };
    setTimeout(() => fin({ code: 'timeout' }), wait);
    s.on('connect', () => s.write('GET /api/cmux/screen/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        if (!/^HTTP\/1.1 101/.test(buf.toString('latin1', 0, 12))) return fin({ code: 'no101' });
        up = true; buf = buf.subarray(i + 4);
        for (const f of frames) s.write(f);
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 0x0f, pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        if (op === 8) return fin({ code: pl.length >= 2 ? pl.readUInt16BE(0) : 1005 });
      }
    });
    s.on('close', () => fin({ code: 'end' })); s.on('error', () => fin({ code: 'error' }));
  });
}
function maskedFrame(op, payload, fin = true) {
  const len = payload.length, mask = crypto.randomBytes(4);
  let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
const rss = (pid) => { try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024; } catch (_) { return 0; } };
async function ticket(port, p) {
  const ms = JSON.parse((await req(port, '/api/machines')).body);
  const list = Array.isArray(ms) ? ms : (ms.machines || ms.data || []);
  const id = (list[0] && (list[0].id || list[0].machine)) || '';
  const r = await req(port, `/api/cmux/fs/download-ticket?machine=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`);
  assert.strictEqual(r.status, 200, r.body);
  return JSON.parse(r.body).ticket;
}

function wsOpen(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve({ ok: true, ws });
    ws.onerror = () => resolve({ ok: false });
  });
}

test('front door on the compiled runtime', { skip: !BUN && 'bun not installed', timeout: QUIET_MS + SLOW_MS + 120000 }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p43-front-')));
  const bin = path.join(tmp, 'srv');
  execFileSync(BUN, ['build', '--compile', path.join(ROOT, 'server.js'), '--outfile', bin], { cwd: ROOT, stdio: 'pipe' });
  const up = await stubBridge();
  const env = { HOME: tmp, CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: 's3', CMUX_MACHINE_LABEL: 'stub', PORT: '0', HOST: '127.0.0.1' };
  const bun = await boot(bin, [], env);
  const node = await boot(process.execPath, [path.join(ROOT, 'server.js')], { ...env, HOME: fs.mkdtempSync(path.join(tmp, 'n-')) });
  t.after(() => { bun.child.kill('SIGKILL'); node.child.kill('SIGKILL'); up.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  // The internal node port: the compiled process's other TCP listener.
  const innerPort = () => {
    const out = execFileSync('lsof', ['-a', '-p', String(bun.child.pid), '-iTCP', '-sTCP:LISTEN', '-P', '-Fn'], { encoding: 'utf8' });
    const ps = [...out.matchAll(/^n\S*:(\d+)$/gm)].map((m) => Number(m[1])).filter((p) => p !== bun.port);
    return ps[0];
  };

  // Started now, checked last: a quiet SSE must survive QUIET_MS through the front door.
  const quiet = new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: bun.port, path: '/api/cmux/stream?machine=&surface=q' }, (res) => {
      const t0 = Date.now(); let ended = null;
      res.on('data', () => {}); res.on('close', () => { ended = Date.now() - t0; });
      setTimeout(() => { resolve({ status: res.statusCode, ended }); r.destroy(); }, QUIET_MS);
    });
    r.on('error', (e) => resolve({ error: e.message }));
  });

  await t.test('loopback request is local', async () => {
    const r = await req(bun.port, '/api/pair/hello');
    assert.strictEqual(r.status, 200, r.body);
  });

  await t.test('tunnel-shaped request with spoofed X-Forwarded-For / x-hm-peer / x-hm-front is not local', async () => {
    for (const h of [
      { 'x-forwarded-for': '127.0.0.1', 'x-hm-peer': '127.0.0.1' },
      { 'cf-connecting-ip': '127.0.0.1', 'x-hm-peer': '::1', 'x-hm-front': '0'.repeat(64) },
    ]) {
      const r = await req(bun.port, '/api/pair/hello', { headers: h });
      assert.strictEqual(r.status, 403, JSON.stringify(h) + r.body);
    }
    // x-hm-* carry no meaning any more: harmless on a real loopback client, worthless on the internal port
    const ok = await req(bun.port, '/api/pair/hello', { headers: { 'x-hm-peer': '203.0.113.9', 'x-hm-front': 'guess' } });
    assert.strictEqual(ok.status, 200, ok.body);
    const inner = await req(innerPort(), '/api/pair/hello', { headers: { 'x-hm-peer': '127.0.0.1', 'x-hm-front': '0'.repeat(64) } });
    assert.strictEqual(inner.status, 403, inner.body);
  });

  await t.test('the node side never sees x-hm-peer / x-hm-front from the front door', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/front-door.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib/pairing.js'), 'utf8');
    assert.ok(!/x-hm-(peer|front)/.test(src), 'x-hm-peer / x-hm-front still referenced');
  });

  await t.test('direct local dialer to the internal node port is not local', async () => {
    const p = innerPort();
    assert.ok(p && p !== bun.port, 'internal port ' + p);
    const r = await req(p, '/api/pair/hello');
    assert.strictEqual(r.status, 403, r.body);
    const v = await req(p, '/api/version');
    assert.strictEqual(v.status, 200, 'the internal port still serves non-local routes');
  });

  await t.test('keep-alive: the second request on one connection keeps the peer', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const ports = [];
    const one = () => new Promise((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: bun.port, path: '/api/pair/hello', agent, headers: { host: '127.0.0.1' } }, (res) => {
        ports.push(res.socket.localPort);
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      r.on('error', reject);
    });
    const a = await one(); const b = await one(); const c = await one();
    agent.destroy();
    assert.strictEqual(new Set(ports).size, 1, 'requests did not share one connection: ' + ports);
    for (const r of [a, b, c]) assert.strictEqual(r.status, 200, r.body);
  });

  await t.test('a later upgrade on a keep-alive connection is not a websocket', async () => {
    const r = await new Promise((resolve) => {
      const s = net.connect(bun.port, '127.0.0.1');
      let buf = '';
      s.on('connect', () => s.write('GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
      s.on('data', (d) => {
        const first = !buf; buf += d;
        if (first) s.write('GET /api/cmux/screen/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      });
      setTimeout(() => { s.destroy(); resolve(buf); }, 1500);
      s.on('close', () => resolve(buf));
    });
    assert.ok(!/HTTP\/1\.1 101/.test(r), 'second-request upgrade got 101');
    assert.ok(/HTTP\/1\.1 404/.test(r), 'second-request upgrade got no 404: ' + JSON.stringify(r));
  });

  await t.test('WS handshake: 101 on the screen path, 404 elsewhere; echo round-trips', async () => {
    const a = await wsOpen(`ws://127.0.0.1:${bun.port}/api/cmux/screen/ws`);
    assert.ok(a.ok, 'no 101 on /api/cmux/screen/ws');
    const echo = await new Promise((r) => { a.ws.onmessage = (e) => r(e.data); a.ws.send('ping'); });
    assert.strictEqual(echo, 'ping'); a.ws.close();
    const raw = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: bun.port, path: '/api/cmux/other/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      r.on('response', (res) => { resolve(res.statusCode); res.resume(); });
      r.on('upgrade', () => resolve(101)); r.on('error', () => resolve('error')); r.end();
    });
    assert.strictEqual(raw, 404);
    // The same refusal on a fresh connection (routed by the front door's first-head check, not node).
    const fresh = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: bun.port, path: '/api/cmux/other/ws', agent: false, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      r.on('response', (res) => { resolve(res.statusCode); res.resume(); });
      r.on('upgrade', () => resolve(101)); r.on('error', () => resolve('error')); r.end();
    });
    assert.strictEqual(fresh, 404);
  });

  await t.test('SSE client disconnect closes the node side (upstream sees it) within 1 s', async () => {
    const before = up.closes.length;
    const t0 = await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port: bun.port, path: '/api/cmux/stream?machine=&surface=d' }, (res) => {
        res.once('data', () => { const at = Date.now(); r.destroy(); resolve(at); });
      });
    });
    const deadline = Date.now() + 3000;
    while (up.closes.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(up.closes.length > before, 'upstream never saw the close');
    assert.ok(up.closes[up.closes.length - 1] - t0 <= 1000, `close took ${up.closes[up.closes.length - 1] - t0} ms`);
  });

  await t.test('route parity: compiled front door answers like the node server', async () => {
    const paths = ['/healthz', '/api/version', '/', '/index.html', '/app.js', '/sidebar.js', '/manifest.webmanifest', '/vendor/../server.js',
      '/nope', '/api/nope', '/api/pair/hello', '/api/machines', '/api/cmux/tree?machine=x'];
    const rows = [];
    for (const p of paths) {
      const [a, b] = await Promise.all([req(bun.port, p), req(node.port, p)]);
      rows.push([p, a.status, b.status, a.headers['content-type'], b.headers['content-type']]);
    }
    // content-type compared always: the front door must not add one where node sent none.
    for (const [p, a, b, ca, cb] of rows) { assert.strictEqual(a, b, `${p}: bun ${a} node ${b}`); assert.strictEqual(ca, cb, `${p} content-type`); }
    const [ha, hb] = await Promise.all([req(bun.port, '/', { method: 'HEAD' }), req(node.port, '/', { method: 'HEAD' })]);
    assert.strictEqual(ha.status, hb.status, 'HEAD parity');
  });

  await t.test('50 MB download through the front door with bounded RSS (slow reader)', async (t3) => {
    const tk = await ticket(bun.port, 'big');
    const base = rss(bun.child.pid); let peak = base;
    const got = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: bun.port, path: '/api/cmux/fs/download?ticket=' + encodeURIComponent(tk) }, (res) => {
        let n = 0, paused = false;
        const iv = setInterval(() => { peak = Math.max(peak, rss(bun.child.pid)); }, 50);
        res.on('data', (d) => {
          n += d.length;
          // a slow reader for a while: without backpressure the rest of the file piles up in the front door
          if (!paused && n > 5 * 1024 * 1024) { paused = true; res.pause(); setTimeout(() => res.resume(), 3000); }
        });
        res.on('end', () => { clearInterval(iv); resolve({ status: res.statusCode, n }); });
        res.on('error', (e) => { clearInterval(iv); reject(e); });
      }).on('error', reject);
    });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.n, BIG);
    t3.diagnostic(`rss base ${(base / 1048576).toFixed(1)} MB, peak ${(peak / 1048576).toFixed(1)} MB`);
    assert.ok(peak - base < 64 * 1024 * 1024, `front door RSS grew ${((peak - base) / 1048576).toFixed(1)} MB for a 50 MB file`);
  });

  await t.test(`slow upstream: ${SLOW_MS} ms to first byte still answers`, { timeout: SLOW_MS + 20000 }, async () => {
    const tk = await ticket(bun.port, 'slow');
    const t0 = Date.now();
    const r = await req(bun.port, '/api/cmux/fs/download?ticket=' + encodeURIComponent(tk));
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(r.body, 'slow-ok');
    assert.ok(Date.now() - t0 >= SLOW_MS - 50);
  });

  await t.test('Bun websocket adapter enforces the lib/ws.js client limits', async (t2) => {
    const { DEFAULTS } = require('../lib/ws');
    const hello = maskedFrame(1, Buffer.from('hi'));
    const [frameBig, msgBig, badUtf8, noHello, ok] = await Promise.all([
      rawWs(bun.port, [hello, maskedFrame(2, Buffer.alloc(DEFAULTS.maxFramePayload + 1))]),
      rawWs(bun.port, [hello, maskedFrame(2, Buffer.alloc(40 * 1024), false), maskedFrame(0, Buffer.alloc(40 * 1024))]),
      rawWs(bun.port, [maskedFrame(1, Buffer.from([0xc3, 0x28]))]),
      rawWs(bun.port, [], { wait: DEFAULTS.helloTimeoutMs + 3000 }),
      rawWs(bun.port, [hello, maskedFrame(2, Buffer.alloc(DEFAULTS.maxMessage))], { wait: DEFAULTS.helloTimeoutMs + 1500 }),
    ]);
    t2.diagnostic(JSON.stringify({ frameBig, msgBig, badUtf8, noHello, ok }));
    assert.strictEqual(frameBig.code, 1009, 'frame over 64 KiB');
    assert.strictEqual(msgBig.code, 1009, 'reassembled message over 64 KiB');
    assert.strictEqual(noHello.code, 1008, 'no hello');
    assert.ok(noHello.ms >= DEFAULTS.helloTimeoutMs - 100 && noHello.ms < DEFAULTS.helloTimeoutMs + 2000, `hello deadline at ${noHello.ms} ms`);
    assert.strictEqual(ok.code, 'timeout', 'a 64 KiB message after the hello is accepted and the socket stays open');
  });

  await t.test('Bun websocket adapter: invalid UTF-8 text closes 1007', { todo: 'open: Bun 1.3 drops the TCP connection on invalid UTF-8 text before the message handler runs' }, async () => {
    const r = await rawWs(bun.port, [maskedFrame(1, Buffer.from([0xc3, 0x28]))]);
    assert.strictEqual(r.code, 1007, JSON.stringify(r));
  });

  await t.test('SERVER_SOCKET: no TCP listener, and a request over the socket is not local', async () => {
    const sdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p43s-'))); fs.chmodSync(sdir, 0o700);
    const sock = path.join(sdir, 's.sock');
    // socket mode refuses a loopback TCP bridge; a TEST-NET address is never dialled by these routes
    const s = await boot(bin, [], { ...env, CMUX_MACHINE_URL: 'http://192.0.2.1:9', HOME: fs.mkdtempSync(path.join(tmp, 's-')), SERVER_SOCKET: sock }, true);
    try {
      let lsof = '';
      try { lsof = execFileSync('lsof', ['-a', '-p', String(s.child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }).trim(); }
      catch (e) { if (e.status !== 1) throw e; /* lsof exits 1 when nothing matches */ }
      assert.strictEqual(lsof, '', 'a TCP listener is open in SERVER_SOCKET mode');
      assert.strictEqual((fs.statSync(sock).mode & 0o777), 0o600);
      const h = await req(sock, '/api/pair/hello');
      assert.strictEqual(h.status, 403, h.body);
      const v = await req(sock, '/api/version');
      assert.strictEqual(v.status, 200);
    } finally { s.child.kill('SIGKILL'); fs.rmSync(sdir, { recursive: true, force: true }); }
  });

  await t.test('SIGTERM with an open SSE ends the process within 6 s', async () => {
    const s = await boot(bin, [], { ...env, HOME: fs.mkdtempSync(path.join(tmp, 'g-')) });
    await new Promise((resolve) => { http.get({ host: '127.0.0.1', port: s.port, path: '/api/cmux/stream?machine=&surface=g' }, (res) => { res.on('data', () => {}); res.on('error', () => {}); resolve(); }).on('error', () => {}); });
    const t0 = Date.now();
    const exited = new Promise((r) => s.child.on('exit', () => r(Date.now() - t0)));
    s.child.kill('SIGTERM');
    const ms = await Promise.race([exited, new Promise((r) => setTimeout(() => r(Infinity), 8000))]);
    assert.ok(ms <= 6000, `shutdown took ${ms} ms`);
  });

  await t.test(`quiet SSE stays open ${QUIET_MS} ms`, async () => {
    const q = await quiet;
    assert.strictEqual(q.status, 200, JSON.stringify(q));
    assert.strictEqual(q.ended, null, `stream closed after ${q.ended} ms`);
  });
});
