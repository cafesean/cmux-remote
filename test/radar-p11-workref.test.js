'use strict';
// p11 S-002 — the WorkRef builder and, mostly, the status projection.
//
// All fixtures here are SYNTHETIC by rule, not by habit: this repository is public and a previous
// phase leaked owner-identifying material badly enough that the repo had to be deleted and
// recreated. Project keys are PROJ/ALPHA/BETA and paths are /repo/<name>, matching what
// config.example.json and mod-jira's header already use.
//
// THE PROJECTION IS ORDERED, AND THE ORDER IS THE CONTRACT. A table of one-fact-at-a-time cases
// would pass against an implementation that got the precedence backwards, because with one fact set
// there is nothing to outrank. So the cases below deliberately set CONFLICTING facts and assert
// which one wins — blocked over an in-flight tracker status, parked over blocked's absence, both
// legs required for `done`.
//
// THE CONTESTED CASE has its own test and its own comment, because it is the result most likely to
// be "fixed" into a bug: Jira says done while git still shows outstanding work, and the answer is
// `unknown` rather than either side. Radar reports the disagreement (mod-jira already emits
// jira-done-git-live drift) and asserts neither.
const test = require('node:test');
const assert = require('node:assert');

const {
  buildWorkRef, buildWorkRefs, projectStatus, isSelectable, inScope,
  linksFor, clusterHasDanglingFacts, urnFor, clusterFor, CANONICAL,
} = require('../radar/workref.js');

const ALIASES = { epics: { 'PROJ-108': ['p59', 'tokentotal'] }, branchOverrides: {} };

// A git fragment in the shape mod-git publishes: two repos, one branch mapped to PROJ-108 by its
// issue key, one mapped by alias, one orphan, plus a dirty worktree.
const gitFragment = () => ({
  repos: {
    'example-web': {
      branches: [
        { name: 'feature/PROJ-108-metering', unpushed: 0, mergedIntoDevelop: true },
        { name: 'chore/unrelated-thing', unpushed: 4, mergedIntoDevelop: false },
      ],
      worktrees: [],
    },
    'example-api': {
      branches: [{ name: 'feature/tokentotal', unpushed: 0, mergedIntoDevelop: true }],
      worktrees: [],
    },
  },
});

test('urn and cluster: stable, source lowercased, sourceId verbatim', () => {
  assert.strictEqual(urnFor('JIRA', 'PROJ-108'), 'urn:work:jira:PROJ-108');
  assert.strictEqual(urnFor('jira', 'PROJ-108'), 'urn:work:jira:PROJ-108');
  assert.strictEqual(urnFor('', 'PROJ-108'), null);
  assert.strictEqual(urnFor('jira', '  '), null);
  assert.strictEqual(clusterFor('jira', 'PROJ-108', 'PROJ-108'), 'PROJ-108');
  assert.strictEqual(clusterFor('jira', '99', null), 'jira:99', 'no epic ⇒ falls back to source:id');
});

// ---- the projection ------------------------------------------------------------------------------

test('projection: every output is inside the fixed vocabulary', () => {
  const inputs = [
    {}, { nativeCategory: 'new' }, { nativeCategory: 'indeterminate' }, { nativeCategory: 'done' },
    { nativeCategory: 'done', hasDanglingFacts: true }, { sessionBlocked: true }, { parked: true },
    { waiting: true }, { hasActivitySignal: true }, { nativeCategory: 'bogus' },
  ];
  for (const i of inputs) assert.ok(CANONICAL.includes(projectStatus(i)), `${JSON.stringify(i)} → ${projectStatus(i)}`);
});

test('projection: a blocked session OUTRANKS the tracker', () => {
  // Jira is in-flight and would say `active`; a blocked session must win, because a tracker cannot
  // know a session is sitting on a prompt.
  assert.strictEqual(projectStatus({ nativeCategory: 'indeterminate', sessionBlocked: true }), 'blocked');
  assert.strictEqual(projectStatus({ nativeCategory: 'done', sessionBlocked: true }), 'blocked');
  assert.strictEqual(projectStatus({ nativeCategory: 'new', hasAssignee: true, sessionBlocked: true }), 'blocked');
});

test('projection: parked outranks everything below it, blocked outranks parked', () => {
  assert.strictEqual(projectStatus({ nativeCategory: 'indeterminate', parked: true }), 'parked');
  assert.strictEqual(projectStatus({ parked: true, sessionBlocked: true }), 'blocked', 'a human parked it, but it is blocked NOW');
});

test('projection: waiting outranks the tracker status but not blocked/parked', () => {
  assert.strictEqual(projectStatus({ nativeCategory: 'indeterminate', waiting: true }), 'waiting');
  assert.strictEqual(projectStatus({ waiting: true, parked: true }), 'parked');
});

test('projection: done needs BOTH legs — tracker done AND nothing outstanding in git', () => {
  assert.strictEqual(projectStatus({ nativeCategory: 'done' }), 'done');
  assert.strictEqual(projectStatus({ nativeCategory: 'done', hasDanglingFacts: false }), 'done');
});

// The one a future reader will try to "fix".
test('projection: CONTESTED (tracker done, git still dirty) is `unknown`, not done and not active', () => {
  const got = projectStatus({ nativeCategory: 'done', hasDanglingFacts: true });
  assert.strictEqual(got, 'unknown');
  assert.notStrictEqual(got, 'done', 'asserting done would hide work git can see is unfinished');
  assert.notStrictEqual(got, 'active', 'asserting active would overrule the tracker on its own field');
});

test('projection: new is `ready` only when triaged; untriaged is `inbox`', () => {
  assert.strictEqual(projectStatus({ nativeCategory: 'new' }), 'inbox');
  assert.strictEqual(projectStatus({ nativeCategory: 'new', hasAssignee: true }), 'ready');
  assert.strictEqual(projectStatus({ nativeCategory: 'new', hasSprint: true }), 'ready');
});

test('projection: an unrecognised category is `unknown`, never coerced into a real state', () => {
  for (const bad of ['bogus', 'Done', 'IN PROGRESS', '', null, undefined, 7]) {
    assert.strictEqual(projectStatus({ nativeCategory: bad }), 'unknown', `category ${JSON.stringify(bad)}`);
  }
});

test('projection: radar activity alone can make it active with no tracker status at all', () => {
  assert.strictEqual(projectStatus({ hasActivitySignal: true }), 'active');
});

// ---- links and dangling facts ----------------------------------------------------------------------

test('links: joins an epic to its branches through the SHARED mapper, across repos', () => {
  const links = linksFor('PROJ-108', gitFragment(), ALIASES);
  assert.deepStrictEqual(links, [
    'urn:work:git:example-api/feature/tokentotal',   // matched by alias
    'urn:work:git:example-web/feature/PROJ-108-metering', // matched by issue key
  ]);
});

test('links: an unrelated branch never joins, and an unknown epic joins nothing', () => {
  assert.ok(!linksFor('PROJ-108', gitFragment(), ALIASES).some((u) => u.includes('unrelated')));
  assert.deepStrictEqual(linksFor('PROJ-999', gitFragment(), ALIASES), []);
  assert.deepStrictEqual(linksFor(null, gitFragment(), ALIASES), []);
});

test('dangling facts: unpushed, unmerged and dirty each count; a clean cluster does not', () => {
  assert.strictEqual(clusterHasDanglingFacts('PROJ-108', gitFragment(), ALIASES), false);

  const unpushed = gitFragment();
  unpushed.repos['example-web'].branches[0].unpushed = 9;
  assert.strictEqual(clusterHasDanglingFacts('PROJ-108', unpushed, ALIASES), true);

  const unmerged = gitFragment();
  unmerged.repos['example-web'].branches[0].mergedIntoDevelop = false;
  assert.strictEqual(clusterHasDanglingFacts('PROJ-108', unmerged, ALIASES), true);

  const dirty = gitFragment();
  dirty.repos['example-web'].worktrees = [
    { path: '/repo/example-web/.wt/tokentotal', branch: 'feature/PROJ-108-metering', dirty: { staged: 0, unstaged: 2, untracked: 0 } },
  ];
  assert.strictEqual(clusterHasDanglingFacts('PROJ-108', dirty, ALIASES), true);
});

test('dangling facts: another epic\'s mess never counts as this one\'s', () => {
  const g = gitFragment();
  g.repos['example-web'].branches[1].unpushed = 40;   // chore/unrelated-thing is an orphan
  assert.strictEqual(clusterHasDanglingFacts('PROJ-108', g, ALIASES), false);
});

// ---- scope and selectability ---------------------------------------------------------------------

test('scope: out-of-scope project is excluded, and absent scope means unrestricted', () => {
  const wr = { source: 'jira', sourceId: 'BETA-7', links: [] };
  assert.strictEqual(inScope(wr, { jiraProjects: ['PROJ', 'ALPHA'] }), false);
  assert.strictEqual(inScope(wr, { jiraProjects: ['BETA'] }), true);
  assert.strictEqual(inScope(wr, undefined), true, 'the CLI passes no scope');
});

test('scope: a cluster touching only out-of-scope repos is excluded', () => {
  const wr = { source: 'jira', sourceId: 'PROJ-108', links: ['urn:work:git:example-web/feature/x'] };
  assert.strictEqual(inScope(wr, { repos: ['example-api'] }), false);
  assert.strictEqual(inScope(wr, { repos: ['example-web'] }), true);
});

test('selectable: needs an actionable status AND scope AND something to act on', () => {
  const mk = (over) => Object.assign({ source: 'jira', sourceId: 'PROJ-108', links: [], status: { canonical: 'active' } }, over);
  assert.strictEqual(isSelectable(mk({}), null), false, 'nothing to act on');
  assert.strictEqual(isSelectable(mk({ links: ['urn:work:git:example-web/feature/x'] }), null), true);
  assert.strictEqual(isSelectable(mk({ description: 'do the thing' }), null), true);
  assert.strictEqual(isSelectable(mk({ hasSpecFolder: true }), null), true);
  for (const s of ['done', 'parked', 'inbox', 'waiting', 'unknown']) {
    assert.strictEqual(isSelectable(mk({ status: { canonical: s }, description: 'x' }), null), false, `${s} is never selected`);
  }
  for (const s of ['ready', 'active', 'blocked']) {
    assert.strictEqual(isSelectable(mk({ status: { canonical: s }, description: 'x' }), null), true, `${s} is selectable`);
  }
});

// ---- the builder --------------------------------------------------------------------------------

test('builder: carries native status verbatim and marks its own projection', () => {
  const wr = buildWorkRef({
    source: 'jira', sourceId: 'PROJ-108', kind: 'epic', title: 'Metering hardening',
    nativeStatus: 'Ready for Code Review', nativeCategory: 'indeterminate',
    epicKey: 'PROJ-108', sourceUrl: 'https://jira.example.com/browse/PROJ-108',
    connector: 'mod-jira', description: 'harden it',
  }, { gitFragment: gitFragment(), aliases: ALIASES, observedAt: '2026-01-01T00:00:00.000Z' });

  assert.strictEqual(wr.status.native, 'Ready for Code Review', 'display name preserved exactly');
  assert.strictEqual(wr.status.nativeCategory, 'indeterminate');
  assert.strictEqual(wr.status.canonical, 'active');
  assert.strictEqual(wr.provenance.confidence, 'recorded');
  assert.strictEqual(wr.provenance.observedAt, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(wr.cluster, 'PROJ-108');
  assert.strictEqual(wr.route, null, 'route is eligibility.js\'s job');
  assert.strictEqual(wr.links.length, 2);
  assert.strictEqual(wr.selectable, true);
});

test('builder: an unrecognised native category is nulled, not passed through', () => {
  const wr = buildWorkRef({ source: 'jira', sourceId: 'PROJ-1', nativeStatus: 'Weird', nativeCategory: 'made-up' }, {});
  assert.strictEqual(wr.status.nativeCategory, null);
  assert.strictEqual(wr.status.native, 'Weird', 'the display name is still the source\'s word');
  assert.strictEqual(wr.status.canonical, 'unknown');
});

test('builder: no identity ⇒ no WorkRef', () => {
  assert.strictEqual(buildWorkRef({ source: 'jira' }, {}), null);
  assert.strictEqual(buildWorkRef({ sourceId: 'PROJ-1' }, {}), null);
});

test('buildWorkRefs: deduplicates by urn (first wins) and sorts deterministically', () => {
  const items = [
    { source: 'jira', sourceId: 'PROJ-9', title: 'second' },
    { source: 'jira', sourceId: 'PROJ-2', title: 'first' },
    { source: 'jira', sourceId: 'PROJ-9', title: 'DUPLICATE' },
    'not an object',
    null,
  ];
  const out = buildWorkRefs(items, {});
  assert.deepStrictEqual(out.map((w) => w.urn), ['urn:work:jira:PROJ-2', 'urn:work:jira:PROJ-9']);
  assert.strictEqual(out[1].title, 'second', 'first read wins; records are never merged');
});

test('buildWorkRefs: is pure — the same input twice gives byte-identical output', () => {
  const items = [{ source: 'jira', sourceId: 'PROJ-108', epicKey: 'PROJ-108', nativeCategory: 'indeterminate' }];
  const ctx = { gitFragment: gitFragment(), aliases: ALIASES, observedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepStrictEqual(buildWorkRefs(items, ctx), buildWorkRefs(items, ctx));
});
