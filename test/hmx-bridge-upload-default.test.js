'use strict';
// HyprMux Bridge 0.3.6: uploads default to ~/HyprMux-Uploads (not ~/Downloads/cmux-remote), and a user's own
// UPLOAD_DIR line in the Bridge env file wins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bridgeUploadDefault } = require('../lib/hm-home');

test('no UPLOAD_DIR line -> ~/HyprMux-Uploads under the given home, no spaces', () => {
  const d = bridgeUploadDefault('PORT=63150\nSERVER_TOKEN=x\n', '/Users/someone');
  assert.strictEqual(d, '/Users/someone/HyprMux-Uploads');
  assert.ok(!/\s/.test(d));
  assert.ok(!d.includes('Downloads'));
});

test('a user UPLOAD_DIR line wins (no default set)', () => {
  assert.strictEqual(bridgeUploadDefault('PORT=1\nUPLOAD_DIR=/Users/someone/cmux-uploads\n', '/Users/someone'), null);
});

test('a commented or indented mention does not count as set', () => {
  assert.strictEqual(bridgeUploadDefault('# UPLOAD_DIR=/x\n', '/h'), '/h/HyprMux-Uploads');
});

test('empty or missing env text -> default', () => {
  assert.strictEqual(bridgeUploadDefault('', '/h'), '/h/HyprMux-Uploads');
  assert.strictEqual(bridgeUploadDefault(undefined, '/h'), '/h/HyprMux-Uploads');
});

test('the Bridge runtime applies it for the bridge mode only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bridge-app', 'hyprmux-runtime.js'), 'utf8');
  assert.match(src, /if \(mode === 'bridge'\) \{\s*const dflt = require\('\.\/lib\/hm-home'\)\.bridgeUploadDefault\(/);
});
