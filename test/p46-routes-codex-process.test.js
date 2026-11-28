'use strict';
// p46 C6 finding: a Codex pane started in cmux carries no hook event and no cwd, so the cwd/event join found
// nothing and the app showed "no thread". A Codex process keeps its rollout open (measured on Mac x:
// `lsof -p <pid>` lists ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), so the pane's own process names its
// rollout. These tests cover that join (procs.codexTranscriptOf, join via 'process') and the F1 case it closes:
// another Codex run in the same directory that is not a visible pane can no longer take a pane's thread.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const procs = require('../sessions/procs.js');
const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p46p-')));
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();
const line = (r) => JSON.stringify(r) + '\n';
const meta = (id, cwd) => ({ timestamp: ts(0), type: 'session_meta', payload: { id, session_id: id, cwd, cli_version: '0.0.0-test' } });
const item = (n, it) => ({ timestamp: ts(n), type: 'event_msg', payload: { type: 'item_completed', turn_id: 't-1', item: it } });
const user = (n, text) => item(n, { type: 'UserMessage', id: `u${n}`, content: [{ type: 'text', text, text_elements: [] }] });
const agent = (n, text) => item(n, { type: 'AgentMessage', id: `a${n}`, phase: 'final_answer', content: [{ type: 'Text', text }] });

const UUID = (n) => `01a222c${n}-ca6d-7fa1-8d87-af8367b2a2d8`;
function rollout(home, n, cwd) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '04');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `rollout-2026-11-04T10-0${n}-00-${UUID(n)}.jsonl`);
  fs.writeFileSync(p, [meta(UUID(n), cwd), user(1, `q-${n}`), agent(2, `a-${n}`)].map(line).join(''));
  return p;
}

test('codexTranscriptOf: the newest rollout under ~/.codex/sessions that the process holds; anything else is ignored', async () => {
  const home = '/home/example';
  const dir = `${home}/.codex/sessions/2026/11/04`;
  const open = [
    '/dev/null', `${dir}/rollout-2026-11-04T10-01-00-${UUID(1)}.jsonl`, `${dir}/rollout-2026-11-04T10-05-00-${UUID(5)}.jsonl`,
    '/tmp/rollout-2026-11-04T10-09-00-' + UUID(9) + '.jsonl',            // outside the root
    `${home}/.codex/sessions/../x/rollout-2026-11-04T10-08-00-${UUID(8)}.jsonl`,   // dot-dot
    `${dir}/history.jsonl`,                                              // not a rollout name
  ];
  const r = await procs.codexTranscriptOf(4242, { home, codexOpenFiles: async () => open });
  assert.equal(r.sessionId, UUID(5));
  assert.equal(r.transcriptPath, `${dir}/rollout-2026-11-04T10-05-00-${UUID(5)}.jsonl`);
  assert.equal(await procs.codexTranscriptOf(4242, { home, codexOpenFiles: async () => ['/dev/null'] }), null);
  // The wrapper's codex-kind descendants are asked in the same lsof call (the Rust binary holds the rollout).
  const W = '/lib/node_modules/@openai/codex';
  const table = procs.parsePs([' 1 0 /sbin/launchd', ` 10 1 node ${W}/bin/codex.js`, ` 11 10 ${W}/node_modules/@openai/codex-darwin-arm64/vendor/bin/codex`, ' 12 10 /bin/sh -c sleep 1'].join('\n'));
  let asked = null;
  await procs.codexTranscriptOf(10, { home, table, codexOpenFiles: async (pids) => { asked = pids; return []; } });
  assert.deepEqual(asked, [10, 11]);
  assert.equal(await procs.codexTranscriptOf(4242, { home, codexOpenFiles: async () => { throw new Error('lsof refused'); } }), null);
});

const get = (r, p) => new Promise((resolve) => {
  let code = 0;
  r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve({ code, json: JSON.parse(b) }) }, new URL('http://x' + p));
});
const texts = (j) => (j.messages || []).map((m) => m.text);
const threadOf = (sf) => `/cmux/sessions/${encodeURIComponent(`mini:${sf}`)}/thread`;

// Two tmux-hosted panes, each running `codex`; no hook events at all and no cwd for either.
function twoCodexPanes(home, held) {
  // Real shape (Codex 0.154 on Mac x): a node wrapper (the agent the pane runs) with the Rust binary under it,
  // and only the binary holds the rollout open. Pane A is the plain shape: the agent holds it itself.
  const W = '/lib/node_modules/@openai/codex';
  const table = procs.parsePs([' 1 0 /sbin/launchd', ' 100 1 -zsh', ` 101 100 node ${W}/bin/codex.js`, ` 102 101 ${W}/node_modules/@openai/codex-darwin-arm64/vendor/bin/codex`,
    ' 200 1 -zsh', ` 201 200 node ${W}/bin/codex.js`, ` 202 201 ${W}/node_modules/@openai/codex-darwin-arm64/vendor/bin/codex`].join('\n'));
  const mkSess = (name, sf, pid, pane) => ({ socket: '/s', name, attached: 1, epoch: 1, created: 1, surfaceId: sf, clientPids: [], panes: [{ id: pane, pid, active: true, cwd: '/w' }] });
  const snap = { table, sessions: [mkSess('a', 'surface:A', 100, '%1'), mkSess('b', 'surface:B', 200, '%2')] };
  return createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [
      { id: 'surface:A', ref: 'surface:1', title: 'a', type: 'terminal' },
      { id: 'surface:B', ref: 'surface:2', title: 'b', type: 'terminal' }] }],
    readEvents: async () => ({ events: [], more: false }), procSnapshot: async () => snap,
    codexOpenFiles: async (pids) => [].concat(pids).flatMap((p) => held[p] || []) });
}

test('process join: two Codex panes in one directory with no hook events each show their own rollout, and a third run that is not a pane takes neither', async () => {
  const home = mk();
  const a = rollout(home, 1, '/w');
  const b = rollout(home, 2, '/w');
  rollout(home, 9, '/w');   // newest rollout in the same cwd, held by no pane (Codex outside cmux, an exec run, an exited pane)
  const r = twoCodexPanes(home, { 102: [a], 202: [b] });
  const l = await get(r, '/cmux/sessions');
  assert.equal(l.code, 200);
  assert.deepEqual(l.json.sessions.map((s) => [s.surface, s.kind]).sort(), [['surface:A', 'codex'], ['surface:B', 'codex']]);
  const ta = await get(r, threadOf('surface:A'));
  const tb = await get(r, threadOf('surface:B'));
  assert.equal(ta.json.unsupported, undefined, JSON.stringify(ta.json));
  assert.equal(tb.json.unsupported, undefined, JSON.stringify(tb.json));
  assert.deepEqual(texts(ta.json), ['q-1', 'a-1']);
  assert.deepEqual(texts(tb.json), ['q-2', 'a-2']);
});

test('process join: a Codex pane whose process holds no rollout yet answers unsupported codex (no cwd guess, no wrong thread)', async () => {
  const home = mk();
  rollout(home, 9, '/w');
  const r = twoCodexPanes(home, {});
  await get(r, '/cmux/sessions');
  const t = await get(r, threadOf('surface:A'));
  assert.equal(t.json.unsupported, 'codex', JSON.stringify(t.json));
  assert.deepEqual(t.json.messages, []);
});
