'use strict';
// p9 S-007 — POST /api/radar/inbox/reply: admission, validation, authorisation, machine resolution,
// the lease, and the three gates that stand between an operator's sentence and a live terminal.
//
// WHY THIS FILE IS SHAPED THE WAY IT IS. §2.1 principle 4: a blind write into a terminal is the one
// dangerous act in this feature. Text sent to a pane that is not at a prompt goes wherever the
// cursor happens to be. So the assertions below are almost never "the happy path works" — they are
// "the refusal fires, and NOTHING downstream ran". Every gate test therefore asserts the response
// code AND the absence of the calls that gate is supposed to prevent, because a gate that answers
// correctly while still having fetched a grid or sent text is not a gate.
//
// The asymmetry that orders the send mapping (§5.5 step 8) is asserted directly: an outcome may only
// read as "nothing was typed" when the bridge's contract PROVES the rejection preceded typing.
// `send_failed` tells the operator to retry immediately; if that is ever wrong they double-type into
// a live terminal. Everything unprovable is `send_unconfirmed` and takes the lease.
//
// Offline and deterministic by construction:
//   * gate 1 reads REAL event files off a temp RADAR_DIR (local bridge) or an INJECTED transport
//     (remote bridge) — the same exported primitive on both paths, never a stubbed fold;
//   * every bridge call goes through an injected transport, so no socket is opened;
//   * every deadline is the route's own, driven by an injected timer factory — a real fake clock,
//     not a sleep;
//   * the clock is injected, so the lease boundary is tested AT the comparator, not near it.
//
// Every fixture is synthesised: invented session ids on the reserved `fixture-inbox-N` grammar,
// invented machine, workspace, tab and file names, invented timestamps, invented text.

const { test, mock } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRadar } = require('../radar-server');
const sessions = require('../radar/mod-sessions');
const eventlog = require('../radar/eventlog');

// ---- synthetic identity --------------------------------------------------------------------------

const MACHINE = 'fixture-box';
const S1 = 'fixture-inbox-1';
const S2 = 'fixture-inbox-2';
const TAB = 'fixture-tab-1111';
const TAB2 = 'fixture-tab-2222';
const CWD = '/fixture/work/sample-service';
const TOKEN = 'fixture-server-token';

const NOW = Date.parse('2026-01-02T03:00:10.000Z');
const BLOCKED = Date.parse('2026-01-02T03:00:00.000Z');
const ISO = (ms) => new Date(ms).toISOString();

// ---- grid fixtures -------------------------------------------------------------------------------
// Built from paneKind's actual decision rule rather than copied from a capture: a boxed prompt
// (rule / ❯ / rule) BELOW a themed shell prompt is an agent; the same two signatures in the other
// order is a shell that the agent has exited. Position is the whole discriminator.

const GRID_STYLES = [
  { id: 0, background: '#000000', foreground: '#999999', inverse: false },
  { id: 1, background: '#1A1A1A', foreground: '#FFFFFF', inverse: false },
];
const RULE = '────────────────';
const SHELL_ROW = ' demouser@127  ~ ';

const AGENT_GRID = {
  active_screen: 'primary',
  cursor: { row: 4, column: 2 },
  styles: GRID_STYLES,
  row_spans: [
    { row: 1, column: 0, style_id: 1, text: SHELL_ROW },
    { row: 3, column: 0, style_id: 0, text: RULE },
    { row: 4, column: 0, style_id: 0, text: '❯ ' },
    { row: 5, column: 0, style_id: 0, text: RULE },
  ],
};
const SHELL_GRID = {
  active_screen: 'primary',
  cursor: { row: 6, column: 0 },
  styles: GRID_STYLES,
  row_spans: [
    { row: 0, column: 0, style_id: 0, text: RULE },
    { row: 1, column: 0, style_id: 0, text: '❯ ' },
    { row: 2, column: 0, style_id: 0, text: RULE },
    { row: 4, column: 0, style_id: 1, text: SHELL_ROW },
  ],
};
const ALTSCREEN_GRID = {
  active_screen: 'alternate',
  styles: [{ id: 0, background: '#000000', foreground: '#FFFFFF' }],
  row_spans: [{ row: 0, column: 0, style_id: 0, text: 'editor' }],
};
const UNKNOWN_GRID = {
  active_screen: 'primary',
  styles: [{ id: 0, background: '#000000', foreground: '#FFFFFF' }],
  row_spans: [{ row: 0, column: 0, style_id: 0, text: 'plain output line' }],
};

// The fixtures are only worth what paneKind says about them, so that is asserted before any route
// test leans on them. A silently-miscoloured grid would make gate 3 look correct while proving
// nothing at all.
test('the grid fixtures really are agent / shell / altscreen / unknown to the shipped paneKind', () => {
  const { paneKind } = require('../public/menuparse.js');
  assert.strictEqual(paneKind({ grid: AGENT_GRID, status: '' }).kind, 'agent');
  assert.strictEqual(paneKind({ grid: SHELL_GRID, status: '' }).kind, 'shell');
  assert.strictEqual(paneKind({ grid: ALTSCREEN_GRID, status: '' }).kind, 'altscreen');
  assert.strictEqual(paneKind({ grid: UNKNOWN_GRID, status: '' }).kind, 'unknown');
  // The trap gate 3 exists to close, proved on the fixture itself: the workspace-scoped status
  // string alone flips the SHELL grid to `agent`, at paneKind's highest precedence.
  assert.strictEqual(paneKind({ grid: SHELL_GRID, status: 'claude_code=Running' }).kind, 'agent');
});

// ---- event fixtures ------------------------------------------------------------------------------

function ev(over) {
  return Object.assign({
    ts: BLOCKED,
    sessionId: S1,
    event: 'Notification',
    notificationType: 'idle_prompt',
    cwd: CWD,
  }, over || {});
}

// The default waiting session: answered, stopped, then blocked on an idle prompt, with its own tab
// recorded at every step.
function baseEvents() {
  return [
    ev({ ts: BLOCKED - 60000, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB }),
    ev({ ts: BLOCKED - 1000, event: 'Stop', notificationType: null, surfaceId: TAB }),
    ev({ ts: BLOCKED, surfaceId: TAB }),
  ];
}

const TURN = { blockedSince: ISO(BLOCKED), assistantTs: null };
const REPLY = 'Per batch, and cap it at five.';

// ---- the tree ------------------------------------------------------------------------------------

function treeWith(uuids) {
  const ids = Array.isArray(uuids) ? uuids : [uuids];
  return {
    workspaces: [{
      ref: 'fixture-workspace',
      title: 'fixture-workspace',
      tabs: ids.map((id, i) => ({ id, ref: `tab-${i + 1}`, type: 'terminal', status: '', statusCovered: true })),
    }],
  };
}

// The real producer's shape: `list-status` runs ONCE per workspace and the same string is stamped
// onto the workspace and onto every terminal tab with statusScope 'workspace'. A workspace where any
// tab runs Claude therefore advertises 'Claude running' on its shell tabs too.
function workspaceStatusTree(uuids, status) {
  const t = treeWith(uuids);
  t.workspaces[0].status = status;
  t.workspaces[0].statusScope = 'workspace';
  for (const tab of t.workspaces[0].tabs) { tab.status = status; tab.statusScope = 'workspace'; }
  return t;
}

// ---- transports ----------------------------------------------------------------------------------

const routeOf = (url) => (url.includes('/cmux/session-events') ? 'events'
  : url.includes('/cmux/tree') ? 'tree'
    : url.includes('/cmux/grid') ? 'grid'
      : url.includes('/cmux/send') ? 'send' : 'other');

// One injected transport for every bridge call the route makes. It records WHAT was asked as well as
// what was answered, because most of this story's acceptance criteria are about calls that must not
// happen and headers that must be present.
function stubHttp(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const o = opts || {};
    const kind = routeOf(url);
    const call = { kind, url, method: o.method || 'GET', headers: o.headers || {}, body: o.body, signal: o.signal, timeoutMs: o.timeoutMs };
    calls.push(call);
    const h = routes[kind];
    if (h === undefined) throw new Error(`unstubbed bridge call: ${kind} ${url}`);
    return typeof h === 'function' ? await h(call) : h;
  };
  fn.calls = calls;
  fn.kinds = () => calls.map((c) => c.kind);
  fn.count = (kind) => calls.filter((c) => c.kind === kind).length;
  fn.last = (kind) => calls.filter((c) => c.kind === kind).pop() || null;
  return fn;
}

const okTree = (uuids) => async () => ({ ok: true, status: 200, json: treeWith(uuids === undefined ? TAB : uuids) });
const okGrid = (grid, seq) => async () => ({ ok: true, status: 200, json: { seq: seq === undefined ? 77 : seq, grid: grid || AGENT_GRID } });
const okSend = () => async () => ({ ok: true, status: 200, json: { ok: true } });

function happyRoutes(over) {
  return Object.assign({ tree: okTree(), grid: okGrid(), send: okSend() }, over || {});
}

// A promise a test can await and resolve from anywhere — the only honest way to say "the client
// disconnected WHILE this call was in flight".
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A transport that parks until the request-scoped signal fires, then rejects the way a real aborted
// fetch does. This is what proves the ctx.signal plumbing rather than merely proving that later
// gates were skipped.
function parkUntilAborted(started) {
  return (call) => new Promise((_resolve, reject) => {
    const sig = call.signal;
    const fail = () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (!sig) return reject(new Error('the route passed no signal to this call'));
    if (sig.aborted) return fail();
    sig.addEventListener('abort', fail, { once: true });
    if (started) started.resolve(call);
  });
}

// ---- a fake clock for the route's own deadlines ---------------------------------------------------
// Every timeout in this route is created by the ROUTE on an AbortController it owns, so a timer
// factory is a complete fake clock for it: the test can read what durations are armed and fire them.

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    api: {
      setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
    },
    armed: () => [...pending.values()].map((t) => t.ms),
    fireAll() { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } },
  };
}

// ---- the harness ---------------------------------------------------------------------------------

async function tempDir() {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-reply-')));
}

async function writeConfig(dir, over) {
  const cfg = Object.assign({
    configVersion: 1,
    role: 'leader',
    collectorId: MACHINE,
    scanIntervalMin: 10,
    sessionSweepSec: 60,
    repos: [],
    timeouts: { bridgeMs: 5000 },
  }, over || {});
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  return cfg;
}

async function writeEvents(dir, events) {
  const evdir = path.join(dir, 'events');
  await fsp.mkdir(evdir, { recursive: true });
  const byDay = new Map();
  for (const e of events || []) {
    const f = eventlog.dayFile(evdir, e.ts);
    if (!byDay.has(f)) byDay.set(f, []);
    byDay.get(f).push(JSON.stringify(e));
  }
  for (const [f, lines] of byDay) await fsp.writeFile(f, lines.join('\n') + '\n');
  return evdir;
}

// The stub collector exists only to hand the route REAL paths. Nothing in this story reads a
// snapshot: the reply route folds the event log and writes nothing at all.
function stubCollector(dir) {
  return {
    paths: {
      dir,
      config: path.join(dir, 'config.json'),
      state: path.join(dir, 'state.json'),
      aliases: path.join(dir, 'aliases.json'),
      decisions: path.join(dir, 'decisions.json'),
      events: path.join(dir, 'events'),
    },
    stats: {},
    getState: async () => null,
    lastStateSync: () => null,
    scan: async () => ({ ok: true, published: false, warnings: [], error: null, durationMs: 1, state: null }),
    start: () => {},
    stop: () => {},
    isScanning: () => false,
  };
}

async function mount(dir, over) {
  const logs = [];
  const writes = [];
  const radar = createRadar(Object.assign({
    createCollector: () => stubCollector(dir),
    scanOnStart: false,
    log: () => {},
    env: { SERVER_TOKEN: TOKEN },
    inboxLog: (l) => logs.push(l),
    now: () => NOW,
  }, over || {}));

  const srv = http.createServer(async (req, res) => {
    // Recorded at the socket edge: "no response bytes were written after the abort" is an assertion
    // about what the ROUTE did, and only a wrapper here can see it once the client is gone.
    const wh = res.writeHead.bind(res);
    res.writeHead = (...a) => { writes.push({ kind: 'head', status: a[0] }); return wh(...a); };
    const end = res.end.bind(res);
    res.end = (...a) => { writes.push({ kind: 'end', body: typeof a[0] === 'string' ? a[0] : null }); return end(...a); };
    const u = new URL(req.url, 'http://x');
    try { await radar.handle(req, res, u); } catch (e) {
      if (!res.headersSent) { try { res.writeHead(500); } catch (_) { /* gone */ } }
      try { res.end(); } catch (_) { /* gone */ }
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    radar,
    logs,
    writes,
    dir,
    base: `http://127.0.0.1:${srv.address().port}`,
    async close() {
      await new Promise((r) => srv.close(r));
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

// One call: build the temp radar dir, write the config and the events, mount the route.
async function setup(o) {
  const opts = o || {};
  const dir = await tempDir();
  await writeConfig(dir, opts.config);
  await writeEvents(dir, opts.events === undefined ? baseEvents() : opts.events);
  const httpStub = stubHttp(happyRoutes(opts.routes));
  const m = await mount(dir, Object.assign({ bridgeHttp: httpStub }, opts.radar || {}));
  m.http = httpStub;
  return m;
}

async function post(base, body) {
  const r = await fetch(`${base}/api/radar/inbox/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep the text */ }
  return { status: r.status, json, text };
}

const goodBody = (over) => Object.assign({ machine: MACHINE, sessionId: S1, text: REPLY, turn: TURN }, over || {});

// A raw request, so a body can be oversized, truncated, or abandoned mid-flight — none of which
// `fetch` will do on request.
function rawPost(base, payload, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/radar/inbox/reply`);
    const headers = { 'content-type': 'application/json' };
    if (o.contentLength !== undefined) headers['content-length'] = String(o.contentLength);
    else headers['content-length'] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', (e) => resolve({ status: null, json: null, text: '', error: e.code || e.message }));
    if (o.abortAfterWrite) {
      req.write(payload);
      setTimeout(() => { req.destroy(); resolve({ status: null, json: null, text: '', aborted: true }); }, 30);
      return;
    }
    req.end(payload);
  });
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 60 : ms));

// ==================================================================================================
// AC 1 — ADMISSION. Two boundaries, not one, and neither of them reaches validation or transport.
// ==================================================================================================

test('AC1: admission — bad_json, non-object bodies, both size boundaries, the hard-cap socket kill, and a mid-body abort', async () => {
  const m = await setup();
  try {
    // Unparseable.
    const bad = await rawPost(m.base, '{not json');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.code, 'bad_json');
    assert.strictEqual(bad.json.message, 'Malformed request.');

    // Parsed, but not a plain object. An array and a null are both valid JSON and neither is a body.
    for (const payload of ['[]', 'null', '"a string"', '7']) {
      const r = await rawPost(m.base, payload);
      assert.strictEqual(r.status, 400, payload);
      assert.strictEqual(r.json.code, 'bad_request', payload);
      assert.strictEqual(r.json.message, 'Malformed request.');
    }

    // BODY_CAP + 1 drains to 413 — the reader answers, it does not cut the connection.
    const overCap = 'x'.repeat(16 * 1024 + 1);
    const r1 = await rawPost(m.base, overCap);
    assert.strictEqual(r1.status, 413);
    assert.strictEqual(r1.json.code, 'body_too_large');
    assert.strictEqual(r1.json.message, 'Reply exceeds the request size cap.');

    // Exactly HARD_CAP is still inside the drain window: the reader destroys only PAST it.
    const atHard = 'y'.repeat(16 * 16 * 1024);
    const r2 = await rawPost(m.base, atHard);
    assert.strictEqual(r2.status, 413);
    assert.strictEqual(r2.json.code, 'body_too_large');

    // HARD_CAP + 1: the reader destroys the socket itself. No response is writable, so none is
    // attempted, and admission never completed so nothing is logged.
    const before = m.writes.length;
    const r3 = await rawPost(m.base, 'z'.repeat(16 * 16 * 1024 + 1));
    assert.strictEqual(r3.status, null, 'the socket must die, not answer');
    assert.ok(r3.error, `expected a transport error, got ${JSON.stringify(r3)}`);
    await settle();
    assert.strictEqual(m.writes.length, before, 'no response bytes for a hard-cap kill');

    // A client that disconnects mid-body: no crash, no response, no log.
    const writesBefore = m.writes.length;
    const r4 = await rawPost(m.base, '{"machine":"fixture-box"', { contentLength: 4096, abortAfterWrite: true });
    assert.strictEqual(r4.aborted, true);
    await settle();
    assert.strictEqual(m.writes.length, writesBefore, 'no response write after a mid-body abort');

    // No crash: the server that just had a socket destroyed under it and a body abandoned mid-flight
    // is still answering. Without this, "no response was written" is equally consistent with a
    // handler that died.
    const alive = await rawPost(m.base, '{still broken');
    assert.strictEqual(alive.status, 400);
    assert.strictEqual(alive.json.code, 'bad_json');

    // NONE of the above reached validation or transport, and step 0 emits no log line at all.
    assert.deepStrictEqual(m.http.kinds(), []);
    assert.deepStrictEqual(m.logs, []);
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 2 — validation. Every refusal here is free: nothing has been asked of any machine yet.
// ==================================================================================================

test('AC2: each invalid parsed body gets its own code, and no fold, tree, grid or send runs', async () => {
  const m = await setup();
  try {
    const cases = [
      [{ sessionId: S1, text: REPLY, turn: TURN }, 400, 'bad_request', 'missing machine'],
      [goodBody({ machine: '   ' }), 400, 'bad_request', 'blank machine'],
      [{ machine: MACHINE, text: REPLY, turn: TURN }, 400, 'bad_request', 'missing sessionId'],
      [goodBody({ turn: undefined }), 400, 'bad_request', 'missing turn'],
      [goodBody({ turn: { assistantTs: null } }), 400, 'bad_request', 'turn without blockedSince'],
      [goodBody({ turn: { blockedSince: '', assistantTs: null } }), 400, 'bad_request', 'empty blockedSince'],
      [goodBody({ turn: { blockedSince: ISO(BLOCKED) } }), 400, 'bad_request', 'assistantTs absent'],
      [goodBody({ turn: { blockedSince: ISO(BLOCKED), assistantTs: 12 } }), 400, 'bad_request', 'assistantTs not string-or-null'],
      [goodBody({ turn: [ISO(BLOCKED)] }), 400, 'bad_request', 'turn is an array'],
      [goodBody({ text: 42 }), 400, 'empty_reply', 'non-string text'],
      [goodBody({ text: undefined }), 400, 'empty_reply', 'missing text'],
      [goodBody({ text: '   \n\t ' }), 400, 'empty_reply', 'whitespace-only text'],
      [goodBody({ text: 'a'.repeat(8193) }), 413, 'reply_too_large', '8193 bytes'],
    ];
    for (const [body, status, code, why] of cases) {
      const r = await post(m.base, body);
      assert.strictEqual(r.status, status, why);
      assert.strictEqual(r.json.code, code, why);
    }
    // The cap is in BYTES, not characters: 4096 three-byte characters are 12288 bytes and are
    // refused, even though they are half the character count that passes.
    const wide = await post(m.base, goodBody({ text: '☃'.repeat(4096) }));
    assert.strictEqual(wide.status, 413);
    assert.strictEqual(wide.json.code, 'reply_too_large');

    // Not one of those bodies reached a transport — validation is free, and it happens before the
    // route asks any machine anything.
    assert.deepStrictEqual(m.http.kinds(), [], 'no transport for a rejected body');

    // The boundary from the other side, last so it cannot pollute the assertion above: 8192 one-byte
    // characters are exactly at the cap and go all the way through.
    const atCap = await post(m.base, goodBody({ text: 'a'.repeat(8192) }));
    assert.strictEqual(atCap.status, 200, m.logs.map((l) => l.code).join(','));
    assert.strictEqual(JSON.parse(m.http.last('send').body).text.length, 8192);
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 3 — authorisation.
// ==================================================================================================

test('AC3: an empty SERVER_TOKEN is 403 unauthenticated_server and a viewer is 409 viewer_refused, neither with a transport call', async () => {
  const open = await setup({ radar: { env: {} } });
  try {
    const r = await post(open.base, goodBody());
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'unauthenticated_server');
    assert.strictEqual(r.json.message, 'Set SERVER_TOKEN to enable replies.');
    assert.deepStrictEqual(open.http.kinds(), []);
  } finally { await open.close(); }

  const viewer = await setup({ config: { role: 'viewer', leaderBaseUrl: 'http://fixture-leader:8080' } });
  try {
    const r = await post(viewer.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'viewer_refused');
    assert.strictEqual(r.json.message, 'This install is a viewer — answer from the leader.');
    assert.deepStrictEqual(viewer.http.kinds(), []);
    // A viewer refusal IS an admitted outcome and is logged; a step-0 refusal is not.
    assert.strictEqual(viewer.logs.length, 1);
    assert.strictEqual(viewer.logs[0].code, 'viewer_refused');
  } finally { await viewer.close(); }
});

// ==================================================================================================
// AC 4 — machine resolution through the RAW config and the exported normalizeBridges.
// ==================================================================================================

test('AC4: the send rides the configured bridge baseUrl and secret; an unknown machine refuses before transport; no bridges[] resolves the implicit local one', async () => {
  const SECRET_REF = 'FIXTURE_BRIDGE_SECRET_M2';
  const prior = process.env[SECRET_REF];
  process.env[SECRET_REF] = 'fixture-secret-value';
  const m2 = 'fixture-box-2';
  // A bridge that is `local` for EVENTS (read off the temp disk) but whose tree/grid/send still ride
  // its configured baseUrl — which is exactly how the leader's own machine is configured in the wild.
  const m = await setup({
    config: {
      collectorId: 'fixture-leader',
      bridges: [{ id: m2, baseUrl: 'http://fixture-bridge-2:8799/', secretRef: SECRET_REF, local: true }],
    },
  });
  try {
    const r = await post(m.base, goodBody({ machine: m2 }));
    assert.strictEqual(r.status, 200, m.logs.map((l) => l.code).join(','));
    const send = m.http.last('send');
    assert.strictEqual(send.url, 'http://fixture-bridge-2:8799/cmux/send', 'the RAW config + normalizeBridges path, trailing slash normalized');
    assert.strictEqual(send.headers['x-bridge-secret'], 'fixture-secret-value');

    // A machine nobody configured is refused BEFORE any transport — the call log is unchanged.
    const kindsBefore = m.http.kinds().length;
    const nope = await post(m.base, goodBody({ machine: 'fixture-nope' }));
    assert.strictEqual(nope.status, 400);
    assert.strictEqual(nope.json.code, 'unknown_machine');
    assert.strictEqual(nope.json.message, 'No bridge is configured for this machine.');
    assert.strictEqual(m.http.kinds().length, kindsBefore, 'unknown_machine never reaches a transport');
  } finally {
    await m.close();
    if (prior === undefined) delete process.env[SECRET_REF]; else process.env[SECRET_REF] = prior;
  }

  // No bridges[] at all: the implicit local bridge carries the collector's own id.
  const implicit = await setup();
  try {
    const r = await post(implicit.base, goodBody());
    assert.strictEqual(r.status, 200, implicit.logs.map((l) => l.code).join(','));
    assert.strictEqual(implicit.http.last('send').url, 'http://127.0.0.1:8799/cmux/send');
    assert.strictEqual(implicit.http.count('events'), 0, 'the implicit local bridge reads events off disk, never over HTTP');
  } finally { await implicit.close(); }
});

// ==================================================================================================
// AC 5 — gate-1 completeness. A read that SUCCEEDED while omitting history is not a complete read.
// ==================================================================================================

// A configured REMOTE bridge, so the events read is an injected HTTP call whose envelope the test
// controls exactly. The local cases below drive the real on-disk reader instead.
function remoteConfig() {
  return {
    collectorId: 'fixture-leader',
    bridges: [{ id: MACHINE, baseUrl: 'http://fixture-bridge:8799', secretRef: 'FIXTURE_BRIDGE_SECRET' }],
  };
}

const remoteEvents = (body) => async () => ({ ok: true, status: 200, json: body });

test('AC5: every incomplete or failed events read is 502 events_unavailable, stops the pipeline, and retains a lease', async () => {
  // (a) LOCAL read error — the events directory is a regular file, so readdir throws.
  {
    const dir = await tempDir();
    await writeConfig(dir);
    await fsp.writeFile(path.join(dir, 'events'), 'not a directory');
    const httpStub = stubHttp(happyRoutes());
    const m = await mount(dir, { bridgeHttp: httpStub });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 502);
      assert.strictEqual(r.json.code, 'events_unavailable');
      assert.strictEqual(r.json.message, "The event log isn't readable right now — nothing was sent.");
      assert.deepStrictEqual(httpStub.kinds(), [], 'fail closed: no tree, no grid, no send');
    } finally { await m.close(); }
  }

  // (b) LOCAL skipped > 0 — one unparseable line is enough to make the history incomplete.
  {
    const dir = await tempDir();
    await writeConfig(dir);
    const evdir = await writeEvents(dir, baseEvents());
    const f = eventlog.dayFile(evdir, BLOCKED);
    await fsp.appendFile(f, '{"ts": broken\n');
    const httpStub = stubHttp(happyRoutes());
    const m = await mount(dir, { bridgeHttp: httpStub });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 502);
      assert.strictEqual(r.json.code, 'events_unavailable');
      assert.deepStrictEqual(httpStub.kinds(), []);
    } finally { await m.close(); }
  }

  // (c) LOCAL more:true — the on-disk reader's own page cap, which the collector never surfaced.
  {
    const dir = await tempDir();
    await writeConfig(dir);
    const many = [];
    for (let i = 0; i < eventlog.MAX_PAGE + 1; i++) {
      many.push(ev({ ts: BLOCKED - (eventlog.MAX_PAGE + 1 - i) * 10, sessionId: `fixture-inbox-${100 + i}`, event: 'Stop', notificationType: null }));
    }
    many.push(...baseEvents());
    await writeEvents(dir, many);
    const httpStub = stubHttp(happyRoutes());
    const m = await mount(dir, { bridgeHttp: httpStub });
    try {
      // The precondition this case rests on: the READ really is truncated. Asserted directly,
      // because a fixture that quietly fit inside one page would make the route look correct.
      const read = await sessions.readMachineEvents(
        { id: MACHINE, local: true }, { now: NOW, paths: { events: path.join(dir, 'events') } },
      );
      assert.strictEqual(read.more, true, 'the local fixture must actually overflow one page');
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 502);
      assert.strictEqual(r.json.code, 'events_unavailable');
      assert.deepStrictEqual(httpStub.kinds(), []);
    } finally { await m.close(); }
  }

  // (d) REMOTE transport error, (e) remote more:true, (f) remote skipped:1, and (g) the bridge's
  // HTTP 200 success envelope that reports a failed read.
  const remoteCases = [
    ['transport error', async () => ({ ok: false, status: 503, json: null })],
    ['more:true', remoteEvents({ events: [], more: true, skipped: 0 })],
    ['skipped:1', remoteEvents({ events: [], more: false, skipped: 1 })],
    ['200 events_unreadable', remoteEvents({ events: [], more: false, error: 'events_unreadable' })],
  ];
  for (const [why, handler] of remoteCases) {
    const m = await setup({ config: remoteConfig(), routes: { events: handler } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 502, why);
      assert.strictEqual(r.json.code, 'events_unavailable', why);
      assert.deepStrictEqual(m.http.kinds(), ['events'], `${why}: the events read is the only call`);
    } finally { await m.close(); }
  }
});

// ==================================================================================================
// AC 6 — candidate-set identity. Seven cases, each one a distinct way a reply could land in another
// session's terminal. This is the single most load-bearing test in the file.
// ==================================================================================================

test('AC6: the candidate contest closes tab-only takeover, cross-field takeover, dual-field fallback and the per-field stale fallthrough', async () => {
  // (1) TABID-ONLY TAKEOVER — our fold names T only in tabId; a LATER event from another session
  // claims T. The tab is live in the tree, so without this contest the reply would be typed into it.
  {
    const m = await setup({
      events: [
        ev({ ts: BLOCKED, tabId: TAB }),
        ev({ ts: BLOCKED + 1000, sessionId: S2, event: 'UserPromptSubmit', notificationType: null, tabId: TAB }),
      ],
      routes: { tree: okTree(TAB) },
    });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.code, 'surface_reassigned');
      assert.strictEqual(r.json.message, 'Another session has taken over this tab.');
      assert.deepStrictEqual(m.http.kinds(), [], 'no tree, grid or send once a candidate is lost');
    } finally { await m.close(); }
  }

  // (2) TABID-ONLY OWNERSHIP — the latest T-bearing event is ours, so gate 2 proceeds. Exactly one
  // tree fetch: the contest is answered from the events already read, never by asking the bridge.
  {
    const m = await setup({
      events: [
        ev({ ts: BLOCKED - 1000, sessionId: S2, event: 'Stop', notificationType: null, tabId: TAB }),
        ev({ ts: BLOCKED, tabId: TAB }),
      ],
      routes: { tree: okTree(TAB) },
    });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 200, m.logs.map((l) => l.code).join(','));
      assert.strictEqual(m.http.count('tree'), 1);
    } finally { await m.close(); }
  }

  // (3) CROSS-FIELD TAKEOVER, both directions. joinRecorded resolves surfaceId and tabId through the
  // SAME byUuid namespace, so a value claimed in either field is the same pane claim.
  for (const [ourField, theirField] of [['surfaceId', 'tabId'], ['tabId', 'surfaceId']]) {
    const ours = ev({ ts: BLOCKED });
    ours[ourField] = TAB;
    const theirs = ev({ ts: BLOCKED + 1000, sessionId: S2, event: 'UserPromptSubmit', notificationType: null });
    theirs[theirField] = TAB;
    const m = await setup({ events: [ours, theirs], routes: { tree: okTree(TAB) } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409, `${ourField} vs ${theirField}`);
      assert.strictEqual(r.json.code, 'surface_reassigned', `${ourField} vs ${theirField}`);
      assert.deepStrictEqual(m.http.kinds(), []);
    } finally { await m.close(); }
  }

  // (4) DUAL-FIELD FALLBACK — our surfaceId is dead (absent from the tree) and our tabId is live but
  // now claimed by another session. Without a per-VALUE contest, gate 1 would pass on the dead
  // surfaceId and joinRecorded would fall through to the tab someone else owns.
  {
    const m = await setup({
      events: [
        ev({ ts: BLOCKED, surfaceId: 'fixture-tab-dead', tabId: TAB }),
        ev({ ts: BLOCKED + 1000, sessionId: S2, event: 'UserPromptSubmit', notificationType: null, tabId: TAB }),
      ],
      routes: { tree: okTree(TAB) },
    });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.code, 'surface_reassigned');
      assert.deepStrictEqual(m.http.kinds(), [], 'the un-contested second candidate never reaches joinRecorded');
    } finally { await m.close(); }
  }

  // (5) DUAL-FIELD LEGIT — same shape, but we hold the latest claim on BOTH values.
  {
    const m = await setup({
      events: [ev({ ts: BLOCKED, surfaceId: 'fixture-tab-dead', tabId: TAB })],
      routes: { tree: okTree(TAB) },
    });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 200, m.logs.map((l) => l.code).join(','));
      assert.strictEqual(m.http.last('send').body.includes(TAB), true, 'joined through the surviving candidate');
    } finally { await m.close(); }
  }

  // (6) NEITHER FIELD — the fold has no recorded identity at all. The contest has nothing to
  // contest, so it passes, and gate 2's recorded-only join is what refuses.
  {
    const m = await setup({ events: [ev({ ts: BLOCKED })], routes: { tree: okTree(TAB) } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.code, 'tab_gone');
      assert.strictEqual(r.json.message, "This session's tab is closed.");
      assert.deepStrictEqual(m.http.kinds(), ['tree'], 'gate 2 answered; gate 3 never ran');
    } finally { await m.close(); }
  }

  // (7) PER-FIELD STALE FALLTHROUGH (§5.1.2a). An older event carried {surfaceId:S1, tabId:T1}; the
  // LATEST carries only surfaceId:S2. The folded tabId is null, so T1 is neither a candidate here
  // nor reachable by gate 2 — even though T1 is LIVE in the tree and another session claims it.
  {
    const m = await setup({
      events: [
        ev({ ts: BLOCKED - 2000, event: 'Stop', notificationType: null, surfaceId: 'fixture-tab-S1', tabId: TAB }),
        ev({ ts: BLOCKED, surfaceId: 'fixture-tab-S2' }),
        ev({ ts: BLOCKED + 500, sessionId: S2, event: 'UserPromptSubmit', notificationType: null, tabId: TAB }),
      ],
      routes: { tree: okTree(TAB) },
    });
    try {
      // The precondition, asserted rather than assumed: the fold really did drop T1.
      const read = await sessions.readMachineEvents({ id: MACHINE, local: true }, { now: NOW, paths: { events: path.join(m.dir, 'events') } });
      const fold = sessions.foldSession(MACHINE, S1, sessions.groupEvents(read.events).get(S1));
      assert.strictEqual(fold.surfaceId, 'fixture-tab-S2');
      assert.strictEqual(fold.tabId, null, 'the per-field snapshot must have cleared the stale tabId');

      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.code, 'tab_gone');
      assert.deepStrictEqual(m.http.kinds(), ['tree'], 'no send, and no join to the live T1');
    } finally { await m.close(); }
  }

  // (7, mirror) the tab-only direction: latest event carries only tabId, and the live older surfaceId
  // is equally unreachable.
  {
    const m = await setup({
      events: [
        ev({ ts: BLOCKED - 2000, event: 'Stop', notificationType: null, surfaceId: TAB, tabId: 'fixture-tab-T1' }),
        ev({ ts: BLOCKED, tabId: 'fixture-tab-T2' }),
      ],
      routes: { tree: okTree(TAB) },
    });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.code, 'tab_gone', 'the live older surfaceId is not reachable');
      assert.deepStrictEqual(m.http.kinds(), ['tree']);
    } finally { await m.close(); }
  }
});

// ==================================================================================================
// AC 7 — the bridge auth header on all four calls, and the bridge's own 403.
// ==================================================================================================

test('AC7: x-bridge-secret rides events, tree, grid AND send; a bridge 403 forbidden at the send is send_failed with no lease', async () => {
  const prior = process.env.FIXTURE_BRIDGE_SECRET;
  process.env.FIXTURE_BRIDGE_SECRET = 'fixture-remote-secret';
  const remoteBase = { config: remoteConfig(), routes: { events: remoteEvents({ events: baseEvents(), more: false, skipped: 0 }) } };
  const m = await setup(remoteBase);
  try {
    const r = await post(m.base, goodBody());
    assert.strictEqual(r.status, 200, m.logs.map((l) => l.code).join(','));
    assert.deepStrictEqual(m.http.kinds(), ['events', 'tree', 'grid', 'send']);
    for (const call of m.http.calls) {
      assert.strictEqual(call.headers['x-bridge-secret'], 'fixture-remote-secret', `${call.kind} must carry the secret`);
    }
  } finally { await m.close(); }

  // `forbidden` is the BRIDGE's auth vocabulary, applied before every /cmux/* route — provably
  // before any child process is spawned, so it is genuinely "nothing was typed".
  const denied = await setup(Object.assign({}, remoteBase, {
    routes: Object.assign({}, remoteBase.routes, { send: async () => ({ ok: false, status: 403, json: { error: 'forbidden' } }) }),
  }));
  try {
    const r = await post(denied.base, goodBody());
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.code, 'send_failed');
    assert.strictEqual(r.json.message, 'Sending failed — nothing was typed into the tab.');
    // No lease: an immediate retry must be legal, which is what §6.1's Retry column promises.
    const again = await post(denied.base, goodBody());
    assert.strictEqual(again.json.code, 'send_failed', 'a send_failed retry proceeds all the way back to the send');
    assert.strictEqual(denied.http.count('send'), 2);
  } finally {
    await denied.close();
    if (prior === undefined) delete process.env.FIXTURE_BRIDGE_SECRET; else process.env.FIXTURE_BRIDGE_SECRET = prior;
  }
});

// ==================================================================================================
// AC 8 / 9 / 10 — gate 1's own ladder.
// ==================================================================================================

test('AC8: a session with no trace is 404 session_not_found; a session answered since is 409 already_answered with no later calls', async () => {
  const missing = await setup({ events: [ev({ ts: BLOCKED, sessionId: S2 })] });
  try {
    const r = await post(missing.base, goodBody());
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json.code, 'session_not_found');
    assert.strictEqual(r.json.message, 'No trace of this session in the retained events.');
    assert.deepStrictEqual(missing.http.kinds(), []);
  } finally { await missing.close(); }

  // The exact real-world shape: the hook appended UserPromptSubmit and NO sweep has rewritten
  // state.json yet — which is why gate 1 reads the event log and never the snapshot.
  const answered = await setup({
    events: baseEvents().concat([ev({ ts: BLOCKED + 5000, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB })]),
  });
  try {
    const r = await post(answered.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'already_answered');
    assert.strictEqual(r.json.message, 'This session is no longer waiting.');
    assert.deepStrictEqual(answered.http.kinds(), []);
  } finally { await answered.close(); }
});

test('AC9: a session blocked on a permission_request is 409 not_text_answerable and never fetches a tree', async () => {
  const m = await setup({
    events: [ev({ ts: BLOCKED - 1000, event: 'Stop', notificationType: null, surfaceId: TAB }), ev({ ts: BLOCKED, event: 'PermissionRequest', notificationType: null, surfaceId: TAB })],
  });
  try {
    const r = await post(m.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'not_text_answerable');
    assert.strictEqual(r.json.message, 'This session is waiting at a permission prompt — open the tab to answer it.');
    assert.deepStrictEqual(m.http.kinds(), []);
  } finally { await m.close(); }
});

test('AC10: the turn token converts numeric-ms to ISO before comparing, and a changed question is refused', async () => {
  const m = await setup({ routes: { tree: okTree(TAB) } });
  try {
    // THE RUNTIME-TYPE ASSERTION (trap 23). The fold speaks numeric ms; the row speaks ISO. If the
    // route compared the raw values, every valid reply would be rejected — so the test proves the
    // fixture really is numeric before proving the route accepts the ISO form built from it.
    const read = await sessions.readMachineEvents({ id: MACHINE, local: true }, { now: NOW, paths: { events: path.join(m.dir, 'events') } });
    const fold = sessions.foldSession(MACHINE, S1, sessions.groupEvents(read.events).get(S1));
    assert.strictEqual(typeof fold.blockedSince, 'number', 'foldSession must carry numeric ms');
    assert.strictEqual(Number.isInteger(fold.blockedSince), true);
    const rowTurn = { blockedSince: new Date(fold.blockedSince).toISOString(), assistantTs: null };
    assert.notStrictEqual(rowTurn.blockedSince, fold.blockedSince, 'the two representations are genuinely different values');

    const ok = await post(m.base, goodBody({ turn: rowTurn }));
    assert.strictEqual(ok.status, 200, m.logs.map((l) => l.code).join(','));
  } finally { await m.close(); }

  // blocked(A) -> answered -> blocked(B), replying with A's token.
  const moved = await setup({
    events: baseEvents().concat([
      ev({ ts: BLOCKED + 5000, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB }),
      ev({ ts: BLOCKED + 6000, surfaceId: TAB }),
    ]),
    radar: { now: () => NOW + 7000 },
  });
  try {
    const r = await post(moved.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'question_changed');
    assert.strictEqual(r.json.message, 'The question changed — waiting for the update…');
    assert.deepStrictEqual(moved.http.kinds(), [], 'no send for a question that moved');
  } finally { await moved.close(); }
});

// The assistantTs half of the token, driven through the real transcript reader.
test('AC10b: assistantTs is compared against the real transcript tail, and a stale one is question_changed', async () => {
  const dir = await tempDir();
  await writeConfig(dir);
  const transcript = path.join(dir, 'fixture-transcript.jsonl');
  const TS = '2026-01-02T02:58:57.000Z';
  await fsp.writeFile(transcript, JSON.stringify({
    type: 'assistant', timestamp: TS, message: { content: [{ type: 'text', text: 'Per request or per batch?' }] },
  }) + '\n');
  await writeEvents(dir, [
    ev({ ts: BLOCKED - 1000, event: 'Stop', notificationType: null, surfaceId: TAB, transcriptPath: transcript }),
    ev({ ts: BLOCKED, surfaceId: TAB, transcriptPath: transcript }),
  ]);
  const httpStub = stubHttp(happyRoutes());
  const m = await mount(dir, { bridgeHttp: httpStub });
  try {
    const stale = await post(m.base, goodBody({ turn: { blockedSince: ISO(BLOCKED), assistantTs: null } }));
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.code, 'question_changed');
    assert.deepStrictEqual(httpStub.kinds(), []);

    const fresh = await post(m.base, goodBody({ turn: { blockedSince: ISO(BLOCKED), assistantTs: TS } }));
    assert.strictEqual(fresh.status, 200, m.logs.map((l) => l.code).join(','));
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 11 — the plain surfaceId takeover.
// ==================================================================================================

test('AC11: a later event from a DIFFERENT session carrying our recorded surfaceId is 409 surface_reassigned with no send', async () => {
  const m = await setup({
    events: baseEvents().concat([
      ev({ ts: BLOCKED + 2000, sessionId: S2, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB }),
    ]),
    routes: { tree: okTree(TAB) },
  });
  try {
    const r = await post(m.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'surface_reassigned');
    assert.strictEqual(m.http.count('send'), 0);
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 12 — gate 2, and the distinction bridge failure / tab absence.
// ==================================================================================================

test('AC12: a tree that responds without our identity is 409 tab_gone; a tree that fails is 502 bridge_unreachable', async () => {
  const gone = await setup({ routes: { tree: okTree(TAB2) } });
  try {
    const r = await post(gone.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'tab_gone');
    assert.strictEqual(gone.http.count('grid'), 0);
  } finally { await gone.close(); }

  // Four ways a tree fetch fails, and every one of them is the machine, not the tab.
  const failures = [
    ['thrown', async () => { throw new Error('ECONNREFUSED'); }],
    ['non-2xx', async () => ({ ok: false, status: 500, json: { error: 'boom' } })],
    ['non-JSON', async () => ({ ok: true, status: 200, json: null })],
    ['no workspaces array', async () => ({ ok: true, status: 200, json: { workspaces: 'nope' } })],
  ];
  for (const [why, handler] of failures) {
    const m = await setup({ routes: { tree: handler } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 502, why);
      assert.strictEqual(r.json.code, 'bridge_unreachable', why);
      assert.strictEqual(r.json.message, "The machine isn't reachable right now.");
      assert.strictEqual(m.http.count('grid'), 0, why);
    } finally { await m.close(); }
  }
});

// Source assertions match CALL and ACCESS syntax, never bare words: a comment that names a function
// is documentation, and a test that failed on prose would be pressure to delete the prose.
test('AC12b: SOURCE ASSERTION — gate 2 calls the exported joinRecorded, and no cwd fallback is reachable from the route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'radar-server.js'), 'utf8');
  assert.match(src, /sessions\.joinRecorded\(/, 'the route must call the EXPORTED joinRecorded');
  // joinSurface owns the cwd heuristic; surfaceCandidate and mapCwd are its only other doors, and
  // the cwd map itself is reached through the index's byCwd. No call or access to any of them.
  for (const re of [/\bjoinSurface\s*\(/, /\bsurfaceCandidate\s*\(/, /\bmapCwd\s*\(/, /\.byCwd\b/]) {
    assert.strictEqual(re.test(src), false, `${re} must not be reachable from the reply route`);
  }
  // And the index the route builds is deliberately rootless, which is what leaves the cwd map empty:
  // there is nothing for a heuristic to fall through to, rather than a rule saying it must not.
  assert.match(src, /buildSurfaceIndex\(treeRes\.json,\s*null\)/);
});

test('DoD: SOURCE ASSERTION — paneKind comes from public/menuparse.js and no second prompt-detection lives here', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'radar-server.js'), 'utf8');
  assert.match(src, /require\('\.\/public\/menuparse\.js'\)/);
  assert.match(src, /paneKind\(\{ grid: gj\.grid, status: '' \}\)/, 'gate 3 must pass the empty status, always');
  // A second implementation would look like these: the status regex, the box signature, or a
  // hand-rolled row scan. None of them may exist outside menuparse.js.
  for (const re of [/AGENT_STATUS_RE/, /lastBoxedPrompt/, /lastShellPrompt/, /\bbuildRows\s*\(/, /row_spans/]) {
    assert.strictEqual(re.test(src), false, `${re} indicates a second prompt-detection implementation`);
  }
  // Trap 19: the sequence number is the ENVELOPE's. The phantom on the grid object is never read.
  assert.match(src, /const seq = gj\.seq;/);
  assert.strictEqual(/\.state_seq\b/.test(src), false, 'the phantom grid sequence field must never be read');
  assert.strictEqual(/paneKind\([^)]*\)\.seq/.test(src), false, 'paneKind(...).seq reads the phantom');
});

// ==================================================================================================
// AC 13 / 16 — gate 3, grid evidence only.
// ==================================================================================================

test('AC13: with the real workspace-scoped status claiming Claude, a shell/altscreen/unknown grid is still 409 not_at_prompt; only the grid can pass it', async () => {
  const STATUS = 'claude_code=Running';
  for (const [why, grid] of [['shell', SHELL_GRID], ['altscreen', ALTSCREEN_GRID], ['unknown', UNKNOWN_GRID]]) {
    const m = await setup({
      routes: {
        // The producer's real shape: the status is stamped onto every terminal tab in the workspace.
        tree: async () => ({ ok: true, status: 200, json: workspaceStatusTree(TAB, STATUS) }),
        grid: okGrid(grid),
      },
    });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409, why);
      assert.strictEqual(r.json.code, 'not_at_prompt', why);
      assert.strictEqual(r.json.message, "The tab isn't at a Claude prompt right now.");
      assert.strictEqual(m.http.count('send'), 0, `${why}: nothing may be typed`);
    } finally { await m.close(); }
  }

  // The positive case, under the SAME poisoned status: the selected tab's own grid proves `agent`.
  const good = await setup({
    routes: { tree: async () => ({ ok: true, status: 200, json: workspaceStatusTree(TAB, STATUS) }), grid: okGrid(AGENT_GRID) },
  });
  try {
    const r = await post(good.base, goodBody());
    assert.strictEqual(r.status, 200, good.logs.map((l) => l.code).join(','));
    assert.strictEqual(good.http.count('send'), 1);
  } finally { await good.close(); }
});

test('AC16: plain shell, altscreen and unknown grids are each 409 not_at_prompt with no send', async () => {
  for (const [why, grid] of [['shell', SHELL_GRID], ['altscreen', ALTSCREEN_GRID], ['unknown', UNKNOWN_GRID]]) {
    const m = await setup({ routes: { grid: okGrid(grid) } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, 409, why);
      assert.strictEqual(r.json.code, 'not_at_prompt', why);
      assert.strictEqual(m.http.count('send'), 0, why);
    } finally { await m.close(); }
  }
});

// ==================================================================================================
// AC 14 — the heuristic row, end to end.
// ==================================================================================================

test('AC14: a session whose only possible join is cwd-based is refused 409 tab_gone — the same row S-005 marks answerable:false', async () => {
  // No recorded identity at all, but a workspace whose folder matches this session's cwd and which
  // holds exactly one terminal tab: the cwd heuristic would have joined it. Gate 2 must not.
  const tree = treeWith(TAB);
  const m = await setup({
    events: [ev({ ts: BLOCKED - 1000, event: 'Stop', notificationType: null }), ev({ ts: BLOCKED })],
    routes: {
      tree: async () => ({ ok: true, status: 200, json: tree }),
      // A roots payload would be the cwd map's only source, and the route never asks for one.
      other: async () => { throw new Error('the reply route must not fetch fs/roots'); },
    },
  });
  try {
    const r = await post(m.base, goodBody());
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'tab_gone');
    assert.deepStrictEqual(m.http.kinds(), ['tree'], 'no roots fetch, no grid, no send');
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 15 — the admitted abort, at each of the three in-flight points.
// ==================================================================================================

// Parks the FIRST call of its kind until the request-scoped signal fires, then behaves normally —
// so a follow-up request in the same test exercises the real pipeline instead of re-parking.
function parkOnce(started, fallback) {
  const park = parkUntilAborted(started);
  let used = false;
  return (call) => {
    if (used) return fallback(call);
    used = true;
    return park(call);
  };
}

async function abortDuring(kind) {
  const started = deferred();
  const routes = happyRoutes();
  const normal = kind === 'events'
    ? remoteEvents({ events: baseEvents(), more: false, skipped: 0 })
    : routes[kind];
  routes[kind] = parkOnce(started, normal);
  const cfg = kind === 'events' ? remoteConfig() : undefined;
  const m = await setup({ config: cfg, routes });

  // The route logs `client_closed` with no response to observe, so the log line IS the completion
  // signal. Watching the array the harness already fills is the only handle a client has.
  const logged = deferred();
  const watch = setInterval(() => { if (m.logs.length) { clearInterval(watch); logged.resolve(m.logs[0]); } }, 5);

  const u = new URL(`${m.base}/api/radar/inbox/reply`);
  const payload = JSON.stringify(goodBody());
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
  });
  req.on('error', () => {});
  req.end(payload);

  const call = await started.promise;
  const writesBefore = m.writes.length;
  req.destroy();
  const line = await logged.promise;
  clearInterval(watch);
  await settle();
  return { m, call, line, writesBefore };
}

test('AC15: a client disconnect during the events read, the tree fetch or the grid fetch aborts the call in flight, sends nothing, takes no lease, writes nothing and logs exactly one client_closed', async () => {
  for (const kind of ['events', 'tree', 'grid']) {
    const { m, call, line, writesBefore } = await abortDuring(kind);
    try {
      // The signal plumbing itself, not merely "later gates were skipped": the injected transport
      // held the route's own signal and saw it fire.
      assert.strictEqual(call.signal.aborted, true, `${kind}: the in-flight call must observe the abort`);
      assert.strictEqual(m.logs.length, 1, `${kind}: exactly one log line`);
      assert.strictEqual(line.code, 'client_closed');
      assert.strictEqual(line.outcome, 'refused');
      assert.strictEqual(line.machine, MACHINE);
      assert.strictEqual(line.sessionId, S1);
      assert.strictEqual(m.http.count('send'), 0, `${kind}: nothing is ever sent`);
      // Every call after the aborted one is skipped too.
      const after = { events: ['events'], tree: ['tree'], grid: ['tree', 'grid'] }[kind];
      assert.deepStrictEqual(m.http.kinds(), after, `${kind}: no call after the abort`);
      assert.strictEqual(m.writes.length, writesBefore, `${kind}: no response bytes after the abort`);
    } finally { await m.close(); }
  }
});

test('AC15b: no lease survives an admitted abort — the next request runs the whole pipeline', async () => {
  const { m } = await abortDuring('tree');
  try {
    const r = await post(m.base, goodBody());
    assert.strictEqual(r.status, 200, m.logs.map((l) => l.code).join(','));
    assert.strictEqual(m.http.count('send'), 1);
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 17 — malformed bridge bodies.
// ==================================================================================================

test('AC17: an empty, non-JSON, truncated or wrong-shape body from tree/grid is bridge_unreachable and from send is send_unconfirmed — never a 409, never success', async () => {
  const malformed = [
    ['empty', { ok: true, status: 200, json: null }],
    ['non-JSON', { ok: true, status: 200, json: null }],
    ['truncated', { ok: true, status: 200, json: null }],
    ['wrong shape', { ok: true, status: 200, json: { unexpected: true } }],
  ];
  for (const [why, answer] of malformed) {
    const t = await setup({ routes: { tree: async () => answer } });
    try {
      const r = await post(t.base, goodBody());
      assert.strictEqual(r.json.code, 'bridge_unreachable', `tree ${why}`);
      assert.strictEqual(r.status, 502);
    } finally { await t.close(); }

    const g = await setup({ routes: { grid: async () => answer } });
    try {
      const r = await post(g.base, goodBody());
      assert.strictEqual(r.json.code, 'bridge_unreachable', `grid ${why}`);
      assert.strictEqual(g.http.count('send'), 0, `grid ${why}: nothing typed`);
    } finally { await g.close(); }

    const s = await setup({ routes: { send: async () => answer } });
    try {
      const r = await post(s.base, goodBody());
      assert.strictEqual(r.status, 502, `send ${why}`);
      assert.strictEqual(r.json.code, 'send_unconfirmed', `send ${why}`);
      // And the lease is held, because a malformed answer proves nothing about the pane.
      const again = await post(s.base, goodBody());
      assert.strictEqual(again.json.code, 'already_answered', `send ${why}: the lease held`);
      assert.strictEqual(s.http.count('send'), 1);
    } finally { await s.close(); }
  }

  // A grid whose seq is missing or not a number is the same failure: an expect_seq of undefined
  // would silently disable the bridge's whole precondition.
  for (const bad of [{ grid: AGENT_GRID }, { seq: 'seven', grid: AGENT_GRID }, { seq: 3 }, { seq: 3, grid: null }, { seq: 3, grid: [] }]) {
    const m = await setup({ routes: { grid: async () => ({ ok: true, status: 200, json: bad }) } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.json.code, 'bridge_unreachable', JSON.stringify(bad));
      assert.strictEqual(m.http.count('send'), 0);
    } finally { await m.close(); }
  }
});

// ==================================================================================================
// AC 18 — timeouts, under the route's own fake clock.
// ==================================================================================================

test('AC18: a tree or grid past bridgeMs is 502 bridge_unreachable; a send past 20000 ms is 502 send_unconfirmed with the lease held', async () => {
  for (const kind of ['tree', 'grid']) {
    const started = deferred();
    const clock = fakeTimers();
    const routes = happyRoutes();
    routes[kind] = parkUntilAborted(started);
    const m = await setup({ routes, radar: { timers: clock.api } });
    try {
      const pending = post(m.base, goodBody());
      await started.promise;
      assert.deepStrictEqual(clock.armed(), [5000], `${kind}: the route armed exactly the configured bridgeMs`);
      clock.fireAll();
      const r = await pending;
      assert.strictEqual(r.status, 502, kind);
      assert.strictEqual(r.json.code, 'bridge_unreachable', kind);
      assert.strictEqual(m.http.count('send'), 0, kind);
    } finally { await m.close(); }
  }

  const started = deferred();
  const clock = fakeTimers();
  const m = await setup({ routes: happyRoutes({ send: parkUntilAborted(started) }), radar: { timers: clock.api } });
  try {
    const pending = post(m.base, goodBody());
    await started.promise;
    assert.deepStrictEqual(clock.armed(), [20000], 'the send deadline is SEND_TIMEOUT_MS, not bridgeMs');
    clock.fireAll();
    const r = await pending;
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json.code, 'send_unconfirmed');
    assert.strictEqual(r.json.message, "The send wasn't confirmed — check the tab before retrying.");
    // A timeout after dispatch proves nothing about the pane, so the lease is held.
    const again = await post(m.base, goodBody());
    assert.strictEqual(again.json.code, 'already_answered');
    assert.strictEqual(m.http.count('send'), 1);
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 19 / 20 / 21 / 22 — the lease.
// ==================================================================================================

test('AC19: the lease is BY OUTCOME — send_failed retries freely, the three write outcomes do not, and two simultaneous POSTs produce exactly one send', async () => {
  // send_failed: no lease, so the retry runs the whole pipeline again.
  const failed = await setup({ routes: { send: async () => ({ ok: false, status: 502, json: { error: 'send_failed' } }) } });
  try {
    assert.strictEqual((await post(failed.base, goodBody())).json.code, 'send_failed');
    assert.strictEqual((await post(failed.base, goodBody())).json.code, 'send_failed');
    assert.strictEqual(failed.http.count('send'), 2, 'no lease means an immediate retry is legal');
  } finally { await failed.close(); }

  // pane_changed likewise: the bridge proved the seq moved before anything was typed.
  const paneChanged = await setup({ routes: { send: async () => ({ ok: false, status: 409, json: { error: 'seq_changed', seq: 99 } }) } });
  try {
    assert.strictEqual((await post(paneChanged.base, goodBody())).json.code, 'pane_changed');
    assert.strictEqual((await post(paneChanged.base, goodBody())).json.code, 'pane_changed');
    assert.strictEqual(paneChanged.http.count('send'), 2);
  } finally { await paneChanged.close(); }

  const leased = [
    ['ok', async () => ({ ok: true, status: 200, json: { ok: true } }), 200],
    ['send_unconfirmed', async () => ({ ok: false, status: 502, json: { error: 'text_command_unconfirmed' } }), 502],
    ['text_inserted_submit_failed', async () => ({ ok: false, status: 502, json: { error: 'submit_failed_text_inserted' } }), 502],
  ];
  for (const [why, handler] of leased) {
    const m = await setup({ routes: { send: handler } });
    try {
      await post(m.base, goodBody());
      const retry = await post(m.base, goodBody());
      assert.strictEqual(retry.status, 409, why);
      assert.strictEqual(retry.json.code, 'already_answered', why);
      assert.strictEqual(m.http.count('send'), 1, why);
      assert.strictEqual(m.http.count('tree'), 1, `${why}: a leased retry makes no tree call`);
      assert.strictEqual(m.http.count('grid'), 1, `${why}: a leased retry makes no grid call`);
    } finally { await m.close(); }
  }

  // Two simultaneous POSTs. The mutex serializes them and the lease answers the second.
  const race = await setup();
  try {
    const [a, b] = await Promise.all([post(race.base, goodBody()), post(race.base, goodBody())]);
    const codes = [a, b].map((r) => (r.json.ok ? 'ok' : r.json.code)).sort();
    assert.deepStrictEqual(codes, ['already_answered', 'ok']);
    assert.strictEqual(race.http.count('send'), 1, 'exactly one bridge send for two simultaneous replies');
  } finally { await race.close(); }
});

test('AC20: the ok lease expires at EXACTLY now - at >= 120000 — held at 119999, gone at 120000 and 120001', async () => {
  for (const [elapsed, expect] of [[119999, 'already_answered'], [120000, 'ok'], [120001, 'ok']]) {
    let clock = NOW;
    const m = await setup({ radar: { now: () => clock } });
    try {
      const first = await post(m.base, goodBody());
      assert.strictEqual(first.status, 200, m.logs.map((l) => l.code).join(','));
      const sendsAfterFirst = m.http.count('send');
      const treesAfterFirst = m.http.count('tree');

      clock = NOW + elapsed;
      const retry = await post(m.base, goodBody());
      if (expect === 'already_answered') {
        assert.strictEqual(retry.status, 409, `${elapsed}`);
        assert.strictEqual(retry.json.code, 'already_answered', `${elapsed}`);
        assert.strictEqual(m.http.count('tree'), treesAfterFirst, `${elapsed}: a held lease makes no tree call`);
        assert.strictEqual(m.http.count('grid'), 1, `${elapsed}: a held lease makes no grid call`);
        assert.strictEqual(m.http.count('send'), sendsAfterFirst, `${elapsed}: a held lease makes no send`);
      } else {
        assert.strictEqual(retry.status, 200, `${elapsed}: the lease is already gone at the comparator`);
        assert.strictEqual(m.http.count('send'), sendsAfterFirst + 1, `${elapsed}: it proceeded through gate 1 to a send`);
      }
    } finally { await m.close(); }
  }
});

test('AC21: the send_unconfirmed and text_inserted_submit_failed leases NEVER time-expire — only a new turn releases them', async () => {
  const uncertain = [
    ['send_unconfirmed', { ok: false, status: 502, json: { error: 'text_command_unconfirmed' } }],
    ['text_inserted_submit_failed', { ok: false, status: 502, json: { error: 'submit_failed_text_inserted' } }],
  ];
  for (const [why, answer] of uncertain) {
    let clock = NOW;
    const m = await setup({ routes: { send: async () => answer }, radar: { now: () => clock } });
    try {
      const first = await post(m.base, goodBody());
      assert.strictEqual(first.json.code, why);
      const sends = m.http.count('send');
      // 119999 is inside the ok-lease window; 120000 and 120001 are outside it; 24 h is far outside.
      // None of them may release a lease §6.1 marks not retryable.
      for (const elapsed of [119999, 120000, 120001, 24 * 3600 * 1000]) {
        clock = NOW + elapsed;
        const retry = await post(m.base, goodBody());
        assert.strictEqual(retry.status, 409, `${why} at ${elapsed}`);
        assert.strictEqual(retry.json.code, 'already_answered', `${why} at ${elapsed}`);
        assert.strictEqual(m.http.count('tree'), 1, `${why} at ${elapsed}: no tree call`);
        assert.strictEqual(m.http.count('grid'), 1, `${why} at ${elapsed}: no grid call`);
        assert.strictEqual(m.http.count('send'), sends, `${why} at ${elapsed}: no send`);
      }

      // THE ONLY RELEASE: a complete fold reporting a NEW turn. The clock stays PAST the ok-lease
      // boundary (120001 ms, not 24 h — a session four hours stale is `abandoned`, which would
      // refuse for an unrelated reason and prove nothing), so the fold is what releases this and
      // nothing else could be.
      clock = NOW + 120001;
      const NEW_BLOCK = BLOCKED + 10000;
      await writeEvents(m.dir, baseEvents().concat([
        ev({ ts: BLOCKED + 9000, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB }),
        ev({ ts: NEW_BLOCK, surfaceId: TAB }),
      ]));
      const fresh = await post(m.base, goodBody({ turn: { blockedSince: ISO(NEW_BLOCK), assistantTs: null } }));
      assert.strictEqual(fresh.json.code, why, `${why}: the new turn released the lease and the pipeline ran again`);
      assert.strictEqual(m.http.count('send'), sends + 1);
    } finally { await m.close(); }
  }
});

test('AC22: a leased session on a configured REMOTE bridge re-reads events over /cmux/session-events, and an unavailable read retains the lease', async () => {
  const prior = process.env.FIXTURE_BRIDGE_SECRET;
  process.env.FIXTURE_BRIDGE_SECRET = 'fixture-remote-secret';
  let events = baseEvents();
  let eventsAnswer = null;
  const m = await setup({
    config: remoteConfig(),
    routes: {
      events: async () => (eventsAnswer || { ok: true, status: 200, json: { events, more: false, skipped: 0 } }),
    },
  });
  try {
    assert.strictEqual((await post(m.base, goodBody())).status, 200, m.logs.map((l) => l.code).join(','));
    const base = { events: m.http.count('events'), tree: m.http.count('tree'), grid: m.http.count('grid'), send: m.http.count('send') };

    // Same turn: one more events read over HTTP, and nothing else.
    const held = await post(m.base, goodBody());
    assert.strictEqual(held.status, 409);
    assert.strictEqual(held.json.code, 'already_answered');
    assert.strictEqual(m.http.count('events'), base.events + 1, 'the lease re-check is a real remote read');
    assert.strictEqual(m.http.count('tree'), base.tree);
    assert.strictEqual(m.http.count('grid'), base.grid);
    assert.strictEqual(m.http.count('send'), base.send);

    // An unavailable remote read: 502, LEASE RETAINED — proved by the next same-turn request still
    // answering already_answered rather than proceeding.
    eventsAnswer = { ok: true, status: 200, json: { events: [], more: true, skipped: 0 } };
    const unavailable = await post(m.base, goodBody());
    assert.strictEqual(unavailable.status, 502);
    assert.strictEqual(unavailable.json.code, 'events_unavailable');
    assert.strictEqual(m.http.count('send'), base.send, 'nothing after the failed read');
    eventsAnswer = null;
    assert.strictEqual((await post(m.base, goodBody())).json.code, 'already_answered', 'the lease was retained through the outage');

    // A NEW turn releases it, and the read that proved the new turn is REUSED as gate 1 — exactly
    // one events fetch for the whole request.
    const NEW_BLOCK = BLOCKED + 10000;
    events = baseEvents().concat([
      ev({ ts: BLOCKED + 9000, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB }),
      ev({ ts: NEW_BLOCK, surfaceId: TAB }),
    ]);
    const beforeFresh = m.http.count('events');
    const fresh = await post(m.base, goodBody({ turn: { blockedSince: ISO(NEW_BLOCK), assistantTs: null } }));
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(m.http.count('events'), beforeFresh + 1, 'exactly ONE events fetch: the lease read is reused as gate 1');
  } finally {
    await m.close();
    if (prior === undefined) delete process.env.FIXTURE_BRIDGE_SECRET; else process.env.FIXTURE_BRIDGE_SECRET = prior;
  }
});

test('AC19b: on a LOCAL machine too, a new-turn release reuses its read as gate 1 — exactly one readMachineEvents call', async () => {
  let clock = NOW;
  const m = await setup({ radar: { now: () => clock } });
  try {
    assert.strictEqual((await post(m.base, goodBody())).status, 200, m.logs.map((l) => l.code).join(','));
    const NEW_BLOCK = BLOCKED + 10000;
    await writeEvents(m.dir, baseEvents().concat([
      ev({ ts: BLOCKED + 9000, event: 'UserPromptSubmit', notificationType: null, surfaceId: TAB }),
      ev({ ts: NEW_BLOCK, surfaceId: TAB }),
    ]));
    clock = NOW + 1000;   // still well inside the ok lease, so the release is the FOLD, not the clock

    const spy = mock.method(sessions, 'readMachineEvents');
    try {
      const fresh = await post(m.base, goodBody({ turn: { blockedSince: ISO(NEW_BLOCK), assistantTs: null } }));
      assert.strictEqual(fresh.status, 200);
      assert.strictEqual(spy.mock.callCount(), 1, 'the lease re-check read IS gate 1 — never two fetches');
    } finally { spy.mock.restore(); }
    assert.strictEqual(m.http.count('send'), 2);
  } finally { await m.close(); }
});

// ==================================================================================================
// AC 23 / 24 / 25 — the send itself.
// ==================================================================================================

test('AC23: the call order is exactly fold -> tree -> grid -> send, and the send carries the recorded tab, submit:true, the secret and the ENVELOPE seq', async () => {
  const prior = process.env.FIXTURE_BRIDGE_SECRET;
  process.env.FIXTURE_BRIDGE_SECRET = 'fixture-remote-secret';
  const SEQ = 4242;
  const TEXT = '\n  leading whitespace, a tab\there, and a trailing newline\n';
  const m = await setup({
    config: remoteConfig(),
    routes: {
      events: remoteEvents({ events: baseEvents(), more: false, skipped: 0 }),
      // The phantom is present in the grid AND different from the envelope seq: if the route ever
      // read paneKind(...).seq, expect_seq would carry this value instead.
      grid: async () => ({ ok: true, status: 200, json: { seq: SEQ, grid: Object.assign({ state_seq: 999999 }, AGENT_GRID) } }),
    },
  });
  try {
    const r = await post(m.base, goodBody({ text: TEXT }));
    assert.strictEqual(r.status, 200, m.logs.map((l) => l.code).join(','));
    assert.deepStrictEqual(m.http.kinds(), ['events', 'tree', 'grid', 'send']);
    const send = m.http.last('send');
    assert.strictEqual(send.method, 'POST');
    assert.strictEqual(send.headers['x-bridge-secret'], 'fixture-remote-secret');
    const body = JSON.parse(send.body);
    assert.deepStrictEqual(body, { surface: TAB, text: TEXT, submit: true, expect_seq: SEQ });
    // Byte-exact: the reply the operator typed, not a normalised version of it.
    assert.strictEqual(body.text, TEXT);
    assert.strictEqual(m.http.last('grid').url.includes(encodeURIComponent(TAB)), true);
  } finally {
    await m.close();
    if (prior === undefined) delete process.env.FIXTURE_BRIDGE_SECRET; else process.env.FIXTURE_BRIDGE_SECRET = prior;
  }
});

test('AC24: the send mapping is exhaustive and by provable phase, each with its exact §6.1 message', async () => {
  const cases = [
    ['seq_changed', { ok: false, status: 409, json: { error: 'seq_changed', seq: 5 } }, 409, 'pane_changed', 'The tab changed while sending — nothing was sent.', false],
    ['seq_unavailable', { ok: false, status: 409, json: { error: 'seq_unavailable' } }, 502, 'send_failed', 'Sending failed — nothing was typed into the tab.', false],
    ['bridge send_failed', { ok: false, status: 502, json: { error: 'send_failed' } }, 502, 'send_failed', 'Sending failed — nothing was typed into the tab.', false],
    ['text_command_unconfirmed', { ok: false, status: 502, json: { error: 'text_command_unconfirmed' } }, 502, 'send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
    ['submit_failed_text_inserted', { ok: false, status: 502, json: { error: 'submit_failed_text_inserted' } }, 502, 'text_inserted_submit_failed', 'Text was placed in the tab but not submitted — finish it there.', true],
    ['bad_surface', { ok: false, status: 400, json: { error: 'bad_surface' } }, 502, 'send_failed', 'Sending failed — nothing was typed into the tab.', false],
    ['bad_json', { ok: false, status: 400, json: { error: 'bad_json' } }, 502, 'send_failed', 'Sending failed — nothing was typed into the tab.', false],
    ['forbidden', { ok: false, status: 403, json: { error: 'forbidden' } }, 502, 'send_failed', 'Sending failed — nothing was typed into the tab.', false],
    ['unknown 409', { ok: false, status: 409, json: { error: 'something_new' } }, 502, 'send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
    ['unlisted 5xx', { ok: false, status: 503, json: { error: 'overloaded' } }, 502, 'send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
    ['malformed 2xx', { ok: true, status: 200, json: { unexpected: 'shape' } }, 502, 'send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
    ['non-JSON 2xx', { ok: true, status: 200, json: null }, 502, 'send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
    ['connection lost after dispatch', 'throw', 502, 'send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
  ];
  for (const [why, answer, status, code, message, leased] of cases) {
    const handler = answer === 'throw'
      ? async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
      : async () => answer;
    const m = await setup({ routes: { send: handler } });
    try {
      const r = await post(m.base, goodBody());
      assert.strictEqual(r.status, status, why);
      assert.strictEqual(r.json.code, code, why);
      assert.strictEqual(r.json.message, message, why);
      // The lease column of §6.1, asserted behaviourally: a retry either reaches the bridge again or
      // is stopped by the lease.
      const retry = await post(m.base, goodBody());
      if (leased) {
        assert.strictEqual(retry.json.code, 'already_answered', `${why}: must take the lease`);
        assert.strictEqual(m.http.count('send'), 1, why);
      } else {
        assert.strictEqual(retry.json.code, code, `${why}: must NOT take a lease`);
        assert.strictEqual(m.http.count('send'), 2, why);
      }
    } finally { await m.close(); }
  }
});

test('AC25: each POST fetches a fresh tree, and a fully successful reply leaves state.json byte-identical', async () => {
  let uuids = [TAB];
  const m = await setup({
    routes: {
      tree: async () => ({ ok: true, status: 200, json: treeWith(uuids) }),
      send: async () => ({ ok: false, status: 409, json: { error: 'seq_changed' } }),   // no lease, so the second POST really runs
    },
  });
  try {
    assert.strictEqual((await post(m.base, goodBody())).json.code, 'pane_changed');
    uuids = [TAB2];                                    // the tab closed between the two replies
    const second = await post(m.base, goodBody());
    assert.strictEqual(second.json.code, 'tab_gone', 'no snapshot reuse: the second POST saw the mutated tree');
    assert.strictEqual(m.http.count('tree'), 2);
  } finally { await m.close(); }

  // The route writes NOTHING to state.json — not a status, not a receipt, not a timestamp.
  const dir = await tempDir();
  await writeConfig(dir);
  await writeEvents(dir, baseEvents());
  const statePath = path.join(dir, 'state.json');
  await fsp.writeFile(statePath, JSON.stringify({ generatedAt: '2026-01-02T03:04:05.000Z', sessions: [], inbox: [] }, null, 2));
  const before = await fsp.readFile(statePath);
  const httpStub = stubHttp(happyRoutes());
  const w = await mount(dir, { bridgeHttp: httpStub });
  try {
    assert.strictEqual((await post(w.base, goodBody())).status, 200, w.logs.map((l) => l.code).join(','));
    const after = await fsp.readFile(statePath);
    assert.strictEqual(Buffer.compare(before, after), 0, 'state.json must be byte-identical');
  } finally { await w.close(); }
});

// ==================================================================================================
// AC 26 / 27 — the envelope and the log.
// ==================================================================================================

test('AC26: every failure body is exactly one §6.1 code and message; the success body is exactly {ok:true} with neither', async () => {
  const ok = await setup();
  try {
    const r = await post(ok.base, goodBody());
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true });
    assert.deepStrictEqual(Object.keys(r.json), ['ok'], 'the 200 row is the only outcome with no code and no message');
  } finally { await ok.close(); }

  // One representative of every failure family the route can reach, each checked for the exact
  // two-key envelope. The strings themselves are asserted at each gate above.
  const failures = [
    [async (m) => post(m.base, '{'), {}, 'bad_json'],
    [async (m) => post(m.base, goodBody({ machine: '' })), {}, 'bad_request'],
    [async (m) => post(m.base, goodBody({ machine: 'fixture-nope' })), {}, 'unknown_machine'],
    [async (m) => post(m.base, goodBody({ text: ' ' })), {}, 'empty_reply'],
    [async (m) => post(m.base, goodBody({ text: 'a'.repeat(8193) })), {}, 'reply_too_large'],
    [async (m) => post(m.base, goodBody({ sessionId: 'fixture-inbox-9' })), {}, 'session_not_found'],
    [async (m) => post(m.base, goodBody()), { routes: { tree: okTree(TAB2) } }, 'tab_gone'],
    [async (m) => post(m.base, goodBody()), { routes: { grid: okGrid(SHELL_GRID) } }, 'not_at_prompt'],
    [async (m) => post(m.base, goodBody()), { routes: { tree: async () => ({ ok: false, status: 500, json: null }) } }, 'bridge_unreachable'],
  ];
  for (const [run, opts, code] of failures) {
    const m = await setup(opts);
    try {
      const r = await run(m);
      assert.strictEqual(r.json.code, code, code);
      assert.deepStrictEqual(Object.keys(r.json).sort(), ['code', 'message'], code);
      assert.strictEqual(typeof r.json.message, 'string');
      assert.strictEqual(r.json.message.length > 0, true);
      assert.strictEqual('ok' in r.json, false, `${code}: a failure body never carries ok`);
    } finally { await m.close(); }
  }
});

test('AC27: one line per admitted terminal outcome, with the gate fields null until their gate ran; a step-0 rejection emits none', async () => {
  const m = await setup();
  try {
    const r = await post(m.base, goodBody());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(m.logs.length, 1);
    const line = m.logs[0];
    assert.deepStrictEqual(
      Object.keys(line).sort(),
      ['at', 'code', 'evt', 'machine', 'outcome', 'requestId', 'seq', 'sessionId', 'tabUuid'],
    );
    assert.strictEqual(line.evt, 'inbox_reply');
    assert.match(line.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.strictEqual(line.machine, MACHINE);
    assert.strictEqual(line.sessionId, S1);
    assert.strictEqual(line.tabUuid, TAB);
    assert.strictEqual(line.seq, 77);
    assert.strictEqual(line.outcome, 'sent');
    assert.strictEqual(line.code, 'ok');
    assert.strictEqual(line.at, ISO(NOW));
  } finally { await m.close(); }

  // A refusal before the gates ran: tabUuid and seq are null, because "we never looked" and "we
  // looked and found nothing" are different facts.
  const refused = await setup({ routes: { tree: okTree(TAB2) } });
  try {
    await post(refused.base, goodBody());
    assert.strictEqual(refused.logs.length, 1);
    assert.strictEqual(refused.logs[0].code, 'tab_gone');
    assert.strictEqual(refused.logs[0].outcome, 'refused');
    assert.strictEqual(refused.logs[0].tabUuid, null);
    assert.strictEqual(refused.logs[0].seq, null);
  } finally { await refused.close(); }

  // Step 0 owns no request yet: bad_json, a non-object body, the 413 and the hard-cap kill all
  // answer (or do not) without a line.
  const step0 = await setup();
  try {
    await post(step0.base, '{nope');
    await post(step0.base, '[]');
    await rawPost(step0.base, 'x'.repeat(16 * 1024 + 1));
    assert.deepStrictEqual(step0.logs, []);
  } finally { await step0.close(); }

  // Each request gets its own id, and the two uncertain writes log as `sent` — a log that called
  // them "refused" would read, to whoever greps it, as "nothing happened" while text sits in a pane.
  const uncertain = await setup({ routes: { send: async () => ({ ok: false, status: 502, json: { error: 'submit_failed_text_inserted' } }) } });
  try {
    await post(uncertain.base, goodBody({ sessionId: S1 }));
    await post(uncertain.base, goodBody({ machine: 'fixture-nope' }));
    assert.strictEqual(uncertain.logs.length, 2);
    assert.strictEqual(uncertain.logs[0].code, 'text_inserted_submit_failed');
    assert.strictEqual(uncertain.logs[0].outcome, 'sent');
    assert.strictEqual(uncertain.logs[1].code, 'unknown_machine');
    assert.strictEqual(uncertain.logs[1].outcome, 'refused');
    assert.notStrictEqual(uncertain.logs[0].requestId, uncertain.logs[1].requestId);
  } finally { await uncertain.close(); }
});

// ==================================================================================================
// The shipped process. Everything above mounts the route in-process, which proves the pipeline but
// not that a real `server.js` reaches it: the route has to survive the dispatch table, the shared
// auth gate and the token-in-URL refusal, none of which the in-process harness exercises.
// ==================================================================================================

test('END TO END: a real server.js child routes POST /api/radar/inbox/reply, and the 401 gate answers before the route owns the request', async () => {
  const { bootServer, call } = require('./helpers/server-boot');
  const home = await tempDir();
  const radarDir = path.join(home, '.radar');
  await fsp.mkdir(path.join(radarDir, 'events'), { recursive: true });
  await writeConfig(radarDir);
  await writeEvents(radarDir, baseEvents());

  // (a) SERVER_TOKEN set: an unauthenticated POST is refused by the SHARED gate, before the route.
  //     §6.1 marks that row ◊ — it is not this route's body shape and it emits no inbox_reply line.
  const guarded = await bootServer({
    cwd: home,
    env: { RADAR_ENABLED: '1', RADAR_SCAN_ON_START: '0', SERVER_TOKEN: TOKEN, HOME: home },
  });
  try {
    const unauth = await call(guarded.base, 'POST', '/api/radar/inbox/reply', { body: goodBody() });
    assert.strictEqual(unauth.status, 401);
    assert.strictEqual(unauth.json && unauth.json.code, undefined, 'the shared gate does not speak §6.1');

    // A token in the URL is refused by radar itself, whatever the body says.
    const inUrl = await call(guarded.base, 'POST', `/api/radar/inbox/reply?token=${TOKEN}`, { body: goodBody() });
    assert.strictEqual(inUrl.status, 401);
    assert.strictEqual(inUrl.json.error, 'token_in_url');

    // Authenticated, and the route really is mounted: an unconfigured machine gets the §6.1 row.
    const routed = await call(guarded.base, 'POST', '/api/radar/inbox/reply', { token: TOKEN, body: goodBody({ machine: 'fixture-nope' }) });
    assert.strictEqual(routed.status, 400);
    assert.deepStrictEqual(routed.json, { code: 'unknown_machine', message: 'No bridge is configured for this machine.' });

    // And step 0 works in the shipped process too.
    const badJson = await call(guarded.base, 'POST', '/api/radar/inbox/reply', { token: TOKEN, body: '{oops', headers: { 'content-type': 'application/json' } });
    assert.strictEqual(badJson.status, 400);
    assert.strictEqual(badJson.json.code, 'bad_json');
  } finally { await guarded.stop(); }

  // (b) SERVER_TOKEN empty: the whole API is open, so the ONE route that types into a terminal
  //     refuses on its own. This is the case that cannot be tested any other way — server.js reads
  //     SERVER_TOKEN once, at module load, from its own environment.
  const open = await bootServer({
    cwd: home,
    env: { RADAR_ENABLED: '1', RADAR_SCAN_ON_START: '0', HOME: home },
  });
  try {
    const r = await call(open.base, 'POST', '/api/radar/inbox/reply', { body: goodBody() });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, { code: 'unauthenticated_server', message: 'Set SERVER_TOKEN to enable replies.' });
  } finally {
    await open.stop();
    await fsp.rm(home, { recursive: true, force: true });
  }
});

// The default logger, since "injectable with a console.error default" is the contract and a default
// nobody exercises is a default nobody knows is broken.
test('the default logger writes one line of JSON to console.error', async () => {
  const dir = await tempDir();
  await writeConfig(dir);
  await writeEvents(dir, baseEvents());
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  const m = await mount(dir, { bridgeHttp: stubHttp(happyRoutes()), inboxLog: undefined });
  try {
    await post(m.base, goodBody());
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const mine = parsed.filter((p) => p.evt === 'inbox_reply');
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].code, 'ok');
    assert.strictEqual(lines.filter((l) => l.includes('inbox_reply')).every((l) => !l.includes('\n')), true, 'single-line JSON');
  } finally {
    console.error = original;
    await m.close();
  }
});
