'use strict';
// p42: the hub answers in its envelope {success, data} (hub-dev c3328386, contract v1.6). The Bridge client unwraps it.
const test = require('node:test');
const assert = require('node:assert');
const { createHubClient } = require('../lib/plan-policy');

const env = (data, status = 200) => ({ status, ok: status < 400, json: async () => (status < 400 ? { success: true, data } : { success: false, error: data }) });
function client(routes) {
  return createHubClient({ base: 'https://hub.example', fetchImpl: async (url) => routes[new URL(url).pathname.split('/').pop()] });
}

test('enveloped /entitlement, /plans and /devices are read from data (real hub shape)', async () => {
  const c = client({
    entitlement: env({ plan: 'free', status: 'none', source: 'none', limits: { maxDevices: 1, maxMachines: 1, remoteDesktop: 'view' }, enforced: true }),
    plans: env({ enforced: true, defaultPlan: 'free', fairUse: { maxMachines: 20, maxDevices: 20 }, plans: [{ code: 'free', limits: { maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' } }] }),
    devices: env({ devices: [{ id: 'h1', deviceId: 'd1', status: 'active', publicKey: 'pk' }] }),
  });
  const e = await c.entitlement('t');
  assert.strictEqual(e.enforced, true); assert.strictEqual(e.plan, 'free'); assert.strictEqual(e.limits.remoteDesktop, 'view');
  const p = await c.plans();
  assert.strictEqual(p.enforced, true); assert.strictEqual(p.defaultPlan, 'free');
  assert.deepStrictEqual((await c.devices('t')).map((d) => d.id), ['h1']);
});

test('enveloped 404 PLANS_NOT_CONFIGURED -> enforced:false', async () => {
  const c = client({ entitlement: env({ code: 'PLANS_NOT_CONFIGURED' }, 404) });
  assert.deepStrictEqual(await c.entitlement('t'), { enforced: false });
});
