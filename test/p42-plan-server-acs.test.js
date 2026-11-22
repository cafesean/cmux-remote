'use strict';
// p42 HMXB-005: server.js acceptance cases (real server, stub hub + stub bridge): T3/T6 401s, T5 duplicate ids, R1 tickets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootServer } = require('./helpers/server-boot');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p42s-'));
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
function signIn(d) {
  fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ ownerSub: 'A', ownerEpoch: 1 }));
  fs.writeFileSync(path.join(d, 'hub-access-token'), JSON.stringify({ ownerSub: 'A', ownerEpoch: 1, accessToken: 'tok-A', exp: 4e9 }));
}
const fwd = { 'cf-connecting-ip': '1.2.3.4' };
const okBridge = () => listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url.startsWith('/cmux/fs/download') ? 'bytes' : '{}'); });

test('AC9 T3/T6: invalid key -> 401 (never 402) at /api/cmux/*, /api/pair/devices and the accounts relay on a cold cache with a hanging hub', async () => {
  const hub = await listen(() => {});   // never answers
  const br = await okBridge(); const d = dir(); signIn(d);
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', HMX_PLAN_STATE_DIR: d, HMX_HUB_URL: 'http://127.0.0.1:' + hub.address().port,
    CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: 'http://127.0.0.1:' + br.address().port, secret: 'sb' }]) } });
  try {
    for (const p of ['/api/cmux/machines', '/api/pair/devices', '/api/cmux/accounts', '/api/cmux/screen/mouse']) {
      const r = await fetch(s.base + p, { method: p.endsWith('mouse') ? 'POST' : 'GET', headers: { authorization: 'Bearer junk', ...fwd } });
      assert.strictEqual(r.status, 401, p);
    }
    assert.ok(s.alive());
  } finally { await s.stop(); hub.closeAllConnections?.(); hub.close(); br.close(); }
});

test('AC10 T5: CMUX_MACHINES + CMUX_CONFIG with a duplicate id count once; Free lists only the first', async () => {
  const br = await okBridge();
  const base = 'http://127.0.0.1:' + br.address().port;
  const cfg = path.join(dir(), 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ machines: [{ id: 'm1', label: 'M1 again', baseUrl: base, secret: 'sb' }, { id: 'm2', label: 'M2', baseUrl: base, secret: 'sb' }] }));
  const mk = (ent) => listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/entitlement') ? JSON.stringify(ent) : JSON.stringify({ devices: [] })); });
  const env = (hub, d) => ({ SERVER_TOKEN: 'tok', HMX_PLAN_STATE_DIR: d, HMX_HUB_URL: 'http://127.0.0.1:' + hub.address().port, CMUX_CONFIG: cfg,
    CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: base, secret: 'sb' }]) });
  const pro = await mk({ enforced: true, entitlement: { plan: 'pro', limits: { maxMachines: null, maxDevices: null, remoteDesktop: 'full' } } });
  const d1 = dir(); signIn(d1); const s1 = await bootServer({ env: env(pro, d1) });
  try {
    const r = await fetch(s1.base + '/api/cmux/machines', { headers: { authorization: 'Bearer tok' } });
    assert.deepStrictEqual((await r.json()).machines.map((m) => m.id).sort(), ['m1', 'm2']);
  } finally { await s1.stop(); pro.close(); }
  const free = await mk({ enforced: true, entitlement: { plan: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } } });
  const d2 = dir(); signIn(d2); const s2 = await bootServer({ env: env(free, d2) });
  try {
    const r = await fetch(s2.base + '/api/cmux/machines', { headers: { authorization: 'Bearer tok' } });
    assert.strictEqual((await r.json()).machines.length, 1);
  } finally { await s2.stop(); free.close(); br.close(); }
});

test('AC11/AC23 R1: a download ticket minted for key K is refused (401, ticket deleted) after K is revoked', async () => {
  const hub = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/entitlement') ? JSON.stringify({ enforced: false }) : JSON.stringify({ devices: [] })); });
  const br = await okBridge(); const d = dir(); signIn(d);
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', PUBLIC_URL: 'https://mac.example', HMX_PLAN_STATE_DIR: d, HMX_HUB_URL: 'http://127.0.0.1:' + hub.address().port,
    CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: 'http://127.0.0.1:' + br.address().port, secret: 'sb' }]) } });
  const J = { 'content-type': 'application/json' };
  try {
    const st = await (await fetch(s.base + '/api/pair/start', { method: 'POST', headers: { authorization: 'Bearer tok' } })).json();
    const cl = await (await fetch(s.base + '/api/pair/claim', { method: 'POST', headers: J, body: JSON.stringify({ code: st.code, deviceName: 'phone' }) })).json();
    assert.ok(cl.deviceKey, JSON.stringify({ st, cl }));
    const K = { authorization: 'Bearer ' + cl.deviceKey };
    let r = await fetch(s.base + '/api/cmux/fs/download-ticket?machine=m1&path=/tmp/x', { headers: K });
    assert.strictEqual(r.status, 200);
    const { ticket } = await r.json();
    r = await fetch(s.base + '/api/cmux/fs/download?ticket=' + ticket); assert.strictEqual(r.status, 200); await r.text();
    const devs = await (await fetch(s.base + '/api/pair/devices', { headers: { authorization: 'Bearer tok' } })).json();
    const id = devs.devices.find((x) => x.deviceName === 'phone').id;
    r = await fetch(s.base + '/api/pair/devices/' + id, { method: 'DELETE', headers: { authorization: 'Bearer tok' } });
    assert.ok(r.status < 300, 'revoked');
    r = await fetch(s.base + '/api/cmux/fs/download?ticket=' + ticket); assert.strictEqual(r.status, 401);
    r = await fetch(s.base + '/api/cmux/fs/download?ticket=' + ticket); assert.strictEqual(r.status, 403, 'ticket deleted');
  } finally { await s.stop(); hub.close(); br.close(); }
});
