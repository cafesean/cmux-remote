'use strict';
// p41 D197 (HMX-84): a session wrapped its NEEDS YOU banner in a ``` fence, so no callout was made.
const test = require('node:test');
const assert = require('node:assert');
const { splitCallouts } = require('../sessions/callouts.js');

const opts = { seanBanner: true };
const BANNER = ['█████████████████████', '██  NEEDS YOU', '██  1. Ship it? [yes (rec) / no]', '██  2. Retry login? [now / later]', '█████████████████████'].join('\n');
const need = (body) => [{ type: 'needs-you', title: 'Needs you', options: [], body }];

test('D197: fenced █ banner at the end lifts, fence dropped', () => {
  for (const f of ['```', '~~~', '```text']) {
    const close = f.startsWith('~') ? '~~~' : '```';
    const r = splitCallouts(`Done.\n\n${f}\n${BANNER}\n${close}\n`, opts);
    assert.deepStrictEqual(r.callouts, need('Ship it? [yes (rec) / no]\nRetry login? [now / later]'));
    assert.strictEqual(r.text, 'Done.');
  }
});

test('D197: fenced ⛔ NEEDS YOU list at the end lifts', () => {
  const r = splitCallouts('Report.\n\n```\n⛔ NEEDS YOU:\n1. Approve push? [yes (rec) / no]\n```', opts);
  assert.deepStrictEqual(r.callouts, need('Approve push? [yes (rec) / no]'));
  assert.strictEqual(r.text, 'Report.');
});

test('D197: fenced banner mid-message stays example text', () => {
  const md = `Rule:\n\n\`\`\`\n${BANNER}\n\`\`\`\n\nThat is the format.`;
  const r = splitCallouts(md, opts);
  assert.deepStrictEqual(r.callouts, []);
  assert.strictEqual(r.text, md);
});

test('D197: trailing fence of ordinary code, and indented banner, stay untouched', () => {
  const code = 'Run:\n\n```\nnpm test\n```';
  assert.deepStrictEqual(splitCallouts(code, opts), { text: code, callouts: [] });
  const ind = `Eg:\n\n    ${BANNER.split('\n').join('\n    ')}`;
  assert.deepStrictEqual(splitCallouts(ind, opts).callouts, []);
});

test('D197: without seanBanner a fenced banner is not lifted', () => {
  assert.deepStrictEqual(splitCallouts(`x\n\n\`\`\`\n${BANNER}\n\`\`\``).callouts, []);
});
