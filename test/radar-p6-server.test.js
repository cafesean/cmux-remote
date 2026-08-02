'use strict';
// p6 — the server half of S-006 (the five HTTP routes, viewer refusal, the role overlay) and S-009's
// derivation rules (suppression AFTER every p5 count, the vacuous-`every` trap, handoffsLive).
//
// radar/handoff.js is a CONCURRENT deliverable and is stubbed here through createRadar's
// `createHandoff` seam, exactly as the collector is stubbed through `createCollector`: what this
// file proves is the ROUTE layer's contract — dispatch, auth inheritance, body caps, viewer refusal,
// envelope relay — which must hold whatever the protocol module answers.
//
// Three claims are the load-bearing ones, each measured against the real code before this story:
//   1. counts.mergeable is computed FROM attention (derive.js), so suppression must run after every
//      p5 count or a live handoff silently changes a shipped number (spec §6.6).
//   2. "removed iff EVERY contributed key is covered" is vacuously true of an item contributing
//      NONE — a naive build hides every blocked prompt the moment any handoff goes live (§9 trap 20).
//   3. state.role does not exist in p5 and proxyStateFromLeader returns the leader's snapshot
//      unchanged — so the viewer overlay is a CODE change, proven here on both machines (spec §3).
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRadar, BODY_CAP } = require('../radar-server');
const { validate } = require('../radar/schema-lite');
const stateSchema = require('../radar/state.schema.json');
const { derive } = require('../radar/derive');
const fullFixture = require('../radar/fixtures/state.full.json');
const { bootServer, call } = require('./helpers/server-boot');

const P6_ROUTES = [
  { method: 'POST', path: '/api/radar/handoff/preview', fn: 'preview' },
  { method: 'POST', path: '/api/radar/handoff', fn: 'commit' },
  { method: 'POST', path: '/api/radar/recovery/adopt', fn: 'adopt' },
  { method: 'POST', path: '/api/radar/recovery/discard', fn: 'discard' },
  { method: 'GET', path: '/api/radar/handoff/h-20260801-0001-abcdef', fn: 'get' },
];

// ---- harness -------------------------------------------------------------------------------------

function stubCollector(over) {
  const base = {
    paths: { dir: '/tmp/stub-radar' },
    getState: async () => fullFixture,
    scan: async () => ({ ok: true, published: true, warnings: [], error: null, durationMs: 1, state: fullFixture }),
    start: () => {}, stop: () => {}, isScanning: () => false,
  };
  return Object.assign(base, over || {});
}

// A stand-in for radar/handoff.js's createHandoff: records every call, answers whatever the test
// wired in. `factoryCalls` is how the viewer tests assert the module was never even constructed.
function stubHandoff(answers) {
  const calls = [];
  const factoryCalls = [];
  const a = Object.assign({
    preview: { status: 200, body: { v: 1, plan: { previewId: 'p-1' }, hash: 'f'.repeat(64) } },
    commit: { status: 201, body: { handoffId: 'h-1', status: 'active', sessionId: 'u-1', transcriptPath: '/t.jsonl', logPath: '/l.log', factKeys: ['orphan:r:b'] } },
    adopt: { status: 200, body: {} },
    discard: { status: 200, body: {} },
    get: { status: 200, body: { id: 'h-1', status: 'active' } },
  }, answers || {});
  const impl = {};
  for (const fn of ['preview', 'commit', 'adopt', 'discard', 'get']) {
    impl[fn] = async (arg) => { calls.push({ fn, arg }); return a[fn]; };
  }
  return {
    calls,
    factoryCalls,
    factory: (deps) => { factoryCalls.push(deps); return impl; },
  };
}

async function mount(collector, over) {
  const radar = createRadar(Object.assign({ createCollector: () => collector, scanOnStart: false, log: () => {} }, over || {}));
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/radar/')) {
      try { return await radar.handle(req, res, u); } catch (e) {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"radar_error"}'); }
        return res.end();
      }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { radar, base, close: () => new Promise((r) => srv.close(r)) };
}

async function viewerMount(handoffStub) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p6-viewer-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'viewer',
    leaderBaseUrl: 'http://leader.invalid:8080', leaderTokenRef: 'LEADER_TOK', repos: [],
  }));
  const c = stubCollector({ paths: { dir, config: path.join(dir, 'config.json') } });
  const m = await mount(c, { createHandoff: handoffStub.factory, env: { LEADER_TOK: 'leader-secret' } });
  return { m, cleanup: async () => { await m.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

// ---- the five routes (spec §7.1) ----------------------------------------------------------------

test('the five p6 routes dispatch to the protocol module and relay {status, body} VERBATIM', async () => {
  const h = stubHandoff();
  const m = await mount(stubCollector(), { createHandoff: h.factory });
  try {
    const pv = await call(m.base, 'POST', '/api/radar/handoff/preview', { body: { selectors: ['PROJ-1'] } });
    assert.strictEqual(pv.status, 200);
    assert.deepStrictEqual(pv.json, { v: 1, plan: { previewId: 'p-1' }, hash: 'f'.repeat(64) });
    assert.deepStrictEqual(h.calls[0], { fn: 'preview', arg: { selectors: ['PROJ-1'] } });

    const cm = await call(m.base, 'POST', '/api/radar/handoff', { body: { previewId: 'p-1', hash: 'f'.repeat(64), idempotencyKey: 'k1' } });
    assert.strictEqual(cm.status, 201);
    assert.strictEqual(cm.json.handoffId, 'h-1');
    assert.deepStrictEqual(h.calls[1].arg, { previewId: 'p-1', hash: 'f'.repeat(64), idempotencyKey: 'k1' });

    const ad = await call(m.base, 'POST', '/api/radar/recovery/adopt', { body: { token: 'a'.repeat(64) } });
    assert.strictEqual(ad.status, 200);
    assert.deepStrictEqual(ad.json, {});
    assert.deepStrictEqual(h.calls[2], { fn: 'adopt', arg: { token: 'a'.repeat(64) } });

    const di = await call(m.base, 'POST', '/api/radar/recovery/discard', { body: { token: 'b'.repeat(64) } });
    assert.strictEqual(di.status, 200);
    assert.deepStrictEqual(h.calls[3], { fn: 'discard', arg: { token: 'b'.repeat(64) } });

    const gt = await call(m.base, 'GET', '/api/radar/handoff/h-20260801-0001-abcdef');
    assert.strictEqual(gt.status, 200);
    assert.deepStrictEqual(h.calls[4], { fn: 'get', arg: 'h-20260801-0001-abcdef' });
  } finally { await m.close(); }
});

test('an error envelope from the protocol module is relayed byte-for-byte — no reshaping layer', async () => {
  const h = stubHandoff({
    preview: { status: 422, body: { error: 'selector_unresolved', message: 'a selector resolved to nothing', incidentId: '9e0f1a2b-0000-4000-8000-000000000001' } },
    get: { status: 404, body: { error: 'handoff_not_found', message: 'no handoff has that id' } },
  });
  const m = await mount(stubCollector(), { createHandoff: h.factory });
  try {
    const pv = await call(m.base, 'POST', '/api/radar/handoff/preview', { body: { selectors: ['nope'] } });
    assert.strictEqual(pv.status, 422);
    assert.deepStrictEqual(Object.keys(pv.json).sort(), ['error', 'incidentId', 'message'],
      'one code, one sentence, one incidentId — never an array of selectors (spec §7.3)');

    const gt = await call(m.base, 'GET', '/api/radar/handoff/h-nope');
    assert.strictEqual(gt.status, 404);
    assert.deepStrictEqual(gt.json, { error: 'handoff_not_found', message: 'no handoff has that id' });
  } finally { await m.close(); }
});

test('GET /api/radar/handoff/:id percent-decodes the id; POST there is not a route', async () => {
  const h = stubHandoff();
  const m = await mount(stubCollector(), { createHandoff: h.factory });
  try {
    await call(m.base, 'GET', '/api/radar/handoff/h%2D1');
    assert.deepStrictEqual(h.calls[0], { fn: 'get', arg: 'h-1' });
    const post = await call(m.base, 'POST', '/api/radar/handoff/h-1', { body: {} });
    assert.strictEqual(post.status, 404, 'there is no POST :id route and no collection route');
  } finally { await m.close(); }
});

// ---- body handling (spec §7.1 steps 1–2 live in the route layer) --------------------------------

test('p6 bodies: >16 KiB is 413 body_too_large and bad JSON is 400 bad_json — both BEFORE the protocol module, both carrying `message`', async () => {
  const h = stubHandoff();
  const m = await mount(stubCollector(), { createHandoff: h.factory });
  try {
    const big = await call(m.base, 'POST', '/api/radar/handoff/preview', { body: JSON.stringify({ pad: 'x'.repeat(BODY_CAP + 1) }) });
    assert.strictEqual(big.status, 413);
    assert.strictEqual(big.json.error, 'body_too_large');
    assert.ok(typeof big.json.message === 'string' && big.json.message.length > 0);

    const bad = await call(m.base, 'POST', '/api/radar/handoff', { body: '{nope' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'bad_json');
    assert.ok(typeof bad.json.message === 'string' && bad.json.message.length > 0,
      'every p6 error body carries error AND message; only the two inherited 401s may omit it (spec §7.1)');

    assert.strictEqual(h.calls.length, 0, 'a refused body never reaches the protocol module');
  } finally { await m.close(); }
});

test('a token in the query string is 401 token_in_url on every p6 route, and the protocol module is never consulted', async () => {
  const h = stubHandoff();
  const m = await mount(stubCollector(), { createHandoff: h.factory });
  try {
    for (const r of P6_ROUTES) {
      const res = await call(m.base, r.method, `${r.path}?token=sekret`, r.method === 'POST' ? { body: {} } : undefined);
      assert.strictEqual(res.status, 401, `${r.path} must refuse ?token=`);
      assert.deepStrictEqual(res.json, { error: 'token_in_url' }, 'one of the two inherited envelopes that carry no message — do not "fix" it');
    }
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(h.factoryCalls.length, 0);
  } finally { await m.close(); }
});

// ---- auth inheritance, proven on the REAL shipped server (spec §7.1) ----------------------------

test('the five routes inherit authed(): no bearer is the inherited {error:"unauthorized"} envelope, with no message', async () => {
  const srv = await bootServer({ env: { SERVER_TOKEN: 'p6-secret', RADAR_ENABLED: '1' } });
  try {
    for (const r of P6_ROUTES) {
      const res = await call(srv.base, r.method, r.path, r.method === 'POST' ? { body: {} } : undefined);
      assert.strictEqual(res.status, 401, `${r.path} must be behind authed()`);
      assert.deepStrictEqual(res.json, { error: 'unauthorized' },
        'server.js:231\'s envelope verbatim — the second stated exception to the message rule');
    }
    // and with a valid bearer, radar's own token-in-url rule still applies on top
    const q = await call(srv.base, 'POST', '/api/radar/handoff/preview?token=p6-secret', { token: 'p6-secret', body: {} });
    assert.strictEqual(q.status, 401);
    assert.deepStrictEqual(q.json, { error: 'token_in_url' });
  } finally { await srv.stop(); }
});

// ---- viewer refusal (spec §3) --------------------------------------------------------------------

test('on a viewer EVERY p6 route answers 409 viewer_readonly {leaderBaseUrl} and the protocol module is never constructed', async () => {
  const h = stubHandoff();
  const v = await viewerMount(h);
  try {
    for (const r of P6_ROUTES) {
      const res = await call(v.m.base, r.method, r.path, r.method === 'POST' ? { body: {} } : undefined);
      assert.strictEqual(res.status, 409, `${r.path} must refuse on a viewer`);
      assert.strictEqual(res.json.error, 'viewer_readonly');
      assert.strictEqual(res.json.leaderBaseUrl, 'http://leader.invalid:8080');
      assert.ok(typeof res.json.message === 'string' && res.json.message.length > 0);
    }
    assert.strictEqual(h.factoryCalls.length, 0, 'refusal happens before radar/handoff.js is even required — zero side effects');
    assert.strictEqual(h.calls.length, 0);
  } finally { await v.cleanup(); }
});

// ---- the role overlay (spec §3, MEASURED gap: p5's proxy returned the snapshot unchanged) --------

test('two servers, one snapshot: the leader publishes role "leader"; the viewer\'s own proxy rewrites it to "viewer" and nothing else', async () => {
  // the leader: its own snapshot, verbatim
  const leader = await mount(stubCollector({ getState: async () => fullFixture }));
  // the viewer: proxies that same snapshot and overlays role on the response
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p6-overlay-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'viewer', leaderBaseUrl: 'http://leader.invalid:8080', repos: [],
  }));
  const viewer = await mount(
    stubCollector({ paths: { dir, config: path.join(dir, 'config.json') } }),
    { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(fullFixture) }) },
  );
  try {
    const l = await call(leader.base, 'GET', '/api/radar/state');
    assert.strictEqual(l.status, 200);
    assert.strictEqual(l.json.role, 'leader', 'derive() publishes role from config.role — the fixture carries the leader\'s own answer');

    const v = await call(viewer.base, 'GET', '/api/radar/state');
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.json.role, 'viewer', 'without the rewrite a viewer reports "leader" — the wrong answer on the one machine that needs the right one');
    assert.deepStrictEqual(Object.assign({}, v.json, { role: l.json.role }), l.json,
      'role is the ONLY field the proxy rewrites; every other field is byte-identical');
  } finally {
    await leader.close();
    await viewer.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---- derive: the four §4.6 additions -------------------------------------------------------------

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const SOURCES_OK = {
  git: { status: 'ok', observedAt: new Date(NOW).toISOString() },
  sessions: { status: 'disabled' },
  deploy: { status: 'disabled' },
  jira: { status: 'disabled' },
  specs: { status: 'disabled' },
  config: { status: 'ok' },
};

const branch = (o) => Object.assign({
  name: 'feature/PROJ-1-thing', sha: 'sha1', epic: 'PROJ-1', epicVia: 'issue-key', isDefault: false,
  unpushed: 0, noRemote: false, mergedIntoDevelop: true, mergedIntoMain: false,
  lastCommitAt: daysAgo(90), worktree: null,
}, o);

const worktree = (o) => Object.assign({
  path: '/wt/a', branch: 'feature/PROJ-1-thing', head: 'sha1', isMain: false, bare: false, locked: false,
  prunable: false, dirty: { staged: 0, unstaged: 0, untracked: 0 }, dirtyError: null,
  stale: false, staleReason: null, cleanupCommand: null,
}, o);

function build(o) {
  o = o || {};
  const repos = {};
  const src = o.repos || { r1: { branches: [branch()] } };
  for (const id of Object.keys(src)) {
    repos[id] = {
      path: `/repos/${id}`, defaultBranches: { develop: 'd', main: 'm' },
      branches: src[id].branches || [], worktrees: src[id].worktrees || [], deploy: null,
      fetch: { status: 'ok', error: null },
    };
  }
  return derive({
    now: NOW,
    collectorId: 'test-machine',
    config: o.config || { repos: [] },
    sources: Object.assign({}, SOURCES_OK, o.sources || {}),
    aliases: {},
    decisions: o.decisions || [],
    handoffs: o.handoffs,
    handoffRecovery: o.handoffRecovery,
    fragments: {
      git: { repos },
      sessions: { sessions: o.sessions || [], machines: null },
      specs: o.specs || { specOrphans: [], epics: {} },
      jira: { epics: {}, drift: [] },
    },
  });
}

const liveHandoff = (factKeys, id) => ({
  id: id || 'h-20260801-0001-aaaaaa', status: 'active',
  selectors: ['epic:PROJ-1'], factKeys,
  session: { machine: 'test-machine', sessionId: '2b6c0d1e-0000-4000-8000-000000000001' },
});

test('derive publishes the four §4.6 fields with their REQUIRED empty values when no handoff exists, and the result is schema-valid', () => {
  const state = build({});
  assert.deepStrictEqual(state.handoffs, []);
  assert.strictEqual(state.handoffRecovery, null, 'null, not undefined — the UI predicate is `!== null` and an omitted key satisfies it');
  assert.strictEqual(state.counts.handoffsLive, 0);
  assert.strictEqual(state.role, 'leader');
  const v = validate(stateSchema, state);
  assert.deepStrictEqual(v.errors, []);
});

test('derive publishes role from config.role — "viewer" when the config says so, "leader" for anything else', () => {
  assert.strictEqual(build({ config: { role: 'viewer', repos: [] } }).role, 'viewer');
  assert.strictEqual(build({ config: { role: 'leader', repos: [] } }).role, 'leader');
  assert.strictEqual(build({ config: { repos: [] } }).role, 'leader');
});

test('handoffs[] and handoffRecovery pass through, counts.handoffsLive equals handoffs.length, and the schema accepts them', () => {
  const rec = { token: 'c'.repeat(64), since: daysAgo(1) };
  const state = build({
    handoffs: [liveHandoff(['branch:r1:feature/PROJ-1-thing:unpushed']), liveHandoff(['orphan:r1:x'], 'h-20260801-0002-bbbbbb')],
    handoffRecovery: rec,
  });
  assert.strictEqual(state.counts.handoffsLive, 2);
  assert.deepStrictEqual(state.handoffRecovery, rec);
  const v = validate(stateSchema, state);
  assert.deepStrictEqual(v.errors, []);
});

test('the schema REQUIRES all four additions and still refuses an unknown sibling', () => {
  const base = build({});
  const drop = (k) => { const c = JSON.parse(JSON.stringify(base)); delete c[k]; return validate(stateSchema, c); };
  assert.strictEqual(drop('handoffs').valid, false);
  assert.strictEqual(drop('handoffRecovery').valid, false, 'omitted satisfies `!== null` (undefined !== null) — required-ness removes the case instead of testing for it');
  assert.strictEqual(drop('role').valid, false);
  const noCount = JSON.parse(JSON.stringify(base));
  delete noCount.counts.handoffsLive;
  assert.strictEqual(validate(stateSchema, noCount).valid, false);
  const extra = JSON.parse(JSON.stringify(base));
  extra.handoffQueue = [];
  assert.strictEqual(validate(stateSchema, extra).valid, false, 'additionalProperties:false still holds at the top level');
  // handoffs[] carries ONLY the live set — a terminal status is a schema violation, not a row
  const terminal = JSON.parse(JSON.stringify(base));
  terminal.handoffs = [Object.assign(liveHandoff(['orphan:r:b']), { status: 'resolved' })];
  assert.strictEqual(validate(stateSchema, terminal).valid, false);
});

// ---- derive: suppression (spec §6.6) -------------------------------------------------------------

// A board with one mergeable epic (every branch pushed, none merged), one orphan, and one blocked
// session. PROJ-1's complete fact-key set is the two unmerged-develop keys.
const MERGEABLE_WORLD = {
  repos: {
    r1: {
      branches: [
        branch({ name: 'feature/PROJ-1-a', unpushed: 0, mergedIntoDevelop: false, mergedIntoMain: null }),
        branch({ name: 'feature/PROJ-1-b', unpushed: 0, mergedIntoDevelop: false, mergedIntoMain: null }),
        branch({ name: 'stray', epic: null, epicVia: 'orphan', unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null }),
      ],
    },
  },
  sessions: [{ key: { machine: 'm', sessionId: 's1' }, status: 'blocked', epic: 'PROJ-1', surface: null, notificationType: null, cacheExpiresAt: null }],
  sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
};
// §6.1 encodes exactly two characters — % and : — so a branch slash stays literal in the key.
const PROJ1_KEYS = [
  'branch:r1:feature/PROJ-1-a:unmerged-develop',
  'branch:r1:feature/PROJ-1-b:unmerged-develop',
];

test('SUPPRESSION RUNS AFTER EVERY p5 COUNT: counts.mergeable is byte-identical with and without a live handoff, while the item leaves attention[]', () => {
  const before = build(MERGEABLE_WORLD);
  assert.strictEqual(before.counts.mergeable, 1);
  assert.ok(before.attention.some((a) => a.type === 'mergeable' && a.epic === 'PROJ-1'));

  const during = build(Object.assign({}, MERGEABLE_WORLD, { handoffs: [liveHandoff(PROJ1_KEYS)] }));
  // counts.mergeable is computed from attention itself (radar/derive.js) — suppressing first would
  // silently change a shipped p5 count, which p6 must never do (spec §6.6, measured).
  assert.deepStrictEqual(
    Object.assign({}, during.counts, { handoffsLive: 0 }),
    Object.assign({}, before.counts, { handoffsLive: 0 }),
    'every p5 count is identical during suppression; handoffsLive is the only count p6 adds');
  assert.strictEqual(during.counts.handoffsLive, 1);
  assert.ok(!during.attention.some((a) => a.type === 'mergeable'), 'the covered item IS removed from the published attention[]');
});

test('an item is suppressed iff it contributes >= 1 key and EVERY one is covered — one uncovered key keeps the row', () => {
  const partial = build(Object.assign({}, MERGEABLE_WORLD, { handoffs: [liveHandoff([PROJ1_KEYS[0]])] }));
  assert.ok(partial.attention.some((a) => a.type === 'mergeable' && a.epic === 'PROJ-1'),
    'one of the two keys is uncovered, so the item stays');
});

test('THE VACUOUS-EVERY TRAP (§9 trap 20): a handoff covering every key on the board hides NO zero-key item', () => {
  const world = {
    repos: MERGEABLE_WORLD.repos,
    sessions: [
      { key: { machine: 'm', sessionId: 's1' }, status: 'blocked', epic: 'PROJ-1', surface: null, notificationType: null, cacheExpiresAt: null },
      // a second blocked session whose window closed -> blocked-stale
      { key: { machine: 'm', sessionId: 's2' }, status: 'blocked', epic: null, surface: null, notificationType: null, cacheExpiresAt: daysAgo(1) },
    ],
    sources: { sessions: { status: 'ok', observedAt: new Date(NOW).toISOString() } },
    decisions: [{ id: 'd1', title: 'decide something', since: daysAgo(2), epic: null, closedAt: null }],
    specs: { specOrphans: [{ specFolder: 'p9-thing', project: 'x' }], epics: {} },
  };
  const before = build(world);
  // cover EVERY fact key any item on this board contributes (the orphan's + the epic's)
  const everyKey = PROJ1_KEYS.concat(['orphan:r1:stray']);
  const during = build(Object.assign({}, world, { handoffs: [liveHandoff(everyKey)] }));

  for (const type of ['blocked', 'blocked-stale', 'decision', 'spec-orphan']) {
    assert.strictEqual(
      during.attention.filter((a) => a.type === type).length,
      before.attention.filter((a) => a.type === type).length,
      `${type} contributes zero fact keys and must NEVER be suppressed — "every key covered" is vacuously true of it`);
  }
  assert.ok(!during.attention.some((a) => a.type === 'mergeable'), 'the key-contributing items did leave');
  assert.ok(!during.attention.some((a) => a.type === 'orphan'));
});

test('a folded orphan-group loses exactly its covered members; below the group minimum the survivors return as loose rows; empty disappears', () => {
  const world = {
    repos: {
      r1: {
        branches: [
          branch({ name: 'a', epic: null, epicVia: 'orphan', unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null }),
          branch({ name: 'b', epic: null, epicVia: 'orphan', unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null }),
          branch({ name: 'c', epic: null, epicVia: 'orphan', unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null }),
        ],
      },
    },
  };
  const before = build(world);
  const group = before.attention.find((a) => a.type === 'orphan-group');
  assert.ok(group && group.count === 3, 'the fixture folds three orphans into one group');

  const oneCovered = build(Object.assign({}, world, { handoffs: [liveHandoff(['orphan:r1:a'])] }));
  const g1 = oneCovered.attention.find((a) => a.type === 'orphan-group');
  assert.ok(g1, 'two members remain -> still a group');
  assert.strictEqual(g1.count, 2);
  assert.deepStrictEqual(g1.items.map((m) => m.branch).sort(), ['b', 'c'], 'the remaining members stay reachable');

  const twoCovered = build(Object.assign({}, world, { handoffs: [liveHandoff(['orphan:r1:a', 'orphan:r1:b'])] }));
  assert.ok(!twoCovered.attention.some((a) => a.type === 'orphan-group'), 'a group of one is barred by the schema');
  assert.deepStrictEqual(twoCovered.attention.filter((a) => a.type === 'orphan').map((m) => m.branch), ['c'],
    'the lone survivor returns as a loose row');
  assert.deepStrictEqual(validate(stateSchema, twoCovered).errors, []);

  const allCovered = build(Object.assign({}, world, { handoffs: [liveHandoff(['orphan:r1:a', 'orphan:r1:b', 'orphan:r1:c'])] }));
  assert.ok(!allCovered.attention.some((a) => a.type === 'orphan' || a.type === 'orphan-group'));
  // counts are computed from the SOURCE lists, before suppression — the fold and the cover change nothing
  assert.strictEqual(allCovered.counts.orphans, 3);
});

test('an orphan FOLDED into a group still resolves as a selector — flattenAttention unfolds derive\'s `items`', () => {
  // Caught by the S-008 evidence run: derive folds >= ORPHAN_GROUP_MIN orphans under `items`, and a
  // flatten that looks for any other key hides every member — the selector then 422s for a row that
  // is plainly on the board (§6.1's trap, hit for real).
  const hk = require('../radar/handoff-keys');
  const state = build({
    repos: {
      r1: {
        branches: [
          branch({ name: 'a', epic: null, epicVia: 'orphan', unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null }),
          branch({ name: 'b', epic: null, epicVia: 'orphan', unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null }),
        ],
      },
    },
  });
  assert.ok(state.attention.some((a) => a.type === 'orphan-group'), 'the fixture folds its orphans');
  assert.deepStrictEqual(hk.keysForSelector(state, 'orphan:r1:a'), ['orphan:r1:a']);
  assert.deepStrictEqual(hk.keysForSelector(state, 'orphans').sort(), ['orphan:r1:a', 'orphan:r1:b'],
    'the `orphans` selector reaches every folded member too');
});

test('suppression ends when the handoff leaves the live set: with handoffs[] empty again, attention[] is deep-equal to the pre-dispatch board', () => {
  const before = build(MERGEABLE_WORLD);
  const after = build(Object.assign({}, MERGEABLE_WORLD, { handoffs: [] }));
  assert.deepStrictEqual(after.attention, before.attention,
    'p5\'s facts decide: no baseline, no snapshot comparison, no state field involved (spec §6.6)');
});
