'use strict';
// S2-0b: a git diff must not carry a credential file's content to the phone. The diff routes take
// a pathspec (a dir, `.`, or pathspec magic all widen it), so the guard runs on the OUTPUT: every
// per-file section whose old or new path is a denied path (lib/secret-paths) is replaced by a
// one-line note. Fail closed: a section whose path cannot be read is dropped too.
const path = require('path');
const { isDeniedPath } = require('./secret-paths');

// git C-quotes paths with special bytes: "a/x\tb". Undo it (octal escapes become byte chars).
function unquote(s) {
  if (!s.startsWith('"')) return s;
  const SIMPLE = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') return out;
    if (ch !== '\\') { out += ch; continue; }
    const esc = s[++i];
    if (esc === undefined) return out;
    if (/[0-7]/.test(esc)) {
      let d = esc;
      while (d.length < 3 && /[0-7]/.test(s[i + 1] || '')) d += s[++i];
      out += String.fromCharCode(parseInt(d, 8));
    } else out += esc in SIMPLE ? SIMPLE[esc] : esc;
  }
  return out;
}

// A per-file section starts here: two-way (`--git`) and merge-conflict combined (`--cc`, `--combined`).
const SECTION_RE = /^diff (--git|--cc|--combined) /;

const strip = (p, prefix) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);

/** Repo-relative paths named by one diff section (header, ---/+++, rename/copy lines). */
function sectionPaths(lines) {
  const out = [];
  const m0 = SECTION_RE.exec(lines[0]);
  const head = m0 ? lines[0].slice(m0[0].length) : '';
  if (m0 && m0[1] !== '--git') {
    // combined diff header names ONE path, unprefixed, C-quoted when needed
    if (head) out.push(unquote(head));
  } else if (head.startsWith('"')) {
    // "a/x" "b/y" or "a/x" b/y — split at the first closing quote
    const end = head.indexOf('" ', 1);
    if (end > 0) {
      const a = strip(unquote(head.slice(0, end + 1)), 'a/');
      const rest = head.slice(end + 2);
      const b = strip(unquote(rest), 'b/');
      if (a != null) out.push(a);
      if (b != null) out.push(b);
    }
  } else if (head.startsWith('a/')) {
    // a/X b/Y with spaces is ambiguous; when old == new (the common case) the halves are symmetric.
    const body = head.slice(2);
    const half = (body.length - 3) / 2;
    if (Number.isInteger(half) && body.slice(half, half + 3) === ' b/' && body.slice(0, half) === body.slice(half + 3)) out.push(body.slice(0, half));
    else {
      const i = body.indexOf(' b/');
      if (i > 0) { out.push(body.slice(0, i)); out.push(body.slice(i + 3)); }
    }
  }
  for (const l of lines.slice(1)) {
    if (l.startsWith('@@')) break;               // hunks start (incl. combined @@@): no more header lines
    let m;
    if ((m = /^(?:---|\+\+\+) (.*)$/.exec(l))) {
      const v = unquote(m[1].replace(/\t.*$/, ''));
      if (v !== '/dev/null') { const r = strip(v, 'a/') ?? strip(v, 'b/'); if (r != null) out.push(r); }
    } else if ((m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(l))) out.push(unquote(m[1]));
    else if ((m = /^Binary files (.*) and (.*) differ$/.exec(l))) {
      for (const v of [m[1], m[2]]) { const u = unquote(v); if (u !== '/dev/null') { const r = strip(u, 'a/') ?? strip(u, 'b/'); if (r != null) out.push(r); } }
    }
  }
  return out;
}

/**
 * Drop every section of a `git diff` whose file is a credential path.
 * `top` = the repo's realpath'd top dir. Returns { diff, redacted: number of sections removed }.
 */
function redactDeniedDiff(text, top, home) {
  if (!text) return { diff: text || '', redacted: 0 };
  const lines = text.split('\n');
  const out = [];
  let redacted = 0;
  let i = 0;
  // Preamble: text before the first section. git prints none; anything here came from something
  // else (an external diff tool, a new format) and cannot be attributed to a file, so it is dropped.
  const pre = [];
  while (i < lines.length && !SECTION_RE.test(lines[i])) pre.push(lines[i++]);
  if (pre.some((l) => l.trim())) { redacted++; out.push('# hidden by HyperMux: diff text without a file header is never sent'); }
  while (i < lines.length) {
    const start = i++;
    while (i < lines.length && !SECTION_RE.test(lines[i])) i++;
    const sec = lines.slice(start, i);
    const rels = sectionPaths(sec);
    const denied = !rels.length || rels.some((r) => isDeniedPath(path.resolve(top, r), home));
    if (denied) { redacted++; out.push(`# hidden by HyperMux: a credential file's diff is never sent (${rels.length ? 'denied path' : 'unreadable header'})`); }
    else out.push(...sec);
  }
  return { diff: out.join('\n'), redacted };
}

module.exports = { redactDeniedDiff, sectionPaths };
