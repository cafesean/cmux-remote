'use strict';
// p18 STORY-004 — the backend contract: the page gets the SAME JSON from both backends
// (specs.md §2.2 principle 3, §5.1, §15.2).
//
// Two REAL bridge.js children: one on the cmux backend with a fixture-serving fake cmux
// (test/helpers/fake-cmux.js), one on BACKEND=tmux against a throwaway tmux server on a private
// socket. Every non-browser route is called on both and the recursive JSON shapes compared
// (test/helpers/shape.js); the tmux side's effects are checked in tmux itself. Also: the 9 browser
// routes answer 501 on tmux only, the p9 send guarantees hold on tmux, and a Claude menu printed into
// a real tmux pane is detected through the bridge exactly as from the cmux capture it came from.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const ids = require('../lib/tmux-ids');
const menuparse = require('../public/menuparse.js');
const { bootBridge, BRIDGE_JS } = require('./helpers/bridge-child');
const { writeFakeCmux } = require('./helpers/fake-cmux');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');
const { shapeOf, difference } = require('./helpers/shape');
const { gridToTerminal } = require('./helpers/grid-to-ansi');

const HAVE_TMUX = !!tmuxBinary();
const skip = HAVE_TMUX ? false : 'tmux not installed';
const SECRET = 'p18-contract-secret';

// ---- HTTP -------------------------------------------------------------------------------------
async function call(base, method, pathAndQuery, body, extraHeaders) {
  const headers = { 'x-bridge-secret': SECRET, ...(extraHeaders || {}) };
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) payload = body;
    else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(`${base}${pathAndQuery}`, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep text */ }
  return { status: r.status, json, text };
}
// The first `data:` frame of an SSE route, then hang up.
function firstFrame(base, pathAndQuery, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${pathAndQuery}`);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'x-bridge-secret': SECRET } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) { clearTimeout(timer); req.destroy(); return resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`no data frame from ${pathAndQuery}`)); }, timeoutMs);
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
  });
}
// Status only (browser/stream is SSE on the cmux side and never ends by itself).
function statusOf(base, method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${pathAndQuery}`);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { 'x-bridge-secret': SECRET, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (res.headers['content-type'] === 'text/event-stream') { req.destroy(); resolve({ status: res.statusCode, text }); } });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
    if (data) req.write(data);
    req.end();
  });
}

// ---- the two bridges ------------------------------------------------------------------------------
let fakeDir, fake, cmuxB, srv, tmuxB, epoch;
before(async () => {
  fakeDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p18-fake-')));
  fs.writeFileSync(path.join(fakeDir, 'p18-note.txt'), 'x');
  fake = writeFakeCmux(fakeDir, { cwd: fakeDir });
  cmuxB = await bootBridge({ env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET } });
  if (!HAVE_TMUX) return;
  srv = await startTmux({ cols: 120, rows: 40 });
  tmuxB = await bootBridge({ env: { BACKEND: 'tmux', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin, BRIDGE_SECRET: SECRET } });
  fs.writeFileSync(path.join(tmuxB.cwd, 'p18-note.txt'), 'x');
  await waitFor(async () => (await srv.run(['list-sessions', '-F', '#{session_name}'])).stdout.trim() === 'main', { what: 'main' });
  epoch = await srv.startTime();
  // workspace A = main:0 split into two side-by-side panes; workspace B = one more window
  await srv.runOk(['split-window', '-d', '-h', '-t', 'main:0']);
  await srv.runOk(['new-window', '-d', '-t', 'main:']);
});
after(async () => {
  if (cmuxB) await cmuxB.stop();
  if (tmuxB) await tmuxB.stop();
  if (srv) await srv.stop();
  if (fakeDir) await fsp.rm(fakeDir, { recursive: true, force: true });
});

const S = (pane) => ids.mint(4, epoch, Number(String(pane).replace('%', '')));
const P = (pane) => ids.mint(3, epoch, Number(String(pane).replace('%', '')));
const W = (win) => ids.mint(2, epoch, Number(String(win).replace('@', '')));
// A fresh two-pane tmux window for a destructive route.
async function scratch() {
  const out = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{window_id} #{pane_id}'])).trim();
  const [win, p1] = out.split(' ');
  const p2 = (await srv.runOk(['split-window', '-d', '-h', '-t', p1, '-P', '-F', '#{pane_id}'])).trim();
  return { win, p1, p2, ws: W(win), pane1: P(p1), pane2: P(p2), sf1: S(p1), sf2: S(p2) };
}
async function tmuxIds() {
  const t = await call(tmuxB.base, 'GET', '/cmux/tree');
  const wsA = t.json.workspaces.find((w) => w.panes.length === 2);
  const wsB = t.json.workspaces.find((w) => w !== wsA);
  return { ws: wsA.id, ws2: wsB.id, pane: wsA.panes[0].id, pane2: wsA.panes[1].id, sf: wsA.tabs[0].id, sf2: wsA.tabs[1].id };
}
const fakeIds = () => {
  const I = fake.ids;
  return { ws: I.wsA, ws2: I.wsB, pane: I.paneA1, pane2: I.paneA2, sf: I.sfA1, sf2: I.sfA2 };
};
function sameShape(route, a, b) {
  assert.equal(b.status, a.status, `${route}: status cmux ${a.status} vs tmux ${b.status} (${b.text || ''})`);
  const d = difference(shapeOf(a.json), shapeOf(b.json));
  assert.equal(d, '', `${route}: ${d}\ncmux: ${JSON.stringify(a.json).slice(0, 600)}\ntmux: ${JSON.stringify(b.json).slice(0, 600)}`);
}

test('shape parity: every non-browser GET route', { skip }, async () => {
  const f = fakeIds();
  const t = await tmuxIds();
  const routes = (i) => [
    '/cmux/tree',
    `/cmux/layout?workspace=${i.ws}`,
    `/cmux/grid?surface=${i.sf}`,
    `/cmux/screen?surface=${i.sf}`,
    `/cmux/screen?surface=${i.sf}&lines=50`,
    `/cmux/history?surface=${i.sf}`,
    '/cmux/fs/roots',
    `/cmux/completions?surface=${i.sf}&text=${encodeURIComponent('@p18')}&caret=4`,
  ];
  const rf = routes(f), rt = routes(t);
  for (let i = 0; i < rf.length; i++) {
    const a = await call(cmuxB.base, 'GET', rf[i]);
    const b = await call(tmuxB.base, 'GET', rt[i]);
    assert.equal(a.status, 200, `${rf[i]} on cmux: ${a.text}`);
    sameShape(rf[i].split('?')[0] + (rf[i].includes('lines=') ? '?lines' : ''), a, b);
  }
  // the grid really is the tmux pane, and the completion really read the tmux workspace's cwd
  const comp = await call(tmuxB.base, 'GET', `/cmux/completions?surface=${t.sf}&text=${encodeURIComponent('@p18')}&caret=4`);
  assert.ok(JSON.stringify(comp.json).includes('p18-note.txt'), comp.text);
});

test('shape parity: every non-browser POST route (and the tmux side really did it)', { skip }, async () => {
  const f = fakeIds();
  const t = await tmuxIds();
  const both = async (route, fBody, tBody, check) => {
    const a = await call(cmuxB.base, 'POST', route, fBody);
    const b = await call(tmuxB.base, 'POST', route, tBody);
    sameShape(route, a, b);
    if (check) await check(b);
    return b;
  };
  // typing
  await both('/cmux/send', { surface: f.sf, text: 'echo p18-send-ok' }, { surface: t.sf, text: 'echo p18-send-ok' });
  await both('/cmux/key', { surface: f.sf, key: 'enter' }, { surface: t.sf, key: 'enter' });
  await waitFor(async () => /^p18-send-ok$/m.test(await srv.capture(`%${ids.parse(t.sf).n}`)), { what: 'the typed command output' });
  // tabs, workspaces
  await both('/cmux/new-surface', { workspace: f.ws, pane: f.pane }, { workspace: t.ws, pane: t.pane }, (b) => {
    assert.equal(b.status, 200);
    assert.ok(b.json.id && ids.parse(b.json.id).kind === 4, 'the new tab id is found by tree diff');
  });
  await both('/cmux/new-workspace', { cwd: fakeDir }, { cwd: srv.dir }, (b) => assert.ok(b.json.workspace && b.json.id));
  let s = await scratch();
  await both('/cmux/close-tab', { surface: f.sf2 }, { surface: s.sf2 }, async () => {
    assert.deepEqual((await srv.runOk(['list-panes', '-t', s.win, '-F', '#{pane_id}'])).trim().split('\n'), [s.p1]);
  });
  await both('/cmux/rename-workspace', { workspace: f.ws, title: 'renamed' }, { workspace: t.ws, title: 'renamed' }, async () => {
    assert.equal(await srv.display('main:0', '#{window_name}'), 'renamed');
  });
  s = await scratch();
  await both('/cmux/close-workspace', { workspace: f.ws2 }, { workspace: s.ws }, async () => {
    assert.ok(!(await srv.runOk(['list-windows', '-a', '-F', '#{window_id}'])).split('\n').includes(s.win));
  });
  // panes
  s = await scratch();
  await both('/cmux/new-pane', { workspace: f.ws, direction: 'right', pane: f.pane }, { workspace: s.ws, direction: 'down', pane: s.pane1 }, async (b) => {
    assert.equal(b.status, 200);
    assert.equal((await srv.runOk(['list-panes', '-t', s.win, '-F', '#{pane_id}'])).trim().split('\n').length, 3);
  });
  await both('/cmux/split-off', { surface: f.sf, direction: 'right', workspace: f.ws }, { surface: t.sf, direction: 'right', workspace: t.ws }, (b) => {
    assert.equal(b.status, 502);
    assert.match(b.json.detail, /invalid_state: splitting off would leave the source pane empty/);
  });
  s = await scratch();
  await both('/cmux/drop-surface', { workspace: f.ws, surface: f.sf2, pane: f.pane, edge: 'center' },
    { workspace: s.ws, surface: s.sf2, pane: s.pane1, edge: 'center' }, async () => {
      const g = (await srv.runOk(['list-panes', '-t', s.win, '-F', '#{pane_id} #{pane_left} #{pane_top}'])).trim().split('\n').map((l) => l.split(' '));
      assert.equal(g.find((q) => q[0] === s.p2)[1], g.find((q) => q[0] === s.p1)[1], 'stacked in the same column');
    });
  s = await scratch();
  await both('/cmux/drop-surface', { workspace: f.ws, surface: f.sf2, pane: f.pane, edge: 'left' },
    { workspace: s.ws, surface: s.sf2, pane: s.pane1, edge: 'left' }, async () => {
      const g = (await srv.runOk(['list-panes', '-t', s.win, '-F', '#{pane_id} #{pane_left} #{pane_top}'])).trim().split('\n').map((l) => l.split(' ').map((v, i) => (i ? Number(v) : v)));
      const L = g.find((q) => q[0] === s.p2), R = g.find((q) => q[0] === s.p1);
      assert.ok(L[1] < R[1] && L[2] === R[2], JSON.stringify(g));
    });
  s = await scratch();
  await both('/cmux/close-pane', { workspace: f.ws, pane: f.pane2 }, { workspace: s.ws, pane: s.pane2 }, async () => {
    assert.deepEqual((await srv.runOk(['list-panes', '-t', s.win, '-F', '#{pane_id}'])).trim().split('\n'), [s.p1]);
  });
  await both('/cmux/focus-pane', { pane: f.pane2, workspace: f.ws }, { pane: t.pane2, workspace: t.ws }, async () => {
    assert.equal(await srv.display(`%${ids.parse(t.pane2).n}`, '#{pane_active}'), '1');
  });
  await both('/cmux/focus-surface', { surface: f.sf }, { surface: t.sf }, async () => {
    assert.equal(await srv.display(`%${ids.parse(t.sf).n}`, '#{pane_active}'), '1');
  });
  // divider drag + equalize, from the handles each bridge's own layout reports
  const lf = (await call(cmuxB.base, 'GET', `/cmux/layout?workspace=${f.ws}`)).json;
  const lt = (await call(tmuxB.base, 'GET', `/cmux/layout?workspace=${t.ws}`)).json;
  const hf = lf.handles.find((h) => h.axis === 'x'), ht = lt.handles.find((h) => h.axis === 'x');
  assert.ok(hf && ht, 'both layouts have an x divider');
  const beforeW = (await srv.runOk(['list-panes', '-t', 'main:0', '-F', '#{pane_width}'])).trim();
  await both('/cmux/resize-pane', { workspace: f.ws, paneA: hf.a[0], paneB: hf.b[0], axis: 'x', target: 0.3 },
    { workspace: t.ws, paneA: ht.a[0], paneB: ht.b[0], axis: 'x', target: 0.3 }, async (b) => {
      assert.equal(b.status, 200);
      assert.notEqual((await srv.runOk(['list-panes', '-t', 'main:0', '-F', '#{pane_width}'])).trim(), beforeW, 'the divider moved');
    });
  await both('/cmux/equalize', { workspace: f.ws }, { workspace: t.ws });
  // upload (cmux-free on both, but part of the route set)
  const up = async (base) => call(base, 'POST', '/cmux/upload', Buffer.from('p18 bytes'), { 'x-file-name': 'p18.txt', 'content-type': 'application/octet-stream' });
  sameShape('/cmux/upload', await up(cmuxB.base), await up(tmuxB.base));
});

test('SSE: the first data frame of grid-stream, panes-stream and layout-stream has the same shape', { skip }, async () => {
  const f = fakeIds();
  const t = await tmuxIds();
  const pairs = [
    [`/cmux/grid-stream?surface=${f.sf}`, `/cmux/grid-stream?surface=${t.sf}`],
    [`/cmux/panes-stream?surfaces=${f.sf},${f.sf2}`, `/cmux/panes-stream?surfaces=${t.sf},${t.sf2}`],
    [`/cmux/layout-stream?workspace=${f.ws}`, `/cmux/layout-stream?workspace=${t.ws}`],
  ];
  for (const [pf, pt] of pairs) {
    const a = await firstFrame(cmuxB.base, pf);
    const b = await firstFrame(tmuxB.base, pt);
    sameShape(pf.split('?')[0], a, b);
    assert.ok(a.json.h && b.json.h);
  }
});

const BROWSER = [
  ['POST', '/cmux/browser/open'], ['POST', '/cmux/browser/tap'], ['POST', '/cmux/browser/type'],
  ['POST', '/cmux/browser/key'], ['POST', '/cmux/browser/scroll'], ['POST', '/cmux/browser/nav'],
  ['POST', '/cmux/browser/zoom'], ['GET', '/cmux/browser/info'], ['GET', '/cmux/browser/stream'],
];
test('the 9 browser routes: 501 unsupported_backend on tmux, never 501 on cmux', { skip }, async () => {
  const f = fakeIds();
  for (const [method, route] of BROWSER) {
    const q = method === 'GET' ? `?surface=${f.sf}` : '';
    const body = method === 'POST' ? { surface: f.sf, url: 'https://example.invalid/', x: 0.5, y: 0.5, text: 'a', key: 'enter', dy: 10, action: 'back', dir: 'in' } : undefined;
    const b = await call(tmuxB.base, method, route + q, body);
    assert.equal(b.status, 501, `${route}: ${b.text}`);
    assert.deepEqual(b.json, { error: 'unsupported_backend', backend: 'tmux' });
    const a = await statusOf(cmuxB.base, method, route + q, body);
    assert.notEqual(a.status, 501, `${route} on cmux`);
  }
});

test('p9 parity on tmux: expect_seq 200 / 409 seq_changed; a stale-epoch id is send_failed (nothing typed)', { skip }, async () => {
  const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}', 'cat'])).trim();
  const sf = S(pane);
  const g = await call(tmuxB.base, 'GET', `/cmux/grid?surface=${sf}`);
  assert.equal(g.status, 200);
  assert.ok(Number.isFinite(g.json.seq));
  const ok = await call(tmuxB.base, 'POST', '/cmux/send', { surface: sf, text: 'p18-precondition-ok', expect_seq: g.json.seq });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { ok: true });
  await waitFor(async () => (await srv.capture(pane)).includes('p18-precondition-ok'), { what: 'the guarded send' });
  const g2 = await call(tmuxB.base, 'GET', `/cmux/grid?surface=${sf}`);
  const moved = await call(tmuxB.base, 'POST', '/cmux/send', { surface: sf, text: 'must-not-land', expect_seq: g2.json.seq + 1 });
  assert.equal(moved.status, 409);
  assert.equal(moved.json.error, 'seq_changed');
  assert.equal(moved.json.seq, g2.json.seq);
  const stale = ids.mint(4, epoch - 3600, Number(pane.slice(1)));
  const dead = await call(tmuxB.base, 'POST', '/cmux/send', { surface: stale, text: 'must-not-land', submit: true });
  assert.equal(dead.status, 502);
  assert.equal(dead.json.error, 'send_failed');
  assert.match(dead.json.detail, /^not_found: stale id/);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!(await srv.capture(pane)).includes('must-not-land'));
});

test('end-to-end menu detection: claude-slash-2 printed into a real tmux pane is detected through /cmux/grid', { skip }, async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'grids', 'claude-slash-2.json'), 'utf8')).grid;
  const prog = path.join(srv.dir, 'claude-slash-2.term');
  fs.writeFileSync(prog, gridToTerminal(fx));
  const pane = (await srv.runOk(['new-session', '-d', '-s', 'fx', '-x', String(fx.columns), '-y', String(fx.rows), '-P', '-F', '#{pane_id}',
    `cat '${prog}'; exec sleep 100000`])).trim();
  await waitFor(async () => (await srv.capture(pane)).includes('❯'), { what: 'the fixture on screen' });
  assert.equal(await srv.display(pane, '#{pane_width}x#{pane_height}'), `${fx.columns}x${fx.rows}`);
  assert.equal(await srv.display(pane, '#{history_size}'), '0');
  const want = menuparse.parseMenu(fx);
  assert.ok(want && want.signal === 'foreground', 'the fixture is a Claude menu');
  const r = await waitFor(async () => {
    const g = await call(tmuxB.base, 'GET', `/cmux/grid?surface=${S(pane)}`);
    return g.status === 200 && g.json.grid.cursor.row === fx.cursor.row && g.json.grid.cursor.column === fx.cursor.column && g;
  }, { what: 'the fixture cursor' });
  const got = menuparse.parseMenu(r.json.grid);
  assert.deepEqual(got, want);
  assert.equal(got.signal, 'foreground');
  assert.equal(menuparse.paneKind({ grid: r.json.grid }).kind, menuparse.paneKind({ grid: fx }).kind);
});

test('the cmux path is unchanged: cli() makes the exact execFile cmux() always made', () => {
  const src = fs.readFileSync(BRIDGE_JS, 'utf8');
  const m = /function cli\(args, opts, cb\) \{\n([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'cli() exists');
  assert.match(m[1], /if \(tmuxCli\) return tmuxCli\.exec\(args, opts, cb\);/);
  assert.match(m[1], /return execFile\(CMUX_BIN, args, \{ timeout: opts\.timeout, env: CMUX_ENV, maxBuffer: 8 \* 1024 \* 1024 \}, cb\);/);
  // the two call paths go through it, and nothing else spawns cmux
  assert.match(src, /function cmux\(args, cb, timeout = 8000, tries = 0\) \{\n  cli\(args, \{ timeout \}, \(err, stdout, stderr\) => \{/);
  assert.match(src, /const child = cli\(args, \{ timeout: SEND_CMD_TIMEOUT_MS \},/);
  assert.equal((src.match(/execFile\(CMUX_BIN/g) || []).length, 1);
  // with BACKEND unset, tmuxCli is null: nothing tmux is even loaded
  assert.match(src, /const tmuxCli = BACKEND === 'tmux' \? require\('\.\/lib\/tmux-cli'\)\.createTmuxCli\(/);
});
