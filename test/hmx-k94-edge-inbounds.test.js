// k94 (HyprMux: Dock and hot corners from Remote Desktop): fraction 1 maps to the display's LAST point, never
// d.x + d.w, which is outside the display (the next display's first column, or nowhere).
const test = require('node:test');
const assert = require('node:assert');
const { JXA_INPUT } = require('../lib/mac-screen');

const src = /function inPt\(d,P\)\{[^\n]*?\};\}/.exec(JXA_INPUT);
test('JXA input script defines inPt and every pointer op uses it', () => {
  assert.ok(src, 'inPt in JXA_INPUT');
  assert.ok(!/P\.fx\*d\.w,y:d\.y\+P\.fy\*d\.h\}/.test(JXA_INPUT), 'no raw d.x+fx*d.w point left');
});

test('inPt keeps the far edges on the display', () => {
  const inPt = new Function(`${src[0]}; return inPt;`)();
  const d = { x: -1920, y: -298, w: 1920, h: 1080 };
  assert.deepStrictEqual(inPt(d, { fx: 1, fy: 1 }), { x: -1, y: -298 + 1079 });
  assert.deepStrictEqual(inPt(d, { fx: 0, fy: 0 }), { x: -1920, y: -298 });
  assert.deepStrictEqual(inPt(d, { fx: 0.5, fy: 0.5 }), { x: -960, y: -298 + 540 });
});
