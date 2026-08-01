'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { readPanes, deriveHandles, normalizeLayout } = require('../panelayout');

// A pane as `cmux rpc pane.list` reports it.
const pane = (ref, x, y, w, h, extra = {}) => ({
  ref, id: 'ID-' + ref, index: extra.index != null ? extra.index : 0,
  focused: !!extra.focused, columns: extra.columns || 80, rows: extra.rows || 50,
  selected_surface_id: extra.surface || ('SF-' + ref), selected_surface_ref: extra.surfaceRef || 'surface:1',
  surface_refs: extra.surface_refs || ['surface:1'], surface_ids: extra.surface_ids || ['SF-' + ref],
  pixel_frame: { x, y, width: w, height: h },
});

// The shape observed live on cmux 0.64.20: three columns, sidebar-offset container, and a
// container_frame.width (1680) NARROWER than the panes' real extent (240 → 1920).
const THREE_COLS = {
  container_frame: { width: 1680, height: 1022 },
  panes: [
    pane('pane:32', 240, 28, 669, 1022, { index: 0 }),
    pane('pane:30', 909, 28, 743, 1022, { index: 1, focused: true }),
    pane('pane:25', 1652, 28, 268, 1022, { index: 2 }),
  ],
};

test('readPanes: skips panes with no usable frame (mid-teardown)', () => {
  const got = readPanes({ panes: [pane('pane:1', 0, 0, 100, 100), { ref: 'pane:2' },
    pane('pane:3', 0, 0, 0, 100)] });
  assert.deepStrictEqual(got.map((p) => p.ref), ['pane:1']);
});

test('normalizeLayout: normalises against the pane bbox, NOT container_frame', () => {
  const l = normalizeLayout(THREE_COLS);
  // bbox = 240..1920 => 1680 wide by coincidence of arithmetic, but x0 is 240 not 0:
  assert.strictEqual(l.box.w, 1680);
  assert.strictEqual(l.panes[0].ref, 'pane:32');
  assert.strictEqual(l.panes[0].x, 0);                       // leftmost pane starts AT the left edge
  assert.ok(Math.abs(l.panes[0].w - 669 / 1680) < 1e-9);
  const last = l.panes[l.panes.length - 1];
  assert.ok(Math.abs((last.x + last.w) - 1) < 1e-6);          // rightmost pane ends AT the right edge
});

test('normalizeLayout: fractions of every pane sum to the full width with no gaps', () => {
  const l = normalizeLayout(THREE_COLS);
  const spanned = l.panes.reduce((acc, p) => acc + p.w, 0);
  assert.ok(Math.abs(spanned - 1) < 0.01, 'columns should tile the box: ' + spanned);
  for (const p of l.panes) { assert.ok(p.y === 0 && Math.abs(p.h - 1) < 1e-9); }
});

test('normalizeLayout: carries desktop px size (drag px -> resize px conversion)', () => {
  const l = normalizeLayout(THREE_COLS);
  assert.strictEqual(l.panes[0].pxw, 669);
  assert.strictEqual(l.panes[0].pxh, 1022);
  assert.strictEqual(l.focusedPane, 'pane:30');
});

test('deriveHandles: one divider per touching edge, a = the left/top side', () => {
  const hs = deriveHandles(readPanes(THREE_COLS));
  assert.strictEqual(hs.length, 2);
  const [h1, h2] = hs.sort((a, b) => a.pos - b.pos);
  assert.strictEqual(h1.axis, 'x');
  assert.deepStrictEqual(h1.a, ['pane:32']);
  assert.deepStrictEqual(h1.b, ['pane:30']);
  assert.deepStrictEqual(h2.a, ['pane:30']);
  assert.deepStrictEqual(h2.b, ['pane:25']);
});

test('deriveHandles: a full-width divider against a stack lists both facing panes', () => {
  //  +---------+---------+
  //  |  top-l  |  top-r  |
  //  +---------+---------+   <- one horizontal divider, two panes above it
  //  |       bottom      |
  //  +-------------------+
  const panes = readPanes({ panes: [
    pane('pane:1', 0, 0, 500, 300),
    pane('pane:2', 500, 0, 500, 300),
    pane('pane:3', 0, 300, 1000, 300),
  ] });
  const hs = deriveHandles(panes);
  const horiz = hs.filter((h) => h.axis === 'y');
  assert.strictEqual(horiz.length, 1);
  assert.deepStrictEqual(horiz[0].a.sort(), ['pane:1', 'pane:2']);
  assert.deepStrictEqual(horiz[0].b, ['pane:3']);
  assert.strictEqual(hs.filter((h) => h.axis === 'x').length, 1);   // top-l | top-r
});

test('deriveHandles: a corner touch is not a divider', () => {
  //  pane:1 bottom-right corner touches pane:2 top-left corner only.
  const panes = readPanes({ panes: [
    pane('pane:1', 0, 0, 100, 100),
    pane('pane:2', 100, 100, 100, 100),
  ] });
  assert.deepStrictEqual(deriveHandles(panes), []);
});

test('normalizeLayout: handle spans are fractions of the OTHER axis', () => {
  const l = normalizeLayout({ panes: [
    pane('pane:1', 0, 0, 500, 600),
    pane('pane:2', 500, 0, 500, 300),
    pane('pane:3', 500, 300, 500, 300),
  ] });
  const vert = l.handles.filter((h) => h.axis === 'x');
  assert.strictEqual(vert.length, 1);
  assert.ok(Math.abs(vert[0].pos - 0.5) < 0.01);
  assert.strictEqual(vert[0].start, 0);
  assert.strictEqual(vert[0].end, 1);            // pane:1 faces BOTH right-hand panes: full height
  assert.deepStrictEqual(vert[0].a, ['pane:1']);
  assert.deepStrictEqual(vert[0].b.sort(), ['pane:2', 'pane:3']);
});

test('normalizeLayout: single pane has no handles and fills the box', () => {
  const l = normalizeLayout({ panes: [pane('pane:9', 240, 28, 800, 900, { focused: true })] });
  assert.deepStrictEqual(l.handles, []);
  assert.deepStrictEqual(
    { x: l.panes[0].x, y: l.panes[0].y, w: l.panes[0].w, h: l.panes[0].h },
    { x: 0, y: 0, w: 1, h: 1 });
});

test('normalizeLayout: empty / failed pane.list degrades, never throws', () => {
  assert.deepStrictEqual(normalizeLayout(null).panes, []);
  assert.deepStrictEqual(normalizeLayout({ panes: [] }).handles, []);
});

// A workspace cmux has never displayed answers with every frame 0x0 (observed live right after
// `new-workspace` + `new-pane`). Dropping those panes would blank the mirror for a workspace whose
// tabs are perfectly readable.
test('normalizeLayout: zero-size frames fall back to equal tiles, flagged estimated', () => {
  const l = normalizeLayout({
    container_frame: { width: 0, height: 0 },
    panes: [pane('pane:34', 0, 0, 0, 0, { focused: true }), pane('pane:36', 0, 0, 0, 0),
      pane('pane:35', 0, 0, 0, 0)],
  });
  assert.strictEqual(l.estimated, true);
  assert.strictEqual(l.panes.length, 3);
  assert.strictEqual(l.focusedPane, 'pane:34');
  assert.deepStrictEqual(l.panes.map((p) => p.w), [1 / 3, 1 / 3, 1 / 3]);
  assert.ok(Math.abs(l.panes[2].x - 2 / 3) < 1e-9);
  assert.deepStrictEqual(l.handles, [], 'no real dividers exist yet — nothing to drag');
  assert.strictEqual(l.panes[0].selectedSurface, 'SF-pane:34');
});

test('normalizeLayout: real geometry is never flagged estimated', () => {
  assert.strictEqual(normalizeLayout(THREE_COLS).estimated, undefined);
});
