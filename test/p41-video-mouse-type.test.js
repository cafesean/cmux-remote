'use strict';
// p41 D305: the app sends video mouse input as { t: 'mouse', type: 'move' | 'down' | 'drag' | 'up' }.
// videoItem read only `kind`, so the live pointer and drags over video never reached the Mac.
const test = require('node:test');
const assert = require('node:assert');
const { videoItem } = require('../lib/mac-screen');

test('D305: the app shape (type) passes as a mouse item with kind', () => {
  for (const type of ['move', 'down', 'drag', 'up']) {
    assert.deepStrictEqual(videoItem({ seq: 1, t: 'mouse', type, fx: 0.25, fy: 0.75 }),
      { seq: 1, t: 'mouse', kind: type, fx: 0.25, fy: 0.75, button: 'left' });
  }
});

test('D305: the kind shape still passes; an unknown phase is dropped', () => {
  assert.strictEqual(videoItem({ seq: 2, t: 'mouse', kind: 'move', fx: 0.5, fy: 0.5 }).kind, 'move');
  assert.strictEqual(videoItem({ seq: 3, t: 'mouse', type: 'hover', fx: 0.5, fy: 0.5 }), null);
  assert.strictEqual(videoItem({ seq: 4, t: 'mouse', fx: 0.5, fy: 0.5 }), null);
});
