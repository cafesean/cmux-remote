// p11 — three operator-reported defects, proved at the layer each one lives in.
//
//   1. A new workspace came up in the PHONE layout on a desktop: pills on top, no pane header. The
//      split/solo decision was `!canSplit() || panes.length <= 1`, and a new workspace has exactly one
//      pane, forever. Proved by running the shipped visiblePanes/syncSoloClass.
//   2. There was no way to rename a workspace anywhere in the stack, so every workspace wore the title
//      of whatever tab happened to be in front of it. Proved through a REAL bridge child.
//   3. A pane showed one screen of history where 2000 rows were expected. cmux caps terminal.replay at
//      240 scrollback rows and takes no parameter to raise it, so the rows above it have to come from
//      `read-screen --scrollback` and be JOINED to the styled grid. The join is the risk — count-based
//      arithmetic drifts, because read-screen trims trailing blanks and replay does not — so the seam
//      is found by content, and that is what most of these tests measure.
//
// Client-side claims use the p8 extract-and-run method (see p8-client-wiring.test.js): lift the exact
// shipped source of one function out of public/app.js, bind fakes to the seams it names, and run it. A
// regex would pass against the same text sitting in a comment; evaluating it cannot.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(REPO, 'bridge.js'), 'utf8');
const HTML = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');

// ---- extraction (same brace matcher as p8-client-wiring; a bad lift throws in new Function) ----
function matchBrace(src, open) {
  assert.equal(src[open], '{', 'matchBrace must start on a {');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces from offset ' + open);
}
function fnSrcIn(src, name, label) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, label + ' must declare function ' + name);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  return src.slice(m.index, matchBrace(src, open) + 1);
}
const appFn = (name) => fnSrcIn(APP, name, 'public/app.js');
const bridgeFn = (name) => fnSrcIn(BRIDGE, name, 'bridge.js');
// Build one lifted function with its seams bound by name.
function lift(src, name, seams) {
  const names = Object.keys(seams);
  const fn = new Function(...names, src + '\nreturn ' + name + ';');
  return fn(...names.map((n) => seams[n]));
}

// =====================================================================================
// Group A — the layout is a property of the VIEWPORT, not of the pane count
// =====================================================================================

// visiblePanes decides WHICH panes get painted and whether the survivor is blown up `solo` (which is
// what hides the pane header). One pane on a wide viewport must come back as the split view's single
// pane, NOT as a solo blow-up.
function buildVisiblePanes(panes, opts) {
  const o = opts || {};
  const status = [];
  const fn = lift(appFn('visiblePanes'), 'visiblePanes', {
    layoutPanes: () => panes,
    canSplit: () => o.canSplit !== false,
    MAX_PANES: o.maxPanes || 6,
    state: { focusPane: o.focusPane || null, tab: o.tab || null },
    setStatus: (m) => status.push(m),
  });
  return { fn, status };
}
const P = (id, extra) => Object.assign({ id, ref: 'pane:' + id, x: 0, y: 0, w: 1, h: 1 }, extra || {});

test('A1 one pane on a wide viewport is the split view — not a solo blow-up', () => {
  const { fn } = buildVisiblePanes([P('a', { focused: true })]);
  const out = fn();
  assert.equal(out.length, 1);
  assert.ok(!out[0].solo, 'a single pane must NOT be marked solo when the viewport can split — '
    + '`.pane.solo` is what hides the pane header, and hiding it is what showed the pills instead');
  assert.equal(out[0].id, 'a', 'and it is the pane the layout reported, not a rebuilt copy');
});

test('A2 one pane on a NARROW viewport is still the solo blow-up (the phone behaviour survives)', () => {
  const { fn } = buildVisiblePanes([P('a', { focused: true })], { canSplit: false });
  const out = fn();
  assert.equal(out.length, 1);
  assert.equal(out[0].solo, true, 'the phone still gets one terminal at a time');
  assert.deepEqual([out[0].x, out[0].y, out[0].w, out[0].h], [0, 0, 1, 1], 'blown up to full size');
});

test('A3 several panes on a wide viewport keep coming back whole', () => {
  const { fn } = buildVisiblePanes([P('a'), P('b'), P('c')]);
  assert.deepEqual(fn().map((p) => p.id), ['a', 'b', 'c']);
});

test('A4 past the cap: the focused pane is kept and the truncation is SAID, not silent', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const { fn, status } = buildVisiblePanes(ids.map((i) => P(i)), { maxPanes: 6, focusPane: 'h' });
  const out = fn();
  assert.equal(out.length, 6);
  assert.ok(out.some((p) => p.id === 'h'), 'the focused pane must be on screen even past the cap');
  assert.ok(status.some((m) => /6 of 8 panes/.test(m)), 'the reader is told panes are not painted');
});

// syncSoloClass is the other half: it toggles body.solo, and index.html hides #tabs unless body.solo.
function buildSyncSolo(panes, canSplit) {
  const cls = new Set();
  const body = { classList: { toggle: (n, on) => { if (on) cls.add(n); else cls.delete(n); } } };
  const fn = lift(appFn('syncSoloClass'), 'syncSoloClass', {
    document: { body },
    canSplit: () => canSplit,
    layoutPanes: () => panes,
  });
  return { fn, has: () => cls.has('solo') };
}

test('A5 body.solo (which is what shows the pill strip) keys on the viewport ALONE', () => {
  const wide1 = buildSyncSolo([P('a')], true);
  wide1.fn();
  assert.equal(wide1.has(), false, 'one pane, wide viewport → split view, no pills');

  const wideN = buildSyncSolo([P('a'), P('b')], true);
  wideN.fn();
  assert.equal(wideN.has(), false);

  const narrow = buildSyncSolo([P('a'), P('b')], false);
  narrow.fn();
  assert.equal(narrow.has(), true, 'narrow viewport → pills, whatever the pane count');
});

test('A6 the pill strip is still gated on body.solo in the shipped stylesheet', () => {
  assert.match(HTML, /body:not\(\.solo\)\s*#tabs\s*\{\s*display:\s*none/,
    'if this gate moved, A5 stops describing what the reader sees');
});

// =====================================================================================
// Group B — the history join (bridge.js): found by CONTENT, scanning from the end
// =====================================================================================

const normRow = lift(bridgeFn('normRow'), 'normRow', {});
const alignHistory = lift(bridgeFn('alignHistory'), 'alignHistory', { normRow });
const spansToText = lift(bridgeFn('spansToText'), 'spansToText', {});

test('B1 spansToText pads gaps to the column, like the client paints them', () => {
  const m = spansToText([
    { row: 0, column: 4, text: 'abc' },
    { row: 0, column: 0, text: '>>' },
    { row: 1, column: 0, text: 'x' },
  ]);
  assert.equal(m.get(0), '>>  abc', 'runs sorted by column, the gap filled with spaces');
  assert.equal(m.get(1), 'x');
});

test('B2 the seam is the LAST occurrence of the anchor, not the first', () => {
  // "line 27"/"line 28" appear twice; the replay window is the RECENT copy. A forward scan would put
  // the seam at 5 and silently drop 21 rows of history into the middle of the pane.
  const lines = ['a', 'b', 'c', 'd', 'e', 'line 27', 'line 28', 'f'];
  for (let i = 8; i < 26; i++) lines.push('pad ' + i);
  lines.push('line 27', 'line 28', 'line 29');
  assert.equal(alignHistory(lines, ['line 27', 'line 28', 'line 29']), lines.length - 3);
});

test('B3 a blank first styled row does not anchor — the offset walks to real content', () => {
  const lines = ['old 1', 'old 2', 'real', 'tail'];
  // styled window starts with two blank rows, then "real": the seam is 2 rows ABOVE the match.
  assert.equal(alignHistory(lines, ['', '', 'real', 'tail']), 0,
    'anchoring on "" would match at index 0 and claim the whole buffer as history');
});

test('B4 trailing whitespace differences do not break the join', () => {
  // read-screen keeps the row's trailing spaces; a reconstructed span row may not (or vice versa).
  assert.equal(alignHistory(['h1', 'h2', 'prompt $   '], ['prompt $']), 2);
});

test('B5 an anchor that is nowhere in the text is -1, not a guess', () => {
  assert.equal(alignHistory(['a', 'b'], ['nothing like it']), -1);
});

test('B6 all-blank styled rows cannot anchor anything', () => {
  assert.equal(alignHistory(['a', 'b'], ['', '  ', '']), -1);
});

// =====================================================================================
// Group C — /cmux/history and /cmux/rename-workspace through a REAL bridge child
// =====================================================================================
// The child gets a cmux SHIM, so these run the shipped route code (validation, the learned-cap early
// return, the read-screen spawn, the slice) without a real cmux — and the shim LOGS every call, which
// is how "it did not pay for a 2000-line read" becomes an assertion instead of a hope.

const VIEWPORT_ROWS = 34;
const SB_CAP = 240;
// A 300-line buffer whose replay window is the last 274 rows: history above it is lines 1..26.
function fixture(opts) {
  const o = opts || {};
  const sbRows = o.sbRows == null ? SB_CAP : o.sbRows;
  const total = o.total || 300;
  const lines = [];
  for (let i = 1; i <= total; i++) lines.push('line ' + i);
  const styledText = o.styledText || ((x) => x);             // how THIS cmux formats a replay row
  const styledFrom = total - (sbRows + VIEWPORT_ROWS);        // 300-274 = 26 rows of history
  const scrollback_spans = [];
  for (let r = 0; r < sbRows; r++) scrollback_spans.push({ row: r, column: 0, style_id: 0, text: styledText(lines[styledFrom + r]) });
  const row_spans = [];
  for (let r = 0; r < VIEWPORT_ROWS; r++) row_spans.push({ row: r, column: 0, style_id: 0, text: styledText(lines[styledFrom + sbRows + r]) });
  return {
    historyRows: styledFrom,
    screen: lines.join('\n') + '\n',                          // read-screen: trailing newline, blanks trimmed
    replay: JSON.stringify({
      seq: 7,
      render_grid: {
        active_screen: o.altScreen ? 'alternate' : 'primary',
        columns: 98, rows: VIEWPORT_ROWS, scrollback_rows: sbRows,
        styles: [{ id: 0, foreground: '#fff', background: '#000' }],
        scrollback_spans, row_spans, cursor: { row: 33, column: 0, visible: true },
      },
    }),
  };
}

async function bootWithShim(t, fx) {
  const { bootBridge } = require('./helpers/bridge-child');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p11-shim-'));
  const shim = path.join(dir, 'cmux');
  const log = path.join(dir, 'calls.log');
  await fsp.writeFile(shim, '#!/bin/sh\n'
    + 'printf "%s\\n" "$*" >> "$CALL_LOG"\n'
    + 'case "$*" in\n'
    + '  *terminal.replay*) cat "$REPLAY_JSON" ;;\n'
    + '  *read-screen*) cat "$SCREEN_TXT" ;;\n'
    + '  *workspace-action*) echo "OK action" ;;\n'
    + '  *) echo "{}" ;;\n'
    + 'esac\n', { mode: 0o755 });
  await fsp.writeFile(path.join(dir, 'replay.json'), fx.replay);
  await fsp.writeFile(path.join(dir, 'screen.txt'), fx.screen);
  const br = await bootBridge({ env: {
    CMUX_BIN: shim, BRIDGE_SECRET: 'p11s', CALL_LOG: log,
    REPLAY_JSON: path.join(dir, 'replay.json'), SCREEN_TXT: path.join(dir, 'screen.txt'),
  } });
  t.after(async () => { await br.stop(); await fsp.rm(dir, { recursive: true, force: true }); });
  const H = { 'x-bridge-secret': 'p11s' };
  return {
    br,
    // Swap what the shim answers (the bridge process, and what it has learned, stay the same) and
    // clear the call log, so the next request's spawns can be asserted on their own.
    setFixture: async (next) => {
      await fsp.writeFile(path.join(dir, 'replay.json'), next.replay);
      await fsp.writeFile(path.join(dir, 'screen.txt'), next.screen);
      await fsp.writeFile(log, '');
    },
    calls: async () => (await fsp.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    get: async (pq) => {
      const r = await fetch(`${br.base}${pq}`, { headers: H });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    post: async (pq, body) => {
      const r = await fetch(`${br.base}${pq}`, { method: 'POST',
        headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
  };
}
const SURFACE = 'AAAAAAAA-0000-0000-0000-00000000000F';
const WORKSPACE = 'BBBBBBBB-0000-0000-0000-0000000000CD';

test('C1 /cmux/history hands back exactly the rows ABOVE the replay window', async (t) => {
  const fx = fixture();
  const B = await bootWithShim(t, fx);
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.aligned, true);
  assert.equal(r.json.styledRows, SB_CAP + VIEWPORT_ROWS);
  assert.equal(r.json.rows.length, fx.historyRows, 'the 26 rows cmux replay cannot reach');
  assert.equal(r.json.rows[0], 'line 1');
  assert.equal(r.json.rows[r.json.rows.length - 1], 'line ' + fx.historyRows);
  // The join is the whole point: the last history row and the first styled row must be CONSECUTIVE,
  // with nothing duplicated and nothing swallowed.
  assert.equal(r.json.rows[r.json.rows.length - 1], 'line 26');
  assert.equal(JSON.parse(fx.replay).render_grid.scrollback_spans[0].text, 'line 27');
});

test('C2 `rows` bounds the total the pane holds — the newest history wins', async (t) => {
  const B = await bootWithShim(t, fixture());
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=280`);
  assert.equal(r.status, 200);
  // 280 asked − 274 styled = room for 6, and they must be the six CLOSEST to the styled grid.
  assert.equal(r.json.rows.length, 6);
  assert.deepEqual(r.json.rows, ['line 21', 'line 22', 'line 23', 'line 24', 'line 25', 'line 26']);
});

test('C3 once the cap is SEEN, a short buffer is answered from the replay alone — no 2000-line read', async (t) => {
  const B = await bootWithShim(t, fixture());
  const first = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(first.json.rows.length, 26, 'control: a saturated replay with history above it teaches the cap');
  await B.setFixture(fixture({ sbRows: 12, total: 12 + VIEWPORT_ROWS }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.complete, true, 'the replay window already reaches the top of the buffer');
  assert.deepEqual(r.json.rows, []);
  const calls = await B.calls();
  assert.ok(calls.some((c) => /terminal\.replay/.test(c)), 'control: it did ask for the grid');
  assert.ok(!calls.some((c) => /read-screen/.test(c)), 'and did NOT spawn a scrollback read');
});

test('C3b before any cap is seen, a short buffer PAYS the read — and still says complete', async (t) => {
  const B = await bootWithShim(t, fixture({ sbRows: 12, total: 12 + VIEWPORT_ROWS }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.complete, true, 'read-screen proved nothing sits above the window');
  assert.equal(r.json.aligned, true);
  assert.deepEqual(r.json.rows, []);
  assert.ok((await B.calls()).some((c) => /read-screen/.test(c)),
    'a hard-coded cap is how every pane on another cmux build got told "nothing above"');
});

test('C3c a build that caps replay LOWER than 240 still gets its history (the old shortcut hid it)', async (t) => {
  // scrollback_rows 100 on a 300-line buffer: 166 rows above the window. `100 < 240` used to answer
  // `complete: true` without looking — one screen + 100 rows, forever, on such a build.
  const B = await bootWithShim(t, fixture({ sbRows: 100 }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.ok(!r.json.complete);
  assert.equal(r.json.aligned, true);
  assert.equal(r.json.rows.length, 300 - (100 + VIEWPORT_ROWS));
  assert.equal(r.json.rows[r.json.rows.length - 1], 'line 166', 'consecutive with the first styled row');
  assert.equal(r.json.scrollbackRows, 100, 'the replay cap is reported, for diagnosing a remote build');
});

test('C3d caps that DISAGREE (not a fixed row count on this build) switch the shortcut off', async (t) => {
  // Only a LARGER saturated window can reveal the disagreement: once a cap is learned, anything below
  // it takes the shortcut. So: 200 first (learned), then 240 (>= 200, read, saturated too).
  const B = await bootWithShim(t, fixture({ sbRows: 200 }));
  await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  await B.setFixture(fixture({ sbRows: 240 }));
  const mid = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(mid.json.rows.length, 300 - (240 + VIEWPORT_ROWS), 'control: 240 was a saturated window too');
  await B.setFixture(fixture({ sbRows: 12, total: 12 + VIEWPORT_ROWS }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.json.complete, true);
  assert.ok((await B.calls()).some((c) => /read-screen/.test(c)),
    'with no single cap, "fewer rows than the cap" proves nothing — the read must be paid');
});

test('C3e a seam that cannot be found by content is spliced BY COUNT, marked approx — never dropped', async (t) => {
  // This cmux formats replay rows so differently from read-screen that no anchor matches at all.
  const B = await bootWithShim(t, fixture({ styledText: (x) => x.toUpperCase() }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.aligned, false);
  assert.equal(r.json.approx, true, 'the client is told the seam is a count, not a match');
  assert.equal(r.json.rows.length, 26, 'used to be rows: [] — "a pane shows very few lines"');
  assert.equal(r.json.rows[25], 'line 26');
  // …and a count-based guess is not evidence of the cap: the short buffer after it still pays the read.
  await B.setFixture(fixture({ sbRows: 12, total: 12 + VIEWPORT_ROWS }));
  await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.ok((await B.calls()).some((c) => /read-screen/.test(c)));
});

test('C4 an alt-screen surface reports altScreen and invents no past', async (t) => {
  const B = await bootWithShim(t, fixture({ altScreen: true }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.altScreen, true, 'cmux gives an alternate screen ZERO scrollback by design');
  assert.deepEqual(r.json.rows, []);
  assert.equal(r.json.aligned, false, '"no history exists" must not read as "not fetched yet"');
  const calls = await B.calls();
  assert.ok(!calls.some((c) => /read-screen/.test(c)),
    'the history read-screen reports there belongs to the buffer BEHIND the TUI — never prepend it');
});

test('C5 /cmux/history refuses a surface that is not a surface', async (t) => {
  const B = await bootWithShim(t, fixture());
  assert.equal((await B.get('/cmux/history?surface=workspace:2')).status, 400);
  assert.equal((await B.get('/cmux/history?surface=')).status, 400);
  assert.equal((await B.get('/cmux/history?surface=;%20rm%20-rf%20/')).status, 400);
});

test('C6 rename passes the title through to workspace-action, addressed by UUID', async (t) => {
  const B = await bootWithShim(t, fixture());
  const r = await B.post('/cmux/rename-workspace', { workspace: WORKSPACE, title: '  infra  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.title, 'infra', 'trimmed');
  const calls = await B.calls();
  const c = calls.find((x) => /workspace-action/.test(x));
  assert.ok(c, 'the rename must reach cmux');
  assert.match(c, /--action rename/);
  assert.match(c, new RegExp('--workspace ' + WORKSPACE),
    'refs do not resolve from a detached launchd bridge — the target must be the UUID');
  assert.match(c, /--title infra/);
});

test('C7 an emptied name CLEARS it — the only way to undo a rename', async (t) => {
  const B = await bootWithShim(t, fixture());
  const r = await B.post('/cmux/rename-workspace', { workspace: WORKSPACE, title: '   ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const c = (await B.calls()).find((x) => /workspace-action/.test(x));
  assert.match(c, /--action clear-name/);
  assert.ok(!/--title/.test(c), 'clear-name takes no title');
});

test('C8 rename sanitises what could not have been typed, and refuses a non-workspace', async (t) => {
  const B = await bootWithShim(t, fixture());
  assert.equal((await B.post('/cmux/rename-workspace', { workspace: 'surface:3', title: 'x' })).status, 400);
  assert.equal((await B.post('/cmux/rename-workspace', { workspace: '', title: 'x' })).status, 400);
  const r = await B.post('/cmux/rename-workspace', { workspace: WORKSPACE, title: 'one\ntwo\tthree' });
  assert.equal(r.json.title, 'one two three', 'newlines and tabs would corrupt the sidebar row');
  const long = await B.post('/cmux/rename-workspace', { workspace: WORKSPACE, title: 'z'.repeat(400) });
  assert.equal(long.json.title.length, 120);
});

// =====================================================================================
// Group D — the client actually paints the history, and never lets it fire keys
// =====================================================================================

// renderGrid is the one function that has to place history ABOVE the live grid, key it by its own text
// so live frames never rebuild it, and leave the tail-follow behaviour alone.
function buildRenderGrid(view, opts) {
  const o = opts || {};
  const refreshed = [];
  const seams = {
    styleSpan: () => {},
    buildRow: (spans) => mkNode(spans.map((s) => s.text).join(''), 'trow'),
    buildPlainRow: (text) => mkNode(text, 'trow hist'),
    rowSig: (spans) => spans.map((s) => s.column + ':' + s.style_id + ':' + s.text).join('|'),
    fitFont: () => {},
    getComputedStyle: () => ({ fontSize: '13px', lineHeight: '17px', paddingTop: '0', paddingBottom: '0' }),
    scrollToTail: () => { o.tailed && o.tailed(); },
    focusedView: () => null,
    updateJump: () => {},
    refreshHistory: (v) => refreshed.push(v),
  };
  return { fn: lift(appFn('renderGrid'), 'renderGrid', seams), refreshed };
}
// The smallest DOM a row list needs: childNodes with appendChild/replaceChild/removeChild.
function mkNode(text, cls) {
  return { nodeText: text, className: cls || '', getBoundingClientRect: () => ({ top: 0, bottom: 0 }) };
}
function mkScreen() {
  const kids = [];
  return {
    childNodes: kids,
    style: {}, clientHeight: 170, scrollHeight: 1000, scrollTop: 0,
    appendChild: (n) => { kids.push(n); return n; },
    replaceChild: (n, old) => { kids[kids.indexOf(old)] = n; return n; },
    removeChild: (n) => { kids.splice(kids.indexOf(n), 1); return n; },
    get lastChild() { return kids[kids.length - 1]; },
    getBoundingClientRect: () => ({ top: 0, bottom: 170 }),
  };
}
function mkView(hist) {
  return { screenEl: mkScreen(), rowSig: [], cols: 0, followTail: true, hist: hist || null, histLen: 0 };
}
const grid = (texts) => ({
  columns: 98, rows: texts.length,
  styles: [{ id: 0, background: '#000' }],
  spans: texts.map((t, r) => ({ row: r, column: 0, style_id: 0, text: t })),
});

test('D1 history is painted ABOVE the grid, in order, and counted in histLen', () => {
  const v = mkView(['h1', 'h2', 'h3']);
  buildRenderGrid(v).fn(v, grid(['live1', 'live2']));
  const rows = v.screenEl.childNodes.map((n) => n.nodeText);
  assert.deepEqual(rows, ['h1', 'h2', 'h3', 'live1', 'live2'],
    'the reader scrolls up out of the live grid straight into the older rows');
  assert.equal(v.histLen, 3, 'histLen is what tells the tap handler where the live grid starts');
  assert.equal(v.screenEl.childNodes[0].className, 'trow hist');
  assert.equal(v.screenEl.childNodes[3].className, 'trow');
});

test('D2 a live frame does NOT rebuild the history nodes', () => {
  const v = mkView(['h1', 'h2']);
  const R = buildRenderGrid(v);
  R.fn(v, grid(['a']));
  const before = v.screenEl.childNodes.slice(0, 2);
  R.fn(v, grid(['b']));                      // the grid moved; history did not
  const after = v.screenEl.childNodes.slice(0, 2);
  assert.equal(after[0], before[0], 'same node object — ~1700 rebuilt rows four times a second is unusable');
  assert.equal(after[1], before[1]);
  assert.equal(v.screenEl.childNodes[2].nodeText, 'b', 'control: the live row DID repaint');
});

test('D3 without history the pane still blank-fills to its own height (the phone behaviour)', () => {
  const v = mkView(null);
  buildRenderGrid(v).fn(v, grid(['only']));
  assert.ok(v.screenEl.childNodes.length > 1, 'a one-row grid still occupies the pane');
  assert.equal(v.histLen, 0);
});

test('D4 with history there is no blank padding under the prompt', () => {
  const v = mkView(['h1', 'h2']);
  buildRenderGrid(v).fn(v, grid(['only']));
  assert.equal(v.screenEl.childNodes.length, 3, 'history already fills the scroll — padding is dead space');
});

test('D5 the styled top scrolling off triggers ONE refetch, not a per-frame storm', () => {
  const v = mkView(['h1']);
  const R = buildRenderGrid(v);
  R.fn(v, grid(['top', 'x']));            // establishes the top signature
  assert.equal(R.refreshed.length, 0);
  R.fn(v, grid(['top', 'y']));            // tail changed, top did not
  assert.equal(R.refreshed.length, 0, 'ordinary output must not refetch 2000 rows');
  R.fn(v, grid(['NEWTOP', 'y']));         // the buffer scrolled: the seam moved
  assert.equal(R.refreshed.length, 1, 'a moved seam would otherwise leave a silent gap in the pane');
  assert.equal(R.refreshed[0], v);
});

// tryMenuClick turns a tap into arrow presses. History rows keep their old ❯ forever, so they must be
// invisible to it — otherwise a tap computes its delta from a highlight that no longer exists and fires
// arrow keys at the wrong item of a live menu.
function buildTryMenuClick(v, opts) {
  const o = opts || {};
  const pressed = [];
  const fn = lift(appFn('tryMenuClick'), 'tryMenuClick', {
    state: { tab: { id: 's1' }, tabType: 'terminal' },
    setStatus: () => {},
    pressKeys: (k) => { pressed.push(...k); },
    MENU_MARKERS: '❯▶►▸➤»‣',
    MENU_ITEM_RE: new RegExp('^\\s*[❯▶►▸➤»‣]?\\s*\\d+[.)]\\s+\\S'),
    firstGlyph: (s) => { const t = (s || '').replace(/^\s+/, ''); return t ? t[0] : ''; },
    isMarked: (s) => '❯▶►▸➤»‣'.indexOf((s || '').replace(/^\s+/, '')[0] || '') >= 0,
  });
  return { fn, pressed, o };
}
function menuScreen(texts, histLen) {
  const kids = texts.map((t) => ({ textContent: t }));
  return { screenEl: { childNodes: kids }, histLen: histLen || 0, rows: kids };
}

test('D6 a stale menu sitting in the history cannot steer the arrows', () => {
  // History holds a dead menu whose ❯ is on item 1; the LIVE menu's ❯ is on item 2. Tapping live item 3
  // is one `down`. Counting the history rows too would make it three, landing three items away.
  const v = menuScreen([
    '❯ 1. old choice', '  2. old other',            // history (histLen = 2)
    '  1. Yes', '❯ 2. No', '  3. Maybe',            // live grid
  ], 2);
  const T = buildTryMenuClick(v);
  assert.equal(T.fn(v, v.rows[4]), true);
  assert.deepEqual(T.pressed, ['down', 'enter']);
});

test('D7 a tap on a history row is not a menu action at all', () => {
  const v = menuScreen(['❯ 1. old choice', '  2. old other', '  1. Yes', '❯ 2. No'], 2);
  const T = buildTryMenuClick(v);
  assert.equal(T.fn(v, v.rows[0]), false, 'history is not clickable — it is a transcript');
  assert.deepEqual(T.pressed, []);
});

test('D8 with no history the detector behaves exactly as before', () => {
  const v = menuScreen(['  1. Yes', '❯ 2. No', '  3. Maybe'], 0);
  const T = buildTryMenuClick(v);
  assert.equal(T.fn(v, v.rows[0]), true);
  assert.deepEqual(T.pressed, ['up', 'enter']);
});

// =====================================================================================
// Group E — the routes exist end to end (a client call that reaches nothing is the classic dark wire)
// =====================================================================================

test('E1 the server relays both new routes, and the client calls them', () => {
  assert.match(SERVER, /p === '\/api\/cmux\/history'/, 'server must relay /api/cmux/history');
  assert.match(SERVER, /p === '\/api\/cmux\/rename-workspace'/, 'server must relay the rename');
  assert.match(SERVER, /bridge\(m, `\/cmux\/history\?\$\{qs\}`/, 'and reach the bridge route');
  assert.match(SERVER, /bridge\(m, '\/cmux\/rename-workspace'/);
  assert.match(BRIDGE, /p === '\/cmux\/history'/, 'bridge must serve /cmux/history');
  assert.match(BRIDGE, /p === '\/cmux\/rename-workspace'/);
  assert.match(APP, /\/api\/cmux\/history\?machine=/, 'the client must actually fetch history');
  assert.match(APP, /'\/api\/cmux\/rename-workspace'/);
});

test('E2 the pane attach path is what triggers the history fetch', () => {
  // If this call moved out of updateView, panes would only ever get history by a lucky refetch.
  const src = appFn('updateView');
  assert.match(src, /loadHistory\(v, want\)/,
    'a surface arriving in a pane is the moment its 2000 rows are fetched');
});

test('E3 clearScreen drops the history with the surface it belonged to', () => {
  const src = appFn('clearScreen');
  assert.match(src, /v\.hist = null/, 'history from the previous surface must not linger in the pane');
  assert.match(src, /v\.histLen = 0/);
});

test('E4 the operator-visible default is 2000 rows', () => {
  assert.match(APP, /HISTORY_ROWS = 2000/);
  assert.match(BRIDGE, /HISTORY_MAX_ROWS = 2000/);
  // The cmux ceiling this path exists to get past is LEARNED per bridge now, never a constant: a
  // hard-coded 240 said `complete` for every pane on a build that caps replay lower.
  assert.doesNotMatch(BRIDGE, /REPLAY_SB_CAP/, 'no hard-coded replay cap may come back');
  assert.match(BRIDGE, /replayReachesTop\(replayCap, sbRows\)/);
});

// =====================================================================================
// Group F — cmux-version tolerance of the join (bridge.js), unit level
// =====================================================================================
// An older or newer cmux may format a replay row differently from read-screen's text for the same
// buffer line. Each of these used to end at `rows: []`.

const spliceByCount = lift(bridgeFn('spliceByCount'), 'spliceByCount', { normRow });
const learnReplayCap = lift(bridgeFn('learnReplayCap'), 'learnReplayCap', {});
const replayReachesTop = lift(bridgeFn('replayReachesTop'), 'replayReachesTop', {});

test('F1 a wide-char spacer column in the replay row does not break the join', () => {
  // spansToText pads a CJK char's second cell with a space; read-screen does not.
  assert.equal(alignHistory(['old', '中文 ok', 'next'], ['中 文  ok', 'next']), 1);
});

test('F2 NBSP / inner-space differences are formatting, not content', () => {
  assert.equal(alignHistory(['a', 'b', 'x y  z', 'tail'], ['x y z', 'tail']), 2);
});

test('F3 a successor that WRAPS differently still anchors — if the anchor line is unique', () => {
  // read-screen unwrapped a soft-wrapped row the replay shows as two; the pair check fails, the
  // unique single anchor does not.
  const lines = ['h1', 'h2', 'unique anchor', 'long row part A part B'];
  assert.equal(alignHistory(lines, ['unique anchor', 'long row part A', 'part B']), 2);
});

test('F4 …but a NON-unique lone anchor is refused rather than guessed', () => {
  const lines = ['dup', 'q', 'dup', 'r'];
  assert.equal(alignHistory(lines, ['dup', 'NOT HERE']), -1);
});

test('F5 later anchors are tried when the first styled row is not in the text', () => {
  // the oldest styled row was re-rendered by cmux (e.g. a prompt redraw) — the next one still joins
  assert.equal(alignHistory(['h1', 'h2', 'real a', 'real b', 'real c'], ['REDRAWN', 'real b', 'real c']), 2);
});

test('F6 an anchor with fewer rows above it than in the window means nothing is above: 0, not -1', () => {
  assert.equal(alignHistory(['x', 'y'], ['', '', '', 'x', 'y']), 0);
});

test('F7 count splice: plain text ends where the window ends, less its trailing blank rows', () => {
  const lines = []; for (let i = 1; i <= 50; i++) lines.push('l' + i);
  const styled = []; for (let i = 0; i < 20; i++) styled.push('S' + i);
  assert.equal(spliceByCount(lines, styled), 30);
  // read-screen trims the window's 5 trailing blank rows, so they must not be counted against it
  assert.equal(spliceByCount(lines, styled.concat(['', '', '  ', '', ''])), 30);
  assert.equal(spliceByCount(lines.slice(0, 10), styled), 0, 'never negative');
});

test('F8 the replay cap is learned, and only a single agreed cap enables the shortcut', () => {
  const cap = { n: 0, min: 0, max: 0 };
  assert.equal(replayReachesTop(cap, 12), false, 'nothing seen yet: the read must be paid');
  learnReplayCap(cap, 240);
  assert.equal(replayReachesTop(cap, 12), true);
  assert.equal(replayReachesTop(cap, 240), false, 'a saturated window may have rows above it');
  learnReplayCap(cap, 240);
  assert.equal(replayReachesTop(cap, 239), true);
  learnReplayCap(cap, 180);
  assert.equal(replayReachesTop(cap, 12), false, 'caps disagree: not a row cap on this build');
  learnReplayCap(cap, 0);
  assert.equal(cap.n, 3, 'a zero-row replay teaches nothing');
});

// =====================================================================================
// Group G — cmux version floor (lib/cmux-version.js) and where it surfaces
// =====================================================================================

const cv = require('../lib/cmux-version');

test('G1 parse: `cmux --version` output, bare versions, and junk', () => {
  assert.deepEqual(cv.parseCmuxVersion('cmux 0.64.25 (106) [b685a275c]'), [0, 64, 25]);
  assert.deepEqual(cv.parseCmuxVersion('0.64.9'), [0, 64, 9]);
  assert.equal(cv.parseCmuxVersion('OK'), null);
  assert.equal(cv.parseCmuxVersion(''), null);
  assert.equal(cv.parseCmuxVersion(null), null);
});

test('G2 compare is numeric per part, not lexical', () => {
  assert.equal(cv.compareVersions('0.64.9', '0.64.19'), -1, '"9" > "19" lexically — must not matter');
  assert.equal(cv.compareVersions('0.64.19', '0.64.19'), 0);
  assert.equal(cv.compareVersions('0.65.0', '0.64.99'), 1);
  assert.equal(cv.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(cv.compareVersions('nope', '0.64.19'), null);
});

test('G3 assess: at/above the floor is supported, below is not, unreadable is UNKNOWN (null)', () => {
  assert.equal(cv.MIN_CMUX_VERSION, '0.64.19');
  assert.deepEqual(cv.assessCmuxVersion('cmux 0.64.25 (106) [x]'), { version: '0.64.25', min: '0.64.19', supported: true });
  assert.deepEqual(cv.assessCmuxVersion('cmux 0.64.19'), { version: '0.64.19', min: '0.64.19', supported: true });
  assert.deepEqual(cv.assessCmuxVersion('cmux 0.62.3'), { version: '0.62.3', min: '0.64.19', supported: false });
  assert.deepEqual(cv.assessCmuxVersion(''), { version: null, min: '0.64.19', supported: null });
});

test('G4 the bridge reports the version through capabilities and warns at boot when below the floor', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p11-ver-'));
  const shim = path.join(dir, 'cmux');
  await fsp.writeFile(shim, '#!/bin/sh\ncase "$*" in\n  --version) echo "cmux 0.62.3 (1) [abc]" ;;\n'
    + '  tree*) echo \'{"windows":[]}\' ;;\n  *) echo "{}" ;;\nesac\n', { mode: 0o755 });
  const { bootBridge } = require('./helpers/bridge-child');
  const br = await bootBridge({ env: { CMUX_BIN: shim, BRIDGE_SECRET: 'p11v' } });
  t.after(async () => { await br.stop(); await fsp.rm(dir, { recursive: true, force: true }); });
  const deadline = Date.now() + 5000;
  while (!/older than 0\.64\.19/.test(br.stdout()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.match(br.stdout(), /WARNING: cmux 0\.62\.3 is older than 0\.64\.19/);
  const r = await fetch(`${br.base}/cmux/tree`, { headers: { 'x-bridge-secret': 'p11v' } });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.deepEqual(d.capabilities.cmux, { version: '0.62.3', min: '0.64.19', supported: false });
  assert.equal(d.capabilities.backend, 'cmux', 'additive: the p18 keys are untouched');
});

test('G5 the page shows a below-floor cmux on the steady "live" status — and nothing otherwise', () => {
  const note = lift(appFn('cmuxCompatNote'), 'cmuxCompatNote', {});
  assert.equal(note({ cmux: { version: '0.62.3', min: '0.64.19', supported: false } }), 'cmux 0.62.3 < 0.64.19 (update cmux)');
  assert.equal(note({ cmux: { version: '0.64.25', min: '0.64.19', supported: true } }), '');
  assert.equal(note({ cmux: { version: null, min: '0.64.19', supported: null } }), '', 'unknown is not "too old"');
  assert.equal(note({ backend: 'tmux' }), '', 'tmux / pre-version bridges carry no cmux key');
  assert.equal(note(undefined), '');
  assert.match(appFn('setStatus'), /txt === 'live'[\s\S]*cmuxCompatNote\(state\.caps\[state\.machine\]\)/,
    'wired into the status line, not a toast');
});

// =====================================================================================
// Group H — the client keeps asking until it has an answer (public/app.js)
// =====================================================================================
// The pane that "shows very few lines" is also what a client produces when its ONE history request
// was skipped or came back empty: the refetch only ever fired for panes that already had history.

test('H1 a pane with no history and no "none exists" answer retries on later frames', () => {
  const v = mkView(null);
  const R = buildRenderGrid(v);
  R.fn(v, grid(['a']));
  R.fn(v, grid(['b']));
  assert.equal(R.refreshed.length, 2, 'every frame asks refreshHistory, which does the throttling');
});

test('H2 a pane the bridge said is complete (or alt-screen) does not retry per frame', () => {
  const v = mkView(null); v.histDone = true;
  const R = buildRenderGrid(v);
  R.fn(v, grid(['top', 'x']));
  R.fn(v, grid(['top', 'y']));
  assert.equal(R.refreshed.length, 0, 'no retry loop on a pane with nothing above it');
  R.fn(v, grid(['NEWTOP', 'y']));
  assert.equal(R.refreshed.length, 1, '…until its top row moves: output pushed rows above the window');
});

test('H3 history parked while the reader was scrolled up lands once they follow the tail again', () => {
  const v = mkView(null); v.histPending = ['h1', 'h2']; v.followTail = false;
  const R = buildRenderGrid(v);
  R.fn(v, grid(['live']));
  assert.equal(v.histLen, 0, 'a reader scrolled up is not yanked');
  assert.equal(R.refreshed.length, 0, 'and parked rows are not re-fetched');
  v.followTail = true;
  R.fn(v, grid(['live']));
  assert.equal(v.histLen, 2);
  assert.deepEqual(v.screenEl.childNodes.slice(0, 2).map((n) => n.nodeText), ['h1', 'h2']);
  assert.equal(v.histPending, null);
});

function buildLoadHistory(answer) {
  const painted = [];
  // fnSrcIn lifts from `function`, so the `async` keyword in front of it is put back here
  const fn = lift('async ' + appFn('loadHistory'), 'loadHistory', {
    state: { machine: 'm1' },
    HISTORY_ROWS: 2000,
    jget: async () => {
      const a = typeof answer === 'function' ? await answer() : answer;
      return { ok: a.status === 200, json: async () => a.body };
    },
    renderGrid: (v) => painted.push(v),
  });
  return { fn, painted };
}
const hv = (extra) => Object.assign({ surfaceId: 'S1', followTail: true, lastGrid: {}, hist: null,
  histBusy: false, histReq: null, histDone: false, histPending: null, histFails: 0, histAt: 0 }, extra || {});

test('H4 rows are painted; complete/altScreen mark the pane done; an empty non-answer does not', async () => {
  const L1 = buildLoadHistory({ status: 200, body: { rows: ['a', 'b'], aligned: true } });
  const v1 = hv(); await L1.fn(v1, 'S1');
  assert.deepEqual(v1.hist, ['a', 'b']); assert.equal(L1.painted.length, 1); assert.equal(v1.histBusy, false);

  const v2 = hv(); await buildLoadHistory({ status: 200, body: { rows: [], complete: true } }).fn(v2, 'S1');
  assert.equal(v2.histDone, true); assert.equal(v2.histFails, 0);

  const v3 = hv(); await buildLoadHistory({ status: 200, body: { rows: [], altScreen: true } }).fn(v3, 'S1');
  assert.equal(v3.histDone, true);

  const v4 = hv(); await buildLoadHistory({ status: 200, body: { rows: [], aligned: false } }).fn(v4, 'S1');
  assert.equal(v4.histDone, false, 'an old bridge\'s failed join is not "nothing above"');
  assert.equal(v4.histFails, 1, 'counted, so retries back off');

  const v5 = hv(); await buildLoadHistory({ status: 502, body: { error: 'cmux_failed' } }).fn(v5, 'S1');
  assert.equal(v5.histDone, false); assert.equal(v5.histFails, 1);
});

test('H5 an in-flight request for the PREVIOUS surface does not block the new one', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const L = buildLoadHistory(async () => { calls.push(1); await gate; return { status: 200, body: { rows: ['old'] } }; });
  const v = hv({ surfaceId: 'A' });
  const pa = L.fn(v, 'A');                    // in flight for A
  v.surfaceId = 'B';                          // the pane switched surfaces (clearScreen ran)
  const pb = L.fn(v, 'B');                    // the attach-time load for B
  assert.equal(calls.length, 2, 'B was asked for, not skipped behind A\'s busy flag');
  release(); await pa; await pb;
  assert.equal(v.histBusy, false, 'B\'s completion clears the flag; A\'s stale finish did not steal it');
  assert.deepEqual(v.hist, ['old'], 'B\'s own answer landed');
});

test('H6 the SAME surface already in flight is not asked twice', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const L = buildLoadHistory(async () => { n++; await gate; return { status: 200, body: { rows: ['x'] } }; });
  const v = hv();
  const p1 = L.fn(v, 'S1');
  const p2 = L.fn(v, 'S1');
  release(); await p1; await p2;
  assert.equal(n, 1);
});

test('H7 a scrolled-up reader gets the rows PARKED, not painted, and not thrown away', async () => {
  const v = hv({ followTail: false });
  const L = buildLoadHistory({ status: 200, body: { rows: ['p1', 'p2'] } });
  await L.fn(v, 'S1');
  assert.equal(v.hist, null);
  assert.deepEqual(v.histPending, ['p1', 'p2']);
  assert.equal(L.painted.length, 0);
});

test('H8 refreshHistory throttles, and backs off after failures', () => {
  const asked = [];
  const refresh = lift(appFn('refreshHistory'), 'refreshHistory', {
    HISTORY_MIN_GAP_MS: 4000, loadHistory: (v, sid) => asked.push(sid),
  });
  const now = Date.now();
  refresh({ surfaceId: 'S', histAt: now - 1000 });
  assert.equal(asked.length, 0, 'inside the 4s floor');
  refresh({ surfaceId: 'S', histAt: now - 5000 });
  assert.equal(asked.length, 1);
  refresh({ surfaceId: 'S', histAt: now - 5000, histFails: 2 });
  assert.equal(asked.length, 1, 'two failures: 16s gap');
  refresh({ surfaceId: 'S', histAt: now - 70000, histFails: 9 });
  assert.equal(asked.length, 2, 'the backoff is capped (64s)');
});

test('H9 clearScreen resets every history field with the surface', () => {
  const src = appFn('clearScreen');
  for (const f of ['histDone = false', 'histPending = null', 'histFails = 0']) assert.ok(src.includes('v.' + f), f);
});
