'use strict';
// p19 STORY-004 — the transport contract: over UNIX sockets the page gets exactly what it gets over
// TCP (specs.md §2.2 principle 2, §7.2, §15.2).
//
// Two REAL pairs on the same fixture-serving fake cmux (test/helpers/fake-cmux.js):
//   TCP     bridge.js on an ephemeral 127.0.0.1 port, server.js on another, CMUX_MACHINE_URL=http://…
//   socket  bridge.js on BRIDGE_SOCKET, server.js on SERVER_SOCKET, CMUX_MACHINE_URL=unix:…
// Every /api/cmux/* route in server.js's handleApi is called on both, through the same raw client
// (test/helpers/unix-call.js), and the status codes and recursive JSON shapes (test/helpers/shape.js)
// must be equal. The route list is READ FROM THE SOURCE: a route added to handleApi without a case
// here fails the first test. SSE routes compare their first frame; the download compares a 206 range
// byte for byte; the upload compares the bytes that land on disk.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { bootServer, SERVER_JS } = require('./helpers/server-boot');
const { writeFakeCmux, IDS: I } = require('./helpers/fake-cmux');
const { shapeOf, difference } = require('./helpers/shape');
const { g, commit } = require('./helpers/git-fixture');
const { call, firstFrame, openStream } = require('./helpers/unix-call');

const SECRET = 'p19-contract-secret';
const TOKEN = 'p19-contract-token';
const DL = Buffer.from('0123456789abcdefghij-p19-download-bytes\n');

// ---- the route list, read from handleApi ---------------------------------------------------------
function scanRoutes(src) {
  const start = src.indexOf('async function handleApi(');
  // code only: a comment may name a path that is not a route
  const body = src.slice(start, src.indexOf('\n}\n', start)).replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
  const routes = new Set();
  for (const m of body.matchAll(/'(\/api\/cmux\/[a-z0-9/-]*)'/g)) {
    const r = m[1];
    if (!r.endsWith('/')) { routes.add(r); continue; }
    // a prefix route: its sub-routes are the allow-lists and `sub === '…'` checks of its own block
    const at = body.indexOf(`p.slice('${r}'.length)`);
    if (at < 0) continue;   // the prefix is only tested (startsWith), its block is found through the slice
    const block = body.slice(at, body.indexOf('\n  }\n', at));
    for (const arr of block.matchAll(/\[([^\]]*)\]\.includes\(sub\)/g)) {
      for (const n of arr[1].matchAll(/'([a-z0-9-]+)'/g)) routes.add(r + n[1]);
    }
    for (const n of block.matchAll(/sub === '([a-z0-9-]+)'/g)) routes.add(r + n[1]);
  }
  return [...routes].sort();
}

// ---- the two pairs --------------------------------------------------------------------------------
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p19-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
let fakeDir, fake, tcp, uds;
before(async () => {
  fakeDir = tmp();
  fs.writeFileSync(path.join(fakeDir, 'p18-note.txt'), 'x');
  fs.writeFileSync(path.join(fakeDir, 'p19-dl.bin'), DL);
  // a real repo, so the git and gitread relays answer with data instead of `unknown_repo`
  await g(fakeDir, ['init', '-q', '-b', 'main']);
  await commit(fakeDir, 'p18-note.txt', 'x', 'p19 contract fixture');
  fs.writeFileSync(path.join(fakeDir, 'p18-note.txt'), 'x changed');
  fake = writeFakeCmux(fakeDir, { cwd: fakeDir });
  const benv = { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET };
  const senv = { SERVER_TOKEN: TOKEN, CMUX_MACHINE_SECRET: SECRET };

  const tb = await bootBridge({ env: benv });
  const ts = await bootServer({ env: { ...senv, CMUX_MACHINE_URL: tb.base } });
  tcp = { bridge: tb, server: ts, target: ts.base };

  const d = tmp();
  const ub = await bootBridge({ socket: path.join(d, 'bridge.sock'), env: benv });
  const us = await bootServer({ socket: path.join(d, 'server.sock'), env: { ...senv, CMUX_MACHINE_URL: `unix:${ub.socketPath}` } });
  uds = { bridge: ub, server: us, target: us.socketPath };
});
after(async () => {
  for (const p of [tcp, uds]) if (p) { await p.server.stop(); await p.bridge.stop(); }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function sameShape(label, a, b) {
  assert.equal(b.status, a.status, `${label}: status tcp ${a.status} vs unix ${b.status}\ntcp: ${(a.text || '').slice(0, 300)}\nunix: ${(b.text || '').slice(0, 300)}`);
  const d = difference(shapeOf(a.json), shapeOf(b.json));
  assert.equal(d, '', `${label}: ${d}\ntcp: ${JSON.stringify(a.json).slice(0, 600)}\nunix: ${JSON.stringify(b.json).slice(0, 600)}`);
}

// ---- the cases: one per route (a route may carry several requests) --------------------------------
const q = (s) => encodeURIComponent(s);
const json = (method, pq, body) => ({ kind: 'json', method, pq, body });
const sse = (pq) => ({ kind: 'sse', pq });
const post = (pq, body) => json('POST', pq, { machine: 'default', ...body });
function cases() {
  const note = path.join(fakeDir, 'p18-note.txt');
  return {
    '/api/cmux/machines': [json('GET', '/api/cmux/machines')],
    '/api/cmux/bootstrap': [json('GET', '/api/cmux/bootstrap'), json('GET', '/api/cmux/bootstrap?machine=nope')],
    '/api/cmux/fleet': [json('GET', '/api/cmux/fleet')],
    '/api/cmux/tree': [json('GET', '/api/cmux/tree'), json('GET', '/api/cmux/tree?machine=nope')],
    '/api/cmux/fs/download-ticket': [json('GET', `/api/cmux/fs/download-ticket?path=${q(note)}`), json('GET', '/api/cmux/fs/download-ticket')],
    '/api/cmux/fs/download': [{ kind: 'download' }],
    '/api/cmux/fs/roots': [json('GET', '/api/cmux/fs/roots')],
    '/api/cmux/fs/list': [json('GET', `/api/cmux/fs/list?path=${q(fakeDir)}`)],
    '/api/cmux/fs/read': [json('GET', `/api/cmux/fs/read?path=${q(note)}`), json('GET', `/api/cmux/fs/read?path=${q('/etc/hosts')}`)],
    '/api/cmux/git/repos': [json('GET', '/api/cmux/git/repos')],
    '/api/cmux/git/status': [json('GET', `/api/cmux/git/status?repo=${q(fakeDir)}`)],
    '/api/cmux/git/branches': [json('GET', `/api/cmux/git/branches?repo=${q(fakeDir)}`)],
    '/api/cmux/git/worktrees': [json('GET', `/api/cmux/git/worktrees?repo=${q(fakeDir)}`)],
    '/api/cmux/git/diff': [json('GET', `/api/cmux/git/diff?repo=${q(fakeDir)}&path=p18-note.txt`)],
    '/api/cmux/git/stage': [json('POST', `/api/cmux/git/stage?machine=default`, { repo: fakeDir, paths: ['x'] })],
    '/api/cmux/git/unstage': [json('POST', `/api/cmux/git/unstage?machine=default`, { repo: fakeDir, paths: ['x'] })],
    '/api/cmux/git/command': [json('POST', `/api/cmux/git/command?machine=default`, { verb: 'no-such-verb', params: {} })],
    '/api/cmux/gitread/probe': [json('GET', `/api/cmux/gitread/probe?dir=${q(fakeDir)}`)],
    '/api/cmux/gitread/status': [json('GET', `/api/cmux/gitread/status?dir=${q(fakeDir)}`)],
    '/api/cmux/gitread/branches': [json('GET', `/api/cmux/gitread/branches?dir=${q(fakeDir)}`)],
    '/api/cmux/gitread/worktrees': [json('GET', `/api/cmux/gitread/worktrees?dir=${q(fakeDir)}`)],
    '/api/cmux/gitread/diff': [json('GET', `/api/cmux/gitread/diff?dir=${q(fakeDir)}&path=p18-note.txt`)],
    '/api/cmux/gitread/command': [json('POST', `/api/cmux/gitread/command?machine=default`, { verb: 'no-such-verb', dir: fakeDir, params: {} })],
    '/api/cmux/completions': [json('GET', `/api/cmux/completions?surface=${I.sfA1}&text=${q('@p18')}&caret=4`)],
    '/api/cmux/grid': [json('GET', `/api/cmux/grid?surface=${I.sfA1}`)],
    '/api/cmux/screen': [json('GET', `/api/cmux/screen?surface=${I.sfA1}`), json('GET', `/api/cmux/screen?surface=${I.sfA1}&lines=50`)],
    '/api/cmux/history': [json('GET', `/api/cmux/history?surface=${I.sfA1}`)],
    '/api/cmux/layout': [json('GET', `/api/cmux/layout?workspace=${I.wsA}`)],
    '/api/cmux/stream': [sse(`/api/cmux/stream?surface=${I.sfA1}`)],
    '/api/cmux/grid-stream': [sse(`/api/cmux/grid-stream?surface=${I.sfA1}`)],
    '/api/cmux/layout-stream': [sse(`/api/cmux/layout-stream?workspace=${I.wsA}`)],
    '/api/cmux/panes-stream': [sse(`/api/cmux/panes-stream?surfaces=${I.sfA1},${I.sfA2}`)],
    '/api/cmux/send': [post('/api/cmux/send', { surface: I.sfA1, text: 'echo p19' }), post('/api/cmux/send', { surface: I.sfA1, text: 'x', expect_seq: 1 })],
    '/api/cmux/key': [post('/api/cmux/key', { surface: I.sfA1, key: 'enter' })],
    '/api/cmux/new-surface': [post('/api/cmux/new-surface', { workspace: I.wsA, pane: I.paneA1 })],
    '/api/cmux/new-workspace': [post('/api/cmux/new-workspace', { cwd: fakeDir })],
    '/api/cmux/close-tab': [post('/api/cmux/close-tab', { surface: I.sfA2 })],
    '/api/cmux/rename-workspace': [post('/api/cmux/rename-workspace', { workspace: I.wsA, title: 'renamed' })],
    '/api/cmux/close-workspace': [post('/api/cmux/close-workspace', { workspace: I.wsB })],
    '/api/cmux/new-pane': [post('/api/cmux/new-pane', { workspace: I.wsA, direction: 'right', pane: I.paneA1 })],
    '/api/cmux/split-off': [post('/api/cmux/split-off', { surface: I.sfA1, direction: 'right', workspace: I.wsA })],
    '/api/cmux/drop-surface': [post('/api/cmux/drop-surface', { workspace: I.wsA, surface: I.sfA2, pane: I.paneA1, edge: 'center' })],
    '/api/cmux/close-pane': [post('/api/cmux/close-pane', { workspace: I.wsA, pane: I.paneA2 })],
    '/api/cmux/focus-pane': [post('/api/cmux/focus-pane', { pane: I.paneA2, workspace: I.wsA })],
    '/api/cmux/focus-surface': [post('/api/cmux/focus-surface', { surface: I.sfA1 })],
    '/api/cmux/resize-pane': [post('/api/cmux/resize-pane', { workspace: I.wsA, paneA: I.paneA1, paneB: I.paneA2, axis: 'x', target: 0.3 })],
    '/api/cmux/equalize': [post('/api/cmux/equalize', { workspace: I.wsA })],
    '/api/cmux/upload': [{ kind: 'upload' }],
    '/api/cmux/browser/info': [json('GET', `/api/cmux/browser/info?surface=${I.sfA1}`)],
    '/api/cmux/browser/stream': [{ kind: 'open', pq: `/api/cmux/browser/stream?surface=${I.sfA1}` }],
    '/api/cmux/browser/open': [post('/api/cmux/browser/open', { surface: I.sfA1, url: 'https://example.invalid/' })],
    '/api/cmux/browser/tap': [post('/api/cmux/browser/tap', { surface: I.sfA1, x: 0.5, y: 0.5 })],
    '/api/cmux/browser/type': [post('/api/cmux/browser/type', { surface: I.sfA1, text: 'a' })],
    '/api/cmux/browser/key': [post('/api/cmux/browser/key', { surface: I.sfA1, key: 'enter' })],
    '/api/cmux/browser/scroll': [post('/api/cmux/browser/scroll', { surface: I.sfA1, dy: 10 })],
    '/api/cmux/browser/nav': [post('/api/cmux/browser/nav', { surface: I.sfA1, action: 'back' })],
    '/api/cmux/browser/zoom': [post('/api/cmux/browser/zoom', { surface: I.sfA1, dir: 'in' })],
  };
}

test('the route list is read from handleApi, and every route has a contract case', () => {
  const scanned = scanRoutes(fs.readFileSync(SERVER_JS, 'utf8'));
  const table = Object.keys(cases()).sort();
  const missing = scanned.filter((r) => !table.includes(r));
  const stale = table.filter((r) => !scanned.includes(r));
  assert.deepEqual(missing, [], `routes in server.js handleApi with no contract case: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `contract cases for routes server.js no longer has: ${stale.join(', ')}`);
  assert.ok(scanned.length >= 50, `only ${scanned.length} routes scanned — the scanner is broken`);
  console.log(`# p19 contract: ${scanned.length} /api/cmux routes read from handleApi`);
});

test('every /api/cmux route answers the same status and JSON shape over TCP and over UNIX sockets', async () => {
  const all = cases();
  let calls = 0;
  const tally = {};
  const count = (st) => { tally[st] = (tally[st] || 0) + 1; };
  for (const route of Object.keys(all)) {
    for (const c of all[route]) {
      if (c.kind === 'json') {
        const [a, b] = await Promise.all([tcp, uds].map((p) => call(p.target, c.method, c.pq, { token: TOKEN, body: c.body })));
        sameShape(`${c.method} ${c.pq}`, a, b);
        count(a.status);
        calls++;
      } else if (c.kind === 'sse') {
        const [a, b] = await Promise.all([tcp, uds].map((p) => firstFrame(p.target, c.pq, { token: TOKEN })));
        sameShape(`SSE ${c.pq}`, a, b);
        assert.equal(a.status, 200, `${c.pq} first frame`);
        assert.ok(a.data && b.data, `${c.pq}: both sent a data frame`);
        assert.equal(a.json === null, b.json === null, `${c.pq}: JSON on one side only`);
        if (a.json === null) assert.equal(b.data, a.data, `${c.pq}: the same text frame`);
        count(a.status);
        calls++;
      } else if (c.kind === 'open') {
        const [a, b] = await Promise.all([tcp, uds].map((p) => openStream(p.target, c.pq, { token: TOKEN })));
        a.close(); b.close();
        assert.equal(b.status, a.status, `${c.pq}: status tcp ${a.status} vs unix ${b.status}`);
        assert.equal(b.headers['content-type'], a.headers['content-type']);
        count(a.status);
        calls++;
      } else if (c.kind === 'download') {
        const note = path.join(fakeDir, 'p19-dl.bin');
        const got = [];
        for (const p of [tcp, uds]) {
          const t = await call(p.target, 'GET', `/api/cmux/fs/download-ticket?path=${q(note)}`, { token: TOKEN });
          assert.equal(t.status, 200, t.text);
          const r = await call(p.target, 'GET', `/api/cmux/fs/download?ticket=${q(t.json.ticket)}`, { headers: { range: 'bytes=0-9' } });
          const full = await call(p.target, 'GET', `/api/cmux/fs/download?ticket=${q(t.json.ticket)}`);
          const bad = await call(p.target, 'GET', '/api/cmux/fs/download?ticket=nope');
          got.push({ r, full, bad });
        }
        const [a, b] = got;
        assert.equal(a.r.status, 206);
        assert.equal(b.r.status, 206);
        assert.equal(b.r.headers['content-range'], a.r.headers['content-range']);
        assert.equal(a.r.headers['content-range'], `bytes 0-9/${DL.length}`);
        assert.deepEqual(b.r.body, a.r.body);
        assert.deepEqual(a.r.body, DL.subarray(0, 10));
        assert.equal(a.full.status, 200);
        assert.deepEqual(b.full.body, DL, 'the whole file over the sockets');
        assert.deepEqual(a.full.body, DL);
        sameShape('download bad ticket', a.bad, b.bad);
        count(a.r.status); count(a.full.status); count(a.bad.status);
        calls += 3;
      } else if (c.kind === 'upload') {
        const bytes = Buffer.from(`p19 upload bytes ${'z'.repeat(5000)}\n\u0000ÿ`, 'latin1');
        const [a, b] = await Promise.all([tcp, uds].map((p) => call(p.target, 'POST', '/api/cmux/upload?machine=default',
          { token: TOKEN, body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'p19.bin' } })));
        sameShape('upload', a, b);
        assert.equal(a.status, 200, a.text);
        assert.equal(a.json.bytes, bytes.length);
        assert.deepEqual(fs.readFileSync(a.json.path), bytes, 'tcp: the bytes landed');
        assert.deepEqual(fs.readFileSync(b.json.path), bytes, 'unix: the same bytes landed');
        count(a.status);
        calls++;
      } else assert.fail(`unknown case kind ${c.kind}`);
    }
  }
  assert.ok(calls >= 60, `${calls} comparisons`);
  console.log(`# p19 contract: ${calls} comparisons, statuses ${JSON.stringify(tally)}`);
});

test('the contract really ran on two transports: TCP pair on ports, socket pair on unix: paths', () => {
  assert.match(tcp.server.stdout(), /cmux-remote server on http:\/\/127\.0\.0\.1:\d+ with 1 machine\(s\)/);
  assert.ok(uds.server.stdout().includes(`cmux-remote server on unix:${uds.server.socketPath} with 1 machine(s)`));
  assert.ok(uds.server.stdout().includes(`→ unix:${uds.bridge.socketPath}`));
});
