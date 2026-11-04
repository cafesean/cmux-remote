'use strict';
// p41 A5 — per-session status (needs-you / working / finished / your-turn / idle).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { statusFor, contextPct, contextUsage, CONTEXT_WINDOWS, LIMITS } = require('../sessions/status.js');

const SURFACE = 'E716A549-97CA-4D01-9C6F-78EE5B26C7E5';
const ev = (event, ts, extra) => ({ ts, event, ...extra });
const user = (ts, text = 'go') => ({ id: `u${ts}:0`, ts, kind: 'user', text });
const asst = (ts, text) => ({ id: `a${ts}:0`, ts, kind: 'assistant', text });
const callout = (ts, type, title, body = '', options = []) => ({ id: `a${ts}:1`, ts, kind: 'callout', callout: { type, title, body, options } });
const tools = (ts, items) => ({ id: `t${ts}:0`, ts, kind: 'tools', items });
const marker = (epochS, surface = SURFACE, ask = 'Answer captain a1: tonight or Monday?') =>
  ({ session_id: 's1', name: 'x', ask, epoch: epochS, cmux: { surface_id: surface } });

test('needs-you from a Notification newer than the last UserPromptSubmit', () => {
  const r = statusFor({ now: 1000,
    lastMsgs: [user(100), asst(150, 'Running it')],
    events: [ev('UserPromptSubmit', 100), ev('Notification', 200, { notificationType: 'permission_prompt' })],
  });
  assert.strictEqual(r.status, 'needs-you');
  assert.match(r.preview, /^Needs you: /);
});

test('a Notification older than the last UserPromptSubmit, or followed by a Stop, does not count', () => {
  const old = statusFor({ now: 1000, lastMsgs: [], events: [ev('Notification', 100), ev('UserPromptSubmit', 200)], toolRunning: true });
  assert.strictEqual(old.status, 'working');
  const answered = statusFor({ now: 1000, lastMsgs: [], events: [ev('UserPromptSubmit', 100), ev('Notification', 200), ev('Stop', 300)] });
  assert.strictEqual(answered.status, 'your-turn');
});

test('needs-you from an unanswered question', () => {
  const q = { id: 'q1:0', ts: 300, kind: 'question', question: { header: 'Cut', text: 'Full Cadra cut tonight or Monday?', options: [], multi: false } };
  const r = statusFor({ now: 1000, lastMsgs: [user(100), q], events: [ev('UserPromptSubmit', 100)] });
  assert.strictEqual(r.status, 'needs-you');
});

test('an answered question (more messages after it) is not needs-you', () => {
  const q = { id: 'q1:0', ts: 300, kind: 'question', question: { header: '', text: 'Which?', options: [], multi: false } };
  const r = statusFor({ now: 1000, lastMsgs: [q, asst(400, 'Thanks, going with A')], events: [ev('UserPromptSubmit', 100), ev('Stop', 500)] });
  assert.strictEqual(r.status, 'your-turn');
});

test('needs-you from a needs-you callout in the last assistant message', () => {
  const r = statusFor({ now: 1000,
    lastMsgs: [user(100), asst(200, 'Ready.'), callout(200, 'needs-you', 'Answer captain a1', 'Tonight or Monday?')],
    events: [ev('UserPromptSubmit', 100), ev('Stop', 210)],
  });
  assert.strictEqual(r.status, 'needs-you');
  assert.strictEqual(r.preview, 'Needs you: Answer captain a1');
});

test('a needs-you callout in an earlier message does not count', () => {
  const r = statusFor({ now: 1000,
    lastMsgs: [user(100), callout(200, 'needs-you', 'Old ask'), user(300, 'A'), asst(400, 'Done with A')],
    events: [ev('UserPromptSubmit', 300), ev('Stop', 410)],
  });
  assert.strictEqual(r.status, 'your-turn');
});

test('needs-you from a fresh marker for this surface', () => {
  const r = statusFor({ now: 1000,
    lastMsgs: [user(100), asst(150, 'Hm')],
    events: [ev('UserPromptSubmit', 100), ev('Stop', 160)],
    marker: marker(1), surfaceId: SURFACE.toLowerCase(),
  });
  assert.strictEqual(r.status, 'needs-you');
  assert.strictEqual(r.preview, 'Needs you: Answer captain a1: tonight or Monday?');
});

test('stale marker ignored when surface gone or older than last prompt', () => {
  const base = { lastMsgs: [user(5000), asst(5100, 'ok')], events: [ev('UserPromptSubmit', 5000), ev('Stop', 5200)] };
  // older than the last prompt (epoch is seconds)
  assert.strictEqual(statusFor({ now: 1000, ...base, marker: marker(4), surfaceId: SURFACE }).status, 'your-turn');
  // a different surface (the marker's pane is gone, or this pane is another one)
  assert.strictEqual(statusFor({ now: 1000, ...base, marker: marker(9, 'OTHER'), surfaceId: SURFACE }).status, 'your-turn');
  // no surface known for this pane
  assert.strictEqual(statusFor({ now: 1000, ...base, marker: marker(9) }).status, 'your-turn');
  // older than the newest user message even when no prompt event is retained
  assert.strictEqual(statusFor({ now: 1000, lastMsgs: [user(5000)], events: [], marker: marker(4), surfaceId: SURFACE }).status, 'idle');
});

test('working: a tool is running', () => {
  const r = statusFor({ now: 1000,
    lastMsgs: [user(100), tools(200, [{ id: 't', name: 'Bash', target: 'npm test', status: 'running' }])],
    events: [ev('UserPromptSubmit', 100), ev('Stop', 150)],
    toolRunning: true,
  });
  assert.strictEqual(r.status, 'working');
  assert.strictEqual(r.preview, 'Bash npm test');
});

test('working: latest event is a UserPromptSubmit with no Stop yet', () => {
  const r = statusFor({ now: 1000, lastMsgs: [asst(50, 'Earlier reply.'), user(100)], events: [ev('Stop', 60), ev('UserPromptSubmit', 100)] });
  assert.strictEqual(r.status, 'working');
  assert.strictEqual(r.preview, 'Earlier reply.');
});

test('finished: done callout, then a Stop', () => {
  const r = statusFor({ now: 1000,
    lastMsgs: [user(100), asst(200, 'All merged.'), callout(200, 'done', 'Task A5 done')],
    events: [ev('UserPromptSubmit', 100), ev('Stop', 210)],
  });
  assert.strictEqual(r.status, 'finished');
});

test('finished: a DONE line, then a Stop; no Stop yet is not finished', () => {
  const lastMsgs = [user(100), asst(200, 'Summary\n\nstatus: DONE\n')];
  assert.strictEqual(statusFor({ now: 1000, lastMsgs, events: [ev('UserPromptSubmit', 100), ev('Stop', 210)] }).status, 'finished');
  assert.strictEqual(statusFor({ now: 1000, lastMsgs: [user(100), asst(200, 'DONE - merged')], events: [ev('UserPromptSubmit', 100), ev('Stop', 210)] }).status, 'finished');
  assert.strictEqual(statusFor({ now: 1000, lastMsgs, events: [ev('UserPromptSubmit', 100), ev('Stop', 150)] }).status, 'your-turn');
  assert.strictEqual(statusFor({ now: 1000, lastMsgs, events: [ev('UserPromptSubmit', 100)] }).status, 'working');
});

test('a thread already read falls back to your-turn', () => {
  const lastMsgs = [user(100), asst(200, 'DONE')];
  assert.strictEqual(statusFor({ now: 1000, lastMsgs, events: [ev('Stop', 210)], unread: false }).status, 'your-turn');
});

test('your-turn: a Stop and nothing running', () => {
  const r = statusFor({ now: 1000, lastMsgs: [user(100), asst(200, 'Which approach do you prefer?')], events: [ev('UserPromptSubmit', 100), ev('Stop', 210)] });
  assert.strictEqual(r.status, 'your-turn');
  assert.strictEqual(r.preview, 'Which approach do you prefer?');
});

test('idle: nothing to go on, or the session ended', () => {
  assert.strictEqual(statusFor({ now: 1000, lastMsgs: [], events: [] }).status, 'idle');
  const ended = statusFor({ now: 1000, lastMsgs: [user(100)], events: [ev('UserPromptSubmit', 100), ev('Notification', 150), ev('SessionEnd', 200)], toolRunning: true });
  assert.strictEqual(ended.status, 'idle');
});

test('preview for needs-you uses question text', () => {
  const q = { id: 'q1:0', ts: 300, kind: 'question', question: { header: 'Cut', text: 'Full Cadra cut tonight or Monday?', options: [], multi: false } };
  const r = statusFor({ now: 1000, lastMsgs: [user(100), q], events: [ev('UserPromptSubmit', 100), ev('Notification', 310)] });
  assert.strictEqual(r.preview, 'Needs you: Full Cadra cut tonight or Monday?');
});

test('preview is the first line of the last assistant text, cut to 120 chars', () => {
  const long = 'x'.repeat(300);
  const r = statusFor({ now: 1000, lastMsgs: [asst(1, 'old'), asst(2, `\n\n${long}\nsecond line`)], events: [ev('Stop', 3)] });
  assert.strictEqual(r.preview.length, 120);
  assert.ok(r.preview.endsWith('…'));
  assert.strictEqual(statusFor({ now: 1000, lastMsgs: [], events: [ev('Stop', 3)] }).preview, '');
});

test('contextPct from usage', () => {
  const usage = { input_tokens: 10000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 10000, output_tokens: 5 };
  assert.strictEqual(contextPct(usage, 'claude-opus-4-5'), 50);
  assert.strictEqual(contextPct(usage, 'claude-sonnet-4-5'), 50);
  assert.strictEqual(contextPct(usage, 'claude-opus-4-5[1m]'), 10);
  assert.strictEqual(contextPct(usage, 'some-other-model'), undefined);
  assert.strictEqual(contextPct(null, 'claude-opus-4-5'), undefined);
  assert.strictEqual(contextPct({ input_tokens: 999999 }, 'claude-opus-4-5'), 100);
  assert.ok(CONTEXT_WINDOWS.length >= 3);
  const r = statusFor({ now: 1000, lastMsgs: [asst(1, 'hi')], events: [ev('Stop', 2)], usage, model: 'claude-opus-4-5' });
  assert.strictEqual(r.contextPct, 50);
  assert.ok(!('contextPct' in statusFor({ now: 1000, lastMsgs: [], events: [], usage, model: 'mystery' })));
});

test('Stop then idle_prompt is not needs-you', () => {
  const r = statusFor({
    lastMsgs: [user(100), asst(200, 'Done for now.')],
    events: [ev('UserPromptSubmit', 100), ev('Stop', 210), ev('Notification', 270, { notificationType: 'idle_prompt' })],
  });
  assert.strictEqual(r.status, 'your-turn');
  const noType = statusFor({ now: 1000, lastMsgs: [], events: [ev('UserPromptSubmit', 100), ev('Notification', 200)], toolRunning: false });
  assert.strictEqual(noType.status, 'working');
});

test('working is capped: no Stop and no activity for LIMITS.workingMaxMs -> idle', () => {
  const t0 = 1000000;
  const events = [ev('UserPromptSubmit', t0)];
  const lastMsgs = [user(t0), asst(t0 + 1, 'Earlier.')];
  assert.strictEqual(LIMITS.workingMaxMs, 30 * 60 * 1000);
  assert.strictEqual(statusFor({ lastMsgs, events, now: t0 + LIMITS.workingMaxMs - 1 }).status, 'working');
  assert.strictEqual(statusFor({ lastMsgs, events, now: t0 + LIMITS.workingMaxMs + 5 }).status, 'idle');
  assert.strictEqual(statusFor({ lastMsgs, events, toolRunning: true, now: t0 + LIMITS.workingMaxMs + 5 }).status, 'idle');
  // fresh transcript activity keeps it working
  const live = [user(t0), asst(t0 + LIMITS.workingMaxMs, 'Still going.')];
  assert.strictEqual(statusFor({ lastMsgs: live, events, now: t0 + LIMITS.workingMaxMs + 5 }).status, 'working');
});

test('contextPct infers a 1M window when used tokens exceed 200k', () => {
  const big = { input_tokens: 1000, cache_read_input_tokens: 449000, cache_creation_input_tokens: 0 };
  assert.strictEqual(contextPct(big, 'claude-opus-4-5'), 45);
  assert.strictEqual(contextPct({ input_tokens: 200000 }, 'claude-opus-4-5'), 100);
  assert.strictEqual(contextPct({ input_tokens: 200001 }, 'claude-sonnet-4-5'), 20);
  assert.strictEqual(contextPct({ input_tokens: 100000 }, 'claude-haiku-4-5'), 50);
});

test('contextUsage reads the last assistant record with usage from the transcript tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p41-status-'));
  const file = path.join(dir, 't.jsonl');
  const row = (o) => JSON.stringify(o);
  fs.writeFileSync(file, [
    row({ type: 'assistant', message: { model: 'claude-opus-4-5', usage: { input_tokens: 1 } } }),
    row({ type: 'user', message: { content: 'hi' } }),
    row({ type: 'assistant', message: { model: 'claude-opus-4-5', usage: { input_tokens: 40000, cache_read_input_tokens: 60000 } } }),
    row({ type: 'assistant', isSidechain: true, message: { model: 'claude-opus-4-5', usage: { input_tokens: 5 } } }),
    '{"type":"assistant","message":{"mod',
  ].join('\n'));
  try {
    const c = await contextUsage(file);
    assert.strictEqual(c.model, 'claude-opus-4-5');
    assert.strictEqual(contextPct(c.usage, c.model), 50);
    assert.strictEqual(await contextUsage(path.join(dir, 'missing.jsonl')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
