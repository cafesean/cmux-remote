'use strict';
// p11 S-003 — the Agile intake, and mostly the isolation between it and the JQL half.
//
// THE LOAD-BEARING TEST HERE is `an Agile outage does not touch sources.jira` (Codex round 1,
// finding 10). The two halves talk to different API families and answer different questions, so an
// Agile 401 must degrade `sources.jiraAgile` alone. Poisoning `sources.jira` would make the p5 epic
// drift detector read as broken while it is working perfectly — a false red costs the same trust as
// a false green, and this is the one place the wiring makes it easy to do by accident.
//
// TWO MORE TESTS ARE LOAD-BEARING FOR THE SAME REASON, both pinning defects that reported `ok` while
// intaking nothing or everything: the issue endpoint's `issues`/`total` envelope (a `values`-only
// reader intakes ZERO issues, silently), and the `projectKeyOrId` board scoping (a client-side
// `location.projectKey` filter scopes NOTHING on Jira Data Center, which sends no location at all).
// Neither was visible from this file until its stub stopped answering `values` to every path.
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
// Jira Data Center answers /board with NO `location` block at all. That shape is why a client-side
// `b.location.projectKey` filter could not scope anything: the arm that lets a location-less board
// through has to let every board through. Scoping is asked of the server instead.
const bareBoard = (id, name) => ({ id, name });
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

// Routes the Agile paths a scan actually walks, ANSWERING WITH THE ENVELOPE EACH REAL ENDPOINT USES:
// /board and /board/{id}/sprint reply `values` + `isLast`; /board/{id}/issue replies `issues` +
// `total` and carries neither of those keys. A stub that answered `values` everywhere is exactly
// what let the zero-issue intake read green — the fixture agreed with the bug, so every assertion
// downstream of it was true and meaningless.
//
// Anything unrouted 404s, so a typo in a path is a failed test rather than a silently empty result.
function agileStub(routes, calls) {
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace('/rest/agile/1.0/', '');
    if (calls) calls.push(p + (u.search || ''));
    for (const [re, val] of routes) {
      if (re.test(p)) {
        if (val && val.httpStatus) return { ok: false, status: val.httpStatus, json: async () => ({}) };
        const body = /\/issue$/.test(p)
          ? { expand: 'schema,names', startAt: Number(u.searchParams.get('startAt')) || 0, maxResults: 50, total: val.length, warningMessages: [], issues: val }
          : { values: val, isLast: true };
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// A fetch built from an explicit path→body map, for the tests that care about the exact envelope or
// the exact request path rather than about a whole scan's shape.
function routeStub(handler, calls) {
  return async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace('/rest/agile/1.0/', '');
    if (calls) calls.push(p + (u.search || ''));
    const body = handler(p, u.searchParams);
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (body && body.httpStatus) return { ok: false, status: body.httpStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
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

// ---- D1: the issue endpoint's envelope -----------------------------------------------------------
//
// /board/{id}/issue answers `issues` + `total` and NEVER `values` — live-probed on a Jira Data
// Center instance (keys: expand,startAt,maxResults,total,issues,warningMessages,names,schema).
// Reading only `values` intook zero issues on every board while `sources.jiraAgile` stayed `ok`:
// a total loss wearing a green badge, which no assertion about boards or sprints could see.

test('D1: rows arrive under `issues` with `total` and no `isLast`, and are intaken', async () => {
  const calls = [];
  const impl = routeStub((p) => {
    if (p === 'board') return { values: [bareBoard(1, 'PROJ board')], isLast: true };
    if (p === 'board/1/sprint') return { values: [sprint(30, 'Sprint 3', 'active')], isLast: true };
    if (p === 'board/1/issue') {
      return {
        expand: 'schema,names', startAt: 0, maxResults: 50, total: 2, warningMessages: [],
        issues: [agileIssue('PROJ-108', 'In Progress', 'indeterminate', 'Epic'), agileIssue('PROJ-9', 'To Do', 'new')],
      };
    }
    return undefined;
  }, calls);

  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.strictEqual(r.source.status, 'ok');
  assert.deepStrictEqual(r.items.map((i) => i.kind).sort(), ['board', 'epic', 'issue', 'sprint']);
  assert.deepStrictEqual(
    r.items.filter((i) => i.kind === 'epic' || i.kind === 'issue').map((i) => i.sourceId).sort(),
    ['PROJ-108', 'PROJ-9'],
  );
  assert.strictEqual(calls.filter((c) => c.startsWith('board/1/issue')).length, 1,
    'startAt >= total ends the loop without an extra page — the issue envelope has no isLast to read');
});

test('D1: a non-zero total with zero rows read degrades the source — a 200 is not rows', async () => {
  // The pre-fix response, verbatim in shape: the server reports 99 issues and the reader extracts
  // none of them. Reporting `ok` here is the exact false-green the guard exists to prevent.
  const impl = routeStub((p) => {
    if (p === 'board') return { values: [bareBoard(1, 'PROJ board')], isLast: true };
    if (p === 'board/1/sprint') return { values: [], isLast: true };
    if (p === 'board/1/issue') return { expand: 'schema,names', startAt: 0, maxResults: 50, total: 99, someFutureEnvelope: [{ key: 'PROJ-1' }] };
    return undefined;
  });

  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.notStrictEqual(r.source.status, 'ok', 'a call that yielded no rows must never report plain ok');
  assert.strictEqual(r.source.status, 'stale');
  assert.match(r.source.error, /99/, 'the count the server claimed is named');
  assert.match(r.source.error, /board 1/);
  assert.ok(!r.items.some((i) => i.kind === 'issue' || i.kind === 'epic'), 'and no phantom rows are invented');
  assert.ok(r.items.some((i) => i.kind === 'board'), 'what WAS read still publishes');
});

test('D1: a total the server never delivers stops on the empty page, not at MAX_AGILE_PAGES', async () => {
  const calls = [];
  const impl = routeStub((p, params) => {
    if (p === 'board') return { values: [bareBoard(1, 'PROJ board')], isLast: true };
    if (p === 'board/1/sprint') return { values: [], isLast: true };
    if (p === 'board/1/issue') {
      const startAt = Number(params.get('startAt')) || 0;
      // Claims 10, delivers 4 and then nothing — the shape that would otherwise spin every scan.
      const issues = startAt === 0 ? [0, 1, 2, 3].map((i) => agileIssue(`PROJ-${i}`, 'To Do', 'new')) : [];
      return { startAt, maxResults: 50, total: 10, issues };
    }
    return undefined;
  }, calls);

  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.strictEqual(calls.filter((c) => c.startsWith('board/1/issue')).length, 2, 'one page of rows, one empty page, stop');
  assert.strictEqual(r.items.filter((i) => i.kind === 'issue').length, 4);
  assert.strictEqual(r.source.status, 'ok', 'rows did arrive; a short total is the server\'s business');
});

// ---- D2: the allowlist has to scope the SERVER's board list ---------------------------------------

test('D2: boards are fetched per configured project, deduped, and never instance-wide', async () => {
  const calls = [];
  const byProject = {
    PROJ: [bareBoard(1, 'PROJ board'), bareBoard(9, 'Shared board')],
    ALPHA: [bareBoard(9, 'Shared board'), bareBoard(2, 'ALPHA board')],
  };
  const impl = routeStub((p, params) => {
    // No `location` anywhere, and an unscoped list would answer with every board on the instance —
    // so if scoping were still client-side, BETA's board would arrive and be intaken.
    if (p === 'board') return { values: byProject[params.get('projectKeyOrId')] || [bareBoard(77, 'BETA board')], isLast: true };
    if (/\/sprint$/.test(p)) return { values: [], isLast: true };
    if (/\/issue$/.test(p)) return { startAt: 0, maxResults: 50, total: 0, issues: [] };
    return undefined;
  }, calls);

  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);

  const boardCalls = calls.filter((c) => c.startsWith('board?'));
  assert.strictEqual(boardCalls.length, 2, 'one board list per configured project');
  assert.ok(boardCalls.every((c) => c.includes('projectKeyOrId=')), 'no unscoped instance-wide list is ever issued');
  assert.ok(boardCalls.some((c) => c.includes('projectKeyOrId=PROJ')));
  assert.ok(boardCalls.some((c) => c.includes('projectKeyOrId=ALPHA')));

  assert.deepStrictEqual(r.items.filter((i) => i.kind === 'board').map((i) => i.sourceId), ['1', '9', '2'],
    'the union of both projects, with the shared board once');
  assert.strictEqual(r.source.boards, 3);
  assert.strictEqual(calls.filter((c) => c.startsWith('board/9/issue')).length, 1,
    'a board shared by two projects is walked once, not once per project');
  assert.ok(!calls.some((c) => c.startsWith('board/77/')), 'a board no configured project owns is never walked');
});

test('D2: with no allowlist configured the board list stays unscoped', async () => {
  const calls = [];
  const impl = routeStub((p) => {
    if (p === 'board') return { values: [bareBoard(5, 'Some board')], isLast: true };
    if (/\/sprint$/.test(p)) return { values: [], isLast: true };
    if (/\/issue$/.test(p)) return { startAt: 0, maxResults: 50, total: 0, issues: [] };
    return undefined;
  }, calls);

  const cfg = { baseUrl: 'https://jira.example', tokenRef: 'JT', agile: { enabled: true, maxIssuesPerScan: 500 } };
  const r = await collectAgile(cfg, CTX(impl), OBSERVED);
  assert.deepStrictEqual(calls.filter((c) => c.startsWith('board?')), ['board?startAt=0&maxResults=50']);
  assert.deepStrictEqual(r.items.filter((i) => i.kind === 'board').map((i) => i.sourceId), ['5']);
  assert.strictEqual(r.source.status, 'ok');
});

test('D2: one project\'s board list failing costs that project only, and says so', async () => {
  const impl = routeStub((p, params) => {
    if (p === 'board') {
      if (params.get('projectKeyOrId') === 'ALPHA') return { httpStatus: 403 };
      return { values: [bareBoard(1, 'PROJ board')], isLast: true };
    }
    if (/\/sprint$/.test(p)) return { values: [], isLast: true };
    if (/\/issue$/.test(p)) return { startAt: 0, maxResults: 50, total: 0, issues: [] };
    return undefined;
  });

  const r = await collectAgile(CFG({ enabled: true, maxIssuesPerScan: 500 }), CTX(impl), OBSERVED);
  assert.strictEqual(r.source.status, 'stale', 'a partial board list is not a healthy scan');
  assert.match(r.source.error, /ALPHA/);
  assert.match(r.source.error, /403/);
  assert.deepStrictEqual(r.items.filter((i) => i.kind === 'board').map((i) => i.sourceId), ['1'],
    'the project that answered is still intaken');
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
