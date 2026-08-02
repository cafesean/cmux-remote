'use strict';
// S-008 evidence — a VIEWER renders no select affordance at all (spec §3): the affordance's only
// possible outcome there is 409 viewer_readonly, and an affordance that can only 409 is itself a
// chore. The role signal is the proxy overlay, proven separately in run.sh; here the shipped tab
// reads the viewer server's own /api/radar/state.
//
// Usage: node ui-proof-viewer.js  (VIEWER_BASE, SERVER_TOKEN in the environment)
const assert = require('assert');
const { bootRadar, buttonsNamed, checkboxes, containsText, flush } = require('./dom-stub');

(async () => {
  const b = bootRadar({ base: process.env.VIEWER_BASE, token: process.env.SERVER_TOKEN });
  await b.api.refresh();
  await flush();
  assert.ok(containsText(b.mount, 'RADAR'), 'the board itself renders — refusal is scoped to the affordance');
  assert.strictEqual(buttonsNamed(b.mount, 'select').length, 0, 'NO select affordance on a viewer');
  assert.strictEqual(checkboxes(b.mount).length, 0);
  console.log(JSON.stringify({ ok: true, viewer: true, selectButtons: 0 }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ui-proof-viewer FAIL:', e && e.message); process.exit(1); });
