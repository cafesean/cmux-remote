'use strict';
// p41 D190 (Sean: "the NEEDS YOU buttons no longer appear"): the chief's SWEEP replies end with a plain
// `⛔ NEEDS YOU:` line + numbered asks (chief-of-staff SKILL "SWEEP reply" shape), not the █ banner. Only the
// banner was lifted into a needs-you callout, so those replies reached the app as plain text with no buttons.
// Fixtures are real chief replies (2026-11-08), names and hosts scrubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { splitCallouts } = require('../sessions/callouts.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'needs-you', n), 'utf8');
const ASK2 = 'App setup like the reference site (ask a1): download button + phone "Set Up a Mac" link? [build both (rec) / download button only / later]';

test('D190: the full █ banner still lifts to a needs-you callout', () => {
  const { callouts } = splitCallouts(fx('banner.md'), { seanBanner: true });
  assert.deepStrictEqual(callouts, [{ type: 'needs-you', title: 'Needs you', options: [],
    body: 'Add the app download button + phone "Set Up a Mac" link? [build both (rec) / download button only / later]' }]);
});

test('D190: a SWEEP `⛔ NEEDS YOU:` list lifts to the same needs-you callout', () => {
  const { text, callouts } = splitCallouts(fx('sweep-list.md'), { seanBanner: true });
  assert.deepStrictEqual(callouts, [{ type: 'needs-you', title: 'Needs you', options: [],
    body: `Retry Google sign-in at hub.example.test. It unblocks worker-b and worker-c.\n${ASK2}` }]);
  assert.ok(!/NEEDS YOU/.test(text), 'the list leaves the text');
  assert.ok(text.endsWith('Chief context is at 34%; load LOCAL.'));
});

test('D190: SNAPSHOT one-line `⛔ NEEDS YOU: <ask>` and a bold header lift too', () => {
  assert.deepStrictEqual(splitCallouts('Table\n\n⛔ NEEDS YOU: Approve the push? [yes / no]', { seanBanner: true }).callouts,
    [{ type: 'needs-you', title: 'Needs you', body: 'Approve the push? [yes / no]', options: [] }]);
  assert.deepStrictEqual(splitCallouts('**⛔ NEEDS YOU:**\n1. Pick one [a / b]', { seanBanner: true }).callouts,
    [{ type: 'needs-you', title: 'Needs you', body: 'Pick one [a / b]', options: [] }]);
});

test('D190: no false positives (prose, quoted, fenced, header with no asks, preset off)', () => {
  const none = (md, o = { seanBanner: true }) => assert.deepStrictEqual(splitCallouts(md, o), { text: md, callouts: [] });
  none('My replies used a plain "⛔ NEEDS YOU:" list instead of the banner.');
  none('```\n⛔ NEEDS YOU:\n1. example\n```');
  none('⛔ NEEDS YOU:\n\nNothing numbered here.');
  none('Nothing needs you.');
  none(fx('sweep-list.md'), {});
});
