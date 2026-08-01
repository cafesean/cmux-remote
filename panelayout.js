// Pane layout maths — pure, dependency-free, unit-tested (test/pane-layout.test.js).
//
// `cmux rpc pane.list` answers with DESKTOP pixel frames: a `container_frame` plus one `pixel_frame`
// per pane. Two things make those unusable as-is for the mirror:
//   1. `container_frame` is the WINDOW's content box — it includes the sidebar, so the leftmost pane
//      starts at x≈240 and the rightmost pane's right edge can exceed container_frame.width. Normalising
//      against the container therefore squashes the mirror and leaves a phantom left gutter.
//   2. cmux exposes no split TREE over the socket (no directions, no divider list), so the mirror can't
//      reconstruct nesting. It doesn't need to: absolutely-positioned boxes reproduce any split tree,
//      and the DIVIDERS can be recovered from the boxes themselves (two panes whose facing edges touch
//      and whose spans overlap share a divider).
// So: normalise against the BOUNDING BOX of the panes, and derive the handles geometrically.
'use strict';

const EDGE_TOL = 24;      // desktop px — a divider is ~1px of chrome plus each side's padding
const SPAN_MIN = 24;      // desktop px — ignore corner touches; a handle needs real shared edge

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Pull the panes we can actually use out of a raw `pane.list` payload.
function readPanes(raw) {
  const out = [];
  for (const p of (raw && raw.panes) || []) {
    const f = p && p.pixel_frame;
    const x = num(f && f.x), y = num(f && f.y), w = num(f && f.width), h = num(f && f.height);
    if (x == null || y == null || !w || !h || w <= 0 || h <= 0) continue;   // mid-teardown pane
    out.push({
      ref: String(p.ref || ''),
      id: String(p.id || p.ref || ''),
      index: Number.isFinite(p.index) ? p.index : out.length,
      focused: !!p.focused,
      cols: num(p.columns) || 0,
      rows: num(p.rows) || 0,
      selectedSurface: String(p.selected_surface_id || p.selected_surface_ref || ''),
      selectedSurfaceRef: String(p.selected_surface_ref || ''),
      surfaceRefs: Array.isArray(p.surface_refs) ? p.surface_refs.map(String) : [],
      surfaceIds: Array.isArray(p.surface_ids) ? p.surface_ids.map(String) : [],
      px: { x, y, w, h },
    });
  }
  return out;
}

// Derive the draggable dividers from the boxes. `a` is the pane on the LEFT (axis 'x') or ABOVE
// (axis 'y') — the side that GROWS when the divider is dragged toward b. Panes on both sides are
// listed because a divider can face several panes at once (a column split against a stack).
function deriveHandles(panes) {
  const handles = [];
  const keyOf = (axis, pos) => axis + ':' + Math.round(pos);
  const byKey = new Map();
  for (const a of panes) {
    for (const b of panes) {
      if (a === b) continue;
      // vertical divider: a's right edge meets b's left edge, rows overlap
      if (Math.abs((a.px.x + a.px.w) - b.px.x) <= EDGE_TOL) {
        const s = Math.max(a.px.y, b.px.y), e = Math.min(a.px.y + a.px.h, b.px.y + b.px.h);
        if (e - s >= SPAN_MIN) addHandle('x', (a.px.x + a.px.w + b.px.x) / 2, s, e, a, b);
      }
      // horizontal divider: a's bottom edge meets b's top edge, columns overlap
      if (Math.abs((a.px.y + a.px.h) - b.px.y) <= EDGE_TOL) {
        const s = Math.max(a.px.x, b.px.x), e = Math.min(a.px.x + a.px.w, b.px.x + b.px.w);
        if (e - s >= SPAN_MIN) addHandle('y', (a.px.y + a.px.h + b.px.y) / 2, s, e, a, b);
      }
    }
  }
  function addHandle(axis, pos, s, e, a, b) {
    const k = keyOf(axis, pos);
    let hd = byKey.get(k);
    if (!hd) { hd = { axis, pos, start: s, end: e, a: [], b: [] }; byKey.set(k, hd); handles.push(hd); }
    hd.start = Math.min(hd.start, s); hd.end = Math.max(hd.end, e);
    if (!hd.a.includes(a.ref)) hd.a.push(a.ref);
    if (!hd.b.includes(b.ref)) hd.b.push(b.ref);
  }
  return handles;
}

// A workspace cmux has never DISPLAYED has panes but no geometry — every pixel_frame (and the
// container) comes back 0×0, so readPanes drops the lot and the mirror would show nothing at all for a
// workspace you just created. Fall back to equal tiles in pane order: it mirrors the right surfaces in
// a sane arrangement, and `estimated` tells the client not to offer drag handles (there is no real
// divider to move yet — cmux itself has no geometry to resize).
function estimateLayout(raw, extra) {
  const src = (raw && raw.panes) || [];
  const n = src.length;
  if (!n) return { panes: [], handles: [], box: { w: 0, h: 0 }, estimated: true, ...extra };
  const panes = src.map((p, i) => ({
    ref: String(p.ref || ''), id: String(p.id || p.ref || ''), index: Number.isFinite(p.index) ? p.index : i,
    focused: !!p.focused, cols: 0, rows: 0,
    selectedSurface: String(p.selected_surface_id || p.selected_surface_ref || ''),
    selectedSurfaceRef: String(p.selected_surface_ref || ''),
    surfaceRefs: Array.isArray(p.surface_refs) ? p.surface_refs.map(String) : [],
    surfaceIds: Array.isArray(p.surface_ids) ? p.surface_ids.map(String) : [],
    x: i / n, y: 0, w: 1 / n, h: 1, pxw: 0, pxh: 0,
  }));
  const focused = panes.find((p) => p.focused);
  return { box: { w: 0, h: 0 }, focusedPane: focused ? focused.ref : null, panes, handles: [], estimated: true, ...extra };
}

// Normalise everything into 0..1 of the pane BOUNDING BOX, and keep the box's desktop size so a drag
// measured in mirror pixels can be converted back into the desktop pixels `pane.resize` moves.
function normalizeLayout(raw, extra = {}) {
  const panes = readPanes(raw);
  if (!panes.length) {
    if (raw && Array.isArray(raw.panes) && raw.panes.length) return estimateLayout(raw, extra);
    return { panes: [], handles: [], box: { w: 0, h: 0 }, ...extra };
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of panes) {
    x0 = Math.min(x0, p.px.x); y0 = Math.min(y0, p.px.y);
    x1 = Math.max(x1, p.px.x + p.px.w); y1 = Math.max(y1, p.px.y + p.px.h);
  }
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const fx = (v) => Math.min(1, Math.max(0, (v - x0) / bw));
  const fy = (v) => Math.min(1, Math.max(0, (v - y0) / bh));
  const handles = deriveHandles(panes).map((hd) => ({
    axis: hd.axis,
    pos: hd.axis === 'x' ? fx(hd.pos) : fy(hd.pos),
    start: hd.axis === 'x' ? fy(hd.start) : fx(hd.start),
    end: hd.axis === 'x' ? fy(hd.end) : fx(hd.end),
    a: hd.a, b: hd.b,
  }));
  const focused = panes.find((p) => p.focused);
  return {
    box: { w: Math.round(bw), h: Math.round(bh) },
    focusedPane: focused ? focused.ref : null,
    panes: panes
      .map((p) => ({
        ref: p.ref, id: p.id, index: p.index, focused: p.focused,
        cols: p.cols, rows: p.rows,
        selectedSurface: p.selectedSurface, selectedSurfaceRef: p.selectedSurfaceRef,
        surfaceRefs: p.surfaceRefs, surfaceIds: p.surfaceIds,
        // fractions of the bounding box, plus the desktop size (drag → resize conversion)
        x: fx(p.px.x), y: fy(p.px.y), w: p.px.w / bw, h: p.px.h / bh,
        pxw: Math.round(p.px.w), pxh: Math.round(p.px.h),
      }))
      // paint order: top-to-bottom, left-to-right — stable across polls even as refs churn
      .sort((m, n) => (m.y - n.y) || (m.x - n.x)),
    handles,
    ...extra,
  };
}

module.exports = { readPanes, deriveHandles, normalizeLayout, estimateLayout, EDGE_TOL, SPAN_MIN };
