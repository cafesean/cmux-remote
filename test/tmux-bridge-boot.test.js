'use strict';
// p18 STORY-004 — bridge.js BACKEND selection at boot (specs.md §5.1, D1).
//
// Real bridge.js children on ephemeral ports (test/helpers/bridge-child.js). The cmux backend runs
// against a fake cmux (CMUX_BIN); the tmux backend against a throwaway tmux on a private socket.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge, callBridge, BRIDGE_JS } = require('./helpers/bridge-child');
const { writeFakeCmux } = require('./helpers/fake-cmux');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');

const skip = tmuxBinary() ? false : 'tmux not installed';
const SECRET = 'p18-boot-secret';

test('BACKEND=bogus: exits non-zero with the refusal and never announces a port', async () => {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p18-bogus-')));
  try {
    const child = spawn(process.execPath, [BRIDGE_JS], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: os.tmpdir(), BRIDGE_PORT: '0', BRIDGE_HOST: '127.0.0.1', BACKEND: 'bogus' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    assert.notEqual(code, 0);
    assert.match(err, /BACKEND must be "cmux" or "tmux" \(got "bogus"\) — refusing to start/);
    assert.doesNotMatch(out, /cmux-remote bridge on/);
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('BACKEND unset: /cmux/tree carries the cmux capabilities', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p18-fake-')));
  const fake = writeFakeCmux(dir);
  const b = await bootBridge({ env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET } });
  try {
    const r = await callBridge(b.base, '/cmux/tree', { secret: SECRET });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.capabilities, { backend: 'cmux', browser: true, sidebarStatus: true, tabsInPane: true, radar: true });
    assert.match(b.stdout(), /backend: cmux/);
  } finally {
    await b.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('BACKEND=tmux: tmux capabilities, and `main` exists right after boot, before any request', { skip }, async () => {
  const srv = await startTmux({ cols: 100, rows: 30 });
  const b = await bootBridge({ env: { BACKEND: 'tmux', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin, BRIDGE_SECRET: SECRET } });
  try {
    await waitFor(async () => (await srv.run(['list-sessions', '-F', '#{session_name}'])).stdout.trim() === 'main', { what: 'boot-time ensure()' });
    await waitFor(() => /tmux: ready \(epoch \d+, tmux /.test(b.stdout()), { what: 'the ready log line' });
    assert.match(b.stdout(), /backend: tmux/);
    const r = await callBridge(b.base, '/cmux/tree', { secret: SECRET });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.capabilities, { backend: 'tmux', browser: false, sidebarStatus: false, tabsInPane: false, radar: false });
    assert.equal(r.json.workspaces.length, 1);
    assert.equal(r.json.workspaces[0].tabs[0].status, '');       // no sidebar status source on tmux
  } finally {
    await b.stop();
    await srv.stop();
  }
});

test('BACKEND=tmux with the tmux server not up yet: the bridge still boots, and picks tmux up later', { skip }, async () => {
  const srv = await startTmux({ cols: 100, rows: 30, lazy: true });
  const b = await bootBridge({ env: { BACKEND: ' TMUX ', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin, BRIDGE_SECRET: SECRET } });
  try {
    await waitFor(() => /tmux: not ready yet — tmux_unavailable: /.test(b.stdout()), { what: 'the not-ready log line' });
    const down = await callBridge(b.base, '/cmux/tree', { secret: SECRET });
    assert.equal(down.status, 502);
    assert.equal(down.json.error, 'cmux_failed');
    await srv.launch();
    const up = await callBridge(b.base, '/cmux/tree', { secret: SECRET });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.capabilities.backend, 'tmux');
    assert.equal(up.json.workspaces.length, 1);
    assert.equal((await srv.runOk(['list-sessions', '-F', '#{session_name}'])).trim(), 'main');
  } finally {
    await b.stop();
    await srv.stop();
  }
});
