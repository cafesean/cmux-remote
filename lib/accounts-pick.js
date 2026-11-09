'use strict';
// D228 slice A — "Auto" Claude account pick + "has room" marks. Pure: no Keychain, no network, no token.
// Port of the chief-of-staff rule (account-limit.sh --pick, Sean 2026-11-07/08):
//   room  = state ok|unknown AND util5h < 0.90 AND util7d < 0.90 (each only when known)
//   order = lowest util7d, then util5h (known before unknown), then oldest lastUsedAt (never used first),
//           then fewest live launches, then name
//   named accounts only: `a` (the Mac's own login, legacy-explicit-only) never wins Auto
//   ACCOUNT_POOL (chief file, one name per word) when present and non-empty: pick only from it
//   no account with room -> pick null + the soonest reset among the candidates
// Spec: _specs/p41-native-apps/d228-account-load-balancing.md (slice A); multi-account.md D13.
const fs = require('fs');
const path = require('path');

const ROOM_MAX = 0.90;                 // accountAutoRoomMax
const POOL_MAX_BYTES = 64 * 1024;      // a bigger pool file is ignored (treated as absent)
const RESERVED = new Set(['a', 'auto']);

const known = (v) => typeof v === 'number' && Number.isFinite(v);

function room(row) {
  if (!row || (row.state !== 'ok' && row.state !== 'unknown')) return false;
  if (known(row.util5h) && row.util5h >= ROOM_MAX) return false;
  if (known(row.util7d) && row.util7d >= ROOM_MAX) return false;
  return true;
}

// When an account without room gets room back (ms) | null
function resetOf(row) {
  if (!row) return null;
  const ms = (s) => (known(s) && s > 0 ? s * 1000 : null);
  const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  if (row.state === 'limited') return iso(row.resetsAt) != null ? iso(row.resetsAt) : (ms(row.reset7d) || ms(row.reset5h));
  if (row.state === 'invalid') return null;
  const r = [];
  if (known(row.util7d) && row.util7d >= ROOM_MAX && ms(row.reset7d)) r.push(ms(row.reset7d));
  if (known(row.util5h) && row.util5h >= ROOM_MAX && ms(row.reset5h)) r.push(ms(row.reset5h));
  return r.length ? Math.max(...r) : null;   // both over: room only after the later one
}

const cmpNum = (a, b) => (known(a) ? (known(b) ? a - b : -1) : (known(b) ? 1 : 0));

// rows: accounts-usage rows; launches: LIVE launches [{account}] (fewest-live tie-break); pool: Set|null
// -> { pick: name|null, why: string, soonest: ISO|null }
function pick(rows, launches, now, pool) {
  const usePool = pool && pool.size ? pool : null;
  const cands = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.name === 'string'
    && !RESERVED.has(r.name) && (!usePool || usePool.has(r.name)));
  const live = new Map();
  for (const l of Array.isArray(launches) ? launches : []) if (l && l.account) live.set(l.account, (live.get(l.account) || 0) + 1);
  const ok = cands.filter(room);
  if (!ok.length) {
    let soon = null;
    for (const r of cands) { const t = resetOf(r); if (t != null && t > (now || 0) && (soon == null || t < soon)) soon = t; }
    const why = cands.length ? 'all at limit' : (usePool ? 'no account in the pool' : 'no named account');
    return { pick: null, why, soonest: soon == null ? null : new Date(soon).toISOString() };
  }
  const used = (r) => { const t = Date.parse(r.lastUsedAt); return Number.isFinite(t) ? t : -Infinity; };
  ok.sort((x, y) => cmpNum(x.util7d, y.util7d) || cmpNum(x.util5h, y.util5h)
    || (used(x) - used(y) || 0) || ((live.get(x.name) || 0) - (live.get(y.name) || 0))
    || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const p = ok[0];
  const pct = (v) => (known(v) ? Math.round(v * 100) + '%' : '?');
  return { pick: p.name, why: `most room (7d ${pct(p.util7d)}, 5h ${pct(p.util5h)}, live ${live.get(p.name) || 0})`, soonest: null };
}

// The chief's pool file: HYPERMUX_ACCOUNT_POOL_FILE, else <dir of the chief usage file>/ACCOUNT_POOL.<prefix>
// (the chief writes account-usage.json and ACCOUNT_POOL.<prefix> in the same $COS_DIR), else $COS_DIR.
function poolFile(env = process.env) {
  if (env.HYPERMUX_ACCOUNT_POOL_FILE) return path.isAbsolute(env.HYPERMUX_ACCOUNT_POOL_FILE) ? env.HYPERMUX_ACCOUNT_POOL_FILE : null;
  const dir = env.COS_DIR && path.isAbsolute(env.COS_DIR) ? env.COS_DIR
    : (env.HYPERMUX_ACCOUNT_USAGE_FILE && path.isAbsolute(env.HYPERMUX_ACCOUNT_USAGE_FILE) ? path.dirname(env.HYPERMUX_ACCOUNT_USAGE_FILE) : null);
  return dir ? path.join(dir, 'ACCOUNT_POOL.' + (env.COS_MACHINE_PREFIX || 'm')) : null;
}

// -> Set of names | null (missing / empty / too big / unreadable = no pool, the chief's old behaviour)
function readPool(file) {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > POOL_MAX_BYTES) return null;
    const names = fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean);
    return names.length ? new Set(names) : null;
  } catch (_) { return null; }
}

module.exports = { room, pick, resetOf, poolFile, readPool, ROOM_MAX, RESERVED };
