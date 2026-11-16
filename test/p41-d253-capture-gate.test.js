'use strict';
// p41 D253 (HMX-130) — no screencapture while Screen Recording is KNOWN missing. On macOS 15+ every capture
// without the grant pops "<binary> would like to record this computer's screen" again; that prompt is itself
// a system dialog, so the dialog OCR re-captured it -> prompt loop. Proves: the dialog reader skips OCR (and
// caches nothing) while ocrAllowed() is false and OCRs once it turns true; /screen/shot answers
// screen_permission WITHOUT running screencapture when captureGranted() === false; null (unknown) still captures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDialogReader, DIALOG_OWNERS } = require('../lib/mac-dialogs');
const { createMacScreen } = require('../lib/mac-screen');

const OWNER = Object.keys(DIALOG_OWNERS)[0];
const OSA_OUT = JSON.stringify({ displays: [{ index: 1, x: 0, y: 0, w: 1512, h: 982, scale: 2 }],
  windows: [{ owner: OWNER, pid: 77, wid: 900, layer: 0, x: 500, y: 300, w: 400, h: 200, titled: false }] });

test('dialog OCR: skipped and not cached while ocrAllowed() is false; runs once allowed', async () => {
  let t = 0, allowed = false, ocrCalls = 0;
  const r = createDialogReader({ osa: async () => ({ ok: true, out: OSA_OUT }), prelude: '', now: () => (t += 10000),
    axRead: async (items) => items.map(() => ({ error: 'no_window' })),
    ocrRead: async (items) => { ocrCalls++; return items.map(() => ({ lines: [] })); },
    ocrAllowed: () => allowed });
  const a = await r.read();
  assert.equal(a.status, 200);
  assert.equal(a.body.dialogs.length, 1);
  assert.equal(ocrCalls, 0);
  await r.read();
  assert.equal(ocrCalls, 0);
  allowed = true;
  await r.read();
  assert.equal(ocrCalls, 1, 'grant arrives -> the same dialog is OCRed (nothing cached while blocked)');
});

function fakeBin(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!' + process.execPath + '\n' + body, { mode: 0o755 });
  return p;
}

test('/screen/shot: captureGranted false -> screen_permission, screencapture never runs; null -> captures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd253-'));
  const log = path.join(dir, 'cap.log');
  const env = { SCREEN_VIEW: '1',
    SCREEN_SCREENCAPTURE_BIN: fakeBin(dir, 'cap', `require('fs').appendFileSync(${JSON.stringify(log)}, 'x\\n'); require('fs').writeFileSync(process.argv[process.argv.length - 1], Buffer.alloc(64, 9));`),
    SCREEN_SIPS_BIN: fakeBin(dir, 'sips', `const a = process.argv.slice(2); require('fs').copyFileSync(a[a.indexOf('--out') - 1], a[a.indexOf('--out') + 1]);`),
    SCREEN_CAFFEINATE_BIN: fakeBin(dir, 'caff', ''),
    SCREEN_OSASCRIPT_BIN: fakeBin(dir, 'osa', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('ok\\n'));`) };
  let granted = false;
  const ms = createMacScreen({ env, secret: 's', host: '127.0.0.1', log: () => {}, captureGranted: () => granted,
    childEnv: () => ({ PATH: '/usr/bin:/bin' }) });
  const denied = await ms.shot('1');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'screen_permission');
  assert.equal(fs.existsSync(log), false, 'no screencapture while the grant is known missing');
  granted = null;
  const ok = await ms.shot('1');
  assert.equal(ok.status, 200);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
