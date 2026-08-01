'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createCollector, fragmentsFromState } = require('../radar/collector');
const store = require('../radar/store');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'radar-collector-'));

const repoFragment = (marker) => ({
  repos: {
    fx: {
      path: '/repos/fx',
      defaultBranches: { develop: 'a'.repeat(40), main: 'b'.repeat(40) },
      branches: [{
        name: `feature/PROJ-1-${marker}`, sha: 'c'.repeat(40), epic: 'PROJ-1', epicVia: 'issue-key',
        isDefault: false, unpushed: 3, noRemote: false, mergedIntoDevelop: false, mergedIntoMain: false,
        lastCommitAt: new Date().toISOString(), worktree: null,
      }],
      worktrees: [],
      deploy: null,
      fetch: { status: 'ok', error: null },
    },
  },
});

const okModule = (marker, observedAt) => async () => ({
  fragment: repoFragment(marker),
  source: { status: 'ok', observedAt: observedAt || new Date().toISOString() },
  warnings: [],
});

async function seedConfig(dir, extra) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(Object.assign({
    configVersion: 1, role: 'leader', repos: [{ id: 'fx', path: '/repos/fx' }],
  }, extra || {})));
}

// ---- publication --------------------------------------------------------------------------------

test('a scan publishes state.json atomically and getState reads it back', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const c = createCollector({ radarDir: dir, modules: { git: okModule('one') } });
  const r = await c.scan();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.published, true);
  const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.strictEqual(onDisk.v, 1);
  assert.strictEqual(onDisk.repos.fx.branches[0].name, 'feature/PROJ-1-one');
  assert.deepStrictEqual((await c.getState()).generatedAt, onDisk.generatedAt);
  assert.deepStrictEqual((await fsp.readdir(dir)).filter((n) => n.includes('.tmp-')), []);
  c.stop();
});

test('concurrent scan requests COALESCE onto the single in-flight scan', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  let invocations = 0;
  const slow = async () => {
    invocations++;
    await new Promise((res) => setTimeout(res, 40));
    return { fragment: repoFragment('slow'), source: { status: 'ok', observedAt: new Date().toISOString() }, warnings: [] };
  };
  const c = createCollector({ radarDir: dir, modules: { git: slow } });
  const [a, b, d] = await Promise.all([c.scan(), c.scan(), c.scan()]);
  assert.strictEqual(invocations, 1, 'one fan-out, not three');
  assert.strictEqual(c.stats.coalesced, 2);
  assert.strictEqual(a.state.generatedAt, b.state.generatedAt);
  assert.strictEqual(b.state.generatedAt, d.state.generatedAt);
  assert.strictEqual(c.isScanning(), false);
  c.stop();
});

// ---- the partial-failure contract ----------------------------------------------------------------

test('a module failure carries its fragment forward and publishes FRESH error metadata', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const firstAt = '2026-07-30T10:00:00.000Z';
  let mode = 'ok';
  const flaky = async () => {
    if (mode === 'boom') throw new Error('git exploded');
    return { fragment: repoFragment('good'), source: { status: 'ok', observedAt: firstAt }, warnings: [] };
  };
  const c = createCollector({ radarDir: dir, modules: { git: flaky } });

  const good = await c.scan();
  assert.strictEqual(good.state.repos.fx.branches[0].name, 'feature/PROJ-1-good');
  assert.strictEqual(good.state.sources.git.observedAt, firstAt);

  mode = 'boom';
  const degraded = await c.scan();
  assert.strictEqual(degraded.published, true, 'a module failure NEVER blocks publication');
  // data: last-good, per fragment, unchanged
  assert.strictEqual(degraded.state.repos.fx.branches[0].name, 'feature/PROJ-1-good');
  // metadata: fresh
  assert.strictEqual(degraded.state.sources.git.status, 'error');
  assert.strictEqual(degraded.state.sources.git.error, 'git exploded');
  assert.notStrictEqual(degraded.state.sources.git.observedAt, firstAt);
  assert.ok(Date.parse(degraded.state.generatedAt) >= Date.parse(good.state.generatedAt));
  // and the new snapshot really is on disk
  const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.strictEqual(onDisk.sources.git.status, 'error');
  c.stop();
});

test('carry-forward survives a process restart because it is rebuilt from state.json', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const first = createCollector({ radarDir: dir, modules: { git: okModule('persisted') } });
  await first.scan();
  first.stop();

  // A brand-new collector object, no in-memory history at all.
  const second = createCollector({ radarDir: dir, modules: { git: async () => { throw new Error('still down'); } } });
  const r = await second.scan();
  assert.strictEqual(r.state.repos.fx.branches[0].name, 'feature/PROJ-1-persisted');
  assert.strictEqual(r.state.sources.git.error, 'still down');
  second.stop();
});

test('whole-file last-good applies ONLY when the publication itself fails', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const c = createCollector({ radarDir: dir, modules: { git: okModule('first') } });
  await c.scan();
  const before = await fsp.readFile(path.join(dir, 'state.json'), 'utf8');

  await fsp.chmod(dir, 0o500);
  try {
    const r = await c.scan();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.published, false);
    assert.match(r.error, /publish failed/);
    assert.strictEqual(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'), before, 'previous snapshot untouched');
  } finally {
    await fsp.chmod(dir, 0o700);
  }
  c.stop();
});

test('unimplemented modules report `disabled`, never silence', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  // `sessions: null` explicitly un-implements S-004's module. It ships in DEFAULT_MODULES now, and
  // the contract under test here is "no impl -> disabled", not "sessions is missing".
  const c = createCollector({ radarDir: dir, modules: { git: okModule('x'), sessions: null } });
  const { state } = await c.scan();
  assert.deepStrictEqual(state.sources.sessions, { status: 'disabled' });
  assert.deepStrictEqual(state.sources.deploy, { status: 'disabled' });
  assert.deepStrictEqual(state.sources.jira, { status: 'disabled' });
  assert.deepStrictEqual(state.sources.specs, { status: 'disabled' });
  c.stop();
});

// ---- degraded inputs ------------------------------------------------------------------------------

test('an absent config starts the collector with error sources instead of crashing', async () => {
  const dir = await tmp();
  const c = createCollector({ radarDir: dir, modules: { git: okModule('x') } });
  const r = await c.scan();
  assert.strictEqual(r.published, true);
  assert.strictEqual(r.state.sources.config.status, 'error');
  assert.match(r.state.sources.config.error, /config missing/);
  c.stop();
});

test('corrupt aliases/decisions/state files degrade into sources.config, never a throw', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  await fsp.writeFile(path.join(dir, 'aliases.json'), 'not json');
  await fsp.writeFile(path.join(dir, 'decisions.json'), '[[[');
  await fsp.writeFile(path.join(dir, 'state.json'), 'previous snapshot was truncated');
  const c = createCollector({ radarDir: dir, modules: { git: okModule('x') } });
  const r = await c.scan();
  assert.strictEqual(r.published, true);
  assert.strictEqual(r.state.sources.config.status, 'error');
  assert.match(r.state.sources.config.error, /aliases\.json/);
  assert.match(r.state.sources.config.error, /decisions\.json/);
  c.stop();
});

test('an unknown configVersion surfaces as a config error source', async () => {
  const dir = await tmp();
  await seedConfig(dir, { configVersion: 7 });
  const c = createCollector({ radarDir: dir, modules: { git: okModule('x') } });
  const { state } = await c.scan();
  assert.strictEqual(state.sources.config.status, 'error');
  assert.match(state.sources.config.error, /unknown configVersion 7/);
  c.stop();
});

// ---- timers ----------------------------------------------------------------------------------------

test('start() installs an unref-ed timer and stop() clears it (idempotently)', async () => {
  const dir = await tmp();
  await seedConfig(dir, { scanIntervalMin: 1 });
  const c = createCollector({ radarDir: dir, modules: { git: okModule('x') } });
  const t = c.start();
  assert.ok(t, 'timer handle returned');
  assert.strictEqual(c.start(), undefined, 'start is idempotent — no second timer');
  c.stop();
  c.stop();
  assert.ok(!t.hasRef || t.hasRef() === false, 'timer never holds the event loop open');
});

// ---- mutations ---------------------------------------------------------------------------------------

test('tag validates against server-known repos and branches before writing', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const c = createCollector({ radarDir: dir, modules: { git: okModule('one') } });

  await assert.rejects(() => c.tagBranch({ repo: 'fx', branch: 'feature/PROJ-1-one', epic: 'PROJ-9' }), /no snapshot yet/);
  await c.scan();
  await assert.rejects(() => c.tagBranch({ repo: 'nope', branch: 'x', epic: 'PROJ-9' }), /unknown repo nope/);
  await assert.rejects(() => c.tagBranch({ repo: 'fx', branch: 'not-a-branch', epic: 'PROJ-9' }), /unknown branch fx:not-a-branch/);
  await assert.rejects(() => c.tagBranch({ repo: 'fx', branch: 'feature/PROJ-1-one' }), /requires repo, branch and epic/);

  await c.tagBranch({ repo: 'fx', branch: 'feature/PROJ-1-one', epic: 'PROJ-9' });
  const aliases = JSON.parse(await fsp.readFile(path.join(dir, 'aliases.json'), 'utf8'));
  assert.strictEqual(aliases.branchOverrides['fx:feature/PROJ-1-one'], 'PROJ-9');
  c.stop();
});

test('decide/decided round-trips through the write queue and reopen is a new id', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const c = createCollector({ radarDir: dir, modules: { git: okModule('x') } });

  const d1 = await c.addDecision({ title: 'Provision the prod provider row', epic: 'PROJ-108', context: 'why' });
  assert.strictEqual(d1.id, 'provision-the-prod-provider-row');
  assert.strictEqual(d1.epic, 'PROJ-108');
  assert.strictEqual(d1.closedAt, null);

  await c.closeDecision(d1.id);
  await assert.rejects(() => c.closeDecision(d1.id), /no open decision/);
  await assert.rejects(() => c.closeDecision('nope'), /no open decision/);

  const d2 = await c.addDecision({ title: 'Provision the prod provider row' });
  assert.strictEqual(d2.id, 'provision-the-prod-provider-row-2', 'reopen = a new id, history stays append-only');

  const list = JSON.parse(await fsp.readFile(path.join(dir, 'decisions.json'), 'utf8'));
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].closedAt);
  c.stop();
});

test('flag assertions are stored with the assertion date and validated', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  const c = createCollector({ radarDir: dir, now: () => Date.parse('2026-07-30T12:00:00Z'), modules: { git: okModule('x') } });
  await assert.rejects(() => c.setFlag({ epic: 'PROJ-1', state: 'maybe' }), /on\|off\|n\/a/);
  await c.setFlag({ epic: 'PROJ-1', state: 'n/a' });
  const aliases = JSON.parse(await fsp.readFile(path.join(dir, 'aliases.json'), 'utf8'));
  assert.deepStrictEqual(aliases.flags['PROJ-1'], { state: 'n/a', assertedAt: '2026-07-30' });
  c.stop();
});

test('mutations do not clobber unrelated keys of aliases.json', async () => {
  const dir = await tmp();
  await seedConfig(dir);
  await store.writeJsonAtomic(path.join(dir, 'aliases.json'), { epics: { 'PROJ-1': ['p1'] }, titles: { 'PROJ-1': 'keep me' } });
  const c = createCollector({ radarDir: dir, modules: { git: okModule('one') } });
  await c.scan();
  await c.tagBranch({ repo: 'fx', branch: 'feature/PROJ-1-one', epic: 'PROJ-9' });
  await c.setFlag({ epic: 'PROJ-1', state: 'on' });
  const aliases = JSON.parse(await fsp.readFile(path.join(dir, 'aliases.json'), 'utf8'));
  assert.deepStrictEqual(aliases.epics, { 'PROJ-1': ['p1'] });
  assert.strictEqual(aliases.titles['PROJ-1'], 'keep me');
  assert.strictEqual(aliases.flags['PROJ-1'].state, 'on');
  c.stop();
});

test('fragmentsFromState rebuilds every module slice, including deploy nested under repos', () => {
  const f = fragmentsFromState({
    v: 1,
    repos: { a: { path: '/a', defaultBranches: {}, branches: [1], worktrees: [2], deploy: { dev: { status: 'ok' } }, fetch: { status: 'ok', error: null } } },
    sessions: [{ id: 's' }],
    machines: [{ id: 'm', bridge: 'ok', lastSeenAt: null }],
  });
  assert.deepStrictEqual(f.git.repos.a.branches, [1]);
  assert.strictEqual(f.git.repos.a.deploy, null, 'deploy is its own fragment, not the git one');
  assert.deepStrictEqual(f.deploy.repos.a, { dev: { status: 'ok' } });
  assert.deepStrictEqual(f.sessions.sessions, [{ id: 's' }]);
  assert.deepStrictEqual(fragmentsFromState(null).git.repos, {});
});
