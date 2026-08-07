'use strict';
// p11 S-006 — the ROUTE half of the dispatch mechanism: POST /api/radar/dispatch.
//
// WHY THIS FILE EXISTS. radar-server.js imported createDispatcher and never called it. The commit
// message and the p11 notes both said the route was mounted beside the p6 handoff routes; it was
// not, and nothing in the suite would have noticed, because test/radar-p11-dispatch.test.js drives
// createDispatcher in process with injected deps — it proves the MECHANISM and cannot see whether
// anything reaches it. A dead import is exactly the shape of defect that survives a green suite, so
// the assertions here are about the wiring: a real HTTP request, over a real socket, arriving at the
// real dispatcher.
//
// The division of labour is the same one radar-p6-server.test.js draws. radar/dispatch.js owns every
// judgment and its own tests pin them; what is proved here is that the route inherits the three
// gates it is supposed to inherit (authed(), the token-in-url refusal, the 16 KB cap), refuses on a
// viewer, and relays {status, payload} without a reshaping layer in between.
//
// SYNTHETIC EVERYTHING (spec F19): PROJ/ALPHA identifiers, /repo/<name> paths, loopback bridges.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRadar, BODY_CAP } = require('../radar-server');
const { bootServer, call } = require('./helpers/server-boot');

// A fixed clock, injected through createRadar's `now` seam: eligibility is an idle-seconds
// comparison, so a fixture built against the wall clock would be a slow-machine flake.
const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

const BRIDGE_ID = 'leader-1';
const SECRET_REF = 'ALPHA_BRIDGE_SECRET';
const OPERATOR_REF = 'ALPHA_OPERATOR_TOKEN';

// The state shape is radar-p11-dispatch.test.js's, unchanged: one epic, one idle session on its
// cluster, one addressable surface. Reused rather than re-invented so route tests and mechanism
// tests cannot disagree about what an eligible session looks like.
const SESSION = (over) => Object.assign({
  key: { machine: BRIDGE_ID, sessionId: 'sess-a' },
  surface: { tabRef: 'surface:2' }, surfaceReason: null,
  repo: 'example-web', worktree: 'feature/PROJ-1-thing', epic: 'PROJ-1',
  status: 'idle', lastEventAt: agoMin(10), lastSubmitAt: agoMin(11),
}, over);

const STATE = (sessions) => ({
  collectorId: BRIDGE_ID,
  sessions: sessions || [SESSION()],
  workRefs: [{
    urn: 'urn:work:jira:PROJ-1', source: 'jira', sourceId: 'PROJ-1', kind: 'epic',
    title: 'a thing', status: { native: 'In Progress', nativeCategory: 'indeterminate', canonical: 'active' },
    cluster: 'PROJ-1', links: ['urn:work:git:example-web/feature/PROJ-1-thing'], selectable: true, route: null,
  }],
});

const REQ = (over) => Object.assign(
  { workRefUrns: ['urn:work:jira:PROJ-1'], authority: 'sean', runId: 'run-1' },
  over || {},
);

// ---- harness -------------------------------------------------------------------------------------

function stubCollector(over) {
  return Object.assign({
    paths: { dir: '/tmp/stub-radar-p11' },
    getState: async () => STATE(),
    scan: async () => ({ ok: true, published: true, warnings: [], error: null, durationMs: 1, state: null }),
    start: () => {}, stop: () => {}, isScanning: () => false,
  }, over || {});
}

// A config file ON DISK, because that is where the switch lives: the route re-reads it per request
// precisely so an operator can flip `dispatch.enabled` without a restart, and a test that injected a
// config object would prove nothing about that path. `dispatch` is omitted by default — the shipped
// default is off, and the tests that need it on say so loudly.
async function radarDirWith(over) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p11-route-')));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(Object.assign({
    configVersion: 1,
    role: 'leader',
    collectorId: BRIDGE_ID,
    repos: [{ id: 'example-web', path: '/repo/example-web' }],
    resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: true },
    bridges: [{ id: BRIDGE_ID, baseUrl: 'http://127.0.0.1:9', secretRef: SECRET_REF }],
  }, over || {}), null, 2));
  return dir;
}

// Records every bridge call and answers whatever the test wired in. The default is the bridge's
// success envelope; `{ok:true}` from the transport alone must never be enough (see the send test).
function stubBridge(answer) {
  const calls = [];
  return {
    calls,
    http: async (url, opts) => {
      calls.push({ url, opts });
      return answer || { ok: true, status: 200, json: { ok: true } };
    },
  };
}

async function mount(over) {
  const radar = createRadar(Object.assign({
    createCollector: () => stubCollector((over || {}).collector),
    scanOnStart: false,
    log: () => {},
    now: () => NOW,
  }, over || {}));
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

// One dispatch against a fully wired route: temp config dir, stub collector, stub bridge, injected
// env. Everything a caller can reach is real from the socket inward.
async function dispatchWith(opts) {
  const o = opts || {};
  const dir = await radarDirWith(o.config);
  const bridge = stubBridge(o.bridgeAnswer);
  const m = await mount({
    collector: Object.assign({ paths: { dir, config: path.join(dir, 'config.json') } }, o.collector),
    bridgeHttp: bridge.http,
    env: Object.assign({ [SECRET_REF]: 'bridge-secret' }, o.env),
    createDispatcher: o.createDispatcher,
  });
  try {
    const res = await call(m.base, 'POST', '/api/radar/dispatch', { body: o.body === undefined ? REQ() : o.body });
    return { res, bridge, base: m.base };
  } finally {
    await m.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---- the route exists at all (defect D3) -----------------------------------------------------------

test('POST /api/radar/dispatch is MOUNTED — the dead import is called and answers the dispatcher\'s envelope', async () => {
  const { res } = await dispatchWith({ body: REQ({ authority: 'operator' }) });
  assert.notStrictEqual(res.status, 404, 'the route existed only in a commit message before this');
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.json.error, 'dispatch_disabled');
});

test('GET /api/radar/dispatch is not a route — a dispatch is a mutation and may not be reachable from a link or a prefetch', async () => {
  const dir = await radarDirWith();
  const m = await mount({ collector: { paths: { dir, config: path.join(dir, 'config.json') } } });
  try {
    const r = await call(m.base, 'GET', '/api/radar/dispatch');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json.error, 'not_found');
  } finally { await m.close(); await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---- the three inherited gates ---------------------------------------------------------------------

test('the route is behind authed() and refuses a token in the URL — proved on the REAL shipped server', async () => {
  const dir = await radarDirWith();
  const srv = await bootServer({
    env: { SERVER_TOKEN: 'route-secret', RADAR_ENABLED: '1', RADAR_DIR: dir, RADAR_SCAN_ON_START: '0' },
  });
  try {
    const anon = await call(srv.base, 'POST', '/api/radar/dispatch', { body: REQ() });
    assert.strictEqual(anon.status, 401, 'an unauthenticated dispatch must never reach the dispatcher');
    assert.deepStrictEqual(anon.json, { error: 'unauthorized' }, 'server.js\'s envelope verbatim');

    // A token in a query string lands in browser history and every access log that records one, so
    // radar refuses to be authenticated that way at all — even when the token is correct.
    const inUrl = await call(srv.base, 'POST', '/api/radar/dispatch?token=route-secret', { token: 'route-secret', body: REQ() });
    assert.strictEqual(inUrl.status, 401);
    assert.deepStrictEqual(inUrl.json, { error: 'token_in_url' });

    // and the same request WITH a bearer reaches the dispatcher, which refuses it on its own terms
    const authed = await call(srv.base, 'POST', '/api/radar/dispatch', { token: 'route-secret', body: REQ({ authority: 'operator' }) });
    assert.strictEqual(authed.status, 503);
    assert.strictEqual(authed.json.error, 'dispatch_disabled');
  } finally { await srv.stop(); await fsp.rm(dir, { recursive: true, force: true }); }
});

test('with RADAR_ENABLED unset the route does not exist — the rollback story covers it like every other radar route', async () => {
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p11-off-')));
  const srv = await bootServer({ cwd: scratch, env: { SERVER_TOKEN: 'off-token' } });
  try {
    const r = await call(srv.base, 'POST', '/api/radar/dispatch', { token: 'off-token', body: REQ() });
    assert.strictEqual(r.status, 404, 'unset RADAR_ENABLED must mean the dispatch surface is not there at all');
    assert.strictEqual(r.json.error, 'not_found');
  } finally { await srv.stop(); await fsp.rm(scratch, { recursive: true, force: true }); }
});

test('the §7 body cap applies: >16 KiB is 413 and malformed JSON is 400, both BEFORE the dispatcher sees anything', async () => {
  const seen = [];
  const spy = () => ({ dispatch: async (b) => { seen.push(b); return { status: 200, payload: { dispatched: true } }; } });

  const big = await dispatchWith({ createDispatcher: spy, body: JSON.stringify({ pad: 'x'.repeat(BODY_CAP + 1) }) });
  assert.strictEqual(big.res.status, 413);
  assert.strictEqual(big.res.json.error, 'body_too_large');
  assert.ok(typeof big.res.json.message === 'string' && big.res.json.message.length > 0);

  const bad = await dispatchWith({ createDispatcher: spy, body: '{nope' });
  assert.strictEqual(bad.res.status, 400);
  assert.strictEqual(bad.res.json.error, 'bad_json');

  assert.deepStrictEqual(seen, [], 'a refused body never reaches the mechanism');
});

test('a viewer refuses the dispatch before the body is read, and the dispatcher is never consulted', async () => {
  const seen = [];
  const spy = () => ({ dispatch: async (b) => { seen.push(b); return { status: 200, payload: {} }; } });
  const { res } = await dispatchWith({
    createDispatcher: spy,
    config: { role: 'viewer', leaderBaseUrl: 'http://leader.invalid:8080' },
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.error, 'viewer_readonly');
  assert.strictEqual(res.json.leaderBaseUrl, 'http://leader.invalid:8080');
  assert.deepStrictEqual(seen, [], 'a viewer would inject into its own pane against the leader\'s snapshot');
});

// ---- the relay ---------------------------------------------------------------------------------------

test('the dispatcher\'s {status, payload} is relayed VERBATIM — there is no reshaping layer to drift', async () => {
  const envelope = { status: 418, payload: { error: 'invented_code', detail: 'whatever the module says', route: { kind: 'resume' } } };
  const { res } = await dispatchWith({ createDispatcher: () => ({ dispatch: async () => envelope }) });
  assert.strictEqual(res.status, 418);
  assert.deepStrictEqual(res.json, envelope.payload);
});

// ---- the authority gate, over HTTP (spec §8.1, Codex round 1 finding 4) -------------------------------

test('operator authority is 503 dispatch_disabled while the switch is off, and the switch is off by DEFAULT', async () => {
  // No `dispatch` block in the config at all: this is the shipped shape, and it must refuse.
  const { res, bridge } = await dispatchWith({ body: REQ({ authority: 'operator', authorityToken: 'anything' }) });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.json.error, 'dispatch_disabled');
  assert.match(res.json.detail, /Hermes authority layer/);
  assert.deepStrictEqual(bridge.calls, [], 'nothing may be injected by a refused dispatch');

  // and written out explicitly, it still refuses
  const explicit = await dispatchWith({
    config: { dispatch: { enabled: false, authorityTokenRef: OPERATOR_REF } },
    body: REQ({ authority: 'operator' }),
  });
  assert.strictEqual(explicit.res.status, 503);
});

test('with the switch ON the operator token is read from the env var the config NAMES — wrong or missing is 403', async () => {
  const on = { dispatch: { enabled: true, authorityTokenRef: OPERATOR_REF } };
  const env = { [OPERATOR_REF]: 'operator-secret' };

  const wrong = await dispatchWith({ config: on, env, body: REQ({ authority: 'operator', authorityToken: 'nope' }) });
  assert.strictEqual(wrong.res.status, 403);
  assert.strictEqual(wrong.res.json.error, 'authority_refused');
  assert.deepStrictEqual(wrong.bridge.calls, []);

  const missing = await dispatchWith({ config: on, env, body: REQ({ authority: 'operator' }) });
  assert.strictEqual(missing.res.status, 403);

  // The env var is UNSET while the config still names it: no token can then be right.
  const unset = await dispatchWith({ config: on, body: REQ({ authority: 'operator', authorityToken: 'operator-secret' }) });
  assert.strictEqual(unset.res.status, 403, 'a named ref with nothing behind it may not authorise anything');

  const right = await dispatchWith({ config: on, env, body: REQ({ authority: 'operator', authorityToken: 'operator-secret' }) });
  assert.strictEqual(right.res.status, 200, 'the mechanism works once enabled — what ships is the refusal, not a stub');
  assert.strictEqual(right.res.json.route.kind, 'resume');
});

test('an unrecognised authority is 400 over HTTP too, never defaulted to the safer-sounding one', async () => {
  for (const a of [undefined, 'admin', 'root']) {
    const { res } = await dispatchWith({ body: REQ({ authority: a }) });
    assert.strictEqual(res.status, 400, `authority ${JSON.stringify(a)}`);
    assert.strictEqual(res.json.error, 'bad_request');
  }
});

// ---- the server-side re-check, reached through the route ----------------------------------------------

test('eligibility is recomputed at dispatch time: a RUNNING session on the cluster is 409, with no spawn fallback', async () => {
  const { res, bridge } = await dispatchWith({ collector: { getState: async () => STATE([SESSION({ status: 'running' })]) } });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.error, 'cluster_busy');
  assert.strictEqual(res.json.detail, 'cluster-running');
  assert.deepStrictEqual(bridge.calls, [], 'never two writers — and the route is where that can be enforced');
});

test('a BLOCKED session on the cluster is refused the same way', async () => {
  const { res } = await dispatchWith({ collector: { getState: async () => STATE([SESSION({ status: 'blocked' })]) } });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.detail, 'cluster-blocked');
});

test('a caller may PROPOSE a target but not choose one — the route re-resolves and refuses a stale proposal', async () => {
  const { res, bridge } = await dispatchWith({ body: REQ({ route: { kind: 'resume', sessionId: 'sess-somewhere-else' } }) });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.error, 'target_mismatch');
  assert.deepStrictEqual(bridge.calls, []);
});

test('a leader that can see no repos refuses rather than routing against an inventory it cannot reach', async () => {
  const { res, bridge } = await dispatchWith({ config: { repos: [] } });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json.error, 'not_leader');
  assert.match(res.json.detail, /zero repos/);
  assert.deepStrictEqual(bridge.calls, [], 'the two-leader topology is refused, not routed around');
});

test('an unknown workRef is 404 and a batch is 400 — one packet, one run', async () => {
  const unknown = await dispatchWith({ body: REQ({ workRefUrns: ['urn:work:jira:NOPE-1'] }) });
  assert.strictEqual(unknown.res.status, 404);
  assert.strictEqual(unknown.res.json.error, 'unknown_workref');

  const batch = await dispatchWith({ body: REQ({ workRefUrns: ['urn:work:jira:PROJ-1', 'urn:work:jira:PROJ-2'] }) });
  assert.strictEqual(batch.res.status, 400);
});

// ---- the injection itself ------------------------------------------------------------------------------

test('a resume reaches the SAME bridge contract the reply route uses: POST /cmux/send, addressed by surface, secret header attached', async () => {
  const { res, bridge } = await dispatchWith({});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.route.kind, 'resume');
  assert.strictEqual(res.json.route.sessionId, 'sess-a');
  assert.strictEqual(res.json.dispatched, true);

  assert.strictEqual(bridge.calls.length, 1, 'one dispatch, one send — never a retry loop');
  const sent = bridge.calls[0];
  assert.strictEqual(sent.url, 'http://127.0.0.1:9/cmux/send');
  assert.strictEqual(sent.opts.method, 'POST');
  assert.strictEqual(sent.opts.headers['x-bridge-secret'], 'bridge-secret',
    'the bridge secret is resolved from secretRef exactly as collectMachine resolves it');
  const body = JSON.parse(sent.opts.body);
  assert.strictEqual(body.surface, 'surface:2', 'addressed by surface ref, never by tabUuid or workspace');
  assert.strictEqual(body.submit, true);
  assert.match(body.text, /Never delete branches/, 'the seed carries the hard rules');
  assert.match(body.text, /STOP and ask/);
});

test('a bridge that does not say ok:true is a failure, not a silent success', async () => {
  // The transport answered 200 with a body that never confirmed the send. Treating that as a
  // success is how a dispatch reports work started that never was.
  const { res, bridge } = await dispatchWith({ bridgeAnswer: { ok: true, status: 200, json: { queued: 'maybe' } } });
  assert.strictEqual(bridge.calls.length, 1);
  assert.notStrictEqual(res.status, 200, 'an unconfirmed send may not be reported as a dispatch');
});

test('an unroutable machine is a refusal, not an exception escaping as a 500', async () => {
  const { res } = await dispatchWith({ collector: { getState: async () => STATE([SESSION({ key: { machine: 'beta-2', sessionId: 'sess-a' } })]) } });
  assert.ok(res.status >= 400 && res.status < 600);
  assert.notStrictEqual(res.json.error, 'radar_error', 'a bridge this server cannot resolve is an answer, not a fault');
});

// ---- the spawn arm -----------------------------------------------------------------------------------

test('with nothing eligible the route reaches the SPAWN arm, and refuses on its own terms rather than 501', async () => {
  // This used to answer 501 spawn_unavailable, because p6 owned the only session spawn in the
  // repository and it lived in the middle of commit(). That spawn is now an extracted primitive
  // (radar/handoff.js spawnSession) and radar-server.js wires the dep to it — so the arm is REACHED.
  // What it does once reached is radar-p11-spawn.test.js's subject; the assertion here is only that
  // nothing answers "no spawn implementation wired" any more.
  //
  // This fixture has no polyrepoRoot and no claudeBin on disk, so the preflight refuses the launch:
  // 502 spawn_failed, the dispatcher's documented code for a spawn that threw.
  const { res, bridge } = await dispatchWith({ collector: { getState: async () => STATE([]) } });
  assert.notStrictEqual(res.status, 501, 'the dep is wired; 501 spawn_unavailable is now unreachable');
  assert.notStrictEqual(res.json.error, 'spawn_unavailable');
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.json.error, 'spawn_failed');
  assert.deepStrictEqual(bridge.calls, [], 'nothing was injected on the way to that answer');
});
