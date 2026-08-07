'use strict';
// p11 S-004 — "additive" is a CLAIM, and this file is where it is made to earn the word.
//
// Codex round 1 (finding 3) was right to attack it: state.schema.json has additionalProperties:false
// at the top level AND inside counts, so the original "p5 fixtures pass unchanged" claim was simply
// false — the schema HAD to change. The resolution is that every p11 field is added as OPTIONAL
// (present in properties, absent from required), which is the only arrangement where both halves of
// the claim hold at once:
//
//   old p5 snapshots, with no workRefs at all      -> still valid
//   new p11 snapshots, with workRefs               -> also valid
//
// The consequence is a rule, asserted below: a consumer that assumes the key is present is the
// defect, not the snapshot that omits it.
const { test } = require('node:test');
const assert = require('node:assert');
const { derive } = require('../radar/derive');
const { validate } = require('../radar/schema-lite');
const SCHEMA = require('../radar/state.schema.json');

// The repo's validator takes (schema, data) and answers { valid, errors }.
const validateState = (state) => { const r = validate(SCHEMA, state); return { ok: r.valid, errors: r.errors }; };

const NOW = Date.parse('2026-07-30T12:00:00.000Z');

const baseInput = (over) => Object.assign({
  now: NOW,
  collectorId: 'leader-1',
  config: { role: 'leader', repos: [], resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: true } },
  sources: { git: { status: 'ok' }, sessions: { status: 'ok' }, deploy: { status: 'disabled' }, jira: { status: 'disabled' }, specs: { status: 'disabled' }, config: { status: 'ok' } },
  aliases: {}, decisions: [], handoffs: [], handoffRecovery: null,
  fragments: { git: { repos: {} }, deploy: { repos: {} }, sessions: { sessions: [], machines: null }, jira: { epics: {} }, specs: { specOrphans: [], epics: {} } },
}, over);

test('a snapshot with NO p11 input still validates and reports zero counts', () => {
  const state = derive(baseInput());
  const v = validateState(state);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors || []));
  assert.deepStrictEqual(state.workRefs, []);
  assert.strictEqual(state.counts.workRefs, 0);
  assert.strictEqual(state.counts.workRefsSelectable, 0);
});

test('an OLD p5-shaped snapshot — workRefs absent entirely — is still valid', () => {
  const state = derive(baseInput());
  delete state.workRefs;
  delete state.counts.workRefs;
  delete state.counts.workRefsSelectable;
  const v = validateState(state);
  assert.strictEqual(v.ok, true, `optional means optional: ${JSON.stringify(v.errors || [])}`);
});

test('an extended snapshot carrying WorkRefs is valid', () => {
  const state = derive(baseInput({
    fragments: Object.assign(baseInput().fragments, {
      jiraAgile: { items: [{ source: 'jira', sourceId: 'PROJ-108', kind: 'epic', title: 'metering', nativeStatus: 'In Progress', nativeCategory: 'indeterminate', epicKey: 'PROJ-108', description: 'do it', connector: 'mod-jira' }] },
    }),
  }));
  const v = validateState(state);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors || []));
  assert.strictEqual(state.workRefs.length, 1);
  assert.strictEqual(state.counts.workRefs, 1);
  assert.strictEqual(state.workRefs[0].status.canonical, 'active');
  assert.strictEqual(state.workRefs[0].status.native, 'In Progress', 'the source keeps its word');
});

// The consumer-level proof Codex asked for: the additive claim is about what p5 CONSUMERS see, not
// only about what the validator accepts.
test('the p5 structures are byte-identical with and without p11 input', () => {
  const without = derive(baseInput());
  const withRefs = derive(baseInput({
    fragments: Object.assign(baseInput().fragments, {
      jiraAgile: { items: [{ source: 'jira', sourceId: 'PROJ-1', nativeCategory: 'new', epicKey: 'PROJ-1' }] },
    }),
  }));
  for (const key of ['epics', 'attention', 'sessions', 'repos', 'machines', 'jiraDrift', 'handoffs']) {
    assert.deepStrictEqual(withRefs[key], without[key], `${key} must not move when WorkRefs appear`);
  }
  // Every p5 count is untouched; only the two p11 counters differ.
  for (const c of ['blocked', 'decisions', 'mergeable', 'orphans', 'staleWorktrees', 'handoffsLive']) {
    assert.strictEqual(withRefs.counts[c], without.counts[c], `counts.${c} must not move`);
  }
});

test('counts come from the source list, not from a filtered or folded view', () => {
  const items = [
    { source: 'jira', sourceId: 'PROJ-1', nativeCategory: 'indeterminate', epicKey: 'PROJ-1', description: 'x' }, // selectable
    { source: 'jira', sourceId: 'PROJ-2', nativeCategory: 'done', epicKey: 'PROJ-2' },                            // not selectable
    { source: 'jira', sourceId: 'PROJ-3', nativeCategory: 'new', epicKey: 'PROJ-3' },                             // inbox, not selectable
  ];
  const state = derive(baseInput({ fragments: Object.assign(baseInput().fragments, { jiraAgile: { items } }) }));
  assert.strictEqual(state.counts.workRefs, 3, 'the total counts everything, selectable or not');
  assert.strictEqual(state.counts.workRefsSelectable, 1);
});

test('a route is resolved per WorkRef and carried on the snapshot', () => {
  const sessions = [{
    key: { machine: 'leader-1', sessionId: 'sess-a' },
    surface: { tabRef: 'surface:2' }, surfaceReason: null,
    repo: 'example-web', worktree: 'feature/PROJ-1-thing', epic: 'PROJ-1',
    status: 'idle', lastEventAt: new Date(NOW - 600000).toISOString(), lastSubmitAt: new Date(NOW - 660000).toISOString(),
  }];
  const input = baseInput({
    fragments: Object.assign(baseInput().fragments, {
      sessions: { sessions, machines: [{ id: 'leader-1', bridge: 'ok', lastSeenAt: null }] },
      jiraAgile: { items: [{ source: 'jira', sourceId: 'PROJ-1', nativeCategory: 'indeterminate', epicKey: 'PROJ-1', description: 'x' }] },
    }),
  });
  const state = derive(input);
  assert.strictEqual(state.workRefs[0].route.kind, 'resume');
  assert.strictEqual(state.workRefs[0].route.sessionId, 'sess-a');
});

test('a RUNNING session on the cluster leaves route null on the published snapshot too', () => {
  const sessions = [{
    key: { machine: 'leader-1', sessionId: 'sess-a' },
    surface: { tabRef: 'surface:2' }, surfaceReason: null,
    repo: 'example-web', worktree: 'feature/PROJ-1-thing', epic: 'PROJ-1',
    status: 'running', lastEventAt: new Date(NOW - 1000).toISOString(), lastSubmitAt: new Date(NOW - 2000).toISOString(),
  }];
  const state = derive(baseInput({
    fragments: Object.assign(baseInput().fragments, {
      sessions: { sessions, machines: [{ id: 'leader-1', bridge: 'ok', lastSeenAt: null }] },
      jiraAgile: { items: [{ source: 'jira', sourceId: 'PROJ-1', nativeCategory: 'indeterminate', epicKey: 'PROJ-1', description: 'x' }] },
    }),
  }));
  assert.strictEqual(state.workRefs[0].route.kind, null, 'the cluster gate must survive the wiring');
  assert.strictEqual(state.workRefs[0].route.reason, 'cluster-running');
  assert.strictEqual(validateState(state).ok, true);
});
