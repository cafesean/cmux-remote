'use strict';
// p43 locked-state: a locked Mac (loginwindow holds Secure Keyboard Entry) cannot take remote typing. The bridge
// SAYS so: /cmux/screen/info reports locked + the secure-input owner (process name only), key/type answer 423
// mac_locked while clicks still pass, and the video path emits a type-5 meta {kind:'locked'} on change.
// FAKE osascript / ioreg / ps only: never reads the real session, never posts real input.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacScreen } = require('../lib/mac-screen');
const S = require('../lib/screen-stream');

const fake = (body) => '#!' + process.execPath + '\n' + "'use strict';const fs=require('fs');const D=process.env.FAKE_DIR;" + body;
const FAKE_OSA = fake(String.raw`
let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const locked = fs.existsSync(D + '/locked');
  if (s.includes('lockProbe')) return process.stdout.write(JSON.stringify({ lockProbe: 1, locked, secureInput: locked }) + '\n');
  if (s.includes('canCapture')) return process.stdout.write(JSON.stringify({ displays: [{ index: 1, id: 1, x: 0, y: 0, w: 10, h: 10, scale: 1 }], canCapture: true, canControl: true, secureInput: locked, locked }) + '\n');
  fs.appendFileSync(D + '/posted.log', 'x\n');
  process.stdout.write('ok\n');
});
`);
const FAKE_IOREG = fake("process.stdout.write('+-o Root  <class IORegistryEntry>\\n    | \"IOConsoleUsers\" = ({\"kCGSSessionScreenIsLocked\"=Yes,\"kCGSSessionSecureInputPID\"=405,\"kCGSSessionUserNameKey\"=\"u\"})\\n');");
const FAKE_PS = fake("if (process.argv.includes('405')) process.stdout.write('/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow\\n'); else process.exit(1);");

function mkScreen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p43lock-'));
  for (const [n, src] of [['osascript', FAKE_OSA], ['ioreg', FAKE_IOREG], ['ps', FAKE_PS]]) fs.writeFileSync(path.join(dir, n), src, { mode: 0o755 });
  const env = { SCREEN_VIEW: '1', SCREEN_CONTROL: '1', SCREEN_OSASCRIPT_BIN: path.join(dir, 'osascript'), SCREEN_IOREG_BIN: path.join(dir, 'ioreg'), SCREEN_PS_BIN: path.join(dir, 'ps') };
  const ms = createMacScreen({ env, host: '127.0.0.1', log: () => {}, childEnv: () => ({ PATH: '/usr/bin:/bin', FAKE_DIR: dir }) });
  return { ms, dir, posted: () => { try { return fs.readFileSync(path.join(dir, 'posted.log'), 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; } } };
}

test('info: locked + secureInputOwner (name only); unlocked -> locked false, owner null', async (t) => {
  const { ms, dir } = mkScreen(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let r = await ms.info();
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, false);
  assert.equal(r.body.secureInputOwner, null);
  fs.writeFileSync(path.join(dir, 'locked'), '1');
  r = await ms.info();
  assert.equal(r.body.locked, true);
  assert.equal(r.body.secureInput, true);
  assert.equal(r.body.secureInputOwner, 'loginwindow');
});

test('0.3.2 locked: key/type still post (lock-screen password, D97 probe 2026-11-06); tap posts', async (t) => {
  const { ms, dir, posted } = mkScreen(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'locked'), '1');
  const k = await ms.input('key', { key: 'tab' });
  assert.equal(k.status, 200, 'typing is never refused while locked');
  const ty = await ms.input('type', { text: 'hello' });
  assert.equal(ty.status, 200);
  assert.equal(posted(), 2, 'both keystrokes reached osascript');
  const tap = await ms.input('tap', { fx: 0.5, fy: 0.5 });
  assert.equal(tap.status, 200);
  assert.equal(posted(), 3);
  fs.rmSync(path.join(dir, 'locked'));
  const ok = await ms.input('key', { key: 'tab' });   // lock answer is cached ≤1 s; a fresh probe after it
  assert.equal(ok.status, 200);
  const st = await ms.lockState({ fresh: true });
  assert.equal(st.locked, false);
});

const fakeHelper = (dir, behaviour) => {
  const p = path.join(dir, 'hm-screen-stream');
  const fx = path.join(__dirname, 'fixtures', 'p43-fake-helper.js');
  fs.writeFileSync(p, '#!/bin/sh\nFAKE_HELPER_MODE=' + behaviour + ' exec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(fx) + '\n', { mode: 0o755 });
  return p;
};
const sink = () => { const s = { got: [], write: (b) => s.got.push(b) }; return s; };
const metas = (s) => s.got.flatMap((b) => { const d = []; S.createDeframer({ onPacket: (p, h) => { if (h.type === 5) d.push(JSON.parse(p.subarray(42))); }, onError: () => {} }).push(b); return d; });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(10); } };

test('video path: locked meta on attach + change; 0.3.2 key/type items still forwarded while locked', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p43lockss-'));
  let lock = { locked: true, secureInput: true, secureInputOwner: 'loginwindow' };
  const ss = S.createScreenStream({ lookup: () => S.helperLookup({ env: { SCREEN_STREAM_BIN: fakeHelper(dir, 'ok') } }),
    flags: { view: true, control: true }, log: () => {}, focusPollMs: 20, stopAfterMs: 50, backoffMs: [20],
    jxaRelease: async () => 'ok', lockState: async () => lock });
  t.after(() => { ss.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = sink();
  assert.ok(ss.attach(7, 1, s).ok);
  await until(() => metas(s).some((m) => m.kind === 'locked'));
  assert.deepEqual(metas(s).find((m) => m.kind === 'locked'), { kind: 'locked', locked: true, secureInputOwner: 'loginwindow' });
  assert.ok((await ss.openControl(7, 1, 1)).ok);
  const kr = await ss.input({ gen: 1, epoch: 1, items: [{ seq: 1, t: 'key', key: 'a', mods: [], code: 0, flags: 0 }] });
  assert.equal(kr.status, 200, 'typing is never refused while locked');
  const tr = await ss.input({ gen: 1, epoch: 1, items: [{ seq: 2, t: 'type', text: 'x' }, { seq: 3, t: 'tap', fx: 0.5, fy: 0.5 }] });
  assert.equal(tr.status, 200);
  const mr = await ss.input({ gen: 1, epoch: 1, items: [{ seq: 4, t: 'mouse', kind: 'move', fx: 0.5, fy: 0.5 }] });
  assert.equal(mr.status, 200);
  lock = { locked: false, secureInput: false, secureInputOwner: null };
  await until(() => metas(s).some((m) => m.kind === 'locked' && m.locked === false));
  const ok = await ss.input({ gen: 1, epoch: 1, items: [{ seq: 5, t: 'key', key: 'a', mods: [], code: 0, flags: 0 }] });
  assert.equal(ok.status, 200);
});
