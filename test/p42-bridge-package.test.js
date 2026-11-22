'use strict';
// HyprMux Bridge packaging: LaunchAgent plists, Info.plist, package-bridge.sh output, no auto-install code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APPDIR = path.join(ROOT, 'scripts', 'bridge-app');
const BUNDLE_ID = 'com.hyprmux.bridge';
const AGENTS = ['daemon', 'server', 'tunnel', 'core'];
const mac = process.platform === 'darwin';

function plistJson(file) {
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
}

test('four LaunchAgent plists lint with pinned labels and the Bridge bundle id', { skip: !mac }, () => {
  const files = fs.readdirSync(path.join(APPDIR, 'LaunchAgents')).sort();
  assert.deepStrictEqual(files, AGENTS.map((a) => `${BUNDLE_ID}.${a}.plist`).sort());
  for (const a of AGENTS) {
    const f = path.join(APPDIR, 'LaunchAgents', `${BUNDLE_ID}.${a}.plist`);
    execFileSync('plutil', ['-lint', '-s', f]);
    const p = plistJson(f);
    assert.strictEqual(p.Label, `${BUNDLE_ID}.${a}`);
    assert.deepStrictEqual(p.AssociatedBundleIdentifiers, [BUNDLE_ID]);
    const prog = a === 'core' ? 'Contents/MacOS/HyprMuxBridge' : 'Contents/MacOS/hyprmux-runtime';
    assert.strictEqual(p.BundleProgram, prog);
  }
  assert.deepStrictEqual(plistJson(path.join(APPDIR, 'LaunchAgents', `${BUNDLE_ID}.core.plist`)).ProgramArguments, ['HyprMuxBridge', '--core']);
  assert.deepStrictEqual(plistJson(path.join(APPDIR, 'LaunchAgents', `${BUNDLE_ID}.daemon.plist`)).ProgramArguments, ['hyprmux-runtime', 'bridge']);
});

test('package-bridge.sh assembles HyprMux Bridge.app (stub binaries)', { skip: !mac }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pkg-'));
  try {
    const stub = path.join(tmp, 'stub');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const rt = path.join(tmp, 'rt');
    fs.mkdirSync(path.join(rt, 'server'), { recursive: true });
    fs.copyFileSync(stub, path.join(rt, 'hyprmux-runtime'));
    const out = path.join(tmp, 'out');
    execFileSync(path.join(APPDIR, 'package-bridge.sh'), [out, path.join(tmp, 'work')], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_MENU_BIN: stub, BRIDGE_RUNTIME_DIR: rt, BRIDGE_CLOUDFLARED_BIN: stub, BRIDGE_SCREEN_STREAM_BIN: stub },
      stdio: 'pipe',
    });
    const c = path.join(out, 'HyprMux Bridge.app', 'Contents');
    for (const b of ['HyprMuxBridge', 'hyprmux-runtime', 'cloudflared', 'hm-screen-stream']) {
      const st = fs.statSync(path.join(c, 'MacOS', b));
      assert.ok(st.mode & 0o111, `${b} executable`);
    }
    const info = plistJson(path.join(c, 'Info.plist'));
    assert.strictEqual(info.CFBundleIdentifier, BUNDLE_ID);
    assert.strictEqual(info.LSUIElement, true);
    assert.strictEqual(info.CFBundleShortVersionString, require('../package.json').version);
    assert.strictEqual(fs.readdirSync(path.join(c, 'Library', 'LaunchAgents')).length, 4);
    for (const png of ['StatusBarIconTemplate.png', 'StatusBarIconTemplate@2x.png']) {
      assert.ok(fs.statSync(path.join(c, 'Resources', png)).size > 0, png);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Bridge has no auto-install code (no Sparkle, no installer launch, no write into /Applications)', () => {
  const dir = path.join(ROOT, 'native', 'hyprmux-bridge', 'Sources');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.build') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.swift')) files.push(p);
    }
  })(dir);
  assert.ok(files.length >= 6);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /Sparkle|SPUUpdater/, f);
    assert.doesNotMatch(src, /\/usr\/sbin\/installer|hdiutil|ditto|\.pkg"/, f);
    assert.doesNotMatch(src, /"\/Applications/, f);
    // the only Processes launched: launchctl, and ps -o comm= (read-only: a BundleProgram job's executable path)
    for (const m of src.matchAll(/URL\(fileURLWithPath: "([^"]+)"\)|run\("([^"]+)"/g)) {
      assert.ok(['/bin/launchctl', '/bin/ps'].includes(m[1] || m[2]), f + ': ' + (m[1] || m[2]));
    }
  }
});

test('menu bar shows the logo (template image), status in the tooltip, reopen opens the menu', () => {
  const main = fs.readFileSync(path.join(ROOT, 'native', 'hyprmux-bridge', 'Sources', 'HyprMuxBridge', 'main.swift'), 'utf8');
  assert.match(main, /Bundle\.main\.image\(forResource: MenuBarStatus\.iconName\)/);
  assert.match(main, /isTemplate = true/);
  assert.match(main, /toolTip = MenuBarStatus\.toolTip\(statusText\)/);
  assert.doesNotMatch(main, /button\?\.title = "HyprMux/);
  assert.match(main, /func applicationShouldHandleReopen\(/);
  assert.match(main, /app\.delegate = controller/);
  for (const png of ['StatusBarIconTemplate.png', 'StatusBarIconTemplate@2x.png']) {
    assert.ok(fs.existsSync(path.join(APPDIR, 'Resources', png)), png);
  }
});

test('package.json version is a Bridge 0.x release (0.2.x field fixes, 0.3.x video Remote Desktop)', () => {
  assert.match(require('../package.json').version, /^0\.[23]\.\d+$/);
});

test('Connect refresh token is kept only in the Keychain store (never written to a file, never logged)', () => {
  const dir = path.join(ROOT, 'native', 'hyprmux-bridge', 'Sources');
  const src = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.swift'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const line of src.split('\n')) {
    if (/writePrivate\(|createFile\(|\.write\(to:|print\(|NSLog\(/.test(line)) assert.doesNotMatch(line, /refresh/i, line);
  }
  assert.match(src, /keychain\.write\(service: InstallKeyStore\.service, account: Self\.refreshAccount/);
});

// Screen video helper (F1): prebuilt hm-screen-stream sits next to hyprmux-runtime in Contents/MacOS,
// is signed before the app (inside-out), and the compiled runtime finds it there.
function stubPackage(tmp) {
  const stub = path.join(tmp, 'stub');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const rt = path.join(tmp, 'rt');
  fs.mkdirSync(path.join(rt, 'server'), { recursive: true });
  fs.copyFileSync(stub, path.join(rt, 'hyprmux-runtime'));
  const out = path.join(tmp, 'out');
  execFileSync(path.join(APPDIR, 'package-bridge.sh'), [out, path.join(tmp, 'work')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_MENU_BIN: stub, BRIDGE_RUNTIME_DIR: rt, BRIDGE_CLOUDFLARED_BIN: stub, BRIDGE_SCREEN_STREAM_BIN: stub },
    stdio: 'pipe',
  });
  return path.join(out, 'HyprMux Bridge.app');
}

test('sign-bridge.sh dry run signs hm-screen-stream (hardened, no JIT entitlements) before the app', { skip: !mac }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sign-'));
  try {
    const app = stubPackage(tmp);
    const log = execFileSync(path.join(APPDIR, 'sign-bridge.sh'), [app, path.join(tmp, 'signed')], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SIGN_DRY_RUN: '1', SIGN_ID: 'TEST' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const signs = log.split('\n').filter((l) => l.startsWith('codesign '));
    const idx = (re) => signs.findIndex((l) => re.test(l));
    const helper = idx(/MacOS\/hm-screen-stream'?$/);
    const appLine = idx(/HyprMux Bridge\.app'?$/);
    assert.ok(helper >= 0, 'helper signed:\n' + log);
    assert.ok(appLine > helper, 'helper signed before the app:\n' + log);
    assert.match(signs[helper], /--options runtime/);
    assert.doesNotMatch(signs[helper], /--entitlements/);
    assert.ok(idx(/MacOS\/hyprmux-runtime'?$/) < appLine && idx(/MacOS\/HyprMuxBridge'?$/) < appLine);
    assert.doesNotMatch(log, /notarytool|hdiutil create/, 'dry run never notarizes or builds a DMG');
    assert.ok(!fs.existsSync(path.join(tmp, 'signed', 'HyprMuxBridge.dmg')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sign-bridge.sh refuses a package without hm-screen-stream', { skip: !mac }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sign-'));
  try {
    const app = stubPackage(tmp);
    fs.rmSync(path.join(app, 'Contents', 'MacOS', 'hm-screen-stream'));
    const r = require('child_process').spawnSync(path.join(APPDIR, 'sign-bridge.sh'), [app, path.join(tmp, 'signed')], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SIGN_DRY_RUN: '1', SIGN_ID: 'TEST' }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /missing MacOS\/hm-screen-stream/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('compiled runtime finds hm-screen-stream next to itself in Contents/MacOS', { skip: !mac }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lookup-'));
  try {
    const app = stubPackage(tmp);
    const { helperLookup } = require('../lib/screen-stream.js');
    const macos = path.join(app, 'Contents', 'MacOS');
    const r = helperLookup({ env: {}, execPath: path.join(macos, 'hyprmux-runtime'), run: () => { throw new Error('no toolchain on a user Mac'); } });
    assert.deepStrictEqual(r, { bin: path.join(macos, 'hm-screen-stream') });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
