'use strict';
// D2/D4 — the lifecycle EXIT gate (`radar done`) and the handoff-brief assembler (`radar brief`).
//
// These two are what turn feature-lifecycle's TRUE DONE from prose into something a script — or a
// dispatched session — can assert instead of claim. The rule they encode: `unknown` is never a
// pass, and a selector that resolves to nothing is a failure, not a silently shorter brief.
const { test } = require('node:test');
const assert = require('node:assert');
const { trueDoneReport, renderDone, buildBrief } = require('../radar/radar-cli');

const NOW = '2026-08-01T00:00:00.000Z';
const ladder = (o) => Object.assign({ spec: 'done', pushed: 'done', mergedDevelop: 'done', deployedDev: 'done', prod: 'done', flags: 'done' }, o || {});
const base = (o) => Object.assign({
  v: 1, generatedAt: NOW, collectorId: 'test',
  sources: { git: { status: 'ok' }, jira: { status: 'ok' } },
  repos: {}, epics: [], attention: [], jiraDrift: [], counts: {},
}, o || {});

const verdictOf = (r, id) => (r.rows.find((x) => x.id === id) || {}).verdict;

// ---- radar done ----------------------------------------------------------------------------------

test('an epic absent from the board IS done — that is the definition, not a proxy for it', () => {
  const r = trueDoneReport(base(), 'PROJ-1');
  assert.strictEqual(r.done, true);
  assert.strictEqual(verdictOf(r, 'board'), 'PASS');
});

test('an epic on the board is never done, however green its ladder', () => {
  const r = trueDoneReport(base({ epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: '1 commit unpushed', ladder: ladder(), signals: [], repos: [] }] }), 'PROJ-1');
  assert.strictEqual(r.done, false);
  assert.strictEqual(verdictOf(r, 'board'), 'FAIL', 'still listed => still open, no matter what the cells say');
});

test('UNKNOWN is not a PASS — missing data must never read green', () => {
  const r = trueDoneReport(base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder({ prod: 'unknown', mergedDevelop: 'unknown' }), signals: [], repos: [] }],
  }), 'PROJ-1');
  assert.strictEqual(verdictOf(r, 'prod'), 'UNKNOWN');
  assert.strictEqual(verdictOf(r, 'merged'), 'UNKNOWN');
  assert.strictEqual(verdictOf(r, 'pushed'), 'PASS');
});

// The worktree record carries `branch`, NEVER `epic` — verified against the real snapshot: 42
// worktrees, 0 with an `epic` key. These fixtures therefore use the REAL shape, so a check keyed on
// a field that does not exist cannot pass here either.
test('a worktree still mapped to the epic fails, and a DIRTY one says it cannot be removed', () => {
  const state = base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: [], repos: ['r1'] }],
    repos: { r1: {
      branches: [{ name: 'feature/a', epic: 'PROJ-1' }, { name: 'feature/b', epic: 'PROJ-1' }],
      worktrees: [
        { path: '/w/clean', branch: 'feature/a', dirty: { staged: 0, unstaged: 0, untracked: 0 } },
        { path: '/w/dirty', branch: 'feature/b', dirty: { staged: 0, unstaged: 3, untracked: 0 } },
      ],
    } },
  });
  const r = trueDoneReport(state, 'PROJ-1');
  const row = r.rows.find((x) => x.id === 'worktrees');
  assert.strictEqual(row.verdict, 'FAIL');
  assert.match(row.note, /2 remaining/);
  assert.match(row.note, /1 DIRTY/);
});

test('REGRESSION: the worktree join goes through the BRANCH — `epic` is not a worktree field', () => {
  // The bug this replaces: `w.epic === key` matched nothing on every real snapshot, so the worktree
  // condition was a silent PASS for every epic on the board.
  const state = base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: [], repos: ['r1'] }],
    repos: { r1: {
      branches: [{ name: 'feature/a', epic: 'PROJ-1' }],
      worktrees: [{ path: '/w/a', branch: 'feature/a', dirty: { staged: 0, unstaged: 0, untracked: 0 } }],
    } },
  });
  assert.strictEqual(verdictOf(trueDoneReport(state, 'PROJ-1'), 'worktrees'), 'FAIL',
    'a worktree on this epic\'s branch must be found without any `epic` field on the worktree');
});

test('a worktree on a branch radar cannot map is UNKNOWN, never a clear PASS', () => {
  const state = base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: [], repos: ['r1'] }],
    repos: { r1: { branches: [], worktrees: [{ path: '/w/x', branch: 'feature/ghost', dirty: { staged: 0, unstaged: 0, untracked: 0 } }] } },
  });
  const row = trueDoneReport(state, 'PROJ-1').rows.find((x) => x.id === 'worktrees');
  assert.strictEqual(row.verdict, 'UNKNOWN');
  assert.match(row.note, /cannot map/);
});

test('the main checkout is not a teardown obligation', () => {
  const state = base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: [], repos: ['r1'] }],
    repos: { r1: {
      branches: [{ name: 'develop', epic: 'PROJ-1' }],
      worktrees: [{ path: '/repo', branch: 'develop', isMain: true, dirty: { staged: 0, unstaged: 9, untracked: 0 } }],
    } },
  });
  assert.strictEqual(verdictOf(trueDoneReport(state, 'PROJ-1'), 'worktrees'), 'PASS');
});

test('an epic left In Progress in Jira fails — ticking checkboxes is not transitioning', () => {
  const withSignal = trueDoneReport(base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: ['jira-in-progress'], repos: [] }],
  }), 'PROJ-1');
  assert.strictEqual(verdictOf(withSignal, 'jira'), 'FAIL');

  const withDrift = trueDoneReport(base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: [], repos: [] }],
    jiraDrift: [{ epic: 'PROJ-1', note: 'Jira says In Progress but no branch carries this epic' }],
  }), 'PROJ-1');
  assert.strictEqual(verdictOf(withDrift, 'jira'), 'FAIL');
});

test('an open decision on the epic fails', () => {
  const r = trueDoneReport(base({
    epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: 'x', ladder: ladder(), signals: [], repos: [] }],
    attention: [{ type: 'decision', id: 'd7', epic: 'PROJ-1' }],
  }), 'PROJ-1');
  assert.strictEqual(verdictOf(r, 'decisions'), 'FAIL');
  assert.match(r.rows.find((x) => x.id === 'decisions').note, /d7/);
});

test('renderDone says NOT done and never prints a bare "done"', () => {
  const r = renderDone(base({ epics: [{ key: 'PROJ-1', zone: 'active', phrase: 'building', ladder: ladder(), signals: [], repos: [] }] }), 'PROJ-1');
  assert.strictEqual(r.done, false);
  assert.match(r.text, /is NOT done/);
  assert.match(r.text, /PARKED WITH A REASON/);
});

// ---- radar brief ---------------------------------------------------------------------------------

const briefState = () => base({
  epics: [{ key: 'PROJ-1', zone: 'dormant', phrase: '54 commits unpushed', ladder: ladder({ mergedDevelop: 'todo' }), signals: ['unpushed-commits'], repos: ['site'], lastActivityAt: '2026-07-07T00:00:00.000Z' }],
  attention: [
    { type: 'mergeable', epic: 'PROJ-1' },
    { type: 'orphan', repo: 'r1', branch: 'feature/x' },
  ],
  repos: { r1: { worktrees: [{ path: '/w/a', stale: true, staleReason: 'merged', cleanupCommand: "git -C /r1 worktree remove /w/a" }] } },
});

test('the brief invokes the skill on line 1 — deterministic, not description matching', () => {
  const b = buildBrief(briefState(), ['PROJ-1'], {});
  assert.strictEqual(b.text.split('\n')[0], '/radar-handoff');
});

test('the brief carries facts and pointers, and states the end state as a runnable check', () => {
  const b = buildBrief(briefState(), ['PROJ-1', 'worktrees', 'orphans'], {});
  assert.strictEqual(b.items, 3);
  assert.match(b.text, /MERGE {2}epic PROJ-1/, 'a mergeable epic gets the MERGE verb');
  assert.match(b.text, /worktree remove \/w\/a/, 'the verified cleanup command is carried verbatim');
  assert.match(b.text, /r1:feature\/x/);
  assert.match(b.text, /\/recall PROJ-1/, 'context hunt is pointed at, not inlined');
  assert.match(b.text, /radar done <epic>/, 'the end state is checkable, not a sentiment');
  assert.deepStrictEqual(b.unknown, []);
});

test('a selector that resolves to nothing is REPORTED, never silently dropped', () => {
  const b = buildBrief(briefState(), ['PROJ-1', 'PROJ-NOPE'], {});
  assert.deepStrictEqual(b.unknown, ['PROJ-NOPE']);
  assert.match(b.text, /UNRESOLVED SELECTORS/);
  assert.match(b.text, /nothing was invented/);
});

test('a degraded source is stated in the brief — an executor must know a fact may be stale', () => {
  const s = briefState();
  s.sources.deploy = { status: 'error', error: 'token unset' };
  const b = buildBrief(s, ['PROJ-1'], {});
  assert.match(b.text, /SOURCE WARNING: deploy=error/);
});

test('an epic with no mergeable row gets SHIP-OR-PARK, not MERGE', () => {
  const s = briefState();
  s.attention = s.attention.filter((a) => a.type !== 'mergeable');
  assert.match(buildBrief(s, ['PROJ-1'], {}).text, /SHIP-OR-PARK {2}epic PROJ-1/);
});
