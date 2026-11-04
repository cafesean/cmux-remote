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

const PLUGIN_CACHE_MS = 60 * 1000;
const DESC_MAX = 100;

// Claude Code's own slash commands. Static on purpose: they live in the binary, not on disk, so there is
// nothing to scan. Best effort like the rest of `/` — a new release can add one before this list does.
const BUILTINS = [
  ['add-dir', 'Add a working directory'], ['agents', 'Manage subagents'], ['bug', 'Report a bug'],
  ['clear', 'Clear the conversation'], ['color', 'Set the prompt bar color'],
  ['compact', 'Compact the conversation'], ['config', 'Open settings'],
  ['context', 'Show context usage'], ['cost', 'Show token cost'], ['doctor', 'Check the install'],
  ['exit', 'Exit Claude Code'], ['export', 'Export the conversation'], ['help', 'Show help'],
  ['hooks', 'Manage hooks'], ['ide', 'Manage IDE integration'], ['init', 'Create a CLAUDE.md'],
  ['login', 'Sign in'], ['logout', 'Sign out'], ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit memory files'], ['model', 'Switch model'], ['output-style', 'Set the output style'],
  ['permissions', 'Manage tool permissions'], ['plugin', 'Manage plugins'],
  ['rename', 'Rename the session'], ['resume', 'Resume a past session'],
  ['review', 'Review a pull request'], ['rewind', 'Rewind the conversation or code'],
  ['status', 'Show status'], ['statusline', 'Set up the status line'],
  ['terminal-setup', 'Install terminal key bindings'], ['todos', 'List todo items'],
  ['usage', 'Show plan usage'], ['vim', 'Toggle vim mode'],
].map(([text, desc]) => ({ text, kind: 'builtin', desc }));

// Module-level so every createCompletions() in the process shares one scan; keyed by home so a test
// pointing at a temp home never sees another's result.
const pluginCache = new Map();

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
  const readFile = opts.readFile || require('fs/promises').readFile;
  const now = opts.now || Date.now;

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

  // ---- / : built-ins, plugins, then skills, commands and agents from disk ---------------------------
  // Best effort BY DESIGN: Claude's own menu is dynamic and context-sensitive, so this list can
  // drift. That is a documented property, not a bug to chase — the live-menu mirror (§6.1) is what
  // shows the real thing; this is what works before anything has been sent.
  const isDirent = (e) => (typeof e.isDirectory === 'function' ? e.isDirectory() : !!e.isDirectory);

  // First `description:` line of a frontmatter block. A folded/literal value (`>` / `|`) keeps its
  // text on the next line, so take that one instead.
  async function describe(file) {
    let src;
    try { src = await readFile(file, 'utf8'); } catch (_) { return ''; }
    const lines = String(src).split(/\r?\n/);
    if (lines[0].trim() !== '---') return '';
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = /^description:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      let v = m[1].trim();
      if (/^[>|][+-]?$/.test(v)) v = (lines[i + 1] || '').trim();
      v = v.replace(/^(["'])(.*)\1$/, '$2');
      return v.length > DESC_MAX ? v.slice(0, DESC_MAX - 1) + '…' : v;
    }
    return '';
  }

  async function readJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch (_) { return null; }
  }

  async function scanPlugin(plugin, installPath) {
    const out = [];
    const sub = async (dir, kind) => {
      let entries;
      try { entries = await readdir(path.join(installPath, dir), { withFileTypes: true }); } catch (_) { return; }
      await Promise.all(entries.map(async (e) => {
        const isSkill = kind === 'skill';
        if (e.name.startsWith('.')) return;
        if (isSkill ? !(isDirent(e) || (e.isSymbolicLink && e.isSymbolicLink())) : !/\.(md|markdown)$/i.test(e.name)) return;
        const name = isSkill ? e.name : e.name.replace(/\.(md|markdown)$/i, '');
        const file = isSkill ? path.join(installPath, dir, e.name, 'SKILL.md') : path.join(installPath, dir, e.name);
        const desc = await describe(file);
        out.push(Object.assign({ text: plugin + ':' + name, kind }, desc ? { desc } : {}));
      }));
    };
    await Promise.all([sub('skills', 'skill'), sub('commands', 'command'), sub('agents', 'agent')]);
    out.sort((a, b) => a.text.localeCompare(b.text));   // Promise.all finishes in disk-latency order
    return out;
  }

  // Enabled plugins only (settings.json `enabledPlugins`; a missing key means "all installed").
  // Hundreds of files, so scanned at most once per PLUGIN_CACHE_MS rather than per keystroke.
  async function plugins() {
    const hit = pluginCache.get(homedir);
    if (hit && now() - hit.at < PLUGIN_CACHE_MS) return hit.list;
    const [installed, settings] = await Promise.all([
      readJson(path.join(homedir, '.claude', 'plugins', 'installed_plugins.json')),
      readJson(path.join(homedir, '.claude', 'settings.json')),
    ]);
    const enabled = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : null;
    const scans = [];
    for (const [key, installs] of Object.entries((installed && installed.plugins) || {})) {
      if (enabled && !enabled[key]) continue;
      const plugin = key.split('@')[0];
      for (const inst of Array.isArray(installs) ? installs : []) {
        if (inst && inst.installPath) scans.push(scanPlugin(plugin, inst.installPath));
      }
    }
    const list = (await Promise.all(scans)).flat();
    pluginCache.set(homedir, { at: now(), list });
    return list;
  }

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
    const add = (c) => {
      if (seen.has(c.text)) return;      // one chip per name: two identical chips are not a choice
      seen.add(c.text);
      out.push(c);
    };
    // Order here is the tiebreak among equally-matched candidates: your own, then built-ins, then plugins.
    for (const r of roots) {
      let entries;
      try { entries = await readdir(r.dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const name = isDirent(e) ? e.name : e.name.replace(/\.(md|markdown)$/i, '');
        if (!name || name.startsWith('.')) continue;
        add({ text: name, kind: r.kind });
      }
    }
    BUILTINS.forEach(add);
    (await plugins()).forEach(add);
    const lower = String(prefix || '').toLowerCase();
    if (!lower) return out;
    // `plugin:name` also counts as a prefix match on `name`, so `/cav` finds `tools:caveman`.
    const isPrefix = (t) => { const l = t.toLowerCase(); const i = l.indexOf(':'); return l.startsWith(lower) || (i >= 0 && l.slice(i + 1).startsWith(lower)); };
    return out.filter((c) => isPrefix(c.text)).concat(
      out.filter((c) => !isPrefix(c.text) && c.text.toLowerCase().includes(lower)));
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

module.exports = { createCompletions, BUILTINS, tokenAt, splitSegment, safeJoin, CompletionError, IGNORE_DIRS, MAX_CANDIDATES };
