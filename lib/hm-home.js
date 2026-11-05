// p62 S1: one opt-in state root for the HyperMux Server helper.
//
// HYPERMUX_HOME unset (every hand-installed server today) -> every path is exactly what it was.
// HYPERMUX_HOME set to an ABSOLUTE path -> server/bridge state lands under it instead. A relative
// value is ignored (treated as unset) so a launchd plist with a typo can never scatter state into
// the process CWD (= the release dir). Per-file env seams (PUSH_STATE_FILE, HYPERMUX_ACCOUNTS_FILE,
// HYPERMUX_PRIVATE_FILE, UPLOAD_DIR) still win over both, as before.
//
// NOT routed through here, ever: devices.json and server-id (lib/pairing.js). They stay at
// ~/.config/cmux-remote/ so a phone paired to a hand install keeps working after a move.
const os = require('os');
const path = require('path');

function home(env = process.env) {
  const h = env.HYPERMUX_HOME;
  if (typeof h !== 'string' || !h.trim() || !path.isAbsolute(h)) return '';
  return h;
}

// name: file name under HYPERMUX_HOME; legacy: today's absolute path.
function statePath(name, legacy, env = process.env) {
  const h = home(env);
  return h ? path.join(h, name) : legacy;
}

function uploadDir(env = process.env) {
  if (env.UPLOAD_DIR) return env.UPLOAD_DIR;
  const h = home(env);
  return h ? path.join(h, 'uploads') : `${os.homedir()}/Downloads/cmux-remote`;
}

module.exports = { home, statePath, uploadDir };
