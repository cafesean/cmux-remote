'use strict';
// p41 A13 — CF Access service-token headers on every server->bridge call: helper, server bridge(),
// radar reply route (the bridgeHttp path), unix sockets, and no secret in logs. Fixture values are fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const cf = require('../lib/cf-access');
const { createRadar } = require('../radar-server');
const sessions = require('../radar/mod-sessions');
const { bootServer } = require('./helpers/server-boot');

const FAKE_ID = 'fake-id-0123456789.access';
const FAKE_SECRET = 'fake-secret-abcdef0123456789';
const ENV = { CMUX_MINI_CF_ACCESS_ID: FAKE_ID, CMUX_MINI_CF_ACCESS_SECRET: FAKE_SECRET };
const MINI = { accessIdEnv: 'CMUX_MINI_CF_ACCESS_ID', accessSecretEnv: 'CMUX_MINI_CF_ACCESS_SECRET' };

test('helper: raw, env names, name wins, bad name rejected, missing env -> null', () => {
  assert.deepEqual(cf.resolveAccess({ accessId: 'i', accessSecret: 's' }, {}), { id: 'i', secret: 's' });
  assert.deepEqual(cf.resolveAccess(MINI, ENV), { id: FAKE_ID, secret: FAKE_SECRET });
  assert.deepEqual(cf.resolveAccess({ accessId: 'raw', accessSecret: 'raw', ...MINI }, ENV), { id: FAKE_ID, secret: FAKE_SECRET });
  assert.equal(cf.resolveAccess({ ...MINI, accessIdEnv: 'bad name', accessId: 'raw', accessSecret: 'raw' }, ENV), null);
  assert.equal(cf.resolveAccess({ ...MINI, accessIdEnv: 'CMUX_NOPE' }, ENV), null);
  assert.equal(cf.resolveAccess({}, {}), null);
  assert.deepEqual(cf.headersFor(null), {});
  assert.deepEqual(cf.headersFor({ id: 'a', secret: 'b' }), { 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': 'b' });
  assert.deepEqual(cf.accessHeadersFor({ baseUrl: 'unix:/tmp/x.sock', accessId: 'i', accessSecret: 's' }, {}), {});
  assert.deepEqual(cf.accessHeadersFor({ baseUrl: 'http://x', socketPath: '/tmp/x', accessId: 'i', accessSecret: 's' }, {}), {});
  assert.equal(cf.statusLabel({ ...MINI, accessIdEnv: 'CMUX_NOPE' }, ENV), ' [CF Access: missing CMUX_NOPE]');
  assert.equal(cf.statusLabel(MINI, ENV), ' [CF Access]');
});

test('radar normalizeBridges keeps the access fields; collector headers carry them', () => {
  const [b] = sessions.normalizeBridges({ bridges: [{ id: 'm', baseUrl: 'https://m.example.com', ...MINI }] }, 'c', []);
  assert.deepEqual(sessions.cfAccessHeaders(b, ENV), { 'CF-Access-Client-Id': FAKE_ID, 'CF-Access-Client-Secret': FAKE_SECRET });
});

function listenBridge(listenArg) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ workspaces: [] }));
  });
  return new Promise((r) => srv.listen(listenArg, () => r({ srv, seen })));
}

test('server bridge(): TCP machine sends CF headers, missing env sends none; no secret in logs', async () => {
  const { call } = require('./helpers/server-boot');
  const fb = await listenBridge({ port: 0, host: '127.0.0.1' });
  const port = fb.srv.address().port;
  const machines = [
    { id: 'tcp', label: 'T', baseUrl: `http://127.0.0.1:${port}`, secret: 's1', ...MINI },
    { id: 'miss', label: 'M', baseUrl: `http://127.0.0.1:${port}`, secret: 's1', ...MINI, accessIdEnv: 'CMUX_MISSING_VAR' },
  ];
  const s = await bootServer({ env: { ...ENV, CMUX_MACHINES: JSON.stringify(machines) } });
  let logs = '';
  try {
    for (const id of ['tcp', 'miss']) await call(s.base, 'GET', `/api/cmux/tree?machine=${id}`);
    assert.equal(fb.seen[0]['cf-access-client-id'], FAKE_ID);
    assert.equal(fb.seen[0]['cf-access-client-secret'], FAKE_SECRET);
    assert.equal(fb.seen[1]['cf-access-client-id'], undefined, 'missing env -> no headers');
    assert.equal(fb.seen[1]['cf-access-client-secret'], undefined);
  } finally {
    logs = s.stdout() + s.stderr();
    await s.stop(); fb.srv.close();
  }
  assert.match(logs, /\[CF Access\]/);
  assert.match(logs, /\[CF Access: missing CMUX_MISSING_VAR\]/);
  for (const v of [FAKE_ID, FAKE_SECRET]) assert.ok(!logs.includes(v), 'secret value in logs');
});

test('server bridge(): unix socket machine sends no CF headers even with raw values', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join('/tmp', 'a13-')));
  await fsp.chmod(dir, 0o700);
  const sock = path.join(dir, 'b.sock');
  const ub = await listenBridge(sock);
  const machines = [{ id: 'uds', label: 'U', baseUrl: `unix:${sock}`, secret: 's2', accessId: 'raw-id', accessSecret: 'raw-zzz' }];
  const s = await bootServer({ socket: path.join(dir, 's.sock'), env: { CMUX_MACHINES: JSON.stringify(machines) } });
  try {
    const { call: ucall } = require('./helpers/unix-call');
    await ucall(s.socketPath, 'GET', '/api/cmux/tree?machine=uds');
    assert.ok(ub.seen.length >= 1, 'socket bridge was called');
    for (const h of ub.seen) { assert.equal(h['cf-access-client-id'], undefined); assert.equal(h['cf-access-client-secret'], undefined); }
  } finally { await s.stop(); ub.srv.close(); await fsp.rm(dir, { recursive: true, force: true }); }
});

const MACHINE = 'fixture-remote';
const BASE = 'http://fixture-remote.invalid:8799';
const SESSION = 'fixture-inbox-1';
const TAB = 'fixture-tab-uuid-1';
const SEQ = 41;
const REPLY_TEXT = 'Option A.';

const NOW = Date.parse('2026-01-02T03:05:00.000Z');
const T_STOP = Date.parse('2026-01-02T02:58:57.000Z');
const T_BLOCK = Date.parse('2026-01-02T03:00:00.000Z');
const ASSISTANT_TS = '2026-01-02T02:58:57.000Z';
const TURN = { blockedSince: new Date(T_BLOCK).toISOString(), assistantTs: ASSISTANT_TS };
// §5.5 step 4's `ok` window. Used here only to step past it, proving a release came from a new turn
// rather than from a timer; the boundary itself is pinned in test/p9-reply-gates.test.js.
const REPLY_LEASE_WINDOW = 120000;

// A grid whose OWN evidence proves `agent`: the boxed prompt sits below the shell prompt that
// launched it. Gate 3 reads nothing else — status is never consulted.
const STYLES = [
  { id: 0, background: '#000000', foreground: '#999999' },
  { id: 1, background: '#1A1A1A', foreground: '#FFFFFF' },
];
const AGENT_GRID = {
  active_screen: 'primary', styles: STYLES,
  row_spans: [
    { row: 0, column: 0, style_id: 1, text: ' demo@fixture  ~ ' },
    { row: 2, column: 0, style_id: 0, text: '────────────────' },
    { row: 3, column: 0, style_id: 0, text: '❯ ' },
    { row: 4, column: 0, style_id: 0, text: '────────────────' },
  ],
};
const TREE = {
  workspaces: [{
    ref: 'fixture-workspace',
    title: 'fixture-workspace',
    tabs: [{ id: TAB, ref: 'tab-2', type: 'terminal', status: '', statusCovered: true }],
  }],
};

// A REMOTE bridge, because the gap is easiest to state honestly there: the events arrive as a page
// the test controls outright, and `{events: [], more: false, skipped: 0}` is an unambiguously
// COMPLETE read that simply does not carry this session. The same fact reaches a local bridge
// through the retention boundary; the route cannot tell the two apart, which is the point.
async function harness(over) {
  const o = over || {};
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p41-a13-')));
  const tp = path.join(dir, 'transcript.jsonl');
  await fsp.writeFile(tp, `${JSON.stringify({
    type: 'assistant', timestamp: ASSISTANT_TS, message: { content: [{ type: 'text', text: 'A or B?' }] },
  })}\n`);
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1,
    role: 'leader',
    // Pinned so the implicit local bridge can never be this machine's real hostname: the repository
    // is public and a test's fixtures are shipped bytes.
    collectorId: 'fixture-box',
    repos: [],
    timeouts: { bridgeMs: 8000 },
    bridges: [{ id: MACHINE, baseUrl: BASE, accessIdEnv: 'CMUX_TEST_CF_ID', accessSecretEnv: 'CMUX_TEST_CF_'+'SECRET' }],
  }, null, 2));

  const blocked = [
    { ts: T_STOP, sessionId: SESSION, event: 'Stop', transcriptPath: tp },
    {
      ts: T_BLOCK, sessionId: SESSION, event: 'Notification', notificationType: 'idle_prompt',
      transcriptPath: tp, surfaceId: TAB,
    },
  ];

  const state = { events: blocked, sendAnswer: o.sendAnswer };
  const calls = [];
  const stub = async (url, opts) => {
    const kind = /session-events/.test(url) ? 'events'
      : /\/cmux\/tree/.test(url) ? 'tree'
        : /\/cmux\/grid/.test(url) ? 'grid' : 'send';
    calls.push({ kind, body: (opts || {}).body, headers: (opts || {}).headers });
    if (kind === 'events') {
      return { ok: true, status: 200, json: { events: state.events, more: state.more === true, skipped: state.skipped || 0 } };
    }
    if (kind === 'tree') return { ok: true, status: 200, json: TREE };
    if (kind === 'grid') return { ok: true, status: 200, json: { seq: SEQ, grid: AGENT_GRID } };
    return state.sendAnswer;
  };

  const radar = createRadar({
    radarDir: dir,
    scanOnStart: false,
    log: () => {},
    env: { SERVER_TOKEN: 'fixture-token' },
    now: () => state.now || NOW,
    // No real timer may exist in a test that never fires one.
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    bridgeHttp: stub,
    inboxLog: () => {},
  });

  // The body is fed after handle() is called: readJsonBody attaches its listeners on the way in.
  const post = async () => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = {};
    req.destroy = () => {};
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.headersSent = false;
    res.writeHead = (c) => { res.status = c; res.headersSent = true; return res; };
    res.end = (b) => { res.writableEnded = true; res.raw = b; };
    const p = radar.handle(req, res, new URL('http://x/api/radar/inbox/reply'));
    req.emit('data', Buffer.from(JSON.stringify({
      machine: MACHINE, sessionId: SESSION, text: REPLY_TEXT, turn: TURN,
    }), 'utf8'));
    req.emit('end');
    await p;
    return { status: res.status, body: res.raw === undefined ? null : JSON.parse(res.raw) };
  };

  return {
    dir,
    post,
    state,
    blocked,
    allCalls: () => calls,
    sends: () => calls.filter((c) => c.kind === 'send'),
    countOf: (kind) => calls.filter((c) => c.kind === kind).length,
    cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }); },
  };
}


test('radar reply route (the bridgeHttp path) sends CF headers on every bridge call; nothing printed', async () => {
  process.env.CMUX_TEST_CF_ID = FAKE_ID;
  process.env.CMUX_TEST_CF_SECRET = FAKE_SECRET;
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logged.push(a.join(' ')); console.error = console.log; console.warn = console.log;
  const h = await harness({ sendAnswer: { ok: true, status: 200, json: { ok: true } } });
  try {
    await h.post();
    assert.equal(h.sends().length, 1, 'send reached the bridge');
    assert.ok(h.allCalls().length >= 2);
    for (const c of h.allCalls()) {
      assert.equal(c.headers['CF-Access-Client-Id'], FAKE_ID, `${c.kind} carries the id`);
      assert.equal(c.headers['CF-Access-Client-Secret'], FAKE_SECRET, `${c.kind} carries the secret`);
    }
  } finally {
    Object.assign(console, orig);
    await h.cleanup();
    delete process.env.CMUX_TEST_CF_ID;
    delete process.env.CMUX_TEST_CF_SECRET;
  }
  assert.ok(!logged.join('\n').includes(FAKE_SECRET), 'secret in console output');
});
