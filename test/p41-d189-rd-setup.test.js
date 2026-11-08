'use strict';
// p41 D189 — Remote Desktop setup: TCC probe parsing, the `screen` capability shape, cache/fresh/remind,
// the real spawn path against a fake osascript, and the /api/sessions relay of `screen` per machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRdSetup, parseProbe, buildStatus, LIMITS, SETTINGS_URL, JXA_PERMS } = require('../lib/rd-setup');
const { createSessionsProxy } = require('../lib/sessions-proxy');

test('parseProbe: good JSON -> per-permission booleans; junk -> null', () => {
  assert.deepStrictEqual(parseProbe('{"screenRecording":true,"accessibility":false}\n'), { 'screen-recording': true, accessibility: false });
  assert.strictEqual(parseProbe(''), null);
  assert.strictEqual(parseProbe('not json'), null);
  assert.strictEqual(parseProbe('{"screenRecording":"yes","accessibility":true}'), null);
});

test('probe script never asks: no CGRequest / prompt option', () => {
  assert.match(JXA_PERMS, /CGPreflightScreenCaptureAccess/);
  assert.match(JXA_PERMS, /AXIsProcessTrusted\(\)/);
  assert.doesNotMatch(JXA_PERMS, /CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|Prompt/);
});

test('buildStatus: shape, binary per permission, exact settings URLs, ready only when all granted', () => {
  const s = buildStatus({ 'screen-recording': true, accessibility: false }, { binary: '/opt/node', view: true, control: true, at: 5 });
  assert.strictEqual(s.ready, false);
  assert.deepStrictEqual(s.perms, [
    { id: 'screen-recording', granted: true, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', binary: '/opt/node' },
    { id: 'accessibility', granted: false, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', binary: '/opt/node' },
  ]);
  assert.strictEqual(buildStatus({ 'screen-recording': true, accessibility: true }, { binary: 'b' }).ready, true);
  const unknown = buildStatus(null, { binary: 'b' });
  assert.strictEqual(unknown.ready, null);
  assert.deepStrictEqual(unknown.perms, []);
  assert.strictEqual(SETTINGS_URL.accessibility.endsWith('Privacy_Accessibility'), true);
});

test('status: cached for RD_PROBE_TTL_MS, fresh re-probes after the floor, off-mac null', async () => {
  let t = 1000, calls = 0, g = { 'screen-recording': false, accessibility: false };
  const rd = createRdSetup({ platform: 'darwin', now: () => t, binary: 'B', runProbe: async () => { calls++; return g; } });
  assert.strictEqual(rd.cached(), undefined);   // nothing yet (kicks a probe)
  let s = await rd.status();
  assert.strictEqual(calls, 1); assert.strictEqual(s.ready, false);
  g = { 'screen-recording': true, accessibility: true };
  t += 1000; s = await rd.status(); assert.strictEqual(calls, 1);          // cached
  t += 1500; s = await rd.status({ fresh: true }); assert.strictEqual(calls, 2); assert.strictEqual(s.ready, true);   // >= 2 s floor
  t += 500; await rd.status({ fresh: true }); assert.strictEqual(calls, 2);    // under the floor
  t += LIMITS.RD_PROBE_TTL_MS; await rd.status(); assert.strictEqual(calls, 3);
  assert.strictEqual(await createRdSetup({ platform: 'linux', runProbe: async () => g }).status(), null);
  assert.strictEqual(LIMITS.RD_PROBE_TTL_MS <= 30000, true);
});

test('remind: flag shown until TTL, cleared by clear or once everything is granted', async () => {
  let t = 1000, g = { 'screen-recording': false, accessibility: true };
  const rd = createRdSetup({ platform: 'darwin', now: () => t, runProbe: async () => g });
  rd.setRemind(false);
  assert.strictEqual((await rd.status()).remindAt, 1000);
  t += LIMITS.RD_REMIND_TTL_MS; assert.strictEqual((await rd.status()).remindAt, undefined);
  rd.setRemind(false); assert.strictEqual((await rd.status()).remindAt, t);
  rd.setRemind(true); assert.strictEqual((await rd.status()).remindAt, undefined);
  rd.setRemind(false); g = { 'screen-recording': true, accessibility: true }; t += LIMITS.RD_PROBE_FRESH_MIN_MS;
  const s = await rd.status({ fresh: true });
  assert.strictEqual(s.ready, true);
  assert.strictEqual((await rd.status()).remindAt, undefined);
});

test('default probe spawns osascript with the script on stdin (fake binary)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd189-'));
  const fake = path.join(dir, 'osascript');
  fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = "-l" ] || exit 2\ncat >/dev/null\necho \'{"screenRecording":true,"accessibility":false}\'\n', { mode: 0o755 });
  const rd = createRdSetup({ platform: 'darwin', env: { SCREEN_OSASCRIPT_BIN: fake }, binary: 'B' });
  const s = await rd.status();
  assert.deepStrictEqual(s.perms.map((p) => [p.id, p.granted]), [['screen-recording', true], ['accessibility', false]]);
  const bad = createRdSetup({ platform: 'darwin', env: { SCREEN_OSASCRIPT_BIN: path.join(dir, 'missing') } });
  assert.strictEqual((await bad.status()).ready, null);   // spawn failure = unknown, never a throw
});

test('/api/sessions relays each machine\'s screen status; older bridge -> no field', async () => {
  const machines = [{ id: 'max', label: 'Max', secret: 's' }, { id: 'mini', label: 'Mini', secret: 's' }];
  const screen = { ready: false, perms: [{ id: 'accessibility', granted: false }] };
  const upstream = async (m) => ({ ok: true, status: 200, json: async () => (m.id === 'max' ? { machineId: 'max', sessions: [], screen } : { machineId: 'mini', sessions: [] }) });
  const px = createSessionsProxy({ machines, upstream, accessHeaders: () => ({}), findMachine: (id) => machines.find((m) => m.id === id) });
  let out = null;
  const res = { writeHead() {}, end(b) { out = JSON.parse(b); } };
  await px.handle({ method: 'GET' }, res, new URL('http://x/api/sessions'));
  assert.deepStrictEqual(out.machines.find((m) => m.id === 'max').screen, screen);
  assert.strictEqual('screen' in out.machines.find((m) => m.id === 'mini'), false);
});
