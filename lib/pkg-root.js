'use strict';
// D62: where the package's own files (public/, bin/, radar/verdict.schema.json) live at run time.
// node: the repo dir, exactly as `__dirname` gave before. `bun build --compile`: `__dirname` is baked
// as the BUILD path, which is gone on a user's Mac, so the root is HYPERMUX_PKG_ROOT (absolute) when
// set, else the executable's directory (the app bundle places public/ etc. next to the binary).
const path = require('path');

function isBunCompiled() {
  if (!process.versions || !process.versions.bun) return false;
  const main = (typeof Bun !== 'undefined' && Bun.main) || '';   // eslint-disable-line no-undef
  return main.startsWith('/$bunfs/') || /^[A-Z]:[\\/]~BUN[\\/]/i.test(main);
}

function pkgRoot() {
  if (!isBunCompiled()) return path.join(__dirname, '..');
  const env = process.env.HYPERMUX_PKG_ROOT;
  if (env && env.trim() && path.isAbsolute(env)) return env;
  return path.dirname(process.execPath);
}

module.exports = { pkgRoot, isBunCompiled };
