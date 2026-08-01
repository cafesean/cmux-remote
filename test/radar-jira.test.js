'use strict';
// S-008 — mod-jira. The load-bearing test in this file is the one that proves Q2 exists and that
// deleting it makes the Jira-Done drift direction undetectable; every other test guards a rule the
// spec review had to state twice.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  collectJira, loadJiraConfig, openEpicsJql, keysJql, knownEpicKeys,
  searchAll, mapIssue, detectDrift, gitSignalsFor, ISSUE_KEY_RE, PAGE_SIZE,
} = require('../radar/mod-jira');
const { derive } = require('../radar/derive');
const store = require('../radar/store');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const OBSERVED = new Date(NOW).toISOString();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const JIRA_CFG = { baseUrl: 'https://jira.example', tokenRef: 'JT', projects: ['PROJ', 'ALPHA', 'BETA'] };

// A Jira issue as the REST v2 search endpoint actually returns it (shape copied from a live probe
// of a Jira Data Center instance).
const issue = (key, statusName, categoryKey, o) => Object.assign({
  key,
  fields: {
    summary: `${key} summary`,
    status: { name: statusName, statusCategory: { key: categoryKey, name: statusName } },
    project: { key: key.split('-')[0] },
    updated: daysAgo(2),
  },
}, o || {});

// A Jira server stub. `handler(jql, startAt)` returns the issues for that page.
function jiraStub(handler) {
  const queries = [];
  const impl = async (url) => {
    const u = new URL(url);
    const jql = u.searchParams.get('jql');
    const startAt = Number(u.searchParams.get('startAt'));
    queries.push({ jql, startAt, url });
    const r = handler(jql, startAt);
    if (r && r.httpStatus) return { ok: false, status: r.httpStatus, json: async () => r.body || {} };
    if (r instanceof Error) throw r;
    const all = Array.isArray(r) ? r : (r.issues || []);
    const page = all.slice(startAt, startAt + PAGE_SIZE);
    return { ok: true, status: 200, json: async () => ({ startAt, maxResults: PAGE_SIZE, total: all.length, issues: page }) };
  };
  impl.queries = queries;
  return impl;
}

const branch = (o) => Object.assign({
  name: 'feature/PROJ-1-thing', sha: 's', epic: 'PROJ-1', isDefault: false,
  unpushed: 0, mergedIntoDevelop: true, mergedIntoMain: false, lastCommitAt: daysAgo(90), worktree: null,
}, o);

const gitFrag = (branches) => ({ repos: { r1: { path: '/r1', branches, worktrees: [], deploy: null, fetch: { status: 'ok', error: null } } } });

const run = (o) => collectJira(Object.assign({
  now: NOW, jiraConfig: JIRA_CFG, env: { JT: 'token' }, fragments: { git: gitFrag([]) }, aliases: {}, decisions: [],
}, o));

// ---- the two queries -----------------------------------------------------------------------------

test('Q1 filters on statusCategory, not a status display name', () => {
  const jql = openEpicsJql(['PROJ', 'ALPHA', 'BETA']);
  assert.strictEqual(jql, 'project in (PROJ,ALPHA,BETA) AND issuetype = Epic AND statusCategory != Done ORDER BY key');
  assert.ok(!/status\s*!?=\s*"/.test(jql), 'never a quoted display name');
});

test('BOTH queries are issued: open-epics AND key-in for git-known epics', async () => {
  const stub = jiraStub(() => []);
  await run({ fragments: { git: gitFrag([branch({ epic: 'PROJ-108' })]) }, fetchImpl: stub });
  const jqls = stub.queries.map((q) => q.jql);
  assert.strictEqual(jqls.length, 2);
  assert.match(jqls[0], /statusCategory != Done/);
  assert.match(jqls[1], /^key in \(PROJ-108\)/);
});

test('Q2 is what makes the Jira-Done direction detectable — without it the epic is invisible', async () => {
  // PROJ-9 is Done in Jira but git is still moving. Q1 cannot return it: `statusCategory != Done`
  // excludes it by construction. Only Q2 sees it.
  const live = gitFrag([branch({ name: 'feature/PROJ-9-x', epic: 'PROJ-9', unpushed: 4, mergedIntoDevelop: false, lastCommitAt: daysAgo(1) })]);
  const done = issue('PROJ-9', 'Done', 'done');

  const q1Only = await run({
    fragments: { git: live },
    fetchImpl: jiraStub((jql) => (/statusCategory != Done/.test(jql) ? [] : [])),
  });
  assert.deepStrictEqual(q1Only.fragment.drift, [], 'Q1 alone can never see a Done epic');

  const both = await run({
    fragments: { git: live },
    fetchImpl: jiraStub((jql) => (/^key in/.test(jql) ? [done] : [])),
  });
  assert.strictEqual(both.fragment.drift.length, 1);
  assert.strictEqual(both.fragment.drift[0].direction, 'jira-done-git-live');
});

test('only real issue keys enter the key-in clause — a p-numeral would 400 the whole query', () => {
  assert.ok(ISSUE_KEY_RE.test('PROJ-108') && ISSUE_KEY_RE.test('BETA-9'));
  assert.ok(!ISSUE_KEY_RE.test('p59') && !ISSUE_KEY_RE.test('searchindex') && !ISSUE_KEY_RE.test('proj-108'));

  const keys = knownEpicKeys({
    fragments: { git: gitFrag([branch({ epic: 'PROJ-1' }), branch({ name: 'p59-x', epic: 'p59' })]) },
    aliases: { epics: { 'PROJ-108': ['p59'], 'not-an-epic': [] }, branchOverrides: { 'r1:x': 'BETA-4' } },
    decisions: [{ id: 'd', epic: 'ALPHA-2', closedAt: null }, { id: 'e', epic: 'ALPHA-3', closedAt: daysAgo(1) }],
  });
  assert.deepStrictEqual(keys, ['ALPHA-2', 'BETA-4', 'PROJ-1', 'PROJ-108']);
});

test('the key-in query is SKIPPED when nothing is known — empty `key in ()` is invalid JQL', async () => {
  const stub = jiraStub(() => []);
  await run({ fetchImpl: stub });
  assert.strictEqual(stub.queries.length, 1, 'only the open-epics query');
  assert.ok(!stub.queries.some((q) => /key in \(\)/.test(q.jql)));
});

test('a long key list is chunked so the JQL never grows unbounded', async () => {
  const many = Array.from({ length: 250 }, (_, i) => branch({ name: `f/PROJ-${i + 1}`, epic: `PROJ-${i + 1}` }));
  const stub = jiraStub(() => []);
  await run({ fragments: { git: gitFrag(many) }, fetchImpl: stub });
  assert.strictEqual(stub.queries.length, 4, 'open-epics + 3 chunks of 100');
});

test('the JQL is URL-encoded exactly once, and the token never appears in the URL', async () => {
  const stub = jiraStub(() => []);
  await run({ fetchImpl: stub });
  const { url, jql } = stub.queries[0];
  assert.ok(url.includes('jql=project%20in%20(PROJ%2CALPHA%2CBETA)'), url);
  assert.strictEqual(jql, openEpicsJql(['PROJ', 'ALPHA', 'BETA']), 'decodes back to exactly one encoding');
  assert.ok(!url.includes('token'), 'auth is a header, never a query parameter');
});

test('pagination walks startAt until total is reached', async () => {
  const all = Array.from({ length: 230 }, (_, i) => issue(`PROJ-${i + 1}`, 'In Progress', 'indeterminate'));
  const stub = jiraStub((jql) => (/statusCategory/.test(jql) ? all : []));
  const r = await run({ fetchImpl: stub });
  assert.strictEqual(Object.keys(r.fragment.epics).length, 230);
  assert.deepStrictEqual(stub.queries.filter((q) => /statusCategory/.test(q.jql)).map((q) => q.startAt), [0, 100, 200]);
});

test('a server that claims a total but returns nothing does not spin the pagination loop', async () => {
  let pages = 0;
  const impl = async () => { pages++; return { ok: true, status: 200, json: async () => ({ startAt: 0, maxResults: 100, total: 9999, issues: [] }) }; };
  const r = await run({ fetchImpl: impl });
  assert.strictEqual(pages, 1);
  assert.strictEqual(r.source.status, 'ok');
});

// ---- statusCategory mapping ---------------------------------------------------------------------------

test('statusCategory mapping: three display names on one Jira instance collapse to one category', () => {
  // Display names seen on a real instance — in-flight epics spread across three names.
  for (const name of ['In Progress', 'Ready for Code Review', 'Ready for Test']) {
    assert.strictEqual(mapIssue(issue('PROJ-1', name, 'indeterminate')).statusCategory, 'indeterminate', name);
  }
  assert.strictEqual(mapIssue(issue('PROJ-2', 'New', 'new')).statusCategory, 'new');
  assert.strictEqual(mapIssue(issue('PROJ-3', 'Done', 'done')).statusCategory, 'done');
  // The display name is carried for rendering, but nothing branches on it.
  assert.strictEqual(mapIssue(issue('PROJ-1', 'Ready for Test', 'indeterminate')).status, 'Ready for Test');
});

test('an unrecognised statusCategory becomes null and a warning, never a guess', async () => {
  const r = await run({ fetchImpl: jiraStub((jql) => (/statusCategory/.test(jql) ? [issue('PROJ-5', 'Weird', 'sideways')] : [])) });
  assert.strictEqual(r.fragment.epics['PROJ-5'].statusCategory, null);
  assert.match(r.warnings.join(' '), /PROJ-5: unrecognised statusCategory/);
});

test('the key query wins on conflict — it is the one that can see every status', async () => {
  const stub = jiraStub((jql) => (/^key in/.test(jql) ? [issue('PROJ-1', 'Done', 'done')] : [issue('PROJ-1', 'In Progress', 'indeterminate')]));
  const r = await run({ fragments: { git: gitFrag([branch({ epic: 'PROJ-1' })]) }, fetchImpl: stub });
  assert.strictEqual(r.fragment.epics['PROJ-1'].statusCategory, 'done');
});

// ---- drift, both directions --------------------------------------------------------------------------

test('drift direction A — Jira Done, git still live', () => {
  const epic = mapIssue(issue('PROJ-9', 'Done', 'done'));
  assert.strictEqual(detectDrift(epic, { branches: 1, unpushed: 0, unmerged: 0, newestCommitAt: daysAgo(400) }, NOW), null, 'done and quiet is not drift');

  const unpushed = detectDrift(epic, { branches: 1, unpushed: 9, unmerged: 0, newestCommitAt: daysAgo(400) }, NOW);
  assert.strictEqual(unpushed.direction, 'jira-done-git-live');
  assert.match(unpushed.note, /9 unpushed commits/);

  const recent = detectDrift(epic, { branches: 1, unpushed: 0, unmerged: 0, newestCommitAt: daysAgo(3) }, NOW);
  assert.match(recent.note, /a commit in the last 14 days/);

  const unmerged = detectDrift(epic, { branches: 1, unpushed: 0, unmerged: 2, newestCommitAt: daysAgo(400) }, NOW);
  assert.match(unmerged.note, /2 unmerged branches/);
});

test('drift direction B — Jira In Progress, git quiet past 30 days', () => {
  const epic = mapIssue(issue('PROJ-10', 'In Progress', 'indeterminate'));
  assert.strictEqual(detectDrift(epic, { branches: 1, unpushed: 0, unmerged: 0, newestCommitAt: daysAgo(20) }, NOW), null, '20 days is not quiet yet');
  const d = detectDrift(epic, { branches: 1, unpushed: 0, unmerged: 0, newestCommitAt: daysAgo(95) }, NOW);
  assert.strictEqual(d.direction, 'jira-inprogress-git-quiet');
  assert.match(d.note, /no epic-branch commit for 95 days/);
});

// Reversed 2026-07-31 with the Jira-is-not-an-activity-signal change. This epic used to be exempt
// from drift because it has no git clock; that exemption is what let ten of them render as ACTIVE
// on the real board with no commits and no date. No clock is needed to state the fact.
test('an In-Progress epic with ZERO branches IS drift — Jira asserts work git cannot see', () => {
  const epic = mapIssue(issue('PROJ-11', 'In Progress', 'indeterminate'));
  const d = detectDrift(epic, { branches: 0, unpushed: 0, unmerged: 0, newestCommitAt: null }, NOW);
  assert.strictEqual(d.direction, 'jira-inprogress-no-git');
  assert.match(d.note, /no branch anywhere carries this epic/);
});

test('both drift directions land in the digest, attached to the epic they describe', async () => {
  const branches = [
    branch({ name: 'feature/PROJ-9-live', epic: 'PROJ-9', unpushed: 4, mergedIntoDevelop: false, lastCommitAt: daysAgo(1) }),
    branch({ name: 'feature/PROJ-10-old', epic: 'PROJ-10', unpushed: 0, mergedIntoDevelop: true, lastCommitAt: daysAgo(120) }),
  ];
  const r = await run({
    fragments: { git: gitFrag(branches) },
    fetchImpl: jiraStub((jql) => (/^key in/.test(jql)
      ? [issue('PROJ-9', 'Done', 'done'), issue('PROJ-10', 'In Progress', 'indeterminate')]
      : [issue('PROJ-10', 'In Progress', 'indeterminate')])),
  });
  assert.deepStrictEqual(r.fragment.drift.map((d) => `${d.epic}:${d.direction}`), ['PROJ-10:jira-inprogress-git-quiet', 'PROJ-9:jira-done-git-live']);
  assert.strictEqual(r.fragment.epics['PROJ-9'].drift.direction, 'jira-done-git-live');
  assert.strictEqual(r.fragment.epics['PROJ-10'].drift.direction, 'jira-inprogress-git-quiet');
});

test('DRIFT IS NEVER AN INTERRUPT — neither direction produces a single attention item', async () => {
  const branches = [
    branch({ name: 'feature/PROJ-9-live', epic: 'PROJ-9', unpushed: 4, mergedIntoDevelop: false, lastCommitAt: daysAgo(1) }),
    branch({ name: 'feature/PROJ-10-old', epic: 'PROJ-10', unpushed: 0, mergedIntoDevelop: true, lastCommitAt: daysAgo(120) }),
  ];
  const jira = await run({
    fragments: { git: gitFrag(branches) },
    fetchImpl: jiraStub(() => [issue('PROJ-9', 'Done', 'done'), issue('PROJ-10', 'In Progress', 'indeterminate')]),
  });
  assert.strictEqual(jira.fragment.drift.length, 2, 'both directions detected');

  const state = deriveWith({ git: gitFrag(branches), jira: jira.fragment }, { jira: { status: 'ok', observedAt: OBSERVED } });
  const kinds = new Set(state.attention.map((a) => a.type));
  assert.ok(!kinds.has('drift') && !kinds.has('jira-drift') && !kinds.has('jiraDrift'), 'no drift attention type exists');
  // Nothing that reaches the queue references drift at all.
  assert.deepStrictEqual(state.attention.filter((a) => JSON.stringify(a).includes('drift')), []);
  // But the digest consumer can still find it on the published epics.
  const proj9 = state.epics.find((e) => e.key === 'PROJ-9');
  assert.strictEqual(proj9.jira.drift.direction, 'jira-done-git-live');
});

// ---- derive integration -----------------------------------------------------------------------------

function deriveWith(fragments, sourceOverrides) {
  return derive({
    now: NOW,
    collectorId: 'test',
    config: { repos: [] },
    sources: Object.assign({
      git: { status: 'ok', observedAt: OBSERVED },
      sessions: { status: 'disabled' },
      deploy: { status: 'disabled' },
      jira: { status: 'disabled' },
      specs: { status: 'disabled' },
      config: { status: 'ok' },
    }, sourceOverrides || {}),
    aliases: {},
    decisions: [],
    fragments,
  });
}

// S-008's "epics with Jira In Progress and zero branches appear" bullet, as amended: they are still
// REACHABLE — parked, phrased as drift, and in the weekly digest — but a Jira status alone may not
// put anything in the ACTIVE zone. That is the whole point of the reclassification.
test('an epic that is In Progress in Jira with ZERO branches is reachable but DORMANT, never active', async () => {
  const r = await run({ fetchImpl: jiraStub((jql) => (/statusCategory/.test(jql) ? [issue('PROJ-77', 'Ready for Test', 'indeterminate')] : [])) });
  const state = deriveWith({ git: gitFrag([]), jira: r.fragment }, { jira: { status: 'ok', observedAt: OBSERVED } });
  const e = state.epics.find((x) => x.key === 'PROJ-77');
  assert.ok(e, 'present with no branch, no session and no commit — reclassified, not deleted');
  assert.strictEqual(e.zone, 'dormant', 'a Jira status alone can never make an epic ACTIVE');
  assert.ok(e.signals.includes('jira-in-progress'), 'the signal is still reported, just not as activity');
  assert.strictEqual(e.phrase, 'jira says in progress · no branches', 'the row names the drift instead of restating it as fact');
  assert.strictEqual(e.branchCount, 0);
  assert.strictEqual(e.jira.status, 'Ready for Test', 'the display name survives for rendering');
  assert.ok(state.jiraDrift.some((d) => d.epic === 'PROJ-77' && d.direction === 'jira-inprogress-no-git'),
    'and it lands in the weekly digest');
});

test('a Jira In-Progress epic WITH a recent commit is still ACTIVE — corroboration is what promotes it', async () => {
  const r = await run({ fetchImpl: jiraStub((jql) => (/statusCategory/.test(jql) ? [issue('PROJ-78', 'In Progress', 'indeterminate')] : [])) });
  const state = deriveWith(
    { git: gitFrag([branch({ name: 'feature/PROJ-78-x', epic: 'PROJ-78', unpushed: 0, mergedIntoDevelop: true, lastCommitAt: daysAgo(1) })]), jira: r.fragment },
    { jira: { status: 'ok', observedAt: OBSERVED } });
  const e = state.epics.find((x) => x.key === 'PROJ-78');
  assert.strictEqual(e.zone, 'active');
  assert.ok(e.signals.includes('recent-commit'), 'the git signal is what makes it active');
});

test('a Done Jira epic with no git activity at all still disappears — done means gone', async () => {
  const r = await run({ fetchImpl: jiraStub((jql) => (/^key in/.test(jql) ? [issue('PROJ-1', 'Done', 'done')] : [])) });
  const state = deriveWith({ git: gitFrag([branch({ epic: 'PROJ-1', unpushed: 0, mergedIntoDevelop: true, lastCommitAt: daysAgo(400) })]), jira: r.fragment }, { jira: { status: 'ok', observedAt: OBSERVED } });
  assert.strictEqual(state.epics.find((e) => e.key === 'PROJ-1'), undefined);
});

// ---- failure degradation ---------------------------------------------------------------------------------

test('auth and rate-limit failures degrade to a sources.jira error with a NULL fragment', async () => {
  for (const [status, want] of [[401, /401 unauthorized/], [403, /403 unauthorized/], [429, /429 rate limited/], [500, /jira 500/]]) {
    const r = await run({ fetchImpl: jiraStub(() => ({ httpStatus: status, body: { errorMessages: ['nope'] } })) });
    assert.strictEqual(r.source.status, 'error', `HTTP ${status}`);
    assert.match(r.source.error, want);
    assert.strictEqual(r.fragment, null, 'null fragment => the collector carries the last-good epics forward');
  }
});

test('a network failure is a source error, never an empty board', async () => {
  const r = await run({ fetchImpl: async () => { const e = new Error('ETIMEDOUT'); throw e; } });
  assert.strictEqual(r.source.status, 'error');
  assert.match(r.source.error, /ETIMEDOUT/);
  assert.strictEqual(r.fragment, null);
});

test('the error message names the env VAR, never the token value', async () => {
  const r = await run({ env: {} });
  assert.strictEqual(r.source.status, 'error');
  assert.strictEqual(r.source.error, 'env JT is unset');
  assert.strictEqual(r.fragment, null);
});

test('a null fragment makes the collector carry the previous epics forward unchanged', async () => {
  // The contract, exercised through the collector's own merge rule.
  const { fragmentsFromState } = require('../radar/collector');
  const carried = fragmentsFromState({ v: 1, repos: {} });
  const r = await run({ env: {} });
  const merged = r && r.fragment ? r.fragment : carried.jira;
  assert.deepStrictEqual(merged, { epics: {}, drift: [] }, 'falls back to carry-forward rather than publishing an empty set');
});

test('carry-forward keeps jiraDrift and the spec ladder — a skipped module must not zero them', () => {
  // The bug: fragmentsFromState rebuilt git/deploy/sessions but returned EMPTY jira and specs, so
  // any scan that did not run those modules (--no-fetch, or the 60s session-only sweep) republished
  // 0 drift rows and reset every spec cell — while sources.jira/specs were carried forward as `ok`.
  // Data loss under a green badge.
  const { fragmentsFromState } = require('../radar/collector');
  const carried = fragmentsFromState({
    v: 1,
    repos: {},
    jiraDrift: [{ epic: 'PROJ-10', direction: 'jira-inprogress-no-git', note: 'stale' }],
    epics: [
      { key: 'PROJ-10', jira: { status: 'In Progress' }, ladder: { spec: 'done' } },
      { key: 'PROJ-11', jira: null, ladder: { spec: 'partial' } },
      { key: 'PROJ-12', jira: null, ladder: { spec: 'none' } },
    ],
    attention: [
      { type: 'spec-orphan', specFolder: 'p90-solo', project: 'app' },
      { type: 'spec-orphan-group', items: [{ type: 'spec-orphan', specFolder: 'p91-a', project: 'app' }] },
    ],
  });
  assert.strictEqual(carried.jira.drift.length, 1, 'drift survives');
  assert.deepStrictEqual(carried.jira.epics['PROJ-10'], { status: 'In Progress' });
  assert.strictEqual(carried.specs.epics['PROJ-10'].stage, 'done', 'a GO verdict stays done');
  assert.strictEqual(carried.specs.epics['PROJ-11'].stage, 'draft', 'partial maps back to draft');
  assert.strictEqual(carried.specs.epics['PROJ-12'], undefined, 'no folder => nothing to carry');
  assert.deepStrictEqual(carried.specs.specOrphans.map((o) => o.specFolder), ['p90-solo', 'p91-a'],
    'orphans are recovered from attention, INCLUDING the ones folded inside a group');
});

// ---- Q2 resilience: keys git knows about that Jira does not ---------------------------------------------------

test('a key git knows but Jira does not 400s the WHOLE key-in clause — the offenders are dropped and retried', async () => {
  // Verified against a live instance: PROJ-75 and PROJ-76 appear in real branch names
  // and are 404 in Jira. Before this retry, their presence took all of Q2 down permanently, which
  // silently disabled the Jira-Done drift direction on the real repo set.
  const stub = jiraStub((jql) => {
    if (!/^key in/.test(jql)) return [];
    if (/PROJ-75/.test(jql) || /PROJ-76/.test(jql)) {
      return { httpStatus: 400, body: { errorMessages: ["An issue with key 'PROJ-75' does not exist for field 'key'.", "An issue with key 'PROJ-76' does not exist for field 'key'."] } };
    }
    return [issue('PROJ-9', 'Done', 'done')];
  });
  const r = await run({
    fragments: { git: gitFrag([
      branch({ name: 'f/PROJ-9', epic: 'PROJ-9', unpushed: 4, mergedIntoDevelop: false, lastCommitAt: daysAgo(1) }),
      branch({ name: 'f/PROJ-75', epic: 'PROJ-75' }),
      branch({ name: 'f/PROJ-76', epic: 'PROJ-76' }),
    ]) },
    fetchImpl: stub,
  });
  assert.strictEqual(r.source.status, 'ok', 'the scan survives');
  assert.match(r.warnings.join(' '), /PROJ-75, PROJ-76/);
  assert.match(r.warnings.join(' '), /do not exist in Jira and were dropped/);
  assert.strictEqual(r.fragment.drift.length, 1, 'and the drift direction Q2 exists for still fires');
  assert.strictEqual(r.fragment.drift[0].epic, 'PROJ-9');
});

test('missingKeysFromErrors parses every offender Jira names, not just the first', () => {
  const { missingKeysFromErrors } = require('../radar/mod-jira');
  assert.deepStrictEqual(
    missingKeysFromErrors(["An issue with key 'PROJ-75' does not exist for field 'key'.", "An issue with key 'PROJ-76' does not exist for field 'key'."]),
    ['PROJ-75', 'PROJ-76'],
  );
  assert.deepStrictEqual(missingKeysFromErrors(['something else entirely']), []);
});

test('Q2 failing is NOT fatal — Q1 still publishes, and the source says which capability was lost', async () => {
  const stub = jiraStub((jql) => (/^key in/.test(jql)
    ? { httpStatus: 400, body: { errorMessages: ['JQL is malformed for reasons we cannot parse'] } }
    : [issue('PROJ-10', 'In Progress', 'indeterminate')]));
  const r = await run({ fragments: { git: gitFrag([branch({ epic: 'PROJ-1' })]) }, fetchImpl: stub });
  assert.strictEqual(r.source.status, 'stale', 'degraded, not dead');
  assert.match(r.source.error, /Jira-Done drift is undetectable this scan/);
  assert.ok(r.fragment, 'Q1 truth is still published');
  assert.strictEqual(r.fragment.epics['PROJ-10'].statusCategory, 'indeterminate');
});

test('Q1 failing IS fatal — a partial epic set is indistinguishable from "those epics closed"', async () => {
  const r = await run({ fetchImpl: jiraStub((jql) => (/statusCategory/.test(jql) ? { httpStatus: 500, body: {} } : [])) });
  assert.strictEqual(r.source.status, 'error');
  assert.strictEqual(r.fragment, null);
});

// ---- config ------------------------------------------------------------------------------------------------

test('no jira block in the config is `disabled`, not an error', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-jira-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  await store.writeJsonAtomic(cfgPath, { configVersion: 1, repos: [] });
  const r = await collectJira({ now: NOW, paths: { config: cfgPath }, env: {}, fragments: {} });
  assert.deepStrictEqual(r.source, { status: 'disabled' });
  assert.deepStrictEqual(r.fragment, { epics: {}, drift: [] });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the jira config block takes defaults for base url, token ref and projects', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-jira-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  await store.writeJsonAtomic(cfgPath, { configVersion: 1, jira: {} });
  const { cfg } = await loadJiraConfig(cfgPath);
  // No hardcoded host and no borrowed project keys. An empty block is therefore NOT usable: the
  // module reports a reason and stays disabled rather than guessing another organisation's Jira.
  assert.strictEqual(cfg, null, 'an empty jira block cannot be defaulted into a working config');
  const empty = await loadJiraConfig(cfgPath);
  assert.match(empty.error, /projects is empty/);

  // projects present but no host -> still refused, with a different stated reason
  await store.writeJsonAtomic(cfgPath, { configVersion: 1, jira: { projects: ['ABC'] } });
  const noHost = await loadJiraConfig(cfgPath);
  assert.strictEqual(noHost.cfg, null);
  assert.match(noHost.error, /baseUrl is not set/);

  await store.writeJsonAtomic(cfgPath, { configVersion: 1, jira: { baseUrl: 'https://j.example/', projects: ['BETA'] } });
  const custom = await loadJiraConfig(cfgPath);
  assert.strictEqual(custom.cfg.baseUrl, 'https://j.example', 'trailing slash trimmed');
  assert.deepStrictEqual(custom.cfg.projects, ['BETA']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('gitSignalsFor ignores default branches and other epics', () => {
  const s = gitSignalsFor('PROJ-1', gitFrag([
    branch({ name: 'develop', epic: null, isDefault: true, unpushed: 99 }),
    branch({ name: 'feature/PROJ-1-a', epic: 'PROJ-1', unpushed: 2, lastCommitAt: daysAgo(5) }),
    branch({ name: 'feature/PROJ-1-b', epic: 'PROJ-1', unpushed: 3, mergedIntoDevelop: false, lastCommitAt: daysAgo(1) }),
    branch({ name: 'feature/PROJ-2-c', epic: 'PROJ-2', unpushed: 50 }),
  ]));
  assert.deepStrictEqual(s, { branches: 2, unpushed: 5, unmerged: 1, newestCommitAt: daysAgo(1) });
});

test('keysJql quotes nothing and orders deterministically', () => {
  assert.strictEqual(keysJql(['PROJ-1', 'BETA-2']), 'key in (PROJ-1,BETA-2) ORDER BY key');
});

test('searchAll asks the REST v2 search endpoint with a Bearer header', async () => {
  let seen = null;
  const impl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ total: 0, issues: [] }) }; };
  await searchAll('project = PROJ', { baseUrl: 'https://j.example', token: 'secret-value', tokenRef: 'JT', timeoutMs: 1000, fetchImpl: impl });
  assert.ok(seen.url.startsWith('https://j.example/rest/api/2/search?jql='));
  assert.match(seen.url, /fields=summary,status,project,updated/);
  assert.strictEqual(seen.init.headers.authorization, 'Bearer secret-value');
  assert.ok(!seen.url.includes('secret-value'), 'the token is a header, never a URL');
});
