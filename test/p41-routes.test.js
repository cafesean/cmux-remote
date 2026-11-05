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

// Every boot gets a process-table fixture (default: empty, no tmux sockets), so no test reads this
// host's real ps or tmux (a real detached claude would otherwise leak into a cmux-backend list).
function procsFixture(fx) {
  const f = path.join(tmp(), 'procs.json');
  fs.writeFileSync(f, JSON.stringify(fx || { ps: '', tmuxSockets: [] }));
  return f;
}
async function boot(h, extra, fakeOpts) {
  const fake = writeFakeCmux(tmp(), fakeOpts);
  const sock = path.join(tmp(), 'bridge.sock');
  return bootBridge({ cwd: h, socket: sock, env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, RADAR_MACHINE_ID: MACHINE, P41_JOIN_POLL_MS: '200',
    P41_PROCS_FIXTURE: procsFixture(), ...(extra || {}) } });
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

// ---- fix round 1 ---------------------------------------------------------------------------------

test('codex session: thread is empty + unsupported, stream sends one unsupported event', async () => {
  const h = tmp();
  const dir = path.join(h, '.codex', 'sessions', '2026', '11', '04');
  fs.mkdirSync(dir, { recursive: true });
  const x = path.join(dir, 'rollout-2026-11-04T10-00-00-cx.jsonl');
  fs.writeFileSync(x, jsonl([{ type: 'session_meta', payload: { id: 'cx', cwd: '/work/beta' } }, user(1, 'claude-shaped row the Claude reader would show')]));
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'cx', event: 'Stop', transcriptPath: x, surfaceId: IDS.sfB1 }, Date.now());
  const b = await boot(h);
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfB1)}/thread-stream`);
  try {
    const list = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    assert.equal(list.json.sessions.find((v) => v.surface === IDS.sfB1).kind, 'codex');
    const t = await call(b.socketPath, 'GET', `/cmux/sessions/${idOf(IDS.sfB1)}/thread`, { secret: SECRET });
    assert.equal(t.status, 200, t.text);
    assert.equal(typeof t.json.title, 'string');
    assert.deepEqual({ ...t.json, title: '' }, { title: '', messages: [], cursor: null, unsupported: 'codex' });
    const ev = await s.waitFor((f) => f.type === 'unsupported');
    assert.equal(ev.unsupported, 'codex');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(s.frames.length, 1, JSON.stringify(s.frames));
  } finally { s.close(); await b.stop(); }
});

test('stream on a pane that closes: `gone` then the response ends', async () => {
  const { h } = home([user(1, 'go')]);
  const hideFile = path.join(h, 'hide-beta');
  const b = await boot(h, {}, { hideFile });
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfB1)}/thread-stream`);
  try {
    const res = await s.opened;
    const ended = new Promise((r) => res.on('end', r));
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(hideFile, '1');
    await s.waitFor((f) => f.type === 'gone');
    await ended;
  } finally { s.close(); await b.stop(); }
});

test('refused path: a transcript outside the allowed roots, or a symlink out of them, is never served', async () => {
  const h = tmp();
  const out = path.join(h, 'elsewhere');
  fs.mkdirSync(out, { recursive: true });
  const secret = path.join(out, 'secret.jsonl');
  fs.writeFileSync(secret, jsonl([user(1, 'SECRET-TEXT')]));
  const dir = path.join(h, '.claude', 'projects', '-work');
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, 'link.jsonl');
  fs.symlinkSync(secret, link);
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 's1', event: 'Stop', transcriptPath: secret, surfaceId: IDS.sfA1 }, Date.now() - 2000);
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 's2', event: 'Stop', transcriptPath: link, surfaceId: IDS.sfA2 }, Date.now() - 1000);
  const b = await boot(h);
  try {
    for (const sf of [IDS.sfA1, IDS.sfA2]) {
      const t = await call(b.socketPath, 'GET', `/cmux/sessions/${idOf(sf)}/thread`, { secret: SECRET });
      assert.equal(t.status, 200, t.text);
      assert.deepEqual(t.json.messages, []);
      assert.ok(!t.text.includes('SECRET-TEXT'));
      const a = await call(b.socketPath, 'GET', `/cmux/sessions/${idOf(sf)}/attachment/0`, { secret: SECRET });
      assert.equal(a.status, 404);
    }
    const l = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    assert.ok(!l.text.includes('SECRET-TEXT'));
  } finally { await b.stop(); }
});

test('attachment route: bytes and mime of image n; 404 past the end; 400 bad index; 415 non-image', async () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const img = (mime, data) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } });
  const { h } = home([user(1, [{ type: 'text', text: 'look' }, img('image/png', PNG), img('text/html', Buffer.from('<b>x</b>'))]), asst(2, 'seen')]);
  const b = await boot(h);
  try {
    const base = `/cmux/sessions/${idOf(IDS.sfA1)}/attachment/`;
    const ok = await call(b.socketPath, 'GET', base + '0', { secret: SECRET });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.ok(ok.body.equals(PNG));
    assert.equal((await call(b.socketPath, 'GET', base + '1', { secret: SECRET })).status, 415);
    assert.equal((await call(b.socketPath, 'GET', base + '2', { secret: SECRET })).status, 404);
    assert.equal((await call(b.socketPath, 'GET', base + 'x', { secret: SECRET })).status, 400);
  } finally { await b.stop(); }
});

// ---- fix round 2 ---------------------------------------------------------------------------------

test('stream on a claude pane whose join moves to a Codex rollout: reset + unsupported, no Claude-parsed msgs', async () => {
  const { h, a } = home([user(1, 'go'), asst(2, 'first')]);
  const b = await boot(h);
  const s = sse(b.socketPath, `/cmux/sessions/${idOf(IDS.sfA1)}/thread-stream`);
  try {
    await s.opened;
    await new Promise((r) => setTimeout(r, 600));
    const dir = path.join(h, '.codex', 'sessions', '2026', '11', '04');
    fs.mkdirSync(dir, { recursive: true });
    const x = path.join(dir, 'rollout-2026-11-04T10-00-00-cx.jsonl');
    fs.writeFileSync(x, jsonl([{ type: 'session_meta', payload: { id: 'cx', cwd: '/work/alpha' } }]));
    eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'cx', event: 'SessionStart', transcriptPath: x, surfaceId: IDS.sfA1 }, Date.now());
    const ev = await s.waitFor((f) => f.type === 'unsupported');
    assert.equal(ev.unsupported, 'codex');
    await new Promise((r) => setTimeout(r, 600));
    fs.appendFileSync(x, jsonl([asst(20, 'CODEX-AS-CLAUDE')]));
    fs.appendFileSync(a, jsonl([asst(21, 'OLD-FILE')]));
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!s.frames.some((f) => f.type === 'msg'), JSON.stringify(s.frames));
    assert.equal(s.frames.filter((f) => f.type === 'unsupported').length, 1);
  } finally { s.close(); await b.stop(); }
});

// ---- BUG1 fix round 1: a detached tmux session (no cmux pane) is listed and accepts input --------

test('cmux backend: detached tmux claude session listed with reach tmux; /cmux/send + /cmux/key type into it', { skip: tmuxBinary() ? false : 'tmux not installed' }, async () => {
  const srv = await startTmux();
  await srv.runOk(['new-session', '-d', '-s', 'x-chief', 'cat']);
  const panePid = Number(await srv.display('x-chief', '#{pane_pid}'));
  const paneId = await srv.display('x-chief', '#{pane_id}');
  const h = tmp();
  const fx = procsFixture({ ps: `${panePid} 1 cat\n99999 ${panePid} /Users/s/.local/bin/claude -n x-chief\n`, tmuxSockets: [srv.socket] });
  const b = await boot(h, { P41_PROCS_FIXTURE: fx, TMUX_BIN: srv.tmuxBin });
  try {
    const r = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    assert.equal(r.status, 200, r.text);
    const s = r.json.sessions.find((x) => x.title === 'x-chief');
    assert.ok(s, JSON.stringify(r.json.sessions));
    assert.equal(s.reach, 'tmux');
    assert.equal(s.workspace, 'tmux');
    assert.equal(s.kind, 'claude');
    assert.ok(r.json.sessions.filter((x) => x.surface !== s.surface).every((x) => x.reach === 'cmux'));
    const sent = await call(b.socketPath, 'POST', '/cmux/send', { secret: SECRET, body: { surface: s.surface, text: 'hello-p41', submit: true } });
    assert.equal(sent.status, 200, sent.text);
    const key = await call(b.socketPath, 'POST', '/cmux/key', { secret: SECRET, body: { surface: s.surface, key: 'enter' } });
    assert.equal(key.status, 200, key.text);
    await srv.waitFor(async () => /hello-p41\n.*hello-p41/s.test(await srv.capture(paneId)), { what: 'cat echoed the submitted line' });
  } finally { await b.stop(); await srv.stop(); }
});

// A14: Session.choice on the list, from the live screen (fake cmux replays the permission prompt).
test('A14: waiting session carries choice from the live menu; slash menu gives none', async () => {
  const { h } = home([user(1, 'go'), asst(2, 'Deleting build.')]);
  const b = await boot(h, {}, { grid: 'a14-permission' });
  try {
    const r = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    assert.equal(r.status, 200, r.text);
    const a1 = r.json.sessions.find((s) => s.surface === IDS.sfA1);
    assert.equal(a1.status, 'your-turn');
    assert.equal(a1.choice.source, 'menu');
    assert.deepEqual(a1.choice.options.map((o) => o.send.keys), [['enter'], ['down', 'enter'], ['down', 'down', 'enter']]);
    assert.equal(r.json.sessions.find((s) => s.surface === IDS.sfA2).choice, undefined, 'terminal kind: no choice');
  } finally { await b.stop(); }
  const b2 = await boot(h, {}, {});
  try {
    const r = await call(b2.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    assert.equal(r.json.sessions.find((s) => s.surface === IDS.sfA1).choice, undefined, 'a slash completion menu is not a question');
  } finally { await b2.stop(); }
});

// A14 fix 1: POST /cmux/choose re-reads and refuses a stale pick without sending anything.
test('A14: /cmux/choose — stale choiceId and label mismatch are 409 and send nothing; a fresh pick sends', async () => {
  const { h } = home([user(1, 'go'), asst(2, 'Deleting build.')]);
  const logFile = path.join(tmp(), 'cmux.log');
  const b = await boot(h, {}, { grid: 'a14-permission', logFile });
  const sent = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((a) => a[0] === 'send-key' || a[0] === 'send');
  try {
    const list = await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET });
    const ch = list.json.sessions.find((s) => s.surface === IDS.sfA1).choice;
    const post = (body) => call(b.socketPath, 'POST', '/cmux/choose', { secret: SECRET, body: { surface: IDS.sfA1, ...body } });
    const stale = await post({ choiceId: '0000000000000000', index: 0, label: 'Yes' });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.error, 'stale');
    assert.equal(stale.json.choice.choiceId, ch.choiceId);
    const wrong = await post({ choiceId: ch.choiceId, index: 0, label: 'No' });
    assert.equal(wrong.status, 409);
    assert.equal((await post({ choiceId: ch.choiceId, index: 'x', label: 'Yes' })).status, 400);
    assert.deepEqual(sent(), [], 'nothing typed on a refused pick');
    const ok = await post({ choiceId: ch.choiceId, index: 0, label: 'Yes' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(sent().map((a) => a[a.length - 1]), ['enter']);
  } finally { await b.stop(); }
});
