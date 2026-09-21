'use strict';
// Deterministic cmux-shaped ids for the tmux backend (p18 specs.md §5.3). Pure, built-ins only.
//
// The bridge only accepts a ref (`surface:12`) or a UUID as a target (bridge.js SURFACE_RE and
// friends), and the page carries UUIDs around for as long as a tab is open. tmux numbers its objects
// ($N sessions, @N windows, %N panes) from zero again every time the server starts, so a bare number
// cached on a phone could, after a tmux restart, name a DIFFERENT pane. The epoch — the tmux server's
// `#{start_time}` — is therefore baked into every id: an id minted for another server is refused as
// stale instead of being routed to whatever pane now wears that number.
//
//   ${hex8(epoch)}-000${kind}-4000-8000-${hex12(n)}
//
// The fixed `4000`/`8000` groups keep it a well-formed v4-shaped UUID, so it passes every UUID regex.

const KIND = Object.freeze({ window: 1, workspace: 2, pane: 3, surface: 4 });
const KIND_NAME = Object.freeze({ 1: 'window', 2: 'workspace', 3: 'pane', 4: 'surface' });
const ID_RE = /^([0-9a-f]{8})-000([1-4])-4000-8000-([0-9a-f]{12})$/i;

const kindNum = (kind) => (typeof kind === 'string' ? KIND[kind] : Number(kind));
const hex8 = (epoch) => (Number(epoch) >>> 0).toString(16).padStart(8, '0');
const hex12 = (n) => Math.trunc(Number(n)).toString(16).padStart(12, '0');

// mint(4, 1789991468, 12) -> '6ab11a2c-0004-4000-8000-00000000000c'
function mint(kind, epoch, n) {
  const k = kindNum(kind);
  if (!KIND_NAME[k]) throw new Error(`tmux-ids: bad kind ${kind}`);
  return `${hex8(epoch)}-000${k}-4000-8000-${hex12(n)}`;
}

// -> { kind, epoch, n } | null. `epoch` is the 32-bit value the id carries; compare it against
// `liveEpoch >>> 0`, never against the raw start_time.
function parse(id) {
  const m = ID_RE.exec(String(id || ''));
  if (!m) return null;
  return { kind: Number(m[2]), epoch: parseInt(m[1], 16), n: parseInt(m[3], 16) };
}

function ref(kind, n) {
  const name = KIND_NAME[kindNum(kind)];
  if (!name) throw new Error(`tmux-ids: bad kind ${kind}`);
  return `${name}:${n}`;
}

// 'surface:12' -> 12 when the prefix names `kind`; anything else -> null.
function parseRef(str, kind) {
  const name = KIND_NAME[kindNum(kind)];
  const m = /^([a-z]+):(\d+)$/.exec(String(str || ''));
  if (!name || !m || m[1] !== name) return null;
  return Number(m[2]);
}

const sameEpoch = (idEpoch, liveEpoch) => (Number(idEpoch) >>> 0) === (Number(liveEpoch) >>> 0);

// The surface id a hook process can compute for its own pane, with no tmux call: tmux gives every
// pane TMUX_PANE=%N, and the bridge's ensure() puts CMUX_TMUX_EPOCH and CMUX_TMUX_PID (the server's
// pid) in the server's global environment before any shell starts.
//
// The pid is what makes it safe. A tmux server started from INSIDE one of these panes inherits both
// variables into its own panes, whose TMUX_PANE numbers start at %0 again — without a check, its %0
// would claim the outer %0's tab. $TMUX (`<socket>,<server pid>,<session>`) names the server a pane
// really belongs to, so the pid in it must be the one the bridge recorded. Anything missing,
// malformed or mismatched -> '' (radar falls back to its cwd join).
function surfaceFromEnv(env) {
  const e = env || {};
  const pane = String(e.TMUX_PANE || '');
  const epoch = String(e.CMUX_TMUX_EPOCH || '');
  const pid = String(e.CMUX_TMUX_PID || '');
  const tmux = String(e.TMUX || '').split(',');
  if (!/^%\d+$/.test(pane) || !/^\d+$/.test(epoch) || !/^\d+$/.test(pid)) return '';
  if (tmux.length < 3 || tmux[tmux.length - 2] !== pid) return '';
  return mint(KIND.surface, Number(epoch), Number(pane.slice(1)));
}

module.exports = { KIND, KIND_NAME, ID_RE, mint, parse, ref, parseRef, sameEpoch, surfaceFromEnv };
