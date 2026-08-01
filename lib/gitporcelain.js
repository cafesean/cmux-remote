'use strict';
// Pure parsers for git's porcelain formats. Shared by radar (which reports repo-level truth on the
// attention board) and by the p7 source-control panel.
//
// WHY THIS FILE EXISTS: two independent parsers mean the board and the panel eventually disagree
// about the same repo on the same screen, and the board is the thing the operator trusts to tell them what
// is unmerged. One definition of "dirty", one of "unpushed", both here.
//
// Everything is a pure function of a string. No spawning, no I/O — that lives in gitcmd.js.

const lines = (s) => String(s || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);

// `git worktree list --porcelain` emits blank-line-separated stanzas:
//   worktree <path> / HEAD <sha> / (branch refs/heads/<name> | detached | bare) / [locked] / [prunable]
// A stanza we cannot make sense of is SKIPPED AND LOGGED — one weird entry must not cost the repo.
function parseWorktreePorcelain(text) {
  const worktrees = [];
  const errors = [];
  const stanzas = String(text || '').split(/\n\s*\n/);
  for (const stanza of stanzas) {
    const rows = lines(stanza);
    if (rows.length === 0) continue;
    const wt = { path: null, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    let unknownKeys = [];
    for (const row of rows) {
      const sp = row.indexOf(' ');
      const key = sp === -1 ? row : row.slice(0, sp);
      const val = sp === -1 ? '' : row.slice(sp + 1);
      if (key === 'worktree') wt.path = val;
      else if (key === 'HEAD') wt.head = val || null;
      else if (key === 'branch') wt.branch = val.startsWith('refs/heads/') ? val.slice('refs/heads/'.length) : val;
      else if (key === 'detached') wt.detached = true;
      else if (key === 'bare') wt.bare = true;
      else if (key === 'locked') wt.locked = true;
      else if (key === 'prunable') wt.prunable = true;
      else unknownKeys.push(key);
    }
    if (!wt.path) { errors.push(`worktree stanza without a path: ${JSON.stringify(stanza.slice(0, 120))}`); continue; }
    // Detached HEAD is NOT a parse error — it is a real state, and it carries branch:null.
    if (wt.detached) wt.branch = null;
    if (unknownKeys.length) errors.push(`worktree ${wt.path}: ignored unknown porcelain keys ${unknownKeys.join(',')}`);
    worktrees.push(wt);
  }
  return { worktrees, errors };
}

// `git status --porcelain` -> XY counts. A file can be both staged and unstaged; both are counted.
function parseStatusPorcelain(text) {
  const out = { staged: 0, unstaged: 0, untracked: 0 };
  for (const row of String(text || '').split('\n')) {
    if (row.length < 2) continue;
    const x = row[0];
    const y = row[1];
    if (x === '?' && y === '?') { out.untracked++; continue; }
    if (x === '!' && y === '!') continue;                    // ignored files are not dirt
    if (x !== ' ' && x !== '?') out.staged++;
    if (y !== ' ' && y !== '?') out.unstaged++;
  }
  return out;
}

const isClean = (dirty) => !!dirty && dirty.staged === 0 && dirty.unstaged === 0 && dirty.untracked === 0;

// ---- per-file status, for the source-control panel -------------------------------------------
//
// `git status --porcelain=v1 -z` — NUL-separated, so filenames containing newlines, quotes or
// spaces arrive intact and never need unquoting. A rename record is TWO NUL-terminated fields
// (new path, then old), which is why this is a manual walk rather than a split-and-map.
//
// UNMERGED is the state that matters most here. `git add` on a conflicted file does not stage it,
// it marks it RESOLVED — conflict markers and all — and the next commit ships `<<<<<<<`. From a
// phone that renders no conflict UI that is a trap, so unmerged paths are flagged and the panel
// refuses to stage them.
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function parseStatusZ(text) {
  const files = [];
  const buf = String(text || '');
  const parts = buf.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 3) continue;
    const x = rec[0], y = rec[1];
    const xy = x + y;
    let file = rec.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') { from = parts[++i] || null; }   // rename/copy: the old path follows
    const unmerged = UNMERGED_CODES.has(xy);
    files.push({
      path: file,
      from,
      xy,
      staged: !unmerged && x !== ' ' && x !== '?',
      unstaged: !unmerged && y !== ' ' && y !== '?',
      untracked: xy === '??',
      unmerged,
    });
  }
  return files;
}

// `git status --branch --porcelain=v1 -z` header line:
//   ## main...origin/main [ahead 1, behind 2]   |   ## HEAD (no branch)   |   ## main (initial)
// ahead/behind are NULL when there is no upstream — the question could not be asked, and null is
// not zero. Reporting zero would tell the operator there is nothing to push when nobody knows.
function parseBranchHeader(line) {
  const s = String(line || '').replace(/^## /, '');
  if (/^HEAD \(no branch\)/.test(s)) return { branch: null, detached: true, upstream: null, ahead: null, behind: null };
  const m = s.match(/^(?:No commits yet on )?([^.\s]+(?:\.[^.\s]+)*)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$/);
  if (!m) return { branch: null, detached: false, upstream: null, ahead: null, behind: null };
  const out = { branch: m[1] || null, detached: false, upstream: m[2] || null, ahead: null, behind: null };
  if (out.upstream) { out.ahead = 0; out.behind = 0; }          // an upstream exists → the counts are answerable
  if (m[3]) {
    const a = m[3].match(/ahead (\d+)/); if (a) out.ahead = Number(a[1]);
    const b = m[3].match(/behind (\d+)/); if (b) out.behind = Number(b[1]);
  }
  return out;
}

module.exports = {
  lines,
  parseWorktreePorcelain,
  parseStatusPorcelain,
  parseStatusZ,
  parseBranchHeader,
  isClean,
  UNMERGED_CODES,
};
