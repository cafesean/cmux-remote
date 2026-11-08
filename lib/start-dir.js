'use strict';
// p41 D176/D177 — the folder a new session starts in.
//
// new-surface takes an optional `cwd`. Before D176 the bridge passed none, so cmux opened every new
// tab in its own default folder (Sean: "always the monorepo"), whatever pane was clicked. The app now
// sends the clicked pane's folder (or the one picked in the sheet); this module decides whether a
// client-supplied path is safe to hand to cmux, and lists folders worth offering.
const fs = require('fs');
const os = require('os');
const path = require('path');

const extrasFromEnv = (v) => String(v || '').split(':').map((s) => s.trim()).filter(Boolean);

const LIMITS = {
  cwdMaxLen: 1024,        // a start folder longer than this is refused (bad_cwd)
  startDirsMax: 12,       // folders GET /cmux/start-dirs returns
  lastUsedMax: 8,         // last-used folders remembered (start-dirs.json)
};

// Absolute, no NUL / control chars, short, exists, is a directory. Returns the path AS GIVEN (only
// `.`/`..`/double slashes normalized) or null. D183: never the symlink-resolved path — the mini vault
// symlink can resolve to a real mount path that a host process guard refuses (it kills any process with
// that path in argv), so a session started at the real path dies. The check itself follows the link.
function validStartDir(p, aliases = extrasFromEnv(process.env.HYPERMUX_START_DIRS)) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.cwdMaxLen) return null;
  if (/[\x00-\x1f\x7f]/.test(p) || !path.isAbsolute(p)) return null;
  try {
    const given = path.resolve(p);
    const real = fs.realpathSync(given);
    if (!fs.statSync(real).isDirectory()) return null;
    return toAlias(given, real, aliases);
  } catch (_) { return null; }
}

// D183: a pane/workspace cwd reported as the RESOLVED path (<real mount>/…) maps back to the
// configured symlink spelling (HYPERMUX_START_DIRS entry …/vault) when that entry resolves to it.
function toAlias(given, real, aliases) {
  for (const a of aliases || []) {
    if (!path.isAbsolute(a) || a === given) continue;
    const ar = realKey(a);
    if (!ar || ar === a) continue;   // not a symlink alias
    if (real === ar) return path.resolve(a);
    if (real.startsWith(ar + path.sep)) return path.join(path.resolve(a), real.slice(ar.length + 1));
  }
  return given;
}

// The real path, used only to drop duplicates (two spellings of one folder); null when it is gone.
function realKey(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }

// D183: the server's own install dirs (…/releases/<sha>/…) are never a place to start a session; a
// workspace whose shell sits in one (e.g. releases/815240155057/bin) must not become a suggestion.
const RELEASE_DIR_RE = /\/releases\/[0-9a-f]{6,}(\/|$)/i;

// Last-used folders, newest first, in a small JSON file next to the bridge's other state.
function lastUsedStore(file) {
  const read = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j) ? j.filter((x) => typeof x === 'string').slice(0, LIMITS.lastUsedMax) : [];
    } catch (_) { return []; }
  };
  return {
    read,
    add(dir) {
      const next = [dir].concat(read().filter((d) => d !== dir)).slice(0, LIMITS.lastUsedMax);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(next));
        fs.renameSync(file + '.tmp', file);
      } catch (_) { /* best effort: a lost entry only means one less suggestion */ }
    },
  };
}

// Suggested folders: the clicked pane's folder, last used, then the open workspaces' folders, then configured extras
// (HYPERMUX_START_DIRS, ':'-separated) and ~/Main (the Obsidian vault) when it exists, then $HOME.
// Every entry passes validStartDir; duplicates dropped; capped.
function startDirs({ current = null, lastUsed = [], workspaceCwds = [], extras = [], home = os.homedir() } = {}) {
  const out = [];
  const seen = new Set();
  const push = (p, source) => {
    const given = validStartDir(p, extras);
    if (!given || RELEASE_DIR_RE.test(given) || out.length >= LIMITS.startDirsMax) return;
    const key = realKey(given) || given;   // dedupe on the real folder, show the configured spelling
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: given, name: path.basename(given) || given, source });
  };
  if (current) push(current, 'pane');
  for (const p of lastUsed) push(p, 'recent');
  for (const p of workspaceCwds) push(p, 'workspace');
  for (const p of extras) push(p, 'configured');
  push(path.join(home, 'Main'), 'configured');
  push(home, 'home');
  return out;
}

module.exports = { LIMITS, RELEASE_DIR_RE, validStartDir, lastUsedStore, startDirs, extrasFromEnv };
