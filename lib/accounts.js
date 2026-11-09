'use strict';
// p41 S2c — Claude account NAMES on this Mac, for the bridge's /cmux/accounts routes.
//
// Reads only what the Keychain shows without a secret: `show-keychain-info` (locked or not),
// `dump-keychain` WITHOUT -d/-w (attribute lines only; the service names), and
// `find-generic-password` WITHOUT -w (exit code = exists). The token is never read, logged or
// returned here — only the setup/launcher scripts in the user's own pane touch it.
// Keychain scheme (shared with the chief-of-staff plugin): service cos-claude-account-<name>,
// account $USER. Seams: HYPERMUX_SECURITY_BIN (tests use a fake), now, env, user.
const { execFile } = require('child_process');
const os = require('os');
const meta = require('./accounts-meta');

const SERVICE_PREFIX = 'cos-claude-account-';
const NAME_RE = meta.NAME_RE;                      // ^[a-z][a-z0-9]{0,5}$
// D228: `auto` is the new-session choice "pick for me", never an account name (setup refuses it; a Keychain
// item someone made by hand under that name is not listed)
const RESERVED = new Set(['auto']);
const KEYCHAIN_TIMEOUT_MS = 3000;                  // show-keychain-info
const DUMP_TIMEOUT_MS = 5000;                      // dump-keychain / find-generic-password
const DUMP_MAX_BYTES = 4 * 1024 * 1024;            // dump-keychain output cap
const LIST_CACHE_MS = 60000;                       // accountListCacheMs
const FRESH_MIN_MS = 3000;                         // accountFreshMinMs (bridge-wide)
const SVCE_RE = /^\s*"svce"<blob>="([^"]*)"\s*$/;

function createAccounts(opts = {}) {
  const securityBin = opts.securityBin || process.env.HYPERMUX_SECURITY_BIN || '/usr/bin/security';
  const env = require('./secrets-stdin').childEnv(opts.env);   // p62 S2
  const user = opts.user || process.env.USER || os.userInfo().username;
  const clock = opts.now || Date.now;
  const keychainTimeout = opts.keychainTimeoutMs || KEYCHAIN_TIMEOUT_MS;
  let cache = null, cacheAt = -Infinity, freshAt = -Infinity;

  // -> { code, stdout } ; code null = could not run / timed out / output over the cap
  const run = (args, timeout, maxBuffer = 64 * 1024) => new Promise((resolve) => {
    execFile(securityBin, args, { env, timeout, killSignal: 'SIGKILL', maxBuffer }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout || '') });
      resolve({ code: typeof err.code === 'number' && !err.killed ? err.code : null, stdout: '' });
    });
  });

  async function keychainStatus() {
    const r = await run(['show-keychain-info'], keychainTimeout);
    return r.code === 0 ? 'ok' : 'locked';
  }

  // Names only; throws on a failed dump (the route answers a code, never the output).
  async function listNames() {
    const r = await run(['dump-keychain'], DUMP_TIMEOUT_MS, DUMP_MAX_BYTES);
    if (r.code !== 0) { const e = new Error('keychain_read_failed'); e.code = 'keychain_read_failed'; throw e; }
    const out = new Set();
    for (const line of r.stdout.split('\n')) {
      const m = SVCE_RE.exec(line);
      if (!m || !m[1].startsWith(SERVICE_PREFIX)) continue;
      const name = m[1].slice(SERVICE_PREFIX.length);
      if (NAME_RE.test(name) && !RESERVED.has(name)) out.add(name);
    }
    return [...out].sort();
  }

  async function list({ fresh } = {}) {
    const t = clock();
    let bypass = false;
    if (fresh && t - freshAt >= FRESH_MIN_MS) { bypass = true; freshAt = t; }
    if (!bypass && cache && t - cacheAt <= LIST_CACHE_MS) return cache;
    let value;
    if ((await keychainStatus()) !== 'ok') value = { keychain: 'locked', accounts: [] };
    else {
      const m = meta.read();
      const names = await listNames();
      value = { keychain: 'ok', accounts: names.map((name) => ({
        name, addedAt: m[name] && typeof m[name].addedAt === 'string' ? m[name].addedAt : null })) };
    }
    cache = value; cacheAt = clock();
    return value;
  }

  async function exists(name) {
    if (!NAME_RE.test(String(name)) || RESERVED.has(String(name))) return false;
    const r = await run(['find-generic-password', '-a', user, '-s', SERVICE_PREFIX + name], DUMP_TIMEOUT_MS);
    return r.code === 0;
  }

  return { keychainStatus, listNames, list, exists, invalidate() { cache = null; } };
}

module.exports = { createAccounts, SERVICE_PREFIX, NAME_RE, RESERVED, KEYCHAIN_TIMEOUT_MS, DUMP_TIMEOUT_MS, DUMP_MAX_BYTES, LIST_CACHE_MS, FRESH_MIN_MS };
