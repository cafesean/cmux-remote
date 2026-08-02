'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { validate } = require('../radar/schema-lite');
const { createCollector } = require('../radar/collector');
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
