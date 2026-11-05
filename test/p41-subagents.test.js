'use strict';
// p41 A10 — the sub-agent routes on a REAL bridge.js child (the test/p19-bridge-socket.test.js
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p41sa-')));
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
const call0 = (b, p) => call(b.socketPath, 'GET', p, { secret: SECRET });
const AID_RUN = 'a1111111111111111';
const AID_DONE = 'adeploy-test-2de020c0d2623678';
const sub = (n, agentId, rec) => ({ ...rec, isSidechain: true, agentId });
const toolUse = (n, id, name, input) => ({ type: 'assistant', uuid: uid(n), timestamp: iso(n), message: { id: `msg_${n}`, role: 'assistant',
  model: 'claude-opus-4-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
const toolRes = (n, id, text, extra) => ({ type: 'user', uuid: uid(n), timestamp: iso(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...(extra || {}) });

// sess-a with two Agent calls; its dir holds two sub-agents: one done (finished meta), one running (fresh, tool pending).
function subHome() {
  const x = home([user(1, 'go'), toolUse(2, 'toolu_run', 'Agent', { description: 'Run it' }), toolUse(3, 'toolu_done', 'Agent', { description: 'Deploy' }),
    toolRes(4, 'toolu_done', 'deployed', { toolUseResult: { agentId: AID_DONE } }), asst(5, 'ok')]);
  const sd = path.join(x.dir, 'sess-a', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  const w = (aid, rows, meta) => {
    fs.writeFileSync(path.join(sd, `agent-${aid}.jsonl`), jsonl(rows.map((r) => sub(0, aid, r))));
    fs.writeFileSync(path.join(sd, `agent-${aid}.meta.json`), JSON.stringify(meta));
  };
  w(AID_DONE, [user(20, 'deploy please'), asst(21, 'Deployed to dev.')], { agentType: 'general-purpose', description: 'Deploy', toolUseId: 'toolu_done', model: 'sonnet', finished: true });
  w(AID_RUN, [user(30, 'run it'), asst(31, 'Working on it.'), toolUse(32, 'toolu_sub1', 'Bash', { command: 'ls' })], { agentType: 'Explore', description: 'Run it', toolUseId: 'toolu_run', model: 'haiku' });
  return { ...x, sd };
}

test('subagents: list, session counts, Agent rows carry agentId', async () => {
  const { h } = subHome();
  const b = await boot(h);
  try {
    const r = await call0(b, `/cmux/sessions/${idOf(IDS.sfA1)}/subagents`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 2);
    const by = Object.fromEntries(r.json.subagents.map((s) => [s.agentId, s]));
    assert.equal(by[AID_DONE].status, 'done');
    assert.equal(by[AID_RUN].status, 'running');
    assert.equal(by[AID_RUN].description, 'Run it');
    assert.equal(by[AID_RUN].agentType, 'Explore');
    assert.equal(by[AID_RUN].model, 'haiku');
    assert.equal(by[AID_RUN].toolUseId, 'toolu_run');
    assert.equal(by[AID_DONE].preview, 'Deployed to dev.');
    assert.equal(r.json.subagents[0].agentId, AID_RUN, 'newest first');
    for (const s of r.json.subagents) { assert.equal(typeof s.startedAt, 'number'); assert.equal(typeof s.lastActivity, 'number'); }
    const l = await call0(b, '/cmux/sessions');
    const a1 = l.json.sessions.find((s) => s.surface === IDS.sfA1);
    assert.deepEqual(a1.subagents, { running: 1, total: 2 });
    const t = await call0(b, `/cmux/sessions/${idOf(IDS.sfA1)}/thread`);
    const tools = t.json.messages.filter((m) => m.kind === 'tools').flatMap((m) => m.items);
    assert.equal(tools.find((x) => x.id === 'toolu_run').agentId, AID_RUN, 'via meta toolUseId');
    assert.equal(tools.find((x) => x.id === 'toolu_done').agentId, AID_DONE);
  } finally { await b.stop(); }
});

test('subagents: thread page with cursor, and stream appends', async () => {
  const { h, sd } = subHome();
  const b = await boot(h);
  try {
    const base = `/cmux/sessions/${idOf(IDS.sfA1)}/subagents/${AID_RUN}`;
    const p1 = await call0(b, `${base}/thread?limit=2`);
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p1.json.title, 'Run it');
    assert.deepEqual(p1.json.messages.map((m) => m.kind), ['assistant', 'tools']);
    assert.ok(p1.json.cursor);
    const p2 = await call0(b, `${base}/thread?limit=2&before=${encodeURIComponent(p1.json.cursor)}`);
    assert.equal(p2.status, 200, p2.text);
    assert.deepEqual(p2.json.messages.map((m) => m.text), ['run it']);
    assert.equal(p2.json.cursor, null);
    const s = sse(b.socketPath, `${base}/thread-stream`);
    try {
      await s.opened;
      await new Promise((r) => setTimeout(r, 300));
      fs.appendFileSync(path.join(sd, `agent-${AID_RUN}.jsonl`), jsonl([sub(0, AID_RUN, asst(40, 'fresh line'))]));
      const f = await s.waitFor((x) => x.type === 'msg' && x.msg.text === 'fresh line');
      assert.equal(f.agentId, AID_RUN);
      assert.equal(f.session, `${MACHINE}:${IDS.sfA1}`);
    } finally { s.close(); }
  } finally { await b.stop(); }
});

test('subagents: traversal, bad ids and symlinks out are refused', async () => {
  const { h, sd } = subHome();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'agent-asecret0000000000.jsonl'), jsonl([asst(50, 'SECRET')]));
  fs.symlinkSync(path.join(outside, 'agent-asecret0000000000.jsonl'), path.join(sd, 'agent-asymlink000000000.jsonl'));
  const b = await boot(h);
  try {
    const pre = `/cmux/sessions/${idOf(IDS.sfA1)}/subagents`;
    for (const bad of ['..%2F..%2Fsess-a', 'a..%2Fx', 'notanid', 'a1', '%2Fetc%2Fpasswd', 'a1111111.jsonl']) {
      const r = await call0(b, `${pre}/${bad}/thread`);
      assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
      assert.ok(!r.text.includes('SECRET'));
    }
    const sl = await call0(b, `${pre}/asymlink000000000/thread`);
    assert.equal(sl.status, 404, 'symlinked sub-agent file not served');
    assert.ok(!sl.text.includes('SECRET'));
    const st = await call0(b, `${pre}/asymlink000000000/thread-stream`);
    assert.equal(st.status, 404);
    const miss = await call0(b, `${pre}/a2222222222222222/thread`);
    assert.equal(miss.status, 404);
    const l = await call0(b, pre);
    assert.equal(l.json.total, 2, 'symlink not listed');
    const denied = await call(b.socketPath, 'GET', pre);
    assert.equal(denied.status, 403);
  } finally { await b.stop(); }
});

test('subagents: a symlinked subagents dir pointing out is refused', async () => {
  const { h, dir } = home([user(1, 'go'), asst(2, 'ok')]);
  const outside = tmp();
  fs.mkdirSync(path.join(outside, 'subagents'));
  fs.writeFileSync(path.join(outside, 'subagents', 'agent-a3333333333333333.jsonl'), jsonl([asst(60, 'SECRET')]));
  fs.symlinkSync(outside, path.join(dir, 'sess-a'));
  const b = await boot(h);
  try {
    const r = await call0(b, `/cmux/sessions/${idOf(IDS.sfA1)}/subagents/a3333333333333333/thread`);
    assert.equal(r.status, 404);
    const l = await call0(b, `/cmux/sessions/${idOf(IDS.sfA1)}/subagents`);
    assert.equal(l.json.total, 0);
  } finally { await b.stop(); }
});
