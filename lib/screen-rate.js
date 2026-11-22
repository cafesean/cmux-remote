'use strict';
// Video Remote Desktop: the server-owned rate controller for the one viewer (§5.2, §12.3). Pure: no timers, no I/O.
// Every tick (500 ms) it reads what arrived since the last tick:
//   - drops: client Stats {fps, dropped} (per second) and the server's own admission drops vs frames sent;
//   - latency: server ack round trip (send -> cumulative ack), client g2gMsP50 and client rttMs (ping/pong), each
//     compared with its own minimum over the last 10 s.
// Congested (drops > 10 %, or any latency > 1.5 x its 10 s minimum): bitrate x 0.7; at the floor for that fps,
// fps 60 -> 30 -> 15; then resolution x 0.75 (IDR). Clean for 3 s: bitrate x 1.1 up to the cap; then fps up; then
// resolution up (IDR). Ranges: start 4 Mbps at 30 fps at the client's pixel size (capped at native); floor 300 kbps
// at 15 fps; cap 20 Mbps at 60 fps (floor and cap scale with fps).
const RATE = Object.freeze({
  START_KBPS: 4000, START_FPS: 30, FLOOR_KBPS_15: 300, CAP_KBPS_60: 20000,
  DOWN: 0.7, UP: 1.1, RES: 0.75, MIN_W: 320,
  TICK_MS: 500, CLEAN_MS: 3000, MIN_WINDOW_MS: 10000, DROP_FRAC: 0.10, LAT_X: 1.5,
});
const FPS_LADDER = [15, 30, 60];
const floorKbps = (fps) => (RATE.FLOOR_KBPS_15 * fps) / 15;
const capKbps = (fps) => (RATE.CAP_KBPS_60 * fps) / 60;
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const fin = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function createRateController(o = {}) {
  const now = o.now || Date.now;
  let ladder = [], base = { w: 0, h: 0 }, kbps = RATE.START_KBPS, fps = RATE.START_FPS, ri = 0;
  let cleanSince = now(), steps = 0;
  let stFps = 0, stDropped = 0, sent = 0, drops = 0;
  const lat = { ack: [], g2g: [], rtt: [] };    // [{t, v}] over the last 10 s
  const fresh = { ack: [], g2g: [], rtt: [] };  // values since the last tick

  function limits(maxW, maxH, maxFps) {
    const nw = o.nativeW, nh = o.nativeH;
    const k = Math.min(1, (maxW || nw) / nw, (maxH || nh) / nh);
    base = { w: even(nw * k), h: even(nh * k) };
    ladder = FPS_LADDER.filter((f) => f <= (maxFps || 60));
    if (!ladder.includes(fps)) fps = ladder[ladder.length - 1];
    kbps = Math.min(capKbps(fps), Math.max(floorKbps(fps), kbps));
  }
  limits(o.maxW, o.maxH, o.maxFps);
  fps = Math.min(RATE.START_FPS, ladder[ladder.length - 1]);
  kbps = Math.min(capKbps(fps), RATE.START_KBPS);

  const size = (i) => ({ w: even(base.w * Math.pow(RATE.RES, i)), h: even(base.h * Math.pow(RATE.RES, i)) });
  const rate = () => ({ kbps: Math.round(kbps), fps, ...size(ri) });
  const step = (reason, idr) => { steps++; return { ...rate(), reason, idr: !!idr }; };

  function note(kind, v) { if (!fin(v)) return; lat[kind].push({ t: now(), v }); fresh[kind].push(v); }
  function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; }
  function congested() {
    const t = now();
    let late = false;
    for (const k of Object.keys(lat)) {
      while (lat[k].length && t - lat[k][0].t > RATE.MIN_WINDOW_MS) lat[k].shift();
      if (!fresh[k].length || !lat[k].length) continue;
      const min = Math.min(...lat[k].map((x) => x.v));
      if (min > 0 && median(fresh[k]) > RATE.LAT_X * min) late = true;
      fresh[k] = [];
    }
    const cFrac = stFps + stDropped > 0 ? stDropped / (stFps + stDropped) : 0;
    const sFrac = sent + drops > 0 ? drops / (sent + drops) : 0;
    stFps = stDropped = sent = drops = 0;
    return late || cFrac > RATE.DROP_FRAC || sFrac > RATE.DROP_FRAC;
  }
  function down() {
    const floor = floorKbps(fps);
    if (kbps > floor) { kbps = Math.max(floor, kbps * RATE.DOWN); return step('congested'); }
    const i = ladder.indexOf(fps);
    if (i > 0) { fps = ladder[i - 1]; kbps = Math.min(capKbps(fps), Math.max(floorKbps(fps), kbps)); return step('congested'); }
    if (size(ri + 1).w >= RATE.MIN_W) { ri++; return step('congested', true); }
    return null;                                   // at the floor already
  }
  function up() {
    const cap = capKbps(fps);
    if (kbps < cap) { kbps = Math.min(cap, kbps * RATE.UP); return step('clean'); }
    const i = ladder.indexOf(fps);
    if (i < ladder.length - 1) { fps = ladder[i + 1]; return step('clean'); }
    if (ri > 0) { ri--; return step('clean', true); }
    return null;                                   // at the cap
  }
  return {
    rate,
    get kbps() { return Math.round(kbps); },
    get steps() { return steps; },
    /** client {t:"stats"} body */
    onStats(m) {
      if (!m) return;
      if (fin(m.fps) && fin(m.dropped)) { stFps += m.fps; stDropped += m.dropped; }
      note('g2g', m.g2gMsP50); note('rtt', m.rttMs);
    },
    noteAckRtt(ms) { note('ack', ms); },
    noteSent() { sent++; },
    noteDrop() { drops++; },
    /** client Config: new size / fps limits; returns a step when the rate changed */
    limits(maxW, maxH, maxFps) { const b = JSON.stringify(rate()); limits(maxW, maxH, maxFps); return JSON.stringify(rate()) === b ? null : step('config', true); },
    /** oversize IDR (§16.1): resolution x 0.75 now, regardless of the clean/congested timers */
    downscale() { ri++; cleanSince = now(); return step('downscale', true); },
    /** every TICK_MS; returns the step taken or null */
    tick() {
      const t = now();
      if (congested()) { cleanSince = t; return down(); }
      if (t - cleanSince >= RATE.CLEAN_MS) { cleanSince = t; return up(); }
      return null;
    },
  };
}

module.exports = { createRateController, RATE, floorKbps, capKbps };
