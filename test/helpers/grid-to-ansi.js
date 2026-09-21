'use strict';
// Encode a cmux render_grid back into terminal bytes, for the p18 round trips (specs.md §6).
//
// Two encodings, because there are two consumers:
//   gridToAnsi(grid)      what `tmux capture-pane -p -e` prints for that screen: one text line per
//                         row, gaps between spans as default-style blanks, an SGR per style change,
//                         reset at each line end (tmux 3.6a), trailing default blanks omitted. This
//                         is the input ansiToGrid is written against — the PURE round trip.
//   gridToTerminal(grid)  a program for a REAL terminal: clear, then every span placed with an
//                         absolute move ESC[<row+1>;<col+1>H, ending with a move to the grid's own
//                         cursor (menuparse reads the cursor row). Printed into a tmux pane, tmux
//                         lays it out and capture-pane hands back the first form.
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)

const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
const DEFAULT_FG = '#FFFFFF';
const DEFAULT_BG = '#000000';

// Full SGR for a style, from a reset. Default colours are left implicit, as tmux leaves them.
function sgrFor(st) {
  const p = ['0'];
  if (!st) return '\x1b[0m';
  if (st.bold) p.push('1');
  if (st.faint) p.push('2');
  if (st.italic) p.push('3');
  if (st.underline) p.push('4');
  if (st.blink) p.push('5');
  if (st.inverse) p.push('7');
  if (st.invisible) p.push('8');
  if (st.strikethrough) p.push('9');
  if (st.overline) p.push('53');
  const fg = hexRgb(st.foreground);
  if (fg && String(st.foreground).toUpperCase() !== DEFAULT_FG) p.push(`38;2;${fg.join(';')}`);
  const bg = hexRgb(st.background);
  if (bg && String(st.background).toUpperCase() !== DEFAULT_BG) p.push(`48;2;${bg.join(';')}`);
  return `\x1b[${p.join(';')}m`;
}
const isDefault = (st) => sgrFor(st) === '\x1b[0m';
const spansOf = (grid) => (grid && (grid.row_spans || grid.spans)) || [];
const styleMap = (grid) => new Map((grid.styles || []).map((s) => [s.id, s]));
const widthOf = (sp) => (Number.isFinite(sp.cell_width) ? sp.cell_width : String(sp.text || '').length);

function rowsOf(grid) {
  const byRow = new Map();
  for (const sp of spansOf(grid)) {
    if (!byRow.has(sp.row)) byRow.set(sp.row, []);
    byRow.get(sp.row).push(sp);
  }
  for (const list of byRow.values()) list.sort((a, b) => a.column - b.column);
  return byRow;
}

function gridToAnsi(grid) {
  const styles = styleMap(grid);
  const byRow = rowsOf(grid);
  const nRows = Number(grid.rows) || (Math.max(-1, ...byRow.keys()) + 1);
  const out = [];
  for (let r = 0; r < nRows; r++) {
    // drop the row's trailing default-style blank spans: tmux does not print trailing default cells
    const list = (byRow.get(r) || []).slice();
    while (list.length && isDefault(styles.get(list[list.length - 1].style_id)) && !String(list[list.length - 1].text || '').trim()) list.pop();
    let line = '';
    let col = 0;
    let styled = false;
    for (const sp of list) {
      if (sp.column > col) {
        if (styled) { line += '\x1b[0m'; styled = false; }
        line += ' '.repeat(sp.column - col);
        col = sp.column;
      }
      const st = styles.get(sp.style_id);
      if (isDefault(st)) { if (styled) { line += '\x1b[0m'; styled = false; } }
      else { line += sgrFor(st); styled = true; }
      line += sp.text || '';
      col += widthOf(sp);
    }
    if (styled) line += '\x1b[0m';
    out.push(line);
  }
  return out.join('\n') + '\n';
}

function gridToTerminal(grid) {
  const styles = styleMap(grid);
  let s = '\x1b[0m\x1b[H\x1b[2J';
  for (const list of rowsOf(grid).values()) {
    for (const sp of list) {
      s += `\x1b[${sp.row + 1};${sp.column + 1}H` + sgrFor(styles.get(sp.style_id)) + (sp.text || '');
    }
  }
  const c = grid.cursor || { row: 0, column: 0 };
  s += `\x1b[0m\x1b[${(c.row || 0) + 1};${(c.column || 0) + 1}H`;
  return s;
}

module.exports = { gridToAnsi, gridToTerminal, sgrFor };
