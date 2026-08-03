'use strict';
// STORY-005 — `inbox[]` beside the shielded `attention[]` (spec §5.3, §5.4).
//
// Two things are under test and they pull in opposite directions, which is the whole point:
//   the SHIELD  — published `vanished: true` rows must change NOTHING that existed before p9;
//   the INBOX   — and must still appear in the one list that exists to show waiting work.
//
// Everything here is synthesised: invented machine ids, invented session ids on the reserved
// `fixture-inbox-N` grammar, invented paths, invented text, invented timestamps. No live-machine
// state, no clock of its own — `now` is passed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { derive, buildInbox } = require('../radar/derive');
const { candidates } = require('../radar/push');
const { validate } = require('../radar/schema-lite');
const schema = require('../radar/state.schema.json');

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const mins = (n) => n * 60000;
const at = (n) => iso(NOW + mins(n));

// STORY-003 attaches `intent`; this file constructs the shape as a literal so it depends on the
// CONTRACT (§5.2.6/§5.3) and not on `radar/classify.js`.
const intent = (verdict, o) => Object.assign(
  { verdict, reason: 'synthetic reason', model: 'fixture-model', at: at(-1), inferred: true },
  o || {},
);

// The SOURCE surface, as `surfaceOf` emits it — five fields, `tabStatus` among them. The row
// projection must keep exactly four of them.
const sourceSurface = (o) => Object.assign(
  { workspace: 'fixture-ws-ref', tabRef: 'fixture-tab-ref', tabUuid: 'fixture-tab-uuid-1', tabStatus: 'unknown', via: 'recorded' },
  o || {},
);

let seq = 0;
function session(o) {
  const n = ++seq;
  return Object.assign({
    key: { machine: 'fixture-machine-a', sessionId: `fixture-inbox-${n}` },
    transcriptPath: `/synthetic/sessions/fixture-inbox-${n}.jsonl`,
    surface: sourceSurface(),
    surfaceReason: null,
    repo: 'fixture-repo',
    worktree: '/synthetic/worktrees/fixture',
    epic: null,
    status: 'blocked',
    blockedSince: at(-30),
    notificationType: 'idle_prompt',
    lastEventAt: at(-30),
    lastSubmitAt: at(-35),
    lastStopAt: at(-30),
    cacheExpiresAt: at(25),
    cacheApprox: true,
    stale: false,
    observedAt: iso(NOW),
    lastAssistant: { text: 'Synthetic assistant text.', ts: at(-30) },
    intent: intent('needs-decision'),
  }, o);
}

const SOURCES = {
  git: { status: 'ok', observedAt: iso(NOW) },
  sessions: { status: 'ok', observedAt: iso(NOW) },
  deploy: { status: 'disabled' },
  jira: { status: 'disabled' },
  specs: { status: 'disabled' },
  config: { status: 'ok' },
};

function deriveWith(sessions) {
  return derive({
    now: NOW,
    collectorId: 'fixture-collector',
    config: { repos: [] },
    sources: SOURCES,
    aliases: {},
    decisions: [],
    fragments: {
      git: { repos: {} },
      sessions: {
        sessions,
        machines: [{ id: 'fixture-machine-a', bridge: 'ok', lastSeenAt: iso(NOW), eventsStatus: 'ok', stale: false, statusTruncated: false, error: null }],
      },
      specs: { specOrphans: [], epics: {} },
      jira: { epics: {}, drift: [] },
    },
  });
}

const ids = (rows) => rows.map((r) => r.sessionKey.sessionId);

// ---- ordering ------------------------------------------------------------------------------------

test('inbox: three blocked sessions with distinct blockedSince come back oldest-first', () => {
  const a = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-newest' }, blockedSince: at(-5) });
  const b = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-oldest' }, blockedSince: at(-90) });
  const c = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-middle' }, blockedSince: at(-40) });

  // Fed in deliberately out of order, so passing cannot be an accident of input order.
  assert.deepStrictEqual(ids(buildInbox([a, b, c], NOW)), ['fixture-inbox-oldest', 'fixture-inbox-middle', 'fixture-inbox-newest']);
});

// ---- inclusion: verdict --------------------------------------------------------------------------

// EVERY verdict reaches the queue; the verdict is a badge, not a gate. A session that finished, said
// what it did and went quiet is still waiting on the operator — excluding it made the inbox answer
// "Nothing waiting." while sessions sat idle for a reply. What bounds the queue is `status === blocked`
// plus a live `cacheExpiresAt`, both proved by their own tests above.
test('inbox: every verdict reaches the queue, in blockedSince order, verdict carried as a badge', () => {
  const rows = buildInbox([
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-needs' }, blockedSince: at(-40), intent: intent('needs-decision') }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-unknown' }, blockedSince: at(-30), intent: intent('unknown', { model: null }) }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-offer' }, blockedSince: at(-20), intent: intent('offer-more') }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-status' }, blockedSince: at(-10), intent: intent('status-only') }),
  ], NOW);

  assert.deepStrictEqual(ids(rows),
    ['fixture-inbox-needs', 'fixture-inbox-unknown', 'fixture-inbox-offer', 'fixture-inbox-status']);
  // The verdict must survive onto the row, or the badge has nothing to render and the widening just
  // produces four rows a human cannot triage.
  assert.deepStrictEqual(rows.map((r) => r.intent.verdict),
    ['needs-decision', 'unknown', 'offer-more', 'status-only']);
});

test('inbox: MISSING intent is synthesized field-by-field, never copied through as undefined', () => {
  const s = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-nointent' } });
  delete s.intent;
  assert.strictEqual('intent' in s, false, 'precondition: the session really has no intent property');

  const rows = buildInbox([s], NOW);
  assert.strictEqual(rows.length, 1, 'a blocked session with no intent still appears');
  assert.deepStrictEqual(rows[0].intent, {
    verdict: 'unknown', reason: 'intent missing', model: null, at: iso(NOW), inferred: true,
  });
  // Field-by-field: `deepStrictEqual` treats a missing key and an explicit undefined differently
  // enough to be worth stating outright, because the GET route dereferences `intent.verdict` blind.
  assert.deepStrictEqual(Object.keys(rows[0].intent).sort(), ['at', 'inferred', 'model', 'reason', 'verdict']);
  for (const k of Object.keys(rows[0].intent)) assert.notStrictEqual(rows[0].intent[k], undefined, `intent.${k} is not undefined`);
  assert.strictEqual(rows[0].intent.model, null);
  assert.strictEqual(typeof rows[0].intent.at, 'string');
});

// ---- inclusion: the cache deadline ---------------------------------------------------------------

test('inbox: a PAST cacheExpiresAt excludes the row; a NULL deadline does not', () => {
  const expired = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-expired' }, cacheExpiresAt: at(-1) });
  const never = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-nodeadline' }, cacheExpiresAt: null, lastSubmitAt: null });

  assert.deepStrictEqual(ids(buildInbox([expired, never], NOW)), ['fixture-inbox-nodeadline']);
  // A deadline landing exactly on `now` has already closed — the rule is strictly `> now`.
  assert.deepStrictEqual(buildInbox([session({ cacheExpiresAt: iso(NOW) })], NOW), []);
});

test('inbox: with no credential every NON-STALE blocked session appears as unknown, and the expired one still does not', () => {
  // The credential-absent regime (§5.2.5): every blocked session carries unknown · no credential.
  const noCred = intent('unknown', { reason: 'no credential', model: null, at: iso(NOW) });
  const rows = buildInbox([
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-nc-1' }, blockedSince: at(-50), intent: noCred }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-nc-2' }, blockedSince: at(-40), intent: noCred, cacheExpiresAt: null }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-nc-3' }, blockedSince: at(-30), intent: noCred, surface: null, surfaceReason: 'shared-cwd' }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-nc-stale' }, blockedSince: at(-20), intent: noCred, cacheExpiresAt: at(-2) }),
  ], NOW);

  // Rule 2 outranks "all rows appear": the closed window is still excluded.
  assert.deepStrictEqual(ids(rows), ['fixture-inbox-nc-1', 'fixture-inbox-nc-2', 'fixture-inbox-nc-3']);
  for (const r of rows) assert.strictEqual(r.intent.verdict, 'unknown');
});

// ---- inclusion: status ---------------------------------------------------------------------------

test('inbox: abandoned, running and idle sessions never appear, however decisive their verdict', () => {
  const rows = buildInbox([
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-abandoned' }, status: 'abandoned' }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-running' }, status: 'running' }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-idle' }, status: 'idle' }),
  ], NOW);

  assert.deepStrictEqual(rows, []);
});

test('inbox: a vanished blocked session keeps its row — read-only, with the reason on it', () => {
  const rows = buildInbox([
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-vanished' },
      vanished: true, surface: null, surfaceReason: 'recorded-tab-gone',
    }),
  ], NOW);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].surface, null);
  assert.strictEqual(rows[0].surfaceReason, 'recorded-tab-gone');
  assert.strictEqual(rows[0].answerable, false);
  assert.deepStrictEqual(rows[0].actions, []);
});

// ---- the shield ----------------------------------------------------------------------------------

test('LIVESESSIONS SHIELD: published vanished rows change nothing legacy — attention, epics and counts.blocked are identical', () => {
  const live = [
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-live-blocked' }, epic: 'FX-LIVE', blockedSince: at(-45) }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-live-running' }, status: 'running', epic: 'FX-LIVE' }),
  ];
  // Three vanished rows, each carrying something a MISSED derivation would leak: a blocked status
  // (attention + counts.blocked), an epic that exists nowhere else (the epic universe), and — the
  // one that only an unshielded `ctx.sessions` exposes — a session on an epic that DOES exist, whose
  // event clock is newer than anything live, so a leak moves that epic's lastActivityAt.
  const vanished = [
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-gone-1' }, epic: 'FX-GONE', vanished: true, surface: null, surfaceReason: 'recorded-tab-gone', blockedSince: at(-70) }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-gone-2' }, epic: 'FX-GONE-2', vanished: true, surface: null, surfaceReason: 'recorded-tab-gone', blockedSince: at(-60) }),
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-gone-3' }, epic: 'FX-LIVE',
      vanished: true, surface: null, surfaceReason: 'recorded-tab-gone',
      blockedSince: at(-55), lastEventAt: at(-1), notificationType: 'permission_request',
    }),
  ];

  const before = deriveWith(live);                      // the pre-p9 shape: vanished rows stripped
  const after = deriveWith(live.concat(vanished));      // the p9 shape: vanished rows published

  assert.deepStrictEqual(after.attention, before.attention);
  assert.strictEqual(after.counts.blocked, before.counts.blocked);
  assert.deepStrictEqual(after.epics, before.epics);
  const withoutInbox = (c) => { const x = Object.assign({}, c); delete x.inbox; return x; };
  assert.deepStrictEqual(withoutInbox(after.counts), withoutInbox(before.counts));

  // …and the shield is not achieved by dropping the rows: they are published, and they are queued.
  assert.strictEqual(after.sessions.length, 5);
  assert.deepStrictEqual(ids(before.inbox), ['fixture-inbox-live-blocked']);
  assert.deepStrictEqual(ids(after.inbox), ['fixture-inbox-gone-1', 'fixture-inbox-gone-2', 'fixture-inbox-gone-3', 'fixture-inbox-live-blocked']);
  // The negative control: without a shield these are exactly the values that would have moved.
  assert.strictEqual(before.attention.length, 1);
  assert.strictEqual(before.counts.blocked, 1);
  assert.deepStrictEqual(before.epics.map((e) => e.key), ['FX-LIVE']);
  assert.strictEqual(before.epics[0].lastActivityAt, at(-30));
});

test('PUSH SHIELD: candidates() over a state with vanished rows is deep-equal to the same state without them', () => {
  const liveBlocked = session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-push-live' }, blockedSince: at(-30) });
  // Both candidate branches are armed on this one: blocked > 10 min AND a cache window closing
  // inside 20 min. Without the filter it would contribute two push events.
  const vanishedBlocked = session({
    key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-push-gone' },
    vanished: true, surface: null, surfaceReason: 'recorded-tab-gone',
    blockedSince: at(-40), cacheExpiresAt: at(10),
  });

  const withVanished = { sessions: [liveBlocked, vanishedBlocked], attention: [], repos: {} };
  const withoutVanished = { sessions: [liveBlocked], attention: [], repos: {} };

  const expected = candidates(withoutVanished, NOW);
  assert.ok(expected.length > 0, 'precondition: the live session really is a candidate');
  assert.deepStrictEqual(candidates(withVanished, NOW), expected);

  // And on its own a vanished row is worth no notification at all.
  assert.deepStrictEqual(candidates({ sessions: [vanishedBlocked], attention: [], repos: {} }, NOW), []);
  // The negative control: the same row, not vanished, would have produced both events.
  const notVanished = Object.assign({}, vanishedBlocked); delete notVanished.vanished;
  assert.deepStrictEqual(
    candidates({ sessions: [notVanished], attention: [], repos: {} }, NOW).map((c) => c.type).sort(),
    ['blocked', 'cache-expiring'],
  );
});

// ---- the row contract ----------------------------------------------------------------------------

test('inbox: question is the COMPLETE assistant text; a null lastAssistant gives the empty string and an unknown verdict', () => {
  const long = 'Synthetic paragraph for the row contract, long enough to prove nothing truncates it. '.repeat(30);
  assert.ok(long.length > 2000, 'precondition: the fixture text really is 2000+ characters');

  const rows = buildInbox([
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-long' }, blockedSince: at(-50), lastAssistant: { text: long, ts: at(-50) } }),
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-notext' }, blockedSince: at(-40),
      lastAssistant: null, intent: intent('unknown', { reason: 'no transcript text', model: null }),
    }),
  ], NOW);

  assert.strictEqual(rows[0].question, long);
  assert.strictEqual(rows[0].question.length, long.length);
  assert.ok(!/…|\.\.\./.test(rows[0].question), 'no ellipsis of either spelling');

  assert.strictEqual(rows[1].question, '');
  assert.strictEqual(rows[1].intent.verdict, 'unknown');
  assert.strictEqual(rows[1].turn.assistantTs, null);
});

test('inbox: one emitted row matches specs.md 5.3 field-by-field, and the surface projects EXACTLY four fields', () => {
  const src = session({
    key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-contract' },
    epic: 'FX-CONTRACT', repo: 'fixture-repo', worktree: '/synthetic/worktrees/fixture',
    blockedSince: at(-33), lastStopAt: at(-33), cacheExpiresAt: at(27),
    lastAssistant: { text: 'Synthetic assistant text.', ts: at(-33) },
  });
  assert.strictEqual(src.surface.tabStatus, 'unknown', 'precondition: the SOURCE surface carries tabStatus');

  const [r] = buildInbox([src], NOW);

  assert.deepStrictEqual(Object.keys(r).sort(), [
    'actions', 'answerable', 'blockedSince', 'cacheApprox', 'cacheExpiresAt', 'epic', 'intent',
    'lastStopAt', 'notificationType', 'question', 'repo', 'sessionKey', 'surface', 'surfaceReason',
    'turn', 'worktree',
  ]);
  for (const k of Object.keys(r)) assert.notStrictEqual(r[k], undefined, `row.${k} is not undefined`);

  assert.deepStrictEqual(r.sessionKey, { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-contract' });
  assert.strictEqual(r.blockedSince, at(-33));
  assert.strictEqual(typeof r.blockedSince, 'string');
  assert.strictEqual(r.lastStopAt, at(-33));
  assert.strictEqual(r.cacheExpiresAt, at(27));
  assert.strictEqual(r.cacheApprox, true);
  assert.strictEqual(r.notificationType, 'idle_prompt');
  assert.strictEqual(typeof r.notificationType, 'string');
  assert.strictEqual(r.repo, 'fixture-repo');
  assert.strictEqual(r.worktree, '/synthetic/worktrees/fixture');
  assert.strictEqual(r.epic, 'FX-CONTRACT');
  assert.strictEqual(typeof r.question, 'string');
  assert.strictEqual(typeof r.answerable, 'boolean');
  assert.ok(Array.isArray(r.actions));

  // turn — the identity token the reply echoes.
  assert.deepStrictEqual(Object.keys(r.turn).sort(), ['assistantTs', 'blockedSince']);
  assert.strictEqual(r.turn.blockedSince, r.blockedSince, 'turn.blockedSince is the row value verbatim');
  assert.strictEqual(typeof r.turn.blockedSince, 'string');
  assert.strictEqual(r.turn.assistantTs, at(-33));

  // surface — exactly four fields, each typed, none coerced to null.
  assert.deepStrictEqual(Object.keys(r.surface).sort(), ['tabRef', 'tabUuid', 'via', 'workspace']);
  assert.strictEqual('tabStatus' in r.surface, false, 'tabStatus is NOT projected');
  assert.strictEqual(r.surface.workspace, 'fixture-ws-ref');
  assert.strictEqual(r.surface.tabRef, 'fixture-tab-ref');
  assert.strictEqual(r.surface.tabUuid, 'fixture-tab-uuid-1');
  assert.strictEqual(typeof r.surface.tabUuid, 'string');
  assert.strictEqual(r.surface.via, 'recorded');
  assert.strictEqual(r.surfaceReason, null);

  // A resolved surface with a null workspace/tabRef stays null-typed rather than vanishing.
  const [bare] = buildInbox([session({ surface: sourceSurface({ workspace: null, tabRef: null }) })], NOW);
  assert.strictEqual(bare.surface.workspace, null);
  assert.strictEqual(bare.surface.tabRef, null);
  assert.deepStrictEqual(Object.keys(bare.surface).sort(), ['tabRef', 'tabUuid', 'via', 'workspace']);
});

// ---- answerable ----------------------------------------------------------------------------------

test('inbox: answerable follows the surface AND the notification type — and there is no dismiss on either side', () => {
  const rows = buildInbox([
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-resolved' }, blockedSince: at(-50) }),
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-tabgone' }, blockedSince: at(-40),
      surface: null, surfaceReason: 'recorded-tab-gone',
    }),
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-permission' }, blockedSince: at(-30),
      notificationType: 'permission_request',
    }),
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-needsinput' }, blockedSince: at(-20),
      notificationType: 'agent_needs_input',
    }),
  ], NOW);

  assert.deepStrictEqual(rows.map((r) => [r.sessionKey.sessionId, r.answerable]), [
    ['fixture-inbox-resolved', true],
    ['fixture-inbox-tabgone', false],
    ['fixture-inbox-permission', false],   // waiting on a MENU, not on text
    ['fixture-inbox-needsinput', true],    // allowlisted, however rare
  ]);
  assert.deepStrictEqual(rows[0].actions, [{ kind: 'reply' }]);
  assert.deepStrictEqual(rows[1].actions, []);
  assert.deepStrictEqual(rows[2].actions, []);
  assert.deepStrictEqual(rows[3].actions, [{ kind: 'reply' }]);
  for (const r of rows) {
    for (const a of r.actions) assert.strictEqual(a.kind, 'reply', 'reply is the only action kind an inbox row carries');
  }
});

test('HEURISTIC ROW: a cwd-joined surface with a live tabUuid is still read-only', () => {
  const [r] = buildInbox([
    session({
      key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-cwd' },
      surface: sourceSurface({ via: 'cwd', tabUuid: 'fixture-tab-uuid-live' }),
      notificationType: 'idle_prompt',
    }),
  ], NOW);

  assert.strictEqual(r.surface.tabUuid, 'fixture-tab-uuid-live', 'the tab really is live and joined');
  assert.strictEqual(r.surface.via, 'cwd');
  assert.strictEqual(r.answerable, false, 'a guess about WHICH terminal is not an action gate 2 would honour');
  assert.deepStrictEqual(r.actions, []);
});

// ---- counts and the published contract -----------------------------------------------------------

test('inbox: counts.inbox comes from the list, survives a mutated attention[], and the published state validates', () => {
  // Schema-validated fixture: blocked / running / idle only — $defs.session.status has no
  // `abandoned` (pre-existing drift, trap 21).
  const sessions = [
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-pub-1' }, blockedSince: at(-60) }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-pub-2' }, blockedSince: at(-50), surface: null, surfaceReason: 'recorded-tab-gone', vanished: true }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-pub-3' }, blockedSince: at(-40), notificationType: 'permission_request' }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-pub-4' }, status: 'running' }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-pub-5' }, status: 'idle' }),
  ];
  const state = deriveWith(sessions);

  assert.strictEqual(state.counts.inbox, state.inbox.length);
  assert.strictEqual(state.counts.inbox, 3);

  // counts.inbox is a fact about the queue, not about anything a renderer slices.
  const n = state.counts.inbox;
  state.attention.push({ type: 'blocked', sessionKey: { machine: 'x', sessionId: 'y' }, deadline: null, actions: [] });
  state.attention.length = 0;
  assert.strictEqual(state.counts.inbox, n);
  assert.strictEqual(state.counts.inbox, state.inbox.length);

  const res = validate(schema, state);
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(res.valid, true);
  assert.ok(state.inbox.length > 0, 'the validated snapshot really carries inbox rows');
});

test('schema: inbox is declared but never required — root.required and counts.required are unchanged', () => {
  assert.ok(schema.properties.inbox, 'inbox[] is declared at the closed root');
  assert.strictEqual(schema.required.indexOf('inbox'), -1, 'inbox is NOT required at the root');
  assert.ok(schema.properties.counts.properties.inbox, 'counts.inbox is declared in the closed counts object');
  assert.deepStrictEqual(schema.properties.counts.required,
    ['blocked', 'decisions', 'mergeable', 'orphans', 'staleWorktrees', 'handoffsLive'],
    'counts.required is byte-for-byte what it was before p9');
});

test('schema: all four committed state fixtures still validate unmodified', () => {
  const dir = path.join(__dirname, '..', 'radar', 'fixtures');
  const names = fs.readdirSync(dir).filter((f) => /^state\..*\.json$/.test(f)).sort();
  assert.strictEqual(names.length, 4, 'four committed fixtures');
  for (const name of names) {
    const res = validate(schema, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    assert.deepStrictEqual(res.errors, [], `${name} validates`);
  }
});

test('inbox: every emitted row carries intent.inferred === true, whatever produced the verdict', () => {
  const rows = buildInbox([
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-inf-1' }, blockedSince: at(-60), intent: intent('needs-decision') }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-inf-2' }, blockedSince: at(-50), intent: intent('unknown', { reason: 'classifier unreachable', model: null }) }),
    // Attached without the flag at all, and with it explicitly falsified: the row projection is what
    // makes `inferred` true, so neither can publish a row claiming a human decided this.
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-inf-3' }, blockedSince: at(-40), intent: { verdict: 'needs-decision', reason: 'r', model: 'fixture-model', at: at(-1) } }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-inf-4' }, blockedSince: at(-30), intent: intent('unknown', { inferred: false }) }),
    session({ key: { machine: 'fixture-machine-a', sessionId: 'fixture-inbox-inf-5' }, blockedSince: at(-20), intent: undefined }),
  ], NOW);

  assert.strictEqual(rows.length, 5);
  for (const r of rows) assert.strictEqual(r.intent.inferred, true, `${r.sessionKey.sessionId} carries inferred: true`);
});
