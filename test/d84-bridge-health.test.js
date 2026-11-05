'use strict';
// D84: the watchdog's bridge probe (scripts/watchdog/bridge-health.py) must not call a slow cmux
// a wedged bridge. A REAL bridge.js child on an ephemeral port, with a fake cmux whose `tree`
// sleeps past the probe's 8 s budget (an Xcode build starving cmux.app): the probe must report
// exit 2 `cmux_upstream_slow` (no restart) because /healthz still answers. A dead bridge must
// still be exit 1 `bridge_unreachable` (restart). Never touches the live :8799 bridge.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const PROBE = path.join(REPO, 'scripts', 'watchdog', 'bridge-health.py');
const SECRET = 'd84-test-secret';   // fake, test-only

function fixture(treeDelayS) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd84-')));
  const bin = path.join(dir, 'fake-cmux');
  fs.writeFileSync(bin, `#!/bin/bash
case "$*" in
  *tree*) sleep ${treeDelayS}; echo '{"windows":[{"workspaces":[{"ref":"workspace:1","id":"aaaaaaa1-1111-4111-8111-111111111111","title":"w","panes":[{"ref":"pane:1","id":"aaaaaaa1-2222-4222-8222-222222222221","surfaces":[{"ref":"surface:1","id":"aaaaaaa1-3333-4333-8333-333333333331","type":"terminal","title":"t"}]}]}]}]}' ;;
  *list-notifications*) echo '[]' ;;
  *--version*) echo 'cmux 0.64.25' ;;
  *) echo 'claude_code=Running' ;;
esac
`, { mode: 0o755 });
  const release = path.join(dir, 'release');
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, '.env'), `BRIDGE_SECRET=${SECRET}\n`);
  fs.writeFileSync(path.join(dir, 'CURRENT_RELEASE'), release + '\n');
  return { dir, bin };
}

async function bootBridge(fx) {
  const child = spawn(process.execPath, [path.join(REPO, 'bridge.js')], {
    cwd: fx.dir,
    env: { ...process.env, HOME: fx.dir, CMUX_BIN: fx.bin, BRIDGE_PORT: '0', BRIDGE_HOST: '127.0.0.1',
      BRIDGE_SECRET: SECRET, BRIDGE_SOCKET: '', GIT_PANEL_ENABLED: '0', COMPLETIONS_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = ''; const t = setTimeout(() => reject(new Error('no listen: ' + out)), 15000);
    child.stdout.on('data', (d) => { out += d; const m = /bridge on [^:]+:(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
  });
  return { child, port };
}

function runProbe(fx, port) {
  const t0 = Date.now();
  return new Promise((resolve) => execFile('/usr/bin/python3', [PROBE], {
    env: { PATH: process.env.PATH, CMUX_REMOTE_SUPPORT_DIR: fx.dir, CMUX_BRIDGE_PROBE_BASE: `http://127.0.0.1:${port}` },
    timeout: 20000,
  }, (err, stdout) => resolve({ code: err ? err.code : 0, reason: String(stdout).trim(), ms: Date.now() - t0 })));
}

test('fast cmux: probe exit 0 bridge_functional_ok', async () => {
  const fx = fixture(0);
  const b = await bootBridge(fx);
  try {
    const r = await runProbe(fx, b.port);
    assert.deepStrictEqual([r.code, r.reason], [0, 'bridge_functional_ok']);
  } finally { b.child.kill('SIGKILL'); }
});

test('slow cmux (tree > 8 s): bridge still answers /healthz -> exit 2 cmux_upstream_slow, not a restart', async () => {
  const fx = fixture(10);
  const b = await bootBridge(fx);
  try {
    const r = await runProbe(fx, b.port);
    assert.deepStrictEqual([r.code, r.reason], [2, 'cmux_upstream_slow'], JSON.stringify(r));
    assert.ok(r.ms >= 8000 && r.ms < 12500, `probe took ${r.ms} ms`);
  } finally { b.child.kill('SIGKILL'); }
});

test('dead bridge: exit 1 bridge_unreachable (watchdog restarts it)', async () => {
  const fx = fixture(0);
  const b = await bootBridge(fx);
  const port = b.port;
  b.child.kill('SIGKILL');
  await new Promise((r) => b.child.on('exit', r));
  const r = await runProbe(fx, port);
  assert.deepStrictEqual([r.code, r.reason], [1, 'bridge_unreachable']);
});
