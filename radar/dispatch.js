'use strict';
// dispatch.js — p11 S-006. The MECHANISM that sends a packet to a session. It decides nothing about
// whether work should happen; that judgment, and the budget and kill switch that bound it, belong to
// Hermes.
//
// ------------------------------------------------------------------------------------------------
// THE SWITCH IS OFF, AND IT STAYS OFF IN THIS BUILD (spec §8.1, Codex round 1 finding 4).
//
// §2.2 argues that the CLI's default permission mode is the real guardrail because it gates the
// dangerous END of a run. That is true of what happens inside a session. It is NOT true of the
// earlier boundary the p6 press also covered: choosing the work, injecting text into a live
// terminal, causing local edits and commits, reading private context, spending a run. In the full
// design those are held by Hermes' scope, budget, kill switch and circuit breaker — and every one
// of those is deferred out of this build.
//
// So `authority: "operator"` is refused unless `dispatch.enabled` is true, and `dispatch.enabled`
// defaults to false and is not turned on by this phase. What ships here is the mechanism plus its
// refusals. `authority: "sean"` is unchanged: it goes through p6's confirm-gated path exactly as
// today.
//
// ------------------------------------------------------------------------------------------------
// ELIGIBILITY IS RE-CHECKED HERE, SERVER-SIDE, ALWAYS. A caller may propose a target; it may not
// choose one. The snapshot a client read can be a minute old, and a minute is long enough for an
// idle session to start running — so the route is recomputed against the CURRENT state and a caller
// naming anything else is refused rather than obeyed. This is the only place the "never two
// writers" law can actually be enforced, because it is the only place that runs at dispatch time.
const { resolveRoute } = require('./eligibility');

const ERRORS = {
  DISABLED: 'dispatch_disabled',
  NOT_LEADER: 'not_leader',
  UNKNOWN_WORKREF: 'unknown_workref',
  CLUSTER_BUSY: 'cluster_busy',
  TARGET_MISMATCH: 'target_mismatch',
  NO_SURFACE: 'no_surface',
  BAD_REQUEST: 'bad_request',
  AUTHORITY: 'authority_refused',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A leader that can see no repos cannot reach the session inventory it would route against, which is
// exactly the observed two-leader pathology (spec F9, trap 11): a second machine claiming `leader`
// with no config. Refusing is strictly better than computing a confident route against an inventory
// this process cannot touch. Detection only — the topology itself is the operator's to fix.
function leaderRefusal(config) {
  if (!config || config.role !== 'leader') return 'role is not leader';
  if (!Array.isArray(config.repos) || config.repos.length === 0) {
    return 'this collector claims leader but has zero repos configured — refusing rather than routing against an inventory it cannot reach';
  }
  return null;
}

function findWorkRef(state, urn) {
  const list = (state && Array.isArray(state.workRefs)) ? state.workRefs : [];
  return list.find((w) => w && w.urn === urn) || null;
}

// The text a resumed session receives. Deliberately the SAME seed content p6 builds for a spawn —
// one packet description, two delivery mechanisms — so a resumed run and a spawned run cannot drift
// into describing the work differently.
function seedFor(workRef, opts) {
  const o = opts || {};
  const lines = [];
  lines.push(`You are receiving a scoped work packet from radar (run ${o.runId || 'unknown'}).`);
  lines.push('');
  lines.push(`## The work: ${workRef.urn}`);
  if (workRef.title) lines.push(`${workRef.kind || 'item'} — ${workRef.title}`);
  if (workRef.status) lines.push(`Tracker status: ${workRef.status.native || 'unknown'} (radar reads this as ${workRef.status.canonical}).`);
  if (Array.isArray(workRef.links) && workRef.links.length) {
    lines.push('');
    lines.push('## Linked git work');
    for (const l of workRef.links.slice(0, 12)) lines.push(`- ${l}`);
  }
  lines.push('');
  lines.push('## Hard rules');
  lines.push('Verify every fact before acting — use absolute /usr/bin/git, never bare git.');
  lines.push('Never delete branches. Never write to remote systems, trackers, or deploys.');
  lines.push('Push, merge and deploy require explicit approval: prepare the exact command, then STOP and ask.');
  return lines.join('\n');
}

function createDispatcher(deps) {
  const d = deps || {};

  async function dispatch(body) {
    if (!isObj(body)) return { status: 400, payload: { error: ERRORS.BAD_REQUEST, detail: 'body is not an object' } };

    const urns = Array.isArray(body.workRefUrns) ? body.workRefUrns.filter((u) => typeof u === 'string' && u) : [];
    if (urns.length !== 1) {
      // One packet, one run — spec §8, and not a deferral. A batch endpoint is the shape that turns
      // a bounded mistake into an unbounded one.
      return { status: 400, payload: { error: ERRORS.BAD_REQUEST, detail: 'exactly one workRefUrn per dispatch' } };
    }

    // `config` may be async: the server re-reads ~/.radar/config.json per request rather than
    // caching it, so a switch flipped on disk takes effect without a restart.
    const config = d.config ? await d.config() : null;
    const authority = body.authority === 'operator' ? 'operator' : body.authority === 'sean' ? 'sean' : null;
    if (!authority) return { status: 400, payload: { error: ERRORS.BAD_REQUEST, detail: 'authority must be "operator" or "sean"' } };

    if (authority === 'operator') {
      const enabled = !!(config && config.dispatch && config.dispatch.enabled);
      if (!enabled) {
        return {
          status: 503,
          payload: {
            error: ERRORS.DISABLED,
            detail: 'operator dispatch is disabled; the Hermes authority layer (scope, budget, kill switch) is not built, so autonomy is not enabled in this phase',
          },
        };
      }
      const token = d.authorityToken ? await d.authorityToken() : null;
      if (!token || body.authorityToken !== token) {
        return { status: 403, payload: { error: ERRORS.AUTHORITY, detail: 'operator authority token missing or wrong' } };
      }
    }

    const leaderWhy = leaderRefusal(config);
    if (leaderWhy) return { status: 409, payload: { error: ERRORS.NOT_LEADER, detail: leaderWhy } };

    const state = d.readState ? await d.readState() : null;
    const workRef = findWorkRef(state, urns[0]);
    if (!workRef) return { status: 404, payload: { error: ERRORS.UNKNOWN_WORKREF, detail: urns[0] } };

    // Recomputed NOW, against the current snapshot. A client's proposal is advisory.
    const resumeCfg = (config && config.resume) || {};
    const route = resolveRoute(workRef, (state && state.sessions) || [], {
      now: d.now ? d.now() : Date.now(),
      leader: state && state.collectorId,
      minIdleSec: resumeCfg.minIdleSec,
      maxIdleHours: resumeCfg.maxIdleHours,
      requireSurface: resumeCfg.requireSurface,
    });

    if (route.kind === null) {
      // The cluster gate said no. There is no fallback, by design.
      return { status: 409, payload: { error: ERRORS.CLUSTER_BUSY, detail: route.reason, route } };
    }

    const proposed = isObj(body.route) ? body.route : null;
    if (proposed && proposed.sessionId && proposed.sessionId !== route.sessionId) {
      return {
        status: 409,
        payload: { error: ERRORS.TARGET_MISMATCH, detail: `caller proposed ${proposed.sessionId}; current eligibility resolves ${route.sessionId || 'spawn'}`, route },
      };
    }

    const seed = seedFor(workRef, { runId: body.runId });

    if (route.kind === 'resume') {
      const session = ((state && state.sessions) || []).find((s) => s && s.key && s.key.sessionId === route.sessionId);
      const surfaceRef = session && session.surface && (session.surface.tabRef || session.surface.surfaceId);
      if (!surfaceRef) {
        return { status: 409, payload: { error: ERRORS.NO_SURFACE, detail: 'eligible session has no addressable surface', route } };
      }
      try {
        const r = await d.bridgeSend({ surface: surfaceRef, text: seed, submit: true, machine: route.machine });
        if (r && r.ok === false) throw new Error(r.error || 'bridge refused');
        return {
          status: 200,
          payload: { route: { kind: 'resume', sessionId: route.sessionId, machine: route.machine, reason: route.reason, fellBackFrom: null }, seed, dispatched: true },
        };
      } catch (e) {
        // Injection failed. Falling back to a spawn is safe here and ONLY here: the cluster gate
        // already proved nothing live is on this cluster, so a fresh session cannot become a second
        // writer. The fallback is recorded so the run's history shows what actually happened.
        const fb = await spawnFallback(workRef, seed, body, `resume failed: ${(e && e.message) || e}`);
        return fb;
      }
    }

    return await spawnFallback(workRef, seed, body, null);
  }

  async function spawnFallback(workRef, seed, body, fellBackReason) {
    if (typeof d.spawn !== 'function') {
      return { status: 501, payload: { error: 'spawn_unavailable', detail: 'no spawn implementation wired' } };
    }
    try {
      const r = await d.spawn({ workRef, seed, runId: body.runId });
      return {
        status: 200,
        payload: {
          route: { kind: 'spawn', sessionId: (r && r.sessionId) || null, machine: (r && r.machine) || null, reason: fellBackReason || 'no eligible session', fellBackFrom: fellBackReason ? 'resume' : null },
          seed,
          seedPath: (r && r.seedPath) || null,
          // p6's spawn runs with DEFAULT permissions and that is load-bearing (§8.1). If the caller
          // cannot establish the mode, it is reported rather than assumed — "default" is a
          // configuration assumption until something observes it.
          permissionMode: (r && r.permissionMode) || 'unverified',
          dispatched: true,
        },
      };
    } catch (e) {
      return { status: 502, payload: { error: 'spawn_failed', detail: (e && e.message) || String(e) } };
    }
  }

  return { dispatch, seedFor, leaderRefusal };
}

module.exports = { createDispatcher, seedFor, leaderRefusal, findWorkRef, ERRORS };
