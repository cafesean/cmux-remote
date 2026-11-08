'use strict';
// p41 D189 — Remote Desktop setup: TCC probe parsing, the `screen` capability shape, cache/fresh/remind,
// the real spawn path against a fake osascript, and the /api/sessions relay of `screen` per machine.
// D189b — Screen Recording ground truth (other apps' window names in the bridge's spawn chain) and the
// rule that an observed capture only counts next to a passed truth check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRdSetup, parseProbe, buildStatus, LIMITS, SETTINGS_URL, JXA_PERMS } = require('../lib/rd-setup');
const { createSessionsProxy } = require('../lib/sessions-proxy');
const { createMacScreen } = require('../lib/mac-screen');

test('parseProbe: good JSON -> per-permission booleans + truth; junk -> null', () => {
  assert.deepStrictEqual(parseProbe('{"screenRecording":true,"accessibility":false}\n'), { 'screen-recording': true, accessibility: false, truth: null, windows: null, named: null });
  assert.strictEqual(parseProbe('{"screenRecording":false,"accessibility":true,"windows":7,"named":5}').truth, true);
  assert.strictEqual(parseProbe('{"screenRecording":true,"accessibility":true,"windows":7,"named":0}').truth, false);
  assert.strictEqual(parseProbe('{"screenRecording":false,"accessibility":true,"windows":0,"named":0}').truth, null);   // lock screen / empty desktop
  assert.strictEqual(parseProbe('{"screenRecording":false,"accessibility":true,"windows":null,"named":null}').truth, null);   // window list threw
  assert.strictEqual(parseProbe(''), null);
  assert.strictEqual(parseProbe('not json'), null);
  assert.strictEqual(parseProbe('{"screenRecording":"yes","accessibility":true}'), null);
});

test('probe script never asks: no CGRequest / prompt option / capture API', () => {
  assert.match(JXA_PERMS, /CGPreflightScreenCaptureAccess/);
  assert.match(JXA_PERMS, /AXIsProcessTrusted\(\)/);
  assert.match(JXA_PERMS, /CGWindowListCopyWindowInfo\(1,0\)/);   // D189b truth: on-screen-only window list, read-only
  assert.doesNotMatch(JXA_PERMS, /CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|Prompt|CGWindowListCreateImage|CGDisplayCreateImage/);
});

test('buildStatus: shape, binary per permission, exact settings URLs, ready only when all granted', () => {
  const s = buildStatus({ 'screen-recording': true, accessibility: false }, { binary: '/opt/node', view: true, control: true, at: 5 });
  assert.strictEqual(s.ready, false);
  assert.deepStrictEqual(s.perms, [
    { id: 'screen-recording', probe: true, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', binary: '/opt/node', granted: true, source: 'probe', truth: null },
    { id: 'accessibility', probe: false, settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', binary: '/opt/node', granted: false, source: 'probe' },
  ]);
  assert.strictEqual(buildStatus({ 'screen-recording': true, accessibility: true }, { binary: 'b' }).ready, true);
  const unknown = buildStatus(null, { binary: 'b' });
  assert.strictEqual(unknown.ready, null);
  assert.deepStrictEqual(unknown.perms, []);
  assert.strictEqual(SETTINGS_URL.accessibility.endsWith('Privacy_Accessibility'), true);
});

test('truth decides Screen Recording: names visible = granted though preflight says no; hidden = missing though preflight says yes', () => {
  const a = buildStatus({ 'screen-recording': false, accessibility: true, truth: true }, { binary: 'B' });
  assert.deepStrictEqual([a.perms[0].granted, a.perms[0].source, a.perms[0].truth, a.perms[0].probe], [true, 'truth', true, false]);
  assert.strictEqual(a.ready, true);
  const b = buildStatus({ 'screen-recording': true, accessibility: true, truth: false }, { binary: 'B', observed: { capture: Date.now() }, truthOkAt: Date.now() });
  assert.deepStrictEqual([b.perms[0].granted, b.perms[0].source, b.perms[0].truth], [false, 'truth', false]);
  assert.strictEqual(b.ready, false);
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

test('observed: input/AX counts; a capture counts ONLY next to a passed truth check (wallpaper / lock frame proves nothing)', () => {
  const now = 1_000_000;
  const no = { 'screen-recording': false, accessibility: false, truth: null };
  // max case: lock-screen shot, no truth check ever passed -> still missing
  const lock = buildStatus(no, { binary: 'B', observed: { capture: now - 1000, input: now - 2000 }, truthOkAt: 0, now });
  assert.deepStrictEqual(lock.perms.map((p) => [p.id, p.granted, p.source]), [['screen-recording', false, 'probe'], ['accessibility', true, 'observed']]);
  assert.strictEqual(lock.ready, false);
  // a truth check passed 10 s before that capture -> the capture counts
  const ok = buildStatus(no, { binary: 'B', observed: { capture: now - 1000 }, truthOkAt: now - 11000, now });
  assert.deepStrictEqual([ok.perms[0].granted, ok.perms[0].source], [true, 'observed']);
  // truth passed long before the capture -> does not count
  const far = buildStatus(no, { binary: 'B', observed: { capture: now - 1000 }, truthOkAt: now - 1000 - LIMITS.RD_PROBE_TTL_MS - 1, now });
  assert.strictEqual(far.perms[0].granted, false);
  // observations too old: the probe decides
  const old = buildStatus(no, { binary: 'B', observed: { capture: now - LIMITS.RD_OBSERVED_MS, input: now - LIMITS.RD_OBSERVED_MS }, truthOkAt: now - LIMITS.RD_OBSERVED_MS, now });
  assert.deepStrictEqual(old.perms.map((p) => p.granted), [false, false]);
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

// Fixture: fake osascript answers the probe from probe.json; input scripts answer ok; capture writes a JPEG.
function msFixture(probeJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd189-ms-'));
  const w = (n, body) => { const f = path.join(dir, n); fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); return f; };
  fs.writeFileSync(path.join(dir, 'probe.json'), probeJson);
  const vars = {
    SCREEN_VIEW: '1', SCREEN_CONTROL: '1',
    SCREEN_OSASCRIPT_BIN: w('osascript', `in=$(cat); case "$in" in *screenRecording*) cat "${dir}/probe.json";; *) echo ok;; esac`),
    SCREEN_SCREENCAPTURE_BIN: w('screencapture', 'for a; do last="$a"; done; printf "\\377\\330\\377\\340abcdefgh" > "$last"'),
    SCREEN_SIPS_BIN: w('sips', 'prev=""; for a; do if [ "$prev" = "--out" ]; then o="$a"; fi; [ "$a" = "--out" ] && src="$p2"; p2="$a"; prev="$a"; done; cp "$src" "$o"'),
    SCREEN_CAFFEINATE_BIN: w('caffeinate', 'exit 0'),
  };
  return { dir, vars };
}
const pastFloor = () => new Promise((r) => setTimeout(r, LIMITS.RD_PROBE_FRESH_MIN_MS + 50));

test('mac-screen + rd-setup: lock-screen shot (truth null) never flips Screen Recording; input still observed', async () => {
  const { vars } = msFixture('{"screenRecording":false,"accessibility":false,"windows":0,"named":0}');
  const ms = createMacScreen({ env: vars, host: '127.0.0.1', log: () => {} });
  const rd = createRdSetup({ platform: 'darwin', env: vars, binary: 'B', observed: () => ms.observed() });
  assert.strictEqual((await rd.status()).ready, false);
  assert.strictEqual((await ms.shot('1')).status, 200);   // a frame came back (wallpaper / lock screen)
  assert.strictEqual((await ms.input('tap', { fx: 0.5, fy: 0.5 })).status, 200);
  assert.ok(ms.observed().capture > 0 && ms.observed().input > 0);
  await pastFloor();
  const s = await rd.status({ fresh: true });
  assert.deepStrictEqual(s.perms.map((p) => [p.id, p.granted, p.source]), [['screen-recording', false, 'probe'], ['accessibility', true, 'observed']]);
  assert.strictEqual(s.ready, false);
});

test('mac-screen + rd-setup: window names visible in the bridge chain = granted (source truth); hidden = missing', async () => {
  const fx = msFixture('{"screenRecording":false,"accessibility":true,"windows":6,"named":4}');
  const rd = createRdSetup({ platform: 'darwin', env: fx.vars, binary: 'B' });
  let s = await rd.status();
  assert.deepStrictEqual([s.perms[0].granted, s.perms[0].source, s.perms[0].truth], [true, 'truth', true]);
  assert.strictEqual(s.ready, true);
  fs.writeFileSync(path.join(fx.dir, 'probe.json'), '{"screenRecording":true,"accessibility":true,"windows":6,"named":0}');
  await pastFloor();
  s = await rd.status({ fresh: true });
  assert.deepStrictEqual([s.perms[0].granted, s.perms[0].source, s.perms[0].truth, s.perms[0].probe], [false, 'truth', false, true]);
  assert.strictEqual(s.ready, false);
});

test('mac-screen + rd-setup: a capture right after a passed truth check still counts when the screen locks (truth null)', async () => {
  const fx = msFixture('{"screenRecording":false,"accessibility":true,"windows":6,"named":4}');
  const ms = createMacScreen({ env: fx.vars, host: '127.0.0.1', log: () => {} });
  const rd = createRdSetup({ platform: 'darwin', env: fx.vars, binary: 'B', observed: () => ms.observed() });
  assert.strictEqual((await rd.status()).ready, true);   // truth passed
  assert.strictEqual((await ms.shot('1')).status, 200);
  fs.writeFileSync(path.join(fx.dir, 'probe.json'), '{"screenRecording":false,"accessibility":true,"windows":0,"named":0}');   // locked now
  await pastFloor();
  const s = await rd.status({ fresh: true });
  assert.deepStrictEqual([s.perms[0].granted, s.perms[0].source, s.perms[0].truth], [true, 'observed', null]);
});
