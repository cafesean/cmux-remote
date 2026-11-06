'use strict';
// p41 D136 — answer a Mac dialog from the phone. createMacScreen with a FAKE osascript (window list / input
// 'ok') and a FAKE AX helper (AX_HELPER_BIN); nothing real is read, pressed or typed.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMacScreen } = require('../lib/mac-screen');
const { enrich, classifyOcr, LIMITS } = require('../lib/mac-dialogs');
const AXL = require('../lib/ax-helper').LIMITS;

const DISPLAYS = [{ index: 1, x: 0, y: 0, w: 1512, h: 982, scale: 2 }];
const WIN = { owner: 'universalAccessAuthWarn', pid: 34724, layer: 0, x: 525, y: 226, w: 461, h: 181, titled: true };
const SECRET = 'hunter2-NEVER-LOGGED';
let dir;
const FAKE_OSA = '#!' + process.execPath + `\nconst fs=require('fs');const D=${JSON.stringify('')};let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const dir=process.env.FAKE_DIR;fs.appendFileSync(dir+'/osa-stdin.log',s+'\\n<<END>>\\n');process.stdout.write(s.includes('var PARAMS')?'ok\\n':fs.readFileSync(dir+'/windows.json','utf8'));});\n`;
const FAKE_AX = '#!' + process.execPath + `\nconst fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const dir=process.env.FAKE_DIR;fs.appendFileSync(dir+'/ax-req.log',s+'\\n');const q=JSON.parse(s);const A=JSON.parse(fs.readFileSync(dir+'/ax.json','utf8'));process.stdout.write(JSON.stringify(A[q.op]||{error:'bad_request'}));});\n`;
const READ = { buttons: [{ title: 'Deny', frame: { x: 700, y: 360, w: 80, h: 28 }, default: false }, { title: 'Open System Settings', frame: { x: 800, y: 360, w: 170, h: 28 }, default: true }],
  text: '"node" would like to control this computer using accessibility features.', password: false, fields: 0 };
const setAx = (o) => fs.writeFileSync(path.join(dir, 'ax.json'), JSON.stringify(o));
const setWins = (w) => fs.writeFileSync(path.join(dir, 'windows.json'), JSON.stringify({ displays: DISPLAYS, windows: w }));
function screen(flags = { SCREEN_VIEW: '1', SCREEN_CONTROL: '1' }) {
  const logs = [];
  const env = { ...flags, SCREEN_OSASCRIPT_BIN: path.join(dir, 'osa'), AX_HELPER_BIN: path.join(dir, 'ax') };
  const s = createMacScreen({ env, log: (m) => logs.push(m), childEnv: () => ({ PATH: '/usr/bin:/bin', FAKE_DIR: dir }) });
  return { s, logs };
}
before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd136-')));
  fs.writeFileSync(path.join(dir, 'osa'), FAKE_OSA, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ax'), FAKE_AX, { mode: 0o755 });
  setWins([WIN]);
  setAx({ read: { results: [READ] }, press: { ok: true }, focus: { ok: true } });
});
const idOf = async (s) => (await s.dialogs()).body.dialogs[0].id;

test('enrich: helper answer -> buttons with display fractions + default, text capped; error -> axError', () => {
  const e = enrich(READ, DISPLAYS, 1);
  assert.deepEqual(e.buttons.map((b) => [b.title, !!b.default]), [['Deny', false], ['Open System Settings', true]]);
  assert.deepEqual(e.buttons[0].rect, { fx: 0.463, fy: 0.3666, fw: 0.0529, fh: 0.0285 });
  assert.equal(JSON.stringify(e.buttons[0]).includes('abs'), false);
  assert.equal(enrich({ ...READ, text: 'x'.repeat(900) }, DISPLAYS, 1).text.length, LIMITS.AX_TEXT_MAX_CHARS);
  assert.deepEqual(enrich({ error: 'no_window' }, DISPLAYS, 1), { buttons: [], axError: 'no_window' });
});

test('read: SCREEN_CONTROL on -> buttons/text/password; off -> D135 shape, helper never run', async () => {
  const { s } = screen();
  const d = (await s.dialogs()).body.dialogs[0];
  assert.equal(d.buttons.length, 2); assert.equal(d.password, false); assert.match(d.text, /accessibility/);
  assert.equal(JSON.stringify(d).includes('"win"'), false);
  fs.writeFileSync(path.join(dir, 'ax-req.log'), '');
  const v = screen({ SCREEN_VIEW: '1' }).s;
  const d2 = (await v.dialogs()).body.dialogs[0];
  assert.equal(d2.buttons, undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'ax-req.log'), 'utf8'), '');
});

test('press: 403 without SCREEN_CONTROL, 409 gone, 404 no_button, ok via AX, click fallback', async () => {
  const off = screen({ SCREEN_VIEW: '1' }).s;
  assert.equal((await off.dialogPress({ id: 'abcdefabcdef', button: 'Deny' })).status, 403);
  const { s, logs } = screen();
  const id = await idOf(s);
  assert.equal((await s.dialogPress({ id: '000000000000', button: 'Deny' })).body.error, 'dialog_gone');
  assert.equal((await s.dialogPress({ id, button: 'deny' })).body.error, 'no_button');   // exact match only
  const ok = await s.dialogPress({ id, button: 'Deny' });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true, method: 'ax' }]);
  assert.match(logs.join('\n'), /dialog press id=[0-9a-f]{12} owner=universalAccessAuthWarn button="Deny" method=ax/);
  setAx({ read: { results: [READ] }, press: { error: 'press_failed' }, focus: { ok: true } });
  const c = await s.dialogPress({ id, button: 'Open System Settings' });
  assert.deepEqual(c.body, { ok: true, method: 'click' });
  const P = fs.readFileSync(path.join(dir, 'osa-stdin.log'), 'utf8').split('<<END>>').filter((x) => x.includes('"op":"tap"')).pop();
  assert.match(P, /"fx":0\.5853/);   // centre of the button (800+85)/1512
  setAx({ read: { results: [READ] }, press: { ok: true }, focus: { ok: true } });
});

test('type: never logs text, 256 cap, needs a field, focus then stdin type', async () => {
  const { s, logs } = screen();
  const id = await idOf(s);
  assert.equal((await s.dialogType({ id, text: SECRET })).body.error, 'no_field');   // READ has no field
  setAx({ read: { results: [{ ...READ, password: true }] }, press: { ok: true }, focus: { ok: true } });
  const big = await s.dialogType({ id, text: 'x'.repeat(LIMITS.DIALOG_TYPE_MAX_CHARS + 1) });
  assert.deepEqual([big.status, big.body.limit], [413, 256]);
  fs.writeFileSync(path.join(dir, 'ax-req.log'), '');
  const r = await s.dialogType({ id, text: SECRET, submit: true });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.ok(logs.some((l) => l.includes(`typed ${SECRET.length} chars +enter`)));
  assert.equal(logs.join('\n').includes(SECRET), false);
  const ax = fs.readFileSync(path.join(dir, 'ax-req.log'), 'utf8');
  assert.match(ax, /"op":"focus".*"kind":"secure"/);
  assert.equal(ax.includes(SECRET), false);   // the helper never sees the text
  assert.ok(fs.readFileSync(path.join(dir, 'osa-stdin.log'), 'utf8').includes(SECRET));   // only osascript stdin
  assert.equal((await screen({ SCREEN_VIEW: '1' }).s.dialogType({ id, text: 'a' })).status, 403);
});

// Real Vision lines from this Mac's open universalAccessAuthWarn dialog (2026-11-06).
const OCR = { lines: [
  { text: 'Accessibility Access', conf: 1, box: { fx: 0.2, fy: 0.06, fw: 0.4, fh: 0.08 } },
  { text: '"tux" would like to control this computer using', conf: 1, box: { fx: 0.2, fy: 0.29, fw: 0.7, fh: 0.07 } },
  { text: 'devices on your networks.', conf: 1, box: { fx: 0.2, fy: 0.68, fw: 0.5, fh: 0.07 } },   // sentence tail, not a button
  { text: 'Open System Settings', conf: 1, box: { fx: 0.45, fy: 0.80, fw: 0.3, fh: 0.08 } },
  { text: 'Deny', conf: 1, box: { fx: 0.8, fy: 0.79, fw: 0.1, fh: 0.08 } },
  { text: 'Maybe', conf: 0.3, box: { fx: 0.1, fy: 0.80, fw: 0.1, fh: 0.08 } },   // low confidence
] };
test('ocr classify: lower 40%, <=4 words, conf >= 0.5, no sentence tails; rects on the display', () => {
  const c = classifyOcr(OCR, { rect: { fx: 0.5, fy: 0.5, fw: 0.5, fh: 0.5 } });
  assert.deepEqual(c.buttons.map((b) => b.title), ['Open System Settings', 'Deny']);
  assert.deepEqual(c.buttons[1].rect, { fx: 0.9, fy: 0.895, fw: 0.05, fh: 0.04 });
  assert.match(c.text, /^Accessibility Access .*networks\.$/);
  assert.equal(classifyOcr({ lines: [] }, { rect: { fx: 0, fy: 0, fw: 1, fh: 1 } }), null);
});

test('ocr path: AX no buttons -> OCR buttons, press = click (method click), title gone on re-OCR -> 409 dialog_changed', async () => {
  setAx({ read: { results: [{ error: 'no_window' }] }, press: { error: 'no_window' }, focus: { ok: true }, ocr: { results: [OCR] } });
  const { s, logs } = screen();
  const d = (await s.dialogs()).body.dialogs[0];
  assert.deepEqual([d.ocr, d.axError, d.password, d.buttons.map((b) => b.title)], [true, 'no_window', undefined, ['Open System Settings', 'Deny']]);
  const r = await s.dialogPress({ id: d.id, button: 'Deny' });
  assert.deepEqual(r.body, { ok: true, method: 'click' });
  assert.match(logs.join('\n'), /button="Deny" method=click \(ocr\)/);
  setAx({ read: { results: [{ error: 'no_window' }] }, press: {}, focus: {}, ocr: { results: [{ lines: OCR.lines.filter((l) => l.text !== 'Deny') }] } });
  assert.deepEqual((await s.dialogPress({ id: d.id, button: 'Deny' })).body, { error: 'dialog_changed' });
  setAx({ read: { results: [READ] }, press: { ok: true }, focus: { ok: true } });
});

test('limits', () => {
  assert.deepEqual([LIMITS.OCR_BUTTON_MIN_FY, LIMITS.OCR_BUTTON_MAX_WORDS, LIMITS.OCR_MIN_CONF], [0.6, 4, 0.5]);
  assert.deepEqual([LIMITS.AX_WALK_MAX_DEPTH, LIMITS.AX_WALK_MAX_NODES, LIMITS.AX_FRAME_TOL, LIMITS.DIALOG_TYPE_MAX_CHARS, AXL.AX_HELPER_BUILD_TIMEOUT_MS], [10, 400, 3, 256, 60000]);
});
