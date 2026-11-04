'use strict';
// p41 wire contract. The native app, the server and the bridge routes all speak these shapes, so the
// fixtures under test/fixtures/p41 are the shared truth: if a shape changes, this test and
// sessions/CONTRACT.md change with it. Validation uses the repo's own schema-lite (no dependencies).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { validate } = require('../radar/schema-lite.js');

const DIR = path.join(__dirname, 'fixtures', 'p41');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const readNdjson = (name) => fs.readFileSync(path.join(DIR, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const KINDS = ['claude', 'codex', 'terminal', 'browser'];
const STATUSES = ['needs-you', 'working', 'finished', 'idle', 'your-turn'];
const MSG_KINDS = ['user', 'assistant', 'tools', 'callout', 'question', 'todo', 'attachment'];

const str = { type: 'string' };
const num = { type: 'number' };

const Session = {
  type: 'object',
  required: ['id', 'machine', 'workspace', 'surface', 'kind', 'title', 'status', 'preview', 'lastActivity'],
  properties: {
    id: { type: 'string', pattern: '^[^:]+:.+$' },     // "<machine>:<surfaceId>"
    machine: str, workspace: str, surface: str,
    kind: { enum: KINDS },
    title: str,
    status: { enum: STATUSES },
    preview: str,
    lastActivity: num,
    model: str,
    contextPct: { type: 'number', minimum: 0, maximum: 100 },
  },
};

const Tool = {
  type: 'object',
  required: ['id', 'name', 'target', 'status'],
  properties: {
    id: str, name: str, target: str,
    status: { enum: ['running', 'ok', 'error'] },
    lines: { type: 'integer', minimum: 0 },
    output: str,
  },
};

const msgOf = (kind, extraRequired, extraProps) => ({
  type: 'object',
  required: ['id', 'ts', 'kind', ...extraRequired],
  properties: { id: str, ts: num, kind: { const: kind }, ...extraProps },
});

const Msg = {
  oneOf: [
    msgOf('user', ['text'], { text: str }),
    msgOf('assistant', ['text'], { text: str }),
    msgOf('tools', ['items'], { items: { type: 'array', minItems: 1, items: Tool } }),
    msgOf('callout', ['callout'], {
      callout: {
        type: 'object', required: ['type', 'title', 'body', 'options'],
        properties: { type: str, title: str, body: str, options: { type: 'array', items: str } },
      },
    }),
    msgOf('question', ['question'], {
      question: {
        type: 'object', required: ['header', 'text', 'options', 'multi'],
        properties: {
          header: str, text: str, multi: { type: 'boolean' },
          options: { type: 'array', minItems: 1, items: { type: 'object', required: ['label', 'description'], properties: { label: str, description: str } } },
        },
      },
    }),
    msgOf('todo', ['todos'], {
      todos: { type: 'array', minItems: 1, items: { type: 'object', required: ['text', 'done'], properties: { text: str, done: { type: 'boolean' } } } },
    }),
    msgOf('attachment', ['attachment'], {
      attachment: { type: 'object', required: ['mime', 'name', 'url'], properties: { mime: str, name: str, url: str } },
    }),
  ],
};

const SessionList = {
  type: 'object',
  required: ['machineId', 'sessions'],
  properties: { machineId: str, sessions: { type: 'array', minItems: 1, items: Session } },
};

const Thread = {
  type: 'object',
  required: ['title', 'messages', 'cursor'],
  properties: { title: str, messages: { type: 'array', minItems: 1, items: Msg }, cursor: { type: ['string', 'null'] } },
};

const StreamEvent = {
  oneOf: [
    { type: 'object', required: ['type', 'session', 'msg'], properties: { type: { const: 'msg' }, session: str, msg: Msg } },
    { type: 'object', required: ['type', 'session', 'status'], properties: { type: { const: 'status' }, session: str, status: { enum: STATUSES } } },
    { type: 'object', required: ['type', 'session'], properties: { type: { const: 'reset' }, session: str } },
  ],
};

function assertValid(schema, data, label) {
  const r = validate(schema, data);
  assert.ok(r.valid, `${label}: ${r.errors.join('; ')}`);
}

test('fixtures validate against the contract', () => {
  assertValid(SessionList, readJson('sessions.json'), 'sessions.json');

  for (const name of ['thread-claude.json', 'thread-codex.json']) assertValid(Thread, readJson(name), name);

  const events = readNdjson('stream.ndjson');
  assert.ok(events.length > 0, 'stream.ndjson has events');
  events.forEach((e, i) => assertValid(StreamEvent, e, `stream[${i}]`));
});

test('the validator rejects off-contract data', () => {
  const good = readJson('sessions.json').sessions[0];
  assert.ok(!validate(SessionList, readJson('sessions.json').sessions).valid, 'a bare Session[] is not a list reply');
  assert.ok(!validate(Session, { ...good, kind: 'vim' }).valid, 'unknown kind');
  assert.ok(!validate(Session, { ...good, status: 'busy' }).valid, 'unknown status');
  assert.ok(!validate(Session, { ...good, id: 'no-colon' }).valid, 'id without machine prefix');
  assert.ok(!validate(Msg, { id: 'm', ts: 1, kind: 'tools' }).valid, 'tools without items');
  assert.ok(!validate(StreamEvent, { type: 'msg', session: 'a:b' }).valid, 'msg event without msg');
});

test('session ids are <machine>:<surface> and unique', () => {
  const { machineId, sessions } = readJson('sessions.json');
  for (const s of sessions) assert.strictEqual(s.id, `${s.machine}:${s.surface}`);
  for (const s of sessions) assert.strictEqual(s.machine, machineId, 'one bridge lists only its own machine');
  assert.strictEqual(new Set(sessions.map((s) => s.id)).size, sessions.length);
});

test('the fixtures cover every session kind, status and message kind', () => {
  const { sessions } = readJson('sessions.json');
  for (const k of KINDS) assert.ok(sessions.some((s) => s.kind === k), `a ${k} session`);
  for (const st of STATUSES) assert.ok(sessions.some((s) => s.status === st), `a ${st} session`);

  const msgs = [...readJson('thread-claude.json').messages, ...readJson('thread-codex.json').messages];
  for (const k of MSG_KINDS) assert.ok(msgs.some((m) => m.kind === k), `a ${k} message`);
  const tools = msgs.filter((m) => m.kind === 'tools').flatMap((m) => m.items);
  for (const st of ['running', 'ok', 'error']) assert.ok(tools.some((t) => t.status === st), `a ${st} tool`);

  const types = new Set(readNdjson('stream.ndjson').map((e) => e.type));
  for (const t of ['msg', 'status', 'reset']) assert.ok(types.has(t), `a ${t} stream event`);
});

test('fixtures stay small, bounded and free of secrets', () => {
  const claude = readJson('thread-claude.json');
  const codex = readJson('thread-codex.json');
  assert.ok(claude.messages.length + codex.messages.length <= 60, 'at most 60 thread messages');

  for (const m of [...claude.messages, ...codex.messages]) {
    for (const t of m.items || []) assert.ok((t.output || '').length <= 2000, `tool ${t.id} output over 2000 chars`);
  }
  for (const [id, thread] of [['mini:surface:12', claude], ['mini:surface:3', codex]]) {
    thread.messages.filter((m) => m.kind === 'attachment').forEach((m, n) => {
      assert.strictEqual(m.attachment.url, `/api/sessions/${id}/attachment/${n}`, 'attachment url is by 0-based index in the thread');
    });
  }
  const ids = claude.messages.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'message ids are unique within a thread');

  for (const name of fs.readdirSync(DIR)) {
    const text = fs.readFileSync(path.join(DIR, name), 'utf8');
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), `${name}: email address`);
    assert.ok(!/(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xox[bp]-|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})/.test(text), `${name}: token-like string`);
    assert.ok(!/\/Users\/[a-z]/i.test(text), `${name}: real home path`);
  }
});

test('CONTRACT.md documents every type and both route families', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'sessions', 'CONTRACT.md'), 'utf8');
  for (const word of ['Session', 'Msg', 'Tool', 'Stream event', 'cursor']) assert.ok(doc.includes(word), `mentions ${word}`);
  assert.ok(!/POST \/(cmux|api)\/sessions\/:id\/input/.test(doc), 'input is a WebSocket, not a POST');
  for (const route of ['/cmux/sessions', '/api/sessions', 'thread-stream', 'WS /cmux/sessions/:id/input', '/attachment/:n', 'limit=', 'machineId']) assert.ok(doc.includes(route), `mentions ${route}`);
});
