'use strict';
// p42 HMXB-003: GET /api/version is unauthenticated and returns exactly {bridge, protocol, minClient}.
const test = require('node:test');
const assert = require('node:assert');
const { bootServer } = require('./helpers/server-boot');
const pkg = require('../package.json');

test('GET /api/version without a token: 200 {bridge, protocol: 1, minClient: null}, no other fields', async () => {
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok' } });
  try {
    for (const headers of [{}, { 'cf-connecting-ip': '1.2.3.4' }]) {
      const r = await fetch(s.base + '/api/version', { headers });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(await r.json(), { bridge: pkg.version, protocol: 1, minClient: null });
    }
    const other = await fetch(s.base + '/api/sessions', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    assert.notStrictEqual(other.status, 200, 'other /api routes still need a credential');
  } finally { await s.stop(); }
});
