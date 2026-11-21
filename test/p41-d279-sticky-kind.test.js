'use strict';
// p41 D279 — an inconclusive agent probe (no process match, no recent hook event, no transcript) keeps the
// pane's last agent kind for kindStickyMs instead of flipping it to a terminal; a real answer still wins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionRoutes, LIMITS } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd279-')));

function routes() {
  const clock = { t: 1000 };
  const feed = { events: [] };
  const r = createSessionRoutes({
    machineId: 'mini', backend: 'cmux', home: mk(), now: () => clock.t, listSnapshotMs: 0,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'S1', ref: 'surface:1', title: 'm-chief', type: 'terminal' }] }],
    procSnapshot: async () => ({ table: [], sessions: [] }),
    readEvents: async () => ({ events: feed.events, more: false }),
  });
  const kind = () => new Promise((resolve) => {
    let code = 0;
    r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve(code === 200 ? JSON.parse(b).sessions[0].kind : `http_${code}`) }, new URL('http://x/cmux/sessions'));
  });
  const hook = (event) => { feed.events = [{ ts: Date.now(), surfaceId: 'S1', event }]; };
  return { kind, clock, feed, hook };
}

test('D279: an empty probe keeps the agent kind (no flip to terminal)', async () => {
  const { kind, feed, hook, clock } = routes();
  hook('UserPromptSubmit');
  assert.equal(await kind(), 'claude');
  feed.events = [];            // probe comes back empty (slow cmux, no recent hook event)
  clock.t += 5000;
  assert.equal(await kind(), 'claude');
  clock.t += 60000;
  assert.equal(await kind(), 'claude');
});

test('D279: after kindStickyMs of empty probes the pane becomes a terminal', async () => {
  const { kind, feed, hook, clock } = routes();
  hook('Stop');
  assert.equal(await kind(), 'claude');
  feed.events = [];
  clock.t += LIMITS.kindStickyMs + 1;
  assert.equal(await kind(), 'terminal');
});

test('D279: a real answer (SessionEnd) turns it into a terminal at once', async () => {
  const { kind, hook, clock } = routes();
  hook('UserPromptSubmit');
  assert.equal(await kind(), 'claude');
  hook('SessionEnd');
  clock.t += 1000;
  assert.equal(await kind(), 'terminal');
});
