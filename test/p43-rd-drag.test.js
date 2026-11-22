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

// JXA ptr(): run the shipped script text against a fake $ that records every event and field set.
const { JXA_INPUT } = require('../lib/mac-screen');
function runPtr(P, cursor) {
  const src = JXA_INPUT.slice(JXA_INPUT.indexOf('function ptr(P)'), JXA_INPUT.indexOf('function run()'));
  const events = [];
  const $ = {
    kCGMouseButtonLeft: 0, kCGEventMouseMoved: 5, kCGEventLeftMouseDown: 1, kCGEventLeftMouseDragged: 6, kCGEventLeftMouseUp: 2,
    kCGMouseEventClickState: 1, kCGMouseEventDeltaX: 4, kCGMouseEventDeltaY: 5,
    CGEventCreateMouseEvent: (_s, t, pt) => ({ t, pt, f: {} }),
    CGEventSetIntegerValueField: (e, k, v) => { e.f[k] = v; },
    CGEventCreate: () => ({}), CGEventGetLocation: () => cursor,
  };
  const disp = () => ({ x: 0, y: 0, w: 1000, h: 500 });
  new Function('$', 'disp', 'post', src + '; return ptr;')($, disp, (e) => events.push(e))(P);
  return events;
}

test('JXA ptr: down, drag and up carry clickState 1; drag carries deltaX/deltaY from the cursor', () => {
  const dn = runPtr({ kind: 'down', fx: 0.1, fy: 0.2 }, { x: 0, y: 0 });
  assert.deepStrictEqual(dn.map((e) => e.t), [5, 1]);
  assert.strictEqual(dn[1].f[1], 1);
  const dr = runPtr({ kind: 'drag', fx: 0.5, fy: 0.5 }, { x: 100, y: 100 });
  assert.strictEqual(dr.length, 1);
  assert.strictEqual(dr[0].t, 6);
  assert.deepStrictEqual(dr[0].f, { 1: 1, 4: 400, 5: 150 });
  const up = runPtr({ kind: 'up', fx: 0.5, fy: 0.5 }, { x: 500, y: 250 });
  assert.strictEqual(up[0].t, 2);
  assert.strictEqual(up[0].f[1], 1);
  const mv = runPtr({ kind: 'move', fx: 0.5, fy: 0.5 }, { x: 0, y: 0 });
  assert.deepStrictEqual(mv[0].f, {});
});
