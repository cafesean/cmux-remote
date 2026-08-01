'use strict';
// gitpanel — source control for the machine the bridge runs on (p7 Track C).
//
// Bridge-side, not server-side: a machine's repos live on that machine, the same reason fsbrowse is
// here. Every external thing is injected so route logic tests without spawning git.
//
// TWO RULES THIS MODULE ENFORCES, both because the UI cannot:
//
//  1. EVERY CHECK THE UI PERFORMS IS PERFORMED AGAIN HERE, before anything is spawned. Disabling a
//     control in the client is a courtesy to the user; the route is reachable directly with the
//     same token. Repo membership, path validation and the unmerged refusal all live below.
//  2. NOTHING IS EVER INTERPOLATED INTO A SHELL. Reads and writes use argv arrays. The one place a
//     shell is involved is the command TEXT generated for a terminal — and every value in it goes
//     through shellQuote(), because `git check-ref-format` says a ref is well-formed, not that it is
//     safe to put on a command line. Git happily accepts branch names and paths containing `$`,
//     backticks, semicolons, quotes, newlines and leading dashes.

const path = require('path');
const { realpath } = require('fs/promises');
const { gitIn, gitTest, mapLimit } = require('./lib/gitcmd');
const { parseStatusZ, parseBranchHeader, parseWorktreePorcelain } = require('./lib/gitporcelain');

const DIFF_MAX_BYTES = 256 * 1024;
const MAX_PATHS_PER_WRITE = 200;
const GIT_CONCURRENCY = 6;

class GitPanelError extends Error {
  constructor(code, status) { super(code); this.name = 'GitPanelError'; this.code = code; this.status = status || 400; }
}

// ---- §12.2 quoting ------------------------------------------------------------------------------

// POSIX single-quote escaping: wrap in single quotes, and end/reopen around any embedded quote.
// One implementation, used for every interpolated value, no exemptions.
function shellQuote(v) {
  const s = String(v == null ? '' : v);
  if (s === '') return "''";
  return "'" + s.split("'").join("'\\''") + "'";
}

// Generated command TEXT for a terminal. A fixed template per verb — there is no free-form command
// construction anywhere — and `--` before every pathspec so a file called `-rf` is a file.
const COMMAND_TEMPLATES = {
  commit: ({ message }) => `git commit -m ${shellQuote(message || '')}`,
  push: ({ branch }) => (branch ? `git push origin ${shellQuote(branch)}` : 'git push'),
  pull: () => 'git pull --ff-only',
  fetch: () => 'git fetch --all --prune',
  checkout: ({ branch }) => `git checkout ${shellQuote(branch)}`,
  merge: ({ branch }) => `git merge --no-ff ${shellQuote(branch)}`,
  rebase: ({ branch }) => `git rebase ${shellQuote(branch)}`,
  stash: () => 'git stash push -u',
  discard: ({ paths }) => `git restore -- ${(paths || []).map(shellQuote).join(' ')}`,
  clean: () => 'git clean -nd',                    // dry run by design; the user removes the -n
  'worktree-add': ({ dir, branch }) => `git worktree add ${shellQuote(dir)} ${shellQuote(branch)}`,
};

// ---- §12.3 path and repo validation ---------------------------------------------------------------

// Repo-relative pathspec validation. NOT realpath: you stage DELETIONS, and a deleted file has no
// realpath — a jail built on realpath cannot express the very operation it is guarding.
function validatePathspec(rel) {
  const s = String(rel == null ? '' : rel);
  if (!s) throw new GitPanelError('empty_path');
  if (s.startsWith('/') || s.startsWith('~')) throw new GitPanelError('absolute_path');
  if (s.includes('\0')) throw new GitPanelError('bad_path');
  const norm = path.posix.normalize(s);
  if (norm === '..' || norm.startsWith('../')) throw new GitPanelError('outside_repo');
  return norm;
}

// Segment-wise containment. A plain prefix test says /a/repo-2 is inside /a/repo.
function isInside(parent, child) {
  const p = path.resolve(parent), c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

function createGitPanel(opts = {}) {
  const workspaceCwds = opts.workspaceCwds || (async () => []);
  const run = opts.gitIn || gitIn;
  const test = opts.gitTest || gitTest;
  const log = opts.log || (() => {});
  const now = opts.now || (() => new Date().toISOString());
  const writesEnabled = !!opts.writesEnabled;

  // ---- repos ---------------------------------------------------------------------------------

  // The repos on offer are the projects actually open on the Mac — no second configuration to keep
  // in sync with reality. A worktree is its own toplevel and therefore its own repo.
  async function repos() {
    const cwds = await workspaceCwds();
    const seen = new Map();
    await mapLimit(cwds, GIT_CONCURRENCY, async (w) => {
      if (!w || !w.path) return;
      const r = await run(w.path, ['rev-parse', '--show-toplevel'], { timeoutMs: 6000 });
      if (!r.ok) return;
      const top = (r.stdout || '').trim();
      if (!top) return;
      if (!seen.has(top)) seen.set(top, { path: top, name: path.basename(top), labels: [] });
      if (w.label && !seen.get(top).labels.includes(w.label)) seen.get(top).labels.push(w.label);
    });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Canonical membership: only a repo we discovered is addressable. Comparison is by REALPATH, not
  // by path.resolve — symlinked checkouts are ordinary (on macOS even /var is a symlink to
  // /private/var, so git reports a different string than the caller passes), and a lexical compare
  // rejects the same repo under two spellings while a prefix compare would accept a sibling.
  async function realOf(p) {
    try { return await realpath(p); } catch (_) { return path.resolve(p); }
  }
  async function assertRepo(repo) {
    const want = String(repo || '');
    if (!want) throw new GitPanelError('no_repo');
    const [list, wantReal] = await Promise.all([repos(), realOf(want)]);
    const reals = await Promise.all(list.map((r) => realOf(r.path)));
    const i = reals.indexOf(wantReal);
    if (i < 0) throw new GitPanelError('unknown_repo', 403);
    return list[i].path;
  }

  // ---- reads ---------------------------------------------------------------------------------

  async function status(repo) {
    const dir = await assertRepo(repo);
    const r = await run(dir, ['status', '--branch', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const out = r.stdout || '';
    const firstNul = out.indexOf('\0');
    const header = firstNul < 0 ? out : out.slice(0, firstNul);
    const rest = firstNul < 0 ? '' : out.slice(firstNul + 1);
    const branch = parseBranchHeader(header);
    const files = parseStatusZ(rest);
    // A merge or rebase in progress changes what staging MEANS, so the panel says so rather than
    // silently offering controls that resolve conflicts by accident.
    const [merging, rebasing] = await Promise.all([
      test(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { timeoutMs: 4000 }),
      test(dir, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], { timeoutMs: 4000 }),
    ]);
    return {
      repo: dir,
      branch,
      files,
      counts: {
        staged: files.filter((f) => f.staged).length,
        unstaged: files.filter((f) => f.unstaged).length,
        untracked: files.filter((f) => f.untracked).length,
        unmerged: files.filter((f) => f.unmerged).length,
      },
      inProgress: { merge: merging === true, rebase: rebasing === true },
    };
  }

  async function branches(repo) {
    const dir = await assertRepo(repo);
    const SEP = '';   // git refuses control characters in ref names, so splitting on it is total
    const r = await run(dir, ['for-each-ref', '--sort=-committerdate',
      `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(committerdate:iso8601)${SEP}%(HEAD)`,
      'refs/heads']);
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const rows = (r.stdout || '').split('\n').filter(Boolean);
    const out = await mapLimit(rows, GIT_CONCURRENCY, async (row) => {
      const [name, upstream, date, head] = row.split(SEP);
      // ONE definition of unpushed, the same one radar uses. No upstream does not change the
      // command, it only means nothing remote contains it.
      const c = await run(dir, ['rev-list', '--count', name, '--not', '--remotes'], { timeoutMs: 8000 });
      return {
        name,
        upstream: upstream || null,
        date: date || null,
        current: head === '*',
        unpushed: c.ok ? Number((c.stdout || '0').trim()) : null,
      };
    });
    return { repo: dir, branches: out };
  }

  async function worktrees(repo) {
    const dir = await assertRepo(repo);
    const r = await run(dir, ['worktree', 'list', '--porcelain']);
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const { worktrees: list, errors } = parseWorktreePorcelain(r.stdout);
    const withState = await mapLimit(list, GIT_CONCURRENCY, async (w) => {
      const s = await run(w.path, ['status', '--porcelain'], { timeoutMs: 8000 });
      return { ...w, dirty: s.ok ? (s.stdout || '').split('\n').filter(Boolean).length : null };
    });
    return { repo: dir, worktrees: withState, errors };
  }

  async function diff(repo, rel, staged) {
    const dir = await assertRepo(repo);
    const p = validatePathspec(rel);
    const args = ['diff', '--no-color'];
    if (staged) args.push('--cached');
    args.push('--', p);
    const r = await run(dir, args, { timeoutMs: 15000 });
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const full = r.stdout || '';
    const truncated = full.length > DIFF_MAX_BYTES;
    return { repo: dir, path: p, staged: !!staged, diff: truncated ? full.slice(0, DIFF_MAX_BYTES) : full, truncated, bytes: full.length };
  }

  // ---- writes: exactly two, both index-only -------------------------------------------------

  async function write(verb, repo, paths) {
    if (!writesEnabled) throw new GitPanelError('writes_disabled', 403);
    if (verb !== 'stage' && verb !== 'unstage') throw new GitPanelError('unknown_verb');
    if (!Array.isArray(paths) || paths.length === 0) throw new GitPanelError('no_paths');
    if (paths.length > MAX_PATHS_PER_WRITE) throw new GitPanelError('too_many_paths', 413);

    const dir = await assertRepo(repo);
    const specs = paths.map(validatePathspec);

    // The unmerged refusal, enforced HERE and not only in the UI. `git add` on a conflicted file
    // marks it RESOLVED — conflict markers included — and the next commit ships `<<<<<<<`.
    const st = await status(dir);
    if (st.error) throw new GitPanelError('status_failed', 502);
    const unmerged = new Set(st.files.filter((f) => f.unmerged).map((f) => f.path));
    const blocked = specs.filter((s) => unmerged.has(s));
    if (blocked.length) throw new GitPanelError('unmerged_path', 409);

    const args = verb === 'stage' ? ['add', '--', ...specs] : ['restore', '--staged', '--', ...specs];
    const r = await run(dir, args, { timeoutMs: 20000 });
    // Local, mutable, and honest about it: this reconstructs what happened for the operator. It proves
    // nothing after a token compromise, because whoever holds the token can edit it too.
    log({ at: now(), verb, repo: dir, paths: specs.length, ok: r.ok, code: r.code });
    if (!r.ok) throw new GitPanelError('git_failed', 502);
    return { ok: true, verb, repo: dir, paths: specs.length };
  }

  // ---- generated command text (never executed here) ---------------------------------------------

  function command(verb, params) {
    const t = COMMAND_TEMPLATES[verb];
    if (!t) throw new GitPanelError('unknown_command');
    return t(params || {});
  }

  return { repos, status, branches, worktrees, diff, write, command, assertRepo };
}

module.exports = {
  createGitPanel, GitPanelError, shellQuote, validatePathspec, isInside,
  COMMAND_TEMPLATES, DIFF_MAX_BYTES, MAX_PATHS_PER_WRITE,
};
