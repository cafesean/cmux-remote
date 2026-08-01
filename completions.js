'use strict';
// completions — candidates for the compose box's `@` and `/` tokens (p7 §6.2).
//
// Segment-wise, like a shell: the token's dirname selects ONE directory and the candidates are that
// directory's entries. This is not a simplification, it is the only bounded design — "files under
// the workspace cwd" for a repo root means walking node_modules (100k+ entries) on the machine the operator
// is interactively using, at roughly typing cadence. A cap on the response does not bound the walk.
//
// Kept out of bridge.js so it unit-tests with no HTTP and no cmux: every external thing it needs is
// injected. Same shape as fsbrowse.js, which exists for the same reason.

const path = require('path');

const MAX_CANDIDATES = 60;
// Never descend into these. They are the reason a recursive design would be unusable, and they are
// also uninteresting as `@` mentions.
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache', 'target', '.venv']);

class CompletionError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// The word at the caret. Returns null when the caret is not inside an @ or / token — the common
// case, and the one where the whole feature must stay silent.
function tokenAt(text, caret) {
  const s = String(text == null ? '' : text);
  const pos = Math.max(0, Math.min(Number.isFinite(caret) ? caret : s.length, s.length));
  let start = pos;
  while (start > 0 && !/\s/.test(s[start - 1])) start--;
  const word = s.slice(start, pos);
  if (!word) return null;
  const sigil = word[0];
  if (sigil !== '@' && sigil !== '/') return null;
  // A `/` only opens a command menu at the very start of the line — otherwise every absolute path
  // typed mid-sentence would trigger one.
  if (sigil === '/' && !/^\s*$/.test(s.slice(0, start))) return null;
  return { sigil, body: word.slice(1), start, end: pos };
}

// Split a token body into "the directory part" and "the prefix being typed".
function splitSegment(body) {
  const i = body.lastIndexOf('/');
  return i < 0 ? { dir: '', prefix: body } : { dir: body.slice(0, i + 1), prefix: body.slice(i + 1) };
}

// Reject rather than resolve. An absolute path or a `..` escape is not a completion request we can
// serve from a workspace cwd, and quietly resolving it is how a jail becomes decorative.
function safeJoin(root, rel) {
  if (rel.startsWith('/') || rel.startsWith('~')) throw new CompletionError('absolute_path');
  const joined = path.resolve(root, rel);
  const rootRes = path.resolve(root);
  if (joined !== rootRes && !joined.startsWith(rootRes + path.sep)) throw new CompletionError('outside_root');
  return joined;
}

const rank = (a, b) => (a.text.length - b.text.length) || a.text.localeCompare(b.text);

function createCompletions(opts = {}) {
  const cwdForSurface = opts.cwdForSurface || (async () => null);
  const readdir = opts.readdir || require('fs/promises').readdir;
  const homedir = opts.homedir || require('os').homedir();

  // ---- @ : files and directories, one readdir deep ---------------------------------------------
  async function files(cwd, body) {
    const { dir, prefix } = splitSegment(body);
    const abs = safeJoin(cwd, dir || '.');
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true }); }
    catch (e) { throw new CompletionError(e && e.code === 'ENOENT' ? 'not_found' : 'unreadable'); }
    const lower = prefix.toLowerCase();
    const out = [];
    for (const e of entries) {
      const name = e.name;
      if (IGNORE_DIRS.has(name)) continue;
      if (lower && !name.toLowerCase().startsWith(lower)) continue;
      const isDir = typeof e.isDirectory === 'function' ? e.isDirectory() : !!e.isDirectory;
      out.push({ text: dir + name + (isDir ? '/' : ''), kind: isDir ? 'dir' : 'file' });
    }
    out.sort(rank);
    return out;
  }

  // ---- / : skills, commands and agents from disk -------------------------------------------------
  // Best effort BY DESIGN: Claude's own menu is dynamic and context-sensitive, so this list can
  // drift. That is a documented property, not a bug to chase — the live-menu mirror (§6.1) is what
  // shows the real thing; this is what works before anything has been sent.
  async function commands(cwd, prefix) {
    const roots = [
      { dir: path.join(homedir, '.claude', 'commands'), kind: 'command' },
      { dir: path.join(homedir, '.claude', 'skills'), kind: 'skill' },
      { dir: path.join(homedir, '.claude', 'agents'), kind: 'agent' },
      { dir: path.join(cwd || homedir, '.claude', 'commands'), kind: 'command' },
      { dir: path.join(cwd || homedir, '.claude', 'skills'), kind: 'skill' },
      { dir: path.join(cwd || homedir, '.claude', 'agents'), kind: 'agent' },
    ];
    const seen = new Set();
    const out = [];
    for (const r of roots) {
      let entries;
      try { entries = await readdir(r.dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const isDir = typeof e.isDirectory === 'function' ? e.isDirectory() : !!e.isDirectory;
        const name = isDir ? e.name : e.name.replace(/\.(md|markdown)$/i, '');
        if (!name || name.startsWith('.') || seen.has(r.kind + ':' + name)) continue;
        seen.add(r.kind + ':' + name);
        out.push({ text: name, kind: r.kind });
      }
    }
    const lower = String(prefix || '').toLowerCase();
    const matched = lower
      ? out.filter((c) => c.text.toLowerCase().startsWith(lower)).concat(
          out.filter((c) => !c.text.toLowerCase().startsWith(lower) && c.text.toLowerCase().includes(lower)))
      : out;
    return matched;
  }

  /**
   * complete({surface, text, caret}) -> {token, candidates, truncated} | null
   * null means "the caret is not in a completion token" — silence, which is the common answer.
   */
  async function complete({ surface, text, caret }) {
    const tok = tokenAt(text, caret);
    if (!tok) return null;
    const cwd = await cwdForSurface(surface);
    if (!cwd) throw new CompletionError('no_cwd');

    const all = tok.sigil === '@' ? await files(cwd, tok.body) : await commands(cwd, tok.body);
    const truncated = all.length > MAX_CANDIDATES;
    return {
      token: { sigil: tok.sigil, body: tok.body, start: tok.start, end: tok.end },
      candidates: all.slice(0, MAX_CANDIDATES),
      truncated,
      total: all.length,
    };
  }

  return { complete, tokenAt, splitSegment, MAX_CANDIDATES };
}

module.exports = { createCompletions, tokenAt, splitSegment, safeJoin, CompletionError, IGNORE_DIRS, MAX_CANDIDATES };
