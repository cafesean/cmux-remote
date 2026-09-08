'use strict';
// p17 — /api/cmux/fleet: every machine's tree in ONE call. A dead or misconfigured machine comes back
// in its own slot as ok:false and must not delay the others.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { bootServer, call } = require('./helpers/server-boot');

const TREE = { workspaces: [{ ref: 'workspace:1', id: 'W1', title: 'one', selected: true,
  tabs: [{ id: 'S1', ref: 'surface:1', title: 'claude', type: 'terminal', selected: true, pane: 'P1',
    paneRef: 'pane:1', inPane: true, status: 'Needs input' }],
  panes: [{ ref: 'pane:1', id: 'P1', index: 0, focused: true, selected: 'S1', tabs: ['S1'] }] }] };

function stubBridge(secret) {
  const srv = http.createServer((req, res) => {
    const ok = req.headers['x-bridge-secret'] === secret;
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? TREE : { error: 'forbidden' }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  })));
}
// a port nothing listens on: bind, read it, close it — connections are refused at once
const deadPort = () => new Promise((resolve) => {
  const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

test('GET /api/cmux/fleet: every machine in one call; dead and wrong-secret ones are ok:false', async (t) => {
  const live = await stubBridge('s1');
  const dead = await deadPort();
  const srv = await bootServer({ env: {
    SERVER_TOKEN: 'tok', CMUX_MACHINE_URL: '', CMUX_CONFIG: '',
    CMUX_MACHINES: JSON.stringify([
      { id: 'live', label: 'Live Mac', baseUrl: live.base, secret: 's1' },
      { id: 'dead', label: 'Dead Mac', baseUrl: `http://127.0.0.1:${dead}`, secret: 'x' },
      { id: 'wrong', label: 'Wrong Secret', baseUrl: live.base, secret: 'nope' },
    ]) } });
  t.after(async () => { await srv.stop(); await live.close(); });

  assert.equal((await call(srv.base, 'GET', '/api/cmux/fleet')).status, 401, 'token-gated like every /api route');

  const t0 = Date.now();
  const r = await call(srv.base, 'GET', '/api/cmux/fleet', { token: 'tok' });
  const took = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.at, 'number');
  assert.deepEqual(r.json.machines.map((m) => m.id), ['live', 'dead', 'wrong'], 'registry order, every machine present');
  const by = Object.fromEntries(r.json.machines.map((m) => [m.id, m]));
  assert.equal(by.live.ok, true);
  assert.equal(by.live.label, 'Live Mac');
  assert.equal(by.live.workspaces[0].tabs[0].status, 'Needs input', 'the tree is relayed as-is');
  assert.equal(by.dead.ok, false);
  assert.equal(by.dead.error, 'bridge_unreachable');
  assert.deepEqual(by.dead.workspaces, []);
  assert.equal(by.wrong.ok, false);
  assert.equal(by.wrong.error, 'forbidden');
  assert.ok(took < 3000, `a dead machine must not delay the call (took ${took}ms)`);
  for (const m of r.json.machines) { assert.equal(m.baseUrl, undefined); assert.equal(m.secret, undefined); }
});
