'use strict';
// p41 A14 — Session.choice: answer buttons for a waiting session (sessions/choice.js, menuparse.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const menuparse = require('../public/menuparse.js');
const { createChoiceReader, LIMITS } = require('../sessions/choice');

const GRIDS = path.join(__dirname, 'fixtures', 'grids');
const noId = (c) => { const { choiceId, ...rest } = c; assert.match(choiceId, /^[0-9a-f]{16}$/); return rest; };
const load = (n) => JSON.parse(fs.readFileSync(path.join(GRIDS, `${n}.json`), 'utf8')).grid;

const question = { kind: 'question', ts: 5, question: { header: 'Approach', text: 'Which approach?', multi: false,
  options: [{ label: 'Small patch', description: '' }, { label: 'Refactor', description: '' }] } };
const calloutMsgs = [
  { kind: 'assistant', ts: 4, text: 'Ready to ship.' },
  { kind: 'callout', ts: 4, callout: { type: 'needs-you', title: 'Ship it?', body: '', options: ['Ship', 'Hold'] } },
];

test('permission prompt screen -> 3 options with the PWA keys (arrows from the marked row, then Enter)', async () => {
  const r = createChoiceReader({ readGrid: async () => load('a14-permission') });
  const c = await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: [] });
  assert.equal(c.source, 'menu');
  assert.equal(c.question, 'Do you want to proceed?');
  assert.deepEqual(c.options.map((o) => o.label), ['Yes', "Yes, and don't ask again for rm commands in /work/alpha",
    'No, and tell Claude what to do differently (esc)']);
  assert.deepEqual(c.options.map((o) => o.send.keys), [['enter'], ['down', 'enter'], ['down', 'down', 'enter']]);
});

test('AskUserQuestion selector on screen: highlight mid-list, numbered prose above ignored', async () => {
  const r = createChoiceReader({ readGrid: async () => load('a14-ask') });
  const c = await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: [question] });
  assert.equal(c.source, 'menu');
  assert.equal(c.question, 'Which approach should I take?');
  assert.deepEqual(c.options.map((o) => o.label), ['Small patch', 'Refactor', 'Type something.', 'Chat about this']);
  assert.deepEqual(c.options[0].send.keys, ['up', 'enter']);
  assert.deepEqual(c.options[1].send.keys, ['enter']);
  assert.deepEqual(c.options[3].send.keys, ['down', 'down', 'enter']);
});

test('menu keys equal what the PWA computes (stepsTo + enter) and use only /cmux/key names', () => {
  const g = load('a14-permission');
  const menu = menuparse.parseNumberedMenu(g);
  const ok = new Set(['enter', 'up', 'down']);
  menuparse.menuChoice(g).options.forEach((o, i) => {
    assert.deepEqual(o.send.keys, [...menuparse.stepsTo(menu, i), 'enter']);
    for (const k of o.send.keys) assert.ok(ok.has(k));
  });
});

test('pending AskUserQuestion with no readable menu -> source ask, number typed without Enter', async () => {
  const r = createChoiceReader({ readGrid: async () => null });
  const c = await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: [question] });
  assert.deepEqual(noId(c), { source: 'ask', question: 'Which approach?', options: [
    { label: 'Small patch', send: { text: '1', submit: false } },
    { label: 'Refactor', send: { text: '2', submit: false } }] });
});

test('multi-select AskUserQuestion gives no ask choice (one press does not answer it)', async () => {
  const r = createChoiceReader({ readGrid: async () => null });
  const multi = { ...question, question: { ...question.question, multi: true } };
  assert.equal(await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: [multi] }), null);
});

test('callout options in the last assistant message -> source callout, text + Enter', async () => {
  const r = createChoiceReader({ readGrid: async () => load('neg-numbered-prose') });
  const c = await r.choiceFor({ status: 'your-turn', surface: 'S1', lastMsgs: calloutMsgs });
  assert.deepEqual(noId(c), { source: 'callout', question: 'Ship it?', options: [
    { label: 'Ship', send: { text: 'Ship', submit: true } }, { label: 'Hold', send: { text: 'Hold', submit: true } }] });
});

test('a callout no longer last (user replied) offers nothing', async () => {
  const r = createChoiceReader({ readGrid: async () => null });
  const msgs = [...calloutMsgs, { kind: 'user', ts: 9, text: 'Ship' }];
  assert.equal(await r.choiceFor({ status: 'your-turn', surface: 'S1', lastMsgs: msgs }), null);
});

test('none while working / idle / finished, and the screen is not read', async () => {
  let reads = 0;
  const r = createChoiceReader({ readGrid: async () => { reads++; return load('a14-permission'); } });
  for (const status of ['working', 'idle', 'finished']) {
    assert.equal(await r.choiceFor({ status, surface: 'S1', lastMsgs: [question, ...calloutMsgs] }), null);
  }
  assert.equal(reads, 0);
});

test('screen read is shared within the TTL and parsed once per screen hash', async () => {
  let reads = 0, t = 0;
  const r = createChoiceReader({ readGrid: async () => { reads++; return load('a14-permission'); }, now: () => t });
  await r.choiceFor({ status: 'needs-you', surface: 'S1' });
  await r.choiceFor({ status: 'needs-you', surface: 'S1' });
  assert.equal(reads, 1);
  t += LIMITS.choiceScreenTtlMs;
  await r.choiceFor({ status: 'needs-you', surface: 'S1' });
  assert.equal(reads, 2);
});

test('a slow screen read times out to "no live menu" and falls through', async () => {
  const r = createChoiceReader({ readGrid: () => new Promise(() => {}) });
  const orig = LIMITS.choiceScreenTimeoutMs;
  LIMITS.choiceScreenTimeoutMs = 20;
  try {
    const c = await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: [question] });
    assert.equal(c.source, 'ask');
  } finally { LIMITS.choiceScreenTimeoutMs = orig; }
});

test('negatives: numbered prose, shell, zsh menu -> no numbered selector', () => {
  for (const n of ['neg-numbered-prose', 'neg-shell-startup', 'zsh-menu-single']) assert.equal(menuparse.parseNumberedMenu(load(n)), null, n);
});

test('parser stays browser-loadable: the UMD wrapper sets self.cmuxMenuParse with the new API', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'menuparse.js'), 'utf8');
  const self = {};
  new Function('self', 'module', src)(self, undefined);
  for (const k of ['parseMenu', 'stepsTo', 'parseNumberedMenu', 'menuChoice', 'pickKeys']) assert.equal(typeof self.cmuxMenuParse[k], 'function', k);
});

// ---- Fix round 1: atomic choose (commit) ------------------------------------------------------
// A scripted screen: each readGrid call returns the next {seq, grid}; the last one repeats.
function screens(list) {
  let i = 0;
  return async () => list[Math.min(i++, list.length - 1)];
}
function io() {
  const sent = [];
  return { sent, pressKey: async (k) => { sent.push(['key', k]); return { ok: true }; },
    sendText: async (t, s) => { sent.push(['text', t, s]); return { ok: true }; } };
}
// The permission prompt with the highlight moved to `at` (0-based).
function permAt(at) {
  const g = JSON.parse(JSON.stringify(load('a14-permission')));
  for (const sp of g.row_spans) {
    if (sp.row >= 12 && sp.row <= 14) {
      const mine = sp.row - 12 === at;
      sp.style_id = mine ? 1 : 2;
      sp.text = sp.text.replace(/^❯ /, '');
      if (mine) sp.text = '❯ ' + sp.text;
      sp.column = mine ? 1 : 3;
    }
  }
  return g;
}

test('choiceId: stable for the same question+labels, different for another', async () => {
  const r = createChoiceReader({ readGrid: async () => load('a14-permission') });
  const a = await r.choiceFor({ status: 'needs-you', surface: 'S1' });
  const b = await r.choiceFor({ status: 'needs-you', surface: 'S1', fresh: true });
  assert.match(a.choiceId, /^[0-9a-f]{16}$/);
  assert.equal(a.choiceId, b.choiceId);
  const r2 = createChoiceReader({ readGrid: async () => load('a14-ask') });
  assert.notEqual((await r2.choiceFor({ status: 'needs-you', surface: 'S1' })).choiceId, a.choiceId);
});

test('choose: stale choiceId -> 409 stale with the fresh choice, nothing sent', async () => {
  const r = createChoiceReader({ readGrid: async () => ({ seq: 1, grid: load('a14-permission') }) });
  const current = await r.choiceFor({ status: 'needs-you', surface: 'S1', fresh: true });
  const x = io();
  const out = await r.commit({ current, choiceId: 'deadbeefdeadbeef', index: 0, label: 'Yes', surface: 'S1' }, x);
  assert.equal(out.code, 409);
  assert.equal(out.body.error, 'stale');
  assert.equal(out.body.choice.choiceId, current.choiceId);
  assert.deepEqual(x.sent, []);
});

test('choose: label mismatch -> 409, nothing sent', async () => {
  const r = createChoiceReader({ readGrid: async () => ({ seq: 1, grid: load('a14-permission') }) });
  const current = await r.choiceFor({ status: 'needs-you', surface: 'S1', fresh: true });
  const x = io();
  const out = await r.commit({ current, choiceId: current.choiceId, index: 0, label: 'No', surface: 'S1' }, x);
  assert.equal(out.code, 409);
  assert.deepEqual(x.sent, []);
});

test('choose: no current choice (session moved on) -> 409, nothing sent', async () => {
  const r = createChoiceReader({ readGrid: async () => null });
  const x = io();
  const out = await r.commit({ current: null, choiceId: 'x', index: 0, label: 'Yes', surface: 'S1' }, x);
  assert.equal(out.code, 409);
  assert.deepEqual(x.sent, []);
});

test('choose: highlight moved between list read and choose -> keys computed from the FRESH highlight', async () => {
  // The list saw the highlight on 1 ("No" = down,down). At choose time it is on 2: one down only.
  const listed = await createChoiceReader({ readGrid: async () => load('a14-permission') }).choiceFor({ status: 'needs-you', surface: 'S1' });
  assert.deepEqual(listed.options[2].send.keys, ['down', 'down', 'enter']);
  const r = createChoiceReader({ readGrid: screens([{ seq: 5, grid: permAt(1) }, { seq: 6, grid: permAt(2) }]) });
  const label = 'No, and tell Claude what to do differently (esc)';
  const x = io();
  const out = await r.commit({ current: listed, choiceId: listed.choiceId, index: 2, label, surface: 'S1' }, x);
  assert.equal(out.code, 200, JSON.stringify(out));
  assert.deepEqual(x.sent, [['key', 'down'], ['key', 'enter']]);
});

test('choose: readback shows the wrong row highlighted -> 409 selection_moved, no Enter', async () => {
  const r = createChoiceReader({ readGrid: screens([{ seq: 5, grid: permAt(0) }, { seq: 6, grid: permAt(1) }]) });
  const current = await createChoiceReader({ readGrid: async () => load('a14-permission') }).choiceFor({ status: 'needs-you', surface: 'S1' });
  const x = io();
  const out = await r.commit({ current, choiceId: current.choiceId, index: 2, label: current.options[2].label, surface: 'S1' }, x);
  assert.equal(out.code, 409);
  assert.equal(out.body.error, 'selection_moved');
  assert.ok(!x.sent.some((s) => s[1] === 'enter'));
});

test('choose: no newer frame after the arrows -> 409 no_confirmation, no Enter', async () => {
  const orig = LIMITS.choiceReadbackTimeoutMs;
  LIMITS.choiceReadbackTimeoutMs = 200;
  try {
    const r = createChoiceReader({ readGrid: async () => ({ seq: 5, grid: permAt(0) }) });
    const current = await r.choiceFor({ status: 'needs-you', surface: 'S1', fresh: true });
    const x = io();
    const out = await r.commit({ current, choiceId: current.choiceId, index: 1, label: current.options[1].label, surface: 'S1' }, x);
    assert.equal(out.code, 409);
    assert.equal(out.body.error, 'no_confirmation');
    assert.deepEqual(x.sent, [['key', 'down']]);
  } finally { LIMITS.choiceReadbackTimeoutMs = orig; }
});

test('choose: delta 0 -> Enter only, verified on the fresh read', async () => {
  const r = createChoiceReader({ readGrid: async () => ({ seq: 5, grid: permAt(0) }) });
  const current = await r.choiceFor({ status: 'needs-you', surface: 'S1', fresh: true });
  const x = io();
  const out = await r.commit({ current, choiceId: current.choiceId, index: 0, label: 'Yes', surface: 'S1' }, x);
  assert.equal(out.code, 200);
  assert.deepEqual(x.sent, [['key', 'enter']]);
});

test('choose: ask -> digit typed without Enter; callout -> option text + Enter', async () => {
  const r = createChoiceReader({ readGrid: async () => null });
  const ask = await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: [question] });
  let x = io();
  assert.equal((await r.commit({ current: ask, choiceId: ask.choiceId, index: 1, label: 'Refactor', surface: 'S1' }, x)).code, 200);
  assert.deepEqual(x.sent, [['text', '2', false]]);
  const co = await r.choiceFor({ status: 'your-turn', surface: 'S1', lastMsgs: calloutMsgs });
  x = io();
  assert.equal((await r.commit({ current: co, choiceId: co.choiceId, index: 0, label: 'Ship', surface: 'S1' }, x)).code, 200);
  assert.deepEqual(x.sent, [['text', 'Ship', true]]);
});
