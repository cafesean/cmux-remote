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
const { createMacScreen } = require('../lib/mac-screen');

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
    { id: 'screen-recording', granted: true, source: 'probe', probe: true, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', binary: '/opt/node' },
    { id: 'accessibility', granted: false, source: 'probe', probe: false, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', binary: '/opt/node' },
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

test('observed beats the probe: a recent real capture / trusted input counts as granted (source observed)', () => {
  const now = 1_000_000;
  const no = { 'screen-recording': false, accessibility: false };
  const s = buildStatus(no, { binary: 'B', observed: { capture: now - 1000, input: now - 2000 }, now });
  assert.strictEqual(s.ready, true);
  assert.deepStrictEqual(s.perms.map((p) => [p.id, p.granted, p.source, p.probe]), [['screen-recording', true, 'observed', false], ['accessibility', true, 'observed', false]]);
  const old = buildStatus(no, { binary: 'B', observed: { capture: now - LIMITS.RD_OBSERVED_MS, input: 0 }, now });
  assert.strictEqual(old.ready, false);   // too old: the probe decides again
  assert.deepStrictEqual(old.perms.map((p) => p.source), ['probe', 'probe']);
  const both = buildStatus({ 'screen-recording': true, accessibility: false }, { binary: 'B', observed: { capture: now - 1, input: 0 }, now });
  assert.strictEqual(both.perms[0].source, 'probe');   // probe already said yes
});

test('fail open: probe junk, non-zero exit, or timeout -> ready null (unknown), never false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd189-fo-'));
  const mk = (n, body) => { const f = path.join(dir, n); fs.writeFileSync(f, '#!/bin/sh\ncat >/dev/null\n' + body + '\n', { mode: 0o755 }); return f; };
  for (const [bin, opts] of [[mk('junk', 'echo "hello"'), {}], [mk('exit', 'exit 3'), {}], [mk('slow', 'sleep 3; echo \'{"screenRecording":false,"accessibility":false}\''), { timeoutMs: 300 }]]) {
    const rd = createRdSetup({ platform: 'darwin', env: { SCREEN_OSASCRIPT_BIN: bin }, binary: 'B', ...opts });
    const s = await rd.status();
    assert.strictEqual(s.ready, null, bin);
    assert.deepStrictEqual(s.perms, []);
  }
  // a thrown runProbe too
  assert.strictEqual((await createRdSetup({ platform: 'darwin', runProbe: async () => { throw new Error('x'); } }).status()).ready, null);
});

test('mac-screen records real successes; rd-setup turns a probe "missing" into observed granted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd189-ms-'));
  const w = (n, body) => { const f = path.join(dir, n); fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); return f; };
  const env = {
    SCREEN_VIEW: '1', SCREEN_CONTROL: '1',
    // probe says both missing (wrong attribution); input scripts answer ok (AXIsProcessTrusted passed in the real path)
    SCREEN_OSASCRIPT_BIN: w('osascript', 'in=$(cat); case "$in" in *screenRecording*) echo \'{"screenRecording":false,"accessibility":false}\';; *) echo ok;; esac'),
    SCREEN_SCREENCAPTURE_BIN: w('screencapture', 'for a; do last="$a"; done; printf "\\377\\330\\377\\340abcdefgh" > "$last"'),
    SCREEN_SIPS_BIN: w('sips', 'prev=""; for a; do if [ "$prev" = "--out" ]; then o="$a"; fi; [ "$a" = "--out" ] && src="$p2"; p2="$a"; prev="$a"; done; cp "$src" "$o"'),
    SCREEN_CAFFEINATE_BIN: w('caffeinate', 'exit 0'),
  };
  const ms = createMacScreen({ env, host: '127.0.0.1', log: () => {} });
  const rd = createRdSetup({ platform: 'darwin', env, binary: 'B', observed: () => ms.observed() });
  let s = await rd.status();
  assert.strictEqual(s.ready, false);
  assert.deepStrictEqual(ms.observed(), { capture: 0, input: 0 });
  const shot = await ms.shot('1');
  assert.strictEqual(shot.status, 200, JSON.stringify(shot.body).slice(0, 200));
  const tap = await ms.input('tap', { fx: 0.5, fy: 0.5 });
  assert.strictEqual(tap.status, 200);
  assert.ok(ms.observed().capture > 0 && ms.observed().input > 0);
  await new Promise((r) => setTimeout(r, LIMITS.RD_PROBE_FRESH_MIN_MS + 50));
  s = await rd.status({ fresh: true });
  assert.strictEqual(s.ready, true);
  assert.deepStrictEqual(s.perms.map((p) => [p.id, p.granted, p.source, p.probe]), [['screen-recording', true, 'observed', false], ['accessibility', true, 'observed', false]]);
});
