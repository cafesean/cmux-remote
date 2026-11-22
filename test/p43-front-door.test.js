'use strict';
// p43 HMXV-013: the Bun.serve front door on the compiled runtime. server.js is built with
// `bun build --compile` and driven over TCP and over SERVER_SOCKET; a stub bridge stands in for cmux.
// P43_QUIET_SSE_MS shortens the quiet-SSE hold (default 120000, the contract value).
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

function stubBridge() {
  const s = { closes: [] };
  s.server = http.createServer((req, res) => {
    if (req.url.startsWith('/cmux/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hi\n\n');
      req.on('close', () => s.closes.push(Date.now()));
      return;
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

function wsOpen(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve({ ok: true, ws });
    ws.onerror = () => resolve({ ok: false });
  });
}

test('front door on the compiled runtime', { skip: !BUN && 'bun not installed', timeout: QUIET_MS + 120000 }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p43-front-')));
  const bin = path.join(tmp, 'srv');
  execFileSync(BUN, ['build', '--compile', path.join(ROOT, 'server.js'), '--outfile', bin], { cwd: ROOT, stdio: 'pipe' });
  const up = await stubBridge();
  const env = { HOME: tmp, CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: 's3', CMUX_MACHINE_LABEL: 'stub', PORT: '0', HOST: '127.0.0.1' };
  const bun = await boot(bin, [], env);
  const node = await boot(process.execPath, [path.join(ROOT, 'server.js')], { ...env, HOME: fs.mkdtempSync(path.join(tmp, 'n-')) });
  t.after(() => { bun.child.kill('SIGKILL'); node.child.kill('SIGKILL'); up.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

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
      { 'x-hm-peer': '127.0.0.1', 'x-hm-front': 'guess' },
      { 'cf-connecting-ip': '127.0.0.1', 'x-hm-peer': '::1', 'x-hm-front': '0'.repeat(64) },
    ]) {
      const r = await req(bun.port, '/api/pair/hello', { headers: h });
      if (h['x-forwarded-for'] || h['cf-connecting-ip']) assert.strictEqual(r.status, 403, JSON.stringify(h) + r.body);
      else assert.strictEqual(r.status, 200, 'a client copy of x-hm-* is replaced, not trusted or fatal: ' + r.body);
    }
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
    // Bun's Response adds application/octet-stream where node sent no content-type; types node sets must match.
    for (const [p, a, b, ca, cb] of rows) { assert.strictEqual(a, b, `${p}: bun ${a} node ${b}`); if (cb) assert.strictEqual(ca, cb, `${p} content-type`); }
    const [ha, hb] = await Promise.all([req(bun.port, '/', { method: 'HEAD' }), req(node.port, '/', { method: 'HEAD' })]);
    assert.strictEqual(ha.status, hb.status, 'HEAD parity');
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
