'use strict';
// p41 D222: how a browser-surface frame is resized + compressed. A client that knows its pane's
// device-pixel width sends it as `px`; the frame is then resampled to that width (never upscaled),
// clamped to PX_MIN..PX_MAX. A client that sends no px keeps the old longest-edge cap (LEGACY_MAX_DIM).
// Pure functions — bridge.js runs the screenshot and sips.
const LEGACY_MAX_DIM = 800;   // px, longest edge, clients without px (web stream, old app builds)
const PX_MIN = 600;
const PX_MAX = 2400;
const JPEG_Q = '80';          // settled frame (sips formatOptions 0-100)
const JPEG_Q_MOVING = '55';   // frames during a scroll/tap burst

// px query/body value -> integer in PX_MIN..PX_MAX, or null when absent/garbage (legacy path).
function parsePx(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(PX_MAX, Math.max(PX_MIN, n));
}

// PNG IHDR -> { w, h } or null (not a PNG / truncated).
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

// sips resize args for one frame. shrink=false (phone-viewport stream) never resamples.
// px set: resample to px wide only when the source is wider (sips would upscale otherwise).
// px unset: the legacy `-Z 800` longest-edge cap.
function resizeArgs({ shrink = true, px = null, src = null } = {}) {
  if (!shrink) return [];
  if (px == null) return ['-Z', String(LEGACY_MAX_DIM)];
  if (src && src.w <= px) return [];
  return ['--resampleWidth', String(px)];
}

module.exports = { LEGACY_MAX_DIM, PX_MIN, PX_MAX, JPEG_Q, JPEG_Q_MOVING, parsePx, pngSize, resizeArgs };
