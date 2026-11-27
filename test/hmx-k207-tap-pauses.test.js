'use strict';
// HMX k207 ("double click does nothing" in Remote Desktop): the JXA tap posted its events back to back and the Mac
// lost the second click of a double-click (measured: 2 of 3 runs gave down/up only). The shipped script now waits
// 20 ms between every event of a click, like the screen helper (InputCore tap) and like keys.
const test = require('node:test');
const assert = require('node:assert');
const { JXA_INPUT } = require('../lib/mac-screen');

function runTap(P) {
  const src = JXA_INPUT.slice(JXA_INPUT.indexOf('function mouse(P)'), JXA_INPUT.indexOf('function scroll(P)'));
  const log = [];
  const $ = {
    kCGMouseButtonLeft: 0, kCGMouseButtonRight: 1, kCGEventMouseMoved: 5, kCGEventLeftMouseDown: 1, kCGEventLeftMouseUp: 2,
    kCGEventRightMouseDown: 3, kCGEventRightMouseUp: 4, kCGMouseEventClickState: 1,
    CGEventCreateMouseEvent: (_s, t) => ({ t, f: {} }),
    CGEventSetIntegerValueField: (e, k, v) => { e.f[k] = v; },
  };
  const disp = () => ({ x: 0, y: 0, w: 1000, h: 500 });
  const inPt = () => ({ x: 1, y: 1 });
  const r = new Function('$', 'disp', 'inPt', 'post', 'delay', src + '; return mouse;')(
    $, disp, inPt, (e) => log.push(e.f[1] ? `${e.t}:${e.f[1]}` : `${e.t}`), (s) => log.push(`wait${s}`))(P);
  return { r, log };
}

test('k207: a double tap is move, down1, up1, down2, up2 with 20 ms between every event', () => {
  const { r, log } = runTap({ fx: 0.5, fy: 0.5, double: true });
  assert.strictEqual(r, 'ok');
  assert.deepStrictEqual(log, ['5', 'wait0.02', '1:1', 'wait0.02', '2:1', 'wait0.02', '1:2', 'wait0.02', '2:2']);
});

test('k207: a single tap and a right tap keep the same pauses', () => {
  assert.deepStrictEqual(runTap({ fx: 0.5, fy: 0.5 }).log, ['5', 'wait0.02', '1:1', 'wait0.02', '2:1']);
  assert.deepStrictEqual(runTap({ fx: 0.5, fy: 0.5, button: 'right' }).log, ['5', 'wait0.02', '3:1', 'wait0.02', '4:1']);
});
