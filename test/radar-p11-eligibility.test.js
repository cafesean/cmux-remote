'use strict';
// p11 S-005 — route resolution.
//
// WHY THIS FILE WAS REWRITTEN. The first version of it passed while the feature it covered was dead.
// Its sessions carried `worktree: 'feature/PROJ-108-metering'` — a BRANCH-SHAPED string that
// mod-sessions has never once emitted, because mapCwd publishes an absolute CWD PATH there. Every
// links-identity assertion below was therefore proving a property of a fixture nobody produces, and
// in production the same code path could not match anything at all: `'urn:work:git:<repo>/<branch>'
// .endsWith('/' + '/repo/example-web/...')` is false for every input.
//
// So the rule this file now holds itself to: A SESSION FIXTURE HERE MUST BE A SHAPE THE PUBLISHER
// CAN ACTUALLY EMIT. `worktree` is a path, identity lives in the derived `branch`, and the chain
// test at the bottom builds a session through the REAL mapCwd + the REAL enrichment rather than
// asserting the shape by hand.
//
// Fixtures are synthetic per the public-repo rule: PROJ/ALPHA/BETA keys, /repo/<name> paths.
const test = require('node:test');
const assert = require('node:assert');

const {
  resolveRoute, clusterGate, ineligibleReason, sessionMembership, sessionMatchesLinks,
  parseGitLink, tieBreak, REASONS, MEMBERSHIP,
} = require('../radar/eligibility.js');
const { resolveSessionBranch, enrichSessions, derive } = require('../radar/derive.js');
const { mapCwd } = require('../radar/mod-sessions.js');

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

const WEB = '/repo/example-web';
const wt = (name) => `${WEB}/.claude/worktrees/${name}`;

// The shape mod-sessions publishes: worktree is the cwd PATH, branch is derived, epic is mapped.
const session = (over) => Object.assign({
  key: { machine: 'leader-1', sessionId: 'sess-a' },
  surface: { workspace: 'ws', tabRef: 'surface:2', tabUuid: 'uuid-1' },
  surfaceReason: null,
  repo: 'example-web',
  worktree: wt('metering'),
  branch: 'feature/PROJ-108-metering',
  epic: 'PROJ-108',
  status: 'idle',
  lastEventAt: agoMin(10),
  lastSubmitAt: agoMin(11),
}, over);

const workRef = (over) => Object.assign({
  urn: 'urn:work:jira:PROJ-108', cluster: 'PROJ-108',
  links: ['urn:work:git:example-web/feature/PROJ-108-metering'],
}, over);

const OPTS = { now: NOW, leader: 'leader-1', minIdleSec: 90, maxIdleHours: 24 };

// The git fragment the enrichment joins against — the same {path, branch} records mod-git reports.
const GIT_REPOS = {
  'example-web': {
    path: WEB,
    worktrees: [
      { path: WEB, branch: 'develop' },
      { path: wt('metering'), branch: 'feature/PROJ-108-metering' },
      { path: wt('metering-old'), branch: 'feature/PROJ-108-metering-old' },
      { path: wt('detached'), branch: null },
    ],
  },
  'example-api': {
    path: '/repo/example-api',
    worktrees: [{ path: '/repo/example-api/.claude/worktrees/metering', branch: 'feature/PROJ-108-metering' }],
  },
};

// ---- D1: the links leg is real, and it is built from `branch` -----------------------------------

test('D1: a branch-shaped worktree is NOT identity — only the derived branch is', () => {
  // The exact fixture the old suite used to "prove" the links leg. It proves nothing: worktree is a
  // path field, and a session that has no branch has no links identity, whatever its path says.
  const impossible = session({ epic: null, branch: null, worktree: 'feature/PROJ-108-metering' });
  assert.strictEqual(sessionMatchesLinks(impossible, workRef().links), false);
  assert.strictEqual(ineligibleReason(impossible, workRef(), OPTS), REASONS.NO_EPIC);
});

test('D1: the publisher shape — an absolute worktree path with a derived branch — matches links', () => {
  const real = session({ epic: null });                     // path in worktree, branch derived
  assert.strictEqual(sessionMatchesLinks(real, workRef().links), true);
  assert.strictEqual(ineligibleReason(real, workRef(), OPTS), null);
});

test('D1: no branch resolvable means the links leg contributes nothing — no fallback to the path', () => {
  for (const over of [{ branch: null }, { branch: '' }, { branch: undefined }]) {
    const s = session(Object.assign({ epic: null }, over));
    assert.strictEqual(sessionMatchesLinks(s, workRef().links), false, JSON.stringify(over));
    assert.strictEqual(ineligibleReason(s, workRef(), OPTS), REASONS.NO_EPIC, JSON.stringify(over));
  }
});

test('D1: the link URN parses into repo + branch, and a branch keeps its own slashes', () => {
  assert.deepStrictEqual(parseGitLink('urn:work:git:example-web/feature/PROJ-108-metering'),
    { repo: 'example-web', branch: 'feature/PROJ-108-metering' });
  for (const junk of ['urn:work:jira:PROJ-108', 'urn:work:git:example-web', 'urn:work:git:/branch', 'urn:work:git:repo/', null, 7]) {
    assert.strictEqual(parseGitLink(junk), null, String(junk));
  }
});

// ---- D5: link matching is repo-aware and exact ---------------------------------------------------

test('D5: the same branch in a DIFFERENT repo is not a match — the link carries a repoId', () => {
  const elsewhere = session({ repo: 'example-api', epic: null, worktree: '/repo/example-api/.claude/worktrees/metering' });
  assert.strictEqual(sessionMatchesLinks(elsewhere, workRef().links), false);
  assert.strictEqual(ineligibleReason(elsewhere, workRef(), OPTS), REASONS.NO_EPIC);
});

test('D5: suffix matching is gone — a bare trailing segment no longer claims a branch', () => {
  const bare = session({ epic: null, branch: 'PROJ-108-metering' });
  assert.strictEqual(sessionMatchesLinks(bare, workRef().links), false);
  assert.strictEqual(ineligibleReason(bare, workRef(), OPTS), REASONS.NO_EPIC);
});

test('D5: a branch that merely shares a prefix does not match', () => {
  const sibling = session({ epic: null, branch: 'feature/PROJ-108-metering-old', worktree: wt('metering-old') });
  assert.strictEqual(ineligibleReason(sibling, workRef(), OPTS), REASONS.NO_EPIC);
});

// ---- STAGE 0: the cluster gate ------------------------------------------------------------------

test('stage 0: a RUNNING session on the cluster blocks the route entirely — it must NOT spawn', () => {
  const r = resolveRoute(workRef(), [session({ status: 'running' })], OPTS);
  assert.strictEqual(r.kind, null, 'the fallback to spawn is the bug; there must be no fallback');
  assert.strictEqual(r.reason, REASONS.CLUSTER_RUNNING);
  assert.notStrictEqual(r.kind, 'spawn', 'spawning here would put a second writer on a live cluster');
});

test('stage 0: a BLOCKED session on the cluster blocks the route entirely', () => {
  const r = resolveRoute(workRef(), [session({ status: 'blocked' })], OPTS);
  assert.strictEqual(r.kind, null);
  assert.strictEqual(r.reason, REASONS.CLUSTER_BLOCKED);
});

test('stage 0: the gate looks at EVERY session on the cluster, not just resume candidates', () => {
  // This running session fails several stage-1 predicates (wrong machine, no surface). A one-stage
  // implementation would discard it as "not a candidate" and then spawn. It must still gate.
  const hostile = session({ status: 'running', key: { machine: 'other-machine', sessionId: 'sess-x' }, surface: null, surfaceReason: 'no-cwd' });
  const r = resolveRoute(workRef(), [hostile], OPTS);
  assert.strictEqual(r.kind, null);
  assert.strictEqual(r.reason, REASONS.CLUSTER_RUNNING);
});

test('stage 0: an idle session does not gate, and a session on another cluster entirely never gates', () => {
  assert.strictEqual(clusterGate(workRef(), [session({ status: 'idle' })]), null);
  const elsewhere = session({ status: 'running', epic: 'ALPHA-3', repo: 'example-api', branch: 'feature/ALPHA-3-thing', worktree: '/repo/example-api/.claude/worktrees/alpha' });
  assert.strictEqual(clusterGate(workRef(), [elsewhere]), null);
});

// ---- D2: the two-writer hole that opens when the epic is unresolved -------------------------------

test('D2: a RUNNING session with epic:null in a LINKED repo gates the cluster', () => {
  // Nothing ties this session to the epic by name — its cwd mapped to no key — but it is live in a
  // repo this WorkRef has branches in. Dispatching anyway is the two-writer bug reached through an
  // unresolved epic instead of through the fallback.
  const unresolved = session({ status: 'running', epic: null, branch: 'some/scratch-branch', worktree: wt('scratch'), key: { machine: 'leader-1', sessionId: 'live-writer' } });
  assert.strictEqual(clusterGate(workRef(), [unresolved]), REASONS.CLUSTER_RUNNING);

  // and the resolver must not route past it, even with a perfectly eligible session alongside.
  const spare = session({ key: { machine: 'leader-1', sessionId: 'idle-spare' } });
  const r = resolveRoute(workRef(), [unresolved, spare], OPTS);
  assert.strictEqual(r.kind, null);
  assert.strictEqual(r.sessionId, null, 'the eligible spare must not be resumed while a writer is live');
});

test('D2: epic:null in an UNLINKED repo does not gate — the widening is bounded by the links', () => {
  const other = session({ status: 'running', epic: null, repo: 'example-api', branch: null, worktree: '/repo/example-api' });
  assert.strictEqual(clusterGate(workRef(), [other]), null);
});

test('D2: the epic:null widening is STAGE 0 ONLY — it never makes a session resumable', () => {
  const unresolved = session({ epic: null, branch: 'some/scratch-branch', worktree: wt('scratch') });
  assert.strictEqual(sessionMembership(unresolved, workRef(), MEMBERSHIP.GATE), true);
  assert.strictEqual(sessionMembership(unresolved, workRef(), MEMBERSHIP.RESUME), false);
  assert.strictEqual(ineligibleReason(unresolved, workRef(), OPTS), REASONS.NO_EPIC);
  const r = resolveRoute(workRef(), [unresolved], OPTS);
  assert.strictEqual(r.kind, 'spawn', 'idle, so it does not gate; unresolved, so it is not a target');
});

// ---- D4: a conflicting epic outranks a link match --------------------------------------------------

test('D4: epic-conflict beats link-match — a session declaring another epic is never resumed', () => {
  const conflicted = session({ epic: 'BETA-147' });          // sitting in PROJ-108's linked branch
  assert.strictEqual(sessionMatchesLinks(conflicted, workRef().links), true, 'the link leg does match');
  assert.strictEqual(ineligibleReason(conflicted, workRef(), OPTS), REASONS.WRONG_CLUSTER,
    'and it must still lose: a conflicting assertion is evidence of the WRONG target, not missing evidence');
  const r = resolveRoute(workRef(), [conflicted], OPTS);
  assert.strictEqual(r.kind, 'spawn');
  assert.strictEqual(r.sessionId, null);
});

test('D4: that same conflicted session still GATES when it is live — over-gating is the safe way', () => {
  const live = session({ epic: 'BETA-147', status: 'running' });
  assert.strictEqual(sessionMembership(live, workRef(), MEMBERSHIP.GATE), true);
  assert.strictEqual(sessionMembership(live, workRef(), MEMBERSHIP.RESUME), false);
  assert.strictEqual(clusterGate(workRef(), [live]), REASONS.CLUSTER_RUNNING,
    'whatever epic it believes it is on, it is writing in the tree we are about to write in');
});

// ---- D3: one membership predicate, so the stages cannot drift apart ---------------------------------

test('D3: every stage-1 identity is also a stage-0 identity — the gate is never narrower', () => {
  const cases = [
    session(),                                                        // by epic
    session({ epic: null }),                                          // by link
    session({ epic: null, branch: 'some/scratch-branch' }),           // by linked repo (gate only)
    session({ epic: 'BETA-147' }),                                    // conflicting, link-matching
  ];
  for (const s of cases) {
    const resumes = sessionMembership(s, workRef(), MEMBERSHIP.RESUME);
    const gates = sessionMembership(s, workRef(), MEMBERSHIP.GATE);
    assert.ok(gates || !resumes, `a session resumable but not gateable is the drift this predicate exists to stop: ${JSON.stringify(s.epic)}/${JSON.stringify(s.branch)}`);
  }
});

// ---- STAGE 1: the remaining predicates ---------------------------------------------------------------

test('stage 1: same repo, DIFFERENT epic is ineligible — repo containment is not identity', () => {
  const other = session({ epic: 'PROJ-9', branch: 'feature/PROJ-9-other', worktree: wt('other') });
  assert.strictEqual(ineligibleReason(other, workRef(), OPTS), REASONS.WRONG_CLUSTER);
  const r = resolveRoute(workRef(), [other], OPTS);
  assert.strictEqual(r.kind, 'spawn', 'no eligible session, but the cluster is free, so a fresh one is safe');
  assert.strictEqual(r.sessionId, null, 'it must NOT have resumed the unrelated session');
});

test('stage 1: a repo-root session with no epic is ineligible, never guessed into the cluster', () => {
  const root = session({ epic: null, branch: 'develop', worktree: WEB });
  assert.strictEqual(ineligibleReason(root, workRef(), OPTS), REASONS.NO_EPIC);
});

test('predicates: each failure returns its own reason, never a silent false', () => {
  const cases = [
    [{ status: 'running' }, REASONS.NOT_IDLE],
    [{ key: { machine: 'other', sessionId: 'sess-a' } }, REASONS.WRONG_MACHINE],
    [{ lastEventAt: agoMin(0.5) }, REASONS.TOO_FRESH],
    [{ lastEventAt: agoMin(60 * 30) }, REASONS.TOO_STALE],
  ];
  for (const [over, expected] of cases) {
    assert.strictEqual(ineligibleReason(session(over), workRef(), OPTS), expected, JSON.stringify(over));
  }
});

test('D9: an absent or unparseable clock reports no-clock, NOT idle-too-long', () => {
  for (const over of [{ lastEventAt: 'not-a-date' }, { lastEventAt: undefined }, { lastEventAt: null }, { lastEventAt: 12345 }]) {
    const why = ineligibleReason(session(over), workRef(), OPTS);
    assert.strictEqual(why, REASONS.NO_CLOCK, JSON.stringify(over));
    assert.notStrictEqual(why, REASONS.TOO_STALE, 'it fails closed, but it must not borrow a measurement it never made');
  }
  assert.strictEqual(REASONS.NO_CLOCK, 'no-clock');
});

test('predicates: surface:null is rejected and reports the surfaceReason verbatim', () => {
  const s = session({ surface: null, surfaceReason: 'ambiguous-tabs:4' });
  assert.strictEqual(ineligibleReason(s, workRef(), OPTS), 'ambiguous-tabs:4');
  const bare = session({ surface: null, surfaceReason: null });
  assert.strictEqual(ineligibleReason(bare, workRef(), OPTS), REASONS.NO_SURFACE);
});

test('predicates: requireSurface:false lets a surfaceless session through (config knob)', () => {
  const s = session({ surface: null, surfaceReason: 'no-cwd' });
  assert.strictEqual(ineligibleReason(s, workRef(), Object.assign({}, OPTS, { requireSurface: false })), null);
});

test('predicates: a session already bound to a live run is rejected', () => {
  const o = Object.assign({}, OPTS, { boundSessionIds: new Set(['sess-a']) });
  assert.strictEqual(ineligibleReason(session(), workRef(), o), REASONS.ALREADY_BOUND);
});

test('predicates: a WorkRef with no cluster resolves nothing', () => {
  assert.strictEqual(ineligibleReason(session(), workRef({ cluster: null }), OPTS), REASONS.NO_CLUSTER);
});

// ---- D7: a resume route must be able to name its target ----------------------------------------------

test('D7: a session radar cannot name is ineligible, and never becomes a resume', () => {
  for (const over of [{ key: undefined }, { key: {} }, { key: { machine: 'leader-1', sessionId: '' } }, { key: { machine: 'leader-1' } }]) {
    const nameless = session(over);
    assert.strictEqual(ineligibleReason(nameless, workRef(), OPTS), REASONS.NO_IDENTITY, JSON.stringify(over));
    const r = resolveRoute(workRef(), [nameless], OPTS);
    assert.notStrictEqual(r.kind, 'resume', `kind=resume with no sessionId is a dispatchable pointer to nothing: ${JSON.stringify(over)}`);
    assert.strictEqual(r.kind, 'spawn');
  }
});

test('D7: with no leader configured either, a keyless session still cannot become a resume', () => {
  const r = resolveRoute(workRef(), [session({ key: undefined })], { now: NOW, minIdleSec: 90, maxIdleHours: 24 });
  assert.strictEqual(r.kind, 'spawn');
  assert.strictEqual(r.sessionId, null);
});

test('D7: the invariant, swept — kind:resume implies a non-empty sessionId', () => {
  const shapes = [
    [], [session()], [session({ key: undefined })], [session({ epic: null })],
    [session({ epic: 'BETA-147' })], [session({ status: 'running' })],
    [session({ key: { machine: 'leader-1', sessionId: '' } }), session()],
  ];
  for (const list of shapes) {
    const r = resolveRoute(workRef(), list, OPTS);
    if (r.kind === 'resume') {
      assert.ok(typeof r.sessionId === 'string' && r.sessionId.length > 0, JSON.stringify(list.map((s) => s.key)));
    }
  }
});

// ---- D6: every return shape carries rejected[] --------------------------------------------------------

test('D6: the GATED return carries rejected[] — a consumer must not throw on the safety path', () => {
  for (const status of ['running', 'blocked']) {
    const r = resolveRoute(workRef(), [session({ status })], OPTS);
    assert.strictEqual(r.kind, null);
    assert.ok(Array.isArray(r.rejected), `gated route must carry rejected[] (status ${status})`);
    assert.deepStrictEqual(r.rejected.map((x) => x.reason), [], 'stage 0 evaluated no candidates, so it is empty, not absent');
    assert.doesNotThrow(() => r.rejected.map((x) => x.reason));
  }
});

test('D6: resume and spawn carry it too — the key is on every shape', () => {
  for (const list of [[session()], [], [session({ epic: 'PROJ-9', branch: 'feature/PROJ-9-other' })]]) {
    assert.ok(Array.isArray(resolveRoute(workRef(), list, OPTS).rejected));
  }
});

test('rejected[] carries a reason per session so "why can\'t this resume?" is answerable', () => {
  const wrongCluster = session({ status: 'idle', epic: 'ALPHA-1', branch: 'feature/ALPHA-1-thing', worktree: wt('alpha') });
  const noSurface = session({ status: 'idle', surface: null, surfaceReason: 'no-cwd' });
  const r = resolveRoute(workRef(), [wrongCluster, noSurface], OPTS);
  assert.strictEqual(r.kind, 'spawn', 'neither is eligible, and the cluster is free');
  assert.strictEqual(r.rejected.length, 2);
  assert.deepStrictEqual(r.rejected.map((x) => x.reason).sort(), ['no-cwd', REASONS.WRONG_CLUSTER].sort());
});

// ---- D8: tie-break — exact identity outranks any longer partial ---------------------------------------

test('D8: at equal submit time the EXACTLY linked session wins, not the longer "-old" sibling', () => {
  // Both resolve to the cluster by epic, so both are eligible. The canonical one is deliberately
  // given the LATER-sorting id and the SHORTER worktree, so it can only win on exactness.
  const canonical = session({ key: { machine: 'leader-1', sessionId: 'zzz-canonical' }, lastSubmitAt: agoMin(10) });
  const stale = session({
    key: { machine: 'leader-1', sessionId: 'aaa-old' }, lastSubmitAt: agoMin(10),
    worktree: wt('metering-old'), branch: 'feature/PROJ-108-metering-old',
  });
  for (const order of [[canonical, stale], [stale, canonical]]) {
    const r = resolveRoute(workRef(), order, OPTS);
    assert.strictEqual(r.sessionId, 'zzz-canonical', `order ${order.map((s) => s.key.sessionId).join(',')}`);
  }
  assert.ok(tieBreak(canonical, stale, workRef()) < 0, 'and the comparator says so directly');
  assert.ok(tieBreak(stale, canonical, workRef()) > 0, 'symmetrically');
});

test('D8: newest submit still outranks exactness — recency is the first leg', () => {
  const olderExact = session({ key: { machine: 'leader-1', sessionId: 'exact' }, lastSubmitAt: agoMin(60) });
  const newerPartial = session({
    key: { machine: 'leader-1', sessionId: 'newer' }, lastSubmitAt: agoMin(5),
    worktree: wt('metering-old'), branch: 'feature/PROJ-108-metering-old',
  });
  assert.strictEqual(resolveRoute(workRef(), [olderExact, newerPartial], OPTS).sessionId, 'newer');
});

test('D8: with time and exactness equal, id decides — stable under shuffle', () => {
  const mk = (id) => session({ key: { machine: 'leader-1', sessionId: id }, lastSubmitAt: agoMin(5) });
  const a = mk('sess-a'), b = mk('sess-b'), c = mk('sess-c');
  const orders = [[a, b, c], [c, b, a], [b, c, a], [c, a, b]];
  const picks = orders.map((o) => resolveRoute(workRef(), o, OPTS).sessionId);
  assert.strictEqual(new Set(picks).size, 1, `shuffling must not change the pick: ${picks.join(',')}`);
  assert.strictEqual(picks[0], 'sess-a');
});

// ---- the happy paths -----------------------------------------------------------------------------------

test('resume: an eligible idle session is chosen and the reason names the epic', () => {
  const r = resolveRoute(workRef(), [session()], OPTS);
  assert.strictEqual(r.kind, 'resume');
  assert.strictEqual(r.sessionId, 'sess-a');
  assert.strictEqual(r.machine, 'leader-1');
  assert.match(r.reason, /PROJ-108/);
});

test('spawn: reachable only when the cluster is free, and the reason does not imply a budget check', () => {
  const r = resolveRoute(workRef(), [], OPTS);
  assert.strictEqual(r.kind, 'spawn');
  assert.match(r.reason, /budget not evaluated here/, 'Hermes owns the budget; the string must not imply a cap was checked');
});

// ---- the enrichment itself (derive.js) -------------------------------------------------------------------

test('enrichment: a cwd that IS a worktree root resolves to that worktree\'s branch', () => {
  assert.strictEqual(resolveSessionBranch({ repo: 'example-web', worktree: wt('metering') }, GIT_REPOS), 'feature/PROJ-108-metering');
  assert.strictEqual(resolveSessionBranch({ repo: 'example-web', worktree: WEB }, GIT_REPOS), 'develop');
});

test('enrichment: a cwd INSIDE a worktree resolves to it — longest prefix, not exact equality', () => {
  const deep = { repo: 'example-web', worktree: `${wt('metering')}/src/lib` };
  assert.strictEqual(resolveSessionBranch(deep, GIT_REPOS), 'feature/PROJ-108-metering',
    'exact-match-only would resolve almost no real session, since a cwd is usually below the worktree root');
});

test('enrichment: the p5 sibling trap — "-old" must not borrow its neighbour\'s branch', () => {
  assert.strictEqual(resolveSessionBranch({ repo: 'example-web', worktree: wt('metering-old') }, GIT_REPOS), 'feature/PROJ-108-metering-old');
  assert.strictEqual(resolveSessionBranch({ repo: 'example-web', worktree: `${wt('metering-old')}/src` }, GIT_REPOS), 'feature/PROJ-108-metering-old');
});

test('enrichment: unresolvable inputs yield null, never a guess', () => {
  const cases = [
    [{ repo: 'example-web', worktree: wt('detached') }, 'detached HEAD carries no branch'],
    [{ repo: 'unknown-repo', worktree: wt('metering') }, 'repo not in the git fragment'],
    [{ repo: null, worktree: wt('metering') }, 'no repo at all'],
    [{ repo: 'example-web', worktree: null }, 'no cwd (mapCwd found no repo prefix)'],
    [{ repo: 'example-web', worktree: '/somewhere/else' }, 'cwd under no known worktree'],
    [{ repo: 'example-api', worktree: wt('metering') }, 'right path, wrong repo — the join is repo-scoped'],
  ];
  for (const [s, why] of cases) assert.strictEqual(resolveSessionBranch(s, GIT_REPOS), null, why);
  assert.strictEqual(resolveSessionBranch(null, GIT_REPOS), null);
  assert.strictEqual(resolveSessionBranch({ repo: 'example-web', worktree: WEB }, null), null);
});

test('enrichment: copies, never mutation of the collector\'s fragment', () => {
  const raw = session();
  delete raw.branch;                                        // the collector's fragment has no branch
  const input = [raw];
  const out = enrichSessions(input, GIT_REPOS);
  assert.strictEqual(out[0].branch, 'feature/PROJ-108-metering');
  assert.strictEqual('branch' in input[0], false, 'the input fragment must be left as the collector wrote it');
  assert.notStrictEqual(out[0], input[0]);
});

// ---- the chain: publisher -> enrichment -> route ------------------------------------------------------------

test('CHAIN: mapCwd\'s real output, enriched, resumes for the WorkRef that links its branch', () => {
  // No hand-written session shape anywhere in this test. mapCwd publishes repo+worktree(+epic);
  // enrichSessions adds branch; eligibility does the rest. This is the test that would have caught
  // the dead links leg, because it can only pass if the two contracts actually meet.
  const config = { repos: [{ id: 'example-web', path: WEB }, { id: 'example-api', path: '/repo/example-api' }] };
  const cwd = `${wt('metering')}/src`;
  const mapped = mapCwd(cwd, config, {});

  assert.strictEqual(mapped.repo, 'example-web');
  assert.strictEqual(mapped.worktree, cwd, 'worktree is the cwd PATH — this is the contract eligibility must not read as identity');
  assert.strictEqual(mapped.epic, null, 'this cwd maps to no epic key, so the branch leg is the ONLY identity available');

  const [enriched] = enrichSessions([{
    key: { machine: 'leader-1', sessionId: 'from-publisher' },
    status: 'idle',
    surface: { workspace: 'ws', tabRef: 'surface:1' },
    repo: mapped.repo, worktree: mapped.worktree, epic: mapped.epic,
    lastEventAt: agoMin(10), lastSubmitAt: agoMin(11),
  }], GIT_REPOS);

  assert.strictEqual(enriched.branch, 'feature/PROJ-108-metering');
  const r = resolveRoute(workRef(), [enriched], OPTS);
  assert.strictEqual(r.kind, 'resume');
  assert.strictEqual(r.sessionId, 'from-publisher');
});

test('CHAIN: derive() publishes `branch` on sessions[], so the dispatch re-check can read it', () => {
  const state = derive({
    now: NOW,
    collectorId: 'leader-1',
    config: { role: 'leader', repos: [], resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: true } },
    sources: { git: { status: 'ok' }, sessions: { status: 'ok' }, deploy: { status: 'disabled' }, jira: { status: 'disabled' }, specs: { status: 'disabled' }, config: { status: 'ok' } },
    aliases: {}, decisions: [], handoffs: [], handoffRecovery: null,
    fragments: {
      git: { repos: GIT_REPOS },
      deploy: { repos: {} },
      sessions: {
        sessions: [
          { key: { machine: 'leader-1', sessionId: 'published' }, status: 'idle', repo: 'example-web', worktree: `${wt('metering')}/src`, epic: null, lastEventAt: agoMin(10), lastSubmitAt: agoMin(11), surface: null, surfaceReason: 'no-cwd' },
          { key: { machine: 'leader-1', sessionId: 'rootless' }, status: 'idle', repo: null, worktree: null, epic: null, lastEventAt: agoMin(10), lastSubmitAt: agoMin(11), surface: null, surfaceReason: 'no-cwd' },
        ],
        machines: null,
      },
      jira: { epics: {} },
      specs: { specOrphans: [], epics: {} },
    },
  });
  const by = Object.fromEntries(state.sessions.map((s) => [s.key.sessionId, s]));
  assert.strictEqual(by.published.branch, 'feature/PROJ-108-metering');
  assert.strictEqual(by.published.worktree, `${wt('metering')}/src`, 'and worktree is still the path a human reads');
  assert.strictEqual(by.rootless.branch, null, 'unresolvable is null, and null is published rather than omitted');
});
