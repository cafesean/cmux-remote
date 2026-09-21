'use strict';
// p19 STORY-001 — lib/unix-listen.js: the socket path, directory and stale-socket rules
// (specs.md D4–D6, §5, §15.2). Every refusal is triggered on the REAL filesystem — symlinks, open
// modes, FIFOs, a socket left by a SIGKILLed process, a live listener — and observed.
//
// Isolation: every path lives in a fresh fs.mkdtempSync(os.tmpdir()) directory (realpath-ed; mkdtemp
// makes it 0700), removed in after(). os.tmpdir() here is /private/var/folders/<a>/<b>/T, which
// keeps a socket path at ~80 bytes — under the 103-byte cap — and whose ancestors pass D4 (F19).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const ul = require('../lib/unix-listen');

const UID = process.getuid();
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p19-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const modeOf = (p) => fs.lstatSync(p).mode & 0o7777;
const codeOf = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected a SocketConfigError'); };
async function rejectsWith(promise, code) {
  const e = await promise.then(() => null, (err) => err);
  assert.ok(e, `expected a rejection with ${code}`);
  assert.ok(e instanceof ul.SocketConfigError, `not a SocketConfigError: ${e && e.stack}`);
  assert.equal(e.code, code, e.message);
  return e;
}
function getOver(socketPath, p = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: p, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const okServer = () => http.createServer((req, res) => { res.end('pong'); });
const listenOn = (srv, p) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(p, resolve); });
const closeServer = (srv) => new Promise((resolve) => srv.close(() => resolve()));
// listenUnix on a fresh server that MUST be refused. A server that bound anyway is closed before the
// assertions, so a broken rule fails the test instead of hanging the run on an open handle.
async function refusedListen(p, code) {
  const srv = okServer();
  const e = await ul.listenUnix(srv, p).then(() => null, (err) => err);
  const bound = srv.listening;
  if (bound) await closeServer(srv);
  assert.equal(bound, false, `${code}: nothing may be bound`);
  assert.ok(e instanceof ul.SocketConfigError, `expected ${code}, got ${e && e.stack}`);
  assert.equal(e.code, code, e.message);
  return e;
}
// A socket file with no listener behind it: bound by a child node, then SIGKILLed (F16).
async function staleSocketAt(p) {
  const child = spawn(process.execPath, ['-e',
    "require('net').createServer().listen(process.argv[1], () => console.log('up'))", p], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('up')) resolve(); });
    child.on('exit', (c) => reject(new Error(`listener child exited early (${c})`)));
  });
  const gone = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  await gone;
  assert.ok(fs.lstatSync(p).isSocket(), 'a SIGKILLed listener leaves its socket file behind');
}

// ---- validateSocketPath / socketSetting --------------------------------------------------------

test('validateSocketPath: relative, .., //, trailing /, blanks and odd characters -> socket_path_invalid', () => {
  for (const p of ['rel/x.sock', '/a/../b.sock', '/a//b.sock', '/a/b.sock/', '/a/b c.sock', '/a/b$.sock',
    '/a/./b.sock', '/', '', undefined, 5]) {
    const v = ul.validateSocketPath(p);
    assert.equal(v.ok, false, JSON.stringify(p));
    assert.equal(v.code, 'socket_path_invalid', JSON.stringify(p));
    assert.ok(v.detail, 'a refusal says why');
  }
});

test('validateSocketPath: 104 bytes -> socket_path_too_long, 103 bytes accepted', () => {
  assert.equal(ul.MAX_SOCKET_PATH_BYTES, 103);
  const p103 = '/' + 'a'.repeat(102);
  const p104 = '/' + 'a'.repeat(103);
  assert.equal(Buffer.byteLength(p103), 103);
  assert.deepEqual(ul.validateSocketPath(p103), { ok: true });
  const v = ul.validateSocketPath(p104);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'socket_path_too_long');
  assert.match(v.detail, /104 bytes/);
  assert.deepEqual(ul.validateSocketPath('/Users/you/.local/state/cmux-remote/run/bridge.sock'), { ok: true });
});

test('socketSetting: unset, empty or blank -> "", a good path -> the path, a bad one throws', () => {
  assert.equal(ul.socketSetting('X_SOCK', {}), '');
  assert.equal(ul.socketSetting('X_SOCK', { X_SOCK: '' }), '');
  assert.equal(ul.socketSetting('X_SOCK', { X_SOCK: '   ' }), '');
  assert.equal(ul.socketSetting('X_SOCK', { X_SOCK: '/a/b.sock' }), '/a/b.sock');
  const e = codeOf(() => ul.socketSetting('X_SOCK', { X_SOCK: 'rel.sock' }));
  assert.ok(e instanceof ul.SocketConfigError);
  assert.equal(e.code, 'socket_path_invalid');
  assert.match(e.detail, /^X_SOCK: /, 'the detail names the setting');
  assert.equal(codeOf(() => ul.socketSetting('X_SOCK', { X_SOCK: '/' + 'a'.repeat(103) })).code, 'socket_path_too_long');
  assert.equal(codeOf(() => ul.socketSetting('X_SOCK', { X_SOCK: ' /a/b.sock' })).code, 'socket_path_invalid', 'blanks are refused, not trimmed');
});

// ---- checkSocketDir / prepareSocketDir ---------------------------------------------------------

test('checkSocketDir: a good 0700 dir of ours passes', () => {
  const d = tmp();
  assert.doesNotThrow(() => ul.checkSocketDir(d));
});

test('checkSocketDir: symlinked dir, open mode, wrong owner, not a directory', () => {
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link);
  let e = codeOf(() => ul.checkSocketDir(link));
  assert.equal(e.code, 'socket_dir_not_real_path');
  assert.ok(e.detail.includes(real), `the detail names the real path: ${e.detail}`);

  const open = path.join(base, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o755);
  e = codeOf(() => ul.checkSocketDir(open));
  assert.equal(e.code, 'socket_dir_open_mode');
  assert.ok(e.detail.includes(`chmod 700 ${open}`), e.detail);

  e = codeOf(() => ul.checkSocketDir(real, { uid: UID + 1 }));
  assert.equal(e.code, 'socket_dir_wrong_owner');

  const file = path.join(base, 'file');
  fs.writeFileSync(file, 'x');
  assert.equal(codeOf(() => ul.checkSocketDir(file)).code, 'socket_dir_not_directory');
  assert.equal(codeOf(() => ul.checkSocketDir(path.join(base, 'missing'))).code, 'socket_dir_not_directory');
});

test('checkSocketDir: a 0777 non-sticky ancestor -> socket_dir_unsafe_ancestor; 01777 (sticky) is accepted', () => {
  const base = tmp();
  const openParent = path.join(base, 'open');
  fs.mkdirSync(openParent);
  fs.chmodSync(openParent, 0o777);
  const leaf1 = path.join(openParent, 'run');
  fs.mkdirSync(leaf1, { mode: 0o700 });
  const e = codeOf(() => ul.checkSocketDir(leaf1));
  assert.equal(e.code, 'socket_dir_unsafe_ancestor');
  assert.ok(e.detail.startsWith(openParent), e.detail);

  const sticky = path.join(base, 'sticky');
  fs.mkdirSync(sticky);
  fs.chmodSync(sticky, 0o1777);
  assert.equal(modeOf(sticky), 0o1777);
  const leaf2 = path.join(sticky, 'run');
  fs.mkdirSync(leaf2, { mode: 0o700 });
  assert.doesNotThrow(() => ul.checkSocketDir(leaf2));
});

test('prepareSocketDir: creates a missing leaf and missing parents 0700; never chmods an existing dir', () => {
  const base = tmp();
  const leaf = path.join(base, 'a', 'b', 'run');
  ul.prepareSocketDir(leaf);
  for (const d of [path.join(base, 'a'), path.join(base, 'a', 'b'), leaf]) {
    assert.ok(fs.lstatSync(d).isDirectory(), d);
    assert.equal(modeOf(d), 0o700, `${d} is ${modeOf(d).toString(8)}`);
  }
  ul.prepareSocketDir(leaf);   // idempotent on a good dir

  const open = path.join(base, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o755);
  const e = codeOf(() => ul.prepareSocketDir(open));
  assert.equal(e.code, 'socket_dir_open_mode');
  assert.equal(modeOf(open), 0o755, 'the existing directory was left exactly as it was');
});

// ---- clearStaleSocket --------------------------------------------------------------------------

test('clearStaleSocket: no entry -> "absent"', async () => {
  assert.equal(await ul.clearStaleSocket(path.join(tmp(), 'none.sock')), 'absent');
});

test('clearStaleSocket: a regular file, a FIFO and a symlink at the path -> socket_path_not_socket, left in place', async () => {
  const d = tmp();
  const file = path.join(d, 'file.sock');
  fs.writeFileSync(file, 'keep me');
  await rejectsWith(ul.clearStaleSocket(file), 'socket_path_not_socket');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');

  const fifo = path.join(d, 'fifo.sock');
  execFileSync('mkfifo', [fifo]);
  await rejectsWith(ul.clearStaleSocket(fifo), 'socket_path_not_socket');
  assert.ok(fs.lstatSync(fifo).isFIFO());

  // a symlink to a real (stale) socket: not followed, not unlinked
  const target = path.join(d, 'target.sock');
  await staleSocketAt(target);
  const link = path.join(d, 'link.sock');
  fs.symlinkSync(target, link);
  await rejectsWith(ul.clearStaleSocket(link), 'socket_path_not_socket');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.lstatSync(target).isSocket());
});

test('clearStaleSocket: a live listener -> socket_in_use, and it still answers afterwards', async () => {
  const p = path.join(tmp(), 'live.sock');
  const srv = okServer();
  await listenOn(srv, p);
  try {
    await rejectsWith(ul.clearStaleSocket(p), 'socket_in_use');
    assert.deepEqual(await getOver(p), { status: 200, body: 'pong' });
    assert.ok(fs.lstatSync(p).isSocket());
  } finally { await closeServer(srv); }
});

test('clearStaleSocket: the socket a SIGKILLed child left -> "removed", and the path is gone', async () => {
  const p = path.join(tmp(), 'stale.sock');
  await staleSocketAt(p);
  assert.equal(await ul.clearStaleSocket(p), 'removed');
  assert.equal(fs.existsSync(p), false);
});

test('clearStaleSocket: a socket of another uid -> socket_wrong_owner, left in place', async () => {
  const p = path.join(tmp(), 'theirs.sock');
  await staleSocketAt(p);
  await rejectsWith(ul.clearStaleSocket(p, { uid: UID + 1 }), 'socket_wrong_owner');
  assert.ok(fs.lstatSync(p).isSocket());
});

test('clearStaleSocket: the path swapped for another file during the probe -> socket_path_changed, nothing unlinked', async () => {
  const d = tmp();
  const p = path.join(d, 'swap.sock');
  const other = path.join(d, 'other.sock');
  await staleSocketAt(p);
  await staleSocketAt(other);
  const otherIno = fs.lstatSync(other).ino;
  // The first lstat runs synchronously inside clearStaleSocket; the probe's answer arrives on a later
  // tick. Renaming another stale socket over the path in between is exactly the swap D6 guards.
  const pending = ul.clearStaleSocket(p);
  fs.renameSync(other, p);
  await rejectsWith(pending, 'socket_path_changed');
  assert.equal(fs.lstatSync(p).ino, otherIno, 'the swapped-in file is still there');
});

// ---- listenUnix --------------------------------------------------------------------------------

test('listenUnix: a 0600 socket of ours that answers; a second listenUnix on it -> socket_in_use, the first keeps serving', async () => {
  const d = tmp();
  const p = path.join(d, 'run', 'server.sock');
  const a = okServer();
  assert.equal(await ul.listenUnix(a, p), 'absent');
  try {
    const st = fs.lstatSync(p);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, UID);
    assert.equal(modeOf(path.join(d, 'run')), 0o700, 'the missing run/ was created 0700');
    assert.deepEqual(await getOver(p), { status: 200, body: 'pong' });

    const ino = st.ino;
    await refusedListen(p, 'socket_in_use');
    assert.equal(fs.lstatSync(p).ino, ino, 'the live socket was not replaced');
    assert.deepEqual(await getOver(p), { status: 200, body: 'pong' });
  } finally { await closeServer(a); }
});

test('listenUnix: over a stale socket -> "removed", then serves', async () => {
  const p = path.join(tmp(), 'stale.sock');
  await staleSocketAt(p);
  const srv = okServer();
  try {
    assert.equal(await ul.listenUnix(srv, p), 'removed');
    assert.deepEqual(await getOver(p), { status: 200, body: 'pong' });
  } finally { await closeServer(srv); }
});

test('listenUnix: every refusal rejects before anything is bound', async () => {
  const base = tmp();
  const open = path.join(base, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o755);
  const file = path.join(base, 'file.sock');
  fs.writeFileSync(file, 'x');
  for (const [p, code] of [
    ['rel.sock', 'socket_path_invalid'],
    [base + '/' + 'a'.repeat(110 - base.length), 'socket_path_too_long'],
    [path.join(open, 's.sock'), 'socket_dir_open_mode'],
    [file, 'socket_path_not_socket'],
  ]) await refusedListen(p, code);
  assert.equal(fs.existsSync(path.join(open, 's.sock')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('listenUnix: a listen error becomes listen_failed', async () => {
  const d = tmp();
  const srv = okServer();
  await listenOn(srv, path.join(d, 'first.sock'));
  try {
    const e = await rejectsWith(ul.listenUnix(srv, path.join(d, 'second.sock')), 'listen_failed');
    assert.match(e.detail, /ERR_SERVER_ALREADY_LISTEN/);
  } finally { await closeServer(srv); }
});

// ---- source scan -------------------------------------------------------------------------------

test('source scan: built-ins only (fs, net, path) and exactly the 8 exports of specs.md §5', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'unix-listen.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reqs, ['fs', 'net', 'path']);
  assert.deepEqual(Object.keys(ul).sort(), ['MAX_SOCKET_PATH_BYTES', 'SocketConfigError', 'checkSocketDir', 'clearStaleSocket',
    'listenUnix', 'prepareSocketDir', 'socketSetting', 'validateSocketPath'].sort());
});
