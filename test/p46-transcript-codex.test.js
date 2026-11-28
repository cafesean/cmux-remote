'use strict';
// p46 C1 — Codex rollout -> chat-thread messages. Rollouts are generated in a temp dir from the record
// shapes Codex writes; real rollouts are private and are never read or copied in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readThread, tailThread, BadCursorError, OUTPUT_MAX } = require('../sessions/transcript-codex.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p46-c1-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();
const line = (r) => JSON.stringify(r) + '\n';
const file = (name, rows) => {
  const p = path.join(tmp, `${++seq}-${name}.jsonl`);
  fs.writeFileSync(p, rows.map(line).join(''));
  return p;
};
const quiet = () => {};

const meta = (cwd = '/work/example-repo') => ({ timestamp: ts(0), type: 'session_meta', payload: { id: 's-1', session_id: 's-1', cwd, cli_version: '0.171.0' } });
const item = (n, it, kind = 'item_completed') => ({ timestamp: ts(n), type: 'event_msg', payload: { type: kind, turn_id: 't-1', item: it } });
const user = (n, text) => item(n, { type: 'UserMessage', id: `u${n}`, content: [{ type: 'text', text, text_elements: [] }] });
const agent = (n, text) => item(n, { type: 'AgentMessage', id: `a${n}`, phase: 'final_answer', content: [{ type: 'Text', text }] });
const cmd = (n, script, out, extra = {}) => item(n, { type: 'CommandExecution', id: `c${n}`, command: ['/bin/zsh', '-lc', script],
  status: 'completed', exit_code: 0, aggregated_output: out, stdout: out, stderr: '', ...extra });
const resp = (n, payload) => ({ timestamp: ts(n), type: 'response_item', payload });
const call = (n, id, name, args) => resp(n, { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const output = (n, id, out) => resp(n, { type: 'function_call_output', call_id: id, output: out });

test('UserMessage and AgentMessage become user and assistant; title is the cwd basename', async () => {
  const p = file('text', [
    meta(),
    resp(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello there' }] }),
    user(1, 'hello there'),
    resp(2, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi back' }] }),
    agent(2, 'hi back'),
  ]);
  const t = await readThread(p, { log: quiet });
  assert.strictEqual(t.title, 'example-repo');
  assert.deepStrictEqual(t.messages, [
    { id: 'u1', ts: T0 + 1000, kind: 'user', text: 'hello there' },
    { id: 'a2', ts: T0 + 2000, kind: 'assistant', text: 'hi back' },
  ]);
  assert.strictEqual(t.cursor, null);
});

test('CommandExecution is one shell Tool: target is the script, status from status/exit code, output cut', async () => {
  const long = 'x'.repeat(OUTPUT_MAX + 50);
  const p = file('cmd', [
    meta(), user(1, 'go'),
    cmd(2, 'ls -la\n  src', 'a\nb\nc'),
    cmd(3, 'false', 'boom', { status: 'failed', exit_code: 1 }),
    cmd(4, 'yes | head', long),
    item(5, { type: 'CommandExecution', id: 'c5', command: ['sleep', '9'], status: 'in_progress' }, 'item_started'),
  ]);
  const { messages } = await readThread(p, { log: quiet });
  assert.strictEqual(messages.length, 2);
  const g = messages[1];
  assert.strictEqual(g.kind, 'tools');
  assert.strictEqual(g.id, 'c2');
  assert.deepStrictEqual(g.items[0], { id: 'c2', name: 'shell', target: 'ls -la src', status: 'ok', lines: 3, output: 'a\nb\nc' });
  assert.strictEqual(g.items[1].status, 'error');
  assert.strictEqual(g.items[2].output.length, OUTPUT_MAX);
  assert.deepStrictEqual(g.items[3], { id: 'c5', name: 'shell', target: 'sleep 9', status: 'running' });
});

test('function_call and function_call_output pair by call_id; consecutive tools are one message', async () => {
  const p = file('pair', [
    meta(), user(1, 'go'),
    call(2, 'call_1', 'view_image', { path: 'img.png' }),
    call(3, 'call_2', 'js', { command: ['node', '-e', '1'] }),
    output(4, 'call_2', [{ type: 'input_text', text: 'two\nlines' }]),
    output(5, 'call_1', 'seen'),
    output(6, 'call_unknown', 'orphan'),
    agent(7, 'done'),
    call(8, 'call_3', 'js', { query: 'q' }),
  ]);
  const { messages } = await readThread(p, { log: quiet });
  assert.deepStrictEqual(messages.map((m) => m.kind), ['user', 'tools', 'assistant', 'tools']);
  assert.deepStrictEqual(messages[1].items, [
    { id: 'call_1', name: 'view_image', target: 'img.png', status: 'ok', lines: 1, output: 'seen' },
    { id: 'call_2', name: 'js', target: 'node -e 1', status: 'ok', lines: 2, output: 'two\nlines' },
  ]);
  assert.deepStrictEqual(messages[3].items, [{ id: 'call_3', name: 'js', target: 'q', status: 'running' }]);
});

test('reasoning and encrypted_content are never emitted', async () => {
  const p = file('reason', [
    meta(), user(1, 'go'),
    resp(2, { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'SECRET-REASONING' }),
    item(2, { type: 'Reasoning', id: 'r2', summary_text: ['SECRET-SUMMARY'], raw_content: [] }),
    agent(3, 'answer'),
  ]);
  const t = await readThread(p, { log: quiet });
  assert.deepStrictEqual(t.messages.map((m) => m.kind), ['user', 'assistant']);
  assert.ok(!JSON.stringify(t).includes('SECRET'));
  assert.deepStrictEqual(t.skipped, {});
});

test('an unknown record type is skipped, counted and warned once per process', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const rows = [meta(), user(1, 'go'),
    { timestamp: ts(2), type: 'p46_test_future_record', payload: { text: 'private words' } },
    { timestamp: ts(3), type: 'p46_test_future_record', payload: {} },
    item(4, { type: 'P46TestFutureItem', id: 'f4', text: 'private words' }),
    agent(5, 'ok')];
  const p = file('unknown', rows);
  const t = await readThread(p, { log });
  assert.deepStrictEqual(t.messages.map((m) => m.kind), ['user', 'assistant']);
  assert.deepStrictEqual(t.skipped, { 'record:p46_test_future_record': 2, 'item:P46TestFutureItem': 1 });
  await readThread(p, { log });
  assert.strictEqual(logs.length, 2, 'one warn line per type, not per record or per read');
  assert.ok(logs.some((l) => l.includes('p46_test_future_record')));
  assert.ok(!logs.join('\n').includes('private'), 'warn carries the type name only');
});

test('cursor pages back to older messages; a bad cursor throws bad_cursor', async () => {
  const rows = [meta()];
  for (let i = 1; i <= 30; i++) rows.push(i % 2 ? user(i, `q${i}`) : agent(i, `a${i}`));
  const p = file('page', rows);
  const first = await readThread(p, { limit: 10, chunkSize: 512, log: quiet });
  assert.deepStrictEqual(first.messages.map((m) => m.text), Array.from({ length: 10 }, (_, k) => (21 + k) % 2 ? `q${21 + k}` : `a${21 + k}`));
  assert.ok(first.cursor);
  assert.strictEqual(first.title, 'example-repo', 'title from the head when the page did not reach session_meta');
  const second = await readThread(p, { before: first.cursor, limit: 10, chunkSize: 512, log: quiet });
  assert.deepStrictEqual(second.messages.map((m) => m.id)[0], 'u11');
  assert.deepStrictEqual(second.messages.map((m) => m.id).slice(-1), ['a20']);
  const third = await readThread(p, { before: second.cursor, limit: 10, chunkSize: 512, log: quiet });
  assert.strictEqual(third.messages[0].id, 'u1');
  assert.strictEqual(third.cursor, null);
  await assert.rejects(readThread(p, { before: 'not a cursor!', log: quiet }), (e) => e instanceof BadCursorError && e.code === 'bad_cursor');
  const forged = Buffer.from('u11|7').toString('base64url');
  await assert.rejects(readThread(p, { before: forged, log: quiet }), BadCursorError);
});

test('tailThread reads a second appended turn without a reset (offset model)', async () => {
  const p = file('tail', [meta(), user(1, 'turn one'), agent(2, 'reply one')]);
  const t = await readThread(p, { log: quiet });
  assert.strictEqual(t.endOffset, fs.statSync(p).size);
  const ac = new AbortController();
  let resets = 0;
  const got = [];
  const it = tailThread(p, t.endOffset, { signal: ac.signal, pollMs: 20, onReset: () => resets++, log: quiet });
  const reader = (async () => {
    for await (const m of it) { got.push(m); if (got.length >= 4) ac.abort(); }
  })();
  // Turn two arrives in pieces, the way Codex appends while it runs; the last line lands in two writes.
  fs.appendFileSync(p, line(user(3, 'turn two')));
  fs.appendFileSync(p, line(call(4, 'call_t', 'js', { command: 'echo hi' })));
  await new Promise((r) => setTimeout(r, 60));
  const out = line(output(5, 'call_t', 'hi'));
  fs.appendFileSync(p, out.slice(0, 10));
  await new Promise((r) => setTimeout(r, 60));
  fs.appendFileSync(p, out.slice(10) + line(agent(6, 'reply two')));
  await Promise.race([reader, new Promise((_, rej) => setTimeout(() => rej(new Error('tail timed out')), 3000))]);
  assert.strictEqual(resets, 0);
  assert.deepStrictEqual(got.map((m) => [m.kind, m.id]), [['user', 'u3'], ['tools', 'call_t'], ['tools', 'call_t'], ['assistant', 'a6']]);
  assert.strictEqual(got[1].items[0].status, 'running');
  assert.deepStrictEqual(got[2].items[0], { id: 'call_t', name: 'js', target: 'echo hi', status: 'ok', lines: 1, output: 'hi' });
});

test('C5: thread-codex.json is exactly what the normaliser makes of the anonymised rollout fixture', async () => {
  const dir = path.join(__dirname, 'fixtures');
  const t = await readThread(path.join(dir, 'p46', 'codex-rollout.jsonl'), { log: quiet });
  const want = JSON.parse(fs.readFileSync(path.join(dir, 'p41', 'thread-codex.json'), 'utf8'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t)), want);
  const raw = fs.readFileSync(path.join(dir, 'p46', 'codex-rollout.jsonl'), 'utf8');
  assert.ok(!/\/Users\/[a-z]/i.test(raw), 'no real home path');
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(raw), 'no email address');
});
