'use strict';
// S-001 — the fold's p9 edits and the three primitives the reply route needs.
//
// Everything here is synthetic: invented session ids, invented tab ids, invented paths. This
// repository is public and a real transcript, id or home path in a fixture is the one mistake that
// cannot be taken back.
//
// The reply route (S-007) and the inbox derivation (S-005) do not exist yet, so the ACs
// that end "...and a POST for it is refused" / "...derives answerable" are proved at THIS layer, on
// the exact values those two consume: the fold's per-field recorded identity, what `joinRecorded`
// answers for it, and §5.3's answerable predicate restated once below.
const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const mod = require('../radar/mod-sessions');
const eventlog = require('../radar/eventlog');
const { fragmentsFromState } = require('../radar/collector');
const { derive } = require('../radar/derive');
const { validate } = require('../radar/schema-lite');
const schema = require('../radar/state.schema.json');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'p9-fold-'));

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const min = (n) => n * 60 * 1000;

const ev = (over) => Object.assign({
  ts: NOW - min(5), sessionId: 's-1', transcriptPath: '/t/s-1.jsonl', cwd: '/repo/app-web',
  event: 'UserPromptSubmit', notificationType: null,
}, over);
const blocking = (over) => ev(Object.assign({ event: 'Notification', notificationType: 'idle_prompt' }, over));

const CONFIG = { repos: [{ id: 'app-web', path: '/repo/app-web', defaultBranches: ['develop', 'main'] }], timeouts: { bridgeMs: 500 } };
const REMOTE = [{ id: 'machine-b', baseUrl: 'http://machine-b:8799', secretRef: 'X_SECRET' }];

const term = (id, over) => Object.assign({ id, ref: `tab:${id}`, type: 'terminal', status: 'Running', statusCovered: true }, over);
const tree = (tabs) => ({ workspaces: [{ ref: 'workspace:2', title: 'app', tabs }] });
const ROOTS = { roots: [{ kind: 'workspace', label: 'app', path: '/repo/app-web' }] };

function stubBridge(spec) {
  const s = spec || {};
  return async (url) => {
    if (url.includes('/cmux/session-events')) {
      if (!s.events) return { ok: false, status: 503, json: null };
      return { ok: true, status: 200, json: { machineId: 'machine-b', events: s.events, more: false } };
    }
    if (url.includes('/cmux/tree')) return s.tree ? { ok: true, status: 200, json: s.tree } : { ok: false, status: 503, json: null };
    if (url.includes('/cmux/fs/roots')) return s.roots ? { ok: true, status: 200, json: s.roots } : { ok: false, status: 503, json: null };
    return { ok: false, status: 404, json: null };
  };
}

const collect = (spec, over) => mod.collectSessions(Object.assign({
  config: CONFIG, aliases: {}, now: NOW, paths: {}, bridges: REMOTE, http: stubBridge(spec),
}, over || {}));

const one = (frag) => { assert.strictEqual(frag.sessions.length, 1, 'expected exactly one session'); return frag.sessions[0]; };

// The assembly, driven directly, for the cases that are about one fold rather than one sweep.
const assemble = (events, t, roots) => mod.sessionsForMachine(
  { bridge: { id: 'machine-b' }, events, tree: t || null, roots: roots === undefined ? ROOTS : roots },
  { now: NOW, config: CONFIG, aliases: {}, prevByMachine: new Map() }).sessions;

// §5.3's rule, restated once because S-005 owns the implementation: a row may be answered only
// when it names a tab that RECORDED identity resolved, and is waiting on text rather than on a menu.
const answerable = (s) => !!(s.surface && s.surface.tabUuid && s.surface.via === 'recorded'
  && (s.notificationType === 'idle_prompt' || s.notificationType === 'agent_needs_input'));

// §5.1.5's one shared completeness predicate. A read that trips any arm of it is not authoritative,
// whatever its HTTP status said.
const authoritative = (r) => !r.error && r.skipped === 0 && r.more !== true;

const REMOTE_BRIDGE = { id: 'machine-b', baseUrl: 'http://machine-b:8799' };

// `sources` is closed and every module must appear; only the sessions entry varies here.
const sourcesWith = (sessions) => ({
  git: { status: 'ok' }, deploy: { status: 'ok' }, jira: { status: 'ok' },
  specs: { status: 'ok' }, config: { status: 'ok' },
  sessions: { status: sessions.status, observedAt: sessions.observedAt },
});

// ---- the allowlist ------------------------------------------------------------------------------

test('agent_needs_input blocks, and carries its own subtype through to the row', async () => {
  const events = [blocking({ ts: NOW - min(3), notificationType: 'agent_needs_input' })];
  const f = mod.foldSession('machine-b', 's-1', events);
  assert.strictEqual(mod.sessionStatusOf(f, NOW), 'blocked');
  assert.strictEqual(f.notificationType, 'agent_needs_input');

  const s = one((await collect({ events })).fragment);
  assert.strictEqual(s.status, 'blocked');
  assert.strictEqual(s.notificationType, 'agent_needs_input');
  assert.strictEqual(s.blockedSince, new Date(NOW - min(3)).toISOString());
});

test('the blocking set stays an ALLOWLIST — an unlisted subtype is inert', async () => {
  const f = mod.foldSession('machine-b', 's-1', [blocking({ ts: NOW - min(3), notificationType: 'followup_prompt' })]);
  assert.strictEqual(f.blockedSince, null);
  assert.strictEqual(f.notificationType, null);
  assert.notStrictEqual(mod.sessionStatusOf(f, NOW), 'blocked');

  const s = one((await collect({ events: [blocking({ ts: NOW - min(3), notificationType: 'followup_prompt' })] })).fragment);
  assert.notStrictEqual(s.status, 'blocked');
  // Three named values, never a pattern: roughly twenty subtypes exist and the rest must stay inert.
  assert.deepStrictEqual([...mod.BLOCKING_NOTIFICATIONS].sort(), ['agent_needs_input', 'idle_prompt', 'permission_prompt']);
});

// ---- lastStopAt ---------------------------------------------------------------------------------

const ROW_KEYS = [
  'blockedSince', 'cacheApprox', 'cacheExpiresAt', 'epic', 'key', 'lastEventAt', 'lastStopAt',
  'lastSubmitAt', 'notificationType', 'observedAt', 'repo', 'stale', 'status', 'surface',
  'surfaceReason', 'transcriptPath', 'worktree',
];

test('lastStopAt reaches the row when the turn ended, and is null when it never did', async () => {
  // The real waiting shape: a turn ends, then ~63 s later the idle_prompt notification lands.
  const stopped = await collect({
    events: [
      blocking({ ts: NOW - min(9) }),
      ev({ ts: NOW - min(4), event: 'Stop' }),
      blocking({ ts: NOW - min(3) }),
    ],
  });
  const s = one(stopped.fragment);
  assert.strictEqual(s.lastStopAt, new Date(NOW - min(4)).toISOString());
  assert.strictEqual(s.status, 'blocked');

  const never = one((await collect({ events: [blocking({ ts: NOW - min(3) })] })).fragment);
  assert.strictEqual(never.lastStopAt, null);
  assert.deepStrictEqual(Object.keys(never).sort(), ROW_KEYS, 'lastStopAt is the only new field on a live row');
});

// ---- vanished rows ------------------------------------------------------------------------------

const VANISH_EVENTS = [blocking({ ts: NOW - min(20), surfaceId: 'TAB-1' })];

// Sweep 1 joins TAB-1; sweep 2 sees a tree that no longer has it. TAB-2 is the workspace's only
// terminal, so the cwd heuristic would resolve it instantly if anything let it near this path.
const vanishSweep = async () => {
  const first = await collect({ events: VANISH_EVENTS, tree: tree([term('TAB-1')]), roots: ROOTS });
  assert.strictEqual(one(first.fragment).surface.tabUuid, 'TAB-1');
  const second = await collect({ events: VANISH_EVENTS, tree: tree([term('TAB-2')]), roots: ROOTS }, { prev: first.fragment });
  return { first, second };
};

test('a blocked session whose tab left a fetched tree is published vanished, envelope unchanged', async () => {
  const { second } = await vanishSweep();
  const s = one(second.fragment);
  assert.strictEqual(s.vanished, true);
  assert.strictEqual(s.surface, null);
  assert.strictEqual(s.surfaceReason, 'recorded-tab-gone');
  assert.strictEqual(s.status, 'blocked');
  assert.deepStrictEqual(Object.keys(second).sort(), ['fragment', 'source', 'warnings']);
  assert.deepStrictEqual(Object.keys(second.fragment).sort(), ['machines', 'sessions']);
});

test('the vanished flag survives sweep after sweep, carried by the PUBLISHED rows', async () => {
  const { second } = await vanishSweep();
  let frag = second.fragment;
  for (let sweep = 3; sweep <= 5; sweep++) {
    // Exactly the collector's carry-forward: the previous sweep's published rows, round-tripped
    // through JSON the way state.json stores them.
    const published = JSON.parse(JSON.stringify({ repos: {}, sessions: frag.sessions, machines: frag.machines }));
    const prev = fragmentsFromState(published).sessions;
    const r = await collect({ events: VANISH_EVENTS, tree: tree([term('TAB-2')]), roots: ROOTS }, { prev });
    const s = one(r.fragment);
    assert.strictEqual(s.vanished, true, `sweep ${sweep}: still vanished`);
    assert.strictEqual(s.surface, null, `sweep ${sweep}: the live TAB-2 is not a substitute`);
    assert.strictEqual(s.surfaceReason, 'recorded-tab-gone', `sweep ${sweep}`);
    frag = r.fragment;
  }
});

test('a vanished row leaves on a clearing event and on ABANDON_MS — both exit paths', async () => {
  const { second } = await vanishSweep();
  const answered = await collect(
    { events: VANISH_EVENTS.concat([ev({ ts: NOW - min(1), event: 'UserPromptSubmit' })]), tree: tree([term('TAB-2')]), roots: ROOTS },
    { prev: second.fragment });
  assert.deepStrictEqual(answered.fragment.sessions, [], 'answered');

  const aged = await collect(
    { events: [blocking({ ts: NOW - mod.ABANDON_MS - min(5), surfaceId: 'TAB-1' })], tree: tree([term('TAB-2')]), roots: ROOTS },
    { prev: second.fragment });
  assert.deepStrictEqual(aged.fragment.sessions, [], 'aged out');
});

test('a session whose tab vanished but whose status is not blocked appears nowhere', async () => {
  const first = await collect({ events: VANISH_EVENTS, tree: tree([term('TAB-1')]), roots: ROOTS });
  const cases = {
    idle: VANISH_EVENTS.concat([ev({ ts: NOW - min(8), event: 'Stop' })]),
    abandoned: [blocking({ ts: NOW - mod.ABANDON_MS - min(5), surfaceId: 'TAB-1' })],
  };
  for (const [name, events] of Object.entries(cases)) {
    assert.strictEqual(mod.sessionStatusOf(mod.foldSession('machine-b', 's-1', events), NOW), name);
    const r = await collect({ events, tree: tree([term('TAB-2')]), roots: ROOTS }, { prev: first.fragment });
    assert.deepStrictEqual(r.fragment.sessions, [], name);
  }
});

// ---- the three primitives -----------------------------------------------------------------------

test('sessionStatusOf agrees with the assembly at every boundary', () => {
  const cases = [
    ['blocked', [blocking({ ts: NOW - mod.ABANDON_MS + 1 })]],
    ['blocked', [blocking({ ts: NOW - mod.ABANDON_MS })]],
    ['abandoned', [blocking({ ts: NOW - mod.ABANDON_MS - 1 })]],
    ['running', [ev({ ts: NOW - mod.RUNNING_WINDOW_MS, event: 'PostToolUse' })]],
    ['idle', [ev({ ts: NOW - mod.RUNNING_WINDOW_MS - 1, event: 'PostToolUse' })]],
  ];
  for (const [want, events] of cases) {
    const direct = mod.sessionStatusOf(mod.foldSession('machine-b', 's-1', events), NOW);
    assert.strictEqual(direct, want, `${want}: the extracted helper`);
    assert.strictEqual(assemble(events)[0].status, want, `${want}: the assembly, on the same fold`);
  }
});

test('the exported joinRecorded answers exactly what the assembly joins with', () => {
  const t = tree([term('TAB-1'), term('TAB-2')]);
  const idx = mod.buildSurfaceIndex(t, ROOTS);
  const cases = [
    { surfaceId: 'TAB-1', tabId: null },
    { surfaceId: null, tabId: 'TAB-2' },
    { surfaceId: 'TAB-GONE', tabId: null },
    { surfaceId: null, tabId: null },
  ];
  for (const recorded of cases) {
    const direct = mod.joinRecorded(idx, recorded);
    const over = {};
    if (recorded.surfaceId) over.surfaceId = recorded.surfaceId;
    if (recorded.tabId) over.tabId = recorded.tabId;
    const [row] = assemble([blocking(Object.assign({ ts: NOW - min(2) }, over))], t);
    const label = JSON.stringify(recorded);
    if (direct && direct.surface) {
      assert.deepStrictEqual(row.surface, direct.surface, label);
      assert.strictEqual(row.surfaceReason, null, label);
    } else if (direct) {
      assert.strictEqual(row.surface, null, label);
      assert.strictEqual(row.surfaceReason, direct.reason, label);
    } else {
      // null means "this session named no tab", which is the only case that reaches the heuristic —
      // and two terminals in one workspace is exactly what the heuristic cannot resolve.
      assert.strictEqual(row.surfaceReason, 'ambiguous-tabs:2', label);
    }
  }
});

test('readMachineEvents reports every completeness field on BOTH transports', async () => {
  const dir = await tmp();
  const lines = [];
  for (let i = 0; i <= eventlog.MAX_PAGE; i++) lines.push(JSON.stringify(ev({ ts: NOW - min(30) + i, sessionId: `s-${i}` })));
  await fsp.writeFile(path.join(dir, `${eventlog.utcDay(NOW)}.ndjson`), lines.join('\n') + '\n');
  const local = await mod.readMachineEvents({ id: 'machine-b', local: true }, { now: NOW, paths: { events: dir } });
  assert.strictEqual(local.more, true, 'the local reader pages too, and says so');
  assert.strictEqual(authoritative(local), false);
  await fsp.rm(dir, { recursive: true, force: true });

  const skipped = await mod.readMachineEvents(REMOTE_BRIDGE, {
    now: NOW, http: async () => ({ ok: true, status: 200, json: { events: [], more: false, skipped: 1 } }),
  });
  assert.strictEqual(skipped.skipped, 1, 'the remote page reports damaged lines');
  assert.strictEqual(authoritative(skipped), false);

  // The bridge's own unreadable-directory answer, byte for byte: HTTP 200 with an error in it.
  const unreadable = await mod.readMachineEvents(REMOTE_BRIDGE, {
    now: NOW, http: async () => ({ ok: true, status: 200, json: { events: [], more: false, error: 'events_unreadable' } }),
  });
  assert.strictEqual(unreadable.error, 'events_unreadable', 'a success envelope is not a successful read');
  assert.strictEqual(authoritative(unreadable), false);
});

test('a damaged local log, a truncated remote page and a dead remote each report themselves', async () => {
  const dir = await tmp();
  // A directory where a day file belongs: readable name, unreadable content, on every filesystem.
  await fsp.mkdir(path.join(dir, `${eventlog.utcDay(NOW - eventlog.DAY_MS)}.ndjson`));
  await fsp.writeFile(path.join(dir, `${eventlog.utcDay(NOW)}.ndjson`), JSON.stringify(ev({ ts: NOW - min(5) })) + '\n');
  const damaged = await mod.readMachineEvents({ id: 'machine-b', local: true }, { now: NOW, paths: { events: dir } });
  assert.strictEqual(damaged.skipped > 0, true, 'the unread file is counted, not silently dropped');
  assert.strictEqual(damaged.events.length, 1, 'and what WAS readable still comes back');
  assert.strictEqual(authoritative(damaged), false);
  await fsp.rm(dir, { recursive: true, force: true });

  const truncated = await mod.readMachineEvents(REMOTE_BRIDGE, {
    now: NOW, http: async () => ({ ok: true, status: 200, json: { events: [], more: true } }),
  });
  assert.strictEqual(truncated.more, true);
  assert.strictEqual(authoritative(truncated), false);

  const dead = await mod.readMachineEvents(REMOTE_BRIDGE, { now: NOW, http: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual(dead.events, null);
  assert.match(dead.error, /session-events: ECONNREFUSED/);
  assert.strictEqual(authoritative(dead), false);
});

// ---- turn-truthful recorded identity, per field ---------------------------------------------------

test('an event carrying NEITHER recorded field clears both', () => {
  const shapes = {
    'surface only': { surfaceId: 'TAB-1' },
    'both fields': { surfaceId: 'TAB-1', tabId: 'TAB-T' },
  };
  for (const [name, old] of Object.entries(shapes)) {
    // The newer turn is the hook's explicit signature for a session hosted outside cmux.
    const events = [blocking(Object.assign({ ts: NOW - min(20) }, old)), blocking({ ts: NOW - min(2) })];
    const f = mod.foldSession('machine-b', 's-1', events);
    assert.strictEqual(f.surfaceId, null, name);
    assert.strictEqual(f.tabId, null, name);

    // Nothing to contest and nothing to join: the recorded-only join has no answer at all, which is
    // the no-claim branch the reply route refuses at.
    const t = tree([term('TAB-1'), term('TAB-T')]);
    assert.strictEqual(mod.joinRecorded(mod.buildSurfaceIndex(t, ROOTS), { surfaceId: f.surfaceId, tabId: f.tabId }), null, name);
    const [row] = assemble(events, t);
    assert.strictEqual(row.surfaceReason, 'ambiguous-tabs:2', `${name}: no stale pane inherited`);
    assert.strictEqual(answerable(row), false, name);
  }

  // CONTROL: a newer event that DOES record an identity replaces the old one.
  const moved = mod.foldSession('machine-b', 's-1', [
    blocking({ ts: NOW - min(20), surfaceId: 'TAB-1' }),
    blocking({ ts: NOW - min(2), surfaceId: 'TAB-2' }),
  ]);
  assert.strictEqual(moved.surfaceId, 'TAB-2');
});

test('a one-field event clears its counterpart — there is no per-field stale fallback', () => {
  // SURFACE-ONLY. The old tabId T1 is live in the tree; the new surfaceId S2 is not. Carrying T1
  // across the event that omitted it would let the recorded join fall through to a tab this
  // session no longer occupies, while the reply route's contest — seeing this same session as T1's
  // latest claimant — waved it through.
  const surfaceOnly = [
    blocking({ ts: NOW - min(20), surfaceId: 'TAB-S1', tabId: 'TAB-T1' }),
    blocking({ ts: NOW - min(2), surfaceId: 'TAB-S2' }),
  ];
  const f = mod.foldSession('machine-b', 's-1', surfaceOnly);
  assert.strictEqual(f.surfaceId, 'TAB-S2');
  assert.strictEqual(f.tabId, null, 'T1 did not survive');

  const live = tree([term('TAB-T1'), term('TAB-S1')]);
  const idx = mod.buildSurfaceIndex(live, ROOTS);
  const j = mod.joinRecorded(idx, { surfaceId: f.surfaceId, tabId: f.tabId });
  assert.strictEqual(j.surface, null, 'the fallthrough has no tabId left to reach');
  assert.strictEqual(j.reason, 'recorded-tab-gone');
  const [row] = assemble(surfaceOnly, live);
  assert.strictEqual(row.surface, null);
  assert.strictEqual(row.surfaceReason, 'recorded-tab-gone');
  assert.strictEqual(answerable(row), false);

  // TAB-ONLY, the mirror: the live S1 is never joined either.
  const tabOnly = [
    blocking({ ts: NOW - min(20), surfaceId: 'TAB-S1', tabId: 'TAB-T1' }),
    blocking({ ts: NOW - min(2), tabId: 'TAB-T2' }),
  ];
  const g = mod.foldSession('machine-b', 's-1', tabOnly);
  assert.strictEqual(g.surfaceId, null);
  assert.strictEqual(g.tabId, 'TAB-T2');
  const [mirror] = assemble(tabOnly, live);
  assert.strictEqual(mirror.surface, null);
  assert.strictEqual(mirror.surfaceReason, 'recorded-tab-gone');

  // CONTROL: an event carrying BOTH fields replaces both.
  const both = mod.foldSession('machine-b', 's-1', [
    blocking({ ts: NOW - min(20), surfaceId: 'TAB-S1', tabId: 'TAB-T1' }),
    blocking({ ts: NOW - min(2), surfaceId: 'TAB-S2', tabId: 'TAB-T2' }),
  ]);
  assert.strictEqual(both.surfaceId, 'TAB-S2');
  assert.strictEqual(both.tabId, 'TAB-T2');
});

// ---- surface provenance ---------------------------------------------------------------------------

test('surface.via records HOW the tab was identified, and carries through a tree outage', async () => {
  const recEvents = [blocking({ ts: NOW - min(2), surfaceId: 'TAB-1' })];
  const rec = await collect({ events: recEvents, tree: tree([term('TAB-1'), term('TAB-2')]), roots: ROOTS });
  assert.strictEqual(one(rec.fragment).surface.via, 'recorded');
  assert.strictEqual(answerable(one(rec.fragment)), true);

  const cwdEvents = [blocking({ ts: NOW - min(2) })];
  const heur = await collect({ events: cwdEvents, tree: tree([term('TAB-1')]), roots: ROOTS });
  assert.strictEqual(one(heur.fragment).surface.via, 'cwd');
  assert.strictEqual(one(heur.fragment).surface.tabUuid, 'TAB-1');
  assert.strictEqual(answerable(one(heur.fragment)), false, 'a guess about WHICH terminal is not a write target');

  for (const [name, good, events] of [['recorded', rec, recEvents], ['cwd', heur, cwdEvents]]) {
    const down = await collect({ events, tree: null, roots: null }, { prev: good.fragment });
    const s = one(down.fragment);
    assert.strictEqual(s.surface.tabUuid, good.fragment.sessions[0].surface.tabUuid, name);
    assert.strictEqual(s.surface.via, name, `${name}: an outage does not change how we knew`);
  }
});

test('a pre-p9 surface with no provenance is DROPPED on a tree outage, never blessed', async () => {
  const events = [blocking({ ts: NOW - min(2), surfaceId: 'TAB-1' })];
  // A snapshot written before `via` existed. Nothing ever proved how this tab was identified.
  const legacy = { sessions: [{
    key: { machine: 'machine-b', sessionId: 's-1' }, status: 'blocked',
    surface: { workspace: 'workspace:2', tabRef: 'tab:TAB-1', tabUuid: 'TAB-1', tabStatus: 'Running' },
  }] };

  const outage = await collect({ events, tree: null, roots: null }, { prev: legacy });
  const s = one(outage.fragment);
  assert.strictEqual(s.surface, null);
  assert.strictEqual(s.surfaceReason, 'tree-unavailable');
  assert.strictEqual(answerable(s), false, 'read-only until something proves the identity again');
  const state = derive({ now: NOW, collectorId: 'machine-a', sources: sourcesWith(outage.source), fragments: { sessions: outage.fragment } });
  assert.deepStrictEqual(validate(schema, state).errors, []);
  assert.deepStrictEqual(state.attention.find((a) => a.type === 'blocked').actions, [], 'and no Jump either');

  const back = await collect({ events, tree: tree([term('TAB-1')]), roots: ROOTS }, { prev: outage.fragment });
  assert.strictEqual(one(back.fragment).surface.via, 'recorded', 'a fresh tree mints a real one');
});

// ---- vanished recovery -----------------------------------------------------------------------------

test('a fresh exact identity naming a LIVE tab clears vanished — stickiness never outranks it', async () => {
  const first = await collect({ events: VANISH_EVENTS, tree: tree([term('TAB-1')]), roots: ROOTS });
  // The session resumed into TAB-2 and its newest event says so; TAB-1 is gone.
  const moved = VANISH_EVENTS.concat([blocking({ ts: NOW - min(2), surfaceId: 'TAB-2' })]);
  const r = await collect({ events: moved, tree: tree([term('TAB-2')]), roots: ROOTS }, { prev: first.fragment });
  const s = one(r.fragment);
  assert.strictEqual(s.vanished, undefined, 'a legitimate move is not a vanish');
  assert.strictEqual(s.surface.tabUuid, 'TAB-2');
  assert.strictEqual(s.surface.via, 'recorded');
  assert.strictEqual(s.surfaceReason, null);
  assert.strictEqual(answerable(s), true, 'S-005 derives actions [{kind:reply}] from exactly this');
});

test('recovery works from an already-PUBLISHED vanished row', async () => {
  const { second } = await vanishSweep();
  assert.strictEqual(one(second.fragment).vanished, true);
  const published = JSON.parse(JSON.stringify({ repos: {}, sessions: second.fragment.sessions, machines: second.fragment.machines }));
  const prev = fragmentsFromState(published).sessions;

  const moved = VANISH_EVENTS.concat([blocking({ ts: NOW - min(2), surfaceId: 'TAB-2' })]);
  const s = one((await collect({ events: moved, tree: tree([term('TAB-2')]), roots: ROOTS }, { prev })).fragment);
  assert.strictEqual(s.vanished, undefined);
  assert.strictEqual(s.surface.tabUuid, 'TAB-2');
  assert.strictEqual(s.surface.via, 'recorded');
});

test('cwd NEVER revives a vanished row — the heuristic is not consulted at all', async () => {
  const { second } = await vanishSweep();
  const s = one(second.fragment);
  assert.strictEqual(s.vanished, true);
  assert.strictEqual(s.surface, null, 'TAB-2 is the only terminal in this cwd and is still not joined');
  assert.strictEqual(s.surfaceReason, 'recorded-tab-gone');
  assert.strictEqual(answerable(s), false, 'read-only: S-005 derives actions []');

  // Structurally, not just by outcome: instrument the cwd index and prove nothing touches it.
  const spied = () => {
    const idx = mod.buildSurfaceIndex(tree([term('TAB-2')]), ROOTS);
    const real = idx.byCwd;
    let touched = 0;
    idx.byCwd = new Proxy(real, {
      get(t, p, rx) { touched++; const v = Reflect.get(t, p, rx); return typeof v === 'function' ? v.bind(t) : v; },
    });
    return { idx, touched: () => touched };
  };

  const named = spied();
  const j = mod.joinSurface(named.idx, '/repo/app-web', 1, { surfaceId: 'TAB-1', tabId: null });
  assert.strictEqual(j.reason, 'recorded-tab-gone');
  assert.strictEqual(named.touched(), 0, 'a named-but-absent tab short-circuits before any cwd work');

  // The spy is not vacuous: with no recorded identity the heuristic really does run.
  const unnamed = spied();
  mod.joinSurface(unnamed.idx, '/repo/app-web', 1, null);
  assert.ok(unnamed.touched() > 0);
});

// ---- cancellation plumbing -------------------------------------------------------------------------

test('readMachineEvents forwards ctx.signal to its transport, and omits it for the collector', async () => {
  let observed = null;
  const http = (url, opts) => new Promise((resolve) => {
    observed = opts.signal;
    opts.signal.addEventListener('abort', () => resolve({ ok: false, status: 0, json: null }));
  });
  const ctl = new AbortController();
  const p = mod.readMachineEvents(REMOTE_BRIDGE, { now: NOW, http, signal: ctl.signal });
  ctl.abort();
  const aborted = await p;
  assert.strictEqual(observed.aborted, true, 'the in-flight call itself was cancelled');
  assert.ok(aborted.error, 'and an unfinished read never claims a complete history');
  assert.strictEqual(authoritative(aborted), false);

  let sawOpts = null;
  const plain = await mod.readMachineEvents(REMOTE_BRIDGE, {
    now: NOW, http: async (u, o) => { sawOpts = o; return { ok: true, status: 200, json: { events: [], more: false } }; },
  });
  assert.strictEqual(sawOpts.signal, undefined, 'the collector passes none, and gets what it always got');
  assert.deepStrictEqual(plain, { events: [], skipped: 0, more: false, error: null });
});

test('defaultHttp composes an external signal with its own timeout, on the real transport', async () => {
  const realFetch = global.fetch;
  // Duck-typed so the add/remove calls can be counted; the real AbortSignal underneath does the work.
  const extSignal = () => {
    const c = new AbortController();
    const s = {
      adds: 0, removes: 0,
      get aborted() { return c.signal.aborted; },
      addEventListener(...a) { s.adds++; return c.signal.addEventListener(...a); },
      removeEventListener(...a) { s.removes++; return c.signal.removeEventListener(...a); },
      fire() { c.abort(); },
    };
    return s;
  };
  let seen = null;
  const hang = (url, opts) => new Promise((_, reject) => {
    seen = opts.signal;
    if (opts.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const call = (signal) => mod.readMachineEvents(REMOTE_BRIDGE, { now: NOW, timeoutMs: 8000, signal });

  try {
    // 1 · aborted mid-flight
    global.fetch = hang;
    seen = null;
    let ext = extSignal();
    let p = call(ext);
    ext.fire();
    assert.ok((await p).error);
    assert.strictEqual(seen.aborted, true, 'the signal the fetch received is the one that aborted');
    assert.deepStrictEqual([ext.adds, ext.removes], [1, 1]);

    // 2 · ALREADY aborted before the call — a listener added now would never replay
    seen = null;
    ext = extSignal();
    ext.fire();
    assert.ok((await call(ext)).error);
    assert.strictEqual(seen.aborted, true, 'aborted is checked before listening');
    assert.deepStrictEqual([ext.adds, ext.removes], [0, 0], 'nothing added, so nothing to leak');

    // 3 · the private timeout still fires while an external signal is attached
    seen = null;
    ext = extSignal();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      p = call(ext);
      mock.timers.tick(8000);
      assert.ok((await p).error);
    } finally { mock.timers.reset(); }
    assert.strictEqual(seen.aborted, true);
    assert.deepStrictEqual([ext.adds, ext.removes], [1, 1]);

    // 4 · resolve and reject both balance too
    global.fetch = async (url, opts) => { seen = opts.signal; return { ok: true, status: 200, text: async () => '{"events":[],"more":false}' }; };
    ext = extSignal();
    assert.deepStrictEqual(await call(ext), { events: [], skipped: 0, more: false, error: null });
    assert.deepStrictEqual([ext.adds, ext.removes], [1, 1], 'resolve');

    global.fetch = (url, opts) => { seen = opts.signal; return Promise.reject(new Error('ECONNRESET')); };
    ext = extSignal();
    assert.match((await call(ext)).error, /ECONNRESET/);
    assert.deepStrictEqual([ext.adds, ext.removes], [1, 1], 'reject');
  } finally {
    global.fetch = realFetch;
  }
});

// ---- the carry-forward reader stays unfiltered -------------------------------------------------------

test('the collector rebuilds carry-forward WITHOUT filtering vanished — the shield lives in derive/push', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'radar', 'collector.js'), 'utf8');
  const start = src.indexOf('function fragmentsFromState');
  const end = src.indexOf('function createCollector');
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end);
  assert.ok(body.includes('out.sessions = { sessions: state.sessions || []'), 'published sessions are copied whole');
  assert.strictEqual(/vanished/.test(body), false, 'filtering here would delete the carry that IS the stickiness');

  const carried = fragmentsFromState({ repos: {}, sessions: [{ key: { machine: 'machine-b', sessionId: 's-1' }, status: 'blocked', vanished: true }] });
  assert.strictEqual(carried.sessions.sessions[0].vanished, true);
});

// ---- the published contract ---------------------------------------------------------------------------

test('a snapshot carrying lastStopAt, via and a vanished row satisfies the unmodified schema', async () => {
  const { second } = await vanishSweep();
  const live = await collect({
    events: [blocking({ ts: NOW - min(4), sessionId: 's-2', surfaceId: 'TAB-2' }), ev({ ts: NOW - min(1), sessionId: 's-3' })],
    tree: tree([term('TAB-2')]), roots: ROOTS,
  });
  const fragment = {
    sessions: second.fragment.sessions.concat(live.fragment.sessions),
    machines: live.fragment.machines,
  };
  assert.deepStrictEqual(fragment.sessions.map((s) => s.status).sort(), ['blocked', 'blocked', 'running']);

  const state = derive({ now: NOW, collectorId: 'machine-a', sources: sourcesWith(live.source), fragments: { sessions: fragment } });
  assert.deepStrictEqual(validate(schema, state).errors, [], 'no schema edit was needed — $defs.session is open');
  assert.strictEqual(state.sessions.every((s) => 'lastStopAt' in s), true);
  assert.strictEqual(state.sessions.find((s) => s.key.sessionId === 's-2').surface.via, 'recorded');
  assert.strictEqual(state.sessions.find((s) => s.key.sessionId === 's-1').vanished, true);
});
