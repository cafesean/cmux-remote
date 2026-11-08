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

const LIMITS = {
  cwdMaxLen: 1024,        // a start folder longer than this is refused (bad_cwd)
  startDirsMax: 12,       // folders GET /cmux/start-dirs returns
  lastUsedMax: 8,         // last-used folders remembered (start-dirs.json)
};

// Absolute, no NUL / control chars, short, exists, is a directory. Returns the resolved real path or
// null. realpath resolves `..` and symlinks so what reaches cmux is the folder that exists right now.
function validStartDir(p) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.cwdMaxLen) return null;
  if (/[\x00-\x1f\x7f]/.test(p) || !path.isAbsolute(p)) return null;
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch (_) { return null; }
}

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

// Suggested folders: last used, then the open workspaces' folders, then configured extras
// (HYPERMUX_START_DIRS, ':'-separated) and ~/Main (the Obsidian vault) when it exists, then $HOME.
// Every entry passes validStartDir; duplicates dropped; capped.
function startDirs({ lastUsed = [], workspaceCwds = [], extras = [], home = os.homedir() } = {}) {
  const out = [];
  const seen = new Set();
  const push = (p, source) => {
    const real = validStartDir(p);
    if (!real || seen.has(real) || out.length >= LIMITS.startDirsMax) return;
    seen.add(real);
    out.push({ path: real, name: path.basename(real) || real, source });
  };
  for (const p of lastUsed) push(p, 'recent');
  for (const p of workspaceCwds) push(p, 'workspace');
  for (const p of extras) push(p, 'configured');
  push(path.join(home, 'Main'), 'configured');
  push(home, 'home');
  return out;
}

const extrasFromEnv = (v) => String(v || '').split(':').map((s) => s.trim()).filter(Boolean);

module.exports = { LIMITS, validStartDir, lastUsedStore, startDirs, extrasFromEnv };
