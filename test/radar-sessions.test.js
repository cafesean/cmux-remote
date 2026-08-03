'use strict';
// S-004 — mod-sessions: hook events + bridge tree -> session facts.
//
// Every test here is a fixture. The hooks are human-gated (radar/HOOK-INSTALL.md), so the module is
// proved against synthetic NDJSON and a stubbed bridge; nothing in this file needs a live session,
// a live bridge, or cmux.
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const mod = require('../radar/mod-sessions');
const { derive } = require('../radar/derive');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'radar-sessions-'));

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const min = (n) => n * 60 * 1000;

const ev = (over) => Object.assign({
  ts: NOW - min(5), sessionId: 's-1', transcriptPath: '/t/s-1.jsonl', cwd: '/repo/app-web',
  event: 'UserPromptSubmit', notificationType: null,
}, over);

const REPO = { id: 'app-web', path: '/repo/app-web', defaultBranches: ['develop', 'main'] };
const CONFIG = { repos: [REPO], timeouts: { bridgeMs: 500 } };

// A bridge that answers from canned data. `events: null` means "this endpoint fails" — the outage
// cases are the whole point of half these tests.
function stubBridge(spec) {
  const s = spec || {};
  return async (url) => {
    if (url.includes('/cmux/session-events')) {
      if (!s.events) return { ok: false, status: 503, json: null };
      return { ok: true, status: 200, json: { machineId: s.machineId || 'machine-b', events: s.events, more: false } };
    }
    if (url.includes('/cmux/tree')) {
      if (!s.tree) return { ok: false, status: 503, json: null };
      return { ok: true, status: 200, json: s.tree };
    }
    if (url.includes('/cmux/fs/roots')) {
      if (!s.roots) return { ok: false, status: 503, json: null };
      return { ok: true, status: 200, json: s.roots };
    }
    return { ok: false, status: 404, json: null };
  };
}

const REMOTE = [{ id: 'machine-b', baseUrl: 'http://machine-b:8799', secretRef: 'X_SECRET' }];

const collect = (spec, over) => mod.collectSessions(Object.assign({
  config: CONFIG, aliases: {}, now: NOW, paths: {}, bridges: REMOTE, http: stubBridge(spec),
}, over || {}));

const one = (frag) => { assert.strictEqual(frag.sessions.length, 1, 'expected exactly one session'); return frag.sessions[0]; };

// ---- blocked: the narrow set ---------------------------------------------------------------------

test('blocked is set by permission_prompt and by idle_prompt, and by nothing else', async () => {
  for (const nt of ['permission_prompt', 'idle_prompt']) {
    const { fragment } = await collect({ events: [ev({ ts: NOW - min(3), event: 'Notification', notificationType: nt })] });
    const s = one(fragment);
    assert.strictEqual(s.status, 'blocked', nt);
    assert.strictEqual(s.notificationType, nt);
    assert.strictEqual(s.blockedSince, new Date(NOW - min(3)).toISOString());
  }
});

test('auth_success and every other notification subtype are INERT — they neither set nor clear', async () => {
  // Set blocked, then fire a pile of other subtypes. If any of them cleared it (or if any of them
  // could set it), this fixture catches it.
  const { fragment } = await collect({
    events: [
      ev({ ts: NOW - min(9), event: 'Notification', notificationType: 'permission_prompt' }),
      ev({ ts: NOW - min(8), event: 'Notification', notificationType: 'auth_success' }),
      ev({ ts: NOW - min(7), event: 'Notification', notificationType: 'followup_prompt' }),
      ev({ ts: NOW - min(6), event: 'Notification', notificationType: 'edit_prompt' }),
      ev({ ts: NOW - min(5), event: 'PostToolUse' }),
    ],
  });
  const s = one(fragment);
  assert.strictEqual(s.status, 'blocked', 'still blocked — no inert subtype cleared it');
  assert.strictEqual(s.notificationType, 'permission_prompt');
});

test('auth_success ALONE produces no block at all', async () => {
  const { fragment } = await collect({
    events: [ev({ ts: NOW - min(3), event: 'Notification', notificationType: 'auth_success' })],
  });
  const s = one(fragment);
  assert.notStrictEqual(s.status, 'blocked');
  assert.strictEqual(s.blockedSince, null);
  assert.strictEqual(s.notificationType, null);
});

test('the PermissionRequest hook (present on the installed CLI) also sets blocked', async () => {
  const { fragment } = await collect({ events: [ev({ ts: NOW - min(2), event: 'PermissionRequest' })] });
  const s = one(fragment);
  assert.strictEqual(s.status, 'blocked');
  assert.strictEqual(s.notificationType, 'permission_request');
});

// ---- blocked CLEARS three ways -------------------------------------------------------------------

test('clearing path 1/3: a later UserPromptSubmit clears blocked', async () => {
  const { fragment } = await collect({
    events: [
      ev({ ts: NOW - min(9), event: 'Notification', notificationType: 'permission_prompt' }),
      ev({ ts: NOW - min(1), event: 'UserPromptSubmit' }),
    ],
  });
  const s = one(fragment);
  assert.strictEqual(s.status, 'running', 'answered inside the 120 s window');
  assert.strictEqual(s.blockedSince, null);
  assert.strictEqual(s.notificationType, null);
});

test('clearing path 2/3: a later Stop clears blocked', async () => {
  const { fragment } = await collect({
    events: [
      ev({ ts: NOW - min(9), event: 'Notification', notificationType: 'idle_prompt' }),
      ev({ ts: NOW - min(6), event: 'Stop' }),
    ],
  });
  const s = one(fragment);
  assert.strictEqual(s.status, 'idle', 'idle = live, not finished');
  assert.strictEqual(s.blockedSince, null);
});

// p9 §5.1.3 REPLACED the third clearing path. A blocked session whose tab closes used to be dropped
// from sessions[] outright, which also cleared its block. It is now PUBLISHED with vanished: true —
// carry-forward is rebuilt solely from published state, so a drop is a fact forgotten next sweep,
// and the operator's question does not stop existing because a terminal did. The row still leaves
// on the two real clearing events and on ABANDON_MS. Keeping vanished rows off the attention board
// is derive's `liveSessions` shield (S-005), not this module's job.
test('clearing path 3/3: a tab vanishing from the tree publishes the session as vanished, not dropped', async () => {
  const events = [ev({ ts: NOW - min(9), event: 'Notification', notificationType: 'permission_prompt' })];
  const roots = { roots: [{ kind: 'workspace', label: 'app', path: '/repo/app-web' }] };
  const present = {
    workspaces: [{ ref: 'workspace:2', title: 'app', tabs: [{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', status: 'Running', statusCovered: true }] }],
  };

  const before = await collect({ events, tree: present, roots });
  const s = one(before.fragment);
  assert.strictEqual(s.status, 'blocked');
  assert.strictEqual(s.surface.tabUuid, 'UUID-A');

  // The tab is closed: the same events, a tree that no longer contains UUID-A.
  const gone = { workspaces: [{ ref: 'workspace:2', title: 'app', tabs: [{ id: 'UUID-Z', ref: 'surface:9', type: 'terminal', statusCovered: true }] }] };
  const after = await collect({ events, tree: gone, roots }, { prev: before.fragment });
  const v = one(after.fragment);
  assert.strictEqual(v.vanished, true);
  assert.strictEqual(v.surface, null, 'no Jump target — the tab it named is gone');
  assert.strictEqual(v.surfaceReason, 'recorded-tab-gone');
  assert.strictEqual(v.status, 'blocked', 'the session is still waiting on a human');

  // And it does leave, on a real clearing event, tab or no tab.
  const answered = await collect(
    { events: events.concat([ev({ ts: NOW - min(1), event: 'UserPromptSubmit' })]), tree: gone, roots },
    { prev: after.fragment });
  assert.deepStrictEqual(answered.fragment.sessions, [], 'answered -> gone, with no tab to vanish from');
});

test('blocked -> cleared -> blocked again ends BLOCKED (order matters, not membership)', async () => {
  const { fragment } = await collect({
    events: [
      ev({ ts: NOW - min(30), event: 'Notification', notificationType: 'permission_prompt' }),
      ev({ ts: NOW - min(20), event: 'UserPromptSubmit' }),
      ev({ ts: NOW - min(10), event: 'Notification', notificationType: 'idle_prompt' }),
    ],
  });
  const s = one(fragment);
  assert.strictEqual(s.status, 'blocked');
  assert.strictEqual(s.notificationType, 'idle_prompt');
  assert.strictEqual(s.blockedSince, new Date(NOW - min(10)).toISOString());
});

// ---- identity -------------------------------------------------------------------------------------

test('two simultaneous sessions in ONE cwd correlate independently — identity is never cwd', async () => {
  const { fragment } = await collect({
    events: [
      ev({ ts: NOW - min(9), sessionId: 'alpha', event: 'Notification', notificationType: 'permission_prompt' }),
      ev({ ts: NOW - min(1), sessionId: 'beta', event: 'UserPromptSubmit' }),
    ],
    tree: { workspaces: [{ ref: 'workspace:2', title: 'app', tabs: [{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', statusCovered: true }] }] },
    roots: { roots: [{ kind: 'workspace', label: 'app', path: '/repo/app-web' }] },
  });
  assert.strictEqual(fragment.sessions.length, 2, 'one cwd, two rows');
  const alpha = fragment.sessions.find((s) => s.key.sessionId === 'alpha');
  const beta = fragment.sessions.find((s) => s.key.sessionId === 'beta');
  assert.strictEqual(alpha.status, 'blocked');
  assert.strictEqual(beta.status, 'running');
  assert.strictEqual(alpha.key.machine, 'machine-b');
  // Ambiguous by construction: one cwd cannot point at one terminal when two sessions share it.
  assert.strictEqual(alpha.surface, null, 'no Jump when the cwd is shared');
  assert.strictEqual(beta.surface, null);
});

test('an event with NO cwd still lists the session, just without repo/epic mapping', async () => {
  const { fragment } = await collect({
    events: [ev({ ts: NOW - min(2), cwd: null, event: 'Notification', notificationType: 'permission_prompt' })],
  });
  const s = one(fragment);
  assert.strictEqual(s.status, 'blocked', 'a session with no cwd is still a session');
  assert.strictEqual(s.repo, null);
  assert.strictEqual(s.epic, null);
  assert.strictEqual(s.worktree, null);
  assert.strictEqual(s.surface, null);
});

test('cwd maps repo and epic, and ONLY repo and epic', async () => {
  const aliases = { epics: { 'PROJ-93': ['p52'] } };
  const events = [ev({ ts: NOW - min(2), cwd: '/repo/app-web/.claude/worktrees/p52-desktop' })];
  const { fragment } = await collect({ events }, { aliases });
  const s = one(fragment);
  assert.strictEqual(s.repo, 'app-web');
  assert.strictEqual(s.epic, 'PROJ-93', 'p52 alias resolved through the same mapper branches use');
  assert.strictEqual(s.worktree, '/repo/app-web/.claude/worktrees/p52-desktop');
  assert.strictEqual(s.key.sessionId, 's-1', 'identity is unchanged by any of it');
});

test('an issue key in the path maps straight to the epic', async () => {
  const { fragment } = await collect({ events: [ev({ cwd: '/repo/app-web/.claude/worktrees/PROJ-108-searchindex' })] });
  assert.strictEqual(one(fragment).epic, 'PROJ-108');
});

test('a cwd outside every configured repo maps to nothing and still lists', async () => {
  const { fragment } = await collect({ events: [ev({ cwd: '/somewhere/else' })] });
  const s = one(fragment);
  assert.strictEqual(s.repo, null);
  assert.strictEqual(s.epic, null);
});

// ---- status + cache -------------------------------------------------------------------------------

test('running/idle is a 120 s window and idle NEVER means finished', async () => {
  const recent = await collect({ events: [ev({ ts: NOW - 60 * 1000 })] });
  assert.strictEqual(one(recent.fragment).status, 'running');
  const old = await collect({ events: [ev({ ts: NOW - 5 * 60 * 1000 })] });
  const s = one(old.fragment);
  assert.strictEqual(s.status, 'idle');
  // The Stop that ENDED the turn is present, and the session is still 'idle' — never a
  // "finished"/"done" value, because there is no such session state.
  const stopped = await collect({ events: [ev({ ts: NOW - min(30), event: 'Stop' })] });
  assert.strictEqual(one(stopped.fragment).status, 'idle');
});

test('cacheExpiresAt is last submit + 60 min and is ALWAYS flagged approximate', async () => {
  const { fragment } = await collect({
    events: [
      ev({ ts: NOW - min(50), event: 'UserPromptSubmit' }),
      ev({ ts: NOW - min(40), event: 'UserPromptSubmit' }),      // the LAST submit wins
      ev({ ts: NOW - min(35), event: 'Stop' }),
    ],
  });
  const s = one(fragment);
  assert.strictEqual(s.lastSubmitAt, new Date(NOW - min(40)).toISOString());
  assert.strictEqual(s.cacheExpiresAt, new Date(NOW - min(40) + min(60)).toISOString());
  assert.strictEqual(s.cacheApprox, true, 'the TTL drops to 5 min under overage — never asserted');
});

test('a session that never submitted has no cache deadline rather than a guessed one', async () => {
  const { fragment } = await collect({ events: [ev({ ts: NOW - min(3), event: 'SessionStart' })] });
  assert.strictEqual(one(fragment).cacheExpiresAt, null);
  assert.strictEqual(one(fragment).cacheApprox, true);
});

// ---- surface join ---------------------------------------------------------------------------------

const wsTree = (tabs) => ({ workspaces: [{ ref: 'workspace:2', title: 'app', tabs }] });
const wsRoots = { roots: [{ kind: 'workspace', label: 'app', path: '/repo/app-web' }] };

test('an unambiguous cwd -> workspace -> single terminal join yields a Jump target', async () => {
  const { fragment } = await collect({
    events: [ev({ ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })],
    tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', status: 'Running', statusCovered: true }]),
    roots: wsRoots,
  });
  const s = one(fragment);
  assert.deepStrictEqual(s.surface, { workspace: 'workspace:2', tabRef: 'surface:1', tabUuid: 'UUID-A', tabStatus: 'Running', via: 'cwd' });
  const state = derive({ now: NOW, collectorId: 'machine-a', sources: { sessions: { status: 'ok' } }, fragments: { sessions: fragment } });
  const blocked = state.attention.find((a) => a.type === 'blocked');
  assert.deepStrictEqual(blocked.actions, [{ kind: 'jump', machine: 'machine-b', tabRef: 'surface:1', tabUuid: 'UUID-A' }]);
});

test('an AMBIGUOUS join -> surface null -> NO Jump action', async () => {
  const cases = {
    'two terminals in the workspace': { tree: wsTree([
      { id: 'UUID-A', ref: 'surface:1', type: 'terminal', statusCovered: true },
      { id: 'UUID-B', ref: 'surface:2', type: 'terminal', statusCovered: true },
    ]), roots: wsRoots },
    'no workspace matches the cwd': { tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }]), roots: { roots: [{ kind: 'workspace', label: 'app', path: '/some/other/dir' }] } },
    'two workspaces share the label': {
      tree: { workspaces: [
        { ref: 'workspace:2', title: 'app', tabs: [{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }] },
        { ref: 'workspace:7', title: 'app', tabs: [{ id: 'UUID-B', ref: 'surface:2', type: 'terminal' }] },
      ] },
      roots: wsRoots,
    },
    'no roots at all (fs/roots unavailable)': { tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }]), roots: null },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const { fragment } = await collect(Object.assign({
      events: [ev({ ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })],
    }, spec));
    const s = one(fragment);
    assert.strictEqual(s.surface, null, name);
    const state = derive({ now: NOW, collectorId: 'machine-a', sources: { sessions: { status: 'ok' } }, fragments: { sessions: fragment } });
    assert.deepStrictEqual(state.attention.find((a) => a.type === 'blocked').actions, [], `${name}: no Jump`);
  }
});

test('a tab past the 60-tab status cap renders status `unknown`, and is still listed', async () => {
  const { fragment, source } = await collect({
    events: [ev({ ts: NOW - min(2) })],
    // statusCovered:false is what bridge.js sets past the cap: nobody ASKED cmux about this tab.
    tree: Object.assign(wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', statusCovered: false }]), { statusTruncated: true }),
    roots: wsRoots,
  });
  const s = one(fragment);
  assert.strictEqual(s.surface.tabStatus, 'unknown', 'never a green');
  assert.strictEqual(s.surface.tabUuid, 'UUID-A', 'and the session is still fully addressable');
  assert.strictEqual(source.status, 'ok');
  assert.strictEqual(one(fragment).status !== 'blocked', true);
});

test('machines[] reports the 60-tab truncation so the UI can say so', async () => {
  const { fragment } = await collect({
    events: [ev({})],
    tree: Object.assign(wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', statusCovered: false }]), { statusTruncated: true }),
    roots: wsRoots,
  });
  assert.strictEqual(fragment.machines[0].statusTruncated, true);
  assert.strictEqual(fragment.machines[0].bridge, 'ok');
});

// ---- degradation ------------------------------------------------------------------------------------

test('bridge offline: previous session facts carry forward marked stale, with ZERO attention churn', async () => {
  const events = [ev({ ts: NOW - min(20), event: 'Notification', notificationType: 'permission_prompt' })];
  const good = await collect({ events, tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', statusCovered: true }]), roots: wsRoots });
  const before = derive({ now: NOW, collectorId: 'machine-a', sources: { sessions: good.source }, fragments: { sessions: good.fragment } });
  assert.strictEqual(before.attention.filter((a) => a.type === 'blocked').length, 1);

  // Everything on that machine is now unreachable.
  const down = await collect({ events: null, tree: null, roots: null }, { prev: good.fragment });
  const s = one(down.fragment);
  assert.strictEqual(s.stale, true, 'marked stale');
  assert.strictEqual(s.status, 'blocked', 'the FACT is unchanged — an outage is not a state change');
  assert.deepStrictEqual(s.surface, good.fragment.sessions[0].surface, 'the Jump target survives too');
  assert.strictEqual(down.fragment.machines[0].bridge, 'offline');
  assert.strictEqual(down.fragment.machines[0].eventsStatus, 'offline');
  assert.strictEqual(down.source.status, 'error', 'the SOURCE degrades; the data does not');

  const after = derive({ now: NOW, collectorId: 'machine-a', sources: { sessions: down.source }, fragments: { sessions: down.fragment } });
  assert.deepStrictEqual(
    after.attention.map((a) => `${a.type}:${a.sessionKey ? a.sessionKey.sessionId : ''}`),
    before.attention.map((a) => `${a.type}:${a.sessionKey ? a.sessionKey.sessionId : ''}`),
    'zero attention churn from the outage itself',
  );
});

test('events readable but tree down: sessions still fold, surface carries forward, nothing vanishes', async () => {
  const events = [ev({ ts: NOW - min(20), event: 'Notification', notificationType: 'permission_prompt' })];
  const good = await collect({ events, tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', statusCovered: true }]), roots: wsRoots });
  const partial = await collect({ events, tree: null, roots: null }, { prev: good.fragment });
  const s = one(partial.fragment);
  assert.strictEqual(s.status, 'blocked');
  assert.strictEqual(s.stale, false, 'the events are fresh — only the tree is missing');
  assert.strictEqual(s.surface.tabUuid, 'UUID-A', 'surface carried forward rather than flipped to null');
  assert.strictEqual(partial.fragment.machines[0].bridge, 'offline');
  assert.strictEqual(partial.fragment.machines[0].eventsStatus, 'ok');
  assert.strictEqual(partial.source.status, 'stale');
});

test('a machine with no previous facts and no bridge yields nothing, not a fake session', async () => {
  const { fragment, source } = await collect({ events: null, tree: null });
  assert.deepStrictEqual(fragment.sessions, []);
  assert.strictEqual(fragment.machines[0].bridge, 'offline');
  assert.strictEqual(source.status, 'error');
});

test('duplicate events across pages are idempotent — the fold is by (sessionId, ts, event)', async () => {
  const dup = ev({ ts: NOW - min(4), event: 'Notification', notificationType: 'permission_prompt' });
  const { fragment } = await collect({ events: [dup, Object.assign({}, dup), Object.assign({}, dup)] });
  const s = one(fragment);
  assert.strictEqual(s.status, 'blocked');
  assert.strictEqual(s.blockedSince, new Date(NOW - min(4)).toISOString());
});

test('a session older than the 48 h event retention is dropped rather than left hanging', async () => {
  const { fragment } = await collect({ events: [ev({ ts: NOW - 49 * 3600 * 1000 })] });
  assert.deepStrictEqual(fragment.sessions, []);
});

// ---- config ------------------------------------------------------------------------------------------

test('an unconfigured install probes NOTHING and reads only its own event log', async () => {
  const dir = await tmp();
  const events = path.join(dir, 'events');
  await fsp.mkdir(events, { recursive: true });
  await fsp.writeFile(path.join(events, `${new Date(NOW).toISOString().slice(0, 10)}.ndjson`),
    JSON.stringify(ev({ ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })) + '\n');

  let calls = 0;
  const { fragment, source } = await mod.collectSessions({
    config: CONFIG, aliases: {}, now: NOW, collectorId: 'machine-a',
    paths: { dir, events, config: path.join(dir, 'config.json') },
    http: async () => { calls++; return { ok: false, status: 500, json: null }; },
  });
  assert.strictEqual(calls, 0, 'no config.bridges -> no speculative HTTP to whatever is on :8799');
  assert.strictEqual(one(fragment).status, 'blocked', 'the local hook log still works');
  assert.strictEqual(fragment.machines[0].id, 'machine-a');
  assert.strictEqual(fragment.machines[0].bridge, 'unknown', 'unknown, never a guessed ok/offline');
  assert.strictEqual(fragment.machines[0].eventsStatus, 'ok', 'the events really were read');
  assert.strictEqual(source.status, 'ok', 'the source is ok; the UNPROBED part is carried on the machine');
});

test('malformed bridge entries are skipped and named, never a crash', async () => {
  const issues = [];
  const out = mod.normalizeBridges({ bridges: [
    { id: 'ok-one', baseUrl: 'http://a:8799' },
    { id: 'no-url', baseUrl: 'ssh://nope' },
    { baseUrl: 'http://b:8799' },
    'not an object',
    { id: 'ok-one', baseUrl: 'http://dupe:8799' },
  ] }, 'machine-a', issues);
  assert.deepStrictEqual(out.map((b) => b.id), ['ok-one']);
  assert.strictEqual(issues.length, 4);
  assert.match(issues.join('; '), /baseUrl is not http/);
  assert.match(issues.join('; '), /missing id/);
  assert.match(issues.join('; '), /duplicate id/);
});

test('fetch:false suppresses every HTTP call and reports unknown, not offline', async () => {
  let calls = 0;
  const { fragment, source } = await mod.collectSessions({
    config: CONFIG, aliases: {}, now: NOW, paths: {}, bridges: REMOTE,
    fetch: false,
    http: async () => { calls++; return { ok: true, status: 200, json: { events: [], more: false } }; },
  });
  assert.strictEqual(calls, 0);
  assert.strictEqual(fragment.machines[0].bridge, 'unknown');
  assert.strictEqual(fragment.machines[0].eventsStatus, 'unknown');
  assert.strictEqual(source.status, 'stale');
  assert.match(source.error, /not probed/);
});

// ---- the sweep cadence ------------------------------------------------------------------------------

test('the session sweep has its own 60 s cadence, decoupled from the 10-minute git scan', async (t) => {
  const { createCollector } = require('../radar/collector');
  const dir = await tmp();
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', scanIntervalMin: 10, sessionSweepSec: 60, repos: [],
  }));
  const timers = [];
  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => { timers.push(ms); return realSetInterval(() => {}, 1e9); };
  try {
    const c = createCollector({ radarDir: dir, modules: { git: async () => ({ fragment: { repos: {} }, source: { status: 'ok' } }) } });
    c.start({ fetch: false });
    assert.deepStrictEqual(timers, [10 * 60 * 1000, 60 * 1000], 'two independent timers, git and sessions');
    assert.strictEqual(c.hasSweepTimer(), true);
    c.stop();
    assert.strictEqual(c.hasSweepTimer(), false, 'stop() clears the sweep timer too — RADAR_ENABLED rollback');
  } finally {
    global.setInterval = realSetInterval;
  }
});

test('a session-only sweep refreshes sessions and leaves the git fragment and its metadata alone', async () => {
  const { createCollector } = require('../radar/collector');
  const dir = await tmp();
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 1, role: 'leader', repos: [] }));
  let gitRuns = 0;
  let sessionRuns = 0;
  const c = createCollector({
    radarDir: dir,
    modules: {
      git: async () => { gitRuns++; return { fragment: { repos: { r: { path: '/r', branches: [], worktrees: [] } } }, source: { status: 'ok', observedAt: 'GIT-STAMP' } }; },
      sessions: async () => { sessionRuns++; return { fragment: { sessions: [], machines: [{ id: 'm', bridge: 'ok', lastSeenAt: null }] }, source: { status: 'ok', observedAt: `S-${sessionRuns}` } }; },
    },
  });
  await c.scan({ fetch: false });
  const sweep = await c.sweepSessions({ fetch: false });
  assert.strictEqual(gitRuns, 1, 'the sweep does not re-run 200 git spawns');
  assert.strictEqual(sessionRuns, 2);
  assert.strictEqual(sweep.state.sources.sessions.observedAt, 'S-2', 'sessions metadata is fresh');
  assert.strictEqual(sweep.state.sources.git.observedAt, 'GIT-STAMP', 'git metadata is carried, not re-stamped');
  assert.deepStrictEqual(Object.keys(sweep.state.repos), ['r'], 'and the git DATA is carried forward');
  c.stop();
});

// ---- surface join: LONGEST PREFIX, and a reason for every refusal --------------------------------
//
// THE DEFECT THIS CLOSES (found on the live board, 2026-07-31). The join keyed workspace roots by
// EXACT cwd equality. cmux's roots are parent directories — the real board exposes exactly one,
// `/path/to/workspace` — while a session's cwd is a repo or a worktree several levels below
// it. So the join never fired for any real session, and every blocked row rendered a bare
// "surface unknown" with no Jump. That is not "best-effort and ambiguous", it is "never attempted".

test('a session BELOW a workspace root joins it — roots are parent directories, not exact cwds', async () => {
  const { fragment } = await collect({
    events: [ev({ cwd: '/repo/app-web/.claude/worktrees/p61', ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })],
    tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal', status: 'Running', statusCovered: true }]),
    roots: wsRoots,
  });
  const s = one(fragment);
  assert.deepStrictEqual(s.surface, { workspace: 'workspace:2', tabRef: 'surface:1', tabUuid: 'UUID-A', tabStatus: 'Running', via: 'cwd' });
  assert.strictEqual(s.surfaceReason, null, 'a resolved surface carries no reason');
});

test('the LONGEST matching root wins, so a nested workspace beats its parent', async () => {
  const { fragment } = await collect({
    events: [ev({ cwd: '/repo/app-web/apps/api/src', ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })],
    tree: { workspaces: [
      { ref: 'workspace:2', title: 'outer', tabs: [{ id: 'UUID-OUTER', ref: 'surface:1', type: 'terminal' }] },
      { ref: 'workspace:9', title: 'inner', tabs: [{ id: 'UUID-INNER', ref: 'surface:2', type: 'terminal' }] },
    ] },
    roots: { roots: [
      { kind: 'workspace', label: 'outer', path: '/repo/app-web' },
      { kind: 'workspace', label: 'inner', path: '/repo/app-web/apps/api' },
    ] },
  });
  assert.strictEqual(one(fragment).surface.tabUuid, 'UUID-INNER');
});

test('a sibling directory does NOT match on a shared string prefix', async () => {
  // `/repo/app-web-old` must not join the `/repo/app-web` workspace. String prefix is not path
  // prefix, and getting this wrong would Jump to a stranger's tab — the one failure worse than none.
  const { fragment } = await collect({
    events: [ev({ cwd: '/repo/app-web-old', ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })],
    tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }]),
    roots: wsRoots,
  });
  const s = one(fragment);
  assert.strictEqual(s.surface, null);
  assert.strictEqual(s.surfaceReason, 'no-workspace-for-cwd');
});

test('every refusal names its reason, from a fixed vocabulary', async () => {
  const blocking = ev({ ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' });
  const cases = {
    // The live-board case: one workspace, four terminal tabs, and `cmux tree` carries no per-tab
    // cwd — so there is nothing left to disambiguate them with. The count IS the finding.
    'ambiguous-tabs:2': { events: [blocking], roots: wsRoots, tree: wsTree([
      { id: 'UUID-A', ref: 'surface:1', type: 'terminal' },
      { id: 'UUID-B', ref: 'surface:2', type: 'terminal' },
    ]) },
    'no-workspace-for-cwd': { events: [blocking], tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }]),
      roots: { roots: [{ kind: 'workspace', label: 'app', path: '/some/other/dir' }] } },
    'ambiguous-workspace': { events: [blocking], roots: wsRoots, tree: { workspaces: [
      { ref: 'workspace:2', title: 'app', tabs: [{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }] },
      { ref: 'workspace:7', title: 'app', tabs: [{ id: 'UUID-B', ref: 'surface:2', type: 'terminal' }] },
    ] } },
    'no-terminal-tab': { events: [blocking], roots: wsRoots, tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'browser' }]) },
    'no-cwd': { events: [ev({ cwd: null, ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' })], roots: wsRoots,
      tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }]) },
  };
  for (const [want, spec] of Object.entries(cases)) {
    const { fragment } = await collect(spec);
    const s = one(fragment);
    assert.strictEqual(s.surface, null, want);
    assert.strictEqual(s.surfaceReason, want);
    // Whatever the reason, the contract is unchanged: no surface means no Jump action.
    const state = derive({ now: NOW, collectorId: 'machine-a', sources: { sessions: { status: 'ok' } }, fragments: { sessions: fragment } });
    const blocked = state.attention.find((a) => a.type === 'blocked');
    assert.deepStrictEqual(blocked.actions, [], `${want}: no Jump`);
    assert.strictEqual(blocked.surfaceReason, want, `${want}: the reason reaches the attention row`);
  }
});

test('two sessions in one cwd still refuse, and say which refusal it was', async () => {
  const { fragment } = await collect({
    events: [
      ev({ sessionId: 'a', ts: NOW - min(2), event: 'Notification', notificationType: 'permission_prompt' }),
      ev({ sessionId: 'b', ts: NOW - min(2) }),
    ],
    tree: wsTree([{ id: 'UUID-A', ref: 'surface:1', type: 'terminal' }]),
    roots: wsRoots,
  });
  for (const s of fragment.sessions) {
    assert.strictEqual(s.surface, null);
    assert.strictEqual(s.surfaceReason, 'shared-cwd');
  }
});

// ── recorded surface identity (the hook captures CMUX_SURFACE_ID at the source) ──────────────────
// Spec trap 7 said `cmux tree` has no per-tab cwd, so a workspace with >1 terminal can never be
// disambiguated. True — and sidestepped entirely once the session names its own tab. These lock
// that the recorded id WINS over the cwd heuristic, is VALIDATED against the tree, and that the old
// guess still runs for sessions started outside cmux.
{
  const TAB = 'AAAAAAAA-1111-2222-3333-444444444444';
  const OTHER = 'BBBBBBBB-1111-2222-3333-444444444444';
  // One workspace, TWO terminals: the exact shape the cwd heuristic must refuse.
  const tree = { workspaces: [{ ref: 'workspace:9', title: 'shared', tabs: [
    { id: TAB, ref: 'tab:1', type: 'terminal', status: 'idle' },
    { id: OTHER, ref: 'tab:2', type: 'terminal', status: 'idle' },
  ] }] };
  const roots = { roots: [{ kind: 'workspace', label: 'shared', path: '/repo/shared' }] };
  const now = Date.now();
  const ev = (sessionId, extra) => Object.assign(
    { ts: now - 60000, sessionId, event: 'Notification', notificationType: 'idle_prompt', cwd: '/repo/shared' }, extra);
  const run = (events) => mod.sessionsForMachine(
    { bridge: { id: 'm1' }, events, tree, roots },
    { now, config: { repos: [] }, aliases: {}, prevByMachine: new Map() }).sessions;

  test('a recorded surface id resolves the tab the cwd heuristic could never pick', () => {
    const [s] = run([ev('s1', { surfaceId: TAB })]);
    assert.strictEqual(s.surfaceReason, null);
    assert.strictEqual(s.surface.tabUuid, TAB);
    assert.strictEqual(s.surface.workspace, 'workspace:9');
  });

  test('the same session WITHOUT the recorded id still refuses — two terminals, no tiebreak', () => {
    const [s] = run([ev('s1', {})]);
    assert.strictEqual(s.surface, null);
    assert.strictEqual(s.surfaceReason, 'ambiguous-tabs:2');
  });

  test('a recorded id absent from the tree reports the closed tab, never a cwd fallback', () => {
    const [s] = run([ev('s1', { surfaceId: 'CCCCCCCC-0000-0000-0000-000000000000' })]);
    assert.strictEqual(s.surface, null);
    assert.strictEqual(s.surfaceReason, 'recorded-tab-gone');
  });

  test('tabId is accepted when surfaceId is absent', () => {
    const [s] = run([ev('s1', { tabId: OTHER })]);
    assert.strictEqual(s.surface.tabUuid, OTHER);
  });

  test('two sessions sharing a cwd BOTH resolve when each recorded its own tab', () => {
    const rows = run([ev('s1', { surfaceId: TAB }), ev('s2', { surfaceId: OTHER })]);
    const by = new Map(rows.map((r) => [r.key.sessionId, r]));
    assert.strictEqual(by.get('s1').surface.tabUuid, TAB);
    assert.strictEqual(by.get('s2').surface.tabUuid, OTHER);
    assert.strictEqual(by.get('s1').surfaceReason, null);
    assert.strictEqual(by.get('s2').surfaceReason, null);
  });

  test('the newest event wins — a session moved between tabs follows the move', () => {
    const [s] = run([ev('s1', { surfaceId: TAB }), Object.assign(ev('s1', { surfaceId: OTHER }), { ts: now - 1000 })]);
    assert.strictEqual(s.surface.tabUuid, OTHER);
  });
}

// ---- A2: a killed session emits no Stop, so `blocked` must time out ------------------------------

test('A2: blocked expires to `abandoned` past ABANDON_MS — a killed session never emits Stop', async () => {
  const justInside = await collect({
    events: [ev({ ts: NOW - mod.ABANDON_MS + min(5), event: 'Notification', notificationType: 'idle_prompt' })],
  });
  assert.strictEqual(one(justInside.fragment).status, 'blocked', 'inside the window it is still blocked');

  const pastIt = await collect({
    events: [ev({ ts: NOW - mod.ABANDON_MS - min(5), event: 'Notification', notificationType: 'idle_prompt' })],
  });
  const s = one(pastIt.fragment);
  assert.strictEqual(s.status, 'abandoned',
    'past the window radar stops claiming anyone is waiting on it');
  assert.strictEqual(s.notificationType, null, 'no live blocking reason is asserted for a corpse');
  assert.ok(s.blockedSince, 'when it blocked is still recorded — the fact is kept, the claim is not');
});

test('A2: the clearing events still win inside the window', async () => {
  const cleared = await collect({
    events: [
      ev({ ts: NOW - min(90), event: 'Notification', notificationType: 'idle_prompt' }),
      ev({ ts: NOW - min(80), event: 'UserPromptSubmit' }),
    ],
  });
  assert.notStrictEqual(one(cleared.fragment).status, 'blocked');
  assert.notStrictEqual(one(cleared.fragment).status, 'abandoned', 'answered, not abandoned');
});
