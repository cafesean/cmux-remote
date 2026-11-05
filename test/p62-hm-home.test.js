'use strict';
// p62 S1: HYPERMUX_HOME state root. Unset = every path exactly as before (hand installs);
// set = state under it; explicit per-file env still wins; devices.json/server-id never move.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

// Each probe runs in a fresh child so module-level defaults are evaluated under the given env.
function probe(env) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p62-home-')));
  const code = `
    const p = require('path');
    const out = {};
    out.home = require('os').homedir();
    out.upload = require(${JSON.stringify(path.join(REPO, 'lib/hm-home.js'))}).uploadDir();
    // alerts: DEFAULT_FILE is module-private; read it back through the createAlerts default.
    const src = require('fs').readFileSync(${JSON.stringify(path.join(REPO, 'lib/alerts.js'))}, 'utf8');
    out.alertsRoutes = /statePath\\('push.json'/.test(src);
    out.alerts = require(${JSON.stringify(path.join(REPO, 'lib/hm-home.js'))}).statePath('push.json', p.join(out.home, '.local', 'share', 'cmux-remote', 'push.json'));
    out.accounts = require(${JSON.stringify(path.join(REPO, 'lib/accounts-meta.js'))}).filePath
      ? require(${JSON.stringify(path.join(REPO, 'lib/accounts-meta.js'))}).filePath() : null;
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(home, { recursive: true, force: true });
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const { statePath, uploadDir, home } = require('../lib/hm-home');

test('unset -> legacy paths unchanged', () => {
  const env = {};
  assert.equal(home(env), '');
  assert.equal(statePath('push.json', '/legacy/push.json', env), '/legacy/push.json');
  assert.equal(uploadDir(env), `${os.homedir()}/Downloads/cmux-remote`);
  const o = probe({});
  assert.equal(o.upload, `${o.home}/Downloads/cmux-remote`);
  assert.equal(o.alerts, path.join(o.home, '.local', 'share', 'cmux-remote', 'push.json'));
  assert.ok(o.alertsRoutes, 'alerts.js routes its default through hm-home');
});

test('empty or relative HYPERMUX_HOME counts as unset', () => {
  assert.equal(statePath('a.json', '/legacy/a.json', { HYPERMUX_HOME: '' }), '/legacy/a.json');
  assert.equal(statePath('a.json', '/legacy/a.json', { HYPERMUX_HOME: '  ' }), '/legacy/a.json');
  assert.equal(statePath('a.json', '/legacy/a.json', { HYPERMUX_HOME: 'rel/dir' }), '/legacy/a.json');
});

test('set -> under HYPERMUX_HOME', () => {
  const env = { HYPERMUX_HOME: '/hm/state' };
  assert.equal(statePath('push.json', '/legacy/push.json', env), '/hm/state/push.json');
  assert.equal(uploadDir(env), '/hm/state/uploads');
  const o = probe({ HYPERMUX_HOME: '/hm/state' });
  assert.equal(o.upload, '/hm/state/uploads');
  assert.equal(o.alerts, '/hm/state/push.json');
});

test('each of the four call sites goes through hm-home', () => {
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  assert.match(read('lib/alerts.js'), /hm-home'\)\.statePath\('push\.json'/);
  assert.match(read('lib/accounts-meta.js'), /hm-home'\)\.statePath\('accounts\.json'/);
  assert.match(read('lib/private-surfaces.js'), /hm-home'\)\.statePath\('private-surfaces\.json'/);
  assert.match(read('bridge.js'), /const UPLOAD_DIR = require\('\.\/lib\/hm-home'\)\.uploadDir\(\)/);
});

test('explicit per-file env (HYPERMUX_ACCOUNTS_FILE, UPLOAD_DIR) still wins', () => {
  assert.equal(uploadDir({ HYPERMUX_HOME: '/hm/state', UPLOAD_DIR: '/x/up' }), '/x/up');
  const r = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(path.join(REPO, 'lib/accounts-meta.js'))});
    const src = require('fs').readFileSync(${JSON.stringify(path.join(REPO, 'lib/accounts-meta.js'))}, 'utf8');
    console.log(/process\\.env\\.HYPERMUX_ACCOUNTS_FILE\\s*\\n?\\s*\\|\\|\\s*require\\('\\.\\/hm-home'\\)/.test(src));`],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  assert.equal(r.stdout.trim(), 'true', 'HYPERMUX_ACCOUNTS_FILE is checked before HYPERMUX_HOME');
  const ps = fs.readFileSync(path.join(REPO, 'lib/private-surfaces.js'), 'utf8');
  assert.match(ps, /HYPERMUX_PRIVATE_FILE\s*\n\s*\|\|\s*require\('\.\/hm-home'\)/);
  const al = fs.readFileSync(path.join(REPO, 'lib/alerts.js'), 'utf8');
  assert.match(al, /process\.env\.PUSH_STATE_FILE \|\| DEFAULT_FILE/);
});

test('devices.json and server-id path ignores HYPERMUX_HOME', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/pairing.js'), 'utf8');
  assert.match(src, /const DEFAULT_FILE = path\.join\(os\.homedir\(\), '\.config', 'cmux-remote', 'devices\.json'\);/);
  assert.doesNotMatch(src, /hm-home|HYPERMUX_HOME/);
});
