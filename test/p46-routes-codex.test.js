'use strict';
// p46 C2 — Codex panes through the REAL routes (thread read + thread stream) on a real bridge.js child
// (the test/p41-routes.test.js pattern). Rollouts are generated in a temp HOME from the record shapes Codex
// writes; real rollouts are private and never read or copied in.
//
// Blocking proof (chief): two Codex panes in one cwd get two distinct threads, or the explicit
// `codex-ambiguous` state. Never the same thread for both.
//
// How a pane binds, by rule (printed per test):
//   event          a hook event names the pane and the rollout path  (the pane's own)
//   cwd-unique     only a hook event cwd; exactly one pane resolves the rollout
//   cwd-ambiguous  only a hook event cwd; two panes resolve the same rollout -> codex-ambiguous
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { writeFakeCmux, IDS } = require('./helpers/fake-cmux');
const { call } = require('./helpers/unix-call');
const eventlog = require('../radar/eventlog');

const SECRET = 'p46-routes-secret';
const MACHINE = 'mini';
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p46r-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();
const line = (r) => JSON.stringify(r) + '\n';
const meta = (id, cwd) => ({ timestamp: ts(0), type: 'session_meta', payload: { id, session_id: id, cwd, cli_version: '0.0.0-test' } });
const item = (n, it) => ({ timestamp: ts(n), type: 'event_msg', payload: { type: 'item_completed', turn_id: 't-1', item: it } });
const user = (n, text) => item(n, { type: 'UserMessage', id: `u${n}`, content: [{ type: 'text', text, text_elements: [] }] });
const agent = (n, text) => item(n, { type: 'AgentMessage', id: `a${n}`, phase: 'final_answer', content: [{ type: 'Text', text }] });

// HOME with Codex rollouts; names embed the start time, newest name sorts last (the join scans newest first).
function rollouts(h, specs) {
  const dir = path.join(h, '.codex', 'sessions', '2026', '11', '04');
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  specs.forEach((s, i) => {
    const p = path.join(dir, `rollout-2026-11-04T10-0${i}-00-${s.id}.jsonl`);
    fs.writeFileSync(p, (s.rows || [meta(s.id, s.cwd), user(1, `q-${s.id}`), agent(2, `a-${s.id}`)]).map(line).join(''));
    out[s.id] = p;
  });
  return out;
}
const radar = (h) => path.join(h, '.radar');
// A hook event that names pane + rollout (rule: event) ...
const bindEvent = (h, sf, id, p, cwd) => eventlog.appendEventSync(radar(h), { sessionId: id, event: 'Stop', transcriptPath: p, surfaceId: sf, cwd }, Date.now());
// ... or only a cwd (rule: cwd-*).
const cwdEvent = (h, sf, cwd) => eventlog.appendEventSync(radar(h), { sessionId: `none-${sf.slice(0, 4)}`, event: 'SessionStart', surfaceId: sf, cwd }, Date.now());

function procsFixture() {
  const f = path.join(tmp(), 'procs.json');
  fs.writeFileSync(f, JSON.stringify({ ps: '', tmuxSockets: [] }));
  return f;
}
async function boot(h, fakeOpts) {
  const fake = writeFakeCmux(tmp(), fakeOpts);
  return bootBridge({ cwd: h, socket: path.join(tmp(), 'bridge.sock'), env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET,
    RADAR_MACHINE_ID: MACHINE, P41_JOIN_POLL_MS: '200', P41_PROCS_FIXTURE: procsFixture() } });
}
const idOf = (sf) => encodeURIComponent(`${MACHINE}:${sf}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (b) => call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
const thread = (b, sf, q = '') => call(b.socketPath, 'GET', `/cmux/sessions/${idOf(sf)}/thread${q}`, { secret: SECRET });
const texts = (t) => t.json.messages.map((m) => m.text);

function sse(sock, p) {
  const frames = [];
  let waiters = [];
  const req = http.request({ socketPath: sock, path: p, headers: { 'x-bridge-secret': SECRET }, agent: false });
  req.on('response', (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const l = block.split('\n').find((x) => x.startsWith('data: '));
        if (!l) continue;
        try { frames.push(JSON.parse(l.slice(6))); } catch (_) { continue; }
        waiters = waiters.filter((w) => { const hit = frames.find(w.pred); if (hit) w.resolve(hit); return !hit; });
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return {
    frames,
    waitFor(pred, ms = 8000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`no matching frame in ${ms}ms: ${JSON.stringify(frames)}`)), ms);
      });
    },
    close() { req.destroy(); },
  };
}

test('rule event: one Codex pane shows its rollout as a thread, not the unsupported note', async () => {
  const h = tmp();
  const r = rollouts(h, [{ id: 'cx1', cwd: '/work/beta' }]);
  bindEvent(h, IDS.sfB1, 'cx1', r.cx1, '/work/beta');
  const b = await boot(h);
  try {
    const l = await list(b);
    assert.equal(l.json.sessions.find((v) => v.surface === IDS.sfB1).kind, 'codex');
    const t = await thread(b, IDS.sfB1);
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.unsupported, undefined, t.text);
    assert.deepEqual(texts(t), ['q-cx1', 'a-cx1']);
    assert.deepEqual(t.json.messages.map((m) => m.kind), ['user', 'assistant']);
  } finally { await b.stop(); }
});

test('rule cwd-unique: one pane with only a cwd binds the one rollout in that cwd', async () => {
  const h = tmp();
  rollouts(h, [{ id: 'cx2', cwd: '/work/beta' }]);
  cwdEvent(h, IDS.sfB1, '/work/beta');
  const b = await boot(h);
  try {
    await list(b);
    const t = await thread(b, IDS.sfB1);
    assert.equal(t.json.unsupported, undefined, t.text);
    assert.deepEqual(texts(t), ['q-cx2', 'a-cx2']);
  } finally { await b.stop(); }
});

test('rule cwd-ambiguous (BLOCKING): two panes in one cwd, no event path: no thread is shown to either, on the thread route and the stream route', async () => {
  const h = tmp();
  rollouts(h, [{ id: 'cxA', cwd: '/work/shared' }, { id: 'cxB', cwd: '/work/shared' }]);
  cwdEvent(h, IDS.sfA1, '/work/shared');
  cwdEvent(h, IDS.sfA2, '/work/shared');
  const b = await boot(h);
  const s1 = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfA1)}/thread-stream`);
  const s2 = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfA2)}/thread-stream`);
  try {
    await list(b);
    for (const sf of [IDS.sfA1, IDS.sfA2]) {
      const t = await thread(b, sf);
      assert.equal(t.status, 200, t.text);
      assert.equal(t.json.unsupported, 'codex-ambiguous', `${sf}: ${t.text}`);
      assert.deepEqual(t.json.messages, []);
      assert.equal(t.json.cursor, null);
    }
    for (const s of [s1, s2]) {
      const ev = await s.waitFor((f) => f.type === 'unsupported');
      assert.equal(ev.unsupported, 'codex-ambiguous');
    }
    await sleep(700);
    for (const s of [s1, s2]) assert.ok(!s.frames.some((f) => f.type === 'msg'), JSON.stringify(s.frames));
  } finally { s1.close(); s2.close(); await b.stop(); }
});

test('rule event + cwd (BLOCKING): a pane that holds its rollout by event excludes it; the other pane in the cwd gets a different thread', async () => {
  const h = tmp();
  // cxNew is the newest name: without the D299 exclusion the cwd pane would take it too.
  const r = rollouts(h, [{ id: 'cxOld', cwd: '/work/shared' }, { id: 'cxNew', cwd: '/work/shared' }]);
  bindEvent(h, IDS.sfA1, 'cxNew', r.cxNew, '/work/shared');
  cwdEvent(h, IDS.sfA2, '/work/shared');
  const b = await boot(h);
  try {
    await list(b);
    const t1 = await thread(b, IDS.sfA1);
    const t2 = await thread(b, IDS.sfA2);
    assert.equal(t1.json.unsupported, undefined, t1.text);
    assert.equal(t2.json.unsupported, undefined, t2.text);
    assert.deepEqual(texts(t1), ['q-cxNew', 'a-cxNew']);
    assert.deepEqual(texts(t2), ['q-cxOld', 'a-cxOld']);
  } finally { await b.stop(); }
});

test('old-format rollout (no payload envelope): thread answers unsupported codex, never an empty thread', async () => {
  const h = tmp();
  const r = rollouts(h, [{ id: 'cxOldFmt', rows: [{ type: 'session_meta', id: 'cxOldFmt', cwd: '/work/beta' }, { type: 'message', role: 'user', content: 'x' }] }]);
  bindEvent(h, IDS.sfB1, 'cxOldFmt', r.cxOldFmt, '/work/beta');
  const b = await boot(h);
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfB1)}/thread-stream`);
  try {
    await list(b);
    const t = await thread(b, IDS.sfB1);
    assert.equal(t.json.unsupported, 'codex', t.text);
    assert.deepEqual(t.json.messages, []);
    const ev = await s.waitFor((f) => f.type === 'unsupported');
    assert.equal(ev.unsupported, 'codex');
  } finally { s.close(); await b.stop(); }
});

test('stream: a second turn appended to the rollout arrives as a msg with no reset (D3)', async () => {
  const h = tmp();
  const r = rollouts(h, [{ id: 'cx3', cwd: '/work/beta' }]);
  bindEvent(h, IDS.sfB1, 'cx3', r.cx3, '/work/beta');
  const b = await boot(h);
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfB1)}/thread-stream`);
  try {
    await list(b);
    await sleep(700);
    fs.appendFileSync(r.cx3, line(user(3, 'second-q')) + line(agent(4, 'second-a')));
    const m = await s.waitFor((f) => f.type === 'msg' && f.msg && f.msg.text === 'second-a');
    assert.equal(m.msg.kind, 'assistant');
    assert.ok(!s.frames.some((f) => f.type === 'reset'), JSON.stringify(s.frames));
    assert.ok(!s.frames.some((f) => f.type === 'unsupported'), JSON.stringify(s.frames));
  } finally { s.close(); await b.stop(); }
});

test('thread paging through the route: before pages older rows; a forged cursor is 400 bad_cursor (C3)', async () => {
  const h = tmp();
  const rows = [meta('cx4', '/work/beta')];
  for (let n = 1; n <= 6; n++) rows.push(user(2 * n - 1, `q${n}`), agent(2 * n, `a${n}`));
  const r = rollouts(h, [{ id: 'cx4', rows }]);
  bindEvent(h, IDS.sfB1, 'cx4', r.cx4, '/work/beta');
  const b = await boot(h);
  try {
    await list(b);
    const page1 = await thread(b, IDS.sfB1, '?limit=4');
    assert.equal(page1.status, 200, page1.text);
    assert.deepEqual(texts(page1), ['q5', 'a5', 'q6', 'a6']);
    assert.equal(typeof page1.json.cursor, 'string');
    const page2 = await thread(b, IDS.sfB1, `?limit=4&before=${encodeURIComponent(page1.json.cursor)}`);
    assert.equal(page2.status, 200, page2.text);
    assert.deepEqual(texts(page2), ['q3', 'a3', 'q4', 'a4']);
    const bad = await thread(b, IDS.sfB1, `?before=${encodeURIComponent('not-a-cursor')}`);
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.error, 'bad_cursor');
  } finally { await b.stop(); }
});

test('ambiguity ends live: when the other pane goes away the stream resets and tails its own rollout', async () => {
  const h = tmp();
  const r = rollouts(h, [{ id: 'cxS', cwd: '/work/shared' }]);
  cwdEvent(h, IDS.sfA1, '/work/shared');
  cwdEvent(h, IDS.sfB1, '/work/shared');
  const hideFile = path.join(h, 'hide-beta');
  const b = await boot(h, { hideFile });
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfA1)}/thread-stream`);
  try {
    await list(b);
    const amb = await s.waitFor((f) => f.type === 'unsupported');
    assert.equal(amb.unsupported, 'codex-ambiguous');
    fs.writeFileSync(hideFile, '1');                       // workspace beta (the other pane) is gone
    await s.waitFor((f) => f.type === 'reset', 12000);
    await sleep(700);
    fs.appendFileSync(r.cxS, line(agent(9, 'after-split')));
    const m = await s.waitFor((f) => f.type === 'msg' && f.msg && f.msg.text === 'after-split', 12000);
    assert.equal(m.msg.kind, 'assistant');
  } finally { s.close(); await b.stop(); }
});
