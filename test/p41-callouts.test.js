'use strict';
// p41 A4 — Obsidian-style callouts in assistant text.
const test = require('node:test');
const assert = require('node:assert');

const { parseCallouts, splitCallouts, CALLOUT_TYPES, LIMITS } = require('../sessions/callouts.js');

const BANNER = ['████████████████', '██  NEEDS YOU', '██  1. Pick the tunnel', '██  2. Approve the push', '████████████████'].join('\n');

test('CALLOUT_TYPES lists the shipped types', () => {
  assert.deepStrictEqual(CALLOUT_TYPES, ['needs-you', 'done', 'handover', 'decision', 'warning', 'info']);
});

test('> [!needs-you] Title + body', () => {
  const md = ['Before', '', '> [!needs-you] Answer captain a1', '> Full Cadra cut tonight or Monday?', '', 'After'].join('\n');
  assert.deepStrictEqual(parseCallouts(md), [
    { type: 'needs-you', title: 'Answer captain a1', body: 'Full Cadra cut tonight or Monday?', options: [] },
  ]);
});

test('options: A | B -> [A, B] and the line leaves the body', () => {
  const md = ['> [!needs-you] Pick', '> Which one?', '> options: A | B | C'].join('\n');
  assert.deepStrictEqual(parseCallouts(md), [{ type: 'needs-you', title: 'Pick', body: 'Which one?', options: ['A', 'B', 'C'] }]);
});

test('options key case-insensitive', () => {
  const [c] = parseCallouts(['> [!decision] D', '> OPTIONS: Yes|No'].join('\n'));
  assert.deepStrictEqual(c.options, ['Yes', 'No']);
  assert.strictEqual(c.body, '');
});

test('custom type kept, type lower-cased', () => {
  const [a, b] = parseCallouts(['> [!Deploy-Ready] Ship it', '', '> [!NEEDS-YOU] Loud'].join('\n'));
  assert.strictEqual(a.type, 'deploy-ready');
  assert.strictEqual(b.type, 'needs-you');
});

test('fold markers accepted', () => {
  const out = parseCallouts(['> [!info]- Folded', '> hidden', '', '> [!warning]+ Open', '> shown'].join('\n'));
  assert.deepStrictEqual(out.map((c) => [c.type, c.title, c.body]), [['info', 'Folded', 'hidden'], ['warning', 'Open', 'shown']]);
});

test('callout inside a code fence ignored', () => {
  const md = ['Example:', '```', '> [!needs-you] Not real', '> body', '```'].join('\n');
  assert.deepStrictEqual(parseCallouts(md), []);
  assert.strictEqual(splitCallouts(md).text, md);
});

test('tilde fence ignored', () => {
  const md = ['~~~md', '> [!needs-you] Not real', '~~~', '', '> [!done] Real'].join('\n');
  assert.deepStrictEqual(parseCallouts(md).map((c) => c.type), ['done']);
});

test('a longer fence is not closed by a shorter one', () => {
  const md = ['````', '```', '> [!needs-you] Not real', '````'].join('\n');
  assert.deepStrictEqual(parseCallouts(md), []);
});

test('indented code ignored', () => {
  assert.deepStrictEqual(parseCallouts('    > [!needs-you] Not real\n\ttext'), []);
  assert.deepStrictEqual(parseCallouts('\t> [!needs-you] Not real'), []);
});

test('two callouts in one message', () => {
  const md = ['> [!done] One', '> a', '', 'between', '', '> [!warning] Two', '> b'].join('\n');
  const { text, callouts } = splitCallouts(md);
  assert.deepStrictEqual(callouts.map((c) => c.title), ['One', 'Two']);
  assert.strictEqual(text, 'between');
});

test('a plain blockquote is not a callout and stays in the text', () => {
  const md = '> just a quote\n> [!not at first line]';
  assert.deepStrictEqual(splitCallouts(md), { text: md, callouts: [] });
});

test('Sean banner preset off by default, on -> needs-you', () => {
  const md = ['Intro', BANNER, 'After'].join('\n');
  assert.deepStrictEqual(parseCallouts(md), []);
  assert.deepStrictEqual(parseCallouts(md, { seanBanner: true }), [
    { type: 'needs-you', title: 'Needs you', body: 'Pick the tunnel\nApprove the push', options: [] },
  ]);
  assert.strictEqual(splitCallouts(md, { seanBanner: true }).text, 'Intro\nAfter');
});

test('a banner with no numbered asks is left as text', () => {
  const md = ['x', '████', 'y'].join('\n');
  assert.deepStrictEqual(splitCallouts(md, { seanBanner: true }), { text: md, callouts: [] });
});

test('banner inside a code fence ignored', () => {
  const md = ['```', BANNER, '```'].join('\n');
  assert.deepStrictEqual(parseCallouts(md, { seanBanner: true }), []);
});

test('banner and blockquote callouts come out in text order', () => {
  const md = ['> [!done] First', BANNER].join('\n\n');
  assert.deepStrictEqual(parseCallouts(md, { seanBanner: true }).map((c) => c.type), ['done', 'needs-you']);
});

test('limits: 20 callouts, title 200, options 8 x 80', () => {
  const many = Array.from({ length: 25 }, (_, i) => `> [!info] n${i}`).join('\n\n');
  const { text, callouts } = splitCallouts(many);
  assert.strictEqual(callouts.length, LIMITS.maxCallouts);
  assert.ok(text.includes('n20') && !text.includes('n19'));
  const [c] = parseCallouts(`> [!info] ${'t'.repeat(300)}\n> options: ${Array.from({ length: 12 }, () => 'o'.repeat(100)).join(' | ')}`);
  assert.strictEqual(c.title.length, 200);
  assert.strictEqual(c.options.length, 8);
  assert.ok(c.options.every((o) => o.length === 80));
});

test('non-string input gives nothing', () => {
  assert.deepStrictEqual(parseCallouts(undefined), []);
  assert.deepStrictEqual(splitCallouts(null), { text: '', callouts: [] });
});
