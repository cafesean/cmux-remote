'use strict';
// S-004a — the bridge's session-events endpoint, plus the NDJSON log format it serves.
//
// Two layers, both required:
//   1. eventlog.js as a unit — the format contract (malformed lines, ordering, prune boundaries).
//   2. a REAL bridge.js child on an ephemeral port — the wire contract of §M2.
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const eventlog = require('../radar/eventlog');
const { bootBridge, callBridge } = require('./helpers/bridge-child');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'radar-events-'));

const T0 = Date.parse('2026-07-30T12:00:00.000Z');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function seedEvents(radarDir, lines, when) {
  const dir = path.join(radarDir, 'events');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${day(when == null ? T0 : when)}.ndjson`);
  await fsp.writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  return file;
}

const ev = (over) => Object.assign({
  ts: T0, sessionId: 's-1', transcriptPath: '/t/s-1.jsonl', cwd: '/repo', event: 'UserPromptSubmit', notificationType: null,
}, over);

// ---- format ------------------------------------------------------------------------------------

test('normalizeEvent accepts the RAW hook payload shape and keeps only the §M2 fields', () => {
  const out = eventlog.normalizeEvent({
    session_id: 'abc', transcript_path: '/t/abc.jsonl', cwd: '/repo/x',
    hook_event_name: 'Notification', notification_type: 'permission_prompt',
    // Claude Code's payload also carries permission_mode / agent_type / tool_input; tool_input can
    // be a whole file. None of it may reach the log.
    permission_mode: 'default', agent_type: 'general', tool_input: { content: 'x'.repeat(10000) },
  }, T0);
  assert.deepStrictEqual(out, {
    ts: T0, sessionId: 'abc', transcriptPath: '/t/abc.jsonl', cwd: '/repo/x',
    event: 'Notification', notificationType: 'permission_prompt',
  });
});

test('an event with no session_id or no hook_event_name is dropped — identity is not optional', () => {
  assert.strictEqual(eventlog.normalizeEvent({ hook_event_name: 'Stop' }, T0), null);
  assert.strictEqual(eventlog.normalizeEvent({ session_id: 'a' }, T0), null);
  assert.strictEqual(eventlog.normalizeEvent(null, T0), null);
  assert.strictEqual(eventlog.normalizeEvent('not an object', T0), null);
});

test('a malformed TRAILING line is skipped and costs exactly one line', async () => {
  const dir = await tmp();
  await seedEvents(dir, [
    JSON.stringify(ev({ ts: T0 })),
    JSON.stringify(ev({ ts: T0 + 1, event: 'Stop' })),
    '{"ts":123,"sessionId":"s-1","event":"Stop"',        // killed mid-append
  ]);
  const r = await eventlog.readEvents({ radarDir: dir });
  assert.strictEqual(r.events.length, 2, 'the two good lines survive');
  assert.strictEqual(r.skipped, 1);
  assert.deepStrictEqual(r.events.map((e) => e.event), ['UserPromptSubmit', 'Stop']);
});

test('garbage in the MIDDLE of the file does not stop the reader', async () => {
  const dir = await tmp();
  await seedEvents(dir, [
    JSON.stringify(ev({ ts: T0 })),
    'not json at all',
    '[]',                                                 // valid JSON, wrong shape
    JSON.stringify(ev({ ts: T0 + 2, event: 'Stop' })),
  ]);
  const r = await eventlog.readEvents({ radarDir: dir });
  assert.strictEqual(r.events.length, 2);
  assert.strictEqual(r.skipped, 2);
});

test('`since` is an EXCLUSIVE lower bound and the page is ascending', async () => {
  const dir = await tmp();
  await seedEvents(dir, [ev({ ts: T0 + 3 }), ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 })]);
  const all = await eventlog.readEvents({ radarDir: dir });
  assert.deepStrictEqual(all.events.map((e) => e.ts), [T0 + 1, T0 + 2, T0 + 3], 'ascending regardless of file order');
  const since = await eventlog.readEvents({ radarDir: dir, since: T0 + 1 });
  assert.deepStrictEqual(since.events.map((e) => e.ts), [T0 + 2, T0 + 3], 'the bound itself is excluded');
});

test('a page never splits a group of same-ms events, so `since` cannot skip past them', async () => {
  const dir = await tmp();
  // 3 events at T0+1, then 1 at T0+2, with a limit of 2. A hard cap would answer [T0+1, T0+1] and
  // the consumer's next `since=T0+1` would silently lose the third.
  await seedEvents(dir, [ev({ ts: T0 + 1 }), ev({ ts: T0 + 1 }), ev({ ts: T0 + 1 }), ev({ ts: T0 + 2 })]);
  const page = await eventlog.readEvents({ radarDir: dir, limit: 2 });
  assert.deepStrictEqual(page.events.map((e) => e.ts), [T0 + 1, T0 + 1, T0 + 1]);
  assert.strictEqual(page.more, true);
  const next = await eventlog.readEvents({ radarDir: dir, since: T0 + 1, limit: 2 });
  assert.deepStrictEqual(next.events.map((e) => e.ts), [T0 + 2]);
  assert.strictEqual(next.more, false);
});

test('a missing events directory reads as empty, not as an error', async () => {
  const dir = await tmp();
  const r = await eventlog.readEvents({ radarDir: dir });
  assert.deepStrictEqual(r, { events: [], more: false, skipped: 0 });
});

test('appendEventSync round-trips through readEvents and lands in the UTC-day file', async () => {
  const dir = await tmp();
  eventlog.appendEventSync(dir, { session_id: 's9', hook_event_name: 'Stop' }, T0);
  const names = await fsp.readdir(path.join(dir, 'events'));
  assert.deepStrictEqual(names, [`${day(T0)}.ndjson`]);
  const r = await eventlog.readEvents({ radarDir: dir });
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].sessionId, 's9');
  assert.strictEqual(r.events[0].ts, T0);
});

// ---- pruning -----------------------------------------------------------------------------------

test('prune boundary: the CURRENT-day file always survives, even when it looks ancient', async () => {
  const dir = await tmp();
  const events = path.join(dir, 'events');
  await seedEvents(dir, [ev({})], T0);                       // today's file
  // keepMs 0 means "prune everything eligible" — the current file is still excluded, by name,
  // before any arithmetic runs.
  const removed = await eventlog.pruneEvents({ eventsDir: events, now: T0, keepMs: 0 });
  assert.deepStrictEqual(removed, []);
  assert.deepStrictEqual(await fsp.readdir(events), [`${day(T0)}.ndjson`]);
});

test('prune boundary: a dated file survives at 47 h past its day-end and is removed at 49 h', async () => {
  const fileDayStart = Date.parse('2026-07-27T00:00:00.000Z');
  const fileDayEnd = fileDayStart + 24 * 3600 * 1000;        // 2026-07-28T00:00Z
  for (const [ageH, expectRemoved] of [[47, false], [49, true]]) {
    const dir = await tmp();
    const events = path.join(dir, 'events');
    await seedEvents(dir, [ev({ ts: fileDayStart })], fileDayStart);
    const name = `${day(fileDayStart)}.ndjson`;
    const now = fileDayEnd + ageH * 3600 * 1000;
    assert.notStrictEqual(name, `${day(now)}.ndjson`, 'fixture must not be the current-day file');
    const removed = await eventlog.pruneEvents({ eventsDir: events, now });
    assert.deepStrictEqual(removed, expectRemoved ? [name] : [], `${ageH}h past day-end`);
    assert.strictEqual((await fsp.readdir(events)).includes(name), !expectRemoved, `${ageH}h past day-end, on disk`);
  }
});

test('prune ignores files that are not dated event logs', async () => {
  const dir = await tmp();
  const events = path.join(dir, 'events');
  await fsp.mkdir(events, { recursive: true });
  // The push WAL lives in this directory too. Pruning it would be catastrophic.
  await fsp.writeFile(path.join(events, 'push-queue.jsonl'), '{"eventId":"x"}\n');
  await fsp.writeFile(path.join(events, 'notes.txt'), 'hello');
  const removed = await eventlog.pruneEvents({ eventsDir: events, now: T0, keepMs: 0 });
  assert.deepStrictEqual(removed, []);
  assert.deepStrictEqual((await fsp.readdir(events)).sort(), ['notes.txt', 'push-queue.jsonl']);
});

// ---- the hook receiver -------------------------------------------------------------------------

test('hook-receiver appends a normalized line and never throws on junk input', async () => {
  const dir = await tmp();
  const prev = process.env.RADAR_DIR;
  process.env.RADAR_DIR = dir;
  try {
    const receiver = require('../radar/hook-receiver');
    receiver.handle(JSON.stringify({
      session_id: 'hook-1', transcript_path: '/t/hook-1.jsonl', cwd: '/repo',
      hook_event_name: 'Notification', notification_type: 'permission_prompt',
    }));
    receiver.handle('}{ not json');                      // must be swallowed
    receiver.handle(JSON.stringify({ hook_event_name: 'Stop' }));   // no session_id -> dropped
    const r = await eventlog.readEvents({ radarDir: dir });
    assert.strictEqual(r.events.length, 1, 'only the well-formed event is logged');
    assert.strictEqual(r.events[0].notificationType, 'permission_prompt');
  } finally {
    if (prev === undefined) delete process.env.RADAR_DIR; else process.env.RADAR_DIR = prev;
  }
});

// ---- the wire contract, against a real bridge child ---------------------------------------------

test('GET /cmux/session-events honours the §M2 contract on a real bridge child', async () => {
  const dir = await tmp();
  await seedEvents(dir, [
    ev({ ts: T0 + 1, sessionId: 'a', event: 'UserPromptSubmit' }),
    ev({ ts: T0 + 2, sessionId: 'b', event: 'Notification', notificationType: 'permission_prompt' }),
    ev({ ts: T0 + 3, sessionId: 'a', event: 'Stop' }),
  ]);
  const b = await bootBridge({ env: { BRIDGE_SECRET: 'sekrit', RADAR_DIR: dir, RADAR_MACHINE_ID: 'mac-test' } });
  try {
    const all = await callBridge(b.base, '/cmux/session-events', { secret: 'sekrit' });
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.json.machineId, 'mac-test', 'machineId is in the response');
    assert.strictEqual(all.json.more, false);
    assert.deepStrictEqual(all.json.events.map((e) => e.ts), [T0 + 1, T0 + 2, T0 + 3], 'ascending');
    assert.deepStrictEqual(all.json.events[1], {
      ts: T0 + 2, sessionId: 'b', transcriptPath: '/t/s-1.jsonl', cwd: '/repo',
      event: 'Notification', notificationType: 'permission_prompt',
    });

    const since = await callBridge(b.base, `/cmux/session-events?since=${T0 + 2}`, { secret: 'sekrit' });
    assert.deepStrictEqual(since.json.events.map((e) => e.ts), [T0 + 3], 'since is exclusive');

    const limited = await callBridge(b.base, '/cmux/session-events?limit=1', { secret: 'sekrit' });
    assert.strictEqual(limited.json.events.length, 1);
    assert.strictEqual(limited.json.more, true, 'more flags the truncation');

    const bad = await callBridge(b.base, '/cmux/session-events?since=yesterday', { secret: 'sekrit' });
    assert.strictEqual(bad.status, 400);
  } finally {
    await b.stop();
  }
});

test('session-events is behind BRIDGE_SECRET like every other /cmux route', async () => {
  const dir = await tmp();
  await seedEvents(dir, [ev({})]);
  const b = await bootBridge({ env: { BRIDGE_SECRET: 'sekrit', RADAR_DIR: dir } });
  try {
    const anon = await callBridge(b.base, '/cmux/session-events');
    assert.strictEqual(anon.status, 403);
    const wrong = await callBridge(b.base, '/cmux/session-events', { secret: 'nope' });
    assert.strictEqual(wrong.status, 403);
  } finally {
    await b.stop();
  }
});

test('an unreadable event log degrades to an empty page, never a 500', async () => {
  const dir = await tmp();
  const events = path.join(dir, 'events');
  await fsp.mkdir(events, { recursive: true });
  await fsp.chmod(events, 0o000);
  const b = await bootBridge({ env: { BRIDGE_SECRET: 's', RADAR_DIR: dir, RADAR_MACHINE_ID: 'mac-test' } });
  try {
    const r = await callBridge(b.base, '/cmux/session-events', { secret: 's' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.machineId, 'mac-test');
    assert.deepStrictEqual(r.json.events, []);
  } finally {
    await fsp.chmod(events, 0o700);
    await b.stop();
  }
});

test('the new route is additive: unknown paths still 404 and the route needs no cmux', async () => {
  const dir = await tmp();
  await seedEvents(dir, [ev({})]);
  // CMUX_BIN points at a file that does not exist (see the helper), so a cmux-dependent route would
  // fail — proving session-events shares nothing with them.
  const b = await bootBridge({ env: { BRIDGE_SECRET: 's', RADAR_DIR: dir } });
  try {
    assert.strictEqual((await callBridge(b.base, '/cmux/session-events', { secret: 's' })).status, 200);
    assert.strictEqual((await callBridge(b.base, '/cmux/session-eventsX', { secret: 's' })).status, 404);
    assert.strictEqual((await callBridge(b.base, '/cmux/session-events', { secret: 's', method: 'POST' })).status, 404);
    const tree = await callBridge(b.base, '/cmux/tree', { secret: 's' });
    assert.strictEqual(tree.status, 502, 'the cmux route fails without cmux — and session-events did not');
  } finally {
    await b.stop();
  }
});
