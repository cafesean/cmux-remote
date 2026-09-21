'use strict';
// p19 STORY-004 — server.js on a UNIX socket (SERVER_SOCKET), bridges at `unix:` baseUrls, the one
// upstream() seam, and the radar backstop (specs.md D1, D2, D12, D16, §7.2, §8, §15.2).
//
// REAL server.js and bridge.js children (fake cmux, test/helpers/fake-cmux.js), plus test-owned
// in-process fake bridges where the test must observe what the server sends upstream. Every socket
// lives in a fresh 0700 fs.mkdtempSync(os.tmpdir()) directory; requests go through the raw
// test/helpers/unix-call.js. Nothing binds 8080/8799 or touches the live checkout.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { bootServer, SERVER_JS, REPO } = require('./helpers/server-boot');
const { writeFakeCmux, IDS } = require('./helpers/fake-cmux');
const { waitFor } = require('./helpers/tmux-server');
const { call, openStream } = require('./helpers/unix-call');

const SECRET = 'p19-server-bridge-secret';
const TOKEN = 'p19-server-token';
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p19-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
let fake;
before(() => { fake = writeFakeCmux(tmp()); });
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tcpListeners(pid) {
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  return r.stdout.trim();
}
// a bridge and a server, both on sockets in one 0700 dir, the server reaching the bridge by unix:
async function socketPair(serverEnv) {
  const d = tmp();
  const bsock = path.join(d, 'bridge.sock');
  const ssock = path.join(d, 'server.sock');
  const bridge = await bootBridge({ socket: bsock, env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET } });
  const server = await bootServer({ socket: ssock, env: {
    SERVER_TOKEN: TOKEN, CMUX_MACHINE_URL: `unix:${bsock}`, CMUX_MACHINE_SECRET: SECRET, ...(serverEnv || {}) } });
  return { d, bsock, ssock, bridge, server, async stop() { await server.stop(); await bridge.stop(); } };
}
// A server child that is expected to REFUSE to start.
function runRefused(env, ms = 5000) {
  const cwd = tmp();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR || '/tmp', PORT: '0', HOST: '127.0.0.1', SERVER_TOKEN: TOKEN, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (x) => { out += x; });
  child.stderr.on('data', (x) => { err += x; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err, cwd }); });
  });
}
// A test-owned fake bridge on a socket: records requests and their 'close' times.
async function fakeBridge(sockPath) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const rec = { url: req.url, secret: req.headers['x-bridge-secret'], at: Date.now(), closedAt: null };
    log.push(rec);
    req.on('close', () => { rec.closedAt = Date.now(); });
    if (req.url.startsWith('/cmux/panes-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"frame":1}\n\n');
      return;   // left open, like a live stream
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"workspaces":[]}');
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(sockPath, resolve); });
  return { log, srv, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(() => r())); } };
}

test('socket mode: boot line, `→ unix:` machine line, and no TCP listener in either child', async () => {
  const p = await socketPair();
  try {
    assert.equal(p.server.socketPath, p.ssock);
    await waitFor(() => p.server.stdout().includes(`  machine "default" (My Mac) → unix:${p.bsock}\n`), { what: 'the machine line' });
    const out = p.server.stdout();
    assert.ok(out.includes(`cmux-remote server on unix:${p.ssock} with 1 machine(s)\n`), out);
    assert.ok(out.includes('note: SERVER_SOCKET is set — PORT/HOST/SERVER_HOST are ignored; no TCP port is opened'), out);
    assert.ok(!/cmux-remote server on http:/.test(out));
    assert.equal(fs.lstatSync(p.ssock).mode & 0o777, 0o600);
    assert.equal(tcpListeners(p.server.child.pid), '', 'the server holds no TCP listener');
    assert.equal(tcpListeners(p.bridge.child.pid), '', 'the bridge holds no TCP listener');
  } finally { await p.stop(); }
});

test('over the server socket: machines 401/200, tree, bootstrap and fleet through the unix: bridge', async () => {
  const p = await socketPair();
  try {
    assert.equal((await call(p.ssock, 'GET', '/api/cmux/machines')).status, 401);
    const m = await call(p.ssock, 'GET', '/api/cmux/machines', { token: TOKEN });
    assert.equal(m.status, 200);
    assert.deepEqual(m.json, { machines: [{ id: 'default', label: 'My Mac' }] }, 'labels only — never the socket path');

    const direct = await call(p.bsock, 'GET', '/cmux/tree', { secret: SECRET });
    const tree = await call(p.ssock, 'GET', '/api/cmux/tree', { token: TOKEN });
    assert.equal(tree.status, 200, tree.text);
    assert.deepEqual(tree.json.workspaces, direct.json.workspaces, 'the bridge\'s workspaces, relayed');
    assert.ok(tree.json.workspaces.some((w) => w.id === IDS.wsA));

    const boot = await call(p.ssock, 'GET', '/api/cmux/bootstrap', { token: TOKEN });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.machine, 'default');
    assert.equal(boot.json.capabilities.backend, 'cmux');
    assert.equal(boot.json.error, undefined);
    const fleet = await call(p.ssock, 'GET', '/api/cmux/fleet', { token: TOKEN });
    assert.equal(fleet.status, 200);
    assert.equal(fleet.json.machines[0].ok, true);
    assert.equal(fleet.json.machines[0].capabilities.backend, 'cmux');
  } finally { await p.stop(); }
});

test('bridge stopped: tree -> 502 bridge_unreachable, an SSE route -> 502, the server stays up', async () => {
  const p = await socketPair();
  try {
    await p.bridge.stop();
    assert.ok(fs.lstatSync(p.bsock).isSocket(), 'the stopped bridge left its (now dead) socket file');
    const tree = await call(p.ssock, 'GET', '/api/cmux/tree', { token: TOKEN });
    assert.equal(tree.status, 502);
    assert.deepEqual(tree.json, { error: 'bridge_unreachable' });
    const sse = await call(p.ssock, 'GET', `/api/cmux/stream?surface=${IDS.sfA1}`, { token: TOKEN });
    assert.equal(sse.status, 502);
    assert.equal(p.server.alive(), true);
    assert.equal((await call(p.ssock, 'GET', '/api/cmux/machines', { token: TOKEN })).status, 200);
  } finally { await p.stop(); }
});

test('client disconnect on an SSE relay reaches the unix: bridge within 2 s', async () => {
  const d = tmp();
  const bsock = path.join(d, 'fake-bridge.sock');
  const fb = await fakeBridge(bsock);
  const server = await bootServer({ socket: path.join(d, 'server.sock'), env: {
    SERVER_TOKEN: TOKEN, CMUX_MACHINE_URL: `unix:${bsock}`, CMUX_MACHINE_SECRET: SECRET } });
  try {
    const s = await openStream(server.socketPath, '/api/cmux/panes-stream?surfaces=a,b', { token: TOKEN });
    assert.equal(s.status, 200);
    assert.equal(s.headers['content-type'], 'text/event-stream');
    await waitFor(() => fb.log.some((r) => r.url.startsWith('/cmux/panes-stream')), { what: 'the relayed request' });
    const rec = fb.log.find((r) => r.url.startsWith('/cmux/panes-stream'));
    assert.equal(rec.url, '/cmux/panes-stream?surfaces=a%2Cb');
    assert.equal(rec.secret, SECRET, 'the bridge secret travels over the socket');
    assert.equal(rec.closedAt, null, 'still open while the client is');
    const t0 = Date.now();
    s.close();
    await waitFor(() => rec.closedAt !== null, { timeout: 2000, what: 'the upstream request to close' });
    assert.ok(rec.closedAt - t0 < 2000);
  } finally { await server.stop(); await fb.close(); }
});

test('refusals exit 1 before binding: bad unix: machine URLs (named by id) and an open SERVER_SOCKET dir', async () => {
  const base = tmp();
  const long = `unix:${base}/${'l'.repeat(104 - base.length - 1)}`;
  const open = path.join(base, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o755);
  const cases = [
    [{ CMUX_MACHINE_URL: 'unix://x/b.sock' }, /refusing to start: socket_path_invalid: machine "default"/],
    [{ CMUX_MACHINE_URL: 'unix:rel.sock' }, /refusing to start: socket_path_invalid: machine "default"/],
    [{ CMUX_MACHINE_URL: long }, /refusing to start: socket_path_too_long: machine "default"/],
    [{ CMUX_MACHINES: JSON.stringify([{ id: 'good', baseUrl: 'http://127.0.0.1:9' }, { id: 'lab', baseUrl: 'unix:rel.sock' }]) },
      /refusing to start: socket_path_invalid: machine "lab"/],
    [{ CMUX_MACHINE_URL: `unix:${open}/bridge.sock` }, /refusing to start: socket_dir_open_mode: machine "default"/],
    [{ SERVER_SOCKET: path.join(open, 'server.sock') }, /refusing to start: socket_dir_open_mode: /],
    [{ SERVER_SOCKET: 'rel/server.sock' }, /refusing to start: socket_path_invalid: SERVER_SOCKET: /],
  ];
  for (const [env, re] of cases) {
    const r = await runRefused(env);
    assert.equal(r.code, 1, `${JSON.stringify(env)}: exit ${r.code} ${r.signal}\n${r.out}\n${r.err}`);
    assert.match(r.err, re);
    assert.ok(!r.out.includes('cmux-remote server on'), `${JSON.stringify(env)}: never announced a listener`);
  }
  assert.deepEqual(fs.readdirSync(open), [], 'no socket was created in the open dir');
  assert.equal(fs.lstatSync(open).mode & 0o777, 0o755, 'and it was never chmod-ed');
});

test('radar backstop: not loaded in socket mode (SERVER_SOCKET or a unix: machine); TCP with http machines still loads it', async () => {
  // SERVER_SOCKET, no machines
  const d = tmp();
  const s1 = await bootServer({ socket: path.join(d, 's.sock'), env: { SERVER_TOKEN: TOKEN, RADAR_ENABLED: '1', RADAR_DIR: path.join(d, '.radar') } });
  try {
    await waitFor(() => s1.stderr().includes('radar: NOT started'), { what: 'the backstop line' });
    assert.ok(s1.stderr().includes('radar: NOT started — radar is TCP-only and this server runs in socket mode'), s1.stderr());
    assert.ok(!s1.stdout().includes('radar: enabled'));
    const st = await call(s1.socketPath, 'GET', '/api/radar/state', { token: TOKEN });
    assert.equal(st.status, 404);
    assert.equal(fs.existsSync(path.join(d, '.radar')), false, 'radar never touched its directory');
  } finally { await s1.stop(); }

  // TCP listener, but a unix: machine
  const d2 = tmp();
  const s2 = await bootServer({ env: { SERVER_TOKEN: TOKEN, RADAR_ENABLED: '1', RADAR_DIR: path.join(d2, '.radar'),
    CMUX_MACHINE_URL: `unix:${d2}/bridge.sock`, CMUX_MACHINE_SECRET: SECRET } });
  try {
    await waitFor(() => s2.stderr().includes('radar: NOT started'), { what: 'the backstop line' });
    assert.equal((await call(s2.base, 'GET', '/api/radar/state', { token: TOKEN })).status, 404);
  } finally { await s2.stop(); }

  // TCP with an http machine: radar starts exactly as before
  const d3 = tmp();
  const s3 = await bootServer({ env: { SERVER_TOKEN: TOKEN, RADAR_ENABLED: '1', RADAR_DIR: path.join(d3, '.radar'),
    CMUX_MACHINE_URL: 'http://127.0.0.1:9', CMUX_MACHINE_SECRET: SECRET } });
  try {
    await waitFor(() => /radar: enabled — /.test(s3.stdout()) || s3.stderr().includes('radar:'), { what: 'a radar line' });
    assert.match(s3.stdout(), /radar: enabled — /, s3.stderr());
    assert.ok(!s3.stderr().includes('radar: NOT started'));
    assert.notEqual((await call(s3.base, 'GET', '/api/radar/state', { token: TOKEN })).status, 404, 'radar routes are mounted');
  } finally { await s3.stop(); }
});

test('TCP unchanged: SERVER_SOCKET unset with an http machine -> the same boot and machine lines as before', async () => {
  const s = await bootServer({ env: { SERVER_TOKEN: TOKEN, CMUX_MACHINE_URL: 'http://127.0.0.1:9/', CMUX_MACHINE_SECRET: SECRET } });
  try {
    assert.match(s.stdout(), /cmux-remote server on http:\/\/[^:\s]+:(\d+)/);
    await waitFor(() => s.stdout().includes('  machine "default" (My Mac) → 127.0.0.1:9\n'), { what: 'the machine line' });
    assert.ok(!s.stdout().includes('unix:') && !s.stdout().includes('SERVER_SOCKET'), s.stdout());
    assert.ok(tcpListeners(s.child.pid).includes(`127.0.0.1:${s.port}`));
    const tree = await call(s.base, 'GET', '/api/cmux/tree', { token: TOKEN });
    assert.equal(tree.status, 502, 'nothing on :9 — the http path still goes through fetch and fails the same way');
    assert.deepEqual(tree.json, { error: 'bridge_unreachable' });
  } finally { await s.stop(); }
});

test('source scan: one fetch( with m.baseUrl, inside upstream(); exactly five upstream(m, call sites', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const fetches = [...src.matchAll(/\bfetch\(/g)].map((mm) => ({ at: mm.index, line: src.slice(src.lastIndexOf('\n', mm.index) + 1, src.indexOf('\n', mm.index)) }));
  const withBase = fetches.filter((f) => f.line.includes('m.baseUrl'));
  assert.equal(withBase.length, 1, withBase.map((f) => f.line).join('\n'));
  const start = src.indexOf('function upstream(m, pathAndQuery, init) {');
  assert.ok(start > 0, 'upstream() exists');
  const end = src.indexOf('\n}\n', start);
  assert.ok(withBase[0].at > start && withBase[0].at < end, 'that fetch is inside upstream()');
  assert.equal(fetches.length, 1, 'no other fetch( left in server.js');
  const sites = [...src.matchAll(/(?<!function )\bupstream\(m, /g)];
  assert.equal(sites.length, 5);
});

test('source scan: no p19 commit touches radar/ or radar-server.js', (t) => {
  const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  if (git(['rev-parse', '--verify', '555e260^{commit}']).status !== 0) return t.skip('not a git checkout with the p19 base commit');
  const r = git(['log', '--format=', '--name-only', '--grep=^p19 ', '555e260..HEAD']);
  assert.equal(r.status, 0, r.stderr);
  const files = [...new Set(r.stdout.split('\n').filter(Boolean))];
  const radar = files.filter((f) => f.startsWith('radar/') || f === 'radar-server.js');
  assert.deepEqual(radar, []);
  // and the working tree has no uncommitted radar edit either
  const dirty = git(['status', '--porcelain', '--', 'radar', 'radar-server.js']);
  assert.equal(dirty.stdout.trim(), '');
});
