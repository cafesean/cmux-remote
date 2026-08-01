'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { main, renderStatus, parseArgs, age } = require('../radar/radar-cli');
const { flattenAttention } = require('../radar/derive');
const { buildFixtureRepo } = require('./helpers/git-fixture');

const NOW = Date.parse('2026-07-30T14:33:11.000Z');   // 60s after the fixtures' generatedAt
const load = (n) => JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'radar', 'fixtures', n), 'utf8'));

let fx = null;
before(async () => { fx = await buildFixtureRepo(); });
after(async () => { if (fx) await fx.cleanup(); });

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, stdout: () => out.join(''), stderr: () => err.join('') };
}

// ---- argv --------------------------------------------------------------------------------------

test('parseArgs: value flags take the next token, boolean flags do not', () => {
  assert.deepStrictEqual(parseArgs(['decide', 'fix the thing', '--epic', 'PROJ-1', '--json']),
    { positional: ['decide', 'fix the thing'], flags: { epic: 'PROJ-1', json: true } });
  assert.deepStrictEqual(parseArgs(['status', '--dir=/tmp/x', '--all']),
    { positional: ['status'], flags: { dir: '/tmp/x', all: true } });
  assert.deepStrictEqual(parseArgs(['scan', '--no-fetch']), { positional: ['scan'], flags: { 'no-fetch': true } });
});

test('age renders coarse buckets and never a negative number', () => {
  assert.strictEqual(age(new Date(NOW - 30000).toISOString(), NOW), '30s');
  assert.strictEqual(age(new Date(NOW - 20 * 60000).toISOString(), NOW), '20m');
  assert.strictEqual(age(new Date(NOW - 5 * 3600000).toISOString(), NOW), '5h');
  assert.strictEqual(age(new Date(NOW - 9 * 86400000).toISOString(), NOW), '9d');
  assert.strictEqual(age(new Date(NOW + 99999).toISOString(), NOW), '0s');
  assert.strictEqual(age(null, NOW), 'never');
});

// ---- rendering ---------------------------------------------------------------------------------

test('full fixture: hero, capped queue with overflow, both epic zones, cleanup commands', () => {
  const s = renderStatus(load('state.full.json'), { now: NOW });
  const lines = s.split('\n');

  assert.match(s, /^radar · machine-a · snapshot 60s old$/m);
  // NOW hero = the single worst item, and it is the blocked session
  assert.match(s, /^NOW {3}blocked {4}machine-b:9c7fd9a7 \(PROJ-108\)$/m);

  // queue is capped at 4 rows with an explicit overflow affordance (mockup-v2 limit is canonical)
  const queueRows = lines.filter((l) => l.startsWith('  · '));
  assert.strictEqual(queueRows.length, 4);
  assert.match(s, /\+4 more \(radar status --all\)/);
  // sorted: rule-violation before decision before mergeable before orphan
  assert.match(queueRows[0], /^ {2}· violation {2}app-api prod/);
  assert.match(queueRows[1], /^ {2}· decision {3}site-org2-provider-row/);
  assert.match(queueRows[3], /^ {2}· mergeable {2}BETA-147/);

  assert.match(s, /^MOVING \(1\)$/m);
  assert.match(s, /PROJ-108\s+blocked · permission_prompt · 13 commits unpushed/);
  assert.match(s, /^PARKED \(2\)$/m);
  // ladder strip shows the `pushed` cell by name, never `built`
  assert.match(s, /\[specv pushed> merged\. dev\. prod! flag\.\]/);
  assert.ok(!/built/.test(s));

  // cleanup: command strings only, and the dirty worktree gets a warning instead of a command
  assert.match(s, /WORKTREES TO CLEAN \(1\)/);
  assert.match(s, /^ {2}\/usr\/bin\/git -C '.+' worktree remove '.+' {3}# merged$/m);
  assert.match(s, /! 1 worktree has uncommitted work — not cleanup-ready/);
  assert.match(s, /counts: blocked 1 · decisions 2 · mergeable 1 · orphans 4 · stale worktrees 1/);
});

test('--all expands the queue instead of truncating it', () => {
  const s = renderStatus(load('state.full.json'), { now: NOW, all: true });
  assert.strictEqual(s.split('\n').filter((l) => l.startsWith('  · ')).length, 8);
  assert.ok(!/more \(radar status/.test(s));
});

test('degraded fixture: per-source errors are printed, data still renders', () => {
  const s = renderStatus(load('state.degraded.json'), { now: NOW });
  assert.match(s, /sources: git error · sessions stale · deploy error · jira disabled · specs disabled · config error/);
  assert.match(s, /! git: all 8 repos failed: fetch timeout/);
  assert.match(s, /! config: repos\[3\] \(docs\): path is not absolute/);
  assert.match(s, /PROJ-108/, 'carried-forward data still renders under an error badge');
});

test('empty fixture: the all-quiet state, not a blank screen', () => {
  const s = renderStatus(load('state.empty.json'), { now: NOW });
  assert.match(s, /NOW {3}all quiet — nothing is waiting on you/);
  assert.match(s, /MOVING \(0\)/);
  assert.match(s, /WORKTREES TO CLEAN \(0\)/);
  assert.match(s, /counts: blocked 0 · decisions 0 · mergeable 0 · orphans 0 · stale worktrees 0/);
});

test('with no snapshot at all the CLI says so instead of rendering zeros', () => {
  assert.match(renderStatus(null, { now: NOW }), /no snapshot yet — run `radar scan`/);
});

// ---- end to end, no server running --------------------------------------------------------------

test('radar scan/status/tag/decide/decided/flag work standalone against real repos', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-cli-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', collectorId: 'test-machine',
    repos: [{ id: 'fx', path: fx.repo, defaultBranches: ['develop', 'main'] }],
  }));
  const args = (rest) => ['--dir', dir].concat(rest);

  // scan — no server, no bridge, no network
  let c = capture();
  assert.strictEqual(await main(args(['scan', '--no-fetch']), c.io), 0);
  assert.match(c.stdout(), /^radar: scanned 1 repos in \d+\.\ds -> .+state\.json$/m);
  const state = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.strictEqual(state.collectorId, 'test-machine');

  // status renders from the snapshot without rescanning
  c = capture();
  assert.strictEqual(await main(args(['status']), c.io), 0);
  assert.strictEqual(c.stderr(), '', 'a fresh snapshot must not trigger a rescan');
  assert.match(c.stdout(), /^radar · test-machine/m);
  // Same-type orphans are FOLDED into one triage row by default (derive §ORPHAN_GROUP_MIN) —
  // that is the whole point of the fold, so the default view names the count, not the branches.
  assert.match(c.stdout(), /orphans\s+\d+ untagged branches/, 'the unmapped branches are one folded queue row');

  // ... and `--all` unfolds every group, INCLUDING one that took the hero slot, so the CLI can
  // never hide an item behind a count.
  c = capture();
  await main(args(['status', '--all']), c.io);
  assert.match(c.stdout(), /orphan-branch/, 'every member is still reachable with groups expanded');

  // status --json is the same object the API will serve
  c = capture();
  await main(args(['status', '--json']), c.io);
  assert.strictEqual(JSON.parse(c.stdout()).v, 1);

  // tag an orphan -> it maps on the next scan
  c = capture();
  assert.strictEqual(await main(args(['tag', 'fx:orphan-branch', 'PROJ-500']), c.io), 0);
  assert.match(c.stdout(), /fx:orphan-branch -> PROJ-500/);
  assert.strictEqual(await main(args(['scan', '--no-fetch']), capture().io), 0);
  const tagged = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.strictEqual(tagged.repos.fx.branches.find((b) => b.name === 'orphan-branch').epic, 'PROJ-500');
  assert.ok(!flattenAttention(tagged.attention).some((a) => a.type === 'orphan' && a.branch === 'orphan-branch'), 'it left the orphan queue');

  // tag validation rejects unknown values
  c = capture();
  assert.strictEqual(await main(args(['tag', 'fx:no-such-branch', 'PROJ-1']), c.io), 1);
  assert.match(c.stderr(), /unknown branch fx:no-such-branch/);

  // decide -> decided
  c = capture();
  assert.strictEqual(await main(args(['decide', 'Pick the merge order', '--epic', 'PROJ-500']), c.io), 0);
  assert.match(c.stdout(), /decision pick-the-merge-order opened on PROJ-500/);
  c = capture();
  assert.strictEqual(await main(args(['decided', 'pick-the-merge-order']), c.io), 0);
  c = capture();
  assert.strictEqual(await main(args(['decided', 'pick-the-merge-order']), c.io), 1);
  assert.match(c.stderr(), /no open decision/);

  // flag assertion
  c = capture();
  assert.strictEqual(await main(args(['flag', 'PROJ-500', 'off']), c.io), 0);
  const aliases = JSON.parse(await fsp.readFile(path.join(dir, 'aliases.json'), 'utf8'));
  assert.strictEqual(aliases.flags['PROJ-500'].state, 'off');
  assert.strictEqual(aliases.branchOverrides['fx:orphan-branch'], 'PROJ-500');

  // unknown command and help
  c = capture();
  assert.strictEqual(await main(args(['frobnicate']), c.io), 2);
  c = capture();
  assert.strictEqual(await main(args(['help']), c.io), 0);
  assert.match(c.stdout(), /radar is read-only outside its own directory/i);

  await fsp.rm(dir, { recursive: true, force: true });
});

// S-007 defect 1, CLI half. `radar tag` had one shape (branch) while the state it renders is
// dominated by the other (spec-orphans), so the CLI could show you 125 items it had no verb for.
// The lifecycle is asserted end to end — appear, tag, disappear — because the alias append is only
// correct if the p-numeral it writes is the one the next scan matches on.
test('radar tag --spec appends the alias and the spec-orphan leaves the queue', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-cli-spec-'));
  const ctx = path.join(dir, 'ctx');
  await fsp.mkdir(path.join(ctx, 'app', '_specs', 'p63-something'), { recursive: true });
  await fsp.writeFile(path.join(ctx, 'app', '_specs', 'p63-something', 'specs.md'), '# p63\n\n**Verdict:** GO\n');
  // A SECOND folder that stays untagged. It keeps the spec-orphan list non-empty for the typo
  // assertion below: collector.tagSpec only validates against a list it actually has, so with an
  // empty queue there is nothing to validate against (noted as a residual S-009 hole, not fixed here).
  await fsp.mkdir(path.join(ctx, 'app', '_specs', 'p64-other'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', collectorId: 'test-machine',
    specs: { root: ctx },
    repos: [{ id: 'fx', path: fx.repo, defaultBranches: ['develop', 'main'] }],
  }));
  const args = (rest) => ['--dir', dir].concat(rest);

  assert.strictEqual(await main(args(['scan', '--no-fetch']), capture().io), 0);
  let state = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.ok(flattenAttention(state.attention).some((a) => a.type === 'spec-orphan' && a.specFolder === 'p63-something'),
    'the untagged spec folder is an orphan first');

  let c = capture();
  assert.strictEqual(await main(args(['tag', '--spec', 'p63-something', 'PROJ-500']), c.io), 0);
  assert.match(c.stdout(), /spec p63-something -> PROJ-500 \(alias append\)/);
  const aliases = JSON.parse(await fsp.readFile(path.join(dir, 'aliases.json'), 'utf8'));
  assert.deepStrictEqual(aliases.epics['PROJ-500'], ['app/p63-something'],
    'the project-qualified FOLDER NAME is appended — a bare numeral would claim every p63-* folder');

  assert.strictEqual(await main(args(['scan', '--no-fetch']), capture().io), 0);
  state = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  const left = flattenAttention(state.attention).filter((a) => a.type === 'spec-orphan').map((a) => a.specFolder);
  assert.deepStrictEqual(left, ['p64-other'], 'the tagged one is gone on the next scan, the other stays');

  // a folder radar never saw is refused, so a typo cannot write an alias that matches nothing
  c = capture();
  assert.strictEqual(await main(args(['tag', '--spec', 'p99-nope', 'PROJ-500']), c.io), 1);

  // usage errors are errors, not silent no-ops
  c = capture();
  assert.strictEqual(await main(args(['tag', '--spec', 'p63-something']), c.io), 1);
  assert.match(c.stderr(), /usage: radar tag --spec/);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('status with no snapshot scans first, and --no-scan refuses to', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-cli2-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, repos: [{ id: 'fx', path: fx.repo, defaultBranches: ['develop', 'main'] }],
  }));

  let c = capture();
  await main(['--dir', dir, 'status', '--no-scan'], c.io);
  assert.match(c.stdout(), /no snapshot yet/);
  assert.strictEqual(require('fs').existsSync(path.join(dir, 'state.json')), false);

  c = capture();
  await main(['--dir', dir, 'status', '--no-fetch'], c.io);
  assert.match(c.stderr(), /no snapshot, scanning/);
  assert.match(c.stdout(), /MOVING/);
  await fsp.rm(dir, { recursive: true, force: true });
});
