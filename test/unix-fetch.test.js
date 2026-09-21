'use strict';
// p19 STORY-002 — lib/unix-fetch.js: a fetch-shaped client over a UNIX socket (specs.md D2, §6, §15.2).
//
// Every call goes to a REAL in-process http server listening on a socket in a fresh 0700
// fs.mkdtempSync(os.tmpdir()) directory: status/ok/headers, JSON, POST bodies, SSE timing, aborts,
// connect errors and a 5 MiB body. The stale socket comes from a SIGKILLed child, as in the lib's
// own tests. Everything is removed in after().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { parseUnixBaseUrl, unixFetch } = require('../lib/unix-fetch');
const { SocketConfigError } = require('../lib/unix-listen');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIG = crypto.randomBytes(5 * 1024 * 1024);

let dir, sock, srv;
const seen = [];                 // every request the server received: { method, url }
const hangCloses = [];           // times the /hang request emitted 'close'
before(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p19-')));
  fs.chmodSync(dir, 0o700);
  sock = path.join(dir, 'b.sock');
  srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    if (req.url === '/json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Multi', ['a', 'b']);
      return res.end(JSON.stringify({ a: 1 }));
    }
    if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not_found"}'); }
    if (req.url === '/bad-json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('not json{'); }
    if (req.url === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => setTimeout(() => {
        const b = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, cl: req.headers['content-length'] || null, te: req.headers['transfer-encoding'] || null,
          len: b.length, sha: sha(b), secret: req.headers['x-bridge-secret'] || null }));
      }, 50));
      return;
    }
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => { res.write('data: 2\n\n'); res.end(); }, 300);
      return;
    }
    if (req.url === '/hang') {
      req.on('close', () => hangCloses.push(Date.now()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      return;   // never ends by itself
    }
    if (req.url === '/big') { res.writeHead(200, { 'content-length': BIG.length }); return res.end(BIG); }
    res.writeHead(500); res.end();
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(sock, resolve); });
});
after(async () => {
  if (srv) { srv.closeAllConnections(); await new Promise((r) => srv.close(() => r())); }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- parseUnixBaseUrl --------------------------------------------------------------------------

test('parseUnixBaseUrl: unix:/abs -> the path; http(s) -> null; unix://, relative and 104-byte paths refused', () => {
  assert.equal(parseUnixBaseUrl('unix:/abs/b.sock'), '/abs/b.sock');
  assert.equal(parseUnixBaseUrl('http://127.0.0.1:1'), null);
  assert.equal(parseUnixBaseUrl('https://x.example'), null);
  assert.equal(parseUnixBaseUrl(''), null);
  for (const [url, code] of [
    ['unix://x/b.sock', 'socket_path_invalid'],
    ['unix:rel.sock', 'socket_path_invalid'],
    ['unix:', 'socket_path_invalid'],
    ['unix:/' + 'a'.repeat(103), 'socket_path_too_long'],
  ]) {
    let e = null;
    try { parseUnixBaseUrl(url); } catch (err) { e = err; }
    assert.ok(e instanceof SocketConfigError, `${url} must throw`);
    assert.equal(e.code, code, url);
  }
});

// ---- responses ---------------------------------------------------------------------------------

test('GET: status + ok, case-insensitive headers.get, joined multi-value, null when absent, json()', async () => {
  const r = await unixFetch(sock, '/json');
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.headers.get('Content-Type'), 'application/json');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('x-multi'), 'a, b');
  assert.equal(r.headers.get('x-not-sent'), null);
  assert.deepEqual(await r.json(), { a: 1 });

  const nf = await unixFetch(sock, '/missing');
  assert.equal(nf.status, 404);
  assert.equal(nf.ok, false);
  assert.deepEqual(await nf.json(), { error: 'not_found' });

  const bad = await unixFetch(sock, '/bad-json');
  await assert.rejects(bad.json(), SyntaxError, 'invalid JSON rejects, as fetch does');

  assert.equal(await (await unixFetch(sock, '/missing')).text(), '{"error":"not_found"}');
});

test('POST: string and Buffer bodies arrive byte-identical with a matching content-length; extra init keys ignored', async () => {
  const str = 'héllo ✓ world — p19';
  const r1 = await (await unixFetch(sock, '/echo', {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-bridge-secret': 's3' }, body: str, timeout: 5,
  })).json();
  assert.equal(r1.method, 'POST');
  assert.equal(r1.cl, String(Buffer.byteLength(str)));
  assert.equal(r1.len, Buffer.byteLength(str));
  assert.equal(r1.sha, sha(Buffer.from(str, 'utf8')));
  assert.equal(r1.te, null, 'a sized body, not chunked');
  assert.equal(r1.secret, 's3', 'the caller\'s headers are sent');

  const buf = crypto.randomBytes(4096);
  const r2 = await (await unixFetch(sock, '/echo', { method: 'POST', body: buf, timeout: 5 })).json();
  assert.equal(r2.cl, '4096');
  assert.equal(r2.sha, sha(buf));
  // the server waited 50 ms before answering: a 5 ms `timeout` key was not applied
});

test('SSE: the first frame reaches the reader well before the stream ends', async () => {
  const r = await unixFetch(sock, '/sse');
  const t0 = Date.now();
  const reader = r.body.getReader();
  const first = await reader.read();
  const dt = Date.now() - t0;
  const text = Buffer.from(first.value).toString('utf8');
  assert.match(text, /^data: 1\n\n/);
  assert.ok(!text.includes('data: 2'), 'frame 2 is not in the first read');
  assert.ok(dt < 250, `frame 1 took ${dt}ms after the headers`);
  let rest = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest += Buffer.from(value).toString('utf8'); }
  assert.equal(rest, 'data: 2\n\n');
});

// ---- aborts and connect errors -----------------------------------------------------------------

test('abort mid-stream: the server sees the request close within 1 s and the pending read rejects', async () => {
  const ctrl = new AbortController();
  const r = await unixFetch(sock, '/hang', { signal: ctrl.signal });
  const reader = r.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString('utf8'), /data: 1/);
  const pending = reader.read();
  const before = hangCloses.length;
  const t0 = Date.now();
  ctrl.abort();
  // like fetch, the read rejects; the error is http's own `aborted`/AbortError, which every relay catches
  await assert.rejects(pending, (e) => { assert.ok(e instanceof Error); return true; });
  while (hangCloses.length === before && Date.now() - t0 < 1000) await sleep(10);
  assert.equal(hangCloses.length, before + 1, 'the server saw the request close');
  assert.ok(hangCloses[hangCloses.length - 1] - t0 < 1000);
  assert.ok(hangCloses[hangCloses.length - 1] >= t0, 'closed by the abort, not before it');
});

test('a pre-aborted signal rejects at once with AbortError and sends nothing', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const n = seen.length;
  await assert.rejects(unixFetch(sock, '/json', { signal: ctrl.signal }), (e) => { assert.equal(e.name, 'AbortError'); return true; });
  await sleep(100);
  assert.equal(seen.length, n, 'the server saw no request');
});

test('connect errors reject: a stale socket (ECONNREFUSED) and a missing path (ENOENT)', async () => {
  const stale = path.join(dir, 'stale.sock');
  const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up'))", stale],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.on('data', (d) => { if (String(d).includes('up')) resolve(); }));
  const gone = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  await gone;
  assert.ok(fs.lstatSync(stale).isSocket());
  await assert.rejects(unixFetch(stale, '/json'), (e) => { assert.equal(e.code, 'ECONNREFUSED'); return true; });
  await assert.rejects(unixFetch(path.join(dir, 'none.sock'), '/json'), (e) => { assert.equal(e.code, 'ENOENT'); return true; });
});

test('a 5 MiB body through Readable.fromWeb(res.body) lands intact', async () => {
  const r = await unixFetch(sock, '/big');
  assert.equal(r.headers.get('content-length'), String(BIG.length));
  const out = path.join(dir, 'big.bin');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(out));
  const got = fs.readFileSync(out);
  assert.equal(got.length, BIG.length);
  assert.equal(sha(got), sha(BIG));
});

test('source scan: built-ins plus ./unix-listen only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'unix-fetch.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reqs, ['./unix-listen', 'http', 'stream']);
});
