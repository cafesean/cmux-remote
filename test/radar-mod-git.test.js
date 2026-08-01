'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const path = require('path');
const {
  collectGit, parseWorktreePorcelain, parseStatusPorcelain, mapBranchToEpic,
  staleVerdict, removeCommand, UNPUSHED_ARGS,
} = require('../radar/mod-git');
const { GIT_BIN } = require('../lib/gitcmd');
const { buildFixtureRepo, g } = require('./helpers/git-fixture');

let fx = null;
before(async () => { fx = await buildFixtureRepo(); });
after(async () => { if (fx) await fx.cleanup(); });

const cfg = (repoPath) => ({
  timeouts: { gitFetchSec: 20 },
  repos: [{ id: 'fx', path: repoPath, defaultBranches: ['develop', 'main'], deploy: null }],
});
const byName = (repo, name) => repo.branches.find((b) => b.name === name);

// ---- the git binary itself -----------------------------------------------------------------------

test('git is spawned by absolute path — rtk fabricates output for bare `git`', () => {
  assert.strictEqual(GIT_BIN, '/usr/bin/git');
});

test('unpushed has exactly ONE algorithm, and no upstream does not change it', () => {
  assert.deepStrictEqual(UNPUSHED_ARGS('feature/x'), ['rev-list', '--count', 'feature/x', '--not', '--remotes']);
});

// ---- porcelain parsing ---------------------------------------------------------------------------

test('worktree porcelain: detached HEAD carries branch:null', async () => {
  const out = await g(fx.repo, ['worktree', 'list', '--porcelain']);
  const { worktrees, errors } = parseWorktreePorcelain(out);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(worktrees.length, 5);                       // main + 4 added
  const det = worktrees.find((w) => w.path === fx.wt.detached);
  assert.ok(det, 'detached worktree present');
  assert.strictEqual(det.branch, null);
  assert.strictEqual(det.detached, true);
  assert.strictEqual(det.head, fx.developSha);
});

test('worktree porcelain: branches are short names, main worktree comes first', async () => {
  const out = await g(fx.repo, ['worktree', 'list', '--porcelain']);
  const { worktrees } = parseWorktreePorcelain(out);
  assert.strictEqual(worktrees[0].path, fx.repo);
  assert.strictEqual(worktrees[0].branch, 'develop');
  assert.strictEqual(worktrees.find((w) => w.path === fx.wt.dirty).branch, 'feature/dirty-work');
});

test('worktree porcelain: an unparseable stanza is skipped and logged, the rest survive', () => {
  const text = [
    'worktree /good/one', 'HEAD aaaa', 'branch refs/heads/keep', '',
    'HEAD bbbb', 'branch refs/heads/lost',                      // no `worktree` line -> skip
    '', 'worktree /good/two', 'HEAD cccc', 'detached', '',
  ].join('\n');
  const { worktrees, errors } = parseWorktreePorcelain(text);
  assert.deepStrictEqual(worktrees.map((w) => w.path), ['/good/one', '/good/two']);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /without a path/);
});

test('status porcelain: staged / unstaged / untracked counted independently', () => {
  assert.deepStrictEqual(parseStatusPorcelain('M  a\n M b\nMM c\n?? d\n!! ignored\n'),
    { staged: 2, unstaged: 2, untracked: 1 });
  assert.deepStrictEqual(parseStatusPorcelain(''), { staged: 0, unstaged: 0, untracked: 0 });
});

// ---- branch -> epic ------------------------------------------------------------------------------

test('branch->epic: issue keys win, case-insensitively, and never partial-match a longer number', () => {
  const a = { epics: {} };
  assert.deepStrictEqual(mapBranchToEpic('r', 'feature/PROJ-108-searchindex', a), { epic: 'PROJ-108', via: 'issue-key', ambiguous: false });
  assert.deepStrictEqual(mapBranchToEpic('r', 'feature/proj-76-sse', a), { epic: 'PROJ-76', via: 'issue-key', ambiguous: false });
  assert.strictEqual(mapBranchToEpic('r', 'feature/beta-147-story-002', a).epic, 'BETA-147');
  assert.strictEqual(mapBranchToEpic('r', 'feature/ALPHA-9', a).epic, 'ALPHA-9');
});

test('branch->epic: p-number via aliases.json, on delimiter boundaries only', () => {
  const aliases = { epics: { 'PROJ-98': ['p51'], 'PROJ-5': ['p5'] } };
  assert.strictEqual(mapBranchToEpic('r', 'feature/p51-cache-layer', aliases).epic, 'PROJ-98');
  assert.strictEqual(mapBranchToEpic('r', 'feature/p51-cache-layer', aliases).via, 'alias');
  // p5 must NOT claim p51 — the boundary rule is what makes the alias seed safe.
  assert.strictEqual(mapBranchToEpic('r', 'feature/p5-radar', aliases).epic, 'PROJ-5');
  assert.strictEqual(mapBranchToEpic('r', 'feature/p512-nope', aliases).epic, null);
  // A dotted sub-number still resolves to its p-number.
  assert.strictEqual(mapBranchToEpic('r', 'feature/p51-cache-v2.1-team', aliases).epic, 'PROJ-98');
});

test('branch->epic: branchOverrides catch what regex and aliases miss, and are repo-scoped', () => {
  const aliases = { epics: {}, branchOverrides: { 'app-web:fix-tooltip-jitter': 'PROJ-112' } };
  assert.deepStrictEqual(mapBranchToEpic('app-web', 'fix-tooltip-jitter', aliases), { epic: 'PROJ-112', via: 'override', ambiguous: false });
  assert.strictEqual(mapBranchToEpic('docs', 'fix-tooltip-jitter', aliases).epic, null);
});

test('branch->epic: no match is an orphan, not a guess', () => {
  assert.deepStrictEqual(mapBranchToEpic('r', 'feat/set-dark-mode-globally', { epics: {} }),
    { epic: null, via: 'orphan', ambiguous: false });
});

test('branch->epic: ambiguous alias resolves deterministically on sorted key and is flagged', () => {
  const aliases = { epics: { 'ZZZ-1': ['shared'], 'AAA-1': ['shared'] } };
  const r = mapBranchToEpic('r', 'feature/shared-thing', aliases);
  assert.strictEqual(r.epic, 'AAA-1');
  assert.strictEqual(r.ambiguous, true);
});

// ---- live repo facts -----------------------------------------------------------------------------

test('collectGit: unpushed counts, no-upstream and local-only cases', async () => {
  const { fragment, source } = await collectGit({ config: cfg(fx.repo), aliases: {}, now: Date.now(), fetch: false });
  assert.strictEqual(source.status, 'ok');
  const repo = fragment.repos.fx;

  const pushedWithWork = byName(repo, 'feature/PROJ-108-thing');
  assert.strictEqual(pushedWithWork.unpushed, 2, 'two commits after the push');
  assert.strictEqual(pushedWithWork.noRemote, false);

  const localOnly = byName(repo, 'feature/p59-local-only');
  assert.strictEqual(localOnly.noRemote, true, 'never pushed -> no upstream');
  assert.strictEqual(localOnly.unpushed, 1, 'same algorithm, not a different one');

  assert.strictEqual(byName(repo, 'feature/merged-clean').unpushed, 0);
  assert.strictEqual(byName(repo, 'develop').unpushed, 0);
});

test('collectGit: merge facts follow merge-base --is-ancestor against origin refs', async () => {
  const { fragment } = await collectGit({ config: cfg(fx.repo), aliases: {}, now: Date.now(), fetch: false });
  const repo = fragment.repos.fx;
  assert.strictEqual(byName(repo, 'feature/merged-clean').mergedIntoDevelop, true);
  assert.strictEqual(byName(repo, 'feature/merged-clean').mergedIntoMain, false);
  assert.strictEqual(byName(repo, 'feature/PROJ-108-thing').mergedIntoDevelop, false);
});

test('collectGit: a missing comparison ref yields null (unknown), never false', async () => {
  const conf = { timeouts: { gitFetchSec: 20 }, repos: [{ id: 'fx', path: fx.repo, defaultBranches: ['develop', 'nonesuch'], deploy: null }] };
  const { fragment } = await collectGit({ config: conf, aliases: {}, now: Date.now(), fetch: false });
  const b = byName(fragment.repos.fx, 'feature/PROJ-108-thing');
  assert.strictEqual(b.mergedIntoMain, null, 'no origin/main configured as a default branch here');
  assert.strictEqual(fragment.repos.fx.defaultBranches.nonesuch, null);
});

test('collectGit: per-worktree dirty counts come from status --porcelain in that worktree', async () => {
  const { fragment } = await collectGit({ config: cfg(fx.repo), aliases: {}, now: Date.now(), fetch: false });
  const wts = fragment.repos.fx.worktrees;
  const dirty = wts.find((w) => w.path === fx.wt.dirty);
  assert.deepStrictEqual(dirty.dirty, { staged: 0, unstaged: 1, untracked: 1 });
  const clean = wts.find((w) => w.path === fx.wt.merged);
  assert.deepStrictEqual(clean.dirty, { staged: 0, unstaged: 0, untracked: 0 });
});

test('collectGit: stale rule = (merged OR epic-closed OR idle>30d with 0 unpushed) AND clean', async () => {
  const { fragment } = await collectGit({ config: cfg(fx.repo), aliases: {}, now: Date.now(), fetch: false });
  const wts = fragment.repos.fx.worktrees;
  const get = (p) => wts.find((w) => w.path === p);

  assert.strictEqual(get(fx.wt.merged).stale, true);
  assert.strictEqual(get(fx.wt.merged).staleReason, 'merged');
  assert.strictEqual(get(fx.wt.idle).stale, true);
  assert.strictEqual(get(fx.wt.idle).staleReason, 'idle-30d');

  // The two that must never be offered for cleanup.
  assert.strictEqual(get(fx.wt.dirty).stale, false, 'dirty is NEVER cleanup-ready');
  assert.strictEqual(get(fx.wt.dirty).cleanupCommand, null);
  assert.strictEqual(get(fx.repo).isMain, true);
  assert.strictEqual(get(fx.repo).stale, false, 'the main worktree is never stale');
  assert.strictEqual(get(fx.wt.detached).stale, false, 'detached HEAD is unknown, not stale');
});

test('collectGit: cleanup output is a runnable command STRING and nothing is removed', async () => {
  const before = (await g(fx.repo, ['worktree', 'list', '--porcelain'])).split('worktree ').length;
  const { fragment } = await collectGit({ config: cfg(fx.repo), aliases: {}, now: Date.now(), fetch: false });
  const stale = fragment.repos.fx.worktrees.filter((w) => w.stale);
  assert.ok(stale.length >= 1);
  for (const w of stale) {
    assert.match(w.cleanupCommand, /^\/usr\/bin\/git -C '.+' worktree remove '.+'$/);
    // still on disk: radar generates, the human executes
    await fsp.access(w.path);
  }
  const after = (await g(fx.repo, ['worktree', 'list', '--porcelain'])).split('worktree ').length;
  assert.strictEqual(after, before, 'radar removed nothing');
});

test('staleVerdict: epic-closed is a stale reason, and dirt always vetoes', () => {
  const clean = { branch: 'feature/x', isMain: false, bare: false, dirty: { staged: 0, unstaged: 0, untracked: 0 } };
  const facts = { epic: 'PROJ-9', mergedIntoDevelop: false, mergedIntoMain: false, unpushed: 0, lastCommitAt: new Date().toISOString() };
  const opts = { now: Date.now(), closedEpics: new Set(['PROJ-9']), defaultBranches: ['develop', 'main'] };
  assert.deepStrictEqual(staleVerdict(clean, facts, opts), { stale: true, reason: 'epic-closed' });

  const dirty = Object.assign({}, clean, { dirty: { staged: 0, unstaged: 1, untracked: 0 } });
  assert.deepStrictEqual(staleVerdict(dirty, facts, opts), { stale: false, reason: null });

  // unknown dirty state (status failed) is not clean, so not stale
  const unknownDirt = Object.assign({}, clean, { dirty: null });
  assert.deepStrictEqual(staleVerdict(unknownDirt, facts, opts), { stale: false, reason: null });
});

test('removeCommand quotes paths safely for a shell', () => {
  assert.strictEqual(removeCommand("/a/b'c", '/d/e f'), `/usr/bin/git -C '/a/b'\\''c' worktree remove '/d/e f'`);
});

// ---- degradation ----------------------------------------------------------------------------------

test('collectGit: a repo that is not a repo costs that repo, not the scan', async () => {
  const conf = {
    timeouts: { gitFetchSec: 20 },
    repos: [
      { id: 'fx', path: fx.repo, defaultBranches: ['develop', 'main'], deploy: null },
      { id: 'nope', path: path.join(fx.base, 'does-not-exist'), defaultBranches: ['main'], deploy: null },
    ],
  };
  const { fragment, source, warnings } = await collectGit({ config: conf, aliases: {}, now: Date.now(), fetch: false });
  assert.ok(fragment.repos.fx, 'the good repo still collected');
  assert.strictEqual(fragment.repos.nope, undefined);
  assert.strictEqual(source.status, 'stale');
  assert.match(source.error, /1\/2 repos failed/);
  assert.ok(warnings.some((w) => /nope/.test(w)));
});

test('collectGit: zero configured repos is an error source, not an empty success', async () => {
  const { source } = await collectGit({ config: { timeouts: {}, repos: [] }, aliases: {}, now: Date.now(), fetch: false });
  assert.strictEqual(source.status, 'error');
  assert.match(source.error, /no repos configured/);
});

test('a failed fetch degrades to cached refs and ONE aggregate stale badge', async () => {
  // origin points at a path that does not exist: fetch must fail while the local refs stay readable.
  const broken = path.join(fx.base, 'broken');
  await g(fx.base, ['init', '-q', '-b', 'main', broken]);
  await fsp.writeFile(path.join(broken, 'a.txt'), 'a\n');
  await g(broken, ['add', '-A']);
  await g(broken, ['commit', '-q', '-m', 'root']);
  await g(broken, ['remote', 'add', 'origin', path.join(fx.base, 'no-such-remote.git')]);

  const conf = { timeouts: { gitFetchSec: 10 }, repos: [{ id: 'broken', path: broken, defaultBranches: ['main'], deploy: null }] };
  const { fragment, source, warnings } = await collectGit({ config: conf, aliases: {}, now: Date.now(), fetch: true });
  assert.strictEqual(fragment.repos.broken.fetch.status, 'stale');
  assert.ok(fragment.repos.broken.fetch.error);
  assert.strictEqual(source.status, 'stale');
  assert.match(source.error, /fetch stale for 1\/1 repos \(cached refs\)/, 'one aggregate badge, not per-row noise');
  assert.strictEqual(fragment.repos.broken.branches.length, 1, 'cached refs still read');
  assert.strictEqual(fragment.repos.broken.branches[0].noRemote, true);
  assert.strictEqual(warnings.filter((w) => /fetch stale/.test(w)).length, 1);
});

test('a repo with no origin remote skips the fetch instead of reporting it stale', async () => {
  const solo = path.join(fx.base, 'solo');
  await g(fx.base, ['init', '-q', '-b', 'main', solo]);
  await fsp.writeFile(path.join(solo, 'a.txt'), 'a\n');
  await g(solo, ['add', '-A']);
  await g(solo, ['commit', '-q', '-m', 'root']);
  const conf = { timeouts: { gitFetchSec: 10 }, repos: [{ id: 'solo', path: solo, defaultBranches: ['main'], deploy: null }] };
  const { fragment, source } = await collectGit({ config: conf, aliases: {}, now: Date.now(), fetch: true });
  assert.deepStrictEqual(fragment.repos.solo.fetch, { status: 'skipped', error: 'no origin remote' });
  assert.strictEqual(source.status, 'ok');
  // No remote refs at all: every commit is unpushed under the one algorithm, and that is correct.
  assert.strictEqual(fragment.repos.solo.branches[0].unpushed, 1);
  assert.strictEqual(fragment.repos.solo.branches[0].mergedIntoMain, null, 'no origin/main to compare against');
});

test('collectGit: worktrees under a node_modules segment are never walked', async () => {
  // The rule is enforced by path, so it holds even for the ELOOP self-loop in app-api.
  const { fragment } = await collectGit({ config: cfg(fx.repo), aliases: {}, now: Date.now(), fetch: false });
  for (const w of fragment.repos.fx.worktrees) {
    assert.ok(w.path.split(path.sep).indexOf('node_modules') === -1);
  }
});
