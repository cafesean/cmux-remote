'use strict';
// tmux `capture-pane -p -e` text -> cmux `render_grid` (p18 specs.md §6). Pure, built-ins only.
//
// The page, the bridge and Claude-menu detection (public/menuparse.js) all read cmux's render_grid:
// interned styles with hex colours, and positioned spans per row. On the tmux backend the only source
// is capture-pane's SGR-coloured text, so this module rebuilds EXACTLY cmux's shape from it — same
// keys, same colour spelling (#RRGGBB uppercase), style id 0 = the default style — because menuparse
// keys on the foreground colour of the selected row and would silently find nothing on a near miss.
//
// Parsing is a stream over the whole capture. SGR state carries across newlines (tmux 3.6a resets at
// every line end anyway; the parser does not rely on it). Cursor moves, OSC 8 hyperlinks and every
// other escape are dropped: capture-pane is already laid out in rows and columns.

const DEFAULT_FG = '#FFFFFF';
const DEFAULT_BG = '#000000';
// xterm's 16-colour palette. Bold does not brighten.
const PALETTE16 = ['000000', 'CD0000', '00CD00', 'CDCD00', '0000EE', 'CD00CD', '00CDCD', 'E5E5E5',
  '7F7F7F', 'FF0000', '00FF00', 'FFFF00', '5C5CFF', 'FF00FF', '00FFFF', 'FFFFFF'];
const CUBE = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
const TAB_STOP = 8;

const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
function rgbHex(r, g, b) {
  const c = [r, g, b].map((v) => Number(v));
  if (c.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null;
  return '#' + c.map(hex2).join('');
}
function paletteHex(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return '#' + PALETTE16[n];
  if (n < 232) {
    const i = n - 16;
    return '#' + hex2(CUBE[Math.floor(i / 36)]) + hex2(CUBE[Math.floor(i / 6) % 6]) + hex2(CUBE[i % 6]);
  }
  return '#' + hex2(8 + 10 * (n - 232)).repeat(3);
}

// Display width: 0 for combining / zero-width, 2 for wide, 1 otherwise. Checked against tmux's own
// cursor_x in test/tmux-grid.test.js (the wide-emoji fixture).
const ZERO_WIDTH = [[0x0300, 0x036F], [0x1AB0, 0x1AFF], [0x1DC0, 0x1DFF], [0x20D0, 0x20FF],
  [0xFE20, 0xFE2F], [0x200B, 0x200F], [0xFE00, 0xFE0F]];
const WIDE = [[0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
  [0xA000, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE30, 0xFE4F], [0xFF00, 0xFF60],
  [0xFFE0, 0xFFE6], [0x1F300, 0x1F64F], [0x1F900, 0x1F9FF], [0x20000, 0x3FFFD]];
const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
function charWidth(cp) {
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}
function textWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) w += charWidth(ch.codePointAt(0));
  return w;
}

const defaultAttrs = () => ({
  foreground: DEFAULT_FG, background: DEFAULT_BG, bold: false, faint: false, italic: false,
  underline: false, blink: false, inverse: false, invisible: false, strikethrough: false, overline: false,
});
const ATTR_KEYS = Object.keys(defaultAttrs());

function applyCode(a, code) {
  switch (code) {
    case 0: Object.assign(a, defaultAttrs()); return;
    case 1: a.bold = true; return;
    case 2: a.faint = true; return;
    case 3: a.italic = true; return;
    case 4: a.underline = true; return;
    case 5: a.blink = true; return;
    case 7: a.inverse = true; return;
    case 8: a.invisible = true; return;
    case 9: a.strikethrough = true; return;
    case 53: a.overline = true; return;
    case 22: a.bold = false; a.faint = false; return;
    case 23: a.italic = false; return;
    case 24: a.underline = false; return;
    case 25: a.blink = false; return;
    case 27: a.inverse = false; return;
    case 28: a.invisible = false; return;
    case 29: a.strikethrough = false; return;
    case 55: a.overline = false; return;
    case 39: a.foreground = DEFAULT_FG; return;
    case 49: a.background = DEFAULT_BG; return;
    default:
      if (code >= 30 && code <= 37) a.foreground = paletteHex(code - 30);
      else if (code >= 90 && code <= 97) a.foreground = paletteHex(code - 90 + 8);
      else if (code >= 40 && code <= 47) a.background = paletteHex(code - 40);
      else if (code >= 100 && code <= 107) a.background = paletteHex(code - 100 + 8);
      // anything else: ignored
  }
}
// 38/48 (fg/bg) and 58 (underline colour, parsed and dropped) — `sub` is a colon group.
function colonColor(sub) {
  if (sub[1] === '5') return paletteHex(sub[2]);
  if (sub[1] === '2') return sub.length >= 6 ? rgbHex(sub[3], sub[4], sub[5]) : rgbHex(sub[2], sub[3], sub[4]);
  return null;
}
function setColor(a, code, color) {
  if (!color || code === 58) return;
  if (code === 38) a.foreground = color;
  else a.background = color;
}
function applySgr(a, params) {
  const groups = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.includes(':')) {
      const sub = g.split(':');
      const code = Number(sub[0] || 0);
      if (code === 4) a.underline = Number(sub[1] || 0) !== 0;
      else if (code === 38 || code === 48 || code === 58) setColor(a, code, colonColor(sub));
      else applyCode(a, code);
      continue;
    }
    const code = g === '' ? 0 : Number(g);
    if (code === 38 || code === 48 || code === 58) {
      const mode = groups[i + 1];
      if (mode === '5') { setColor(a, code, paletteHex(groups[i + 2])); i += 2; }
      else if (mode === '2') { setColor(a, code, rgbHex(groups[i + 2], groups[i + 3], groups[i + 4])); i += 4; }
      else i += 1;
      continue;
    }
    if (Number.isInteger(code)) applyCode(a, code);
  }
}

// ansiToGrid(text, { columns, rows, cursor: { column, row, visible }, alt }) -> render_grid
function ansiToGrid(text, opts) {
  const o = opts || {};
  const columns = Number(o.columns) || 0;
  const rows = Number(o.rows) || 0;
  const alt = !!o.alt;
  const cur = o.cursor || {};

  const styles = [];
  const styleIds = new Map();
  const intern = (a) => {
    const key = ATTR_KEYS.map((k) => a[k]).join('|');
    let id = styleIds.get(key);
    if (id === undefined) {
      id = styles.length;
      styleIds.set(key, id);
      const st = { id };
      for (const k of ATTR_KEYS) st[k] = a[k];
      styles.push(st);
    }
    return id;
  };
  intern(defaultAttrs());   // id 0 is always the default style

  let src = String(text || '');
  if (src.endsWith('\n')) src = src.slice(0, -1);   // capture-pane terminates its last row

  const lines = [];         // per line: its runs
  let runs = [];
  let open = null;          // the run the next printable char may extend
  let col = 0;
  const attrs = defaultAttrs();
  let sid = 0;
  let dirty = false;        // attrs changed since sid was computed

  const put = (ch, w) => {
    if (w === 0) {          // combining / zero-width: rides on the previous run, no advance
      const target = open || runs[runs.length - 1];
      if (target) target.text += ch;
      return;
    }
    if (dirty) { sid = intern(attrs); dirty = false; }
    if (!open || open.style_id !== sid) {
      open = { row: lines.length, column: col, style_id: sid, text: '', cell_width: 0 };
      runs.push(open);
    }
    open.text += ch;
    open.cell_width += w;
    col += w;
  };
  const endLine = () => {
    const last = runs[runs.length - 1];
    // tmux omits trailing default cells itself; a trailing default-style blank run is not content
    if (last && last.style_id === 0 && !last.text.trim()) runs.pop();
    lines.push(runs);
    runs = []; open = null; col = 0;
  };
  // Skip an escape string (OSC, DCS, SOS, PM, APC) up to BEL or ESC-backslash. A newline also ends
  // it, unconsumed, so a malformed sequence can never swallow the rows after it.
  const skipString = (j) => {
    for (; j < src.length; j++) {
      const c = src.charCodeAt(j);
      if (c === 0x07) return j + 1;
      if (c === 0x0a) return j;
      if (c === 0x1b && src[j + 1] === '\\') return j + 2;
    }
    return j;
  };

  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x1b) {
      const nx = src[i + 1];
      if (nx === '[') {
        let j = i + 2;
        while (j < src.length && src.charCodeAt(j) >= 0x30 && src.charCodeAt(j) <= 0x3f) j++;
        const params = src.slice(i + 2, j);
        const interStart = j;
        while (j < src.length && src.charCodeAt(j) >= 0x20 && src.charCodeAt(j) <= 0x2f) j++;
        const fin = src[j];
        if (fin === 'm' && j === interStart && !/^[<=>?]/.test(params)) { applySgr(attrs, params); dirty = true; }
        i = j < src.length ? j + 1 : j;
      } else if (nx === ']' || nx === 'P' || nx === 'X' || nx === '^' || nx === '_') {
        i = skipString(i + 2);
      } else {
        i += nx === undefined ? 1 : 2;
      }
      continue;
    }
    if (c === 0x0a) { endLine(); i++; continue; }
    if (c === 0x09) {       // capture-pane keeps a literal TAB: expand to the next tab stop
      let stop = (Math.floor(col / TAB_STOP) + 1) * TAB_STOP;
      if (columns > 0) stop = Math.min(stop, Math.max(col + 1, columns - 1));
      while (col < stop) put(' ', 1);
      i++;
      continue;
    }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) { i++; continue; }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    put(ch, charWidth(cp));
  }
  if (src.length || String(text || '').length) endLine();

  const hist = Math.max(0, lines.length - rows);
  const rowSpans = [];
  const sbSpans = [];
  lines.forEach((lineRuns, li) => {
    for (const r of lineRuns) {
      const span = { row: 0, column: r.column, style_id: r.style_id, text: r.text, cell_width: r.cell_width };
      if (li < hist) {
        if (alt) continue;  // the alternate screen has no scrollback of its own
        span.row = li;
        sbSpans.push(span);
      } else {
        span.row = li - hist;
        rowSpans.push(span);
      }
    }
  });

  return {
    columns,
    rows,
    active_screen: alt ? 'alternate' : 'primary',
    scrollback_rows: alt ? 0 : hist,
    cursor: {
      column: Number(cur.column) || 0,
      row: Number(cur.row) || 0,
      visible: cur.visible !== false,
      style: 'block',
      blinking: false,
    },
    styles,
    row_spans: rowSpans,
    scrollback_spans: sbSpans,
  };
}

module.exports = { ansiToGrid, charWidth, textWidth, paletteHex, DEFAULT_FG, DEFAULT_BG };
