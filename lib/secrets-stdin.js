// p62 S2: secrets over stdin, and a child env that never carries a secret.
//
// HYPERMUX_SECRETS_ON_STDIN=1 (the HyperMux Server helper): the parent writes ONE JSON line,
//   {"SERVER_TOKEN":"…","BRIDGE_SECRET":"…","CMUX_MACHINE_SECRET":"…"}, to our stdin. We read it
//   (5 s deadline, else exit 78 = EX_CONFIG), keep the values in this module only, and delete every
//   secret name from process.env, so nothing spawned later can inherit them and `ps -E` shows none.
// Unset (hand installs: .env + launchd): values come from process.env exactly as before, and
//   process.env is left alone (in-process readers such as radar keep working).
// Either mode: every spawn passes env: childEnv(...), which strips the secret names.
// p62 D83: CMUX_SOCKET_PASSWORD (cmux socket auth) is scoped, not shared: childEnv() strips it like
//   any secret; only spawns of the cmux CLI itself use cmuxChildEnv(), which adds it back. In stdin
//   mode the scrub stashes it here first, so the cmux CLI still authenticates.
//
// Never log a value. Error messages name keys only.

const LOADABLE = ['SERVER_TOKEN', 'BRIDGE_SECRET', 'CMUX_MACHINE_SECRET'];
const SECRET_NAMES = ['SERVER_TOKEN', 'BRIDGE_SECRET', 'CMUX_MACHINE_SECRET', 'CMUX_MACHINE_ACCESS_SECRET',
  'TUNNEL_TOKEN', 'HYPERMUX_SECRETS_ON_STDIN', 'CMUX_SOCKET_PASSWORD'];
// Secret names the cmux CLI (and only it) needs in its env. Values come from process.env (or the
// stdin-mode stash), never from a caller's extra.
const CMUX_SCOPED = ['CMUX_SOCKET_PASSWORD'];
const isSecretName = (k) => SECRET_NAMES.includes(k) || /^BRIDGE_SECRET_/.test(k);
const EX_CONFIG = 78;
const MAX_LINE = 64 * 1024;

const store = Object.create(null);
const cmuxStash = Object.create(null);   // CMUX_SCOPED values saved before scrubProcessEnv()
let loaded = false;
let fromStdin = false;

const stdinRequested = (env = process.env) => env.HYPERMUX_SECRETS_ON_STDIN === '1';
// true until loadSecrets() has run in stdin mode: server.js/bridge.js defer their whole body.
const pending = () => !loaded && stdinRequested();

function scrubProcessEnv() {
  for (const k of CMUX_SCOPED) if (process.env[k]) cmuxStash[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (isSecretName(k)) delete process.env[k];
}

function fail(msg, exit) {
  process.stderr.write(`secrets: ${msg}\n`);
  exit(EX_CONFIG);
}

// opts.require: the role's own secret names, passed explicitly by each entry (server.js:
//   ['SERVER_TOKEN'], bridge.js: ['BRIDGE_SECRET']). In stdin mode each must be present and
//   non-blank, else exit 78: a truncated or buggy helper write must never start an unauthenticated
//   server (p62 G1 H1). No filename guess: in a `bun build --compile` binary the entry is not
//   server.js/bridge.js (D62). A name outside LOADABLE fails closed (a typo must not drop the check).
//   No/empty opts.require: at least ONE non-blank secret. Env mode is unchanged (hand installs).
// opts (test seams): stdin, timeoutMs, exit.
function loadSecrets(opts = {}) {
  if (loaded) return Promise.resolve(snapshot());
  if (!stdinRequested()) {
    for (const k of LOADABLE) store[k] = process.env[k] || '';
    loaded = true;
    return Promise.resolve(snapshot());
  }
  const stdin = opts.stdin || process.stdin;
  const timeoutMs = opts.timeoutMs || 5000;
  const exit = opts.exit || ((c) => process.exit(c));
  const required = Array.isArray(opts.require) ? opts.require.slice() : [];
  const badReq = required.find((k) => !LOADABLE.includes(k));
  if (badReq !== undefined) { fail(`required secret name ${JSON.stringify(String(badReq)).slice(0, 40)} is not loadable`, exit); return new Promise(() => {}); }
  const decoder = new (require('string_decoder').StringDecoder)('utf8');   // L2: split multibyte safe
  return new Promise((resolve) => {
    let buf = '';
    let bytes = 0;
    let done = false;
    const finish = (line, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onEnd);
      try { stdin.pause(); if (typeof stdin.destroy === 'function') stdin.destroy(); } catch (_) {}
      if (line == null) return fail(why || 'no secrets line on stdin', exit);
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return fail('stdin secrets line is not JSON', exit); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('stdin secrets line is not a JSON object', exit);
      for (const k of Object.keys(obj)) {
        if (!LOADABLE.includes(k)) return fail(`unknown secret key ${JSON.stringify(k).slice(0, 40)}`, exit);
        if (typeof obj[k] !== 'string') return fail(`secret ${k} is not a string`, exit);
      }
      if (!required.length && !LOADABLE.some((k) => typeof obj[k] === 'string' && obj[k].trim())) {
        return fail('no non-blank secret in the stdin secrets line', exit);
      }
      for (const k of required) {
        if (typeof obj[k] !== 'string' || !obj[k].trim()) return fail(`required secret ${k} is missing or blank`, exit);
      }
      for (const k of LOADABLE) store[k] = obj[k] || '';
      scrubProcessEnv();
      loaded = true;
      fromStdin = true;
      resolve(snapshot());
    };
    const onData = (chunk) => {
      // L1: the cap is on TOTAL bytes, checked before the newline, so one big chunk cannot slip by.
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      const nl = buf.indexOf('\n');
      if ((nl >= 0 ? Buffer.byteLength(buf.slice(0, nl)) : bytes) > MAX_LINE) { buf = ''; return finish(null, 'stdin secrets line is over the size cap'); }
      if (nl >= 0) return finish(buf.slice(0, nl));
    };
    const onEnd = () => finish(buf.trim() ? buf : null);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { stdin.pause(); if (typeof stdin.destroy === 'function') stdin.destroy(); } catch (_) {}
      fail(`no secrets on stdin within ${timeoutMs} ms`, exit);
    }, timeoutMs);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onEnd);
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}

function snapshot() { const o = {}; for (const k of LOADABLE) o[k] = store[k] || ''; return o; }

// The value for a secret name. Before loadSecrets() (env mode callers that never call it), falls
// back to process.env so nothing changes for hand installs.
function get(name) {
  if (loaded) return store[name] || '';
  return process.env[name] || '';
}

// Copy of process.env (plus extra) with every secret name removed. extra cannot re-add one.
function childEnv(extra) {
  const e = { ...process.env, ...(extra || {}) };
  for (const k of Object.keys(e)) if (isSecretName(k)) delete e[k];
  return e;
}

// childEnv(extra) plus the cmux socket auth names. ONLY for spawns whose executable is the cmux CLI
// (bridge.js CMUX_ENV, scripts/capture-grid.js); test/p62-d83-socket-scope.test.js enforces that.
function cmuxChildEnv(extra) {
  const e = childEnv(extra);
  for (const k of CMUX_SCOPED) {
    const v = process.env[k] || cmuxStash[k];
    if (v) e[k] = v;
  }
  return e;
}

// p41 D88: the socket path + password for lib/cmux-socket.js (a direct socket call keeps typed browser
// text out of `cmux` argv). Same source as cmuxChildEnv; the value never leaves this pair of modules.
function cmuxSocketAuth() {
  return { path: process.env.CMUX_SOCKET_PATH || process.env.CMUX_SOCKET || '', password: process.env.CMUX_SOCKET_PASSWORD || cmuxStash.CMUX_SOCKET_PASSWORD || '' };
}

module.exports = { loadSecrets, pending, get, childEnv, cmuxChildEnv, cmuxSocketAuth, isSecretName, SECRET_NAMES, CMUX_SCOPED, LOADABLE,
  fromStdin: () => fromStdin, EX_CONFIG };
