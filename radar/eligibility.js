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
// That is a rule about WHO RECEIVES WORK. The gate asks a different question — "is anything live in
// the tree I am about to write in?" — and there repo containment is a legitimate warning, because
// the worst it can do is refuse. The two are reconciled in one place, at MEMBERSHIP below.
//
// ------------------------------------------------------------------------------------------------
// WHAT THIS MODULE READS, AND THE ONE FIELD IT MUST NOT READ AS IDENTITY. `state.json` publishes
// sessions with DERIVED `repo` / `worktree` / `epic` / `branch` and no raw `cwd`. The longest-prefix,
// segment-boundary rule (p5 trap 8 — `/repo/example-web-old` must never match `/repo/example-web`) is
// applied UPSTREAM, and its results are the fields read here. Re-deriving them would be a second
// mapping engine.
//
// `worktree` IS A CWD PATH — mod-sessions' mapCwd publishes the absolute directory, because that is
// what a human and the UI read. It is not an identity and this module never treats it as one. The
// second identity leg is `branch`, derived in derive.js by joining the session's repo + cwd against
// the worktree records git already reported, and it is the ONLY thing compared against a
// `urn:work:git:<repo>/<branch>` link. The previous suffix test (`link.endsWith('/' + worktree)`)
// was dead on every real session — an absolute path makes the needle `//path/...`, which no URN can
// end with — and it was ALSO too loose on the shapes it did match, since a bare trailing segment
// let worktree `PROJ-108-x` claim branch `feature/PROJ-108-x`. Dead in production and wrong in
// principle: both legs are replaced by exact repo + exact branch equality.

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
  // A session radar cannot NAME. A resume route has to carry a sessionId or it points at nothing,
  // so an identity-less session is refused here rather than resolved into an undispatchable route.
  NO_IDENTITY: 'no-identity',
  NO_SURFACE: 'no-surface',
  TOO_FRESH: 'idle-too-briefly',
  TOO_STALE: 'idle-too-long',
  // Absent or unparseable lastEventAt. Ineligible exactly like TOO_STALE — failing closed is
  // correct — but it is NOT the same fact: "idle too long" asserts a measurement that never
  // happened, and an operator reading it would go looking for a stale session that does not exist.
  NO_CLOCK: 'no-clock',
  ALREADY_BOUND: 'already-bound-to-a-run',
};

const LIVE_ON_CLUSTER = ['running', 'blocked'];
const GIT_URN = 'urn:work:git:';

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

// `urn:work:git:<repoId>/<branch>` -> its two halves. Split on the FIRST slash: workref.js builds
// these from a config repo id (which has no slash) and a branch name (which usually does).
function parseGitLink(urn) {
  if (typeof urn !== 'string' || !urn.startsWith(GIT_URN)) return null;
  const rest = urn.slice(GIT_URN.length);
  const cut = rest.indexOf('/');
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { repo: rest.slice(0, cut), branch: rest.slice(cut + 1) };
}

// The second identity leg: this session is on exactly the repo AND exactly the branch a link names.
// Both halves are required and both are exact. The link's repoId used to be discarded entirely,
// which made a branch name enough to claim a session in a different repo.
function sessionMatchesLinks(session, links) {
  if (!session || !nonEmpty(session.repo) || !nonEmpty(session.branch) || !Array.isArray(links)) return false;
  return links.some((u) => {
    const l = parseGitLink(u);
    return l !== null && l.repo === session.repo && l.branch === session.branch;
  });
}

// Weaker than identity, and used by stage 0 ONLY (see the asymmetry note below): the session sits in
// a repo this WorkRef has branches in.
function sessionInLinkedRepo(session, links) {
  if (!session || !nonEmpty(session.repo) || !Array.isArray(links)) return false;
  return links.some((u) => {
    const l = parseGitLink(u);
    return l !== null && l.repo === session.repo;
  });
}

// ---- membership: ONE predicate, two stages ---------------------------------------------------------
//
// Stage 0 and stage 1 used to answer "is this session on this cluster?" with two different pieces of
// code — stage 1 accepted links as identity, stage 0 had never heard of them — so a session could be
// resumable for a cluster it could not gate. They now share this function, and the ONLY difference
// between the stages is the mode argument, stated here rather than spread across two call sites.
//
// THE ASYMMETRY IS DELIBERATE AND IT ONLY POINTS ONE WAY:
//
//   GATE   over-inclusive on purpose. A false positive REFUSES a dispatch — the cost is a card a
//          human clears. So a session that has resolved to no epic at all, sitting in a repo this
//          WorkRef has work in, counts; and a session declaring a conflicting epic still counts if
//          it is standing in a linked branch, because whatever it believes it is doing, it is
//          writing in the tree we are about to write in.
//   RESUME exact only. A false positive INJECTS work into the wrong session and nothing downstream
//          catches it — the wrong-target defect, with zero tolerance. So the widenings above are not
//          available here, and a session asserting a DIFFERENT epic is refused even when it matches
//          a link: a conflicting assertion is evidence of the wrong target, not missing evidence.
const MEMBERSHIP = { GATE: 'gate', RESUME: 'resume' };

function sessionMembership(session, workRef, mode) {
  const cluster = workRef && workRef.cluster;
  if (!session || !nonEmpty(cluster)) return false;
  const links = (workRef && Array.isArray(workRef.links)) ? workRef.links : [];
  const declaresEpic = nonEmpty(session.epic);

  if (sessionInCluster(session, cluster)) return true;
  if (mode === MEMBERSHIP.RESUME && declaresEpic) return false;    // conflicting assertion, stage 1
  if (sessionMatchesLinks(session, links)) return true;
  if (mode === MEMBERSHIP.GATE && !declaresEpic && sessionInLinkedRepo(session, links)) return true;
  return false;
}

// ---- stage 0 ---------------------------------------------------------------------------------------

// Returns the blocking reason, or null when the cluster is free. Evaluated over EVERY session, not
// just the ones that would have been resume candidates — that difference is the bug this exists for.
function clusterGate(workRef, sessions) {
  const cluster = workRef && workRef.cluster;
  if (!nonEmpty(cluster)) return null;          // no cluster ⇒ nothing to collide with
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!sessionMembership(s, workRef, MEMBERSHIP.GATE)) continue;
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
  if (!session || session.status !== 'idle') return REASONS.NOT_IDLE;

  // Before anything is asked ABOUT the session, it has to be nameable. A route that resumes a
  // session radar cannot identify is a dispatchable pointer to nothing.
  if (!nonEmpty(idOf(session))) return REASONS.NO_IDENTITY;

  if (o.leader && machineOf(session) !== o.leader) return REASONS.WRONG_MACHINE;

  // One predicate with stage 0 (see MEMBERSHIP). The two reasons below are the same refusal told
  // from the session's side: it asserted nothing that ties it here, or it asserted something else.
  if (!sessionMembership(session, workRef, MEMBERSHIP.RESUME)) {
    return nonEmpty(session.epic) ? REASONS.WRONG_CLUSTER : REASONS.NO_EPIC;
  }

  const requireSurface = o.requireSurface !== false;
  if (requireSurface && !session.surface) return session.surfaceReason || REASONS.NO_SURFACE;

  const idleMs = idleMsOf(session, o.now);
  if (idleMs == null) return REASONS.NO_CLOCK;                    // no clock ⇒ cannot prove freshness
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

// Newest first, then EXACT link identity, then id — so the same input always picks the same session.
// A non-deterministic tie-break would make a wrong-target incident unreproducible.
//
// The middle leg used to be "the most specific worktree", implemented as the LONGEST string. Length
// is not specificity: at equal lastSubmitAt, `feature/PROJ-108-searchindex-old` beat the canonical
// `feature/PROJ-108-searchindex` for the simple reason that "-old" is four characters — the tie-break
// preferred the stale sibling by construction. Exact beats partial, and there is no partial rank at
// all: a session whose repo+branch IS one of the WorkRef's links outranks any session that merely
// resolved to the cluster some other way. `workRef` is optional so the comparator stays usable
// standalone; without it neither side can prove exactness and the leg is simply skipped.
function tieBreak(a, b, workRef) {
  const ta = parse(a && a.lastSubmitAt), tb = parse(b && b.lastSubmitAt);
  const na = Number.isFinite(ta) ? ta : -Infinity, nb = Number.isFinite(tb) ? tb : -Infinity;
  if (na !== nb) return nb - na;
  const links = (workRef && Array.isArray(workRef.links)) ? workRef.links : [];
  const ea = sessionMatchesLinks(a, links) ? 0 : 1, eb = sessionMatchesLinks(b, links) ? 0 : 1;
  if (ea !== eb) return ea - eb;
  const ia = idOf(a) || '', ib = idOf(b) || '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// ---- the resolver ------------------------------------------------------------------------------------

function resolveRoute(workRef, sessions, opts) {
  const o = opts || {};
  const list = Array.isArray(sessions) ? sessions : [];

  const gated = clusterGate(workRef, list);
  if (gated) {
    // No fallback. This is the point of stage 0. `rejected` is empty rather than absent: EVERY
    // return shape carries the key, because a consumer doing `route.rejected.map(...)` would
    // otherwise throw on precisely the safety path — the one return a caller must be able to read.
    return { kind: null, sessionId: null, machine: null, reason: gated, rejected: [] };
  }

  const candidates = [];
  const rejected = [];
  for (const s of list) {
    const why = ineligibleReason(s, workRef, o);
    if (why) rejected.push({ sessionId: idOf(s), reason: why });
    else candidates.push(s);
  }

  if (candidates.length) {
    const best = candidates.slice().sort((x, y) => tieBreak(x, y, workRef))[0];
    const sessionId = idOf(best);
    // A `resume` MUST name its target. ineligibleReason already refuses an unnameable session, so
    // this is the invariant restated where the route is actually built — if the two ever disagree,
    // the route falls through to a spawn (safe: stage 0 proved nothing live is on this cluster)
    // instead of emitting a resume that points at nothing.
    if (nonEmpty(sessionId)) {
      return {
        kind: 'resume',
        sessionId,
        machine: machineOf(best),
        reason: `idle ${sec(idleMsOf(best, o.now) || 0)}s · epic ${workRef.cluster}`,
        rejected,
      };
    }
    rejected.push({ sessionId: null, reason: REASONS.NO_IDENTITY });
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

module.exports = {
  resolveRoute, clusterGate, ineligibleReason,
  sessionInCluster, sessionMatchesLinks, sessionInLinkedRepo, sessionMembership, parseGitLink,
  tieBreak, idleMsOf, REASONS, MEMBERSHIP, LIVE_ON_CLUSTER,
};
