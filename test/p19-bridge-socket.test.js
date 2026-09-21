'use strict';
// p19 STORY-003 — bridge.js on a UNIX socket (BRIDGE_SOCKET) — specs.md D1, D4–D6, D16, §7.1, §15.2.
//
// REAL bridge.js children, on the fixture-serving fake cmux (test/helpers/fake-cmux.js) and, for the
// tmux case, a throwaway tmux server on a private socket (test/helpers/tmux-server.js). Every bridge
// socket lives in a fresh 0700 fs.mkdtempSync(os.tmpdir()) directory; nothing binds 8799, touches the
// default tmux socket or the live checkout. Requests over the socket go through the raw
// test/helpers/unix-call.js, never lib/unix-fetch.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootBridge, BRIDGE_JS } = require('./helpers/bridge-child');
const { writeFakeCmux } = require('./helpers/fake-cmux');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');
const { call } = require('./helpers/unix-call');

const SECRET = 'p19-bridge-secret';
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

// TCP listeners held by a pid: '' when none (lsof exits 1 and prints nothing).
function tcpListeners(pid) {
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  return r.stdout.trim();
}
// A bridge child that is expected to REFUSE to start: its exit code and output within `ms`. With
// `until`, a child that announces itself is stopped and `matched` is true. `dotenv` becomes its .env.
function runRefused(env, dotenv, until, ms = 5000) {
  const cwd = tmp();
  if (dotenv != null) fs.writeFileSync(path.join(cwd, '.env'), dotenv);
  const child = spawn(process.execPath, [BRIDGE_JS], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR || '/tmp', BRIDGE_PORT: '0', BRIDGE_HOST: '127.0.0.1',
      CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let matched = false;
  child.stdout.on('data', (d) => { out += d; if (until && !matched && until.test(out)) { matched = true; child.kill('SIGTERM'); } });
  child.stderr.on('data', (d) => { err += d; });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, ms);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err, ms: Date.now() - t0, cwd, matched }); });
  });
}
const bridgeEnv = (extra) => ({ CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, ...(extra || {}) });

test('BRIDGE_SOCKET: boot line, 0600 socket, note line, and no TCP listener even with BRIDGE_PORT/BRIDGE_HOST set', async () => {
  const sock = path.join(tmp(), 'bridge.sock');
  const b = await bootBridge({ socket: sock, env: bridgeEnv() });   // the helper also sets BRIDGE_PORT=0, BRIDGE_HOST=127.0.0.1
  try {
    assert.equal(b.socketPath, sock);
    assert.equal(b.port, null);
    assert.ok(b.stdout().includes(`cmux-remote bridge on unix:${sock}\n`), b.stdout());
    assert.ok(b.stdout().includes('note: BRIDGE_SOCKET is set — BRIDGE_PORT/BRIDGE_HOST are ignored; no TCP port is opened'), b.stdout());
    assert.ok(!/cmux-remote bridge on [^:\s]+:\d+/.test(b.stdout()), 'no TCP boot line');
    await waitFor(() => b.stdout().includes('backend: cmux'), { what: 'the afterListen lines' });   // pipes are async on macOS
    const st = fs.lstatSync(sock);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, process.getuid());
    assert.equal(tcpListeners(b.child.pid), '', 'the bridge holds no TCP listener');
  } finally { await b.stop(); }
});

test('over the socket: /cmux/tree 200 with the secret, 403 without — the same bodies as a TCP bridge on the same fake cmux', async () => {
  const sock = path.join(tmp(), 'bridge.sock');
  const u = await bootBridge({ socket: sock, env: bridgeEnv() });
  const t = await bootBridge({ env: bridgeEnv() });
  try {
    const ok = await call(sock, 'GET', '/cmux/tree', { secret: SECRET });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.capabilities, 'the tree carries capabilities');
    assert.equal(ok.json.capabilities.backend, 'cmux');
    assert.ok(ok.json.workspaces.length >= 2);
    const denied = await call(sock, 'GET', '/cmux/tree');
    assert.equal(denied.status, 403, denied.text);

    const okTcp = await call(t.base, 'GET', '/cmux/tree', { secret: SECRET });
    const deniedTcp = await call(t.base, 'GET', '/cmux/tree');
    assert.deepEqual(ok.json, okTcp.json, 'the tree is the same over the socket and over TCP');
    assert.equal(deniedTcp.status, 403);
    assert.deepEqual(denied.json, deniedTcp.json);
  } finally { await u.stop(); await t.stop(); }
});

test('a second bridge on the same path exits 1 with socket_in_use; the first keeps answering on the same inode', async () => {
  const sock = path.join(tmp(), 'bridge.sock');
  const first = await bootBridge({ socket: sock, env: bridgeEnv() });
  try {
    const ino = fs.lstatSync(sock).ino;
    const second = await runRefused({ BRIDGE_SOCKET: sock });
    assert.equal(second.code, 1, `exit ${second.code} ${second.signal}\n${second.out}\n${second.err}`);
    assert.ok(second.ms < 5000);
    assert.match(second.err, /refusing to start: socket_in_use/);
    assert.ok(!second.out.includes('cmux-remote bridge on'), 'the second bridge never announced itself');
    assert.equal(fs.lstatSync(sock).ino, ino, 'the socket file was not replaced');
    const r = await call(sock, 'GET', '/cmux/tree', { secret: SECRET });
    assert.equal(r.status, 200);
  } finally { await first.stop(); }
});

test('SIGKILL, then restart on the same path: `removed stale socket` and it answers again', async () => {
  const sock = path.join(tmp(), 'bridge.sock');
  const a = await bootBridge({ socket: sock, env: bridgeEnv() });
  const gone = new Promise((resolve) => a.child.on('exit', resolve));
  a.child.kill('SIGKILL');
  await gone;
  assert.ok(fs.lstatSync(sock).isSocket(), 'the killed bridge left its socket file');
  const b = await bootBridge({ socket: sock, env: bridgeEnv() });
  try {
    assert.ok(b.stdout().includes(`removed stale socket ${sock}\n`), b.stdout());
    const r = await call(sock, 'GET', '/cmux/tree', { secret: SECRET });
    assert.equal(r.status, 200);
  } finally { await b.stop(); }
});

test('refusals: exit 1 with `refusing to start: <code>` and no socket created', async () => {
  const base = tmp();
  const open = path.join(base, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o755);
  const real = path.join(base, 'real');
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link);
  const long = path.join(base, 'l'.repeat(104 - base.length - 1));
  assert.equal(Buffer.byteLength(long), 104);
  const fileDir = path.join(base, 'filedir');
  fs.mkdirSync(fileDir, { mode: 0o700 });
  const file = path.join(fileDir, 'bridge.sock');
  fs.writeFileSync(file, 'not a socket');
  const cases = [
    [path.join(open, 'bridge.sock'), 'socket_dir_open_mode', () => assert.deepEqual(fs.readdirSync(open), [])],
    [path.join(link, 'bridge.sock'), 'socket_dir_not_real_path', () => assert.deepEqual(fs.readdirSync(real), [])],
    [long, 'socket_path_too_long', () => assert.ok(!fs.readdirSync(base).some((n) => fs.lstatSync(path.join(base, n)).isSocket()), 'no (truncated) socket')],
    [file, 'socket_path_not_socket', () => assert.equal(fs.readFileSync(file, 'utf8'), 'not a socket')],
    ['rel/bridge.sock', 'socket_path_invalid', null],
  ];
  for (const [p, code, check] of cases) {
    const r = await runRefused({ BRIDGE_SOCKET: p });
    assert.equal(r.code, 1, `${code}: exit ${r.code} ${r.signal}\n${r.out}\n${r.err}`);
    assert.match(r.err, new RegExp(`refusing to start: ${code}`), r.err);
    assert.ok(!r.out.includes('cmux-remote bridge on'), `${code}: nothing was announced`);
    if (check) check();
    if (!path.isAbsolute(p)) assert.equal(fs.existsSync(path.join(r.cwd, p)), false, 'no socket under the cwd either');
  }
  assert.equal(fs.lstatSync(open).mode & 0o777, 0o755, 'the open dir was never chmod-ed');
});

test('BRIDGE_SOCKET="" in the environment hiding a .env socket path refuses to start; unset, the .env path is used', async () => {
  const d = tmp();
  const fileSock = path.join(d, 'bridge.sock');
  const dotenv = `BRIDGE_SOCKET=${fileSock}\n`;
  const up = /cmux-remote bridge on \S+\n/;
  const shadowed = await runRefused({ BRIDGE_SOCKET: '' }, dotenv, up);
  assert.equal(shadowed.matched, false, `it started:\n${shadowed.out}`);
  assert.equal(shadowed.code, 1, `exit ${shadowed.code}\n${shadowed.err}`);
  assert.match(shadowed.err, /refusing to start: socket_setting_shadowed: BRIDGE_SOCKET is set to "" in the environment, which hides the BRIDGE_SOCKET= line in \.env/);
  assert.equal(fs.existsSync(fileSock), false);
  const fromFile = await runRefused({}, dotenv, up);
  assert.ok(fromFile.matched, fromFile.out + fromFile.err);
  assert.ok(fromFile.out.includes(`cmux-remote bridge on unix:${fileSock}\n`), fromFile.out);
});

test('BRIDGE_SOCKET unset: the TCP boot line is unchanged', async () => {
  const b = await bootBridge({ env: bridgeEnv() });
  try {
    assert.match(b.stdout(), /cmux-remote bridge on [^:\s]+:(\d+)/);
    assert.ok(b.stdout().includes(`cmux-remote bridge on 127.0.0.1:${b.port}\n`));
    assert.ok(!b.stdout().includes('unix:') && !b.stdout().includes('BRIDGE_SOCKET'), b.stdout());
    assert.ok(tcpListeners(b.child.pid).includes(`127.0.0.1:${b.port}`), 'a TCP listener, as before');
  } finally { await b.stop(); }
});

test('BACKEND=tmux on a socket: /cmux/tree 200 with capabilities.backend "tmux"', { skip: tmuxBinary() ? false : 'tmux not installed' }, async () => {
  const srv = await startTmux();
  const sock = path.join(tmp(), 'bridge.sock');
  const b = await bootBridge({ socket: sock, env: { BACKEND: 'tmux', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin, BRIDGE_SECRET: SECRET } });
  try {
    await waitFor(async () => (await srv.run(['list-sessions', '-F', '#{session_name}'])).stdout.trim() === 'main', { what: 'main' });
    const r = await call(sock, 'GET', '/cmux/tree', { secret: SECRET });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.capabilities.backend, 'tmux');
    assert.ok(r.json.workspaces.length >= 1);
    assert.equal(tcpListeners(b.child.pid), '');
  } finally { await b.stop(); await srv.stop(); }
});
