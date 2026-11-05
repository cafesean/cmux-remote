'use strict';
// S2-0: paths the bridge must never list, read, download or offer as a completion, even when a
// workspace root contains them (a workspace at ~ puts all of these inside the fs jail).
// Callers pass a REALPATH'd absolute path; the home dir is realpath'd here, so a symlink or
// macOS firmlink that points into a denied place is caught by its target, not its name.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Under home: whole subtrees.
const DENY_TREES = ['.claude-swap-backup', '.ssh', '.appstoreconnect', path.join('Library', 'Keychains')];
// Under home: exact files (and their siblings with a suffix, e.g. .claude.json.backup).
const DENY_FILES = [path.join('.claude', '.credentials.json'), '.claude.json'];
// Anywhere: file names that hold credentials.
const DENY_NAME_RE = /(^|\.)credentials\.json$/i;
// Under ~/.config: any path segment that names a token.
const TOKEN_RE = /token/i;

const homeCache = new Map();
function realHome(home) {
  const h = home || os.homedir();
  if (!homeCache.has(h)) {
    let r = h;
    try { r = fs.realpathSync(h); } catch (_) { /* keep the raw home */ }
    homeCache.set(h, r);
  }
  return homeCache.get(h);
}

const within = (root, p) => {
  if (p === root) return true;
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** True when `realPath` (absolute, already realpath'd) is a credential path the bridge must not serve. */
function isDeniedPath(realPath, home) {
  if (typeof realPath !== 'string' || !realPath) return true;
  const p = path.resolve(realPath);
  if (DENY_NAME_RE.test(path.basename(p))) return true;
  const h = realHome(home);
  const rawH = home || os.homedir();
  for (const base of new Set([h, rawH])) {
    for (const t of DENY_TREES) if (within(path.join(base, t), p)) return true;
    for (const f of DENY_FILES) {
      const fp = path.join(base, f);
      if (p === fp || (path.dirname(p) === path.dirname(fp) && path.basename(p).startsWith(path.basename(fp) + '.'))) return true;
    }
    const cfg = path.join(base, '.config');
    if (within(cfg, p) && p !== cfg && path.relative(cfg, p).split(path.sep).some((s) => TOKEN_RE.test(s))) return true;
  }
  return false;
}

module.exports = { isDeniedPath, DENY_TREES, DENY_FILES };
