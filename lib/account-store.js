'use strict';
// D144 (HMX-59): store ONE pasted Claude token under a name on this Mac, for POST /cmux/accounts/store.
// The same token goes to every picked Mac (a new setup-token on one Mac revokes the others' copy).
//
// Security: the token arrives in the request body only (TLS app -> server, unix socket/https server ->
// bridge). It is passed to `security -i` on STDIN (never argv), never logged, never written to a file;
// only its fingerprint (sha256, first 12 hex) goes to accounts meta. The caller drops it after store().
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const meta = require('./accounts-meta');
const { SERVICE_PREFIX } = require('./accounts');

// same shape rule as lib/account-setup.js extractToken (sk-ant-, url-safe chars, >= 90)
const TOKEN_RE = /^sk-ant-[A-Za-z0-9_-]{83,400}$/;
const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
const fingerprint = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);

function createAccountStore(opts = {}) {
  const secBin = opts.securityBin || process.env.HYPERMUX_SECURITY_BIN || '/usr/bin/security';
  const user = opts.user || process.env.USER || os.userInfo().username;
  const env = require('./secrets-stdin').childEnv(opts.env);
  const metaLib = opts.meta || meta;

  // exit code only; stdout/stderr ignored (never captured, never logged)
  const run = (args, input) => new Promise((resolve) => {
    const p = spawn(secBin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], env });
    p.on('error', () => resolve(1));
    p.on('close', (c) => resolve(c === null ? 1 : c));
    if (input !== undefined) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
  const exists = async (svc) => (await run(['find-generic-password', '-a', user, '-s', svc])) === 0;

  // -> { result: 'stored'|'replaced'|'exists_same', fp } | { error: 'exists_different', fp: existingFp|null } | { error }
  async function store(name, token, { replace = false } = {}) {
    if (typeof name !== 'string' || !meta.NAME_RE.test(name) || name === 'a') return { error: 'bad_name' };
    if (!validToken(token)) return { error: 'bad_token' };
    const fp = fingerprint(token);
    const svc = SERVICE_PREFIX + name;
    const had = await exists(svc);
    if (had) {
      const cur = metaLib.getFp(name);
      if (cur === fp) return { result: 'exists_same', fp };
      if (!replace) return { error: 'exists_different', fp: cur || null };
      // add WITHOUT -U (security -i exits 0 on failure): delete, prove gone, then add
      await run(['delete-generic-password', '-a', user, '-s', svc]);
      if (await exists(svc)) return { error: 'keychain_write_failed' };
    }
    let line = Buffer.from(`add-generic-password -a "${user}" -s "${svc}" -l "Claude account ${name} (HyprMux)" -w ${token}\n`);
    token = '';
    try { await run(['-i'], line); } finally { line.fill(0); line = null; }
    if (!(await exists(svc))) return { error: 'keychain_write_failed' };
    try { metaLib.set(name, { fp, addedAt: new Date().toISOString() }); } catch (_) { return { error: 'meta_write_failed', fp }; }
    return { result: had ? 'replaced' : 'stored', fp };
  }

  return { store };
}

module.exports = { createAccountStore, validToken, fingerprint, TOKEN_RE };
