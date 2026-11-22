'use strict';
// Video Remote Desktop: the server-owned rate controller (lib/screen-rate.js) and its wiring in lib/screen-ws.js.
const test = require('node:test');
const assert = require('node:assert');
const { createRateController, RATE } = require('../lib/screen-rate');

function ctl(o = {}) {
  let t = 0;
  const rc = createRateController({ now: () => t, maxFps: 60, nativeW: 2560, nativeH: 1600, maxW: 1920, maxH: 1200, ...o });
  return { rc, adv: (ms) => { t += ms; }, at: () => t };
}
const clean = (rc, adv, ms) => { const steps = []; for (let i = 0; i < ms / RATE.TICK_MS; i++) { adv(RATE.TICK_MS); rc.onStats({ fps: 30, dropped: 0 }); const s = rc.tick(); if (s) steps.push(s); } return steps; };

test('start: 4 Mbps at 30 fps at the client size capped at native (aspect kept)', () => {
  const { rc } = ctl();
  assert.deepStrictEqual(rc.rate(), { kbps: 4000, fps: 30, w: 1920, h: 1200 });
  const small = ctl({ nativeW: 1280, nativeH: 800, maxW: 3000, maxH: 3000 }).rc;
  assert.deepStrictEqual(small.rate(), { kbps: 4000, fps: 30, w: 1280, h: 800 });
});

test('drops > 10 % step down x0.7; at the fps floor: fps 30 -> 15, then resolution x0.75', () => {
  const { rc, adv } = ctl();
  const bad = () => { adv(RATE.TICK_MS); rc.onStats({ fps: 20, dropped: 5 }); return rc.tick(); };   // 20 %
  const s1 = bad();
  assert.strictEqual(s1.kbps, 2800); assert.strictEqual(s1.fps, 30); assert.strictEqual(s1.reason, 'congested');
  let s; for (let i = 0; i < 10 && rc.rate().fps === 30; i++) s = bad();
  assert.strictEqual(rc.rate().fps, 15, 'fps stepped down at the 30 fps floor');
  assert.ok(rc.rate().kbps >= RATE.FLOOR_KBPS_15);
  for (let i = 0; i < 20 && rc.rate().w === 1920; i++) s = bad();
  assert.strictEqual(rc.rate().w, 1440); assert.strictEqual(rc.rate().h, 900);
  assert.strictEqual(s.idr, true, 'resolution step needs an IDR');
});

test('drops at 10 % or less are clean', () => {
  const { rc, adv } = ctl();
  adv(RATE.TICK_MS); rc.onStats({ fps: 27, dropped: 3 }); assert.strictEqual(rc.tick(), null);
});

test('RTT > 1.5x the 10 s minimum steps down (server ack RTT, client g2gMsP50, client rttMs)', () => {
  for (const feed of [(rc, v) => rc.noteAckRtt(v), (rc, v) => rc.onStats({ fps: 30, dropped: 0, g2gMsP50: v }), (rc, v) => rc.onStats({ fps: 30, dropped: 0, rttMs: v })]) {
    const { rc, adv } = ctl();
    feed(rc, 40); adv(RATE.TICK_MS); assert.strictEqual(rc.tick(), null);
    feed(rc, 59); adv(RATE.TICK_MS); assert.strictEqual(rc.tick(), null, '1.475x: clean');
    feed(rc, 61); adv(RATE.TICK_MS); const s = rc.tick();
    assert.ok(s && s.kbps === 2800, 'above 1.5x min -> step down');
  }
});

test('the RTT minimum is a 10 s window: an old low sample expires', () => {
  const { rc, adv } = ctl();
  rc.noteAckRtt(20); adv(RATE.TICK_MS); rc.tick();
  adv(11000); rc.noteAckRtt(100); rc.tick();
  adv(RATE.TICK_MS); rc.noteAckRtt(100); assert.strictEqual(rc.tick(), null, 'min is now 100');
});

test('clean 3 s: bitrate x1.1 up to the cap; then fps up; resolution is restored first (IDR)', () => {
  const { rc, adv } = ctl();
  assert.deepStrictEqual(clean(rc, adv, 2500), [], 'nothing before 3 s clean');
  const [up] = clean(rc, adv, 500);
  assert.strictEqual(up.kbps, 4400); assert.strictEqual(up.reason, 'clean');
  assert.deepStrictEqual(clean(rc, adv, 2500), [], 'each step needs a fresh 3 s');
  clean(rc, adv, 3000 * 12);
  assert.strictEqual(rc.rate().kbps <= 20000, true);
  assert.strictEqual(rc.rate().fps, 60, 'fps up after the 30 fps cap');
  const d = ctl(); d.rc.downscale();
  assert.strictEqual(d.rc.rate().w, 1440);
  const [r1] = clean(d.rc, d.adv, 3000);
  assert.strictEqual(r1.w, 1920, 'resolution back up first'); assert.strictEqual(r1.idr, true);
  clean(d.rc, d.adv, 3000 * 40);
  assert.strictEqual(d.rc.rate().w, 1920);
  assert.strictEqual(d.rc.rate().fps, 60);
  assert.strictEqual(d.rc.rate().kbps, 20000, 'cap 20 Mbps at 60 fps');
});

test('fps never above the client maxFps; floor 300 kbps at 15 fps', () => {
  const { rc, adv } = ctl({ maxFps: 30 });
  clean(rc, adv, 3000 * 30);
  assert.strictEqual(rc.rate().fps, 30);
  const f = ctl();
  for (let i = 0; i < 200; i++) { f.adv(RATE.TICK_MS); f.rc.onStats({ fps: 1, dropped: 9 }); f.rc.tick(); }
  assert.strictEqual(f.rc.rate().fps, 15); assert.strictEqual(f.rc.rate().kbps, 300);
  assert.ok(f.rc.rate().w >= RATE.MIN_W);
});

test('server admission drops count as drops; a congested tick resets the clean timer', () => {
  const { rc, adv } = ctl();
  for (let i = 0; i < 4; i++) rc.noteSent(); rc.noteDrop();          // 20 %
  adv(RATE.TICK_MS); assert.strictEqual(rc.tick().kbps, 2800);
  assert.deepStrictEqual(clean(rc, adv, 2500), []);
});

test('downscale: x0.75 then x0.56 of the client size', () => {
  const { rc } = ctl();
  assert.strictEqual(rc.downscale().w, 1440);
  assert.strictEqual(rc.downscale().w, 1080);
  assert.strictEqual(rc.rate().h, 676, 'even sizes for the encoder');
});

// Sharpness regressions: a stream that stepped resolution down must get it back once the network is clean.
const congest = (rc, adv) => { adv(RATE.TICK_MS); rc.onStats({ fps: 20, dropped: 5 }); return rc.tick(); };

test('after congestion clears the controller returns to full resolution within N clean ticks', () => {
  const { rc, adv } = ctl();
  for (let i = 0; i < 200 && rc.resSteps < 2; i++) congest(rc, adv);
  assert.strictEqual(rc.resSteps, 2, 'two resolution steps down');
  assert.strictEqual(rc.rate().w, 1080);
  const perStep = RATE.CLEAN_MS / RATE.TICK_MS;
  let ticks = 0;
  while (rc.rate().w !== 1920 && ticks < perStep * 2) { clean(rc, adv, RATE.TICK_MS); ticks++; }
  assert.strictEqual(rc.rate().w, 1920, 'full size back after ' + ticks + ' clean ticks');
  assert.ok(ticks <= perStep * 2, 'within one clean window per resolution step');
  assert.strictEqual(rc.rate().h, 1200);
});

test('oversize IDR downscale is not sticky: the next clean window restores the size', () => {
  const { rc, adv } = ctl();
  rc.downscale(); rc.downscale();
  assert.strictEqual(rc.rate().w, 1080);
  clean(rc, adv, 6000);
  assert.strictEqual(rc.rate().w, 1440, 'x0.75 back once the (6 s) hold of the second step ends');
  clean(rc, adv, 3000);
  assert.strictEqual(rc.rate().w, 1920, 'next clean window: full size');
});

test('repeated oversize IDRs back off the size restore (no IDR churn), capped at 30 s', () => {
  const { rc, adv } = ctl();
  rc.downscale(); clean(rc, adv, 3000); assert.strictEqual(rc.resSteps, 0);
  rc.downscale(); clean(rc, adv, 3000); assert.strictEqual(rc.resSteps, 1, 'second oversize within 60 s holds 6 s');
  clean(rc, adv, 3000); assert.strictEqual(rc.resSteps, 0);
  for (let i = 0; i < 6; i++) rc.downscale();
  clean(rc, adv, 29500); assert.ok(rc.resSteps > 0, 'held');
  clean(rc, adv, 3000 * 8); assert.strictEqual(rc.resSteps, 0, 'hold capped at 30 s');
});

test('latency jitter within 20 ms of the minimum is clean (a fast link never looks congested)', () => {
  const { rc, adv } = ctl();
  rc.onStats({ fps: 30, dropped: 0, rttMs: 8 }); adv(RATE.TICK_MS); rc.tick();
  for (let i = 0; i < 6; i++) { rc.onStats({ fps: 30, dropped: 0, rttMs: 24 }); adv(RATE.TICK_MS); const st = rc.tick(); assert.ok(!st || st.reason === 'clean', '3x but +16 ms: clean'); }
  assert.strictEqual(rc.rate().kbps, 4400, 'stepped up after 3 s');
});

test('p43 floor: congestion and oversize IDRs never shrink the picture below RATE.MIN_W (640) wide', () => {
  assert.ok(RATE.MIN_W >= 640);
  const f = ctl();
  for (let i = 0; i < 200; i++) { f.adv(RATE.TICK_MS); f.rc.onStats({ fps: 1, dropped: 9 }); f.rc.tick(); }
  assert.ok(f.rc.rate().w >= 640, 'congested floor ' + f.rc.rate().w);
  for (let i = 0; i < 5; i++) f.rc.downscale();
  assert.ok(f.rc.rate().w >= 640, 'oversize floor ' + f.rc.rate().w);
});
