'use strict';
// p41 A4 — Obsidian-style callouts in assistant text (spec §3 "Callouts: the open format").
//
//   parseCallouts(markdown, {seanBanner}) -> {type, title, body, options: string[]}[]
//   splitCallouts(markdown, {seanBanner}) -> {text, callouts}   text = markdown without the callout lines
//
// A callout is a blockquote whose first line is `> [!type] Title`. The type is `[a-z][a-z0-9-]*` in any
// case, stored lower case. Obsidian's fold markers (`[!type]-`, `[!type]+`) are accepted and ignored. The
// following `>` lines are the body, except an `options: A | B | C` line (key in any case), which becomes
// `options` and leaves the body. Unknown types are kept as custom types.
//
// Fenced code (``` and ~~~) and indented code are example text: nothing in them is a callout.
//
// Sean's █ banner is the `seanBanner` preset (off unless asked): a run of rows that start with █ and hold at
// least one `██  N. ask` row is one needs-you callout whose body is the asks. A run with no numbered ask
// stays text. Callouts come out in the order they appear in the text.
const CALLOUT_TYPES = ['needs-you', 'done', 'handover', 'decision', 'warning', 'info'];
const LIMITS = { maxCallouts: 20, titleMax: 200, maxOptions: 8, optionMax: 80 };

const HEADER = /^ {0,3}>[ \t]*\[!([A-Za-z][A-Za-z0-9-]*)\][+-]?[ \t]*(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const OPTIONS = /^options:\s*(.*)$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ASK = /^█+\s+\d+\.\s*(.*)$/;

const defaultTitle = (type) => {
  const t = type.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function quoteBlock(lines, start) {
  const m = HEADER.exec(lines[start]);
  const body = [];
  const options = [];
  let end = start + 1;
  for (; end < lines.length; end++) {
    const q = QUOTE.exec(lines[end]);
    if (!q || HEADER.test(lines[end])) break;
    const o = OPTIONS.exec(q[1].trim());
    if (o) options.push(...o[1].split('|').map((s) => s.trim()).filter(Boolean));
    else body.push(q[1]);
  }
  const type = m[1].toLowerCase();
  return {
    end,
    callout: {
      type,
      title: (m[2].trim() || defaultTitle(type)).slice(0, LIMITS.titleMax),
      body: body.join('\n').trim(),
      options: options.slice(0, LIMITS.maxOptions).map((s) => s.slice(0, LIMITS.optionMax)),
    },
  };
}

function bannerBlock(lines, start) {
  let end = start;
  while (end < lines.length && lines[end].startsWith('█')) end++;
  const asks = lines.slice(start, end).map((r) => ASK.exec(r)).filter(Boolean).map((m) => m[1].trim());
  if (!asks.length) return null;
  return { end, callout: { type: 'needs-you', title: 'Needs you', body: asks.join('\n'), options: [] } };
}

function splitCallouts(markdown, { seanBanner = false } = {}) {
  if (typeof markdown !== 'string') return { text: '', callouts: [] };
  const lines = markdown.split('\n');
  const keep = [];
  const callouts = [];
  let fence = null;      // the opening fence marker while inside a code fence
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
    } else if (f && !(f[1][0] === '`' && line.includes('`', f[0].length))) {
      fence = f[1];
    } else if (callouts.length < LIMITS.maxCallouts) {
      const indented = /^( {4}|\t)/.test(line);
      const hit = indented ? null
        : HEADER.test(line) ? quoteBlock(lines, i)
        : seanBanner && line.startsWith('█') ? bannerBlock(lines, i)
        : null;
      if (hit) {
        callouts.push(hit.callout);
        i = hit.end;
        // The blank line that followed the callout would double up with the one before it.
        if (i < lines.length && !lines[i].trim() && (!keep.length || !keep[keep.length - 1].trim())) i++;
        continue;
      }
    }
    keep.push(line);
    i++;
  }
  return { text: callouts.length ? keep.join('\n').trim() : markdown, callouts };
}

const parseCallouts = (markdown, opts) => splitCallouts(markdown, opts).callouts;

module.exports = { parseCallouts, splitCallouts, CALLOUT_TYPES, LIMITS };
