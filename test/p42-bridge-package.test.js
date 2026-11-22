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
const BUNDLE_ID = 'ai.yobolabs.hyprmux.bridge';
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
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_MENU_BIN: stub, BRIDGE_RUNTIME_DIR: rt, BRIDGE_CLOUDFLARED_BIN: stub },
      stdio: 'pipe',
    });
    const c = path.join(out, 'HyprMux Bridge.app', 'Contents');
    for (const b of ['HyprMuxBridge', 'hyprmux-runtime', 'cloudflared']) {
      const st = fs.statSync(path.join(c, 'MacOS', b));
      assert.ok(st.mode & 0o111, `${b} executable`);
    }
    const info = plistJson(path.join(c, 'Info.plist'));
    assert.strictEqual(info.CFBundleIdentifier, BUNDLE_ID);
    assert.strictEqual(info.LSUIElement, true);
    assert.strictEqual(info.CFBundleShortVersionString, require('../package.json').version);
    assert.strictEqual(fs.readdirSync(path.join(c, 'Library', 'LaunchAgents')).length, 4);
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
    // the only Process launched is launchctl
    for (const m of src.matchAll(/URL\(fileURLWithPath: "([^"]+)"\)|run\("([^"]+)"/g)) {
      assert.strictEqual(m[1] || m[2], '/bin/launchctl', f);
    }
  }
});

test('package.json version is the Bridge 0.2.x line', () => {
  assert.match(require('../package.json').version, /^0\.2\.\d+$/);
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
