'use strict';
// p41 D99 — D93's guard was proven only against a FAKED throw (`throw new TypeError('terminated')`
// from a timer). This drives the REAL undici abort: a fetch body wrapped in a Node stream
// (Readable.fromWeb) with no 'error' listener, then the upstream socket is destroyed mid-body.
// Node 26 then throws `TypeError: terminated` from Fetch.onAborted (undici:14945) inside a Socket
// 'close' emit, cause SocketError UND_ERR_SOCKET "other side closed": the exact server.err.log shape.
//   1. control: a bare node child with that preload DIES with Node's fatal banner (the repro is real);
//   2. the real server.js child with the same preload logs `uncaught_transport` and keeps serving.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { bootServer } = require('./helpers/server-boot');

const SECRET = 'd99-secret-value';
const PRELOAD = `
const http = require('http');
const { Readable } = require('stream');
const up = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.write('x'.repeat(5000));
  setTimeout(() => req.socket.destroy(), 50);        // the bridge restarts mid-body
});
up.listen(0, '127.0.0.1', async () => {
  const r = await fetch('http://127.0.0.1:' + up.address().port + '/');
  Readable.fromWeb(r.body).resume();                  // no 'error' listener: the unguarded reader
  setTimeout(() => { up.close(); console.log('D99_ABORT_DONE'); }, 400);
});
up.unref();
`;
function preloadFile() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd99-')), 'abort.js');
  fs.writeFileSync(f, PRELOAD);
  return f;
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return fn(); };
const healthz = (base) => new Promise((resolve) => {
  http.get(`${base}/healthz`, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0));
});

test('D99 control: the real undici abort kills an unguarded node process (repro is real, not faked)', async () => {
  const child = spawn(process.execPath, ['--require', preloadFile(), '-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  assert.notEqual(code, 0, 'unguarded process must die');
  assert.match(err, /TypeError: terminated/);
  assert.match(err, /Fetch\.onAborted/);
  assert.match(err, /UND_ERR_SOCKET/);
});

test('D99: the real server.js survives the real undici abort and logs uncaught_transport', async (t) => {
  const srv = await bootServer({ env: { CMUX_MACHINE_URL: 'http://127.0.0.1:9', CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0', RADAR_ENABLED: '0' }, nodeArgs: ['--require', preloadFile()] });
  t.after(() => srv.stop());
  assert.ok(await until(() => /uncaught_transport /.test(srv.stderr())), `no uncaught_transport line:\n${srv.stderr()}`);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(srv.alive(), `server must survive:\n${srv.stderr()}`);
  assert.equal(await healthz(srv.base), 200);
  assert.match(srv.stderr(), /uncaught_transport \{"cause":"UND_ERR_SOCKET"\}/);
  assert.doesNotMatch(srv.stderr(), /Node\.js v\d/);
  assert.doesNotMatch(srv.stderr(), new RegExp(SECRET));
});

test('D99: installProcessGuards is idempotent (a second module instance never stacks handlers)', () => {
  const { installProcessGuards } = require('../lib/relay-fail');
  const { EventEmitter } = require('events');
  const proc = new EventEmitter();
  proc.exit = () => {};
  assert.equal(installProcessGuards(proc, () => {}), true);
  assert.equal(installProcessGuards(proc, () => {}), false);
  assert.equal(proc.listenerCount('uncaughtException'), 1);
  assert.equal(proc.listenerCount('unhandledRejection'), 1);
});
