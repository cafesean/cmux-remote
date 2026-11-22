'use strict';
// Remote Desktop drag: a press, many drag moves, release. Superseded moves must be acked (posted) so the
// client's pending window never fills; the app wire names the mouse kind "type".
const test = require('node:test');
const assert = require('node:assert');
const { coalesceMoves, createHeld } = require('../lib/screen-stream');

const m = (seq, type) => ({ seq, t: 'mouse', type, fx: seq / 100, fy: 0.5 });

test('press, 10 drags, release: down, last drag, up kept; 9 drags acked as superseded', () => {
  const items = [m(1, 'down'), ...Array.from({ length: 10 }, (_, i) => m(2 + i, 'drag')), m(12, 'up')];
  const r = coalesceMoves(items);
  assert.deepStrictEqual(r.items.map((x) => [x.seq, x.type]), [[1, 'down'], [11, 'drag'], [12, 'up']]);
  assert.deepStrictEqual(r.dropped.map((x) => x.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('moves and drags never merge across kinds or a press', () => {
  const r = coalesceMoves([m(1, 'move'), m(2, 'move'), m(3, 'down'), m(4, 'drag'), m(5, 'move')]);
  assert.deepStrictEqual(r.items.map((x) => x.seq), [2, 3, 4, 5]);
  assert.deepStrictEqual(r.dropped.map((x) => x.seq), [1]);
});

test('held tracks a down sent with the app wire field "type" until its up is posted', () => {
  const h = createHeld();
  h.forward(m(1, 'down'));
  assert.strictEqual(h.empty(), false);
  h.forward(m(2, 'up'));
  h.posted(2);
  assert.strictEqual(h.empty(), true);
});
