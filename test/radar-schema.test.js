'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { validate } = require('../radar/schema-lite');
const { createCollector } = require('../radar/collector');
const { mapCwd } = require('../radar/mod-sessions');
const { buildFixtureRepo } = require('./helpers/git-fixture');

const schema = require('../radar/state.schema.json');
const FIXTURES = ['state.full.json', 'state.degraded.json', 'state.empty.json'];
const load = (n) => JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'radar', 'fixtures', n), 'utf8'));

let fx = null;
before(async () => { fx = await buildFixtureRepo(); });
after(async () => { if (fx) await fx.cleanup(); });

// ---- the validator itself (it has to be trustworthy before the schema means anything) -----------

test('schema-lite: types, required, enum, const and additionalProperties', () => {
  const s = {
    type: 'object', required: ['a'], additionalProperties: false,
    properties: { a: { type: ['string', 'null'] }, b: { enum: ['x', 'y'] }, c: { const: 1 } },
  };
  assert.strictEqual(validate(s, { a: 'hi' }).valid, true);
  assert.strictEqual(validate(s, { a: null }).valid, true);
  assert.strictEqual(validate(s, {}).valid, false);
  assert.match(validate(s, {}).errors[0], /missing required property "a"/);
  assert.match(validate(s, { a: 'x', z: 1 }).errors[0], /unexpected property "z"/);
  assert.match(validate(s, { a: 'x', b: 'q' }).errors[0], /is not one of/);
  assert.match(validate(s, { a: 'x', c: 2 }).errors[0], /expected const 1/);
});

test('schema-lite: $ref, items, patternProperties and oneOf discrimination', () => {
  const s = {
    $defs: { leaf: { type: 'object', required: ['k'], properties: { k: { type: 'integer' } } } },
    type: 'object',
    properties: {
      list: { type: 'array', items: { $ref: '#/$defs/leaf' }, minItems: 1 },
      map: { type: 'object', patternProperties: { '^p-': { $ref: '#/$defs/leaf' } } },
      tagged: {
        type: 'object',
        oneOf: [
          { properties: { t: { const: 'a' } }, required: ['t', 'x'] },
          { properties: { t: { const: 'b' } }, required: ['t', 'y'] },
        ],
      },
    },
  };
  assert.strictEqual(validate(s, { list: [{ k: 1 }], map: { 'p-1': { k: 2 } }, tagged: { t: 'a', x: 1 } }).valid, true);
  assert.strictEqual(validate(s, { list: [] }).valid, false);
  assert.strictEqual(validate(s, { list: [{ k: 'no' }] }).valid, false);
  assert.strictEqual(validate(s, { map: { 'p-1': {} } }).valid, false);
  assert.strictEqual(validate(s, { tagged: { t: 'a', y: 1 } }).valid, false, 'wrong discriminator payload');
});

// ---- the contract ---------------------------------------------------------------------------------

for (const name of FIXTURES) {
  test(`fixture ${name} satisfies state.schema.json v1`, () => {
    const r = validate(schema, load(name));
    assert.deepStrictEqual(r.errors, []);
  });
}

test('the three fixtures really are full / degraded / empty', () => {
  const full = load('state.full.json');
  assert.ok(full.epics.length >= 3 && full.attention.length >= 5);
  assert.ok(full.epics.some((e) => e.zone === 'active') && full.epics.some((e) => e.zone === 'dormant'));
  assert.ok(full.attention.some((a) => a.type === 'blocked'));
  assert.ok(full.counts.staleWorktrees >= 1);

  const degraded = load('state.degraded.json');
  const statuses = Object.keys(degraded.sources).map((k) => degraded.sources[k].status);
  assert.ok(statuses.includes('error') && statuses.includes('stale'));
  // degraded still carries DATA (last-good) alongside the fresh error metadata
  assert.ok(Object.keys(degraded.repos).length >= 1);
  assert.ok(degraded.machines.some((m) => m.bridge === 'offline'));

  const empty = load('state.empty.json');
  assert.deepStrictEqual(empty.epics, []);
  assert.deepStrictEqual(empty.attention, []);
  assert.deepStrictEqual(empty.repos, {});
  assert.deepStrictEqual(empty.counts, { blocked: 0, decisions: 0, mergeable: 0, orphans: 0, staleWorktrees: 0, handoffsLive: 0 });
});

test('the schema is LOAD-BEARING: plausible corruptions are rejected', () => {
  const base = load('state.full.json');
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(base)); fn(c); return validate(schema, c); };

  assert.strictEqual(mutate((s) => { s.v = 2; }).valid, false, 'version bump must not pass as v1');
  assert.strictEqual(mutate((s) => { delete s.counts; }).valid, false);
  assert.strictEqual(mutate((s) => { s.epics[0].zone = 'gone'; }).valid, false, 'gone epics are absent, never a zone value');
  assert.strictEqual(mutate((s) => { s.epics[0].ladder.built = 'done'; delete s.epics[0].ladder.pushed; }).valid, false, 'the cell is `pushed`, never `built`');
  assert.strictEqual(mutate((s) => { s.epics[0].ladder.pushed = 'in-progress'; }).valid, false);
  assert.strictEqual(mutate((s) => { s.sources.git.status = 'fine'; }).valid, false);
  assert.strictEqual(mutate((s) => { s.repos['app-web'].branches[0].unpushed = '3'; }).valid, false, 'unpushed is a count or null, never a string');
  assert.strictEqual(mutate((s) => { s.attention[0] = { type: 'blocked', actions: [] }; }).valid, false, 'a blocked item without a sessionKey');
  assert.strictEqual(mutate((s) => { s.machines[0].bridge = 'maybe'; }).valid, false);
});

// ---- fixture provenance (p11 D11) ---------------------------------------------------------------
//
// state.full.json carried a session with repo:'app-web' and worktree:null — a pair mapCwd CANNOT
// emit. It returns the all-null triple or {repo, worktree, epic} with the cwd path in `worktree`;
// there is no branch that sets one without the other. That drift is exactly how a dead links-matching
// leg survived a green suite: the resolver's links match reads `session.worktree`, and a fixture
// where the field is permanently null exercises the refusal path forever while looking like coverage.
//
// So the guard does not restate the invariant, it EXECUTES the real publisher: the fixture's own
// repos[] become mapCwd's config, and the row must be exactly what mapCwd returns for its own cwd.

// The two reachable shapes, named so a failure says which one was expected.
const isAllNull = (s) => s.repo == null && s.worktree == null && s.epic == null;
const isMapped = (s) => typeof s.repo === 'string' && s.repo !== '' && typeof s.worktree === 'string' && s.worktree.startsWith('/');

// mapCwd resolves the epic through mod-git's branch mapper, with the path tail playing the branch's
// role. A fixture epic that no issue-key spells out is reachable via an alias, so synthesize the one
// an operator would have configured; an issue-key tail wins before aliases are consulted anyway.
const aliasesFor = (s) => (s.epic == null ? {} : { epics: { [s.epic]: [path.basename(s.worktree || '')] } });
const configFor = (state) => ({ repos: Object.keys(state.repos || {}).map((id) => ({ id, path: state.repos[id].path })) });

for (const name of FIXTURES) {
  test(`PROVENANCE: every session in ${name} is a shape mapCwd can actually emit`, () => {
    const state = load(name);
    const config = configFor(state);
    for (const s of state.sessions) {
      const where = `${name} session ${s.key.sessionId}`;
      assert.ok(isAllNull(s) || isMapped(s), `${where}: neither all-null nor repo+absolute-worktree — mapCwd emits no third shape`);
      if (isAllNull(s)) continue;

      // The real mapper, on the row's own cwd, must reproduce the row's own identity fields.
      const produced = mapCwd(s.worktree, config, aliasesFor(s));
      assert.deepStrictEqual(
        { repo: produced.repo, worktree: produced.worktree, epic: produced.epic },
        { repo: s.repo, worktree: s.worktree, epic: s.epic == null ? null : s.epic },
        `${where}: mapCwd cannot produce this row from its own worktree path`,
      );

      // …and the worktree must be one the fixture's own repos[] actually records, so a session
      // cannot sit in a worktree that does not exist in the snapshot that carries it.
      const known = (state.repos[s.repo].worktrees || []).map((w) => w.path);
      assert.ok(known.indexOf(s.worktree) !== -1, `${where}: worktree ${s.worktree} is in no repos['${s.repo}'].worktrees[]`);
      if (s.branch !== undefined && s.branch !== null) {
        const wt = (state.repos[s.repo].worktrees || []).find((w) => w.path === s.worktree);
        assert.strictEqual(s.branch, wt.branch, `${where}: branch disagrees with the worktree record it names`);
      }
    }
  });
}

test('the PROVENANCE guard is LOAD-BEARING: the exact D11 drift is rejected', () => {
  const state = load('state.full.json');
  const config = configFor(state);
  const s = JSON.parse(JSON.stringify(state.sessions[0]));

  // The shape that was actually committed: a repo with no worktree.
  s.worktree = null;
  assert.strictEqual(isAllNull(s) || isMapped(s), false, 'repo set with worktree null must fail the shape gate');

  // A worktree that no repo contains falls out of mapCwd as the all-null triple, so it can never
  // reproduce a row claiming a repo.
  const stray = JSON.parse(JSON.stringify(state.sessions[0]));
  stray.worktree = '/somewhere/else/entirely';
  const produced = mapCwd(stray.worktree, config, aliasesFor(stray));
  assert.deepStrictEqual(produced, { repo: null, worktree: null, epic: null });
  assert.notStrictEqual(produced.repo, stray.repo, 'a cwd outside every configured repo cannot yield a repo');

  // p5 trap 8 still holds at the boundary the resolver depends on: a sibling path that merely SHARES
  // a prefix is not inside the repo.
  assert.strictEqual(mapCwd(state.repos['app-web'].path + '-old', config, {}).repo, null);
});

test('the session def is CLOSED (p11 D10): the resolver fields are declared and a typo cannot hide', () => {
  const base = load('state.full.json');
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(base)); fn(c); return validate(schema, c); };

  // The fields the resume resolver reads are now part of the contract, at their real types.
  assert.strictEqual(mutate((s) => { s.sessions[0].lastEventAt = 12345; }).valid, false, 'lastEventAt is an ISO string or null, never a number');
  assert.strictEqual(mutate((s) => { s.sessions[0].lastSubmitAt = 12345; }).valid, false);
  assert.strictEqual(mutate((s) => { s.sessions[0].worktree = 42; }).valid, false, 'worktree is a path string or null');
  assert.strictEqual(mutate((s) => { s.sessions[0].branch = 42; }).valid, false);

  // The whole point of closing the def: before this, every one of these typos validated clean while
  // the resolver silently read undefined and refused the session forever.
  for (const typo of ['lastEventAtt', 'lastsubmitAt', 'worktee', 'branchName', 'epicc']) {
    assert.strictEqual(mutate((s) => { s.sessions[0][typo] = 'x'; }).valid, false, `typo "${typo}" must be rejected`);
  }

  // Still additive: a pre-p11 row that carries none of the new fields remains valid.
  assert.strictEqual(mutate((s) => {
    for (const k of ['worktree', 'branch', 'lastEventAt', 'lastSubmitAt', 'lastStopAt', 'stale', 'observedAt', 'transcriptPath', 'blockedSince']) delete s.sessions[0][k];
  }).valid, true, 'every new field is OPTIONAL');
});

test('the closed session def accepts everything a publisher can actually emit', () => {
  const base = load('state.full.json');
  const c = JSON.parse(JSON.stringify(base));
  // Every field from mod-sessions' publish site, the events-outage carry-forward (stale), the
  // vanished bit, and the three the classify stage attaches in place before derive publishes the
  // same array as state.sessions.
  Object.assign(c.sessions[0], {
    transcriptPath: null,
    lastStopAt: '2026-07-30T13:46:52.000Z',
    stale: true,
    observedAt: '2026-07-30T14:32:11.000Z',
    vanished: true,
    lastAssistant: { text: 'May I write to /repo/app-web?', ts: '2026-07-30T14:17:10.000Z' },
    sessionTitle: { text: 'search index rollout', source: 'custom' },
    intent: { verdict: 'needs-decision', reason: 'asks for approval', model: 'test-model', at: '2026-07-30T14:17:12.000Z', inferred: true },
  });
  assert.deepStrictEqual(validate(schema, c).errors, [], 'a closed def must not reject its own publisher');

  // offer-more and status-only are real session verdicts — buildInbox filters them, the schema does not.
  for (const verdict of ['offer-more', 'status-only', 'unknown']) {
    const v = JSON.parse(JSON.stringify(c));
    v.sessions[0].intent.verdict = verdict;
    assert.deepStrictEqual(validate(schema, v).errors, [], `${verdict} is a legal session verdict`);
  }
  const bad = JSON.parse(JSON.stringify(c));
  bad.sessions[0].intent.verdict = 'probably';
  assert.strictEqual(validate(schema, bad).valid, false, 'but the verdict vocabulary is still fixed');
});

test('a snapshot derived from REAL repos validates against the schema', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-schema-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, repos: [{ id: 'fx', path: fx.repo, defaultBranches: ['develop', 'main'] }],
  }));
  const c = createCollector({ radarDir: dir, collectorId: 'test-machine' });
  const r = await c.scan({ fetch: false });
  c.stop();
  assert.strictEqual(r.published, true);
  const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  const v = validate(schema, onDisk);
  assert.deepStrictEqual(v.errors, [], 'live snapshot must satisfy the published contract');
  assert.ok(onDisk.repos.fx.branches.length >= 7);
  await fsp.rm(dir, { recursive: true, force: true });
});
