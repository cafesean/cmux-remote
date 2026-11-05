// p62 S2: secrets over stdin, and a child env that never carries a secret.
//
// HYPERMUX_SECRETS_ON_STDIN=1 (the HyperMux Server helper): the parent writes ONE JSON line,
//   {"SERVER_TOKEN":"…","BRIDGE_SECRET":"…","CMUX_MACHINE_SECRET":"…"}, to our stdin. We read it
//   (5 s deadline, else exit 78 = EX_CONFIG), keep the values in this module only, and delete every
//   secret name from process.env, so nothing spawned later can inherit them and `ps -E` shows none.
// Unset (hand installs: .env + launchd): values come from process.env exactly as before, and
//   process.env is left alone (in-process readers such as radar keep working).
// Either mode: every spawn passes env: childEnv(...), which strips the secret names.
//
// Never log a value. Error messages name keys only.

const LOADABLE = ['SERVER_TOKEN', 'BRIDGE_SECRET', 'CMUX_MACHINE_SECRET'];
const SECRET_NAMES = ['SERVER_TOKEN', 'BRIDGE_SECRET', 'CMUX_MACHINE_SECRET', 'CMUX_MACHINE_ACCESS_SECRET',
  'TUNNEL_TOKEN', 'HYPERMUX_SECRETS_ON_STDIN'];
const isSecretName = (k) => SECRET_NAMES.includes(k) || /^BRIDGE_SECRET_/.test(k);
const EX_CONFIG = 78;
const MAX_LINE = 64 * 1024;

const store = Object.create(null);
let loaded = false;
let fromStdin = false;

const stdinRequested = (env = process.env) => env.HYPERMUX_SECRETS_ON_STDIN === '1';
// true until loadSecrets() has run in stdin mode: server.js/bridge.js defer their whole body.
const pending = () => !loaded && stdinRequested();

function scrubProcessEnv() {
  for (const k of Object.keys(process.env)) if (isSecretName(k)) delete process.env[k];
}

function fail(msg, exit) {
  process.stderr.write(`secrets: ${msg}\n`);
  exit(EX_CONFIG);
}

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
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (line) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onEnd);
      try { stdin.pause(); if (typeof stdin.destroy === 'function') stdin.destroy(); } catch (_) {}
      if (line == null) return fail('no secrets line on stdin', exit);
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return fail('stdin secrets line is not JSON', exit); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('stdin secrets line is not a JSON object', exit);
      for (const k of Object.keys(obj)) {
        if (!LOADABLE.includes(k)) return fail(`unknown secret key ${JSON.stringify(k).slice(0, 40)}`, exit);
        if (typeof obj[k] !== 'string') return fail(`secret ${k} is not a string`, exit);
      }
      for (const k of LOADABLE) store[k] = obj[k] || '';
      scrubProcessEnv();
      loaded = true;
      fromStdin = true;
      resolve(snapshot());
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) return finish(buf.slice(0, nl));
      if (buf.length > MAX_LINE) { buf = ''; finish(null); }
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

module.exports = { loadSecrets, pending, get, childEnv, isSecretName, SECRET_NAMES, LOADABLE,
  fromStdin: () => fromStdin, EX_CONFIG };
