'use strict';
// mod-git — the local repo disks. Ground truth for branches, worktrees, dirty state, merge facts,
// stale-worktree verdicts and branch->epic mapping.
//
// RULES THIS MODULE ENFORCES (all previously-hit traps):
//   * git only via ./gitcmd, which spawns the absolute /usr/bin/git. rtk fabricates output.
//   * `unpushed` has exactly ONE definition: rev-list --count <branch> --not --remotes.
//     No upstream does not change the command, it only sets noRemote:true. Grep this file: the
//     string '--not' appears once, in UNPUSHED_ARGS.
//   * Never walk into node_modules. Radar performs NO directory traversal at all — every path it
//     touches came out of `git worktree list` — and worktrees under a node_modules segment are
//     skipped outright (app-api's is an ELOOP self-loop; worktree copies are one-hop symlinks).
//   * A dirty worktree is NEVER cleanup-ready. It is a live dangling fact plus a warning.
//   * Cleanup output is a generated command STRING. This module removes nothing, ever.
//   * A question that cannot be asked (missing ref, timeout) yields null == unknown, never false.
const path = require('path');
const { gitIn, gitTest, lines, mapLimit } = require('../lib/gitcmd');

const BRANCH_CONCURRENCY = 8;
const FETCH_CONCURRENCY = 4;
const STALE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// ASCII unit separator (0x1F): git refuses control characters in ref names, so this byte can
// never appear inside a branch name, sha, date or upstream — splitting on it is total.
const FIELD_SEP = '\u001F';

// The single unpushed algorithm. Every branch, every repo, no exceptions.
const UNPUSHED_ARGS = (branch) => ['rev-list', '--count', branch, '--not', '--remotes'];

const ISSUE_KEY_RE = /(^|[^A-Za-z0-9])(PROJ|ALPHA|BETA)-(\d+)(?![0-9])/i;

const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ---- porcelain parsers (pure, unit-tested against real repos) ---------------------------------

// The porcelain parsers moved to lib/gitporcelain.js so the p7 source-control panel shares them.
// Two definitions of "dirty" or "unpushed" would let the radar board and the panel disagree about
// the same repo on the same screen. Re-exported below, so this module's surface is unchanged.
const { parseWorktreePorcelain, parseStatusPorcelain, isClean } = require('../lib/gitporcelain');

// ---- branch -> epic ----------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An alias matches only on a delimiter boundary, so `p5` never claims `p51-cache-layer`.
// p-numbers are the spec's named case; word aliases ("searchindex", "cache-warm") ride the
// same rule, which is what lets the alias seed pull the orphan queue under the P1 bound.
const aliasMatches = (branch, alias) =>
  new RegExp(`(^|[^A-Za-z0-9])${escapeRe(alias)}([^A-Za-z0-9]|$)`, 'i').test(branch);

// Precedence per spec §M1: (1) issue key in the name, (2) alias from aliases.json,
// (3) branchOverrides, else orphan. Ties inside (2) break on sorted epic key — deterministic,
// and the ambiguity is surfaced rather than hidden.
function mapBranchToEpic(repoId, branch, aliases) {
  const m = String(branch || '').match(ISSUE_KEY_RE);
  if (m) return { epic: `${m[2].toUpperCase()}-${m[3]}`, via: 'issue-key', ambiguous: false };

  const epics = aliases && aliases.epics && typeof aliases.epics === 'object' ? aliases.epics : {};
  const hits = [];
  for (const key of Object.keys(epics).sort()) {
    const list = Array.isArray(epics[key]) ? epics[key] : [];
    for (const a of list) {
      if (typeof a !== 'string' || !a.trim()) continue;
      if (aliasMatches(branch, a.trim())) { hits.push({ epic: key, alias: a.trim() }); break; }
    }
  }
  if (hits.length) return { epic: hits[0].epic, via: 'alias', alias: hits[0].alias, ambiguous: hits.length > 1 };

  const overrides = aliases && aliases.branchOverrides && typeof aliases.branchOverrides === 'object' ? aliases.branchOverrides : {};
  const ov = overrides[`${repoId}:${branch}`];
  if (typeof ov === 'string' && ov.trim()) return { epic: ov.trim(), via: 'override', ambiguous: false };

  return { epic: null, via: 'orphan', ambiguous: false };
}

// ---- stale-worktree verdict ---------------------------------------------------------------------

// stale iff (merged into develop/main OR epic closed OR (tip idle > 30d AND unpushed == 0)) AND clean.
// Everything unknown resolves to NOT stale: the output of this function becomes a removal command a
// human will paste, so a false positive costs real work.
function staleVerdict(wt, branchFacts, opts) {
  const o = opts || {};
  if (wt.isMain || wt.bare) return { stale: false, reason: null };
  if (!wt.branch) return { stale: false, reason: null };                 // detached HEAD -> unknown
  if (o.defaultBranches && o.defaultBranches.indexOf(wt.branch) !== -1) return { stale: false, reason: null };
  if (!isClean(wt.dirty)) return { stale: false, reason: null };          // dirty is never cleanup-ready
  if (!branchFacts) return { stale: false, reason: null };

  if (branchFacts.mergedIntoDevelop === true || branchFacts.mergedIntoMain === true) return { stale: true, reason: 'merged' };
  if (branchFacts.epic && o.closedEpics && o.closedEpics.has(branchFacts.epic)) return { stale: true, reason: 'epic-closed' };
  const ts = branchFacts.lastCommitAt ? Date.parse(branchFacts.lastCommitAt) : NaN;
  if (Number.isFinite(ts) && branchFacts.unpushed === 0 && (o.now - ts) > STALE_IDLE_MS) return { stale: true, reason: 'idle-30d' };
  return { stale: false, reason: null };
}

// A path a human will paste into a shell. Single-quoted, with the absolute binary: the §2 principle
// ("never bare git — rtk proxies it") applies to the command we hand over, not only the ones we run.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const removeCommand = (repoPath, wtPath) => `/usr/bin/git -C ${shq(repoPath)} worktree remove ${shq(wtPath)}`;

const hasNodeModules = (p) => String(p).split(path.sep).indexOf('node_modules') !== -1;

// ---- per-repo collection ------------------------------------------------------------------------

async function collectRepo(repo, aliases, ctx) {
  const out = {
    path: repo.path,
    defaultBranches: {},
    branches: [],
    worktrees: [],
    deploy: null,                  // filled by mod-deploy (S-005); absent source renders unknown
    fetch: { status: 'skipped', error: null },
    warnings: [],
  };

  const top = await gitIn(repo.path, ['rev-parse', '--git-dir'], { timeoutMs: 10000 });
  if (!top.ok) throw new Error(`${repo.id}: not a git repo (${top.stderr.split('\n')[0]})`);

  // 1. fetch (best effort). Failure = cached refs + an aggregate stale badge, never a lost scan.
  if (ctx.fetch) {
    const remotes = await gitIn(repo.path, ['remote'], { timeoutMs: 10000 });
    if (remotes.ok && lines(remotes.stdout).indexOf('origin') !== -1) {
      const r = await gitIn(repo.path, ['fetch', '--quiet', '--no-tags', 'origin'], { timeoutMs: ctx.fetchTimeoutMs });
      out.fetch = r.ok ? { status: 'ok', error: null } : { status: 'stale', error: r.timedOut ? 'fetch timeout' : r.stderr.split('\n')[0] };
    } else {
      out.fetch = { status: 'skipped', error: 'no origin remote' };
    }
  }

  // 2. which comparison refs actually exist. A missing origin/develop means "unknown", not "unmerged".
  const cmp = {};
  for (const b of repo.defaultBranches) {
    const remoteRef = `refs/remotes/origin/${b}`;
    const has = await gitIn(repo.path, ['rev-parse', '--verify', '--quiet', remoteRef], { timeoutMs: 10000 });
    cmp[b] = has.ok ? `origin/${b}` : null;
    const local = await gitIn(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { timeoutMs: 10000 });
    out.defaultBranches[b] = local.ok ? local.stdout.trim() : null;
  }

  // 3. branch tips + upstream, one spawn.
  const fmt = `%(refname:short)${FIELD_SEP}%(objectname)${FIELD_SEP}%(committerdate:iso8601-strict)${FIELD_SEP}%(upstream:short)`;
  const refs = await gitIn(repo.path, ['for-each-ref', 'refs/heads', `--format=${fmt}`], { timeoutMs: 20000 });
  if (!refs.ok) throw new Error(`${repo.id}: for-each-ref failed (${refs.stderr.split('\n')[0]})`);
  const rows = lines(refs.stdout).map((l) => l.split(FIELD_SEP));

  const branches = await mapLimit(rows, BRANCH_CONCURRENCY, async (cols) => {
    const [name, sha, date, upstream] = cols;
    if (!name || !sha) { out.warnings.push(`unparseable ref row: ${JSON.stringify(cols)}`); return null; }

    // THE unpushed algorithm. No upstream does not change it; it only sets noRemote.
    const rl = await gitIn(repo.path, UNPUSHED_ARGS(name), { timeoutMs: 30000 });
    const unpushed = rl.ok && /^\d+$/.test(rl.stdout.trim()) ? Number(rl.stdout.trim()) : null;
    if (unpushed === null) out.warnings.push(`${name}: unpushed count unavailable (${(rl.stderr || '').split('\n')[0]})`);

    const merged = {};
    for (const b of repo.defaultBranches) {
      merged[b] = cmp[b] ? await gitTest(repo.path, ['merge-base', '--is-ancestor', sha, cmp[b]], { timeoutMs: 15000 }) : null;
    }

    const map = mapBranchToEpic(repo.id, name, aliases);
    if (map.ambiguous) out.warnings.push(`${repo.id}:${name}: alias matched more than one epic; took ${map.epic}`);

    return {
      name,
      sha,
      epic: map.epic,
      epicVia: map.via,
      isDefault: repo.defaultBranches.indexOf(name) !== -1,
      unpushed,
      noRemote: !upstream,
      mergedIntoDevelop: merged.develop === undefined ? null : merged.develop,
      mergedIntoMain: merged.main === undefined ? null : merged.main,
      lastCommitAt: iso(date),
      worktree: null,                   // back-filled below
    };
  });
  out.branches = branches.filter(Boolean).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byName = new Map(out.branches.map((b) => [b.name, b]));

  // 4. worktrees + per-worktree dirty state.
  const wtRes = await gitIn(repo.path, ['worktree', 'list', '--porcelain'], { timeoutMs: 20000 });
  if (!wtRes.ok) {
    out.warnings.push(`${repo.id}: worktree list failed (${wtRes.stderr.split('\n')[0]})`);
  } else {
    const parsed = parseWorktreePorcelain(wtRes.stdout);
    for (const e of parsed.errors) out.warnings.push(`${repo.id}: ${e}`);
    const mainPath = parsed.worktrees.length ? parsed.worktrees[0].path : null;

    out.worktrees = await mapLimit(parsed.worktrees, BRANCH_CONCURRENCY, async (wt) => {
      if (hasNodeModules(wt.path)) { out.warnings.push(`${repo.id}: skipped worktree under node_modules: ${wt.path}`); return null; }
      const rec = {
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
        isMain: wt.path === mainPath,
        bare: wt.bare,
        locked: wt.locked,
        prunable: wt.prunable,
        dirty: null,
        dirtyError: null,
        stale: false,
        staleReason: null,
        cleanupCommand: null,
      };
      if (!wt.bare) {
        const st = await gitIn(wt.path, ['status', '--porcelain'], { timeoutMs: 30000 });
        if (st.ok) rec.dirty = parseStatusPorcelain(st.stdout);
        else rec.dirtyError = st.timedOut ? 'status timeout' : (st.stderr.split('\n')[0] || 'status failed');
      }
      const facts = wt.branch ? byName.get(wt.branch) : null;
      const verdict = staleVerdict(rec, facts, { now: ctx.now, closedEpics: ctx.closedEpics, defaultBranches: repo.defaultBranches });
      rec.stale = verdict.stale;
      rec.staleReason = verdict.reason;
      if (rec.stale) rec.cleanupCommand = removeCommand(repo.path, wt.path);
      if (facts) facts.worktree = wt.path;
      return rec;
    });
    out.worktrees = out.worktrees.filter(Boolean);
  }

  return out;
}

// ---- module entry ---------------------------------------------------------------------------------

// Returns the `git` fragment plus its source metadata. A single repo blowing up costs that repo,
// not the scan: it lands in warnings and the source degrades to "stale".
async function collectGit(opts) {
  const config = opts.config;
  const aliases = opts.aliases || {};
  const now = opts.now == null ? Date.now() : opts.now;
  const observedAt = new Date(now).toISOString();
  const ctx = {
    now,
    fetch: opts.fetch !== false,
    fetchTimeoutMs: (config.timeouts && config.timeouts.gitFetchSec ? config.timeouts.gitFetchSec : 20) * 1000,
    closedEpics: opts.closedEpics instanceof Set ? opts.closedEpics : new Set(),
  };

  const warnings = [];
  const repos = {};

  // Fetches are the network-bound part; cap them at 4 so eight repos on a hotspot degrade
  // gracefully instead of all timing out at once.
  const results = await mapLimit(config.repos, FETCH_CONCURRENCY, async (repo) => {
    try {
      return { id: repo.id, repo: await collectRepo(repo, aliases, ctx) };
    } catch (e) {
      return { id: repo.id, error: e && e.message ? e.message : String(e) };
    }
  });

  let failed = 0;
  let fetchStale = 0;
  for (const r of results) {
    if (r.error) { failed++; warnings.push(r.error); continue; }
    for (const w of r.repo.warnings) warnings.push(w);
    delete r.repo.warnings;
    if (r.repo.fetch.status === 'stale') { fetchStale++; warnings.push(`${r.id}: fetch stale (${r.repo.fetch.error})`); }
    repos[r.id] = r.repo;
  }

  // One AGGREGATE badge, not per-row noise: a laptop on a hotspot must not produce a stale storm.
  let source;
  if (config.repos.length === 0) source = { status: 'error', observedAt, error: 'no repos configured' };
  else if (failed === config.repos.length) source = { status: 'error', observedAt, error: `all ${failed} repos failed: ${warnings[0] || 'unknown'}` };
  else if (failed > 0) source = { status: 'stale', observedAt, error: `${failed}/${config.repos.length} repos failed` };
  else if (fetchStale > 0) source = { status: 'stale', observedAt, error: `fetch stale for ${fetchStale}/${config.repos.length} repos (cached refs)` };
  else source = { status: 'ok', observedAt };

  return { fragment: { repos }, source, warnings };
}

module.exports = {
  collectGit,
  collectRepo,
  parseWorktreePorcelain,
  parseStatusPorcelain,
  mapBranchToEpic,
  aliasMatches,
  staleVerdict,
  removeCommand,
  isClean,
  UNPUSHED_ARGS,
  STALE_IDLE_MS,
};
