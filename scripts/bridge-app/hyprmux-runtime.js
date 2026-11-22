'use strict';
// p41 C3: entry point of the `hyprmux-runtime` binary inside HyprMux.app (Mac Catalyst desktop build).
// `bun build --compile` bundles this file together with cmux-remote's server.js and bridge.js (copied
// next to it at the pinned server.ref by scripts/mac/build-runtime.sh), so ONE binary serves three
// LaunchAgents registered by the app with SMAppService:
//
//   hyprmux-runtime server   cmux-remote server.js (UI + API on 127.0.0.1:$PORT)
//   hyprmux-runtime bridge   cmux-remote bridge.js (drives cmux; unix socket only, never TCP)
//   hyprmux-runtime tunnel   cloudflared, reading its token from a 0600 file (never argv, never env)
//
// LaunchAgent plists are static files in the bundle, so they cannot carry per-user paths. This entry
// resolves them at run time: the state dir is ~/Library/Application Support/HyprMux (written by the
// app on first run: .env 0600, run/ 0700, tunnel-token 0600), and the package root (public/, bin/) is
// Contents/Resources/server inside the same bundle as this binary.
const os = require('os');
const path = require('path');
const fs = require('fs');

// Security review 2026-11-06 (P2): the process environment beats .env (loadenv) and reaches every child, so
// `launchctl setenv HOST=0.0.0.0` or a path override could re-aim the agents. Keep only an allowlist; the
// paths below are fixed, never taken from the environment. PATH is fixed too (git/tmux may be in Homebrew).
const ENV_KEEP = new Set(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', '__CF_USER_TEXT_ENCODING', 'HYPRMUX_LOGGED']);
for (const k of Object.keys(process.env)) if (!ENV_KEEP.has(k) && !k.startsWith('LC_')) delete process.env[k];
process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

const STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'HyprMux');
const CONTENTS = path.resolve(path.dirname(process.execPath), '..');
const RUNTIME = path.join(CONTENTS, 'MacOS', 'hyprmux-runtime');

function fail(code, detail) {
  console.error(`hyprmux-runtime: ${code}${detail ? `: ${detail}` : ''}`);
  // 78 = EX_CONFIG: launchd KeepAlive still retries, ThrottleInterval spaces the retries.
  process.exit(78);
}

function ownedPrivate(p, mode) {
  let st;
  try { st = fs.statSync(p); } catch (_) { return false; }
  return st.uid === process.getuid() && (st.mode & 0o077) === 0 && (mode === undefined || (st.mode & 0o777) === mode);
}

const mode = process.argv[2];
if (!['server', 'bridge', 'tunnel'].includes(mode)) fail('usage', 'hyprmux-runtime server|bridge|tunnel');
if (!ownedPrivate(STATE_DIR)) fail('state_dir_not_private', STATE_DIR);

// launchd gives an agent no terminal, and bun's console writes straight to fd 1/2, so the agent re-runs
// itself as a child whose stdout/stderr ARE the log file <state>/logs/<mode>.log (0600), and only
// forwards signals + the exit code. LIMIT: a log over LOG_MAX_BYTES is cut to empty when the agent
// starts (LIMITS.md "HyprMux desktop runtime log cap").
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const { spawn } = require('child_process');

function openLog() {
  const logs = path.join(STATE_DIR, 'logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const file = path.join(logs, `${mode}.log`);
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) {}
  const fd = fs.openSync(file, size > LOG_MAX_BYTES ? 'w' : 'a', 0o600);
  if (size > LOG_MAX_BYTES) fs.writeSync(fd, `log cut at start: was ${size} bytes > ${LOG_MAX_BYTES}\n`);
  return fd;
}

function supervise(cmd, args, env, stdio) {
  const child = spawn(cmd, args, { env, stdio });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code === null ? (signal === 'SIGTERM' ? 0 : 1) : code));
  child.on('error', (e) => fail('spawn_failed', e.code));
}

const logged = process.stdout.isTTY || process.env.HYPRMUX_LOGGED === '1';

function readEnvPort() {
  try {
    const m = fs.readFileSync(path.join(STATE_DIR, '.env'), 'utf8').match(/^PORT=(\d{4,5})$/m);
    return m ? Number(m[1]) : 0;
  } catch (_) { return 0; }
}

/** True when the TCP listener on 127.0.0.1:port belongs to this user AND its executable is this bundle's runtime. */
function portIsOurs(port) {
  const { execFileSync } = require('child_process');
  const run = (bin, args) => { try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return (e && e.stdout) || ''; } };
  const pids = run('/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid()), `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'])
    .split('\n').filter((l) => l.startsWith('p')).map((l) => l.slice(1));
  if (!pids.length) return false;
  let mine;
  try { mine = fs.realpathSync(RUNTIME); } catch (_) { return false; }
  return pids.some((pid) => {
    const txt = run('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, '-d', 'txt', '-Fn']).split('\n').find((l) => l.startsWith('n'));
    if (!txt) return false;
    try { return fs.realpathSync(txt.slice(1)) === mine; } catch (_) { return false; }
  });
}

if (mode === 'tunnel') {
  const tokenFile = path.join(STATE_DIR, 'tunnel-token');
  if (!ownedPrivate(tokenFile, 0o600)) fail('no_tunnel_token');
  const cloudflared = path.join(CONTENTS, 'MacOS', 'cloudflared');
  // Clean env: the child gets no HyprMux secrets, only what cloudflared needs.
  const env = { HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TUNNEL_TOKEN_FILE: tokenFile };
  // Security review 2026-11-06 (P1): 127.0.0.1 ports are shared by every user on the Mac. If another user
  // takes our port while our server is down, phones (through this tunnel) would hand it their device keys.
  // So cloudflared only runs while the listener on PORT is this bundle's own runtime, checked at start and
  // every TUNNEL_OWNER_CHECK_MS (LIMITS.md "HyprMux tunnel listener check").
  const TUNNEL_OWNER_CHECK_MS = 10 * 1000;
  const port = readEnvPort();
  if (!port) fail('no_port');
  if (!portIsOurs(port)) { console.error(`hyprmux-runtime: port ${port} not served by this HyprMux; tunnel waits`); process.exit(75); }
  const fd = logged ? null : openLog();
  supervise(cloudflared, ['tunnel', '--no-autoupdate', 'run'], env, fd === null ? 'inherit' : ['ignore', fd, fd]);
  setInterval(() => {
    if (portIsOurs(port)) return;
    console.error(`hyprmux-runtime: port ${port} no longer served by this HyprMux; stopping the tunnel`);
    process.kill(process.pid, 'SIGTERM');   // supervise() forwards it to cloudflared, then exits
  }, TUNNEL_OWNER_CHECK_MS).unref();
} else if (!logged) {
  const fd = openLog();
  supervise(process.execPath, [mode], Object.assign({}, process.env, { HYPRMUX_LOGGED: '1' }), ['ignore', fd, fd]);
} else {
  // Bridge socket dir: cmux-remote refuses socket paths with spaces ("Application Support" has one), so
  // the socket lives in ~/Library/Caches/ai.yobolabs.hyprmux/run (0700). Caches can be purged: recreate.
  const runDir = path.join(os.homedir(), 'Library', 'Caches', 'ai.yobolabs.hyprmux', 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
  process.chdir(STATE_DIR);   // loadenv.js reads the .env in the CWD
  if (!ownedPrivate(path.join(STATE_DIR, '.env'), 0o600)) fail('env_not_private');
  if (!process.env.HYPERMUX_PKG_ROOT) process.env.HYPERMUX_PKG_ROOT = path.join(CONTENTS, 'Resources', 'server');
  // D128: the account scripts run in cmux panes on Macs without node; the bridge points at wrappers that
  // set HYPERMUX_NODE to the bundled runtime (Resources/server/node-compat/node) before the real script.
  if (mode === 'bridge' && !process.env.HYPERMUX_BIN_DIR) process.env.HYPERMUX_BIN_DIR = path.join(CONTENTS, 'Resources', 'server', 'hyprmux-bin');
  if (mode === 'bridge') require('./bridge.js');
  else require('./server.js');
}
