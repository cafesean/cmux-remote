'use strict';
// p41 A6 — the /cmux/sessions* routes on a REAL bridge.js child (the test/p19-bridge-socket.test.js
// pattern): a UNIX socket in a fresh 0700 temp dir, the fixture-serving fake cmux, HOME = the child's
// own scratch cwd, so the transcripts and the radar event log are fixture files under it.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { writeFakeCmux, IDS } = require('./helpers/fake-cmux');
const { startTmux, tmuxBinary } = require('./helpers/tmux-server');
const { call } = require('./helpers/unix-call');
const eventlog = require('../radar/eventlog');

const SECRET = 'p41-routes-secret';
const MACHINE = 'mini';
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p41r-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.now() - 60 * 1000;
const iso = (n) => new Date(T0 + n * 1000).toISOString();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n, text) => ({ type: 'user', uuid: uid(n), timestamp: iso(n), message: { role: 'user', content: text } });
const asst = (n, text) => ({ type: 'assistant', uuid: uid(n), timestamp: iso(n), message: { id: `msg_${n}`, role: 'assistant',
  model: 'claude-opus-4-5', content: [{ type: 'text', text }], usage: { input_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// A HOME with one Claude transcript joined to surface sfA1 by a Stop hook event.
function home(rowsA) {
  const h = tmp();
  const dir = path.join(h, '.claude', 'projects', '-work-alpha');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'sess-a.jsonl');
  fs.writeFileSync(a, jsonl(rowsA));
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'sess-a', event: 'UserPromptSubmit', transcriptPath: a, surfaceId: IDS.sfA1, cwd: '/work/alpha' }, T0 + 500);
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'sess-a', event: 'Stop', transcriptPath: a, surfaceId: IDS.sfA1, cwd: '/work/alpha' }, T0 + 30000);
  return { h, dir, a };
}

async function boot(h, extra, fakeOpts) {
  const fake = writeFakeCmux(tmp(), fakeOpts);
  const sock = path.join(tmp(), 'bridge.sock');
  return bootBridge({ cwd: h, socket: sock, env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, RADAR_MACHINE_ID: MACHINE, P41_JOIN_POLL_MS: '200', ...(extra || {}) } });
}
const idOf = (sf) => encodeURIComponent(`${MACHINE}:${sf}`);

// An SSE reader: collects every JSON `data:` frame; waitFor(pred) resolves with the first match.
function sse(sock, p) {
  const frames = [];
  let waiters = [];
  const req = http.request({ socketPath: sock, path: p, headers: { 'x-bridge-secret': SECRET }, agent: false });
  const opened = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { frames.push(JSON.parse(line.slice(6))); } catch (_) { continue; }
          waiters = waiters.filter((w) => { const hit = frames.find(w.pred); if (hit) w.resolve(hit); return !hit; });
        }
      });
      resolve(res);
    });
    req.on('error', reject);
  });
  req.end();
  return {
    opened, frames,
    waitFor(pred, ms = 8000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`no matching frame in ${ms}ms: ${JSON.stringify(frames)}`)), ms);
      });
    },
    close() { req.destroy(); },
  };
}

test('sessions lists kinds and status', async () => {
  const { h } = home([user(1, 'go'), asst(2, 'All set.\n\nDONE')]);
  const b = await boot(h, {}, { browser: true });
  try {
    const denied = await call(b.socketPath, 'GET', '/cmux/sessions');
    assert.equal(denied.status, 403, 'auth-gated like every /cmux/* route');
    const r = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.machineId, MACHINE);
    const by = Object.fromEntries(r.json.sessions.map((s) => [s.surface, s]));
    const a1 = by[IDS.sfA1];
    assert.equal(a1.id, `${MACHINE}:${IDS.sfA1}`);
    assert.equal(a1.machine, MACHINE);
    assert.equal(a1.kind, 'claude');
    assert.equal(a1.workspace, 'alpha');
    assert.ok(['finished', 'your-turn'].includes(a1.status), a1.status);
    assert.equal(a1.model, 'claude-opus-4-5');
    assert.equal(a1.contextPct, 25);
    assert.equal(typeof a1.lastActivity, 'number');
    assert.equal(by[IDS.sfA2].kind, 'terminal');
    assert.equal(by[IDS.sfB2].kind, 'browser');
    for (const s of r.json.sessions) assert.equal(s.machine, MACHINE);
    const tree = await call(b.socketPath, 'GET', '/cmux/tree', { secret: SECRET });
    assert.equal(tree.status, 200, 'existing route untouched');
  } finally { await b.stop(); }
});

test('thread pages with cursor', async () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(i % 2 ? user(i, `q${i}`) : asst(i, `a${i}`));
  const { h } = home(rows);
  const b = await boot(h);
  try {
    const p1 = await call(b.socketPath, 'GET', `/cmux/sessions/${idOf(IDS.sfA1)}/thread?limit=4`, { secret: SECRET });
    assert.equal(p1.status, 200, p1.text);
    assert.deepEqual(p1.json.messages.map((m) => m.text), ['q7', 'a8', 'q9', 'a10']);
    assert.equal(p1.json.messages.length, 4);
    assert.equal(p1.json.messages[3].text, 'a10');
    assert.equal(typeof p1.json.cursor, 'string');
    const p2 = await call(b.socketPath, 'GET', `/cmux/sessions/${idOf(IDS.sfA1)}/thread?limit=4&before=${encodeURIComponent(p1.json.cursor)}`, { secret: SECRET });
    assert.equal(p2.status, 200, p2.text);
    assert.deepEqual(p2.json.messages.map((m) => m.text), ['q3', 'a4', 'q5', 'a6']);
    const bad = await call(b.socketPath, 'GET', `/cmux/sessions/${idOf(IDS.sfA1)}/thread?before=%21%21`, { secret: SECRET });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'bad_cursor' });
  } finally { await b.stop(); }
});

test('stream emits msg on transcript append', async () => {
  const { h, a } = home([user(1, 'go'), asst(2, 'first')]);
  const b = await boot(h);
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfA1)}/thread-stream`);
  try {
    const res = await s.opened;
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.equal(res.headers['x-accel-buffering'], 'no');
    await new Promise((r) => setTimeout(r, 600));
    fs.appendFileSync(a, jsonl([asst(3, 'appended')]));
    const ev = await s.waitFor((f) => f.type === 'msg' && f.msg.text === 'appended');
    assert.equal(ev.session, `${MACHINE}:${IDS.sfA1}`);
  } finally { s.close(); await b.stop(); }
});

test('stream emits reset when the join switches file', async () => {
  const { h, dir } = home([user(1, 'go'), asst(2, 'first')]);
  const b = await boot(h);
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfA1)}/thread-stream`);
  try {
    await s.opened;
    await new Promise((r) => setTimeout(r, 600));
    const bPath = path.join(dir, 'sess-b.jsonl');
    fs.writeFileSync(bPath, jsonl([user(10, 'after clear')]));
    eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'sess-b', event: 'SessionStart', transcriptPath: bPath, surfaceId: IDS.sfA1 }, Date.now());
    await s.waitFor((f) => f.type === 'reset');
    await new Promise((r) => setTimeout(r, 600));
    fs.appendFileSync(bPath, jsonl([asst(11, 'on the new file')]));
    await s.waitFor((f) => f.type === 'msg' && f.msg.text === 'on the new file');
  } finally { s.close(); await b.stop(); }
});

test('unknown id → 404', async () => {
  const { h } = home([user(1, 'go')]);
  const b = await boot(h);
  try {
    for (const p of [`/cmux/sessions/${idOf('surface:999')}/thread`, `/cmux/sessions/${encodeURIComponent(`other:${IDS.sfA1}`)}/thread`,
      `/cmux/sessions/${idOf('nope')}/attachment/0`]) {
      const r = await call(b.socketPath, 'GET', p, { secret: SECRET });
      assert.equal(r.status, 404, `${p} ${r.text}`);
    }
  } finally { await b.stop(); }
});

test('tmux backend → sessions work, browser kind absent', { skip: tmuxBinary() ? false : 'tmux not installed' }, async () => {
  const srv = await startTmux();
  const h = tmp();
  const b = await boot(h, { BACKEND: 'tmux', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin });
  try {
    let r;
    for (let i = 0; i < 20; i++) {
      r = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
      if (r.status === 200 && r.json.sessions.length) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.machineId, MACHINE);
    assert.ok(r.json.sessions.length >= 1);
    assert.ok(r.json.sessions.every((s) => s.kind !== 'browser'));
    assert.ok(r.json.sessions.every((s) => s.kind === 'terminal'), JSON.stringify(r.json.sessions));
  } finally { await b.stop(); await srv.stop(); }
});
