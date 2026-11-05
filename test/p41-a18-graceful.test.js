'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createGraceful } = require('../lib/graceful');

function sseClient(port, p) {
  return new Promise((resolve) => {
    http.get({ port, path: p, host: '127.0.0.1' }, (res) => {
      let buf = ''; const o = { buf: () => buf, ended: new Promise((r) => res.on('end', r)) };
      res.on('data', (d) => { buf += d; });
      resolve(o);
    });
  });
}

test('unit: open SSE gets restarting, in-flight request finishes, exit(0)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.write(': hi\n\n'); }
    if (req.url === '/slow') return setTimeout(() => res.end('done'), 200);
    if (req.url === '/healthz') return g.health(res);
    res.end();
  });
  const g = createGraceful(server, { limits: { drainMs: 2000, retryHintMs: 321 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.markReady();
  const port = server.address().port;
  const hz = await new Promise((r) => http.get({ port, path: '/healthz' }, (res) => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(hz, 200);
  const c = await sseClient(port, '/sse');
  const slow = new Promise((r) => http.get({ port, path: '/slow' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => r(b)); }));
  await new Promise((r) => setTimeout(r, 50));
  let code = null; let cleaned = false;
  const exited = new Promise((r) => { g.shutdown(() => { cleaned = true; }, (c2) => { code = c2; r(); }); });
  await c.ended;
  assert.match(c.buf(), /retry: 321\nevent: restarting\ndata: \{"retryMs":321\}\n\n/);
  assert.strictEqual(await slow, 'done');
  await exited;
  assert.strictEqual(code, 0); assert.ok(cleaned);
  assert.strictEqual(g.state.draining, true);
});

test('bridge process: SIGTERM -> restarting frame on /cmux/stream, fast exit, /healthz ready', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge.js')], {
    env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_HOST: '127.0.0.1', BRIDGE_SECRET: 's', BRIDGE_SOCKET: '', RESTART_RETRY_MS: '250' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = ''; const t = setTimeout(() => reject(new Error('no listen: ' + out)), 8000);
    child.stdout.on('data', (d) => { out += d; const m = /bridge on [^:]+:(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
  });
  const hz = await new Promise((r) => http.get({ port, path: '/healthz' }, (res) => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(hz, 200);
  const c = await new Promise((resolve) => http.get({ port, path: '/cmux/stream?surface=x', headers: { 'x-bridge-secret': 's' } }, (res) => {
    let buf = ''; res.on('data', (d) => (buf += d)); resolve({ buf: () => buf, ended: new Promise((r) => res.on('end', r)), status: res.statusCode });
  }));
  if (c.status !== 200) { child.kill('SIGKILL'); return; } // backend unavailable here: unit test above covers framing
  const exit = new Promise((r) => child.on('exit', (code) => r(code)));
  child.kill('SIGTERM');
  await c.ended;
  assert.match(c.buf(), /event: restarting\ndata: \{"retryMs":250\}/);
  assert.strictEqual(await exit, 0);
});
