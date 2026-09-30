'use strict';
// Which cmux the bridge is talking to, and whether this code has been verified against it.
//
// The bridge leans on cmux behaviours that are not a published contract: `rpc terminal.replay`
// returning a `render_grid` with `scrollback_spans` + `active_screen`, `read-screen --scrollback
// --lines N` returning plain text of the same buffer, `rpc pane.list` pixel frames, UUID-addressed rpc
// params. Each was verified on a specific build (comments in bridge.js name them), and the earliest of
// those is 0.64.19 — the replay/read-screen scrollback measurements the deep-history join is built on.
// Older builds may work (the argv adapter in bridge.js already retries flags 0.62.x rejects), but
// nothing here has been measured on them, so they are reported as unsupported rather than refused.
//
// `cmux --version` prints e.g. `cmux 0.64.25 (106) [b685a275c]`.

const MIN_CMUX_VERSION = '0.64.19';

// '0.64.25' | 'cmux 0.64.25 (106) [..]' -> [0, 64, 25], or null when there is no x.y.z in it.
function parseCmuxVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text == null ? '' : text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// <0 / 0 / >0 like a sort comparator. Accepts strings or parsed triples; null when either is unparseable.
function compareVersions(a, b) {
  const x = Array.isArray(a) ? a : parseCmuxVersion(a);
  const y = Array.isArray(b) ? b : parseCmuxVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// What the bridge reports in capabilities.cmux. `supported` is null when the version is unknown (the
// probe failed or the CLI printed something without a version) — unknown is not the same as too old.
function assessCmuxVersion(versionOutput, min) {
  const floor = min || MIN_CMUX_VERSION;
  const v = parseCmuxVersion(versionOutput);
  const version = v ? v.join('.') : null;
  const c = v ? compareVersions(v, floor) : null;
  return { version, min: floor, supported: c == null ? null : c >= 0 };
}

module.exports = { MIN_CMUX_VERSION, parseCmuxVersion, compareVersions, assessCmuxVersion };
