'use strict';
// p41 k110: the app forwards Cmd/Opt combos from the Mac screen's live keyboard; these reach the Mac.
const test = require('node:test');
const assert = require('node:assert');
const { parseKey } = require('../lib/mac-screen');

test('k110: Save, Open, reopen tab and Option+Tab are allowed', () => {
  for (const [k, m] of [['s', ['cmd']], ['o', ['cmd']], ['t', ['cmd', 'shift']], ['tab', ['opt']], ['tab', ['shift', 'opt']]]) {
    assert.ok(parseKey(k, m), `${m.join('+')}+${k}`);
  }
});

test('k110: Cmd+Q and arbitrary Cmd letters stay refused', () => {
  assert.strictEqual(parseKey('q', ['cmd']), null);
  assert.strictEqual(parseKey('b', ['cmd']), null);
});
