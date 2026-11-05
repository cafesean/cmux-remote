'use strict';
// S2r: a Claude/Anthropic token never leaves the Mac in a bridge reply. A session started on a named
// account has CLAUDE_CODE_OAUTH_TOKEN in its env, so `env` in a tool call, a pasted key or a printed
// config can put one into a transcript or onto the terminal screen. Every text the bridge sends out
// (JSON replies and SSE events) passes through here first.
// Shape: sk-ant-<kind><version?>-<body>, e.g. sk-ant-oat01-…, sk-ant-api03-…, sk-ant-admin01-…
// Token characters are [A-Za-z0-9_-], which JSON never escapes, so this works on serialized JSON too.
const TOKEN_RE = /sk-ant-[a-z]+\d*-[A-Za-z0-9_-]{8,}/g;
const MASK = 'sk-ant-…[redacted]';

function redactTokens(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.includes('sk-ant-') ? s.replace(TOKEN_RE, MASK) : s;
}

module.exports = { redactTokens, MASK };

// ---- terminal text: a token can wrap over rows ---------------------------------------------------
// A long `TOKEN=…` line wraps on an 80-column terminal, so the prefix and the body can sit on
// different rows (or in different styled spans). Pieces are joined in reading order, the token is
// found on the joined text, and its characters after `sk-ant-` become `*` in place — row count,
// row lengths and span widths stay the same, so the layout does not move. Over-masking is possible
// (a token that ends at a row end also masks the next row's leading word characters); that is safe.
// Residual (documented in the spec): a token whose `sk-ant-` prefix already scrolled off the top of
// what the bridge read cannot be recognised in the rows that remain.
const KEEP = 'sk-ant-'.length;

function maskPieces(texts, joinNext) {
  let flat = '';
  const owner = [];   // flat index -> [piece, offset] | null for a separator
  texts.forEach((t, i) => {
    for (let k = 0; k < t.length; k++) { flat += t[k]; owner.push([i, k]); }
    if (!joinNext(i)) { flat += '\n'; owner.push(null); }
  });
  if (!flat.includes('sk-ant-')) return texts;
  const hit = texts.map(() => null);
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(flat))) {
    for (let k = m.index + KEEP; k < m.index + m[0].length; k++) {
      const o = owner[k];
      if (!o) continue;
      (hit[o[0]] || (hit[o[0]] = new Set())).add(o[1]);
    }
  }
  return texts.map((t, i) => (hit[i] ? [...t].map((c, k) => (hit[i].has(k) ? '*' : c)).join('') : t));
}

/**
 * Rows of terminal text (top to bottom). A row continues on the next only when it is full: the
 * terminal read trims trailing blanks, so a wrapped row is as long as the longest row of the read.
 */
function redactRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const texts = rows.map((r) => (typeof r === 'string' ? r : ''));
  const width = texts.reduce((w, t) => Math.max(w, t.length), 0);
  const out = maskPieces(texts, (i) => i + 1 < texts.length && texts[i].length >= width);
  return out === texts ? rows : rows.map((r, i) => (typeof r === 'string' ? out[i] : r));
}

/** A terminal snapshot as one string with `\n` between rows. */
function redactText(s) {
  if (typeof s !== 'string' || !s) return s;
  return redactRows(s.split('\n')).join('\n');
}

/**
 * A styled grid { columns, spans:[{row, column, text}] }. Spans join when they touch on a row, and a
 * row joins the next one only when it is full (its last span reaches `columns`; columns 0 = unknown
 * width, treated as full).
 */
function redactGrid(grid) {
  if (!grid || !Array.isArray(grid.spans) || !grid.spans.length) return grid;
  const order = grid.spans.map((s, i) => i).sort((a, b) => (grid.spans[a].row - grid.spans[b].row) || (grid.spans[a].column - grid.spans[b].column));
  const sp = order.map((i) => grid.spans[i]);
  const texts = sp.map((s) => (typeof s.text === 'string' ? s.text : ''));
  const cols = Number(grid.columns) || 0;
  const joinNext = (i) => {
    const a = sp[i], b = sp[i + 1];
    if (!b) return false;
    const end = a.column + texts[i].length;
    if (b.row === a.row) return end === b.column;
    return b.row === a.row + 1 && b.column === 0 && (cols === 0 || end >= cols);
  };
  const out = maskPieces(texts, joinNext);
  if (out === texts) return grid;
  const spans = grid.spans.slice();
  order.forEach((orig, j) => { if (out[j] !== texts[j]) spans[orig] = { ...grid.spans[orig], text: out[j] }; });
  return { ...grid, spans };
}

module.exports.redactRows = redactRows;
module.exports.redactText = redactText;
module.exports.redactGrid = redactGrid;
