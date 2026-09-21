'use strict';
// p19 — listen on a UNIX socket that only its owner can reach (specs.md D4–D6, §5). Built-ins only.
//
// On a shared Mac any local user may bind any free loopback TCP port, so a fixed port is an endpoint
// another user can take first and harvest the tokens sent to it. A socket inside a 0700 directory is
// not: binding or connecting needs write + search on that directory. So the safety of the socket IS
// the safety of its directory, and every rule below is about who could change what the path names:
//
//   path       absolute, normalised, a plain charset, <= 103 bytes (Node 22 on macOS silently binds a
//              TRUNCATED name for longer paths — the socket would appear somewhere else)
//   directory  its own realpath, a real directory, ours, no group/other bits; every ancestor owned by
//              root or us and not group/other-writable unless sticky. An existing directory that
//              fails is REFUSED, never chmod-ed: something may already have been planted in it.
//   old file   a socket left by a killed process is removed only when three connects over ~300 ms
//              are all REFUSED (a live listener with a full queue refuses too, but not for long); an
//              answered probe (or any doubt) means another live process owns it — never steal it.
//
// Every refusal is a SocketConfigError whose `code` the caller prints as
// `refusing to start: <code>: <detail>` before exiting 1, with nothing bound.
const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_SOCKET_PATH_BYTES = 103;
const SOCKET_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

class SocketConfigError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'SocketConfigError';
    this.code = code;
    this.detail = detail;
  }
}

// { ok: true } | { ok: false, code, detail }
function validateSocketPath(p) {
  const bad = (detail) => ({ ok: false, code: 'socket_path_invalid', detail });
  if (typeof p !== 'string' || !p) return bad(`not a path: ${JSON.stringify(p)}`);
  if (!path.isAbsolute(p)) return bad(`${p} is not an absolute path`);
  if (path.normalize(p) !== p || p.endsWith('/')) return bad(`${p} is not normalised (no '..', '.', '//' or trailing '/')`);
  if (!SOCKET_PATH_RE.test(p)) return bad(`${JSON.stringify(p)} may only contain A-Z a-z 0-9 . _ / -`);
  const n = Buffer.byteLength(p);
  if (n > MAX_SOCKET_PATH_BYTES) {
    return { ok: false, code: 'socket_path_too_long', detail: `${p} is ${n} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}` };
  }
  return { ok: true };
}

// '' when the variable is unset or empty; the path when it passes validateSocketPath; else throws.
// The value itself is not trimmed: loadenv.js already trims .env values, so surrounding blanks can
// only come from the real environment, and a path with blanks is refused rather than guessed at.
// `emptyShadowed` (loadenv.js) lists names set EMPTY in the environment while .env gives a value: an
// empty setting that hides a socket path in .env refuses to start instead of silently running TCP.
function socketSetting(name, env = process.env, emptyShadowed = []) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') {
    if (raw != null && emptyShadowed.includes(name)) {
      throw new SocketConfigError('socket_setting_shadowed',
        `${name} is set to "" in the environment, which hides the ${name}= line in .env — unset it or give it the path`);
    }
    return '';
  }
  const p = String(raw);
  const v = validateSocketPath(p);
  if (!v.ok) throw new SocketConfigError(v.code, `${name}: ${v.detail}`);
  return p;
}

const lstatOrNull = (p) => {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};

// Throws SocketConfigError on the first violated rule of D4.
function checkSocketDir(dir, { uid = process.getuid() } = {}) {
  let real;
  try { real = fs.realpathSync(dir); } catch (e) {
    throw new SocketConfigError('socket_dir_not_directory', `${dir}: ${e.code || e.message}`);
  }
  if (real !== dir) throw new SocketConfigError('socket_dir_not_real_path', `${dir} resolves to ${real} — use the real path`);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new SocketConfigError('socket_dir_not_directory', `${dir} is not a directory`);
  if (st.uid !== uid) throw new SocketConfigError('socket_dir_wrong_owner', `${dir} is owned by uid ${st.uid}, not ${uid}`);
  if (st.mode & 0o077) {
    throw new SocketConfigError('socket_dir_open_mode',
      `${dir} has mode ${(st.mode & 0o777).toString(8).padStart(3, '0')}; run: chmod 700 ${dir}`);
  }
  // realpath === dir, so no ancestor is a symlink; each must still be one nobody else can rename in
  for (let a = path.dirname(dir); ; a = path.dirname(a)) {
    const s = fs.lstatSync(a);
    const unsafe = !s.isDirectory() ? 'is not a directory'
      : (s.uid !== 0 && s.uid !== uid) ? `is owned by uid ${s.uid}`
      : ((s.mode & 0o022) && !(s.mode & 0o1000)) ? `is group/other-writable (mode ${(s.mode & 0o7777).toString(8)}) without the sticky bit`
      : '';
    if (unsafe) throw new SocketConfigError('socket_dir_unsafe_ancestor', `${a} ${unsafe}`);
    if (a === '/') break;
  }
}

// mkdir -p dir (mode 0o700) when missing, then checkSocketDir. Never chmods an existing dir.
function prepareSocketDir(dir, { uid = process.getuid() } = {}) {
  let st;
  try { st = lstatOrNull(dir); } catch (e) {
    throw new SocketConfigError('socket_dir_not_directory', `${dir}: ${e.code || e.message}`);
  }
  if (!st) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
      throw new SocketConfigError('socket_dir_not_directory', `cannot create ${dir}: ${e.code || e.message}`);
    }
  }
  checkSocketDir(dir, { uid });
}

// One connect probe: 'refused' (ECONNREFUSED), 'absent' (ENOENT), or `answered` / an errno / 'timeout'
// — anything that is not a refusal or a missing file means someone may be there.
function probeOnce(p, probeMs) {
  return new Promise((resolve) => {
    let settled = false;
    const conn = net.connect(p);
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); conn.destroy(); resolve(r); };
    const timer = setTimeout(() => finish('timeout'), probeMs);
    conn.once('connect', () => finish('answered'));
    // `on`, not `once`: a late second error after finish() must not crash
    conn.on('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ENOENT' ? 'absent' : (e.code || e.message)));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Promise<'absent' | 'removed'>; rejects SocketConfigError (D6, specs.md §5.2).
// A refused connect alone does not prove a socket is dead: on macOS a LIVE listener whose accept
// queue is momentarily full refuses too. So the file counts as stale only after `tries` probes spread
// over (tries - 1) * gapMs all come back ECONNREFUSED; a live server drains its queue in that time.
async function clearStaleSocket(p, { uid = process.getuid(), probeMs = 500, tries = 3, gapMs = 150 } = {}) {
  let before;
  try { before = lstatOrNull(p); } catch (e) {
    throw new SocketConfigError('socket_path_not_socket', `${p}: ${e.code || e.message}`);
  }
  if (!before) return 'absent';
  if (!before.isSocket()) throw new SocketConfigError('socket_path_not_socket', `${p} exists and is not a socket — left untouched`);
  if (before.uid !== uid) throw new SocketConfigError('socket_wrong_owner', `${p} is owned by uid ${before.uid}, not ${uid}`);

  for (let i = 0; i < tries; i++) {
    if (i) await sleep(gapMs);
    const r = await probeOnce(p, probeMs);
    if (r === 'absent') return 'absent';
    if (r === 'answered') throw new SocketConfigError('socket_in_use', `${p}: another process is listening on it`);
    if (r === 'timeout') throw new SocketConfigError('socket_in_use', `${p}: no answer to a connect in ${probeMs}ms — not taking it over`);
    if (r !== 'refused') throw new SocketConfigError('socket_in_use', `${p}: connect probe failed with ${r} — not taking it over`);
  }
  // Nobody answered, every time: a socket file left by a killed process. Unlink it only if the path
  // still names the very same file the probes were made against.
  let after;
  try { after = lstatOrNull(p); } catch (_) { after = null; }
  if (!after || after.dev !== before.dev || after.ino !== before.ino) {
    throw new SocketConfigError('socket_path_changed', `${p} changed during the stale-socket probe`);
  }
  try { fs.unlinkSync(p); } catch (err) {
    throw new SocketConfigError('socket_path_changed', `${p}: unlink failed with ${err.code || err.message}`);
  }
  return 'removed';
}

// prepareSocketDir(dirname) → clearStaleSocket → server.listen(p) → chmod 0600.
// Promise<'absent' | 'removed'> (clearStaleSocket's result, so the caller can log a removal);
// rejects SocketConfigError — a listen 'error' becomes code listen_failed.
async function listenUnix(server, p, { uid = process.getuid() } = {}) {
  const v = validateSocketPath(p);
  if (!v.ok) throw new SocketConfigError(v.code, v.detail);
  prepareSocketDir(path.dirname(p), { uid });
  const result = await clearStaleSocket(p, { uid });
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(new SocketConfigError('listen_failed', err.code || err.message));
    server.once('error', onError);
    try {
      server.listen(p, () => { server.removeListener('error', onError); resolve(); });
    } catch (e) { server.removeListener('error', onError); onError(e); }   // e.g. ERR_SERVER_ALREADY_LISTEN is thrown, not emitted
  });
  try { fs.chmodSync(p, 0o600); } catch (e) {
    throw new SocketConfigError('listen_failed', `chmod 600 ${p}: ${e.code || e.message}`);
  }
  return result;
}

module.exports = {
  MAX_SOCKET_PATH_BYTES, SocketConfigError, socketSetting, validateSocketPath,
  prepareSocketDir, checkSocketDir, clearStaleSocket, listenUnix,
};
