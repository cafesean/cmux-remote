'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSidebarModel, pickLandingTab, KEYS } = require('../public/sidebar.js');

const memStore = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), raw: m }; };
const tab = (id, status, extra) => Object.assign({ id, ref: 'surface:' + id, title: 't-' + id, type: 'terminal', pane: 'P' + id, status }, extra || {});
const fleet = (...machines) => ({ at: 1, machines });
const mac = (id, tabs, ok = true) => ok
  ? { id, label: 'Mac ' + id, ok: true, workspaces: [{ ref: 'workspace:' + id, id: 'W' + id, title: 'ws-' + id, selected: true, tabs }] }
  : { id, label: 'Mac ' + id, ok: false, error: 'bridge_unreachable', workspaces: [] };
const off = { machine: 'a', surfaceId: null, visible: true };

test('Needs input is waiting; Running is running; anything else idle and not listed', () => {
  const m = createSidebarModel({ store: memStore() });
  const s = m.beat(fleet(mac('a', [tab('1', 'Needs input'), tab('2', 'Running'), tab('3', '')])), off, 1000);
  const ws = s.machines[0].workspaces[0];
  assert.deepEqual(ws.tabs.map((t) => [t.id, t.state]), [['1', 'waiting'], ['2', 'running']]);
  assert.equal(ws.state, 'waiting'); assert.equal(ws.count, 1);
  assert.equal(s.machines[0].state, 'waiting'); assert.equal(s.machines[0].count, 1);
  assert.deepEqual(s.totals, { waiting: 1, done: 0 });
});

test('Running → idle while OFF screen becomes done; ON screen it does not', () => {
  const m = createSidebarModel({ store: memStore() });
  m.beat(fleet(mac('a', [tab('1', 'Running'), tab('2', 'Running')])), off, 1000);
  const s = m.beat(fleet(mac('a', [tab('1', ''), tab('2', '')])), { machine: 'a', surfaceId: '2', visible: true }, 2000);
  assert.deepEqual(s.machines[0].workspaces[0].tabs.map((t) => [t.id, t.state]), [['1', 'done']]);
  assert.deepEqual(s.totals, { waiting: 0, done: 1 });
});

test('a background page counts as off screen', () => {
  const m = createSidebarModel({ store: memStore() });
  m.beat(fleet(mac('a', [tab('1', 'Running')])), off, 1000);
  const s = m.beat(fleet(mac('a', [tab('1', '')])), { machine: 'a', surfaceId: '1', visible: false }, 2000);
  assert.equal(s.machines[0].workspaces[0].tabs[0].state, 'done');
});

test('done clears when the tab comes on screen, and via markSeen', () => {
  const m = createSidebarModel({ store: memStore() });
  m.beat(fleet(mac('a', [tab('1', 'Running'), tab('2', 'Running')])), off, 1000);
  m.beat(fleet(mac('a', [tab('1', ''), tab('2', '')])), off, 2000);
  assert.equal(m.snapshot().totals.done, 2);
  const s = m.beat(fleet(mac('a', [tab('1', ''), tab('2', '')])), { machine: 'a', surfaceId: '1', visible: true }, 3000);
  assert.deepEqual(s.machines[0].workspaces[0].tabs.map((t) => t.id), ['2']);
  m.markSeen('a', '2');
  assert.equal(m.snapshot().totals.done, 0);
});

test('memory survives a relaunch: Running before, idle after, still done', () => {
  const store = memStore();
  createSidebarModel({ store }).beat(fleet(mac('a', [tab('1', 'Running')])), off, 1000);
  const again = createSidebarModel({ store });
  const s = again.beat(fleet(mac('a', [tab('1', '')])), off, 2000);
  assert.equal(s.machines[0].workspaces[0].tabs[0].state, 'done');
  assert.ok(JSON.parse(store.get(KEYS.unseen)).includes('a|1'));
});

test('an unreachable machine contributes no rows but keeps its label and error', () => {
  const m = createSidebarModel({ store: memStore() });
  const s = m.beat(fleet(mac('a', [tab('1', 'Needs input')]), mac('b', [], false)), off, 1000);
  assert.equal(s.machines[1].ok, false); assert.equal(s.machines[1].error, 'bridge_unreachable');
  assert.deepEqual(s.machines[1].workspaces, []); assert.equal(s.machines[1].label, 'Mac b');
  assert.deepEqual(s.totals, { waiting: 1, done: 0 });
});

test('memory is pruned only on a COMPLETE fleet, and capped at 200', () => {
  const store = memStore();
  const m = createSidebarModel({ store });
  m.beat(fleet(mac('a', [tab('1', 'Running')]), mac('b', [tab('9', 'Running')])), off, 1000);
  m.beat(fleet(mac('a', [tab('1', '')]), mac('b', [], false)), off, 2000);          // b unreachable: partial view
  assert.ok(JSON.parse(store.get(KEYS.seen)).includes('b|9'), 'b|9 kept while b is unreachable');
  m.beat(fleet(mac('a', [tab('1', '')]), mac('b', [])), off, 3000);                 // complete: tab 9 is gone
  assert.ok(!JSON.parse(store.get(KEYS.seen)).includes('b|9'));
  const many = Array.from({ length: 250 }, (_, i) => tab(String(i), 'Running'));
  m.beat(fleet(mac('a', many)), off, 4000);
  assert.equal(JSON.parse(store.get(KEYS.seen)).length, 200);
});

test('nextTarget walks waiting tabs in fleet order, then done ones, and wraps', () => {
  const m = createSidebarModel({ store: memStore() });
  m.beat(fleet(mac('a', [tab('1', 'Running'), tab('2', 'Needs input')]), mac('b', [tab('3', 'Needs input')])), off, 1000);
  m.beat(fleet(mac('a', [tab('1', ''), tab('2', 'Needs input')]), mac('b', [tab('3', 'Needs input')])), off, 2000);  // 1 → done
  assert.deepEqual(m.nextTarget(null), { machine: 'a', workspaceRef: 'workspace:a', surfaceId: '2', state: 'waiting' });
  assert.equal(m.nextTarget({ machine: 'a', surfaceId: '2' }).surfaceId, '3');
  assert.equal(m.nextTarget({ machine: 'b', surfaceId: '3' }).surfaceId, '1', 'then the done one');
  assert.equal(m.nextTarget({ machine: 'a', surfaceId: '1' }).surfaceId, '2', 'wraps');
  assert.equal(createSidebarModel({ store: memStore() }).nextTarget(null), null);
});

test('stale after 15s without a good beat; a failed beat does not reset it', () => {
  const m = createSidebarModel({ store: memStore() });
  m.beat(fleet(mac('a', [])), off, 1000);
  assert.equal(m.snapshot(10000).stale, false);
  assert.equal(m.beatFailed(17000).stale, true);
  assert.equal(m.beat(fleet(mac('a', [])), off, 18000).stale, false);
});

test('pickLandingTab prefers waiting, then done, then running, then the tab in front', () => {
  const tabs = [tab('1', ''), tab('2', '', { inPane: true }), tab('3', 'Running'), tab('4', ''), tab('5', ''), { id: 'b', type: 'browser' }];
  assert.equal(pickLandingTab(tabs, { 3: 'running', 4: 'done', 5: 'waiting' }).id, '5');
  assert.equal(pickLandingTab(tabs, { 3: 'running', 4: 'done' }).id, '4');
  assert.equal(pickLandingTab(tabs, { 3: 'running' }).id, '3');
  assert.equal(pickLandingTab(tabs, {}).id, '2');
  assert.equal(pickLandingTab([{ id: 'b', type: 'browser' }], {}), null);
});
