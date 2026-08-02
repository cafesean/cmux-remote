'use strict';
// p9 S-006 — GET /api/radar/inbox, and the automatic-scan switch this story had to land first.
//
// TWO deliverables, and the order between them is not cosmetic. Radar's own machinery fights any
// test that injects a state.json fixture: enabling radar fires a boot scan AND arms a 60-second
// session sweep, either of which republishes state.json over the fixture. Without a switch, an
// assertion about `generatedAt` is a bet that the suite finishes inside the first tick — which is a
// race, not a guarantee, and the failure it eventually produces reads like a route bug. So the
// switch lands first and the route's ACs stand on it.
//
// The claims below are each tested the hard way rather than by assertion:
//
//   1. "No automatic scanning" means NO TIMER, not "no boot scan". Proved against a REAL collector
//      over a real temp RADAR_DIR under a fake clock wound past 60 s: the witness is the collector's
//      own stats.scans/stats.sweeps plus the fixture's bytes on disk, not a spy on the server.
//   2. The switch is OPT-OUT ONLY. Every no-scan test has a mirror-image control with the switch
//      absent, which must show the boot scan firing and the sweep timer arming. Without that pair,
//      "the fixture was not overwritten" is equally consistent with a harness that could never
//      detect an overwrite in the first place.
//   3. The env string actually reaches the guard. Proved by spawning a REAL server.js child with
//      RADAR_SCAN_ON_START=0 in its environment — server.js constructs radar with NO options, so
//      the env channel is the only one a shipped process has, and an in-process option test would
//      prove nothing about it. That child has a control child too.
//   4. The viewer never holds the leader token. The proxy tests assert WHERE the credential appears
//      (a server-side Bearer header) and where it does not (any URL, any response body).
//
// Every fixture here is synthesised: invented ids on the reserved `fixture-inbox-N` grammar,
// invented machine and workspace names, invented text, invented timestamps.
const { test, mock } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRadar } = require('../radar-server');
const { validate } = require('../radar/schema-lite');
const stateSchema = require('../radar/state.schema.json');
const emptyFixture = require('../radar/fixtures/state.empty.json');
const { buildInbox } = require('../radar/derive');
const { bootServer, call } = require('./helpers/server-boot');

// ---- fixtures ----------------------------------------------------------------------------------
// A value no scan would ever mint, so "the fixture survived" and "a scan republished" are told apart
// by reading one field rather than by timing.
const GEN = '2026-01-02T03:04:05.000Z';

// The exact §5.3 row. Written out in full rather than built by a helper with defaults hidden
// somewhere else: the shape IS the contract, and a reader of this file should be able to check it
// against the spec without chasing an indirection.
function inboxRow(over) {
  return Object.assign({
    sessionKey: { machine: 'fixture-box', sessionId: 'fixture-inbox-1' },
    blockedSince: '2026-01-02T03:00:00.000Z',
    lastStopAt: '2026-01-02T02:58:57.000Z',
    cacheExpiresAt: null,
    cacheApprox: true,
    notificationType: 'idle_prompt',
    turn: { blockedSince: '2026-01-02T03:00:00.000Z', assistantTs: '2026-01-02T02:58:57.000Z' },
    repo: 'sample-service',
    worktree: null,
    epic: null,
    question: 'Should the retry budget be per request or per batch?',
    intent: { verdict: 'needs-decision', reason: 'ends on a direct question', model: 'fixture-model', at: '2026-01-02T03:00:04.000Z', inferred: true },
    surface: { workspace: 'fixture-workspace', tabRef: 'tab-2', tabUuid: 'fixture-tab-uuid-1', via: 'recorded' },
    surfaceReason: null,
    answerable: true,
    actions: [{ kind: 'reply' }],
  }, over || {});
}

// An `unknown` row is the one the classifier could not speak for — no credential, no transcript, a
// transport failure. It is still a real row: the operator can still read the question.
function unknownRow(over) {
  return inboxRow(Object.assign({
    sessionKey: { machine: 'fixture-box', sessionId: 'fixture-inbox-2' },
    blockedSince: '2026-01-02T03:01:00.000Z',
    turn: { blockedSince: '2026-01-02T03:01:00.000Z', assistantTs: null },
    lastStopAt: null,
    question: 'Ready when you are.',
    intent: { verdict: 'unknown', reason: 'no credential', model: null, at: '2026-01-02T03:01:04.000Z', inferred: true },
  }, over || {}));
}

// `inbox === null` builds a LEGACY snapshot — one written before p9 existed, with no `inbox` key at
// all. That is a different input from `inbox: []`, and the route owes both the same 200.
function stateWith(inbox) {
  const s = JSON.parse(JSON.stringify(emptyFixture));
  s.generatedAt = GEN;
  if (inbox) {
    s.inbox = inbox;
    s.counts.inbox = inbox.length;
  }
  return s;
}

// ---- in-process harness ------------------------------------------------------------------------
function stubCollector(over) {
  const calls = [];
  const base = {
    paths: { dir: '/tmp/stub-radar-p9' },
    stats: {},
    getState: async () => stateWith([inboxRow()]),
    scan: async () => ({ ok: true, published: true, warnings: [], error: null, durationMs: 3, state: null }),
    start: () => {},
    stop: () => {},
    isScanning: () => false,
  };
  const impl = Object.assign({}, base, over || {});
  const wrapped = {};
  for (const k of Object.keys(impl)) {
    wrapped[k] = typeof impl[k] === 'function'
      ? (...args) => { calls.push({ name: k, args }); return impl[k](...args); }
      : impl[k];
  }
  wrapped.calls = calls;
  return wrapped;
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
  return { radar, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

// Real timers, small budget: used to wait for something the code does asynchronously without a
// handle to await (the boot scan is fire-and-forget by design).
async function until(pred, budgetMs) {
  const deadline = Date.now() + (budgetMs || 8000);
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function tempRadarDir(state) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-inbox-')));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', scanIntervalMin: 10, sessionSweepSec: 60, repos: [],
  }));
  if (state) await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return dir;
}

// ---- the fixtures themselves --------------------------------------------------------------------
// The route tests are only worth what their inputs are worth: a row invented to suit the route
// would let a route that reads the wrong shape pass. So the rows are validated against the shipped
// schema — which is CLOSED on inboxItem — before anything is asserted about the route.

test('the route fixtures are the exact §5.3 row shape (schema-valid, closed object)', () => {
  const s = stateWith([inboxRow(), unknownRow()]);
  const v = validate(stateSchema, s);
  assert.strictEqual(v.valid, true, v.errors.join('; '));
  assert.strictEqual(s.counts.inbox, 2);
  // The legacy shape is a valid snapshot too — that is precisely why the route must handle it.
  const legacy = validate(stateSchema, stateWith(null));
  assert.strictEqual(legacy.valid, true, legacy.errors.join('; '));
});

// ---- AC6: cold start and the legacy snapshot -----------------------------------------------------

test('AC6a: GET /api/radar/inbox with NO snapshot is 503 no_snapshot, never an empty-looking 200', async () => {
  const m = await mount(stubCollector({ getState: async () => null }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error, 'no_snapshot');
    // "never computed" and "computed, empty" must not be the same answer.
    assert.strictEqual(r.json.items, undefined);
  } finally { await m.close(); }
});

test('AC6b: a LEGACY snapshot with no inbox field is 200, items [], classifier ok', async () => {
  const legacy = stateWith(null);
  assert.strictEqual('inbox' in legacy, false, 'the fixture must genuinely lack the key, not carry an empty one');
  const m = await mount(stubCollector({ getState: async () => legacy }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.items, []);
    assert.strictEqual(r.json.generatedAt, GEN);
    assert.strictEqual(r.json.sources.classifier, 'ok');
  } finally { await m.close(); }
});

// ---- AC4: the envelope, the nested verdict, and the empty queue ----------------------------------

test("AC4a: one row whose NESTED intent.verdict is 'unknown' makes the classifier degraded", async () => {
  const m = await mount(stubCollector({ getState: async () => stateWith([inboxRow(), unknownRow()]) }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.sources.classifier, 'degraded');
    assert.strictEqual(r.json.items.length, 2);
    // The envelope is exactly three keys — a client reads the queue here, not the board.
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['generatedAt', 'items', 'sources']);
    // Rows pass through untouched: the route projects nothing and truncates nothing.
    assert.deepStrictEqual(r.json.items, [inboxRow(), unknownRow()]);
    // generatedAt is the SNAPSHOT's, verbatim — not minted at request time.
    assert.strictEqual(r.json.generatedAt, GEN);
  } finally { await m.close(); }
});

test("AC4b: with no unknown verdict anywhere the classifier is 'ok'", async () => {
  const rows = [inboxRow(), inboxRow({ sessionKey: { machine: 'fixture-box', sessionId: 'fixture-inbox-3' } })];
  const m = await mount(stubCollector({ getState: async () => stateWith(rows) }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.sources.classifier, 'ok');
    assert.strictEqual(r.json.items.length, 2);
  } finally { await m.close(); }
});

test('AC4c: an empty inbox is 200 with items [] — computed-and-empty is not never-computed', async () => {
  const m = await mount(stubCollector({ getState: async () => stateWith([]) }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.items, []);
    assert.strictEqual(r.json.sources.classifier, 'ok');
    assert.strictEqual(r.json.generatedAt, GEN);
  } finally { await m.close(); }
});

// ---- AC5: the missing-intent row, end to end through the real derivation -------------------------
//
// Hand-writing a row with `intent.verdict: 'unknown'` would prove only that the route can read a
// field this test just wrote. The claim that matters is that a session which reaches derive with NO
// intent at all — a stage bug, partial wiring, a hand-built state — comes out the other side with a
// synthesized intent, and that the route's nested dereference therefore holds unconditionally. So
// the row is produced by the SHIPPED buildInbox, not by this file.

test('AC5: a blocked session with NO intent flows through buildInbox and GET as degraded, no throw', async () => {
  const now = Date.parse('2026-01-02T03:05:00.000Z');
  const session = {
    key: { machine: 'fixture-box', sessionId: 'fixture-inbox-4' },
    status: 'blocked',
    blockedSince: '2026-01-02T03:00:00.000Z',
    lastStopAt: null,
    cacheExpiresAt: null,
    notificationType: 'idle_prompt',
    lastAssistant: { text: 'Which of the two migrations should run first?', ts: '2026-01-02T02:59:00.000Z' },
    surface: { workspace: 'fixture-workspace', tabRef: 'tab-2', tabUuid: 'fixture-tab-uuid-4', via: 'recorded' },
    surfaceReason: null,
    repo: 'sample-service', worktree: null, epic: null,
    // NO `intent` property at all — that is the whole point of the fixture.
  };
  assert.strictEqual('intent' in session, false);
  const rows = buildInbox([session], now);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].intent, {
    verdict: 'unknown', reason: 'intent missing', model: null, at: '2026-01-02T03:05:00.000Z', inferred: true,
  });

  const s = stateWith(rows);
  assert.strictEqual(validate(stateSchema, s).valid, true);
  const m = await mount(stubCollector({ getState: async () => s }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 200, 'a synthesized-intent row must not become a 500');
    assert.strictEqual(r.json.sources.classifier, 'degraded');
    assert.strictEqual(r.json.items.length, 1);
    assert.strictEqual(r.json.items[0].intent.verdict, 'unknown');
  } finally { await m.close(); }
});

// ---- AC2: the scan switch, under a fake clock wound past 60 s ------------------------------------
//
// A REAL collector over a real temp RADAR_DIR. The stubs used elsewhere in this file cannot prove
// this claim: the thing being tested is that no timer EXISTS, and a stub's start() installs none
// either way. The witnesses are the collector's own counters and the fixture's bytes.

test('AC2a: SCAN SWITCH — RADAR_SCAN_ON_START=0 past 60 s: no scan, no sweep, fixture byte-identical, GET unchanged', async () => {
  const dir = await tempRadarDir(stateWith([inboxRow()]));
  const statePath = path.join(dir, 'state.json');
  const before = await fsp.readFile(statePath);
  const radar = createRadar({ radarDir: dir, env: { RADAR_SCAN_ON_START: '0' }, log: () => {} });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try { await radar.handle(req, res, u); } catch (_) { try { res.end(); } catch (__) {} }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const first = await call(base, 'GET', '/api/radar/inbox');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.generatedAt, undefined);
    assert.strictEqual(first.json.generatedAt, GEN);

    // The clock is wound past the 60-second sweep — the tick a boot-scan-only switch would leave
    // armed. HTTP stays outside the mocked window on purpose: fetch has timers of its own.
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      radar.start();
      mock.timers.tick(60_000);
      mock.timers.tick(60_000);
      mock.timers.tick(60_000);
    } finally { mock.timers.reset(); }
    // A settling window in real time: the boot scan is fire-and-forget, so "it did not happen" has
    // to be given the chance to happen before it is asserted.
    await new Promise((r) => setTimeout(r, 500));

    assert.strictEqual(radar.collector.stats.scans, 0, 'no scan may run — not the boot scan, not a swept one');
    assert.strictEqual(radar.collector.stats.sweeps, 0, 'the 60s session sweep must never have armed');
    const after = await fsp.readFile(statePath);
    assert.ok(before.equals(after), 'the injected fixture must be byte-identical on disk');

    const second = await call(base, 'GET', '/api/radar/inbox');
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.json.generatedAt, GEN, 'the GET served the fixture generatedAt throughout');
    assert.deepStrictEqual(second.json.items, [inboxRow()]);
  } finally {
    radar.stop();
    await new Promise((r) => srv.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// The mirror image, and it is what makes AC2a mean anything: with the switch absent the SAME harness
// must observe the boot scan running and the sweep timer firing. Without this, "nothing happened"
// would be equally consistent with a test that could never see it happen.
test('AC2b: SWITCH ABSENT — the boot scan fires and the 60s sweep timer arms, exactly as on main', async () => {
  const dir = await tempRadarDir(stateWith([inboxRow()]));
  const statePath = path.join(dir, 'state.json');
  const before = await fsp.readFile(statePath);
  const radar = createRadar({ radarDir: dir, env: {}, log: () => {} });
  try {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      radar.start();
      mock.timers.tick(60_000);
    } finally { mock.timers.reset(); }

    // sweeps++ happens on entry to sweepSessions, so a fired timer is observable immediately; the
    // scan it drives is async and gets the settling window.
    assert.strictEqual(radar.collector.stats.sweeps, 1, 'the sweep timer must arm and fire on main behaviour');
    const scanned = await until(async () => radar.collector.stats.scans >= 1);
    assert.ok(scanned, 'the boot scan must run when the switch is absent');
    const after = await until(async () => {
      const buf = await fsp.readFile(statePath);
      return before.equals(buf) ? null : buf;
    });
    assert.ok(after, 'and it must republish state.json — this is the overwrite AC2a proves does NOT happen');
    assert.notStrictEqual(JSON.parse(after.toString()).generatedAt, GEN);
  } finally {
    radar.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---- AC3: env wiring and option precedence -------------------------------------------------------

test('AC3a-c: option, env var, and option-with-env-unset all take the no-scan path; neither is overruled', async () => {
  // The boot scan is dispatched through a resolved promise chain, so "it did not run" needs a turn
  // of the microtask queue before it can be asserted.
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const drive = async (opts) => {
    const c = stubCollector();
    const radar = createRadar(Object.assign({ createCollector: () => c, log: () => {} }, opts));
    radar.start();
    await settle();
    radar.stop();
    return c.calls.filter((x) => x.name === 'start' || x.name === 'scan').map((x) => x.name);
  };

  // (a) the option alone, with an env that has no RADAR_SCAN_ON_START in it at all
  assert.deepStrictEqual(await drive({ scanOnStart: false, env: {} }), []);
  // (b) the env var alone — no option passed, which is exactly how server.js constructs radar
  assert.deepStrictEqual(await drive({ env: { RADAR_SCAN_ON_START: '0' } }), []);
  // (c) option precedence: the option still wins when the env var is unset. Asserted on an env that
  //     PROVABLY lacks the key, so this is not case (a) wearing a different hat.
  const env = { PATH: '/usr/bin', HOME: '/tmp/fixture-home' };
  assert.strictEqual('RADAR_SCAN_ON_START' in env, false);
  assert.deepStrictEqual(await drive({ scanOnStart: false, env }), []);

  // The control, and the opt-out rule: absent, both halves run.
  assert.deepStrictEqual((await drive({ env: {} })).sort(), ['scan', 'start']);
  // Opt-out is EXACTLY '0' (after a trim), never "any value present" — a switch that any string
  // could trip would silently disable radar for anyone who set it to 1 meaning "on".
  assert.deepStrictEqual((await drive({ env: { RADAR_SCAN_ON_START: '1' } })).sort(), ['scan', 'start']);
  assert.deepStrictEqual((await drive({ env: { RADAR_SCAN_ON_START: 'true' } })).sort(), ['scan', 'start']);
  assert.deepStrictEqual(await drive({ env: { RADAR_SCAN_ON_START: '  0  ' } }), [], 'trimmed, per the contract');
});

// ---- AC1 + AC3d: a REAL server.js child ----------------------------------------------------------
//
// server.js calls createRadar() with NO options, so the env var is the ONLY channel a shipped
// process has. An in-process option test proves nothing about that path — this one spawns the real
// binary on an ephemeral port with an isolated RADAR_DIR and an injected fixture.

async function bootRadarChild(over) {
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-child-')));
  const radarDir = path.join(scratch, 'radar-home');
  await fsp.mkdir(radarDir);
  await fsp.writeFile(path.join(radarDir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', scanIntervalMin: 10, sessionSweepSec: 60, repos: [],
  }));
  const statePath = path.join(radarDir, 'state.json');
  await fsp.writeFile(statePath, JSON.stringify(stateWith([inboxRow(), unknownRow()]), null, 2));
  const srv = await bootServer({
    cwd: scratch,
    env: Object.assign({ SERVER_TOKEN: 'fixture-token', RADAR_ENABLED: '1', RADAR_DIR: radarDir }, over || {}),
  });
  return { srv, scratch, statePath, cleanup: async () => { await srv.stop(); await fsp.rm(scratch, { recursive: true, force: true }); } };
}

test('AC1 + AC3d: a REAL server child with RADAR_SCAN_ON_START=0 serves the injected fixture and never rescans it', async () => {
  const c = await bootRadarChild({ RADAR_SCAN_ON_START: '0' });
  try {
    const before = await fsp.readFile(c.statePath);
    const r = await call(c.srv.base, 'GET', '/api/radar/inbox', { token: 'fixture-token' });
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.text}`);
    assert.strictEqual(r.json.generatedAt, GEN, 'the fixture generatedAt, not one a boot scan minted');
    assert.deepStrictEqual(r.json.items, [inboxRow(), unknownRow()]);
    assert.strictEqual(r.json.sources.classifier, 'degraded');

    // Give a boot scan every chance to fire before claiming it did not.
    await new Promise((res) => setTimeout(res, 1500));
    const after = await fsp.readFile(c.statePath);
    assert.ok(before.equals(after), 'the env string reached the guard: state.json is byte-identical');
    const again = await call(c.srv.base, 'GET', '/api/radar/inbox', { token: 'fixture-token' });
    assert.strictEqual(again.json.generatedAt, GEN);
    assert.ok(c.srv.alive(), 'the child must still be serving');
  } finally { await c.cleanup(); }
});

test('AC3d control: the same child WITHOUT the switch republishes the fixture — the env var is what suppresses it', async () => {
  const c = await bootRadarChild({});
  try {
    const before = await fsp.readFile(c.statePath);
    const changed = await until(async () => {
      const buf = await fsp.readFile(c.statePath);
      return before.equals(buf) ? null : buf;
    }, 15000);
    assert.ok(changed, 'with the switch absent the boot scan must republish — otherwise the AC above is vacuous');
    assert.notStrictEqual(JSON.parse(changed.toString()).generatedAt, GEN);
  } finally { await c.cleanup(); }
});

// ---- AC7 / AC8: the viewer proxy ------------------------------------------------------------------
//
// A viewer's queue of record lives on the leader, and the LEADER's token may never reach a browser
// served by a different host — a cross-origin fetch would put that credential into a second
// machine's page. So the viewer's own SERVER makes exactly one hop and holds the token. These tests
// therefore assert where the credential appears and where it does not, not merely that data came
// back. Every failure is 502 + lastGood:false rather than a synthesised empty queue: a failed proxy
// and a genuinely empty inbox must never look alike.

async function viewerRadar(over) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-viewer-')));
  // A supplied config REPLACES the default rather than merging into it. Merging cannot express the
  // `leader_unconfigured` case at all — the whole input is a config with leaderBaseUrl ABSENT, and
  // Object.assign has no way to remove a key, so that case would silently test something else.
  const config = (over && over.config) || {
    configVersion: 1, role: 'viewer',
    leaderBaseUrl: 'http://leader.invalid:8080/', leaderTokenRef: 'LEADER_TOK', repos: [],
    timeouts: { bridgeMs: 4000 },
  };
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
  const c = stubCollector({ paths: { dir, config: path.join(dir, 'config.json') } });
  const m = await mount(c, Object.assign({ env: { LEADER_TOK: 'leader-secret' } }, (over && over.radar) || {}));
  return { m, c, dir, cleanup: async () => { await m.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('AC7: a VIEWER proxies /inbox to the leader server-side and returns the body verbatim', async () => {
  const leaderBody = { items: [inboxRow(), unknownRow()], generatedAt: GEN, sources: { classifier: 'degraded' } };
  const seen = [];
  const v = await viewerRadar({
    radar: {
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify(leaderBody) };
      },
    },
  });
  try {
    const r = await call(v.m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, leaderBody, 'verbatim — a viewer does not re-derive the queue');
    assert.strictEqual(seen.length, 1, 'the viewer SERVER made the hop, not the browser');
    assert.strictEqual(seen[0].url, 'http://leader.invalid:8080/api/radar/inbox', 'the inbox route, not /state');
    assert.strictEqual(seen[0].init.headers.authorization, 'Bearer leader-secret');
    assert.ok(!seen[0].url.includes('leader-secret'), 'never in a URL');
    assert.ok(!JSON.stringify(r.json).includes('leader-secret'), 'never in the page-visible body');
    assert.ok(!v.c.calls.some((x) => x.name === 'getState'), 'a viewer serving its own snapshot would be a silent lie');
  } finally { await v.cleanup(); }
});

test('AC8: the viewer failure matrix — five codes, each 502 with lastGood:false', async () => {
  const cases = [
    {
      name: 'leader_unconfigured',
      over: { config: { configVersion: 1, role: 'viewer', leaderTokenRef: 'LEADER_TOK', repos: [] } },
      radar: { fetchImpl: async () => { throw new Error('must not be called'); } },
    },
    {
      name: 'leader_token_missing',
      radar: { env: {}, fetchImpl: async () => { throw new Error('must not be called'); } },
    },
    {
      name: 'leader_error',
      radar: { fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'busy' }) },
    },
    {
      name: 'leader_bad_json',
      radar: { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>not json</html>' }) },
    },
    {
      name: 'leader_unreachable',
      radar: { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
    },
  ];
  for (const cs of cases) {
    const v = await viewerRadar({ config: cs.over && cs.over.config, radar: cs.radar });
    try {
      const r = await call(v.m.base, 'GET', '/api/radar/inbox');
      assert.strictEqual(r.status, 502, `${cs.name}: expected 502, got ${r.status}`);
      assert.strictEqual(r.json.error, cs.name);
      assert.strictEqual(r.json.lastGood, false, `${cs.name}: lastGood must be false`);
      assert.ok(!v.c.calls.some((x) => x.name === 'getState'), `${cs.name}: must not fall back to the viewer's own snapshot`);
    } finally { await v.cleanup(); }
  }
});

// The timeout is the fifth code's other entry, and it needs a clock rather than a rejection: the
// proxy owns an AbortController armed at timeouts.bridgeMs, and nothing else in this file proves
// that timer exists. The injected fetch is a plain function, so mocking setTimeout is safe here in
// a way it would not be around a real fetch.
test('AC8: a leader that never answers times out at timeouts.bridgeMs — leader_unreachable, lastGood false', async () => {
  let aborted = false;
  let dispatched = false;
  const v = await viewerRadar({
    radar: {
      fetchImpl: (url, init) => new Promise((_resolve, reject) => {
        dispatched = true;
        init.signal.addEventListener('abort', () => {
          aborted = true;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    },
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Driven in-process: an HTTP round trip cannot share a window with a mocked setTimeout.
    const res = { code: null, body: null, headersSent: false, writeHead(c) { this.code = c; }, end(b) { this.body = JSON.parse(b); } };
    const p = v.m.radar.handle({ method: 'GET' }, res, new URL('http://x/api/radar/inbox'));
    // Wind the clock only once the request is genuinely in flight. The route reads config off disk
    // first, so a tick fired on the next microtask would land BEFORE the abort timer is armed and
    // then never fire at all — the test would hang rather than fail, which is the worst outcome.
    // setImmediate is a full event-loop turn, so this drains the pending fs work too.
    for (let i = 0; i < 500 && !dispatched; i++) await new Promise((r) => setImmediate(r));
    assert.ok(dispatched, 'the upstream request must be in flight before the clock is wound');
    mock.timers.tick(4000);
    await p;
    assert.strictEqual(aborted, true, 'the bridgeMs timer must actually abort the upstream request');
    assert.strictEqual(res.code, 502);
    assert.strictEqual(res.body.error, 'leader_unreachable');
    assert.strictEqual(res.body.message, 'timeout');
    assert.strictEqual(res.body.lastGood, false);
  } finally {
    mock.timers.reset();
    await v.cleanup();
  }
});

// ---- the routes the switch must NOT have touched --------------------------------------------------
// "Routes and any manual scan API remain live" is half the switch's contract, and it is the half a
// too-eager guard would quietly break.

test('the scan switch disables SCANNING, not the API: POST /api/radar/scan still works with it on', async () => {
  const c = stubCollector();
  const m = await mount(c, { scanOnStart: undefined, env: { RADAR_SCAN_ON_START: '0' } });
  try {
    m.radar.start();
    const r = await call(m.base, 'POST', '/api/radar/scan');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(c.calls.filter((x) => x.name === 'scan').length, 1, 'the forced scan is the ONE scan that ran');
    assert.strictEqual(c.calls.filter((x) => x.name === 'start').length, 0, 'and no scheduler was armed');
    const g = await call(m.base, 'GET', '/api/radar/inbox');
    assert.strictEqual(g.status, 200);
  } finally { await m.close(); }
});

test('a URL-borne token is refused on the inbox route too, exactly as on every other radar route', async () => {
  const m = await mount(stubCollector());
  try {
    const r = await call(m.base, 'GET', '/api/radar/inbox?token=fixture-token');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.error, 'token_in_url');
  } finally { await m.close(); }
});

test('the inbox is GET-only — POST /api/radar/inbox is not this story\'s route', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const r = await call(m.base, 'POST', '/api/radar/inbox');
    assert.strictEqual(r.status, 404);
    assert.ok(!c.calls.some((x) => x.name === 'getState'));
  } finally { await m.close(); }
});
