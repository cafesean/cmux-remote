'use strict';
// p41 D280 — a tmux-hosted claude that lost its CMUX_SURFACE_ID (cmux.app restart) still maps its hook events
// to its pane: the receiver records its tmux pane + socket from the env (no spawn), the bridge maps that
// pane to its tmux session and the session to the cmux pane showing it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cmuxIdentity, tmuxPaneOf } = require('../radar/hook-receiver.js');
const { normalizeEvent } = require('../radar/eventlog.js');
const { latestSurfaceEvent } = require('../sessions/detect.js');
const { createSessionRoutes } = require('../sessions/routes.js');

test('D280: receiver records TMUX_PANE + socket when there is no surface id', () => {
  const env = { TMUX: '/tmp/s/default,123,0', TMUX_PANE: '%7', CMUX_TAB_ID: 'T-stale' };
  assert.equal(cmuxIdentity(env).surfaceId, '');
  assert.deepEqual(tmuxPaneOf(env), { tmuxPane: '%7', tmuxSocket: '/tmp/s/default' });
  assert.deepEqual(tmuxPaneOf({}), {}, 'not in tmux: nothing');
  assert.deepEqual(tmuxPaneOf({ TMUX: '/tmp/s,1,0', TMUX_PANE: 'bad' }), {});
});

test('D280: a real CMUX_SURFACE_ID wins (identity output unchanged)', () => {
  const id = cmuxIdentity({ CMUX_SURFACE_ID: 'S1', TMUX: '/tmp/s/default,1,0', TMUX_PANE: '%1' });
  assert.equal(id.surfaceId, 'S1');
  assert.equal(id.tmuxPane, undefined);
});

test('D280: the event log keeps tmuxPane/tmuxSocket only without a surface id, and only a %N pane', () => {
  const base = { session_id: 'x', hook_event_name: 'Stop', ts: 5 };
  const a = normalizeEvent({ ...base, tmuxPane: '%3', tmuxSocket: '/tmp/s' }, 5);
  assert.deepEqual([a.tmuxPane, a.tmuxSocket], ['%3', '/tmp/s']);
  assert.equal(normalizeEvent({ ...base, tmuxPane: '%3', tmuxSocket: '/tmp/s', surfaceId: 'S1' }, 5).tmuxPane, undefined);
  assert.equal(normalizeEvent({ ...base, tmuxPane: 'x; rm', tmuxSocket: '/tmp/s' }, 5).tmuxPane, undefined);
});

test('D280: latestSurfaceEvent matches an id-less event by the pane\'s tmux panes', async () => {
  const now = Date.now();
  const events = [{ ts: now, event: 'Stop', tmuxPane: '%3', tmuxSocket: '/tmp/s' }, { ts: now, event: 'Stop', tmuxPane: '%3', tmuxSocket: '/tmp/other' }];
  const deps = { now: () => now, readEvents: async () => ({ events, more: false }) };
  const hit = await latestSurfaceEvent({ id: 'S1', tmuxPanes: new Set(['/tmp/s|%3']) }, deps);
  assert.equal(hit.tmuxSocket, '/tmp/s');
  assert.equal(await latestSurfaceEvent({ id: 'S1' }, deps), null, 'no tmux panes on the surface: no guess');
});

test('D280: a cmux pane whose tmux session logs id-less events shows as the agent', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd280-')));
  const r = createSessionRoutes({
    machineId: 'mini', backend: 'cmux', home, listSnapshotMs: 0,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'S1', ref: 'surface:1', title: 'tab', type: 'terminal' }] }],
    // the tmux session still records the pane it was attached from (ownerOf); the claude env does not
    procSnapshot: async () => ({ table: [], sessions: [{ socket: '/tmp/s', name: 'm-chief', panes: [{ id: '%3' }], surfaceId: 'S1', clientPids: [] }] }),
    readEvents: async () => ({ events: [{ ts: Date.now(), event: 'UserPromptSubmit', tmuxPane: '%3', tmuxSocket: '/tmp/s' }], more: false }),
  });
  const kind = await new Promise((resolve) => {
    let code = 0;
    r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve(code === 200 ? JSON.parse(b).sessions[0].kind : `http_${code}`) }, new URL('http://x/cmux/sessions'));
  });
  assert.equal(kind, 'claude');
});
