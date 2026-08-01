'use strict';
// Live-menu detector, tested against REAL captured grids (test/fixtures/grids), not hand-written
// ones. A hand-written fixture encodes the author's belief about how Claude renders; that belief was
// wrong twice already (inverse/background instead of foreground, and grid rows instead of items).
//
// Regenerate fixtures with: node scripts/capture-grid.js scenario <name>

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parseMenu, stepsTo } = require('../public/menuparse.js');

const DIR = path.join(__dirname, 'fixtures', 'grids');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')).grid;
const has = (name) => fs.existsSync(path.join(DIR, `${name}.json`));

// ---- positives ------------------------------------------------------------------------------

test('Claude slash menu: detected, with the highlighted command as the marked item', () => {
  const menu = parseMenu(load('claude-slash-2'));
  assert.ok(menu, 'the slash menu must be detected');
  assert.ok(menu.items.length >= 5, `expected several commands, got ${menu.items.length}`);
  assert.strictEqual(menu.signal, 'foreground', 'Claude marks selection by foreground colour only');
  assert.match(menu.items[menu.markedIndex].text, /^\//, 'the marked item is a slash command');
});

test('one Down press advances the marked item by exactly one — not by one grid row', () => {
  const before = parseMenu(load('claude-slash-2'));
  const after = parseMenu(load('claude-slash-3'));
  assert.ok(before && after);
  assert.strictEqual(after.markedIndex, before.markedIndex + 1,
    'a single Down must move the selection exactly one ITEM; if this fails, item grouping is counting wrapped description rows');
  assert.strictEqual(after.items[after.markedIndex].text, before.items[before.markedIndex + 1].text,
    'the newly marked item must be the one that followed the previously marked item');
});

test('stepsTo produces the arrow sequence that reaches a tapped item', () => {
  const menu = parseMenu(load('claude-slash-2'));
  assert.deepStrictEqual(stepsTo(menu, menu.markedIndex), [], 'delta 0 sends no arrows');
  assert.deepStrictEqual(stepsTo(menu, menu.markedIndex + 2), ['down', 'down']);
  assert.strictEqual(stepsTo(menu, -1), null, 'out-of-range target is refused, not clamped');
  assert.strictEqual(stepsTo(menu, menu.items.length), null);
});

test('Claude @ file picker: detected, one grid row per item', () => {
  const menu = parseMenu(load('claude-at'));
  assert.ok(menu, 'the @ picker must be detected');
  assert.strictEqual(menu.signal, 'foreground');
  assert.ok(menu.items.every((it) => it.rows === 1),
    'the @ picker has no wrapped descriptions, so every item is exactly one row');
  const after = parseMenu(load('claude-at-2'));
  assert.strictEqual(after.markedIndex, menu.markedIndex + 1, 'one Down moves one item here too');
});

// ---- the negatives that matter ---------------------------------------------------------------

test('an IDLE Claude input box is NOT a menu (war-game F1 — the resting state of every idle tab)', () => {
  const menu = parseMenu(load('claude-slash'));
  assert.strictEqual(menu, null,
    'the ───/❯/─── input box must never render chips: a tap there sends up+enter, which recalls history and RESUBMITS the previous prompt');
});

test('numbered prose is not a menu', () => {
  assert.strictEqual(parseMenu(load('neg-numbered-prose')), null);
});

test('an inert zsh candidate list (no highlight) renders nothing', () => {
  if (!has('neg-zsh-list-plain')) return;                       // captured opportunistically
  assert.strictEqual(parseMenu(load('neg-zsh-list-plain')), null,
    'without a highlighted row there is nothing to walk to — silence, not a guess');
});

test('multi-column candidate lists are refused', () => {
  if (!has('zsh-menu-single')) return;
  assert.strictEqual(parseMenu(load('zsh-menu-single')), null,
    'zsh packs several candidates per row; up/down cannot reach them and a tapped row is ambiguous');
});

test('the BRIDGE payload shape works, not just the raw cmux one', () => {
  // cmux replay says `row_spans`; the bridge normalises to `spans`. Reading only the raw name made
  // the detector pass every fixture and find nothing at all in the browser — the fixtures carry one
  // shape and the live client carries the other. Both are asserted from now on.
  const raw = load('claude-slash-2');
  const bridgeShape = {
    columns: raw.columns, rows: raw.rows, cursor: raw.cursor, styles: raw.styles,
    spans: raw.row_spans,          // <- the rename that broke it
  };
  const a = parseMenu(raw), b = parseMenu(bridgeShape);
  assert.ok(b, 'the bridge payload must parse');
  assert.strictEqual(b.markedIndex, a.markedIndex);
  assert.deepStrictEqual(b.items.map((i) => i.text), a.items.map((i) => i.text));
});

// ---- structural guards -------------------------------------------------------------------------

test('a grid with no cursor or no spans is refused rather than throwing', () => {
  assert.strictEqual(parseMenu(null), null);
  assert.strictEqual(parseMenu({}), null);
  assert.strictEqual(parseMenu({ cursor: { row: 0 } }), null);
  assert.strictEqual(parseMenu({ row_spans: [] }), null);
});

test('two items each standing out differently is ambiguous, so no menu', () => {
  // Synthetic on purpose: this shape did not occur in any capture, and the rule it guards is
  // "never guess WHICH of two candidates is selected". One odd row out is a selection; two is noise.
  const grid = {
    columns: 40, rows: 8, cursor: { row: 0, column: 0 },
    styles: [
      { id: 0, foreground: '#999999', background: '#000000', inverse: false },
      { id: 1, foreground: '#B1B9F9', background: '#000000', inverse: false },
      { id: 2, foreground: '#FF0000', background: '#000000', inverse: false },
    ],
    row_spans: [
      { row: 1, column: 0, style_id: 1, text: '/one' },
      { row: 2, column: 0, style_id: 2, text: '/two' },
      { row: 3, column: 0, style_id: 0, text: '/three' },
      { row: 4, column: 0, style_id: 0, text: '/four' },
    ],
  };
  assert.strictEqual(parseMenu(grid), null);
});

test('a run with no shared field colour is not a menu', () => {
  // Every row a different colour = ordinary coloured output (ls --color, a log), not a selection.
  const grid = {
    columns: 40, rows: 8, cursor: { row: 0, column: 0 },
    styles: [
      { id: 0, foreground: '#111111', background: '#000000', inverse: false },
      { id: 1, foreground: '#222222', background: '#000000', inverse: false },
      { id: 2, foreground: '#333333', background: '#000000', inverse: false },
    ],
    row_spans: [
      { row: 1, column: 0, style_id: 0, text: 'alpha' },
      { row: 2, column: 0, style_id: 1, text: 'beta' },
      { row: 3, column: 0, style_id: 2, text: 'gamma' },
    ],
  };
  assert.strictEqual(parseMenu(grid), null);
});

test('output with no live input context is not a menu, however menu-shaped', () => {
  // The exact shape caught on a real surface: `claude usage` prints four rows, the first coloured
  // differently and the rest sharing a field colour. It satisfies every content rule. What it lacks
  // is somewhere to type — the cursor is parked at the top left, invisible, on an empty row.
  const styles = [
    { id: 0, foreground: '#999999', background: '#000000', inverse: false },
    { id: 1, foreground: '#B1B9F9', background: '#000000', inverse: false },
  ];
  const spans = [
    { row: 1, column: 4, style_id: 1, text: '1  user@example.com  [Org]  active' },
    { row: 2, column: 7, style_id: 0, text: '5h  15% resets 40m' },
    { row: 3, column: 7, style_id: 0, text: '7d  32% resets 2d' },
    { row: 4, column: 7, style_id: 0, text: 'Fable 11% resets 2d' },
  ];
  const invisible = { columns: 80, rows: 10, cursor: { row: 0, column: 0, visible: false }, styles, row_spans: spans };
  assert.strictEqual(parseMenu(invisible), null, 'an invisible cursor means nothing is being driven');

  const blankCursorRow = { columns: 80, rows: 10, cursor: { row: 0, column: 0, visible: true }, styles, row_spans: spans };
  assert.strictEqual(parseMenu(blankCursorRow), null, 'a visible cursor on an EMPTY row is still not an input line');
});

test('a coloured block below the cursor is not a menu unless the cursor is on a PROMPT', () => {
  // The shape the operator saw live: while Claude renders a tool call, its bash-command box sits below the
  // cursor. Wrapped command lines gave one row a distinct colour against a dim field, three rows,
  // right below the cursor — every content rule satisfied, and chips appeared over the operator's transcript.
  const styles = [
    { id: 0, foreground: '#999999', background: '#000000', inverse: false },
    { id: 1, foreground: '#FFFFFF', background: '#000000', inverse: false },
  ];
  const spans = (cursorText) => ([
    { row: 5, column: 0, style_id: 0, text: cursorText },
    { row: 6, column: 0, style_id: 1, text: '/tmp/p7b-server.log 2>&1 & sleep 3; node server.js' },
    { row: 7, column: 0, style_id: 0, text: 'cmux-remote server on http://127.0.0.1:8091' },
    { row: 8, column: 0, style_id: 0, text: 'cmux-remote bridge on 127.0.0.1:8792' },
  ]);
  const transcript = { columns: 90, rows: 20, cursor: { row: 5, column: 0, visible: true }, styles, row_spans: spans('running a command') };
  assert.strictEqual(parseMenu(transcript), null, 'transcript output must never render chips');

  // The same block IS a menu when the cursor sits on a prompt line — that is the only difference.
  const atPrompt = { columns: 90, rows: 20, cursor: { row: 5, column: 0, visible: true }, styles, row_spans: spans('❯ /') };
  assert.ok(parseMenu(atPrompt), 'with a prompt on the cursor row the same rows are a menu');
});

test('a run far below the cursor is not a menu', () => {
  const grid = {
    columns: 40, rows: 30, cursor: { row: 0, column: 0 },
    styles: [
      { id: 0, foreground: '#999999', background: '#000000', inverse: false },
      { id: 1, foreground: '#B1B9F9', background: '#000000', inverse: false },
    ],
    row_spans: [
      { row: 20, column: 0, style_id: 1, text: 'alpha' },
      { row: 21, column: 0, style_id: 0, text: 'beta' },
    ],
  };
  assert.strictEqual(parseMenu(grid), null, 'menus render at the cursor; distant output is not one');
});
