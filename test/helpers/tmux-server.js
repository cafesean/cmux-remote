'use strict';
// A throwaway tmux server for the p18 tests: `tmux -u -D -S <mkdtemp>/s -f /dev/null`.
//
// The owner's own tmux lives on the DEFAULT socket (/tmp/tmux-<uid>/default). No test may ever reach
// it, so every server here gets a private socket inside its own fs.mkdtempSync(os.tmpdir()) directory,
// no config file, a scrubbed environment (no TMUX, no CMUX_*, HOME = that directory, SHELL=/bin/sh
// so panes start fast and without the operator's dotfiles), and is killed and deleted by stop().
// The emulator under test is built by srv.cli(), which always passes that socket.
//
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)
const { spawn, execFile, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTmuxBin, createTmuxCli } = require('../../lib/tmux-cli');

// Same resolution as lib/tmux-cli.js; null when no tmux exists at all (callers t.skip()).
function tmuxBinary() {
  const bin = resolveTmuxBin(process.env.TMUX_BIN || '');
  const probe = spawnSync(bin, ['-V'], { encoding: 'utf8' });
  return probe.status === 0 ? bin : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 5000, every = 50, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > until) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(every);
  }
}

async function startTmux(opts) {
  const o = opts || {};
  const cols = o.cols || 120;
  const rows = o.rows || 40;
  const bin = tmuxBinary();
  if (!bin) return null;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p18-tmux-')));
  const socket = path.join(dir, 's');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: dir,
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  // `lazy: true` reserves the socket path without starting the server (a bridge that boots before
  // its tmux); srv.launch() starts it later.
  let server = null;
  let exited = Promise.resolve();
  const launch = async () => {
    server = spawn(bin, ['-u', '-D', '-S', socket, '-f', '/dev/null'], { env, stdio: 'ignore' });
    exited = new Promise((resolve) => server.on('exit', resolve));
    server.on('error', () => {});
    try {
      await waitFor(() => fs.existsSync(socket), { what: 'the tmux socket' });
      await runOk(['set-option', '-g', 'default-size', `${cols}x${rows}`]);
    } catch (e) {
      try { server.kill('SIGKILL'); } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  };
  const run = (args, runOpts) => new Promise((resolve) => {
    const ro = runOpts || {};
    const child = execFile(bin, ['-u', '-S', socket, ...args], { env, timeout: ro.timeout || 8000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
    child.stdin.on('error', () => {});
    if (typeof ro.input === 'string') child.stdin.end(ro.input); else child.stdin.end();
  });
  const runOk = async (args, runOpts) => {
    const r = await run(args, runOpts);
    if (r.code !== 0) throw new Error(`tmux ${args.join(' ')} -> ${r.code}: ${r.stderr}`);
    return r.stdout;
  };

  if (!o.lazy) await launch();

  const srv = {
    dir, socket, tmuxBin: bin, env, run, runOk, waitFor, launch,
    // the emulator under test, pinned to THIS server's socket (last, so `extra` cannot move it)
    cli: (extra) => createTmuxCli({ tmuxBin: bin, session: 'main', home: dir, ...(extra || {}), socket }),
    display: async (target, fmt) => (await runOk(['display', '-p', '-t', target, fmt])).trim(),
    startTime: async () => Number((await runOk(['display', '-p', '#{start_time}'])).trim()),
    capture: async (target, extra) => runOk(['capture-pane', '-p', '-t', target, ...(extra || [])]),
    // type a shell line into a pane; the tests' own control path, never the emulator's
    type: (target, line) => runOk(['send-keys', '-t', target, '-l', '--', line]).then(() => runOk(['send-keys', '-t', target, 'Enter'])),
    async stop() {
      if (server && server.exitCode === null && server.signalCode === null) {
        await run(['kill-server']);
        const hard = setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
        await exited;
        clearTimeout(hard);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return srv;
}

module.exports = { startTmux, tmuxBinary, waitFor, sleep };
