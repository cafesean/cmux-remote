'use strict';
// S-001b — radar mounted on the cmux server, behind RADAR_ENABLED.
//
// Three claims are load-bearing here and each one is tested the hard way rather than by assertion:
//
//   1. RADAR_ENABLED unset means ZERO radar code paths active. Proved by a require-graph probe on a
//      real server child, not by a 404 — a 404 is equally consistent with radar being fully loaded
//      and merely declining to answer.
//   2. A collector exception cannot affect existing cmux routes. Proved by poisoning
//      radar/collector.js in a real server child so every method throws, then asking whether
//      /api/cmux/machines still answers.
//   3. Timers are cleared on disable. Proved by counting the process's live Timeout handles across
//      start()/stop(), not by trusting that stop() was called.
//
// Plus the §7 route table, the 16 KB cap, and the rule the shared auth gate cannot express: authed()
// accepts ?token= for EventSource, and radar refuses to be authenticated that way at all.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRadar, BODY_CAP } = require('../radar-server');
const { validate } = require('../radar/schema-lite');
const { refuse } = require('../radar/collector');
const stateSchema = require('../radar/state.schema.json');
const fullFixture = require('../radar/fixtures/state.full.json');
const { bootServer, call } = require('./helpers/server-boot');
const { buildFixtureRepo } = require('./helpers/git-fixture');

// ---- in-process harness ------------------------------------------------------------------------
// Mounts radar exactly the way server.js does — behind the same `radar &&` switch, with the same
// outer try/catch — alongside a stand-in for an existing cmux route. That sibling route is the
// control: if radar's failure ever reaches it, the boundary leaked.
function stubCollector(over) {
  const calls = [];
  const base = {
    paths: { dir: '/tmp/stub-radar' },
    stats: {},
    getState: async () => fullFixture,
    scan: async () => ({ ok: true, published: true, warnings: [], error: null, durationMs: 7, state: fullFixture }),
    start: () => {},
    stop: () => {},
    tagBranch: async () => true,
    tagSpec: async () => true,
    setFlag: async () => true,
    addDecision: async (i) => ({ id: 'a-decision', title: i.title, since: '2026-07-31T00:00:00Z', context: null, epic: i.epic || null, closedAt: null }),
    closeDecision: async () => true,
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
    if (u.pathname === '/api/cmux/machines') {                       // the control route
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ machines: [] }));
    }
    if (u.pathname.startsWith('/api/radar/')) {
      try { return await radar.handle(req, res, u); } catch (e) {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"radar_error"}'); }
        return res.end();
      }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { radar, base, close: () => new Promise((r) => srv.close(r)) };
}

// ---- §7 route table ----------------------------------------------------------------------------

test('GET /api/radar/state hands back the snapshot VERBATIM (schema-valid, unreshaped)', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const r = await call(m.base, 'GET', '/api/radar/state');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, fullFixture, 'the body must be getState() itself, not a wrapper around it');
    const v = validate(stateSchema, r.json);
    assert.strictEqual(v.valid, true, v.errors.join('; '));
  } finally { await m.close(); }
});

// An empty board and a board that was never computed must not look alike (spec §2: unknown beats
// false green). A 200 with a hollow body would make them identical.
test('GET /api/radar/state with no snapshot is 503, never an empty-looking 200', async () => {
  const m = await mount(stubCollector({ getState: async () => null }));
  try {
    const r = await call(m.base, 'GET', '/api/radar/state');
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.error, 'no_snapshot');
  } finally { await m.close(); }
});

// ---- viewer proxy (spec §3, S-007) --------------------------------------------------------------
//
// The whole reason this hop exists is credential containment: on a viewer, the leader's token must
// be held by the viewer's SERVER and never handed to a browser. The tests below therefore assert
// where the token appears (a Bearer header on a server-side request) and where it does not (any
// URL, any response body), not merely that the proxy returns data.

async function viewerRadar(over) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-viewer-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'viewer',
    leaderBaseUrl: 'http://leader.invalid:8080/', leaderTokenRef: 'LEADER_TOK', repos: [],
  }));
  const c = stubCollector({ paths: { dir, config: path.join(dir, 'config.json') } });
  const m = await mount(c, Object.assign({ env: { LEADER_TOK: 'leader-secret' } }, over || {}));
  return { m, c, dir, cleanup: async () => { await m.close(); await fsp.rm(dir, { recursive: true, force: true }); } };
}

test('a VIEWER proxies /state to the leader server-side, with the token in a Bearer header only', async () => {
  const seen = [];
  const v = await viewerRadar({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(fullFixture) };
    },
  });
  try {
    const r = await call(v.m.base, 'GET', '/api/radar/state');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, fullFixture);
    assert.strictEqual(seen.length, 1, 'the viewer server made the hop, not the browser');
    assert.strictEqual(seen[0].url, 'http://leader.invalid:8080/api/radar/state');
    assert.strictEqual(seen[0].init.headers.authorization, 'Bearer leader-secret');
    assert.ok(!seen[0].url.includes('leader-secret'), 'never in a URL');
    // and the collector's own snapshot was not consulted — the leader is the state of record
    assert.ok(!v.c.calls.some((x) => x.name === 'getState'));
    // nothing in the answer leaks the leader credential to the page
    assert.ok(!JSON.stringify(r.json).includes('leader-secret'));
  } finally { await v.cleanup(); }
});

test('a viewer whose leader is unreachable answers 502 lastGood:false, never a hollow 200', async () => {
  const v = await viewerRadar({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  try {
    const r = await call(v.m.base, 'GET', '/api/radar/state');
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.error, 'leader_unreachable');
    assert.strictEqual(r.json.lastGood, false);
  } finally { await v.cleanup(); }
});

test('a viewer missing the leader token env var says so, and never falls back to its own snapshot', async () => {
  const v = await viewerRadar({ env: {}, fetchImpl: async () => { throw new Error('should not be called'); } });
  try {
    const r = await call(v.m.base, 'GET', '/api/radar/state');
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.error, 'leader_token_missing');
    assert.ok(!v.c.calls.some((x) => x.name === 'getState'), 'a viewer serving its own empty state would be a silent lie');
  } finally { await v.cleanup(); }
});

test('a LEADER never proxies — it serves its own snapshot', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-leader-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 1, role: 'leader', repos: [] }));
  const c = stubCollector({ paths: { dir, config: path.join(dir, 'config.json') } });
  const m = await mount(c, { fetchImpl: async () => { throw new Error('a leader must not call out'); } });
  try {
    const r = await call(m.base, 'GET', '/api/radar/state');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, fullFixture);
  } finally { await m.close(); await fsp.rm(dir, { recursive: true, force: true }); }
});

test('POST /api/radar/scan returns a receipt and delegates to the collector (which coalesces)', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const r = await call(m.base, 'POST', '/api/radar/scan');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.published, true);
    assert.strictEqual(c.calls.filter((x) => x.name === 'scan').length, 1);
  } finally { await m.close(); }
});

// Concurrency is the collector's contract (single in-flight scan). What is verified here is that
// the route hands straight to it — no second scan path, no queue of its own.
test('concurrent POST /api/radar/scan all join the one in-flight collector scan', async () => {
  let running = 0;
  let maxConcurrent = 0;
  let inflight = null;
  const c = stubCollector({
    scan: () => {
      if (inflight) return inflight;                                  // the real collector's coalescing
      running++; maxConcurrent = Math.max(maxConcurrent, running);
      inflight = new Promise((res) => setTimeout(() => {
        running--; inflight = null;
        res({ ok: true, published: true, warnings: [], error: null, durationMs: 5, state: fullFixture });
      }, 50));
      return inflight;
    },
  });
  const m = await mount(c);
  try {
    const rs = await Promise.all([0, 1, 2, 3].map(() => call(m.base, 'POST', '/api/radar/scan')));
    for (const r of rs) assert.strictEqual(r.status, 200);
    assert.strictEqual(maxConcurrent, 1, 'four requests must not produce four scans');
  } finally { await m.close(); }
});

test('a force-scan is POST-only — GET /api/radar/scan is not a route', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const r = await call(m.base, 'GET', '/api/radar/scan');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(c.calls.length, 0, 'a GET must not have triggered a scan');
  } finally { await m.close(); }
});

test('unknown /api/radar/* paths are 404, not a silent 200', async () => {
  const m = await mount(stubCollector());
  try {
    assert.strictEqual((await call(m.base, 'GET', '/api/radar/')).status, 404);
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/nope')).status, 404);
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/decisions//close')).status, 404);
  } finally { await m.close(); }
});

// ---- auth: header only -------------------------------------------------------------------------
// The shared authed() gate accepts ?token= because EventSource cannot set headers. No radar route is
// an EventSource, and a token in a radar URL would land in browser history, referrers, and every
// access log that records query strings. Radar refuses that credential outright.

test('a token in the URL is refused even when the shared gate would have accepted it', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    for (const [method, p] of [['GET', '/api/radar/state'], ['POST', '/api/radar/scan'], ['POST', '/api/radar/flag']]) {
      const r = await call(m.base, method, `${p}?token=supersecret`);
      assert.strictEqual(r.status, 401, `${method} ${p}`);
      assert.strictEqual(r.json.error, 'token_in_url');
    }
    assert.strictEqual(c.calls.length, 0, 'a URL-token request must never reach the collector');
  } finally { await m.close(); }
});

// ---- bodies ------------------------------------------------------------------------------------

test('request bodies are capped at 16 KB and answered with 413 (not a killed socket)', async () => {
  const m = await mount(stubCollector());
  try {
    const big = JSON.stringify({ title: 'x'.repeat(BODY_CAP + 500) });
    assert.ok(big.length > BODY_CAP);
    const r = await call(m.base, 'POST', '/api/radar/decide', { body: big });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.json.error, 'body_too_large');
  } finally { await m.close(); }
});

test('a body just under the cap is accepted', async () => {
  const m = await mount(stubCollector());
  try {
    const r = await call(m.base, 'POST', '/api/radar/decide', { body: { title: 'x'.repeat(BODY_CAP - 100) } });
    assert.strictEqual(r.status, 200);
  } finally { await m.close(); }
});

test('malformed JSON is 400, and a non-object body is 400', async () => {
  const m = await mount(stubCollector());
  try {
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/decide', { body: '{not json' })).json.error, 'bad_json');
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/decide', { body: '[1,2]' })).status, 400);
  } finally { await m.close(); }
});

// ---- mutations ---------------------------------------------------------------------------------

test('every §7 mutation route reaches the collector with the parsed arguments', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const tag = await call(m.base, 'POST', '/api/radar/tag', { body: { kind: 'branch', repo: 'app-web', branch: 'fix-x', epic: 'PROJ-112' } });
    assert.strictEqual(tag.status, 200);
    const decide = await call(m.base, 'POST', '/api/radar/decide', { body: { title: 'site org2 provider row', epic: 'PROJ-113' } });
    assert.strictEqual(decide.status, 200);
    assert.strictEqual(decide.json.decision.id, 'a-decision');
    const close = await call(m.base, 'POST', '/api/radar/decisions/a-decision/close');
    assert.strictEqual(close.status, 200);
    const flag = await call(m.base, 'POST', '/api/radar/flag', { body: { epic: 'PROJ-108', state: 'off' } });
    assert.strictEqual(flag.status, 200);
    assert.strictEqual(flag.json.asserted, true, 'a flag is asserted truth and the API says so');

    const byName = Object.fromEntries(c.calls.map((x) => [x.name, x.args]));
    assert.deepStrictEqual(byName.tagBranch[0], { repo: 'app-web', branch: 'fix-x', epic: 'PROJ-112' });
    assert.strictEqual(byName.addDecision[0].title, 'site org2 provider row');
    assert.strictEqual(byName.addDecision[0].epic, 'PROJ-113');
    assert.strictEqual(byName.closeDecision[0], 'a-decision');
    assert.deepStrictEqual(byName.setFlag[0], { epic: 'PROJ-108', state: 'off' });
  } finally { await m.close(); }
});

test('a decision id with URL-escaped characters survives the round trip', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const r = await call(m.base, 'POST', `/api/radar/decisions/${encodeURIComponent('site org2/provider')}/close`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(c.calls.find((x) => x.name === 'closeDecision').args[0], 'site org2/provider');
  } finally { await m.close(); }
});

// S-007 defect 1. This route answered 501 while collector.tagSpec() sat finished and lifecycle-
// tested next to it, so the spec-orphan queue — the LARGEST class of attention items on the real
// board — had a tag button that could never work. The assertion that matters is the second one:
// the spec branch must reach tagSpec, NOT tagBranch, because a branchOverrides entry keyed on a
// spec folder name can never match a branch and would fail silently forever.
test('spec tagging reaches collector.tagSpec (never tagBranch)', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    const r = await call(m.base, 'POST', '/api/radar/tag', { body: { kind: 'spec', specFolder: 'p63-something', epic: 'PROJ-120' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.kind, 'spec');
    const names = c.calls.map((x) => x.name);
    assert.deepStrictEqual(names, ['tagSpec']);
    assert.deepStrictEqual(c.calls[0].args[0], { specFolder: 'p63-something', epic: 'PROJ-120' });
  } finally { await m.close(); }
});

test('a spec tag missing specFolder or epic is 400 and never reaches the write queue', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    for (const body of [{ kind: 'spec', epic: 'PROJ-120' }, { kind: 'spec', specFolder: 'p63-x' }]) {
      const r = await call(m.base, 'POST', '/api/radar/tag', { body });
      assert.strictEqual(r.status, 400);
    }
    assert.strictEqual(c.calls.length, 0);
  } finally { await m.close(); }
});

// A folder radar has never seen as an orphan is a stale UI or a typo, not a malformed request:
// the collector throws and the route reports 422, the same shape as an unknown branch.
test('an unknown spec folder is 422, carrying the collector message', async () => {
  const c = stubCollector({ tagSpec: async () => { throw refuse('unknown spec folder p99-nope'); } });
  const m = await mount(c);
  try {
    const r = await call(m.base, 'POST', '/api/radar/tag', { body: { kind: 'spec', specFolder: 'p99-nope', epic: 'PROJ-120' } });
    assert.strictEqual(r.status, 422);
    assert.match(r.json.message, /unknown spec folder p99-nope/);
  } finally { await m.close(); }
});

test('malformed mutations are 400 and never reach the write queue', async () => {
  const c = stubCollector();
  const m = await mount(c);
  try {
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/tag', { body: { repo: 'r', branch: 'b' } })).status, 400);
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/tag', { body: { kind: 'wat', repo: 'r', branch: 'b', epic: 'E' } })).status, 400);
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/decide', { body: { title: '  ' } })).status, 400);
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/flag', { body: { epic: 'PROJ-1', state: 'maybe' } })).status, 400);
    assert.strictEqual((await call(m.base, 'POST', '/api/radar/flag', { body: { state: 'on' } })).status, 400);
    assert.strictEqual(c.calls.length, 0);
  } finally { await m.close(); }
});

// Well-formed but naming something radar does not know (a stale UI, a typo) is a different failure
// from a malformed request, and a caller has to be able to tell them apart.
test('a well-formed mutation the collector rejects is 422 with the collector reason', async () => {
  const m = await mount(stubCollector({
    tagBranch: async () => { throw refuse('unknown repo nope (known: app-web)'); },
    closeDecision: async () => { throw refuse('no open decision with id ghost'); },
  }));
  try {
    const tag = await call(m.base, 'POST', '/api/radar/tag', { body: { repo: 'nope', branch: 'b', epic: 'E' } });
    assert.strictEqual(tag.status, 422);
    assert.match(tag.json.message, /unknown repo nope/);
    const close = await call(m.base, 'POST', '/api/radar/decisions/ghost/close');
    assert.strictEqual(close.status, 422);
  } finally { await m.close(); }
});

// ---- error boundary (in-process) ---------------------------------------------------------------

test('a collector that throws on EVERY method degrades radar only — the cmux route still answers', async () => {
  const boom = () => { throw new Error('BOOM'); };
  const m = await mount(stubCollector({ getState: boom, scan: boom, tagBranch: boom, setFlag: boom, addDecision: boom, closeDecision: boom }));
  try {
    for (const [method, p, body] of [
      ['GET', '/api/radar/state', undefined],
      ['POST', '/api/radar/scan', undefined],
      ['POST', '/api/radar/tag', { repo: 'r', branch: 'b', epic: 'E' }],
      ['POST', '/api/radar/decide', { title: 't' }],
      ['POST', '/api/radar/flag', { epic: 'E', state: 'on' }],
    ]) {
      const r = await call(m.base, method, p, { body });
      assert.ok(r.status === 500 || r.status === 422, `${method} ${p} -> ${r.status}`);
      assert.ok(r.json && r.json.error, 'a radar-scoped error body');
    }
    const control = await call(m.base, 'GET', '/api/cmux/machines');
    assert.strictEqual(control.status, 200, 'the existing cmux route must be untouched');
    assert.deepStrictEqual(control.json, { machines: [] });
  } finally { await m.close(); }
});

// ---- timers ------------------------------------------------------------------------------------
// The rollback story is "unset RADAR_ENABLED": start() is then never called and no timer is ever
// created. This tests the other half — that stop() actually reclaims the one it does create.

// NOTE ON THE WITNESS: process.getActiveResourcesInfo() is the obvious probe and it is the WRONG
// one here — it lists resources keeping the event loop alive, and the collector's interval is
// deliberately .unref()'d, so it never appears there whether it is running or not. A test built on
// it passes for the wrong reason. The witness used instead is the handle itself: Node marks a
// Timeout `_destroyed` when clearInterval runs, and the collector hands its handle back from
// start(), so "the timer was cleared" is observed rather than inferred.
test('start() installs exactly one timer and stop() clears it (both idempotent)', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-timer-')));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 1, role: 'leader', scanIntervalMin: 10, repos: [] }));
  const radar = createRadar({ radarDir: dir, scanOnStart: false, log: () => {} });
  try {
    const h1 = radar.collector.start({ fetch: false });
    assert.ok(h1, 'start() installs an interval and returns its handle');
    assert.strictEqual(h1._destroyed, false);
    assert.strictEqual(radar.collector.start({ fetch: false }), undefined, 'a second start() is a no-op — one timer, not two');

    radar.stop();
    assert.strictEqual(h1._destroyed, true, 'stop() must actually clearInterval the handle');
    radar.stop();                                          // idempotent: no throw, nothing to clear

    // The collector's internal handle was nulled too, so a re-enable gets a NEW timer rather than a
    // silent no-op that would leave radar scheduled-but-dead.
    const h2 = radar.collector.start({ fetch: false });
    assert.ok(h2 && h2 !== h1, 'a stopped collector can be started again');
    radar.stop();
    assert.strictEqual(h2._destroyed, true);
  } finally {
    radar.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// The wiring half of the same claim: radar.start()/stop() drive the collector's pair exactly once
// each, which is what makes "rollback = unset RADAR_ENABLED" true — with the env var unset, start()
// is never called, so there is no timer to clear in the first place.
test('radar.start()/stop() drive the collector scheduler once each', async () => {
  const events = [];
  const c = stubCollector({ start: () => { events.push('start'); }, stop: () => { events.push('stop'); } });
  const radar = createRadar({ createCollector: () => c, scanOnStart: false, log: () => {} });
  radar.start();
  radar.start();
  assert.deepStrictEqual(events, ['start']);
  assert.strictEqual(radar.isStarted(), true);
  radar.stop();
  assert.deepStrictEqual(events, ['start', 'stop']);
  assert.strictEqual(radar.isStarted(), false);
});

// ---- the real server: RADAR_ENABLED unset ------------------------------------------------------

test('RADAR_ENABLED unset: no radar module is ever loaded and every radar route 404s', async () => {
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-off-')));
  const probeOut = path.join(scratch, 'requires.log');
  await fsp.writeFile(probeOut, '');
  const srv = await bootServer({
    cwd: scratch,
    nodeArgs: ['--require', path.join(__dirname, 'helpers', 'require-probe.js')],
    env: { SERVER_TOKEN: 'off-token', REQUIRE_PROBE_OUT: probeOut },
  });
  try {
    // The claim, proved on the require graph rather than on a status code.
    const loaded = (await fsp.readFile(probeOut, 'utf8')).split('\n').filter(Boolean);
    assert.ok(loaded.length > 5, 'the probe recorded the boot requires');
    const radarish = loaded.filter((r) => /radar/i.test(r));
    assert.deepStrictEqual(radarish, [], `no radar module may be loaded, saw: ${radarish.join(', ')}`);

    for (const [method, p] of [['GET', '/api/radar/state'], ['POST', '/api/radar/scan'], ['POST', '/api/radar/flag']]) {
      const r = await call(srv.base, method, p, { token: 'off-token', body: method === 'POST' ? {} : undefined });
      assert.strictEqual(r.status, 404, `${method} ${p}`);
      assert.strictEqual(r.json.error, 'not_found');
    }
    assert.strictEqual((await call(srv.base, 'GET', '/api/cmux/machines', { token: 'off-token' })).status, 200);
  } finally { await srv.stop(); await fsp.rm(scratch, { recursive: true, force: true }); }
});

// ---- the real server: RADAR_ENABLED=1 ----------------------------------------------------------

test('RADAR_ENABLED=1: the §7 routes work end to end against a real repo', async () => {
  const fx = await buildFixtureRepo();
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-on-')));
  const radarDir = path.join(scratch, '.radar');
  await fsp.mkdir(radarDir, { recursive: true });
  await fsp.writeFile(path.join(radarDir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', collectorId: 'test-leader', scanIntervalMin: 10,
    repos: [{ id: 'fixture', path: fx.repo, defaultBranches: ['develop', 'main'] }],
  }));
  const probeOut = path.join(scratch, 'requires.log');
  await fsp.writeFile(probeOut, '');
  const TOKEN = 'on-token';
  const srv = await bootServer({
    cwd: scratch,
    nodeArgs: ['--require', path.join(__dirname, 'helpers', 'require-probe.js')],
    env: { SERVER_TOKEN: TOKEN, RADAR_ENABLED: '1', RADAR_DIR: radarDir, REQUIRE_PROBE_OUT: probeOut },
  });
  const authed = (method, p, body) => call(srv.base, method, p, { token: TOKEN, body });
  try {
    const loaded = (await fsp.readFile(probeOut, 'utf8')).split('\n').filter(Boolean);
    assert.ok(loaded.some((r) => /radar-server/.test(r)), 'radar-server.js is loaded when enabled');
    assert.ok(loaded.some((r) => /radar\/collector/.test(r)), 'the collector is loaded when enabled');

    // auth, both ways it can fail
    const noAuth = await call(srv.base, 'GET', '/api/radar/state');
    assert.strictEqual(noAuth.status, 401);
    assert.strictEqual(noAuth.json.error, 'unauthorized', 'the shared authed() gate rejected it');
    const urlToken = await call(srv.base, 'GET', `/api/radar/state?token=${TOKEN}`);
    assert.strictEqual(urlToken.status, 401);
    assert.strictEqual(urlToken.json.error, 'token_in_url', 'a valid token in a URL is still refused');

    // scan -> state
    const scan = await authed('POST', '/api/radar/scan');
    assert.strictEqual(scan.status, 200);
    assert.strictEqual(scan.json.published, true, `scan receipt: ${JSON.stringify(scan.json)}`);
    assert.strictEqual((await authed('GET', '/api/radar/scan')).status, 404, 'scan stays POST-only on the real server');

    const state = await authed('GET', '/api/radar/state');
    assert.strictEqual(state.status, 200);
    const v = validate(stateSchema, state.json);
    assert.strictEqual(v.valid, true, `the served snapshot must honour state.schema.json: ${v.errors.join('; ')}`);
    assert.strictEqual(state.json.collectorId, 'test-leader');
    assert.ok(state.json.repos.fixture, 'the configured repo is in the snapshot');

    // mutations, through the collector's single write queue, landing on disk
    const tag = await authed('POST', '/api/radar/tag', { kind: 'branch', repo: 'fixture', branch: 'orphan-branch', epic: 'PROJ-999' });
    assert.strictEqual(tag.status, 200, JSON.stringify(tag.json));
    const aliases = JSON.parse(await fsp.readFile(path.join(radarDir, 'aliases.json'), 'utf8'));
    assert.strictEqual(aliases.branchOverrides['fixture:orphan-branch'], 'PROJ-999');

    const ghost = await authed('POST', '/api/radar/tag', { repo: 'fixture', branch: 'no-such-branch', epic: 'PROJ-999' });
    assert.strictEqual(ghost.status, 422, 'an unknown branch is validated against the snapshot');

    const decide = await authed('POST', '/api/radar/decide', { title: 'ship the radar tab', epic: 'PROJ-999' });
    assert.strictEqual(decide.status, 200);
    const id = decide.json.decision.id;
    assert.strictEqual((await authed('POST', `/api/radar/decisions/${encodeURIComponent(id)}/close`)).status, 200);
    assert.strictEqual((await authed('POST', `/api/radar/decisions/${encodeURIComponent(id)}/close`)).status, 422, 'closing twice is refused');

    const flag = await authed('POST', '/api/radar/flag', { epic: 'PROJ-999', state: 'off' });
    assert.strictEqual(flag.status, 200);
    const aliases2 = JSON.parse(await fsp.readFile(path.join(radarDir, 'aliases.json'), 'utf8'));
    assert.strictEqual(aliases2.flags['PROJ-999'].state, 'off');
    assert.ok(aliases2.flags['PROJ-999'].assertedAt, 'an assertion carries its date so it can go stale');

    const big = await call(srv.base, 'POST', '/api/radar/decide', { token: TOKEN, body: JSON.stringify({ title: 'x'.repeat(BODY_CAP + 500) }) });
    assert.strictEqual(big.status, 413);

    // and the cmux side is unchanged throughout
    assert.strictEqual((await authed('GET', '/api/cmux/machines')).status, 200);
  } finally {
    await srv.stop();
    await fx.cleanup();
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});

// ---- the real server: the error boundary, on the shipped code ----------------------------------

test('a poisoned collector in a REAL server cannot take the cmux routes down', async () => {
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-boom-')));
  const TOKEN = 'boom-token';
  const srv = await bootServer({
    cwd: scratch,
    nodeArgs: ['--require', path.join(__dirname, 'helpers', 'radar-boom.js')],
    env: { SERVER_TOKEN: TOKEN, RADAR_ENABLED: '1', RADAR_DIR: path.join(scratch, '.radar') },
  });
  try {
    // The server booted at all — start() and the boot scan both threw and were contained.
    assert.ok(srv.alive());

    for (const [method, p, body] of [
      ['GET', '/api/radar/state', undefined],
      ['POST', '/api/radar/scan', undefined],
      ['POST', '/api/radar/tag', { repo: 'r', branch: 'b', epic: 'E' }],
      ['POST', '/api/radar/decide', { title: 't' }],
      ['POST', '/api/radar/flag', { epic: 'E', state: 'on' }],
    ]) {
      const r = await call(srv.base, method, p, { token: TOKEN, body });
      assert.ok(r.status === 500 || r.status === 422, `${method} ${p} -> ${r.status}`);
      assert.match(r.text, /BOOM|radar_error|unprocessable/);
    }

    // The control: existing routes, after radar has thrown on every single request.
    const machines = await call(srv.base, 'GET', '/api/cmux/machines', { token: TOKEN });
    assert.strictEqual(machines.status, 200);
    assert.deepStrictEqual(machines.json, { machines: [] });
    const boot = await call(srv.base, 'GET', '/api/cmux/bootstrap', { token: TOKEN });
    assert.strictEqual(boot.status, 200);
    const ui = await fetch(`${srv.base}/`);
    assert.strictEqual(ui.status, 200, 'the UI still serves');
    assert.ok(srv.alive(), 'and the process is still up');
  } finally { await srv.stop(); await fsp.rm(scratch, { recursive: true, force: true }); }
});


// ---- A8: a fault is not a refusal --------------------------------------------------------------

test('A8: a genuine collector FAULT during a mutation is 500, not 422', async () => {
  // 422 tells the caller "your request named something I do not know" — fix your input. A disk
  // error or a bug in radar is not that, and reporting it as 422 sends the caller to debug a
  // correct request. Only collector refusals are 4xx.
  const m = await mount(stubCollector({
    tagBranch: async () => { throw new Error('ENOSPC: no space left on device'); },
    tagSpec: async () => { throw new Error('Cannot read properties of undefined'); },
    setFlag: async () => { throw new Error('boom'); },
  }));
  try {
    const tag = await call(m.base, 'POST', '/api/radar/tag', { body: { repo: 'r', branch: 'b', epic: 'E' } });
    assert.strictEqual(tag.status, 500, 'a disk fault is radar\'s problem, not the caller\'s');
    assert.strictEqual(tag.json.error, 'radar_error');
    assert.match(tag.json.message, /ENOSPC/, 'the reason is still carried verbatim, never hidden');

    const spec = await call(m.base, 'POST', '/api/radar/tag', { body: { kind: 'spec', specFolder: 'p1-x', epic: 'E' } });
    assert.strictEqual(spec.status, 500);

    const flag = await call(m.base, 'POST', '/api/radar/flag', { body: { epic: 'E', state: 'on' } });
    assert.strictEqual(flag.status, 500);
  } finally { await m.close(); }
});

test('A8: the real collector still refuses (422) for genuinely unknown input', async () => {
  const m = await mount(stubCollector({
    tagBranch: async () => { throw refuse('unknown repo nope (known: app-web)'); },
  }));
  try {
    const r = await call(m.base, 'POST', '/api/radar/tag', { body: { repo: 'nope', branch: 'b', epic: 'E' } });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'unprocessable');
  } finally { await m.close(); }
});
