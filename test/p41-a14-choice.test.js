'use strict';
// p41 A14 — Session.choice: answer buttons for a waiting session (sessions/choice.js, menuparse.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const menuparse = require('../public/menuparse.js');
const { createChoiceReader, LIMITS } = require('../sessions/choice');

const GRIDS = path.join(__dirname, 'fixtures', 'grids');
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
  assert.deepEqual(c, { source: 'ask', question: 'Which approach?', options: [
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
  assert.deepEqual(c, { source: 'callout', question: 'Ship it?', options: [
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
