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

const alignHistory = lift(bridgeFn('alignHistory'), 'alignHistory', {});
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
// The child gets a cmux SHIM, so these run the shipped route code (validation, the sbRows<240 early
// return, the read-screen spawn, the slice) without a real cmux — and the shim LOGS every call, which
// is how "it did not pay for a 2000-line read" becomes an assertion instead of a hope.

const VIEWPORT_ROWS = 34;
const SB_CAP = 240;
// A 300-line buffer whose replay window is the last 274 rows: history above it is lines 1..26.
function fixture(opts) {
  const o = opts || {};
  const sbRows = o.sbRows == null ? SB_CAP : o.sbRows;
  const total = 300;
  const lines = [];
  for (let i = 1; i <= total; i++) lines.push('line ' + i);
  const styledFrom = total - (sbRows + VIEWPORT_ROWS);        // 300-274 = 26 rows of history
  const scrollback_spans = [];
  for (let r = 0; r < sbRows; r++) scrollback_spans.push({ row: r, column: 0, style_id: 0, text: lines[styledFrom + r] });
  const row_spans = [];
  for (let r = 0; r < VIEWPORT_ROWS; r++) row_spans.push({ row: r, column: 0, style_id: 0, text: lines[styledFrom + sbRows + r] });
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

test('C3 a short buffer is answered from the replay alone — no 2000-line read is paid for', async (t) => {
  const B = await bootWithShim(t, fixture({ sbRows: 12 }));
  const r = await B.get(`/cmux/history?surface=${SURFACE}&rows=2000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.complete, true, 'the replay window already reaches the top of the buffer');
  assert.deepEqual(r.json.rows, []);
  const calls = await B.calls();
  assert.ok(calls.some((c) => /terminal\.replay/.test(c)), 'control: it did ask for the grid');
  assert.ok(!calls.some((c) => /read-screen/.test(c)), 'and did NOT spawn a scrollback read');
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
  assert.match(BRIDGE, /REPLAY_SB_CAP = 240/, 'the cmux ceiling this whole path exists to get past');
});
