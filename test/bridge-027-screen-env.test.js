'use strict';
// Bridge 0.2.7: the .env the HyprMux Bridge writes (State.swift ensure()) turns the Mac screen on.
// A child node runs in a temp dir holding that .env, loads it with loadenv.js (as server/bridge do) and
// builds lib/mac-screen with the resulting env. No real capture, no real input.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROBE = `require(${JSON.stringify(path.join(ROOT, 'loadenv'))});
const { createMacScreen } = require(${JSON.stringify(path.join(ROOT, 'lib', 'mac-screen'))});
const s = createMacScreen({ env: process.env, secret: 'synthetic', socket: '/tmp/x.sock', log: () => {} });
process.stdout.write(JSON.stringify({ flags: s.flags, devices: process.env.DEVICES_FILE, plan: process.env.HMX_PLAN_STATE_DIR }));`;

function bridgeEnv(stateDir, extra = []) {
  // Same shape and quoting as BridgeState.ensure() on first run.
  return ['# HyprMux Bridge server (written on first run; 0600).', 'PORT=4123', 'HOST=127.0.0.1',
    `DEVICES_FILE="${stateDir}/devices.json"`, `HMX_PLAN_STATE_DIR="${stateDir}"`, 'HMX_HUB_URL=https://hub.appmatic.io',
    ...extra].join('\n') + '\n';
}

function probe(envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b027-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), envText, { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: dir };   // no SCREEN_* from the test runner
    return { dir, out: JSON.parse(execFileSync(process.execPath, ['-e', PROBE], { cwd: dir, env, encoding: 'utf8' })) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const STATE = '/Users/someone/Library/Application Support/HyprMux';

test('Bridge .env with SCREEN_VIEW=1 / SCREEN_CONTROL=1 turns mac-screen view + control on', () => {
  const { out } = probe(bridgeEnv(STATE, ['SCREEN_VIEW=1', 'SCREEN_CONTROL=1']));
  assert.deepEqual(out.flags, { view: true, control: true });
});

test('quoted values with spaces load unquoted', () => {
  const { out } = probe(bridgeEnv(STATE, ['SCREEN_VIEW=1', 'SCREEN_CONTROL=1']));
  assert.equal(out.devices, STATE + '/devices.json');
  assert.equal(out.plan, STATE);
});

test('a .env without the flags (0.2.6 and earlier) keeps the screen off', () => {
  const { out } = probe(bridgeEnv(STATE));
  assert.deepEqual(out.flags, { view: false, control: false });
});

test('a user SCREEN_CONTROL=0 keeps control off, view on', () => {
  const { out } = probe(bridgeEnv(STATE, ['SCREEN_CONTROL=0', 'SCREEN_VIEW=1']));
  assert.deepEqual(out.flags, { view: true, control: false });
});

test('the quoted .env survives a shell source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b027sh-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), bridgeEnv(STATE, ['SCREEN_VIEW=1', 'SCREEN_CONTROL=1']), { mode: 0o600 });
    const got = execFileSync('/bin/sh', ['-c', 'set -a; . ./.env; printf %s "$DEVICES_FILE|$SCREEN_VIEW"'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(got, STATE + '/devices.json|1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
