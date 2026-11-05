'use strict';
// p41 B1 — /api/sessions* pass-through (lib/sessions-proxy.js; spec §4.1/§7, sessions/CONTRACT.md "Routes").
// REAL server.js child, two test-owned fake bridges on TCP loopback (registry ids 'a'/'b', bridge
// machineIds 'mini'/'air' — deliberately different, as in production).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { bootServer } = require('./helpers/server-boot');
const { call, openStream } = require('./helpers/unix-call');

const TOKEN = 'p41-b1-token';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const sess = (mid, sf) => ({ id: `${mid}:${sf}`, machine: mid, workspace: 'w', surface: sf, kind: 'claude', title: `t-${sf}`, status: 'idle', preview: '', lastActivity: 1 });

async function fakeBridge(mid, secret) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const rec = { url: req.url, secret: req.headers['x-bridge-secret'], closedAt: null };
    log.push(rec);
    res.on('close', () => { rec.closedAt = Date.now(); });
    const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-bridge-secret'] !== secret) return send(401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    const pre = `/cmux/sessions/${encodeURIComponent(mid + ':surface:1')}`;
    if (req.method === 'POST' && (u.pathname === '/cmux/send' || u.pathname === '/cmux/key')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { rec.body = body; send(200, { ok: true, via: mid }); });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/cmux/layout') return send(200, { via: mid });
    if (u.pathname === '/cmux/sessions') return send(200, { machineId: mid, sessions: [sess(mid, 'surface:1')] });
    if (u.pathname === `${pre}/thread`) {
      if (u.searchParams.get('before') === 'bad') return send(400, { error: 'bad_cursor' });
      return send(200, { title: 'T', messages: [], cursor: `opaque/${u.searchParams.get('before') || ''}+=` });
    }
    if (u.pathname === `${pre}/thread-stream`) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hb\n\n');
      res.write('data: {"type":"status","status":"working","session":"x"}\n\n');
      return;   // left open
    }
    if (u.pathname === `${pre}/attachment/0`) { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); return res.end(PNG); }
    return send(404, { error: 'not_found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { log, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(() => r())); } };
}

let ba; let bb; let server;
before(async () => {
  ba = await fakeBridge('mini', 'sa');
  bb = await fakeBridge('air', 'sb');
  server = await bootServer({ env: {
    SERVER_TOKEN: TOKEN,
    CMUX_MACHINES: JSON.stringify([{ id: 'a', label: 'A', baseUrl: ba.url, secret: 'sa' }, { id: 'b', label: 'B', baseUrl: bb.url, secret: 'sb' }]),
  } });
});
after(async () => { await server.stop(); await ba.close(); await bb.close(); });

const enc = (id) => encodeURIComponent(id);

test('merges two machines', async () => {
  const r = await call(server.base, 'GET', '/api/sessions', { token: TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.id).sort(), ['air:surface:1', 'mini:surface:1']);
  assert.deepEqual(r.json.machines.map((m) => [m.id, m.machineId, m.ok]), [['a', 'mini', true], ['b', 'air', true]]);
  // ids route back to the owning machine, with that machine's secret
  const ta = await call(server.base, 'GET', `/api/sessions/${enc('mini:surface:1')}/thread?before=c1`, { token: TOKEN });
  assert.equal(ta.status, 200);
  assert.equal(ta.json.cursor, 'opaque/c1+=', 'cursor passes through untouched');
  const tb = await call(server.base, 'GET', `/api/sessions/${enc('air:surface:1')}/thread`, { token: TOKEN });
  assert.equal(tb.status, 200);
  assert.ok(ba.log.some((x) => x.url.includes('/thread?before=c1') && x.secret === 'sa'));
  assert.ok(bb.log.some((x) => x.url.endsWith('/thread') && x.secret === 'sb'));
});

test('status codes pass through (400 bad_cursor, 404) and attachment bytes', async () => {
  const bad = await call(server.base, 'GET', `/api/sessions/${enc('mini:surface:1')}/thread?before=bad`, { token: TOKEN });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'bad_cursor' });
  const nf = await call(server.base, 'GET', `/api/sessions/${enc('mini:surface:9')}/thread`, { token: TOKEN });
  assert.equal(nf.status, 404);
  const nm = await call(server.base, 'GET', `/api/sessions/${enc('ghost:surface:1')}/thread`, { token: TOKEN });
  assert.equal(nm.status, 404);
  const at = await call(server.base, 'GET', `/api/sessions/${enc('air:surface:1')}/attachment/0`, { token: TOKEN });
  assert.equal(at.status, 200);
  assert.equal(at.headers['content-type'], 'image/png');
  assert.deepEqual(at.body, PNG);
});

test('an unreachable machine is reported, the rest still list', async () => {
  const s2 = await bootServer({ env: {
    SERVER_TOKEN: TOKEN,
    CMUX_MACHINES: JSON.stringify([{ id: 'a', label: 'A', baseUrl: ba.url, secret: 'sa' }, { id: 'dead', label: 'D', baseUrl: 'http://127.0.0.1:1', secret: 'x' }]),
  } });
  try {
    const r = await call(s2.base, 'GET', '/api/sessions', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.json.sessions.length, 1);
    assert.equal(r.json.machines.find((m) => m.id === 'dead').ok, false);
  } finally { await s2.stop(); }
});

test('SSE passes through, heartbeat included, and client close reaches the bridge', async () => {
  const before = ba.log.length;
  const path = `/api/sessions/${enc('mini:surface:1')}/thread-stream`;
  await new Promise((resolve, reject) => {
    const req = http.get(`${server.base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (buf.includes(': hb\n\n') && buf.includes('"status":"working"')) { req.destroy(); resolve(); }
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => reject(new Error('no SSE frames')), 8000);
  });
  const rec = ba.log.slice(before).find((x) => x.url.endsWith('/thread-stream'));
  assert.ok(rec, 'bridge saw the stream request');
  const t0 = Date.now();
  while (!rec.closedAt && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(rec.closedAt, 'upstream request closed after the client left');
});

test('token required', async () => {
  for (const p of ['/api/sessions', `/api/sessions/${enc('mini:surface:1')}/thread`, `/api/sessions/${enc('mini:surface:1')}/thread-stream`, `/api/sessions/${enc('mini:surface:1')}/attachment/0`]) {
    assert.equal((await call(server.base, 'GET', p)).status, 401, p);
    assert.equal((await call(server.base, 'GET', p, { token: 'wrong' })).status, 401, p);
  }
  const s = openStream(server.base, '/api/sessions/x/thread-stream', {});
  assert.equal((await s).status, 401);
  const seen = ba.log.length + bb.log.length;
  await call(server.base, 'GET', '/api/sessions');
  assert.equal(ba.log.length + bb.log.length, seen, 'unauthenticated call never reached a bridge');
});

test('existing routes unchanged', async () => {
  assert.equal((await call(server.base, 'GET', '/api/cmux/machines', { token: TOKEN })).status, 200);
});

test('a machine that blips keeps its routing: thread-stream for its id is 502, not 404', async () => {
  const fb = await fakeBridge('mini', 'sa');
  const s2 = await bootServer({ env: {
    SERVER_TOKEN: TOKEN,
    CMUX_MACHINES: JSON.stringify([{ id: 'a', label: 'A', baseUrl: fb.url, secret: 'sa' }, { id: 'b', label: 'B', baseUrl: bb.url, secret: 'sb' }]),
  } });
  try {
    const first = await call(s2.base, 'GET', '/api/sessions', { token: TOKEN });
    assert.equal(first.json.sessions.length, 2);
    await fb.close();   // tunnel down
    const poll = await call(s2.base, 'GET', '/api/sessions', { token: TOKEN });   // the poll that used to drop the mapping
    assert.equal(poll.json.machines.find((m) => m.id === 'a').ok, false);
    const t = await call(s2.base, 'GET', `/api/sessions/${enc('mini:surface:1')}/thread`, { token: TOKEN });
    assert.equal(t.status, 502);
    const st = await openStream(s2.base, `/api/sessions/${enc('mini:surface:1')}/thread-stream`, { token: TOKEN });
    assert.equal(st.status, 502);
    st.close();
    // an id nobody could own while a machine is down is also 502 (it may be that machine's)
    assert.equal((await call(s2.base, 'GET', `/api/sessions/${enc('other:surface:1')}/thread`, { token: TOKEN })).status, 502);
  } finally { await s2.stop(); }
});

test('?machine= on the list: unknown machine is 404', async () => {
  assert.equal((await call(server.base, 'GET', '/api/sessions?machine=nope', { token: TOKEN })).status, 404);
  const r = await call(server.base, 'GET', '/api/sessions?machine=b', { token: TOKEN });
  assert.deepEqual(r.json.sessions.map((x) => x.id), ['air:surface:1']);
});

test('BUG2: /api/cmux/send|key and query routes accept the bridge machineId (session.machine)', async () => {
  const s2 = await bootServer({ env: {
    SERVER_TOKEN: TOKEN,
    CMUX_MACHINES: JSON.stringify([{ id: 'a', label: 'A', baseUrl: ba.url, secret: 'sa' }, { id: 'b', label: 'B', baseUrl: bb.url, secret: 'sb' }]),
  } });   // fresh server: the id map is EMPTY, so the first send must learn it itself
  try {
    const n0 = bb.log.length;
    const send = await call(s2.base, 'POST', '/api/cmux/send', { token: TOKEN, body: { machine: 'air', surface: 'surface:1', text: 'hi', submit: true } });
    assert.equal(send.status, 200);
    assert.equal(send.json.via, 'air', 'reached the air bridge');
    const sent = bb.log.slice(n0).find((x) => x.url === '/cmux/send');
    assert.equal(sent.secret, 'sb');
    assert.deepEqual(JSON.parse(sent.body), { surface: 'surface:1', text: 'hi', submit: true });
    const key = await call(s2.base, 'POST', '/api/cmux/key', { token: TOKEN, body: { machine: 'mini', surface: 'surface:1', key: 'enter' } });
    assert.equal(key.json.via, 'mini');
    const lay = await call(s2.base, 'GET', '/api/cmux/layout?machine=air&workspace=w', { token: TOKEN });
    assert.equal(lay.json.via, 'air');
    // registry ids keep working (PWA)
    assert.equal((await call(s2.base, 'POST', '/api/cmux/send', { token: TOKEN, body: { machine: 'b', surface: 'surface:1', text: 'x' } })).json.via, 'air');
    // unknown machine -> 404
    assert.equal((await call(s2.base, 'POST', '/api/cmux/send', { token: TOKEN, body: { machine: 'ghost', surface: 's', text: 'x' } })).status, 404);
    assert.equal((await call(s2.base, 'GET', '/api/cmux/layout?machine=ghost', { token: TOKEN })).status, 404);
  } finally { await s2.stop(); }
});
