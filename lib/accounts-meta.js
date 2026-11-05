'use strict';
// Named Claude account metadata (never tokens): { "<name>": { addedAt: ISO, fp: "<12 hex>" } }.
// File ~/.config/cmux-remote/accounts.json (0600); seam env HYPERMUX_ACCOUNTS_FILE.
// Writers lock via mkdir <file>.lock (stale after 10 s), write temp + rename.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-z][a-z0-9]{0,5}$/;
const FP_RE = /^[0-9a-f]{12}$/;
const STALE_MS = 10000;
const WAIT_MS = 2000;

const filePath = () => process.env.HYPERMUX_ACCOUNTS_FILE
  || path.join(os.homedir(), '.config', 'cmux-remote', 'accounts.json');

class MetaError extends Error { constructor(msg, code) { super(msg); this.exitCode = code; } }

function checkName(name, { allowA = false } = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || (name === 'a' && !allowA)) {
    throw new MetaError('bad account name', 2);
  }
}

function read() {
  try {
    const o = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
const names = () => Object.keys(read());
function getFp(name) { const e = read()[name]; return e && typeof e.fp === 'string' ? e.fp : undefined; }

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(fn) {
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const lock = f + '.lock';
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) { fs.rmdirSync(lock); continue; }
      } catch { continue; }
      if (Date.now() - start > WAIT_MS) throw new MetaError('accounts.json locked', 75);
      sleep(25);
    }
  }
  try { return fn(f); } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
}

function write(f, obj) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}

function set(name, { addedAt, fp } = {}) {
  checkName(name);
  if (fp !== undefined && !FP_RE.test(fp)) throw new MetaError('bad fp (want 12 hex)', 2);
  if (addedAt !== undefined && (typeof addedAt !== 'string' || Number.isNaN(Date.parse(addedAt)))) {
    throw new MetaError('bad addedAt (want ISO date)', 2);
  }
  withLock((f) => {
    const all = read();
    const cur = all[name] || {};
    const next = { addedAt: addedAt || cur.addedAt || new Date().toISOString() };
    const nfp = fp !== undefined ? fp : cur.fp;
    if (nfp !== undefined) next.fp = nfp;
    all[name] = next;
    write(f, all);
  });
}

function remove(name) {
  checkName(name);
  withLock((f) => { const all = read(); delete all[name]; write(f, all); });
}

module.exports = { read, getFp, set, remove, names, NAME_RE, FP_RE };

if (require.main === module) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  try {
    const opt = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === '--fp') opt.fp = rest[i + 1];
      else if (rest[i] === '--added') opt.addedAt = rest[i + 1];
      else throw new MetaError(`unknown option ${rest[i]}`, 2);
    }
    if (cmd === 'get-fp') { checkName(name); const v = getFp(name); if (v) process.stdout.write(v + '\n'); }
    else if (cmd === 'set') set(name, opt);
    else if (cmd === 'remove') remove(name);
    else throw new MetaError('usage: accounts-meta.js get-fp|set|remove <name> [--fp <12hex>] [--added <ISO>]', 2);
  } catch (e) {
    process.stderr.write(`accounts-meta: ${e.message}\n`);
    process.exit(e.exitCode || 1);
  }
}
