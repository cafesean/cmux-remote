'use strict';
// p41 A2 — Claude transcript -> chat-thread messages. Transcripts are generated in a temp dir; the real
// ones are private and are never copied in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readThread, tailThread, readAttachment, BadCursorError } = require('../sessions/transcript-claude.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-a2-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const ts = (n) => new Date(T0 + n * 1000).toISOString();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = (name, rows) => {
  const p = path.join(tmp, `${++seq}-${name}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return p;
};
const user = (n, content, extra) => ({ type: 'user', uuid: uid(n), timestamp: ts(n), message: { role: 'user', content }, ...extra });
const asst = (n, content, id) => ({ type: 'assistant', uuid: uid(n), timestamp: ts(n),
  message: { id: id || `msg_${n}`, role: 'assistant', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] } });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content, isError) => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

test('pairs tool_use and tool_result', async () => {
  const p = file('pair', [
    user(1, 'go'),
    asst(2, [use('tu1', 'Read', { file_path: '/a/b/c.js' })]),
    user(3, [result('tu1', 'one\ntwo\nthree')]),
    asst(4, [use('tu2', 'Bash', { command: 'false', description: 'fail' })]),
    user(5, [result('tu2', 'boom', true)]),
    asst(6, [use('tu3', 'Bash', { command: 'sleep 9' })]),
  ]);
  const { messages } = await readThread(p);
  const items = messages.find((m) => m.kind === 'tools').items;
  assert.deepStrictEqual(items[0], { id: 'tu1', name: 'Read', target: '/a/b/c.js', status: 'ok', lines: 3, output: 'one\ntwo\nthree' });
  assert.strictEqual(items[1].status, 'error');
  assert.strictEqual(items[1].target, 'false');
  assert.strictEqual(items[2].status, 'running');
  assert.strictEqual(items[2].output, undefined);
});

test('tool output is cut to 2000 chars and array results are joined', async () => {
  const p = file('cut', [
    asst(1, [use('t', 'Bash', { command: 'x' })]),
    user(2, [result('t', [{ type: 'text', text: 'a'.repeat(3000) }, { type: 'text', text: 'b' }])]),
  ]);
  const { messages } = await readThread(p);
  assert.strictEqual(messages[0].items[0].output.length, 2000);
});

test('groups consecutive tools into one message, a text message splits them', async () => {
  const p = file('group', [
    asst(1, [use('a', 'Read', { file_path: 'x' })], 'm1'),
    asst(2, [use('b', 'Grep', { pattern: 'foo', path: 'src/' })], 'm1'),
    user(3, [result('a', 'x'), result('b', 'y')]),
    asst(4, 'between'),
    asst(5, [use('c', 'Read', { file_path: 'z' })]),
  ]);
  const { messages } = await readThread(p);
  assert.deepStrictEqual(messages.map((m) => m.kind), ['tools', 'assistant', 'tools']);
  assert.deepStrictEqual(messages[0].items.map((i) => i.id), ['a', 'b']);
  assert.strictEqual(messages[0].items[1].target, 'foo src/');
  assert.strictEqual(messages[2].items.length, 1);
});

test('thinking rows and tool_result rows do not split a group', async () => {
  const p = file('thinking', [
    asst(1, [use('a', 'Read', { file_path: 'x' })], 'm1'),
    user(2, [result('a', 'x')]),
    asst(3, [{ type: 'thinking', thinking: 'hmm' }], 'm2'),
    asst(4, [use('b', 'Read', { file_path: 'y' })], 'm2'),
  ]);
  const { messages } = await readThread(p);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].items.length, 2);
});

test('skips meta and system-tag user rows', async () => {
  const p = file('skip', [
    user(1, 'meta text', { isMeta: true }),
    user(2, '<command-name>/clear</command-name>'),
    user(3, [{ type: 'text', text: 'Base directory for this skill: /x' }]),
    user(4, [{ type: 'text', text: '<system-reminder>x</system-reminder>' }]),
    user(5, 'side', { isSidechain: true }),
    user(6, '  hello there  '),
    asst(7, '   '),
    asst(8, 'hi'),
  ]);
  const { messages } = await readThread(p);
  assert.deepStrictEqual(messages.map((m) => [m.kind, m.text]), [['user', 'hello there'], ['assistant', 'hi']]);
  assert.strictEqual(messages[0].ts, T0 + 6000);
});

test('title from last custom-title', async () => {
  const p = file('title', [
    { type: 'custom-title', customTitle: 'first' }, user(1, 'a'),
    { type: 'custom-title', customTitle: 'second' }, asst(2, 'b'),
  ]);
  assert.strictEqual((await readThread(p)).title, 'second');
});

test('AskUserQuestion becomes question with options', async () => {
  const p = file('ask', [asst(1, [use('q', 'AskUserQuestion', { questions: [
    { header: 'Cursor', question: 'How to page?', multiSelect: true,
      options: [{ label: 'Id', description: 'oldest id' }, { label: 'Offset', description: 'file offset' }] },
  ] })])]);
  const { messages } = await readThread(p);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].kind, 'question');
  assert.deepStrictEqual(messages[0].question, { header: 'Cursor', text: 'How to page?', multi: true,
    options: [{ label: 'Id', description: 'oldest id' }, { label: 'Offset', description: 'file offset' }] });
});

test('TodoWrite becomes todo', async () => {
  const p = file('todo', [asst(1, [use('t', 'TodoWrite', { todos: [
    { content: 'one', status: 'completed', activeForm: 'Doing one' },
    { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
  ] })])]);
  const { messages } = await readThread(p);
  assert.strictEqual(messages[0].kind, 'todo');
  assert.deepStrictEqual(messages[0].todos, [{ text: 'one', done: true }, { text: 'two', done: false }]);
});

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const img = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });

test('image becomes attachment with a numbered url, and the bytes can be read back', async () => {
  const p = file('img', [
    user(1, [{ type: 'text', text: 'first' }, img()]),
    asst(2, 'ok'),
    user(3, [img(), { type: 'text', text: 'second' }]),
  ]);
  const { messages } = await readThread(p, { sessionId: 'mini:surface:12' });
  const atts = messages.filter((m) => m.kind === 'attachment');
  assert.deepStrictEqual(atts.map((m) => m.attachment.url),
    ['/api/sessions/mini%3Asurface%3A12/attachment/0', '/api/sessions/mini%3Asurface%3A12/attachment/1']);
  assert.strictEqual(atts[0].attachment.mime, 'image/png');
  assert.match(atts[0].attachment.name, /\.png$/);
  const a1 = await readAttachment(p, 1);
  assert.strictEqual(a1.mime, 'image/png');
  assert.ok(a1.data.equals(PNG));
  assert.strictEqual(await readAttachment(p, 2), null);
});

test('attachment numbers stay global when the page starts after earlier images', async () => {
  const rows = [user(1, [img()])];
  for (let i = 2; i < 10; i++) rows.push(asst(i, `m${i}`));
  rows.push(user(20, [img()]));
  const p = file('imgpage', rows);
  const { messages } = await readThread(p, { sessionId: 's', limit: 3 });
  assert.strictEqual(messages.length, 3);
  assert.strictEqual(messages.find((m) => m.kind === 'attachment').attachment.url, '/api/sessions/s/attachment/1');
});

test('malformed trailing line is skipped', async () => {
  const p = file('torn', [user(1, 'a'), asst(2, 'b'), '{"type":"assistant","uuid":"x","message":{"cont']);
  const { messages } = await readThread(p);
  assert.deepStrictEqual(messages.map((m) => m.text), ['a', 'b']);
});

test('message ids are stable across reads and distinct', async () => {
  const p = file('ids', [user(1, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), asst(2, 'c')]);
  const a = await readThread(p);
  const b = await readThread(p);
  assert.deepStrictEqual(a.messages.map((m) => m.id), b.messages.map((m) => m.id));
  assert.strictEqual(new Set(a.messages.map((m) => m.id)).size, 3);
});

const BANNER = ['████████████████', '██  NEEDS YOU', '██  1. Pick the tunnel', '██  2. Approve the push', '████████████████'];

test('banner rows become a needs-you callout (bannerPreset)', async () => {
  const p = file('banner', [asst(1, ['Intro line', ...BANNER, 'After'].join('\n'))]);
  const { messages } = await readThread(p);
  assert.deepStrictEqual(messages.map((m) => m.kind), ['assistant', 'callout']);
  assert.strictEqual(messages[0].text, 'Intro line\nAfter');
  assert.deepStrictEqual(messages[1].callout, { type: 'needs-you', title: 'Needs you', body: 'Pick the tunnel\nApprove the push', options: [] });
});

test('bannerPreset false leaves the text unchanged', async () => {
  const text = ['Intro', ...BANNER].join('\n');
  const p = file('nobanner', [asst(1, text)]);
  const { messages } = await readThread(p, { bannerPreset: false });
  assert.deepStrictEqual(messages.map((m) => m.kind), ['assistant']);
  assert.strictEqual(messages[0].text, text);
});

test('a banner with no numbered asks is not a callout', async () => {
  const p = file('bar', [asst(1, ['x', '████', 'y'].join('\n'))]);
  const { messages } = await readThread(p);
  assert.deepStrictEqual(messages.map((m) => m.kind), ['assistant']);
});

test('pages with a cursor: oldest message id, null at the start', async () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(i % 2 ? user(i, `u${i}`) : asst(i, `a${i}`));
  const p = file('pages', rows);
  const p1 = await readThread(p, { limit: 4 });
  assert.deepStrictEqual(p1.messages.map((m) => m.text), ['u7', 'a8', 'u9', 'a10']);
  assert.strictEqual(typeof p1.cursor, 'string');
  assert.notStrictEqual(p1.cursor, p1.messages[0].id);
  const p2 = await readThread(p, { limit: 4, before: p1.cursor });
  assert.deepStrictEqual(p2.messages.map((m) => m.text), ['u3', 'a4', 'u5', 'a6']);
  const p3 = await readThread(p, { limit: 4, before: p2.cursor });
  assert.deepStrictEqual(p3.messages.map((m) => m.text), ['u1', 'a2']);
  assert.strictEqual(p3.cursor, null);
  const all = await readThread(p, { limit: 80 });
  assert.strictEqual(all.messages.length, 10);
  assert.strictEqual(all.cursor, null);
});

test('paging through a small chunk size never splits or repeats a tools group', async () => {
  const rows = [];
  let n = 0;
  for (let i = 0; i < 12; i++) {
    rows.push(user(++n, `q${i}`));
    rows.push(asst(++n, [use(`t${i}a`, 'Read', { file_path: 'f' + 'x'.repeat(200) })], `m${i}`));
    rows.push(asst(++n, [use(`t${i}b`, 'Read', { file_path: 'g' + 'x'.repeat(200) })], `m${i}`));
    rows.push(user(++n, [result(`t${i}a`, 'o'), result(`t${i}b`, 'o')]));
    rows.push(asst(++n, `a${i}`));
  }
  const p = file('bigpages', rows);
  const full = await readThread(p, { limit: 500 });
  const seen = [];
  let before;
  for (let guard = 0; guard < 50; guard++) {
    const page = await readThread(p, { limit: 5, before, chunkSize: 512 });
    seen.unshift(...page.messages);
    if (!page.cursor) break;
    before = page.cursor;
  }
  assert.deepStrictEqual(seen.map((m) => m.id), full.messages.map((m) => m.id));
  assert.deepStrictEqual(seen, full.messages);
  assert.ok(seen.filter((m) => m.kind === 'tools').every((m) => m.items.length === 2 && m.items.every((i) => i.status === 'ok')));
});

test('older page keeps sibling blocks of the cursor record', async () => {
  const p = file('siblings', [
    asst(1, 'q1'),
    asst(2, 'q2'),
    user(3, [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'text', text: 'C' }]),
    asst(4, ['text', ...BANNER].join('\n')),
  ]);
  const p1 = await readThread(p, { limit: 2 });
  assert.deepStrictEqual(p1.messages.map((m) => m.kind), ['assistant', 'callout']);
  const p2 = await readThread(p, { limit: 2, before: p1.cursor });
  assert.deepStrictEqual(p2.messages.map((m) => m.text), ['B', 'C']);
  const p3 = await readThread(p, { limit: 2, before: p2.cursor });
  assert.deepStrictEqual(p3.messages.map((m) => m.text), ['q2', 'A']);
  const p4 = await readThread(p, { limit: 2, before: p3.cursor });
  assert.deepStrictEqual(p4.messages.map((m) => m.text), ['q1']);
  assert.strictEqual(p4.cursor, null);
});

test('bogus cursor -> bad_cursor', async () => {
  const p = file('badcursor', [user(1, 'a'), asst(2, 'b')]);
  const ok = Buffer.from(`${uid(2)}:0|${0}`).toString('base64url');
  for (const before of ['nope:0', '', '%%%', 'bm9wZQ', Buffer.from('x|abc').toString('base64url'),
    Buffer.from(`${uid(1)}:0|999999`).toString('base64url'),   // past the end
    Buffer.from(`${uid(1)}:0|5`).toString('base64url'),        // not at a line start
    Buffer.from(`${uid(2)}:0|0`).toString('base64url'),        // line start, other record
    ok]) {
    await assert.rejects(readThread(p, { before }), (e) => e instanceof BadCursorError && e.code === 'bad_cursor' && e.status === 400, JSON.stringify(before));
  }
});

test('empty and missing files', async () => {
  const e = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(e, '');
  assert.deepStrictEqual(await readThread(e), { title: '', messages: [], cursor: null });
  await assert.rejects(readThread(path.join(tmp, 'nope.jsonl')), { code: 'ENOENT' });
});

test('pages backwards with cursor and never reads whole file (60 MB, bytes read < 2 MB; cold cursor < 2 MB)', async () => {
  const p = path.join(tmp, 'big.jsonl');
  const fd = fs.openSync(p, 'w');
  const filler = 'x'.repeat(2000);
  fs.writeSync(fd, JSON.stringify({ type: 'custom-title', customTitle: 'Big one' }) + '\n');
  let size = 0;
  let n = 0;
  while (size < 60 * 1024 * 1024) {
    const rows = [];
    for (let i = 0; i < 200; i++) {
      n++;
      rows.push(JSON.stringify(n % 2 ? user(n, `question ${n} ${filler}`) : asst(n, `answer ${n} ${filler}`)));
    }
    const chunk = rows.join('\n') + '\n';
    fs.writeSync(fd, chunk);
    size += chunk.length;
  }
  fs.closeSync(fd);
  assert.ok(fs.statSync(p).size >= 60 * 1024 * 1024);

  let bytes = 0;
  const counting = { open: async (...a) => {
    const h = await fs.promises.open(...a);
    const read = h.read.bind(h);
    h.read = async (...r) => { const out = await read(...r); bytes += out.bytesRead; return out; };
    return h;
  } };
  const page = await readThread(p, { fs: counting });
  assert.strictEqual(page.messages.length, 80);
  assert.strictEqual(page.title, 'Big one');
  assert.ok(page.cursor);
  assert.ok(bytes < 2 * 1024 * 1024, `read ${bytes} bytes`);
  assert.match(page.messages[79].text, new RegExp(`^(question|answer) ${n} `));

  bytes = 0;
  const older = await readThread(p, { fs: counting, before: page.cursor });
  assert.strictEqual(older.messages.length, 80);
  assert.ok(bytes < 2 * 1024 * 1024, `read ${bytes} bytes for the second page`);
  assert.match(older.messages[79].text, new RegExp(`^(question|answer) ${n - 80} `));
  assert.ok(older.cursor);

  // A cold cursor (a fresh process, a bogus or evicted one) is just as cheap: it names its own offset.
  bytes = 0;
  const bogus = await readThread(p, { fs: counting, before: Buffer.from('nope:0|12345678').toString('base64url') }).catch((e) => e);
  assert.ok(bogus instanceof BadCursorError);
  assert.ok(bytes < 2 * 1024 * 1024, `read ${bytes} bytes for a bogus cursor`);
  bytes = 0;
  const cold = await readThread(p, { fs: counting, before: older.cursor });
  assert.strictEqual(cold.messages.length, 80);
  assert.ok(bytes < 2 * 1024 * 1024, `read ${bytes} bytes for a cold cursor`);
});

const nextTick = (ms) => new Promise((r) => setTimeout(r, ms));
function take(it, n, ms = 4000) {
  const out = [];
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tail timeout')), ms); });
  const run = (async () => {
    for await (const m of it) { out.push(m); if (out.length >= n) break; }
    return out;
  })();
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

test('tailThread yields new messages as the file grows, running tool becomes ok under the same id', async () => {
  const p = file('tail', [user(1, 'before')]);
  const start = fs.statSync(p).size;
  const ac = new AbortController();
  const it = tailThread(p, start, { signal: ac.signal, pollMs: 50 });
  const got = take(it, 3);
  await nextTick(100);
  fs.appendFileSync(p, JSON.stringify(asst(2, [use('tu', 'Bash', { command: 'ls' })])) + '\n');
  await nextTick(100);
  fs.appendFileSync(p, JSON.stringify(user(3, [result('tu', 'a\nb')])) + '\n');
  await nextTick(100);
  // a half-written line is not consumed until it is finished
  const line = JSON.stringify(asst(4, 'done'));
  fs.appendFileSync(p, line.slice(0, 20));
  await nextTick(150);
  fs.appendFileSync(p, line.slice(20) + '\n');
  const msgs = await got;
  ac.abort();
  assert.deepStrictEqual(msgs.map((m) => m.kind), ['tools', 'tools', 'assistant']);
  assert.strictEqual(msgs[0].id, msgs[1].id);
  assert.strictEqual(msgs[0].items[0].status, 'running');
  assert.strictEqual(msgs[1].items[0].status, 'ok');
  assert.strictEqual(msgs[1].items[0].lines, 2);
  assert.strictEqual(msgs[2].text, 'done');
});

test('tailThread pairs a result with a tool_use that is before fromOffset', async () => {
  const p = file('tailwarm', [asst(1, [use('tu', 'Bash', { command: 'ls' })])]);
  const start = fs.statSync(p).size;
  const ac = new AbortController();
  const got = take(tailThread(p, start, { signal: ac.signal, pollMs: 50 }), 1);
  await nextTick(100);
  fs.appendFileSync(p, JSON.stringify(user(2, [result('tu', 'x')])) + '\n');
  const [m] = await got;
  ac.abort();
  assert.strictEqual(m.items[0].status, 'ok');
});

test('tailThread resets on truncation and says so', async () => {
  const p = file('tailreset', [user(1, 'old one'), user(2, 'old two')]);
  const start = fs.statSync(p).size;
  const ac = new AbortController();
  let resets = 0;
  const got = take(tailThread(p, start, { signal: ac.signal, pollMs: 50, onReset: () => { resets++; } }), 1);
  await nextTick(100);
  fs.writeFileSync(p, JSON.stringify(user(9, 'fresh')) + '\n');
  const [m] = await got;
  ac.abort();
  assert.strictEqual(resets, 1);
  assert.strictEqual(m.text, 'fresh');
});

test('tailThread stops when the signal aborts', async () => {
  const p = file('tailabort', [user(1, 'a')]);
  const ac = new AbortController();
  const it = tailThread(p, fs.statSync(p).size, { signal: ac.signal, pollMs: 50 });
  const done = (async () => { for await (const _ of it) { /* none expected */ } return 'ended'; })();
  await nextTick(100);
  ac.abort();
  assert.strictEqual(await done, 'ended');
});
