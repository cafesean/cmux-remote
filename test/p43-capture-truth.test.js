'use strict';
// 0.3.1: /cmux/screen/info canCapture comes from a REAL capture, never from the JXA CGPreflightScreenCaptureAccess
// (that checks osascript, not the runtime). Before any capture: 'unknown'; a tiny probe capture settles it.
// FAKE osascript / screencapture only: never reads the real screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacScreen } = require('../lib/mac-screen');

const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
// The preflight inside osascript always says false (the field bug: osascript has no grant, the runtime does).
const FAKE_OSA = fake(String.raw`
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  if (s.includes('canCapture')) return process.stdout.write(JSON.stringify({ displays: [{ index: 1, id: 1, x: 0, y: 0, w: 10, h: 10, scale: 1 }], canCapture: false, canControl: true, secureInput: false, locked: false }) + '\n');
  process.stdout.write('ok\n');
});
`);
// screencapture: records its args; 'deny' file -> permission error; else writes a few bytes to the last arg.
const FAKE_CAP = fake(String.raw`
fs.appendFileSync(D + '/cap.log', JSON.stringify(process.argv.slice(2)) + '\n');
if (fs.existsSync(D + '/deny')) { process.stderr.write('could not create image from display\n'); process.exit(1); }
fs.writeFileSync(process.argv[process.argv.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
`);

function mk(probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p031cap-'));
  fs.writeFileSync(path.join(dir, 'osascript'), FAKE_OSA, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'screencapture'), FAKE_CAP, { mode: 0o755 });
  const env = { SCREEN_VIEW: '1', SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'), SCREEN_SCREENCAPTURE_BIN: path.join(dir, 'screencapture') };
  const ms = createMacScreen({ env, host: '127.0.0.1', log: () => {}, probeCapture: probe, childEnv: () => ({ PATH: '/usr/bin:/bin', FAKE_DIR: dir }) });
  const caps = () => { try { return fs.readFileSync(path.join(dir, 'cap.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
  return { ms, dir, caps };
}

test('no capture yet + osascript preflight false -> canCapture is not false (unknown)', async (t) => {
  const { ms, dir } = mk(false); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await ms.info();
  assert.equal(r.status, 200);
  assert.notEqual(r.body.canCapture, false);
  assert.equal(r.body.canCapture, 'unknown');
});

test('probe capture succeeds -> canCapture true; probe is one tiny 1x1 capture, run once', async (t) => {
  const { ms, dir, caps } = mk(true); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await ms.info();
  assert.equal(r.body.canCapture, true);
  const c = caps();
  assert.equal(c.length, 1);
  assert.ok(c[0].includes('-D') && !c[0].includes('-R'), 'probe captures the whole main display (a tiny -R rect always fails on macOS)');
  assert.equal((await ms.info()).body.canCapture, true);
  assert.equal(caps().length, 1, 'no second probe once known');
  assert.ok(ms.observed().capture > 0, 'D189 ground truth stamped');
});

test('probe capture fails with a permission error -> canCapture false', async (t) => {
  const { ms, dir } = mk(true); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'deny'), '1');
  assert.equal(await ms.probeCapture(), false);
  assert.equal((await ms.info()).body.canCapture, false);
});

test('a real shot after a failed probe flips canCapture to true', async (t) => {
  const { ms, dir } = mk(true); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'deny'), '1');
  assert.equal(await ms.probeCapture(), false);
  fs.rmSync(path.join(dir, 'deny'));
  const s = await ms.shot('1');
  assert.equal(s.status, 200);
  assert.equal((await ms.info()).body.canCapture, true);
});
