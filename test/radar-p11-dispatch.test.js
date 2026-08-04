'use strict';
// p11 S-006 — the dispatch mechanism and, above all, its refusals.
//
// The tests that matter here are the ones that prove a CALLER CANNOT TALK ITS WAY IN:
//   - operator authority is refused while the switch is off (Codex finding 4),
//   - a client-proposed target is re-checked and refused when it disagrees with current truth,
//   - a busy cluster is refused with no spawn fallback (Codex finding 1, at dispatch time),
//   - a leader that cannot see repos refuses rather than routing (Codex finding 7 / spec F9).
const { test } = require('node:test');
const assert = require('node:assert');
const { createDispatcher, leaderRefusal, ERRORS } = require('../radar/dispatch');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

const CONFIG = (over) => Object.assign({
  role: 'leader',
  repos: [{ id: 'example-web', path: '/repo/example-web' }],
  resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: true },
  dispatch: { enabled: false, authorityTokenRef: 'RADAR_OPERATOR_TOKEN' },
}, over);

const SESSION = (over) => Object.assign({
  key: { machine: 'leader-1', sessionId: 'sess-a' },
  surface: { tabRef: 'surface:2' }, surfaceReason: null,
  repo: 'example-web', worktree: 'feature/PROJ-1-thing', epic: 'PROJ-1',
  status: 'idle', lastEventAt: agoMin(10), lastSubmitAt: agoMin(11),
}, over);

const STATE = (sessions) => ({
  collectorId: 'leader-1',
  sessions: sessions || [SESSION()],
  workRefs: [{
    urn: 'urn:work:jira:PROJ-1', source: 'jira', sourceId: 'PROJ-1', kind: 'epic',
    title: 'a thing', status: { native: 'In Progress', nativeCategory: 'indeterminate', canonical: 'active' },
    cluster: 'PROJ-1', links: ['urn:work:git:example-web/feature/PROJ-1-thing'], selectable: true, route: null,
  }],
});

function mk(over) {
  const calls = { sent: [], spawned: [] };
  const deps = Object.assign({
    config: () => CONFIG(),
    authorityToken: () => 'secret-token',
    readState: async () => STATE(),
    now: () => NOW,
    bridgeSend: async (a) => { calls.sent.push(a); return { ok: true }; },
    spawn: async (a) => { calls.spawned.push(a); return { sessionId: 'new-sess', machine: 'leader-1', seedPath: '/tmp/seed.md', permissionMode: 'default' }; },
  }, over || {});
  return { d: createDispatcher(deps), calls };
}

const REQ = (over) => Object.assign({ workRefUrns: ['urn:work:jira:PROJ-1'], authority: 'sean', runId: 'run-1' }, over || {});

// ---- the authority gate (Codex finding 4) ---------------------------------------------------------

test('operator authority is REFUSED while dispatch.enabled is false — the switch stays off this phase', async () => {
  const { d, calls } = mk();
  const r = await d.dispatch(REQ({ authority: 'operator', authorityToken: 'secret-token' }));
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.payload.error, ERRORS.DISABLED);
  assert.match(r.payload.detail, /Hermes authority layer/);
  assert.strictEqual(calls.sent.length, 0, 'nothing may be injected');
  assert.strictEqual(calls.spawned.length, 0, 'nothing may be spawned');
});

test('operator authority with the switch on still needs the right token', async () => {
  const on = { config: () => CONFIG({ dispatch: { enabled: true, authorityTokenRef: 'X' } }) };
  const wrong = await mk(on).d.dispatch(REQ({ authority: 'operator', authorityToken: 'nope' }));
  assert.strictEqual(wrong.status, 403);
  const missing = await mk(on).d.dispatch(REQ({ authority: 'operator' }));
  assert.strictEqual(missing.status, 403);
  const right = await mk(on).d.dispatch(REQ({ authority: 'operator', authorityToken: 'secret-token' }));
  assert.strictEqual(right.status, 200);
});

test('an unrecognised authority is refused rather than defaulted', async () => {
  for (const a of [undefined, null, '', 'admin', 'root', true]) {
    const r = await mk().d.dispatch(REQ({ authority: a }));
    assert.strictEqual(r.status, 400, `authority ${JSON.stringify(a)}`);
  }
});

// ---- one packet, one run --------------------------------------------------------------------------

test('batch dispatch is refused — one packet per run, and not as a deferral', async () => {
  const two = await mk().d.dispatch(REQ({ workRefUrns: ['urn:work:jira:PROJ-1', 'urn:work:jira:PROJ-2'] }));
  assert.strictEqual(two.status, 400);
  const none = await mk().d.dispatch(REQ({ workRefUrns: [] }));
  assert.strictEqual(none.status, 400);
});

// ---- the leader gate (Codex finding 7 / spec F9) ----------------------------------------------------

test('a leader with zero repos refuses rather than routing against an inventory it cannot reach', async () => {
  assert.match(leaderRefusal({ role: 'leader', repos: [] }), /zero repos/);
  assert.strictEqual(leaderRefusal({ role: 'viewer', repos: [] }), 'role is not leader');
  assert.strictEqual(leaderRefusal(CONFIG()), null);

  const { d, calls } = mk({ config: () => CONFIG({ repos: [] }) });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.payload.error, ERRORS.NOT_LEADER);
  assert.strictEqual(calls.sent.length + calls.spawned.length, 0);
});

// ---- server-side re-check (the core of the mechanism) -----------------------------------------------

test('a RUNNING cluster is refused at dispatch time, with NO spawn fallback', async () => {
  const { d, calls } = mk({ readState: async () => STATE([SESSION({ status: 'running' })]) });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.payload.error, ERRORS.CLUSTER_BUSY);
  assert.strictEqual(r.payload.detail, 'cluster-running');
  assert.strictEqual(calls.spawned.length, 0, 'the fallback must not fire on a busy cluster');
});

test('a BLOCKED cluster is refused the same way', async () => {
  const { d } = mk({ readState: async () => STATE([SESSION({ status: 'blocked' })]) });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.payload.detail, 'cluster-blocked');
});

test('a caller may PROPOSE a target but not choose one — a stale proposal is refused', async () => {
  const { d, calls } = mk();
  const r = await d.dispatch(REQ({ route: { kind: 'resume', sessionId: 'some-other-session' } }));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.payload.error, ERRORS.TARGET_MISMATCH);
  assert.strictEqual(calls.sent.length, 0);
});

test('an unknown workRef is a 404, never a best-effort dispatch', async () => {
  const r = await mk().d.dispatch(REQ({ workRefUrns: ['urn:work:jira:NOPE-1'] }));
  assert.strictEqual(r.status, 404);
});

// ---- the happy paths --------------------------------------------------------------------------------

test('resume injects through the EXISTING bridge contract, addressed by surface ref', async () => {
  const { d, calls } = mk();
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.payload.route.kind, 'resume');
  assert.strictEqual(calls.sent.length, 1);
  assert.strictEqual(calls.sent[0].surface, 'surface:2', 'addressed by surface ref, never tabUuid or workspace');
  assert.strictEqual(calls.sent[0].submit, true);
  assert.match(calls.sent[0].text, /Never delete branches/, 'the seed carries the hard rules');
  assert.match(calls.sent[0].text, /STOP and ask/, 'gated actions are told to stop, matching the permission mode');
});

test('spawn is reached only when nothing is eligible and the cluster is free', async () => {
  const { d, calls } = mk({ readState: async () => STATE([]) });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.payload.route.kind, 'spawn');
  assert.strictEqual(r.payload.route.fellBackFrom, null);
  assert.strictEqual(calls.spawned.length, 1);
});

test('an injection failure falls back to spawn and RECORDS that it did', async () => {
  const { d, calls } = mk({ bridgeSend: async () => { throw new Error('bridge unreachable'); } });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.payload.route.kind, 'spawn');
  assert.strictEqual(r.payload.route.fellBackFrom, 'resume');
  assert.match(r.payload.route.reason, /resume failed/);
  assert.strictEqual(calls.spawned.length, 1, 'exactly one fallback — never a retry loop');
});

test('a bridge that answers ok:false is a failure, not a success', async () => {
  const { d } = mk({ bridgeSend: async () => ({ ok: false, error: 'bad_surface' }) });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.payload.route.fellBackFrom, 'resume');
});

test('the permission mode is reported, not assumed', async () => {
  const unverified = await mk({ readState: async () => STATE([]), spawn: async () => ({ sessionId: 'x' }) }).d.dispatch(REQ());
  assert.strictEqual(unverified.payload.permissionMode, 'unverified', '"default" is an assumption until something observes it');
});

test('an eligible session with no addressable surface is refused, not guessed at', async () => {
  const noSurface = SESSION({ surface: {}, surfaceReason: null });
  const { d } = mk({ config: () => CONFIG({ resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: false } }), readState: async () => STATE([noSurface]) });
  const r = await d.dispatch(REQ());
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.payload.error, ERRORS.NO_SURFACE);
});
