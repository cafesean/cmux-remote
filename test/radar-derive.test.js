'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { derive, assembleLadder, tally, flattenAttention, EPOCH } = require('../radar/derive');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const SOURCES_P1 = {
  git: { status: 'ok', observedAt: new Date(NOW).toISOString() },
  sessions: { status: 'disabled' },
  deploy: { status: 'disabled' },
  jira: { status: 'disabled' },
  specs: { status: 'disabled' },
  config: { status: 'ok' },
};

const branch = (o) => Object.assign({
  name: 'feature/PROJ-1-thing', sha: 'sha1', epic: 'PROJ-1', epicVia: 'issue-key', isDefault: false,
  unpushed: 0, noRemote: false, mergedIntoDevelop: true, mergedIntoMain: false,
  lastCommitAt: daysAgo(90), worktree: null,
}, o);

const worktree = (o) => Object.assign({
  path: '/wt/a', branch: 'feature/PROJ-1-thing', head: 'sha1', isMain: false, bare: false, locked: false,
  prunable: false, dirty: { staged: 0, unstaged: 0, untracked: 0 }, dirtyError: null,
  stale: false, staleReason: null, cleanupCommand: null,
}, o);

function build(opts) {
  const o = opts || {};
  const repos = {};
  for (const id of Object.keys(o.repos || { r1: { branches: [branch()] } })) {
    const r = (o.repos || { r1: { branches: [branch()] } })[id];
    repos[id] = {
      path: `/repos/${id}`, defaultBranches: { develop: 'd', main: 'm' },
      branches: r.branches || [], worktrees: r.worktrees || [], deploy: r.deploy || null,
      fetch: { status: 'ok', error: null },
    };
  }
  return derive({
    now: NOW,
    collectorId: 'test-machine',
    config: { repos: [] },
    sources: Object.assign({}, SOURCES_P1, o.sources || {}),
    aliases: o.aliases || {},
    decisions: o.decisions || [],
    fragments: {
      git: { repos },
      sessions: { sessions: o.sessions || [], machines: o.machines || null },
      specs: o.specs || { specOrphans: [], epics: {} },
      jira: { epics: o.jiraEpics || {}, drift: o.jiraDrift || [] },
    },
  });
}

const epic = (state, key) => state.epics.find((e) => e.key === key);

// Since S-009 the `spec` cell is real (a GO verdict in mod-specs), not the S-003 placeholder that
// auto-completed whenever a branch existed. A test whose subject is a cell to the RIGHT of `spec`
// has to give the epic an accepted spec, or `current` correctly stops at `spec` instead.
const specDone = (key) => ({
  sources: { specs: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  specs: { specOrphans: [], epics: { [key]: { stage: 'done', folders: [] } } },
});

// ---- the two-class oracle ------------------------------------------------------------------------
// Table-driven. Every row states the world and the zone it must produce. The rows that matter most
// are the DORMANT ones: before the two-class rule, dangling facts counted as activity and DORMANT
// was unreachable, so the oracle contradicted itself.

const ZONE_MATRIX = [
  {
    name: 'recent commit alone => ACTIVE',
    world: { repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(3), unpushed: 0, mergedIntoDevelop: true })] } } },
    zone: 'active', signals: ['recent-commit'],
  },
  {
    name: 'unpushed commits alone (old) => DORMANT, never active',
    world: { repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(60), unpushed: 9 })] } } },
    zone: 'dormant', signals: ['unpushed-commits'],
  },
  {
    name: 'unmerged branch alone (old) => DORMANT',
    world: { repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(60), unpushed: 0, mergedIntoDevelop: false })] } } },
    zone: 'dormant', signals: ['unmerged-develop'],
  },
  {
    name: 'dirty worktree alone (old) => DORMANT',
    world: {
      repos: {
        r1: {
          branches: [branch({ lastCommitAt: daysAgo(60), worktree: '/wt/a' })],
          worktrees: [worktree({ dirty: { staged: 0, unstaged: 2, untracked: 1 } })],
        },
      },
    },
    zone: 'dormant', signals: ['dirty-worktree'],
  },
  {
    name: 'clean, merged, pushed, untouched => GONE (absent from epics[])',
    world: { repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200), unpushed: 0, mergedIntoDevelop: true })] } } },
    zone: null,
  },
  {
    name: 'ACTIVE beats dangling: recent commit + unpushed => ACTIVE with both signal classes',
    world: { repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(1), unpushed: 4 })] } } },
    zone: 'active', signals: ['recent-commit', 'unpushed-commits'],
  },
  {
    name: 'epic-keyed open decision pins ACTIVE with zero git signals',
    world: {
      repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200), unpushed: 0, mergedIntoDevelop: true })] } },
      decisions: [{ id: 'd1', title: 'provision the row', since: daysAgo(17), epic: 'PROJ-1', closedAt: null }],
    },
    zone: 'active', signals: ['decision-open'],
  },
  {
    name: 'a CLOSED decision does not pin anything',
    world: {
      repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200), unpushed: 0, mergedIntoDevelop: true })] } },
      decisions: [{ id: 'd1', title: 'done thinking', since: daysAgo(30), epic: 'PROJ-1', closedAt: daysAgo(1) }],
    },
    zone: null,
  },
  {
    name: 'blocked session => ACTIVE',
    world: {
      repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200) })] } },
      sessions: [{ key: { machine: 'machine-b', sessionId: 'u1' }, status: 'blocked', epic: 'PROJ-1', notificationType: 'permission_prompt' }],
      sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
    },
    zone: 'active', signals: ['session-blocked'],
  },
  {
    name: 'idle session is LIVE, not finished => ACTIVE',
    world: {
      repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200) })] } },
      sessions: [{ key: { machine: 'machine-a', sessionId: 'u2' }, status: 'idle', epic: 'PROJ-1' }],
      sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
    },
    zone: 'active', signals: ['session-live'],
  },
  {
    name: 'source unknown propagates: unpushed null => no false dangling fact, still DORMANT via unmerged',
    world: { repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(60), unpushed: null, mergedIntoDevelop: false })] } } },
    zone: 'dormant', signals: ['unmerged-develop'],
  },
];

for (const row of ZONE_MATRIX) {
  test(`zone matrix: ${row.name}`, () => {
    const state = build(row.world);
    const e = epic(state, 'PROJ-1');
    if (row.zone === null) { assert.strictEqual(e, undefined, 'epic must have left the board'); return; }
    assert.ok(e, 'epic present');
    assert.strictEqual(e.zone, row.zone);
    assert.deepStrictEqual(e.signals, row.signals);
  });
}

test('zone transition ACTIVE -> DORMANT -> gone is driven only by the passage of time', () => {
  const active = epic(build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(2), unpushed: 3 })] } } }), 'PROJ-1');
  const dormant = epic(build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(40), unpushed: 3 })] } } }), 'PROJ-1');
  const gone = epic(build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(40), unpushed: 0 })] } } }), 'PROJ-1');
  assert.strictEqual(active.zone, 'active');
  assert.strictEqual(dormant.zone, 'dormant');
  assert.strictEqual(gone, undefined);
});

test('mergeable attention does NOT feed back as an activity signal (that would make DORMANT unreachable)', () => {
  const state = build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(60), unpushed: 0, mergedIntoDevelop: false })] } } });
  assert.strictEqual(epic(state, 'PROJ-1').zone, 'dormant');
  assert.ok(state.attention.some((a) => a.type === 'mergeable' && a.epic === 'PROJ-1'), 'it IS in the attention queue');
});

// ---- ladder ---------------------------------------------------------------------------------------

test('tally: AND semantics — one lagging value drops done to partial, one unknown wins', () => {
  assert.strictEqual(tally([true, true]), 'done');
  assert.strictEqual(tally([true, false]), 'partial');
  assert.strictEqual(tally([false, false]), 'none');
  assert.strictEqual(tally([true, null]), 'unknown');
  assert.strictEqual(tally([]), 'none');
});

test('assembleLadder: leftmost non-done becomes current when there is any progress', () => {
  const cells = assembleLadder({ spec: 'done', pushed: 'none', mergedDevelop: 'none', deployedDev: 'none', prod: 'none', flags: 'none' });
  assert.deepStrictEqual(cells, { spec: 'done', pushed: 'current', mergedDevelop: 'todo', deployedDev: 'todo', prod: 'todo', flags: 'todo' });
});

test('assembleLadder: a zero-progress epic shows todo, never current', () => {
  const cells = assembleLadder({ spec: 'none', pushed: 'none', mergedDevelop: 'none', deployedDev: 'none', prod: 'none', flags: 'none' });
  assert.strictEqual(cells.spec, 'todo');
  assert.ok(!Object.values(cells).includes('current'));
});

test('assembleLadder: unknown outranks current — an unevaluated cell never looks like progress', () => {
  const cells = assembleLadder({ spec: 'done', pushed: 'unknown', mergedDevelop: 'none', deployedDev: 'none', prod: 'none', flags: 'unknown' });
  assert.strictEqual(cells.pushed, 'unknown');
  assert.strictEqual(cells.flags, 'unknown');
});

test('ladder cell is named `pushed` and equals "every epic branch has unpushed == 0"', () => {
  const done = epic(build(Object.assign({ repos: { r1: { branches: [branch({ unpushed: 0, lastCommitAt: daysAgo(1) })] } } }, specDone('PROJ-1'))), 'PROJ-1');
  assert.ok('pushed' in done.ladder && !('built' in done.ladder));
  assert.strictEqual(done.ladder.pushed, 'done');
  const partial = epic(build(Object.assign({
    repos: { r1: { branches: [branch({ name: 'a', unpushed: 0, lastCommitAt: daysAgo(1) }), branch({ name: 'b', unpushed: 3, lastCommitAt: daysAgo(1) })] } },
  }, specDone('PROJ-1'))), 'PROJ-1');
  assert.strictEqual(partial.ladder.pushed, 'current');
});

test('multi-repo ladder: mergedDevelop is done only when EVERY repo satisfies it', () => {
  const world = (r2Merged) => Object.assign({
    repos: {
      r1: { branches: [branch({ name: 'feature/PROJ-1-web', mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })] },
      r2: { branches: [branch({ name: 'feature/PROJ-1-api', mergedIntoDevelop: r2Merged, lastCommitAt: daysAgo(1) })] },
    },
  }, specDone('PROJ-1'));
  assert.strictEqual(epic(build(world(false)), 'PROJ-1').ladder.mergedDevelop, 'current', 'one repo lagging => not done');
  assert.strictEqual(epic(build(world(true)), 'PROJ-1').ladder.mergedDevelop, 'done');
  assert.deepStrictEqual(epic(build(world(true)), 'PROJ-1').repos, ['r1', 'r2']);
});

test('with the deploy source disabled, a fully merged epic reads unknown downstream, never done', () => {
  const e = epic(build({ repos: { r1: { branches: [branch({ mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })] } } }), 'PROJ-1');
  assert.strictEqual(e.ladder.mergedDevelop, 'done');
  assert.strictEqual(e.ladder.deployedDev, 'unknown');
  assert.strictEqual(e.ladder.flags, 'unknown', 'no assertion => unknown, not off');
});

// ---- S-007 defect 2: deploy knowledge is PER REPO --------------------------------------------------
//
// The bug this pins down was live on the real board: app-web's Vercel token was dead, mod-deploy
// correctly marked the AGGREGATE `sources.deploy` stale, and derive's old `sourceOk(sources,'deploy')`
// gate then blanked the deployedDev/prod cells of site, admin and docs too — repos whose probes had
// answered perfectly. Four repos lost their deploy ladder because one token expired.
//
// The fixture below is that exact shape: one broken probe, one good probe, one epic in each repo.
const deployEnv = (o) => Object.assign({
  kind: 'vercel', status: 'ok', sha: 'deployed1', shaMissing: false, shaKnownLocally: true,
  ruleCheck: 'ok', ruleViolation: false, compareRef: 'origin/develop', epicBranchAncestry: {},
  behindDevelop: 0, probedAt: new Date(NOW).toISOString(), error: null, note: null,
}, o);

// One repo's probe is dead, the other's is healthy — exactly what mod-deploy reports when a single
// token expires: per-repo truth intact, aggregate source degraded to `stale`.
const SPLIT_DEPLOY_WORLD = {
  sources: {
    specs: { status: 'ok', observedAt: new Date(NOW).toISOString() },
    deploy: { status: 'stale', observedAt: new Date(NOW).toISOString(), error: '1/2 deploy probes degraded: app-web.dev: env VERCEL_TOKEN_MAIN is unset' },
  },
  specs: { specOrphans: [], epics: { 'PROJ-1': { stage: 'done', folders: [] }, 'BETA-2': { stage: 'done', folders: [] } } },
  repos: {
    'app-web': {
      branches: [branch({ name: 'feature/PROJ-1-web', epic: 'PROJ-1', mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })],
      deploy: { dev: deployEnv({ status: 'unauthorized', sha: null, shaKnownLocally: null, ruleCheck: 'unknown', error: 'env VERCEL_TOKEN_MAIN is unset' }) },
    },
    site: {
      branches: [branch({ name: 'feature/BETA-2-thing', epic: 'BETA-2', mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })],
      deploy: { dev: deployEnv({ epicBranchAncestry: { 'feature/BETA-2-thing': true } }) },
    },
  },
};

test('one repo\'s failed deploy probe does not blank another repo\'s deploy cells', () => {
  const state = build(SPLIT_DEPLOY_WORLD);

  // the healthy repo keeps its REAL cell — this is what the aggregate gate used to destroy
  assert.strictEqual(epic(state, 'BETA-2').ladder.deployedDev, 'done');

  // the broken repo degrades on its own, to unknown — never to a guess in either direction
  assert.strictEqual(epic(state, 'PROJ-1').ladder.deployedDev, 'unknown');

  // and the aggregate badge is untouched: the UI still has something to render the failure with
  assert.strictEqual(state.sources.deploy.status, 'stale');
});

test('the aggregate deploy badge alone never changes a cell — only the repo\'s own data does', () => {
  const good = epic(build(SPLIT_DEPLOY_WORLD), 'BETA-2').ladder;
  // same world, aggregate badge escalated all the way to `error`
  const escalated = Object.assign({}, SPLIT_DEPLOY_WORLD, {
    sources: Object.assign({}, SPLIT_DEPLOY_WORLD.sources, { deploy: { status: 'error', observedAt: new Date(NOW).toISOString(), error: 'all probes degraded' } }),
  });
  assert.deepStrictEqual(epic(build(escalated), 'BETA-2').ladder, good);
});

// A successful probe can still carry UNKNOWN ancestry: computeAncestry returns an empty
// epicBranchAncestry whenever the deployed SHA is not reachable from any local ref (force-push,
// squash-merge, or simply unfetched) while the probe itself stays `ok`. `tally` reports that as
// 'unknown' — and the old `tally(tips) === 'done'` comparison turned 'unknown' into FALSE, i.e.
// "definitely not deployed". That is a confident wrong answer, which §2 forbids outright.
//
// The per-repo gate above makes this path far more reachable than it used to be: a degraded
// aggregate source used to divert every epic into the merge-state fallback and hide it. So the
// two changes have to land together.
test('an ok probe with UNKNOWN ancestry reads unknown, never "not deployed"', () => {
  const world = (ancestry) => ({
    sources: {
      specs: { status: 'ok', observedAt: new Date(NOW).toISOString() },
      deploy: { status: 'ok', observedAt: new Date(NOW).toISOString() },
    },
    specs: { specOrphans: [], epics: { 'PROJ-1': { stage: 'done', folders: [] } } },
    repos: {
      r1: {
        branches: [branch({ mergedIntoDevelop: true, mergedIntoMain: true, lastCommitAt: daysAgo(1) })],
        deploy: {
          // status ok, sha present — but the sha is not reachable locally, so ancestry is empty
          dev: deployEnv({ shaKnownLocally: false, epicBranchAncestry: ancestry }),
          prod: deployEnv({ shaKnownLocally: false, epicBranchAncestry: ancestry, compareRef: 'origin/main' }),
        },
      },
    },
  });

  const unknownAncestry = epic(build(world({})), 'PROJ-1').ladder;
  assert.strictEqual(unknownAncestry.deployedDev, 'unknown', 'empty ancestry map must not read as not-deployed');
  assert.strictEqual(unknownAncestry.prod, 'unknown');

  // partial knowledge is still unknown — one answered branch does not settle the epic
  const partial = epic(build({
    sources: {
      specs: { status: 'ok', observedAt: new Date(NOW).toISOString() },
      deploy: { status: 'ok', observedAt: new Date(NOW).toISOString() },
    },
    specs: { specOrphans: [], epics: { 'PROJ-1': { stage: 'done', folders: [] } } },
    repos: {
      r1: {
        branches: [
          branch({ name: 'feature/PROJ-1-a', mergedIntoDevelop: true, lastCommitAt: daysAgo(1) }),
          branch({ name: 'feature/PROJ-1-b', mergedIntoDevelop: true, lastCommitAt: daysAgo(1) }),
        ],
        deploy: { dev: deployEnv({ epicBranchAncestry: { 'feature/PROJ-1-a': true } }) },
      },
    },
  }), 'PROJ-1').ladder;
  assert.strictEqual(partial.deployedDev, 'unknown', 'one branch answered, one unknown => unknown');

  // and a genuinely answered FALSE is still a confident not-deployed — the fix must not swallow that
  const answeredNo = epic(build({
    sources: {
      specs: { status: 'ok', observedAt: new Date(NOW).toISOString() },
      deploy: { status: 'ok', observedAt: new Date(NOW).toISOString() },
    },
    specs: { specOrphans: [], epics: { 'PROJ-1': { stage: 'done', folders: [] } } },
    repos: {
      r1: {
        branches: [branch({ mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })],
        deploy: { dev: deployEnv({ epicBranchAncestry: { 'feature/PROJ-1-thing': false } }) },
      },
    },
  }), 'PROJ-1').ladder;
  assert.strictEqual(answeredNo.deployedDev, 'current', 'a real false still reads as not yet deployed');
});

test('a repo with no deploy adapter at all still falls back to unknown-once-merged', () => {
  // The fallback the gate protects: with NO deploy data for the epic's repos, a merged epic must
  // read unknown (not done, not todo) — the pre-existing contract, now scoped per epic.
  const state = build({
    repos: { admin: { branches: [branch({ epic: 'PROJ-1', mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })], deploy: null } },
    sources: { deploy: { status: 'stale', observedAt: new Date(NOW).toISOString(), error: 'somebody else broke' } },
  });
  assert.strictEqual(epic(state, 'PROJ-1').ladder.deployedDev, 'unknown');
});

test('asserted flags: on|n/a satisfy the cell, off does not, and a 30d-old assertion is marked stale', () => {
  const mk = (flags) => epic(build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(1) })] } }, aliases: { flags } }), 'PROJ-1');
  assert.strictEqual(mk({ 'PROJ-1': { state: 'on', assertedAt: daysAgo(1) } }).ladder.flags, 'done');
  assert.strictEqual(mk({ 'PROJ-1': { state: 'n/a', assertedAt: daysAgo(1) } }).ladder.flags, 'done');
  assert.strictEqual(mk({ 'PROJ-1': { state: 'off', assertedAt: daysAgo(1) } }).ladder.flags, 'todo');
  assert.strictEqual(mk({ 'PROJ-1': { state: 'on', assertedAt: daysAgo(40) } }).flag.stale, true);
  assert.strictEqual(mk({ 'PROJ-1': { state: 'on', assertedAt: daysAgo(2) } }).flag.stale, false);
});

// ---- lastActivityAt + phrases ----------------------------------------------------------------------

test('lastActivityAt = max(branch commits, mapped session events, epic-keyed decision touches)', () => {
  const state = build({
    repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(9) }), branch({ name: 'b2', lastCommitAt: daysAgo(30) })] } },
    decisions: [{ id: 'd', title: 't', since: daysAgo(4), epic: 'PROJ-1', closedAt: null }],
    sessions: [{ key: { machine: 'm', sessionId: 's' }, status: 'idle', epic: 'PROJ-1', lastEventAt: daysAgo(2) }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  assert.strictEqual(epic(state, 'PROJ-1').lastActivityAt, daysAgo(2));
});

test('lastActivityAt falls back to the epoch when every input is missing', () => {
  const state = build({
    repos: { r1: { branches: [] } },
    decisions: [{ id: 'd', title: 't', since: null, epic: 'PROJ-9', closedAt: null }],
  });
  assert.strictEqual(epic(state, 'PROJ-9').lastActivityAt, EPOCH);
});

test('phrase = top activity signal · top dangling fact, from a fixed template table', () => {
  const e = epic(build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(1), unpushed: 9 })] } } }), 'PROJ-1');
  assert.strictEqual(e.phrase, 'building · 9 commits unpushed');
});

test('phrase tie-break is deterministic: blocked outranks live, unpushed outranks dirty', () => {
  const state = build({
    repos: {
      r1: {
        branches: [branch({ lastCommitAt: daysAgo(1), unpushed: 1, worktree: '/wt/a' })],
        worktrees: [worktree({ dirty: { staged: 1, unstaged: 0, untracked: 0 } })],
      },
    },
    sessions: [
      { key: { machine: 'm', sessionId: 'a' }, status: 'idle', epic: 'PROJ-1' },
      { key: { machine: 'm', sessionId: 'b' }, status: 'blocked', epic: 'PROJ-1', notificationType: 'permission_prompt' },
    ],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  assert.strictEqual(epic(state, 'PROJ-1').phrase, 'blocked · permission_prompt · 1 commit unpushed');
});

test('phrase pluralises off the count, not off free text', () => {
  const one = epic(build({ repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(1), unpushed: 1 })] } } }), 'PROJ-1');
  assert.strictEqual(one.phrase, 'building · 1 commit unpushed');
});

// ---- attention -------------------------------------------------------------------------------------

test('attention is sorted blocked -> rule-violation -> decision -> mergeable -> orphan, with actions[]', () => {
  const state = build({
    repos: {
      r1: {
        branches: [
          branch({ name: 'feature/PROJ-1-x', unpushed: 0, mergedIntoDevelop: false, lastCommitAt: daysAgo(1) }),
          branch({ name: 'random-thing', epic: null, epicVia: 'orphan', mergedIntoDevelop: false, lastCommitAt: daysAgo(1) }),
          branch({ name: 'develop', epic: null, epicVia: 'orphan', isDefault: true }),
        ],
      },
    },
    decisions: [{ id: 'dec-1', title: 'pick one', since: daysAgo(5), epic: null, closedAt: null }],
    sessions: [{ key: { machine: 'machine-b', sessionId: 'u1' }, status: 'blocked', epic: 'PROJ-1', cacheExpiresAt: daysAgo(-1), surface: { tabUuid: 'tab-1', tabRef: 'w1/t2' } }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  assert.deepStrictEqual(state.attention.map((a) => a.type), ['blocked', 'decision', 'mergeable', 'orphan']);
  assert.deepStrictEqual(state.attention[0].actions, [{ kind: 'jump', machine: 'machine-b', tabRef: 'w1/t2', tabUuid: 'tab-1' }]);
  assert.deepStrictEqual(state.attention[1].actions, [{ kind: 'context' }, { kind: 'close' }]);
  assert.deepStrictEqual(state.attention[3], { type: 'orphan', repo: 'r1', branch: 'random-thing', actions: [{ kind: 'tag' }] });
  assert.strictEqual(state.counts.orphans, 1, 'a default branch is not an orphan');
});

test('a blocked session with no resolvable surface gets no Jump action', () => {
  const state = build({
    repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(1) })] } },
    sessions: [{ key: { machine: 'machine-b', sessionId: 'u1' }, status: 'blocked', epic: 'PROJ-1', surface: null }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  assert.deepStrictEqual(state.attention[0].actions, []);
});

test('counts and machines default honestly when the sessions module is absent', () => {
  const state = build({});
  assert.deepStrictEqual(state.counts.blocked, 0);
  assert.deepStrictEqual(state.machines, [{ id: 'test-machine', bridge: 'unknown', lastSeenAt: null }]);
  assert.strictEqual(state.sources.sessions.status, 'disabled');
});

test('epics sort active-first, then most recently active', () => {
  const state = build({
    repos: {
      r1: {
        branches: [
          branch({ name: 'feature/PROJ-1-a', epic: 'PROJ-1', lastCommitAt: daysAgo(5) }),
          branch({ name: 'feature/PROJ-2-b', epic: 'PROJ-2', lastCommitAt: daysAgo(1) }),
          branch({ name: 'feature/PROJ-3-c', epic: 'PROJ-3', lastCommitAt: daysAgo(90), unpushed: 2 }),
        ],
      },
    },
  });
  assert.deepStrictEqual(state.epics.map((e) => e.key), ['PROJ-2', 'PROJ-1', 'PROJ-3']);
  assert.strictEqual(state.epics[2].zone, 'dormant');
});

// ---- orphan grouping (real-board fix, 2026-07-31) -------------------------------------------------
//
// 131 spec folders and 6 unmapped branches used to render as 137 near-identical attention rows.
// That is not a triage surface, it is a grinding list. Same-type orphans now fold into ONE row.
// The three properties that make the fold safe are all asserted here: the members survive, the
// COUNT survives, and a single orphan is never folded.

test('two or more same-type orphans fold into ONE attention row, members intact', () => {
  const state = build({
    repos: {
      r1: {
        branches: [
          branch({ name: 'feature/PROJ-1-a', epic: 'PROJ-1', lastCommitAt: daysAgo(1) }),
          branch({ name: 'loose-one', epic: null }),
          branch({ name: 'loose-two', epic: null }),
          branch({ name: 'loose-three', epic: null }),
        ],
      },
    },
  });
  const groups = state.attention.filter((a) => a.type === 'orphan-group');
  assert.strictEqual(groups.length, 1, 'three orphans are one row');
  assert.strictEqual(state.attention.filter((a) => a.type === 'orphan').length, 0, 'and no loose rows beside it');
  assert.strictEqual(groups[0].count, 3);
  assert.deepStrictEqual(groups[0].actions, [{ kind: 'expand' }], 'expandable — never a dead end');
  assert.deepStrictEqual(groups[0].items.map((i) => i.branch), ['loose-one', 'loose-three', 'loose-two']);
  assert.deepStrictEqual(groups[0].items[0].actions, [{ kind: 'tag' }], 'every member keeps its own action');
  // The count is read off the SOURCE list, never off attention[] — folding rows must not fold the count.
  assert.strictEqual(state.counts.orphans, 3);
  assert.strictEqual(flattenAttention(state.attention).filter((a) => a.type === 'orphan').length, 3);
});

test('one orphan is never grouped', () => {
  const state = build({
    repos: { r1: { branches: [branch({ name: 'feature/PROJ-1-a', epic: 'PROJ-1', lastCommitAt: daysAgo(1) }), branch({ name: 'loose-one', epic: null })] } },
  });
  assert.strictEqual(state.attention.filter((a) => a.type === 'orphan-group').length, 0);
  assert.strictEqual(state.attention.filter((a) => a.type === 'orphan').length, 1);
  assert.strictEqual(state.counts.orphans, 1);
});

test('branch and spec orphans fold SEPARATELY, each in its own sort slot', () => {
  const state = build({
    repos: { r1: { branches: [branch({ name: 'loose-one', epic: null }), branch({ name: 'loose-two', epic: null })] } },
    sources: { specs: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
    specs: { epics: {}, specOrphans: [{ specFolder: 'p90-a' }, { specFolder: 'p91-b' }] },
  });
  assert.deepStrictEqual(state.attention.map((a) => a.type), ['orphan-group', 'spec-orphan-group'],
    'branch orphans before spec orphans, exactly where their members would have sorted');
  assert.strictEqual(state.counts.orphans, 4, 'the count spans both types');
});

test('flattenAttention leaves ungrouped items untouched', () => {
  const flat = flattenAttention([
    { type: 'mergeable', epic: 'PROJ-1' },
    { type: 'orphan-group', count: 2, items: [{ type: 'orphan', branch: 'a' }, { type: 'orphan', branch: 'b' }] },
  ]);
  assert.deepStrictEqual(flat.map((i) => i.type), ['mergeable', 'orphan', 'orphan']);
  assert.deepStrictEqual(flattenAttention(null), []);
  assert.deepStrictEqual(flattenAttention([{ type: 'orphan-group', count: 2 }]).map((i) => i.type), ['orphan-group'],
    'a group without an items array is passed through rather than dropped');
});

// ---- Jira is no longer an activity signal ---------------------------------------------------------

test('Jira In Progress ALONE cannot make an epic active — it parks, phrased as drift', () => {
  const state = build({
    repos: { r1: { branches: [] } },
    jiraEpics: { 'PROJ-30': { key: 'PROJ-30', status: 'In Progress', statusCategory: 'indeterminate' } },
    sources: { jira: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  const e = epic(state, 'PROJ-30');
  assert.ok(e, 'still reachable — reclassified, not deleted');
  assert.strictEqual(e.zone, 'dormant');
  assert.deepStrictEqual(e.signals, ['jira-in-progress']);
  assert.strictEqual(e.phrase, 'jira says in progress · no branches');
  assert.strictEqual(e.lastActivityAt, EPOCH, 'and it has no clock of its own to show');
});

test('Jira In Progress + a stale dangling fact is still DORMANT, and names both', () => {
  const state = build({
    repos: { r1: { branches: [branch({ name: 'feature/PROJ-31-x', epic: 'PROJ-31', unpushed: 3, mergedIntoDevelop: false, lastCommitAt: daysAgo(120) })] } },
    jiraEpics: { 'PROJ-31': { key: 'PROJ-31', status: 'In Progress', statusCategory: 'indeterminate' } },
    sources: { jira: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  const e = epic(state, 'PROJ-31');
  assert.strictEqual(e.zone, 'dormant', 'a dangling fact does not promote it either — only activity does');
  assert.strictEqual(e.phrase, 'jira says in progress · git quiet · 3 commits unpushed');
});

test('Jira In Progress + a recent commit IS active, and the commit owns the phrase', () => {
  const state = build({
    repos: { r1: { branches: [branch({ name: 'feature/PROJ-32-x', epic: 'PROJ-32', lastCommitAt: daysAgo(2) })] } },
    jiraEpics: { 'PROJ-32': { key: 'PROJ-32', status: 'In Progress', statusCategory: 'indeterminate' } },
    sources: { jira: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  const e = epic(state, 'PROJ-32');
  assert.strictEqual(e.zone, 'active');
  assert.strictEqual(e.phrase, 'building', 'the drift phrase only leads when there is no activity');
  assert.deepStrictEqual(e.signals, ['recent-commit', 'jira-in-progress']);
});

test('the jiraDrift digest rides on the snapshot and is never an attention item', () => {
  const drift = [{ epic: 'PROJ-30', direction: 'jira-inprogress-no-git', note: 'x', detectedAt: new Date(NOW).toISOString() }];
  const state = build({ jiraDrift: drift, sources: { jira: { status: 'ok', observedAt: new Date(NOW).toISOString() } } });
  assert.deepStrictEqual(state.jiraDrift, drift);
  assert.strictEqual(state.attention.filter((a) => /drift/.test(a.type)).length, 0);
});

// ---- A1: a closed cache window is no longer urgent ------------------------------------------------

test('blocked with a LIVE deadline stays `blocked` and outranks everything', () => {
  const state = build({
    repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200) })] } },
    sessions: [{
      key: { machine: 'm', sessionId: 'live' }, status: 'blocked', epic: 'PROJ-1',
      notificationType: 'idle_prompt', cacheExpiresAt: new Date(NOW + 20 * 60000).toISOString(),
    }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  const items = flattenAttention(state.attention);
  assert.strictEqual(items[0].type, 'blocked', 'a window still open owns the urgent slot');
});

test('A1: blocked with a CLOSED cache window demotes to `blocked-stale` and loses the hero slot', () => {
  const state = build({
    repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200) })] } },
    // A genuinely actionable item to compete with. Before this fix `blocked` was ATTENTION_ORDER
    // index 0 with no deadline check, so the dead session beat it every time.
    decisions: [{ id: 'd1', title: 'pick a thing', since: daysAgo(1), epic: 'PROJ-1', closedAt: null }],
    sessions: [{
      key: { machine: 'm', sessionId: 'dead' }, status: 'blocked', epic: 'PROJ-1',
      notificationType: 'idle_prompt', cacheExpiresAt: new Date(NOW - 13 * 3600000).toISOString(),
    }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  const items = flattenAttention(state.attention);
  assert.strictEqual(items.filter((i) => i.type === 'blocked-stale').length, 1,
    'still present — someone must answer or kill it');
  assert.strictEqual(items.filter((i) => i.type === 'blocked').length, 0);
  assert.strictEqual(items[0].type, 'decision',
    'an item you can still act on in time outranks a 13h-old dead deadline');
  assert.ok(items.findIndex((i) => i.type === 'blocked-stale') > items.findIndex((i) => i.type === 'decision'));
});

test('A1: a blocked session that never submitted is NOT stale — no window was missed', () => {
  const state = build({
    repos: { r1: { branches: [branch({ lastCommitAt: daysAgo(200) })] } },
    sessions: [{
      key: { machine: 'm', sessionId: 'nosubmit' }, status: 'blocked', epic: 'PROJ-1',
      notificationType: 'permission_prompt', cacheExpiresAt: null,
    }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  assert.strictEqual(flattenAttention(state.attention)[0].type, 'blocked');
});

// ---- default-branch unpushed work must be visible somewhere -------------------------------------

test('REGRESSION: unpushed commits on a DEFAULT branch surface as their own row', () => {
  // The bug: epicBranches filters `!b.isDefault`, so work committed straight to main/develop
  // belonged to no epic and appeared on NO row. radar knew cmux-remote:main had 4 unpushed commits
  // and showed it nowhere — the dangle loop, inside the tool built to end it.
  const state = build({
    repos: { r1: {
      defaultBranches: { main: 'sha' },
      branches: [branch({ name: 'main', isDefault: true, unpushed: 4, lastCommitAt: daysAgo(1) })],
    } },
  });
  const items = flattenAttention(state.attention);
  const row = items.filter((i) => i.type === 'default-unpushed');
  assert.strictEqual(row.length, 1, 'exactly one row per repo, not one per commit');
  assert.strictEqual(row[0].repo, 'r1');
  assert.strictEqual(row[0].branch, 'main');
  assert.strictEqual(row[0].unpushed, 4);
});

test('a clean default branch produces no row', () => {
  const state = build({
    repos: { r1: { defaultBranches: { main: 'sha' }, branches: [branch({ name: 'main', isDefault: true, unpushed: 0 })] } },
  });
  assert.strictEqual(flattenAttention(state.attention).filter((i) => i.type === 'default-unpushed').length, 0);
});

test('a default branch whose unpushed count is UNKNOWN produces no false row', () => {
  const state = build({
    repos: { r1: { defaultBranches: { main: 'sha' }, branches: [branch({ name: 'main', isDefault: true, unpushed: null })] } },
  });
  assert.strictEqual(flattenAttention(state.attention).filter((i) => i.type === 'default-unpushed').length, 0,
    'null means we could not count — never render it as zero, never invent a row');
});

test('default-unpushed ranks below things you can still act on in time, above stale', () => {
  const state = build({
    repos: { r1: {
      defaultBranches: { main: 'sha' },
      branches: [branch({ name: 'main', isDefault: true, unpushed: 2, lastCommitAt: daysAgo(1) })],
    } },
    decisions: [{ id: 'd1', title: 't', since: daysAgo(1), epic: null, closedAt: null }],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
  });
  const types = flattenAttention(state.attention).map((i) => i.type);
  assert.ok(types.indexOf('decision') < types.indexOf('default-unpushed'), 'a decision outranks it');
});
