'use strict';
// eligibility.js — p11 S-005. "Where should this work go: into a session that already exists, or a
// new one?" Radar answers WHERE. It never answers WHETHER — that is Hermes' judgment, gated by
// Hermes' scope, budget and kill switch.
//
// ------------------------------------------------------------------------------------------------
// TWO STAGES, AND THE FIRST ONE IS THE WHOLE SAFETY STORY.
//
// The first draft of this spec had exactly one stage: reject `running` and `blocked` sessions as
// resume candidates, then "no eligible session -> spawn". That is a two-writer bug reached through
// the FALLBACK rather than through the predicate — a cluster somebody is actively writing to has
// zero eligible resume targets, so the fallback cheerfully starts a SECOND session on it.
//
// So the stages answer two different questions and must not be collapsed:
//
//   STAGE 0  may this CLUSTER receive work at all?     -> if anything live is on it, NO. Not a
//                                                         resume, not a spawn, no fallback.
//   STAGE 1  which SESSION should receive it?          -> only reached once stage 0 said yes.
//
// A blocked cluster is not dispatched either: it is sitting on an unanswered permission prompt, and
// the thing it is most likely blocked on is precisely the class of action a human must approve.
// It escalates to a card instead.
//
// ------------------------------------------------------------------------------------------------
// IDENTITY IS THE EPIC, NOT THE REPO. An idle session in a repo is NOT evidence that it is working
// on this WorkRef — one repo carries many epics at once. Matching on repo containment would let a
// packet for one epic land in a live session working on another, which is the wrong-target defect
// with zero tolerance. A session that resolves to a repo but to NO epic (a repo-root session) is
// ineligible for the same reason: there is nothing tying it to this cluster, and guessing is the
// failure mode, not the feature.
//
// ------------------------------------------------------------------------------------------------
// WHAT THIS MODULE READS. `state.json` publishes sessions with DERIVED `repo` / `worktree` / `epic`
// and no raw `cwd`. The longest-prefix, segment-boundary rule (p5 trap 8 — `/repo/example-web-old`
// must never match `/repo/example-web`) is applied UPSTREAM by mod-sessions' mapCwd, and its result
// is the `epic` field read here. Re-deriving it would be a second mapping engine, and it would be
// derived from a field that does not exist in the published contract.

// A fixed vocabulary, in the style of mod-sessions' `surfaceReason`: every refusal says why in a
// word a consumer can branch on, and no refusal is ever a silent `false`.
const REASONS = {
  CLUSTER_RUNNING: 'cluster-running',
  CLUSTER_BLOCKED: 'cluster-blocked',
  NO_CLUSTER: 'no-cluster',
  NOT_IDLE: 'not-idle',
  WRONG_MACHINE: 'wrong-machine',
  WRONG_CLUSTER: 'wrong-cluster',
  NO_EPIC: 'session-has-no-epic',
  NO_SURFACE: 'no-surface',
  TOO_FRESH: 'idle-too-briefly',
  TOO_STALE: 'idle-too-long',
  ALREADY_BOUND: 'already-bound-to-a-run',
};

const LIVE_ON_CLUSTER = ['running', 'blocked'];

const sec = (ms) => Math.floor(ms / 1000);
const parse = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

const machineOf = (s) => (s && s.key && s.key.machine) || null;
const idOf = (s) => (s && s.key && s.key.sessionId) || null;

// Does this session belong to this WorkRef's cluster? Exact identity only.
function sessionInCluster(session, cluster) {
  if (!nonEmpty(cluster)) return false;
  return nonEmpty(session && session.epic) && session.epic === cluster;
}

// A session's worktree may also identify it, when the WorkRef's links name that exact worktree or
// branch. Still exact — a prefix match here would reopen the repo-containment hole.
function sessionMatchesLinks(session, links) {
  if (!session || !nonEmpty(session.worktree) || !Array.isArray(links)) return false;
  return links.some((u) => typeof u === 'string' && u.endsWith(`/${session.worktree}`));
}

// ---- stage 0 ---------------------------------------------------------------------------------------

// Returns the blocking reason, or null when the cluster is free. Evaluated over EVERY session, not
// just the ones that would have been resume candidates — that difference is the bug this exists for.
function clusterGate(workRef, sessions) {
  const cluster = workRef && workRef.cluster;
  if (!nonEmpty(cluster)) return null;          // no cluster ⇒ nothing to collide with
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!sessionInCluster(s, cluster)) continue;
    if (s.status === 'running') return REASONS.CLUSTER_RUNNING;
    if (s.status === 'blocked') return REASONS.CLUSTER_BLOCKED;
  }
  return null;
}

// ---- stage 1 ---------------------------------------------------------------------------------------

// Every predicate, in order, returning the FIRST reason it fails. Callers get a reason even for
// sessions they will never use, which is what makes "why can't this resume?" answerable.
function ineligibleReason(session, workRef, opts) {
  const o = opts || {};
  const cluster = workRef && workRef.cluster;
  if (!nonEmpty(cluster)) return REASONS.NO_CLUSTER;

  // Re-checked here even though stage 0 already excluded these, so a caller that reached this
  // function directly still cannot get an injection into a live session.
  if (session.status !== 'idle') return REASONS.NOT_IDLE;

  if (o.leader && machineOf(session) !== o.leader) return REASONS.WRONG_MACHINE;

  if (!nonEmpty(session.epic) && !sessionMatchesLinks(session, workRef.links)) return REASONS.NO_EPIC;
  if (!sessionInCluster(session, cluster) && !sessionMatchesLinks(session, workRef.links)) return REASONS.WRONG_CLUSTER;

  const requireSurface = o.requireSurface !== false;
  if (requireSurface && !session.surface) return session.surfaceReason || REASONS.NO_SURFACE;

  const idleMs = idleMsOf(session, o.now);
  if (idleMs == null) return REASONS.TOO_STALE;                   // no clock ⇒ cannot prove freshness
  if (idleMs < (o.minIdleSec == null ? 90 : o.minIdleSec) * 1000) return REASONS.TOO_FRESH;
  if (idleMs > (o.maxIdleHours == null ? 24 : o.maxIdleHours) * 3600000) return REASONS.TOO_STALE;

  const bound = o.boundSessionIds instanceof Set ? o.boundSessionIds : new Set(Array.isArray(o.boundSessionIds) ? o.boundSessionIds : []);
  if (bound.has(idOf(session))) return REASONS.ALREADY_BOUND;

  return null;
}

function idleMsOf(session, now) {
  const t = parse(session && session.lastEventAt);
  if (!Number.isFinite(t)) return null;
  const n = now == null ? Date.now() : now;
  return Math.max(0, n - t);
}

// Newest first, then the most specific worktree, then id — so the same input always picks the same
// session. A non-deterministic tie-break would make a wrong-target incident unreproducible.
function tieBreak(a, b) {
  const ta = parse(a.lastSubmitAt), tb = parse(b.lastSubmitAt);
  const na = Number.isFinite(ta) ? ta : -Infinity, nb = Number.isFinite(tb) ? tb : -Infinity;
  if (na !== nb) return nb - na;
  const wa = (a.worktree || '').length, wb = (b.worktree || '').length;
  if (wa !== wb) return wb - wa;
  const ia = idOf(a) || '', ib = idOf(b) || '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// ---- the resolver ------------------------------------------------------------------------------------

function resolveRoute(workRef, sessions, opts) {
  const o = opts || {};
  const list = Array.isArray(sessions) ? sessions : [];

  const gated = clusterGate(workRef, list);
  if (gated) {
    // No fallback. This is the point of stage 0.
    return { kind: null, sessionId: null, machine: null, reason: gated };
  }

  const candidates = [];
  const rejected = [];
  for (const s of list) {
    const why = ineligibleReason(s, workRef, o);
    if (why) rejected.push({ sessionId: idOf(s), reason: why });
    else candidates.push(s);
  }

  if (candidates.length) {
    const best = candidates.slice().sort(tieBreak)[0];
    return {
      kind: 'resume',
      sessionId: idOf(best),
      machine: machineOf(best),
      reason: `idle ${sec(idleMsOf(best, o.now) || 0)}s · epic ${workRef.cluster}`,
      rejected,
    };
  }

  // Stage 0 passed and nothing is eligible: a fresh session is safe because nothing live is on this
  // cluster. Budget is NOT consulted here and the reason says so — Hermes owns the budget, and a
  // reason implying otherwise would let a reader think a cap had been checked when none had.
  return {
    kind: 'spawn',
    sessionId: null,
    machine: o.leader || null,
    reason: 'no eligible session · budget not evaluated here',
    rejected,
  };
}

module.exports = { resolveRoute, clusterGate, ineligibleReason, sessionInCluster, sessionMatchesLinks, tieBreak, idleMsOf, REASONS, LIVE_ON_CLUSTER };
