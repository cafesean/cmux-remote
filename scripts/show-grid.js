#!/usr/bin/env node
'use strict';
// show-grid — print a captured fixture as rows plus its style signals.
//
// Reading a fixture by eye is how the §6.0 rules get settled: you need to see, per row, what text is
// there AND which style signals fire on it. A JSON dump buries that; this puts them side by side.
//
//   node scripts/show-grid.js <fixture-name> [...]

const path = require('path');
const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'grids');

// The "default" background is the most common one across spans — the terminal's own, whatever the
// theme. Style id 0 is NOT reliably the default: a themed prompt can outnumber it on a short grid.
function defaultBackground(grid) {
  const byId = new Map((grid.styles || []).map((s) => [s.id, s]));
  const count = new Map();
  for (const sp of grid.row_spans || []) {
    const st = byId.get(sp.style_id);
    if (!st) continue;
    const w = (sp.text || '').length;
    count.set(st.background, (count.get(st.background) || 0) + w);
  }
  let best = null, bestN = -1;
  for (const [bg, n] of count) if (n > bestN) { bestN = n; best = bg; }
  return best;
}

function rowsOf(grid) {
  const byId = new Map((grid.styles || []).map((s) => [s.id, s]));
  const defBg = defaultBackground(grid);
  const rows = new Map();
  for (const sp of grid.row_spans || []) {
    if (!rows.has(sp.row)) rows.set(sp.row, { text: '', indent: null, bg: new Set(), fg: new Set(), inverse: false, bold: false });
    const r = rows.get(sp.row);
    const st = byId.get(sp.style_id) || {};
    r.text += sp.text || '';
    if (r.indent == null && (sp.text || '').trim()) r.indent = sp.column;
    if (st.background && st.background !== defBg) r.bg.add(st.background);
    if (st.foreground) r.fg.add(st.foreground);
    if (st.inverse) r.inverse = true;
    if (st.bold) r.bold = true;
  }
  return { rows: [...rows.entries()].sort((a, b) => a[0] - b[0]), defBg };
}

const MARKERS = '❯▶►▸➤»‣>';

for (const name of process.argv.slice(2)) {
  const f = require(path.join(FIXTURE_DIR, `${name}.json`));
  const g = f.grid;
  const { rows, defBg } = rowsOf(g);
  console.log(`\n=== ${name} === ${g.columns}x${g.rows}  screen=${g.active_screen}  cursor=r${g.cursor && g.cursor.row}c${g.cursor && g.cursor.column}  defaultBg=${defBg}  styles=${g.styles.length}`);
  console.log('row | ind | signals              | text');
  for (const [n, r] of rows) {
    const trimmed = r.text.replace(/\s+$/, '');
    const sig = [
      r.inverse ? 'INV' : '',
      r.bg.size ? `bg:${[...r.bg].join(',')}` : '',
      MARKERS.includes((trimmed.trimStart()[0] || '')) ? 'MARK' : '',
      r.fg.size > 1 ? `fg×${r.fg.size}` : (r.fg.size ? `fg:${[...r.fg][0]}` : ''),
    ].filter(Boolean).join(' ');
    console.log(`${String(n).padStart(3)} | ${String(r.indent == null ? '' : r.indent).padStart(3)} | ${sig.padEnd(20).slice(0, 20)} | ${JSON.stringify(trimmed.slice(0, 78))}`);
  }
}
