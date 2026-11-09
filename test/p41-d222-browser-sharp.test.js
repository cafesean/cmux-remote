'use strict';
// p41 D222 — browser pane frames sized to the client's pane: `px` (device-pixel width) parsing,
// clamp, never-upscale, legacy 800 px cap without px, raised JPEG qualities. Pure, offline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sp = require('../lib/browser-shot-params');

const png = (w, h) => { const b = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

test('parsePx: absent/garbage -> null (legacy path)', () => {
  for (const v of [undefined, null, '', 'abc', 'NaN', '-5', '0', 'Infinity']) assert.equal(sp.parsePx(v), null, String(v));
});
test('parsePx: clamps to 600..2400 and rounds', () => {
  assert.equal(sp.parsePx('1179'), 1179);
  assert.equal(sp.parsePx(1179.6), 1180);
  assert.equal(sp.parsePx('320'), 600);
  assert.equal(sp.parsePx('9999'), 2400);
  assert.equal(sp.PX_MIN, 600);
  assert.equal(sp.PX_MAX, 2400);
});
test('pngSize: reads IHDR, rejects non-PNG', () => {
  assert.deepEqual(sp.pngSize(png(2880, 1800)), { w: 2880, h: 1800 });
  assert.equal(sp.pngSize(Buffer.alloc(64, 7)), null);
  assert.equal(sp.pngSize(null), null);
});
test('resizeArgs: no px -> legacy -Z 800', () => {
  assert.deepEqual(sp.resizeArgs({}), ['-Z', '800']);
  assert.deepEqual(sp.resizeArgs({ src: { w: 2880, h: 1800 } }), ['-Z', '800']);
});
test('resizeArgs: px -> resample to px wide; never upscale; shrink=false never resamples', () => {
  assert.deepEqual(sp.resizeArgs({ px: 1179, src: { w: 2880, h: 1800 } }), ['--resampleWidth', '1179']);
  assert.deepEqual(sp.resizeArgs({ px: 2400, src: { w: 1600, h: 1200 } }), []);
  assert.deepEqual(sp.resizeArgs({ px: 1179, src: null }), ['--resampleWidth', '1179']);
  assert.deepEqual(sp.resizeArgs({ shrink: false, px: 1179, src: { w: 2880, h: 1800 } }), []);
});
test('JPEG qualities raised: 80 settled / 55 moving', () => {
  assert.equal(sp.JPEG_Q, '80');
  assert.equal(sp.JPEG_Q_MOVING, '55');
});
test('wiring: bridge passes px on shot + scroll; server forwards px on shot', () => {
  const b = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  assert.match(b, /cmuxBrowserShot\(res, s, shotParams\.parsePx\(u\.searchParams\.get\('px'\)\)\)/);
  assert.match(b, /scrollFrame\(surface, shotParams\.parsePx\(b\.px\)\)/);
  assert.match(b, /shotParams\.resizeArgs\(\{ shrink, px, src: shotParams\.pngSize\(png\) \}\)/);
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(s, /qs\.set\('px', px\)/);
});
