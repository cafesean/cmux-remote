'use strict';
// p11 S-005 — route resolution, and specifically the two defects Codex round 1 found in the
// approved spec. Both were reachable, both are two-writer or wrong-target classes, and both have a
// test here whose name says which finding it pins.
//
// Fixtures are synthetic per the public-repo rule: PROJ/ALPHA/BETA keys, /repo/<name> paths.
const test = require('node:test');
const assert = require('node:assert');

const { resolveRoute, clusterGate, ineligibleReason, tieBreak, REASONS } = require('../radar/eligibility.js');

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

const session = (over) => Object.assign({
  key: { machine: 'leader-1', sessionId: 'sess-a' },
  surface: { workspace: 'ws', tabRef: 'surface:2', tabUuid: 'uuid-1' },
  surfaceReason: null,
  repo: 'example-web',
  worktree: 'feature/PROJ-108-metering',
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

// ---- STAGE 0: the cluster gate (Codex finding 1, critical) ------------------------------------------

test('finding 1: a RUNNING session on the cluster blocks the route entirely — it must NOT spawn', () => {
  const r = resolveRoute(workRef(), [session({ status: 'running' })], OPTS);
  assert.strictEqual(r.kind, null, 'the fallback to spawn is the bug; there must be no fallback');
  assert.strictEqual(r.reason, REASONS.CLUSTER_RUNNING);
  assert.notStrictEqual(r.kind, 'spawn', 'spawning here would put a second writer on a live cluster');
});

test('finding 1: a BLOCKED session on the cluster blocks the route entirely', () => {
  const r = resolveRoute(workRef(), [session({ status: 'blocked' })], OPTS);
  assert.strictEqual(r.kind, null);
  assert.strictEqual(r.reason, REASONS.CLUSTER_BLOCKED);
});

test('finding 1: the gate looks at EVERY session on the cluster, not just resume candidates', () => {
  // This running session fails several stage-1 predicates (wrong machine, no surface). A one-stage
  // implementation would discard it as "not a candidate" and then spawn. It must still gate.
  const hostile = session({ status: 'running', key: { machine: 'other-machine', sessionId: 'sess-x' }, surface: null, surfaceReason: 'no-cwd' });
  const r = resolveRoute(workRef(), [hostile], OPTS);
  assert.strictEqual(r.kind, null);
  assert.strictEqual(r.reason, REASONS.CLUSTER_RUNNING);
});

test('cluster gate: an idle session does not gate, and an unrelated cluster never gates', () => {
  assert.strictEqual(clusterGate(workRef(), [session({ status: 'idle' })]), null);
  assert.strictEqual(clusterGate(workRef(), [session({ status: 'running', epic: 'ALPHA-3' })]), null);
});

// ---- STAGE 1: exact cluster identity (Codex finding 2, critical) ------------------------------------

test('finding 2: same repo, DIFFERENT epic is ineligible — repo containment is not identity', () => {
  const other = session({ epic: 'PROJ-9', worktree: 'feature/PROJ-9-other' });
  assert.strictEqual(ineligibleReason(other, workRef(), OPTS), REASONS.WRONG_CLUSTER);
  const r = resolveRoute(workRef(), [other], OPTS);
  assert.strictEqual(r.kind, 'spawn', 'no eligible session, but the cluster is free, so a fresh one is safe');
  assert.strictEqual(r.sessionId, null, 'it must NOT have resumed the unrelated session');
});

test('finding 2: a repo-root session with no epic is ineligible, never guessed into the cluster', () => {
  const root = session({ epic: null, worktree: null, repo: 'example-web' });
  assert.strictEqual(ineligibleReason(root, workRef(), OPTS), REASONS.NO_EPIC);
});

test('finding 2: a session may also match by an EXACT worktree named in links', () => {
  const byWorktree = session({ epic: null, worktree: 'feature/PROJ-108-metering' });
  assert.strictEqual(ineligibleReason(byWorktree, workRef(), OPTS), null);
});

test('finding 2: a worktree that merely shares a prefix does not match', () => {
  const sibling = session({ epic: null, worktree: 'feature/PROJ-108-metering-old' });
  assert.strictEqual(ineligibleReason(sibling, workRef(), OPTS), REASONS.NO_EPIC);
});

// ---- the remaining predicates -----------------------------------------------------------------------

test('predicates: each failure returns its own reason, never a silent false', () => {
  const cases = [
    [{ status: 'running' }, REASONS.NOT_IDLE],
    [{ key: { machine: 'other', sessionId: 'sess-a' } }, REASONS.WRONG_MACHINE],
    [{ lastEventAt: agoMin(0.5) }, REASONS.TOO_FRESH],
    [{ lastEventAt: agoMin(60 * 30) }, REASONS.TOO_STALE],
    [{ lastEventAt: 'not-a-date' }, REASONS.TOO_STALE],
  ];
  for (const [over, expected] of cases) {
    assert.strictEqual(ineligibleReason(session(over), workRef(), OPTS), expected, JSON.stringify(over));
  }
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

// ---- tie-break determinism ---------------------------------------------------------------------------

test('tie-break: newest submit, then deepest worktree, then id — stable under shuffle', () => {
  const a = session({ key: { machine: 'leader-1', sessionId: 'sess-a' }, lastSubmitAt: agoMin(30) });
  const b = session({ key: { machine: 'leader-1', sessionId: 'sess-b' }, lastSubmitAt: agoMin(5) });
  const c = session({ key: { machine: 'leader-1', sessionId: 'sess-c' }, lastSubmitAt: agoMin(5), worktree: 'feature/PROJ-108-metering' });

  const orders = [[a, b, c], [c, b, a], [b, c, a], [c, a, b]];
  const picks = orders.map((o) => resolveRoute(workRef(), o, OPTS).sessionId);
  assert.strictEqual(new Set(picks).size, 1, `shuffling must not change the pick: ${picks.join(',')}`);
  assert.strictEqual(picks[0], 'sess-b', 'newest submit wins; b and c tie on time, b sorts first by id at equal depth');
});

// ---- the happy paths ---------------------------------------------------------------------------------

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

test('rejected[] carries a reason per session so "why can\'t this resume?" is answerable', () => {
  // Note both legs are cleared deliberately: a session on another epic that still sits in THIS
  // WorkRef's linked worktree is genuinely eligible by the links leg, so the "wrong cluster" case
  // has to move its worktree too or it is not the case it claims to be.
  const wrongCluster = session({ status: 'idle', epic: 'ALPHA-1', worktree: 'feature/ALPHA-1-thing' });
  const noSurface = session({ status: 'idle', surface: null, surfaceReason: 'no-cwd' });
  const r = resolveRoute(workRef(), [wrongCluster, noSurface], OPTS);
  assert.strictEqual(r.kind, 'spawn', 'neither is eligible, and the cluster is free');
  assert.strictEqual(r.rejected.length, 2);
  assert.deepStrictEqual(r.rejected.map((x) => x.reason).sort(), ['no-cwd', REASONS.WRONG_CLUSTER].sort());
});
