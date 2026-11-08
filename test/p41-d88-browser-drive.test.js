'use strict';
// p41 D88 — the native app drives a cmux browser tab: scroll {shot:true} answers with a fresh frame
// (scroll-frame floor, re-arms the poll floor); tap reports a password field as secure without echoing
// its value; type sends the text over the cmux SOCKET (never ps-visible argv) and never logs it. REAL
// bridge.js child, fake cmux CLI + fake cmux socket, synthetic ids, offline.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const WS_P = 'aaaaaaa1-1111-4111-8111-111111111111';
const WS_N = 'bbbbbbb1-1111-4111-8111-111111111111';
const S1 = 'aaaaaaa1-3333-4333-8333-333333333331';   // in "Claude accounts" (private)
const S2 = 'bbbbbbb1-3333-4333-8333-333333333331';
const sf = (id, ref) => ({ id, ref, title: ref, type: 'browser', selected: true, selected_in_pane: true });
const pn = (id, ref, index, s) => ({ id, ref, index, focused: index === 0, selected_surface_id: s.id, surfaces: [s] });
const TREE = { windows: [{ id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1', workspaces: [
  { id: WS_P, ref: 'workspace:1', title: 'Claude accounts', selected: false, panes: [pn('aaaaaaa1-2222-4222-8222-222222222221', 'pane:1', 0, sf(S1, 'surface:1'))] },
  { id: WS_N, ref: 'workspace:2', title: 'acme', selected: true, panes: [pn('bbbbbbb1-2222-4222-8222-222222222221', 'pane:2', 0, sf(S2, 'surface:2'))] },
] }] };
const SECRET = 'hunter2-SYNTHETIC-pw-9f3a';
const SOCK_PW = 'sockpw-SYNTHETIC-77';

const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(args) + '\n');
let out = 'OK\n';
if (args[0] === 'tree') out = fs.readFileSync(process.env.FAKE_CMUX_TREE, 'utf8');
else if (args[0] === 'list-status' || args[0] === 'list-notifications') out = args[0] === 'list-notifications' ? '[]' : '';
else if (args[0] === 'rpc') out = '{}';
else if (args[0] === 'browser' && args[2] === 'screenshot') fs.writeFileSync(args[args.indexOf('--out') + 1], Buffer.alloc(64, 7));
else if (args[0] === 'browser' && args[2] === 'eval') {
  const js = args[args.indexOf('--script') + 1];
  const elFile = require('path').join(require('path').dirname(process.env.FAKE_CMUX_LOG), 'tap-el.json');
  if (js.includes('elementFromPoint') && js.includes('mousedown') && fs.existsSync(elFile)) {
    // D199: run the REAL tap script against a stub DOM whose hit element comes from tap-el.json.
    const spec = JSON.parse(fs.readFileSync(elFile, 'utf8'));
    const el = Object.assign({ focus() {}, closest() { return null; }, dispatchEvent() {} }, spec);
    const ctx = { innerWidth: 800, innerHeight: 600, location: { href: 'https://page.example/' }, JSON, String, Math, getComputedStyle: () => ({ position: 'static' }),
      MouseEvent: function MouseEvent() {}, window: {}, document: { elementFromPoint: () => el, body: {}, documentElement: {} } };
    out = String(require('vm').runInNewContext(js, ctx));
  } else if (js.includes('elementFromPoint') && js.includes('mousedown')) out = JSON.stringify({ hit: 'INPUT', editable: true, secure: true, value: '', x: 1, y: 1 });
  else if (js.includes('scrollBy')) out = '"doc:120"';
  else out = '""';
}
process.stdout.write(out, () => process.exit(0));
`;

let bridge, dir, log, server, sockLines = [];
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd88-')));
  const bin = path.join(dir, 'fake-cmux');
  fs.writeFileSync(bin, FAKE_CMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(TREE));
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  log = path.join(dir, 'cmux.log');
  const sock = path.join(dir, 's.sock');
  server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); sockLines.push(line);
        if (line.startsWith('auth ')) { c.write(line === 'auth ' + SOCK_PW ? '{"ok":true}\n' : '{"ok":false,"error":{"code":"auth_failed"}}\n'); continue; }
        const j = JSON.parse(line);
        c.write(JSON.stringify({ id: j.id, ok: true, result: { value: 'ok' } }) + '\n');
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));
  bridge = await bootBridge({ cwd: dir, env: {
    CMUX_BIN: bin, FAKE_CMUX_TREE: path.join(dir, 'tree.json'), FAKE_CMUX_LOG: log,
    CMUX_SOCKET_PATH: sock, CMUX_SOCKET_PASSWORD: SOCK_PW,
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'cfg', 'private-surfaces.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
    BROWSER_SHOT_MIN_MS: '3600000', BROWSER_SCROLL_SHOT_MIN_MS: '200',
  } });
});
after(async () => { if (bridge) await bridge.stop(); if (server) server.close(); if (dir) await fsp.rm(dir, { recursive: true, force: true }); });

const post = async (p, body) => { const r = await fetch(bridge.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { status: r.status, json: j, text: t }; };
const argv = () => { try { return fs.readFileSync(log, 'utf8'); } catch (_) { return ''; } };
const shots = (s) => argv().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'browser' && a[1] === s && a[2] === 'screenshot').length;

test('scroll without shot: ack only, no screenshot', async () => {
  const n = shots(S2);
  const r = await post('/cmux/browser/scroll', { surface: S2, dy: 300 });
  assert.equal(r.status, 200);
  assert.equal(r.json.moved, 'doc:120');
  assert.equal(r.json.image, undefined);
  assert.equal(shots(S2), n);
});

test('scroll {shot:true}: fresh frame in the reply; a 2nd inside the floor waits, then paints; poll floor re-armed', async () => {
  const a = await post('/cmux/browser/scroll', { surface: S2, dy: 300, shot: true });
  assert.equal(a.status, 200);
  assert.match(a.json.mime, /^image\/(jpeg|png)$/);
  assert.ok(Buffer.from(a.json.image, 'base64').length > 0);
  const t0 = Date.now();
  const b = await post('/cmux/browser/scroll', { surface: S2, dy: -300, shot: true });
  assert.ok(b.json.image, 'last scroll of a burst still paints');
  assert.ok(Date.now() - t0 >= 120, 'waited out the scroll-frame floor');
  const poll = await fetch(bridge.base + '/cmux/browser/shot?surface=' + S2);
  assert.equal(poll.status, 429, 'scroll frame re-armed the poll floor');
});

test('scroll: dy clamped to ±5000, integers; no delta -> 400; private -> 423; bad surface -> 400', async () => {
  await post('/cmux/browser/scroll', { surface: S2, dy: 1e9 });
  assert.ok(argv().includes(',5000)'), 'clamped into the script');
  assert.equal((await post('/cmux/browser/scroll', { surface: S2, dy: 0 })).status, 400);
  assert.equal((await post('/cmux/browser/scroll', { surface: S1, dy: 10, shot: true })).status, 423);
  assert.equal(shots(S1), 0);
  assert.equal((await post('/cmux/browser/scroll', { surface: 'x;rm', dy: 10 })).status, 400);
});

test('tap on a password field: secure:true, value never echoed', async () => {
  const r = await post('/cmux/browser/tap', { surface: S2, fx: 0.5, fy: 0.25 });
  assert.equal(r.status, 200);
  assert.equal(r.json.secure, true);
  assert.equal(r.json.editable, true);
  assert.equal(r.json.value, '');
  assert.match(argv(), /var sec=el\.tagName==='INPUT'/);
});

// p41 D199 (D195): tapping an IMG returns its currentSrc so the app's viewer shows the image itself.
const tapEl = (spec) => fs.writeFileSync(path.join(dir, 'tap-el.json'), JSON.stringify(spec));
test('tap on an IMG: src = currentSrc (http(s) only, <= 2048 chars); other hits carry no src', async () => {
  try {
    tapEl({ tagName: 'IMG', currentSrc: 'https://cdn.example/a.jpg?w=1200' });
    let r = await post('/cmux/browser/tap', { surface: S2, fx: 0.5, fy: 0.5 });
    assert.equal(r.status, 200);
    assert.equal(r.json.hit, 'IMG');
    assert.equal(r.json.src, 'https://cdn.example/a.jpg?w=1200');
    for (const bad of ['data:image/png;base64,QUJD', 'blob:https://page.example/1', 'javascript:alert(1)', 'https://cdn.example/' + 'x'.repeat(2048), '']) {
      tapEl({ tagName: 'IMG', currentSrc: bad });
      r = await post('/cmux/browser/tap', { surface: S2, fx: 0.5, fy: 0.5 });
      assert.equal(r.status, 200);
      assert.equal(r.json.hit, 'IMG');
      assert.equal('src' in r.json, false, `no src for ${bad.slice(0, 30)}`);
    }
    tapEl({ tagName: 'IMG', currentSrc: 'https://cdn.example/' + 'x'.repeat(2048 - 'https://cdn.example/'.length) });
    r = await post('/cmux/browser/tap', { surface: S2, fx: 0.5, fy: 0.5 });
    assert.equal(r.json.src.length, 2048, 'exactly the cap is kept');
    tapEl({ tagName: 'DIV', currentSrc: 'https://cdn.example/a.jpg' });
    r = await post('/cmux/browser/tap', { surface: S2, fx: 0.5, fy: 0.5 });
    assert.equal(r.json.hit, 'DIV');
    assert.equal('src' in r.json, false, 'only IMG hits carry src');
  } finally {
    fs.rmSync(path.join(dir, 'tap-el.json'), { force: true });
  }
});

test('type: text goes over the cmux socket (authed), never argv, never logged or echoed', async () => {
  sockLines = [];
  const r = await post('/cmux/browser/type', { surface: S2, text: SECRET });
  assert.equal(r.status, 200);
  assert.equal(r.text.includes(SECRET), false);
  assert.equal(sockLines[0], 'auth ' + SOCK_PW);
  const req = JSON.parse(sockLines[1]);
  assert.equal(req.method, 'browser.eval');
  assert.equal(req.params.surface_id, S2);
  assert.ok(req.params.script.includes(JSON.stringify(SECRET)));
  assert.equal(argv().includes(SECRET), false, 'not in any cmux argv');
  assert.equal(bridge.stdout().includes(SECRET) || bridge.stderr().includes(SECRET), false, 'not logged');
  assert.equal(bridge.stdout().includes(SOCK_PW) || bridge.stderr().includes(SOCK_PW), false);
});

test('type: over the cap -> 413 (text not echoed); private -> 423, socket never asked', async () => {
  const r = await post('/cmux/browser/type', { surface: S2, text: SECRET + 'x'.repeat(5000) });
  assert.equal(r.status, 413);
  assert.equal(r.text.includes(SECRET), false);
  sockLines = [];
  assert.equal((await post('/cmux/browser/type', { surface: S1, text: SECRET })).status, 423);
  assert.equal(sockLines.length, 0);
});

test('shot limiter reserve/mark (injected clock)', () => {
  const { createShotLimiter } = require('../lib/shot-limiter');
  let t = 1000;
  const l = createShotLimiter({ minMs: 350, now: () => t });
  assert.equal(l.reserve('a'), 0);
  t += 100;
  assert.equal(l.reserve('a'), 250);
  assert.equal(l.reserve('a'), 600, 'back-to-back reservations queue');
  l.mark('b');
  assert.equal(createShotLimiter({ minMs: 1 }).take('z').ok, true);
});
