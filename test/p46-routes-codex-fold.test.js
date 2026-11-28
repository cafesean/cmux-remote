'use strict';
// p46 C2 review fixes (in-process routes, the test/p41-d299-shared-cwd-join.test.js harness).
//   F2: a Codex cmux pane and its tmux orphan row are ONE session: they fold into one list row and are
//       not counted as two panes (so the pane is not marked codex-ambiguous for good).
//   F4: when the status tick sees a Codex pane's path change before the join watcher does, the stream
//       still emits exactly one `reset` before the new thread's rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p46f-')));
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();
const line = (r) => JSON.stringify(r) + '\n';
const meta = (id, cwd) => ({ timestamp: ts(0), type: 'session_meta', payload: { id, session_id: id, cwd, cli_version: '0.0.0-test' } });
const item = (n, it) => ({ timestamp: ts(n), type: 'event_msg', payload: { type: 'item_completed', turn_id: 't-1', item: it } });
const user = (n, text) => item(n, { type: 'UserMessage', id: `u${n}`, content: [{ type: 'text', text, text_elements: [] }] });
const agent = (n, text) => item(n, { type: 'AgentMessage', id: `a${n}`, phase: 'final_answer', content: [{ type: 'Text', text }] });

function rollout(home, id, cwd, n = 0) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '04');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `rollout-2026-11-04T10-0${n}-00-${id}.jsonl`);
  fs.writeFileSync(p, [meta(id, cwd), user(1, `q-${id}`), agent(2, `a-${id}`)].map(line).join(''));
  return p;
}
const cwdEv = (surfaceId, cwd) => ({ ts: Date.now() - 1000, event: 'Notification', surfaceId, cwd });
const pathEv = (surfaceId, sessionId, p, cwd) => ({ ts: Date.now(), sessionId, event: 'Stop', transcriptPath: p, surfaceId, cwd });
const snapWithOrphan = () => ({ table: [], sessions: [{ socket: '/s', name: 'x-orph', attached: 0, epoch: 1, created: 1, surfaceId: null, clientPids: [], panes: [{ id: '%7', pid: 5, active: true, cwd: '/w' }] }] });
const orphan = { id: 'surface:orphan', ref: '%7', title: 'x-orph', type: 'terminal', tmuxPane: '%7', tmuxSocket: '/s' };

const get = (r, p) => new Promise((resolve) => {
  let code = 0;
  r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve({ code, json: JSON.parse(b) }) }, new URL('http://x' + p));
});
const threadOf = (sf) => `/cmux/sessions/${encodeURIComponent(`mini:${sf}`)}/thread`;
const texts = (j) => (j.messages || []).map((m) => m.text);

test('F2: a Codex cmux pane + its tmux orphan fold to one row; the pane is not ambiguous and shows its thread', async () => {
  const home = mk();
  rollout(home, 'cxF', '/w');
  const events = [cwdEv('surface:A', '/w'), cwdEv('%7', '/w')];
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:A', ref: 'surface:1', title: 'a', type: 'terminal' }, orphan] }],
    readEvents: async () => ({ events, more: false }), procSnapshot: async () => snapWithOrphan() });
  const l = await get(r, '/cmux/sessions');
  assert.equal(l.code, 200);
  assert.deepEqual(l.json.sessions.map((s) => s.surface), ['surface:A'], JSON.stringify(l.json.sessions.map((s) => [s.surface, s.kind, s.aliases])));
  assert.equal(l.json.sessions[0].kind, 'codex');
  assert.deepEqual(l.json.sessions[0].aliases, ['mini:surface:orphan']);
  const t = await get(r, threadOf('surface:A'));
  assert.equal(t.json.unsupported, undefined, JSON.stringify(t.json));
  assert.deepEqual(texts(t.json), ['q-cxF', 'a-cxF']);
});

test('F2 control: two live cmux panes in one cwd (plus an orphan of one) are still ambiguous', async () => {
  const home = mk();
  rollout(home, 'cxG', '/w');
  const events = [cwdEv('surface:A', '/w'), cwdEv('surface:B', '/w'), cwdEv('%7', '/w')];
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [
      { id: 'surface:A', ref: 'surface:1', title: 'a', type: 'terminal' },
      { id: 'surface:B', ref: 'surface:2', title: 'b', type: 'terminal' }, orphan] }],
    readEvents: async () => ({ events, more: false }), procSnapshot: async () => snapWithOrphan() });
  await get(r, '/cmux/sessions');
  for (const sf of ['surface:A', 'surface:B']) {
    const t = await get(r, threadOf(sf));
    assert.equal(t.json.unsupported, 'codex-ambiguous', `${sf}: ${JSON.stringify(t.json)}`);
    assert.deepEqual(t.json.messages, []);
  }
});

test('F4: a path change seen by the status tick first gives one reset BEFORE the new thread\'s rows', async () => {
  const home = mk();
  const x = rollout(home, 'cxX', '/w', 0);
  const y = rollout(home, 'cxY', '/w', 1);
  const events = [pathEv('surface:A', 'cxX', x, '/w')];
  // statusPollMs 50 << joinPollMs 2000: the status tick reaches the new path before the join watcher does.
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0, joinPollMs: 2000, statusPollMs: 50,
    sseHead: (res) => res.writeHead(200, { 'content-type': 'text/event-stream' }),
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:A', ref: 'surface:1', title: 'a', type: 'terminal' }] }],
    readEvents: async () => ({ events: events.slice(), more: false }), procSnapshot: async () => ({ table: [], sessions: [] }) });
  await get(r, '/cmux/sessions');
  const frames = [];
  const handlers = {};
  const req = { method: 'GET', headers: {}, on: (ev, fn) => { handlers[ev] = fn; } };
  const res = { writeHead() {}, write: (s) => { const m = /^data: (.*)\n\n$/s.exec(s); if (m) frames.push(JSON.parse(m[1])); }, end() {}, on() {}, headersSent: true };
  r.handle(req, res, new URL(`http://x/cmux/sessions/${encodeURIComponent('mini:surface:A')}/thread-stream`));
  try {
    await new Promise((ok) => setTimeout(ok, 700));
    events.push(pathEv('surface:A', 'cxY', y, '/w'));   // the pane resumed another thread
    await new Promise((ok) => setTimeout(ok, 200));      // the status tick (50 ms) has moved; the join watcher (next poll up to 2 s away) has not
    fs.appendFileSync(y, line(agent(9, 'y-new')));
    const until = Date.now() + 6000;
    while (Date.now() < until && !(frames.some((f) => f.type === 'msg' && f.msg.text === 'y-new') && frames.some((f) => f.type === 'reset'))) await new Promise((ok) => setTimeout(ok, 50));
    await new Promise((ok) => setTimeout(ok, 2300));     // past a join watcher poll: it must not add a second reset
    const iReset = frames.findIndex((f) => f.type === 'reset');
    const iMsg = frames.findIndex((f) => f.type === 'msg' && f.msg.text === 'y-new');
    assert.ok(iReset >= 0 && iMsg >= 0, JSON.stringify(frames));
    assert.ok(iReset < iMsg, `reset must come before the new thread's rows: ${JSON.stringify(frames)}`);
    assert.equal(frames.filter((f) => f.type === 'reset').length, 1, JSON.stringify(frames));
    assert.ok(!frames.some((f) => f.type === 'unsupported'), JSON.stringify(frames));
  } finally { if (handlers.close) handlers.close(); }
});
