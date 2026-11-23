'use strict';
// HMX-137 S1: the HyprMux app on this Mac finds the Bridge, whose server port was picked at random, through a fixed
// loopback hello that names the real port. Only GET /api/pair/hello answers; a taken port is skipped, never fatal.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startDiscovery, parsePort } = require('../lib/discovery');

const get = (port, p, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end();
});
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('hello names the real server port; nothing else answers', async () => {
  const port = await freePort();
  const srv = await startDiscovery({ port, serverPort: 63150, hello: () => ({ app: 'cmux-remote', serverId: 's1', version: '0.3.7' }), log: () => {} });
  assert.ok(srv);
  try {
    const r = await get(port, '/api/pair/hello');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { app: 'cmux-remote', serverId: 's1', version: '0.3.7', port: 63150 });
    assert.strictEqual((await get(port, '/api/sessions')).status, 404);
    assert.strictEqual((await get(port, '/api/pair/start', 'POST')).status, 404);
    assert.strictEqual((await get(port, '/api/pair/hello', 'POST')).status, 404);
  } finally { srv.close(); }
});

test('a taken port, an unset port or the server port itself turns discovery off', async () => {
  const busy = http.createServer(); await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const taken = busy.address().port;
  try {
    assert.strictEqual(await startDiscovery({ port: taken, serverPort: 1234, hello: () => ({}), log: () => {} }), null);
  } finally { busy.close(); }
  assert.strictEqual(await startDiscovery({ port: undefined, serverPort: 1234, hello: () => ({}) }), null);
  assert.strictEqual(await startDiscovery({ port: 1234, serverPort: 1234, hello: () => ({}) }), null);
  assert.strictEqual(parsePort('47380'), 47380);
  assert.strictEqual(parsePort('abc'), null);
  assert.strictEqual(parsePort('70000'), null);
});

test('server.js starts discovery on the bound port in both TCP listen paths', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /afterListen\(\); startLocalDiscovery\(f\.port\);/);
  assert.match(src, /afterListen\(\);\n\s*startLocalDiscovery\(bound\);/);
  assert.match(src, /if \(!process\.env\.HMX_DISCOVERY_PORT\) return;/);
});
