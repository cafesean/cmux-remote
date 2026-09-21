'use strict';
// p18 STORY-001 — capture-pane -> render_grid (specs.md §6).
//
// The fixtures in test/fixtures/tmux/ are REAL tmux 3.6a captures recorded by
// scripts/capture-tmux-fixture.js, so this file needs no tmux to run. The menu round trip uses the
// real cmux captures in test/fixtures/grids/ — the truth set Claude-menu detection was built on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { ansiToGrid, textWidth } = require('../lib/tmux-grid');
const { gridToAnsi } = require('./helpers/grid-to-ansi');
const menuparse = require('../public/menuparse.js');

const TMUX_FX = path.join(__dirname, 'fixtures', 'tmux');
const GRID_FX = path.join(__dirname, 'fixtures', 'grids');

function loadTmux(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(TMUX_FX, `${name}.json`), 'utf8'));
  const text = fs.readFileSync(path.join(TMUX_FX, `${name}.ansi`), 'utf8');
  return { meta, text, grid: ansiToGrid(text, meta) };
}
const styleOf = (g, sp) => g.styles.find((s) => s.id === sp.style_id);
const spanWith = (g, s) => g.row_spans.find((sp) => sp.text.includes(s));
function rowText(g, row) {
  let t = '';
  for (const sp of g.row_spans.filter((x) => x.row === row).sort((a, b) => a.column - b.column)) {
    if (sp.column > t.length) t += ' '.repeat(sp.column - t.length);
    t += sp.text;
  }
  return t;
}

test('the 4 recorded scenarios are committed (.ansi + .json each)', () => {
  for (const n of ['sgr-basic', 'rgb-256', 'wide-emoji', 'osc8-link']) {
    assert.ok(fs.existsSync(path.join(TMUX_FX, `${n}.ansi`)), `${n}.ansi`);
    const meta = JSON.parse(fs.readFileSync(path.join(TMUX_FX, `${n}.json`), 'utf8'));
    assert.equal(meta.columns, 60);
    assert.equal(meta.rows, 8);
  }
});

test('rgb-256: the RGB span is #B1B9F9 and the 256-colour 246 span is #949494', () => {
  const { grid } = loadTmux('rgb-256');
  assert.equal(styleOf(grid, spanWith(grid, 'RGB-sel')).foreground, '#B1B9F9');
  assert.equal(styleOf(grid, spanWith(grid, 'field256')).foreground, '#949494');
  assert.equal(spanWith(grid, 'RGB-sel').column, 0);
  assert.equal(spanWith(grid, 'field256').column, 8);
});

test('osc8-link: the hyperlink escapes are dropped and the row reads "link after"', () => {
  const { grid } = loadTmux('osc8-link');
  assert.equal(rowText(grid, 0), 'link after');
  for (const sp of [...grid.row_spans, ...grid.scrollback_spans]) {
    assert.ok(!sp.text.includes('\x1b'), JSON.stringify(sp.text));
    assert.ok(!sp.text.includes(']8;'), JSON.stringify(sp.text));
  }
});

test("wide-emoji: 'X' sits at tmux's own column and cell widths agree with tmux's cursor", () => {
  const { meta, grid } = loadTmux('wide-emoji');
  assert.equal(meta.step_cursor_x, 7);                         // measured by tmux after 日本語X
  // the span holds 日本語X; X's column is its start plus the width of what precedes it
  const sp = spanWith(grid, 'X');
  const xCol = sp.column + textWidth(sp.text.slice(0, sp.text.indexOf('X')));
  assert.equal(xCol, meta.step_cursor_x - 1);
  for (const s of [...grid.row_spans, ...grid.scrollback_spans]) assert.equal(s.cell_width, textWidth(s.text), JSON.stringify(s));
  // row 1 ('🙂 x') ends where tmux put the cursor: the emoji is 2 cells wide, as tmux counted it
  const row1 = grid.row_spans.filter((s) => s.row === 1);
  const end = Math.max(...row1.map((s) => s.column + s.cell_width));
  assert.equal(end, meta.cursor.column);
  assert.equal(meta.cursor.row, 1);
});

test('sgr-basic: flags and 16-colour palette', () => {
  const { grid } = loadTmux('sgr-basic');
  const st = (t) => styleOf(grid, spanWith(grid, t));
  assert.equal(st('BOLD').bold, true);
  assert.equal(st('INV').inverse, true);
  assert.equal(st('INV').foreground, '#FFFFFF');   // inverse is a flag: fg/bg are NOT swapped here
  assert.equal(st('INV').background, '#000000');
  const isu = st('ISU');
  assert.deepEqual([isu.italic, isu.underline, isu.strikethrough, isu.bold], [true, true, true, false]);
  assert.equal(st('red').foreground, '#CD0000');
  assert.equal(st('greenbg').background, '#00CD00');
  assert.equal(st('bright').foreground, '#FFFF00');
  assert.equal(st('bright').background, '#5C5CFF');
  assert.equal(st('end').id, 0);
});

test('exact key sets: styles (12 keys of a real cmux grid), spans, cursor; style 0 is the default', () => {
  const cmuxStyleKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(GRID_FX, 'claude-slash.json'), 'utf8')).grid.styles[0]).sort();
  assert.equal(cmuxStyleKeys.length, 12);
  for (const name of ['sgr-basic', 'rgb-256', 'wide-emoji', 'osc8-link']) {
    const { grid } = loadTmux(name);
    assert.deepEqual(Object.keys(grid).sort(),
      ['active_screen', 'columns', 'cursor', 'row_spans', 'rows', 'scrollback_rows', 'scrollback_spans', 'styles']);
    for (const s of grid.styles) assert.deepEqual(Object.keys(s).sort(), cmuxStyleKeys);
    for (const sp of [...grid.row_spans, ...grid.scrollback_spans]) {
      assert.deepEqual(Object.keys(sp).sort(), ['cell_width', 'column', 'row', 'style_id', 'text']);
    }
    assert.deepEqual(Object.keys(grid.cursor).sort(), ['blinking', 'column', 'row', 'style', 'visible']);
    assert.deepEqual(grid.styles[0], {
      id: 0, foreground: '#FFFFFF', background: '#000000', bold: false, faint: false, italic: false,
      underline: false, blink: false, inverse: false, invisible: false, strikethrough: false, overline: false,
    });
    // colours are uppercase #RRGGBB, always
    for (const s of grid.styles) { assert.match(s.foreground, /^#[0-9A-F]{6}$/); assert.match(s.background, /^#[0-9A-F]{6}$/); }
  }
});

test('grid fixtures: parseMenu and paneKind survive gridToAnsi -> ansiToGrid unchanged', () => {
  const files = fs.readdirSync(GRID_FX).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 7, `expected at least the 7 fixtures, found ${files.length}`);
  let menus = 0;
  for (const f of files) {
    const g = JSON.parse(fs.readFileSync(path.join(GRID_FX, f), 'utf8')).grid;
    const rt = ansiToGrid(gridToAnsi(g), { columns: g.columns, rows: g.rows, cursor: g.cursor, alt: false });
    const want = menuparse.parseMenu(g);
    assert.deepEqual(menuparse.parseMenu(rt), want, f);
    assert.equal(menuparse.paneKind({ grid: rt }).kind, menuparse.paneKind({ grid: g }).kind, f);
    if (want) { menus++; assert.equal(want.signal, 'foreground', f); }
  }
  assert.ok(menus >= 4, 'the positive Claude menu fixtures must be in the set');
});

test('history rows become scrollback_spans; the viewport is the last `rows` lines', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`line${i}`);
  const g = ansiToGrid(lines.join('\n') + '\n', { columns: 20, rows: 4, cursor: { column: 0, row: 3, visible: true } });
  assert.equal(g.scrollback_rows, 6);
  assert.equal(g.active_screen, 'primary');
  assert.deepEqual(g.scrollback_spans.map((s) => [s.row, s.text]), [0, 1, 2, 3, 4, 5].map((i) => [i, `line${i}`]));
  assert.deepEqual(g.row_spans.map((s) => [s.row, s.text]), [[0, 'line6'], [1, 'line7'], [2, 'line8'], [3, 'line9']]);
  const alt = ansiToGrid(lines.join('\n') + '\n', { columns: 20, rows: 4, cursor: { column: 0, row: 0, visible: false }, alt: true });
  assert.equal(alt.active_screen, 'alternate');
  assert.equal(alt.scrollback_rows, 0);
  assert.equal(alt.scrollback_spans.length, 0);
  assert.equal(alt.row_spans.length, 4);
  assert.equal(alt.cursor.visible, false);
});

test('SGR details: colon sub-parameters, 256 cube and greys, resets, unknown codes, carry across lines', () => {
  const g = ansiToGrid('\x1b[4:3mA\x1b[4:0mB\x1b[38:2::1:2:3mC\x1b[38;5;196mD\x1b[48;5;232mE\x1b[0;53;2mF\x1b[22;55;999mG\x1b[31m\nH\n', { columns: 20, rows: 2 });
  const st = (t) => styleOf(g, spanWith(g, t));
  assert.equal(st('A').underline, true);
  assert.equal(st('B').underline, false);
  assert.equal(st('C').foreground, '#010203');
  assert.equal(st('D').foreground, '#FF0000');
  assert.equal(st('E').background, '#080808');
  assert.deepEqual([st('F').overline, st('F').faint], [true, true]);
  assert.equal(st('G').id, 0);
  assert.equal(st('H').foreground, '#CD0000');        // SGR state carried over the newline
});

test('trailing default blanks are dropped; a TAB advances to the next tab stop; C0 is ignored', () => {
  const g = ansiToGrid('ab\x1b[31mX\x1b[0m   \n\x1b[41m  \x1b[0m   \na\tb\x07c\n', { columns: 40, rows: 3 });
  assert.deepEqual(g.row_spans.filter((s) => s.row === 0).map((s) => s.text), ['ab', 'X']);
  assert.deepEqual(g.row_spans.filter((s) => s.row === 1).map((s) => s.text), ['  ']);   // coloured blanks stay
  assert.equal(rowText(g, 2), 'a       bc');
});

test('lib/tmux-ids.js and lib/tmux-grid.js require only node built-ins', () => {
  for (const f of ['tmux-ids.js', 'tmux-grid.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      const bare = r.replace(/^node:/, '');
      assert.ok(builtinModules.includes(bare), `${f} requires non-built-in ${r}`);
    }
    assert.ok(!/\bimport\s/.test(src), `${f} must be CommonJS`);
  }
});
