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

// Display width, as tmux 3.6a itself lays cells out — MEASURED, not taken from Unicode's tables:
// every code point in U+00A0–U+D7FF, U+E000–U+FFFD, U+10000–U+1FBFF and U+E0000–U+E01EF was printed
// into a real tmux pane and its width read back (the sweep is re-run against these tables by
// test/tmux-review-fixes.test.js for the emoji blocks). tmux keeps its own emoji list, so e.g. ⚡ ✅
// 🚀 are wide while ☺ ✈ ❤ are narrow until a VS16 follows them. Ranges are hex `lo-hi` or `cp`;
// U+20000–U+3FFFD (CJK extensions) were not swept and follow Unicode (wide).
function ranges(spec) {
  return spec.trim().split(/\s+/).map((r) => {
    const [lo, hi] = r.split('-').map((h) => parseInt(h, 16));
    return [lo, hi === undefined ? lo : hi];
  });
}
const ZERO_WIDTH = ranges(
  '300-36f 483-489 591-5bd 5bf 5c1-5c2 5c4-5c5 5c7 600-605 610-61a 61c 64b-65f 670 6d6-6dd 6df-6e4 ' +
  '6e7-6e8 6ea-6ed 70f 711 730-74a 7a6-7b0 7eb-7f3 7fd 816-819 81b-823 825-827 829-82d 859-85b ' +
  '890-891 897-89f 8ca-903 93a-93c 93e-94f 951-957 962-963 981-983 9bc 9be-9c4 9c7-9c8 9cb-9cd 9d7 ' +
  '9e2-9e3 9fe a01-a03 a3c a3e-a42 a47-a48 a4b-a4d a51 a70-a71 a75 a81-a83 abc abe-ac5 ac7-ac9 ' +
  'acb-acd ae2-ae3 afa-aff b01-b03 b3c b3e-b44 b47-b48 b4b-b4d b55-b57 b62-b63 b82 bbe-bc2 bc6-bc8 ' +
  'bca-bcd bd7 c00-c04 c3c c3e-c44 c46-c48 c4a-c4d c55-c56 c62-c63 c81-c83 cbc cbe-cc4 cc6-cc8 ' +
  'cca-ccd cd5-cd6 ce2-ce3 cf3 d00-d03 d3b-d3c d3e-d44 d46-d48 d4a-d4d d57 d62-d63 d81-d83 dca ' +
  'dcf-dd4 dd6 dd8-ddf df2-df3 e31 e34-e3a e47-e4e eb1 eb4-ebc ec8-ece f18-f19 f35 f37 f39 f3e-f3f ' +
  'f71-f84 f86-f87 f8d-f97 f99-fbc fc6 102b-103e 1056-1059 105e-1060 1062-1064 1067-106d 1071-1074 ' +
  '1082-108d 108f 109a-109d 1160-11ff 135d-135f 1712-1715 1732-1734 1752-1753 1772-1773 17b4-17d3 ' +
  '17dd 180b-180f 1885-1886 18a9 1920-192b 1930-193b 1a17-1a1b 1a55-1a5e 1a60-1a7c 1a7f 1ab0-1add ' +
  '1ae0-1aeb 1b00-1b04 1b34-1b44 1b6b-1b73 1b80-1b82 1ba1-1bad 1be6-1bf3 1c24-1c37 1cd0-1cd2 ' +
  '1cd4-1ce8 1ced 1cf4 1cf7-1cf9 1dc0-1dff 200b-200f 2028-202e 2060-2064 2066-206f 20d0-20f0 ' +
  '2cef-2cf1 2d7f 2de0-2dff 302a-302d 3099-309a 3164 a66f-a672 a674-a67d a69e-a69f a6f0-a6f1 a802 ' +
  'a806 a80b a823-a827 a82c a880-a881 a8b4-a8c5 a8e0-a8f1 a8ff a926-a92d a947-a953 a980-a983 ' +
  'a9b3-a9c0 a9e5 aa29-aa36 aa43 aa4c-aa4d aa7b-aa7d aab0 aab2-aab4 aab7-aab8 aabe-aabf aac1 ' +
  'aaeb-aaef aaf5-aaf6 abe3-abea abec-abed d7b0-d7c6 d7cb-d7fb fb1e fe00-fe0f fe20-fe2f feff ' +
  'fff9-fffb 101fd 102e0 10376-1037a 10a01-10a03 10a05-10a06 10a0c-10a0f 10a38-10a3a 10a3f ' +
  '10ae5-10ae6 10d24-10d27 10d69-10d6d 10eab-10eac 10efa-10eff 10f46-10f50 10f82-10f85 11000-11002 ' +
  '11038-11046 11070 11073-11074 1107f-11082 110b0-110ba 110bd 110c2 110cd 11100-11102 11127-11134 ' +
  '11145-11146 11173 11180-11182 111b3-111c0 111c9-111cc 111ce-111cf 1122c-11237 1123e 11241 ' +
  '112df-112ea 11300-11303 1133b-1133c 1133e-11344 11347-11348 1134b-1134d 11357 11362-11363 ' +
  '11366-1136c 11370-11374 113b8-113c0 113c2 113c5 113c7-113ca 113cc-113d0 113d2 113e1-113e2 ' +
  '11435-11446 1145e 114b0-114c3 115af-115b5 115b8-115c0 115dc-115dd 11630-11640 116ab-116b7 ' +
  '1171d-1172b 1182c-1183a 11930-11935 11937-11938 1193b-1193e 11940 11942-11943 119d1-119d7 ' +
  '119da-119e0 119e4 11a01-11a0a 11a33-11a39 11a3b-11a3e 11a47 11a51-11a5b 11a8a-11a99 11b60-11b67 ' +
  '11c2f-11c36 11c38-11c3f 11c92-11ca7 11ca9-11cb6 11d31-11d36 11d3a 11d3c-11d3d 11d3f-11d45 11d47 ' +
  '11d8a-11d8e 11d90-11d91 11d93-11d97 11ef3-11ef6 11f00-11f01 11f03 11f34-11f3a 11f3e-11f42 11f5a ' +
  '13430-13440 13447-13455 1611e-1612f 16af0-16af4 16b30-16b36 16f4f 16f51-16f87 16f8f-16f92 16fe4 ' +
  '1bc9d-1bc9e 1bca0-1bca3 1cf00-1cf2d 1cf30-1cf46 1d165-1d169 1d16d-1d182 1d185-1d18b 1d1aa-1d1ad ' +
  '1d242-1d244 1da00-1da36 1da3b-1da6c 1da75 1da84 1da9b-1da9f 1daa1-1daaf 1e000-1e006 1e008-1e018 ' +
  '1e01b-1e021 1e023-1e024 1e026-1e02a 1e08f 1e130-1e136 1e2ae 1e2ec-1e2ef 1e4ec-1e4ef 1e5ee-1e5ef ' +
  '1e6e3 1e6e6 1e6ee-1e6ef 1e6f5 1e8d0-1e8d6 1e944-1e94a e0001 e0020-e007f e0100-e01ef');
const WIDE = ranges(
  '1100-115f 231a-231b 2329-232a 23e9-23ec 23f0 23f3 25fd-25fe 2614-2615 261d 2630-2637 2648-2653 ' +
  '267f 268a-268f 2693 26a1 26aa-26ab 26bd-26be 26c4-26c5 26ce 26d4 26ea 26f2-26f3 26f5 26f9-26fa ' +
  '26fd 2705 270a-270d 2728 274c 274e 2753-2755 2757 2795-2797 27b0 27bf 2b1b-2b1c 2b50 2b55 ' +
  '2e80-2e99 2e9b-2ef3 2f00-2fd5 2ff0-3029 302e-303e 3041-3096 309b-30ff 3105-312f 3131-3163 ' +
  '3165-318e 3190-31e5 31ef-321e 3220-3247 3250-a48c a490-a4c6 a960-a97c ac00-d7a3 f900-fa6d ' +
  'fa70-fad9 fe10-fe19 fe30-fe52 fe54-fe66 fe68-fe6b ff01-ff60 ffe0-ffe6 16fe0-16fe3 16ff0-16ff6 ' +
  '17000-18cd5 18cff-18d1e 18d80-18df2 1aff0-1aff3 1aff5-1affb 1affd-1affe 1b000-1b122 1b132 ' +
  '1b150-1b152 1b155 1b164-1b167 1b170-1b2fb 1d300-1d356 1d360-1d376 1f004 1f0cf 1f18e 1f191-1f19a ' +
  '1f200-1f202 1f210-1f23b 1f240-1f248 1f250-1f251 1f260-1f265 1f300-1f320 1f32d-1f335 1f337-1f37c ' +
  '1f37e-1f393 1f3a0-1f3cc 1f3cf-1f3d3 1f3e0-1f3f0 1f3f4 1f3f8-1f43e 1f440 1f442-1f4fc 1f4ff-1f53d ' +
  '1f54b-1f54e 1f550-1f567 1f574-1f575 1f57a 1f590 1f595-1f596 1f5a4 1f5fb-1f64f 1f680-1f6c5 1f6cc ' +
  '1f6d0-1f6d2 1f6d5-1f6d8 1f6dc-1f6df 1f6eb-1f6ec 1f6f4-1f6fc 1f7e0-1f7eb 1f7f0 1f90c-1f93a ' +
  '1f93c-1f945 1f947-1f9ff 1fa70-1fa7c 1fa80-1fa8a 1fa8e-1fac6 1fac8 1facd-1fadc 1fadf-1faea ' +
  '1faef-1faf8 20000-2fffd 30000-3fffd');
function inRanges(cp, list) {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < list[mid][0]) hi = mid - 1;
    else if (cp > list[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}
// One code point on its own.
function charWidth(cp) {
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

// Clusters, as tmux 3.6a draws them (measured the same way): a VS16 makes a narrow character wide
// (`variation-selector-always-wide`, on by default: ⚠️ ❤️ 1️⃣); a skin-tone modifier and anything after
// a ZWJ join a wide emoji instead of taking cells (👍🏽 🧑🏻‍💻 🏳️‍🌈); consecutive regional indicators
// make one two-cell flag (🇺🇸). step() returns how many cells a code point adds and whether it joins
// the cluster before it; `st` is the per-row cluster state.
const isRI = (cp) => cp >= 0x1F1E6 && cp <= 0x1F1FF;
const newCluster = () => ({ w: 0, ri: false, zwj: false });
function step(st, cp) {
  if (st.w > 0) {
    if (cp === 0xFE0F) { const add = st.w === 1 ? 1 : 0; st.w += add; return { join: true, add }; }
    if (st.zwj) { st.zwj = false; if (st.w === 2) return { join: true, add: 0 }; }
    if (cp === 0x200D) { st.zwj = true; return { join: true, add: 0 }; }
    if (cp >= 0x1F3FB && cp <= 0x1F3FF && st.w === 2) return { join: true, add: 0 };
    if (st.ri && isRI(cp)) { const add = st.w === 1 ? 1 : 0; st.w += add; return { join: true, add }; }
  }
  const w = charWidth(cp);
  if (w === 0) return { join: true, add: 0 };
  st.w = w; st.ri = isRI(cp); st.zwj = false;
  return { join: false, add: w };
}
function textWidth(s) {
  const st = newCluster();
  let w = 0;
  for (const ch of String(s || '')) w += step(st, ch.codePointAt(0)).add;
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

  let cl = newCluster();     // the cluster the next code point may join
  const put = (ch, cp) => {
    const { join, add } = step(cl, cp);
    if (join) {             // joins the character before it: same cell(s), maybe one cell wider
      const target = open || runs[runs.length - 1];
      if (target) { target.text += ch; target.cell_width += add; col += add; }
      return;
    }
    const w = add;
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
    // Trailing blanks in the default style are not content (capture-pane -N pads every row to the
    // pane width; a coloured fill to the end of the line is kept, it is not the default style).
    const last = runs[runs.length - 1];
    if (last && last.style_id === 0) {
      const kept = last.text.replace(/ +$/, '');
      last.cell_width -= last.text.length - kept.length;
      last.text = kept;
      if (!kept.trim()) runs.pop();
    }
    lines.push(runs);
    runs = []; open = null; col = 0; cl = newCluster();
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
      while (col < stop) put(' ', 0x20);
      i++;
      continue;
    }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) { i++; continue; }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    put(ch, cp);
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
