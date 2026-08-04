'use strict';
// p11 S-003 — the Agile intake, and mostly the isolation between it and the JQL half.
//
// THE LOAD-BEARING TEST HERE is `an Agile outage does not touch sources.jira` (Codex round 1,
// finding 10). The two halves talk to different API families and answer different questions, so an
// Agile 401 must degrade `sources.jiraAgile` alone. Poisoning `sources.jira` would make the p5 epic
// drift detector read as broken while it is working perfectly — a false red costs the same trust as
// a false green, and this is the one place the wiring makes it easy to do by accident.
//
// Synthetic throughout per the public-repo rule: PROJ/ALPHA/BETA, jira.example.
const { test } = require('node:test');
const assert = require('node:assert');
const { collectJira, collectAgile, normalizeAgile, agileIssueToRaw } = require('../radar/mod-jira');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const OBSERVED = new Date(NOW).toISOString();
const CFG = (agile) => ({ baseUrl: 'https://jira.example', tokenRef: 'JT', projects: ['PROJ', 'ALPHA'], agile });
const CTX = (fetchImpl) => ({ baseUrl: 'https://jira.example', token: 't', tokenRef: 'JT', timeoutMs: 1000, fetchImpl });

const board = (id, name, projectKey) => ({ id, name, location: { projectKey } });
const sprint = (id, name, state) => ({ id, name, state, endDate: '2026-08-10T00:00:00.000Z' });
const agileIssue = (key, statusName, categoryKey, typeName) => ({
  key,
  fields: {
    summary: `${key} summary`,
    status: { name: statusName, statusCategory: { key: categoryKey } },
    issuetype: { name: typeName || 'Story' },
    assignee: { name: 'someone' },
    updated: '2026-07-28T00:00:00.000Z',
  },
});

// Routes the Agile paths a scan actually walks. Anything unrouted 404s, so a typo in a path is a
// failed test rather than a silently empty result.
function agileStub(routes, calls) {
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace('/rest/agile/1.0/', '');
    if (calls) calls.push(p + (u.search || ''));
    for (const [re, val] of routes) {
      if (re.test(p)) {
        if (val && val.httpStatus) return { ok: false, status: val.httpStatus, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ values: val, isLast: true }) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('normalizeAgile: OFF by default, and bounded', () => {
  assert.deepStrictEqual(normalizeAgile(undefined), { enabled: false, maxIssuesPerScan: 500 });
  assert.deepStrictEqual(normalizeAgile({ enabled: true }), { enabled: true, maxIssuesPerScan: 500 });
  assert.strictEqual(normalizeAgile({ enabled: true, maxIssuesPerScan: 0 }).maxIssuesPerScan, 1);
  assert.strictEqual(normalizeAgile({ enabled: true, maxIssuesPerScan: 99999 }).maxIssuesPerScan, 5000);
  assert.strictEqual(normalizeAgile({ enabled: 'true' }).enabled, false, 'strings do not enable it');
});

test('disabled: no HTTP call is made at all', async () => {
  let called = 0;
  const r = await collectAgile(CFG({ enabled: false, maxIssuesPerScan: 500 }), CTX(async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; }), OBSERVED);
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(r.source, { status: 'disabled' });
  assert.deepStrictEqual(r.items, []);
});

test('success: boards, sprints and issues each become a WorkRef input', async () => {
  const calls = [];
  const impl = agileStub([
    [/^board$/, [board(1, 'PROJ board', 'PROJ')]],
    [/^board\/1\/sprint/, [sprint(30, 'Sprint 3', 'active')]],
    [/^board\/1\/issue/, [agileIssue('PROJ-108', 'In Progress', 'indeterminate', 'Epic'), agileIssue('PROJ-9', 'To Do', 'new')]],
  ], calls);

  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.strictEqual(r.source.status, 'ok');
  const kinds = r.items.map((i) => i.kind).sort();
  assert.deepStrictEqual(kinds, ['board', 'epic', 'issue', 'sprint']);

  const epic = r.items.find((i) => i.kind === 'epic');
  assert.strictEqual(epic.sourceId, 'PROJ-108');
  assert.strictEqual(epic.nativeCategory, 'indeterminate');
  assert.strictEqual(epic.nativeStatus, 'In Progress');
  assert.strictEqual(epic.epicKey, 'PROJ-108', 'an epic is its own cluster');
  assert.strictEqual(epic.sourceUrl, 'https://jira.example/browse/PROJ-108');
  assert.ok(epic.sprint && epic.sprint.urn === 'urn:work:jira-sprint:30', 'the active sprint travels with the issue');
});

test('mapping is by statusCategory only — an unknown category is nulled, never coerced', () => {
  const raw = agileIssueToRaw(agileIssue('PROJ-1', 'Sideways', 'sideways'), null, null, 'https://jira.example');
  assert.strictEqual(raw.nativeCategory, null);
  assert.strictEqual(raw.nativeStatus, 'Sideways', 'the display name is still the source\'s word');
});

test('scope: a board belonging to an out-of-config project is not walked', async () => {
  const calls = [];
  const impl = agileStub([
    [/^board$/, [board(1, 'PROJ board', 'PROJ'), board(2, 'OTHER board', 'OTHER')]],
    [/^board\/1\/sprint/, []], [/^board\/1\/issue/, []],
    [/^board\/2\/sprint/, []], [/^board\/2\/issue/, []],
  ], calls);
  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.deepStrictEqual(r.items.map((i) => i.sourceId), ['1']);
  assert.ok(!calls.some((c) => c.startsWith('board/2/')), 'the out-of-scope board is never fetched');
});

test('budget: the cap truncates and REPORTS pending — truncation is never silent', async () => {
  const many = Array.from({ length: 10 }, (_, i) => agileIssue(`PROJ-${i}`, 'To Do', 'new'));
  const impl = agileStub([
    [/^board$/, [board(1, 'PROJ board', 'PROJ')]],
    [/^board\/1\/sprint/, []],
    [/^board\/1\/issue/, many],
  ]);
  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 3 }), CTX(impl), OBSERVED);
  const issues = r.items.filter((i) => i.kind === 'issue');
  assert.strictEqual(issues.length, 3);
  assert.ok(r.pending > 0, 'the remainder must be reported');
  assert.ok(r.source.pending > 0);
});

test('a board with no sprint support degrades that board only', async () => {
  const impl = agileStub([
    [/^board$/, [board(1, 'PROJ board', 'PROJ')]],
    [/^board\/1\/sprint/, { httpStatus: 400 }],
    [/^board\/1\/issue/, [agileIssue('PROJ-5', 'To Do', 'new')]],
  ]);
  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.strictEqual(r.source.status, 'ok');
  assert.ok(r.items.some((i) => i.kind === 'issue'), 'issues still collected');
  assert.ok(!r.items.some((i) => i.kind === 'sprint'), 'no sprint WorkRefs, and no crash');
});

test('auth failure on the board list degrades jiraAgile with a stated reason', async () => {
  const impl = agileStub([[/^board$/, { httpStatus: 401 }]]);
  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.strictEqual(r.source.status, 'error');
  assert.match(r.source.error, /401/);
  assert.match(r.source.error, /JT/, 'names the tokenRef, never the token');
  assert.deepStrictEqual(r.items, []);
});

test('a 404 says the Agile API is absent rather than reporting an empty board list', async () => {
  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(async () => ({ ok: false, status: 404, json: async () => ({}) })), OBSERVED);
  assert.strictEqual(r.source.status, 'error');
  assert.match(r.source.error, /not available on this instance/);
});

// ---- THE ISOLATION TEST (Codex finding 10) ------------------------------------------------------

test('finding 10: an Agile outage does NOT touch sources.jira or the Q1/Q2 fragment', async () => {
  // Agile 401s; the JQL half answers normally.
  const impl = async (url) => {
    if (url.includes('/rest/agile/')) return { ok: false, status: 401, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({ issues: [{ key: 'PROJ-108', fields: { summary: 's', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, project: { key: 'PROJ' }, updated: OBSERVED } }], total: 1 }),
    };
  };

  const r = await collectJira({
    now: NOW, jiraConfig: CFG({ enabled: true, maxIssuesPerScan: 500 }), env: { JT: 'token' },
    fragments: { git: { repos: {} } }, aliases: {}, decisions: [], fetchImpl: impl,
  });

  assert.strictEqual(r.source.status, 'ok', 'sources.jira must be untouched by an Agile failure');
  assert.ok(r.fragment && r.fragment.epics && r.fragment.epics['PROJ-108'], 'the Q1 fragment still published');
  assert.strictEqual(r.agile.source.status, 'error', 'the failure lands on jiraAgile alone');
});

test('a Q1 failure does not silently take the Agile intake down with it', async () => {
  const impl = async (url) => {
    if (url.includes('/rest/agile/1.0/board?')) return { ok: true, status: 200, json: async () => ({ values: [board(1, 'PROJ board', 'PROJ')], isLast: true }) };
    if (url.includes('/rest/agile/')) return { ok: true, status: 200, json: async () => ({ values: [], isLast: true }) };
    return { ok: false, status: 500, json: async () => ({ errorMessages: ['boom'] }) };   // the JQL half dies
  };
  const r = await collectJira({
    now: NOW, jiraConfig: CFG({ enabled: true, maxIssuesPerScan: 500 }), env: { JT: 'token' },
    fragments: { git: { repos: {} } }, aliases: {}, decisions: [], fetchImpl: impl,
  });
  assert.strictEqual(r.fragment, null, 'Q1 dying still nulls its own fragment');
  assert.strictEqual(r.source.status, 'error');
  assert.ok(r.agile, 'the agile result travels on the early-return path too');
  assert.strictEqual(r.agile.source.status, 'ok');
  assert.ok(r.agile.items.some((i) => i.kind === 'board'));
});
