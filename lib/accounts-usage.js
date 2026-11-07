'use strict';
// D154 (HMX-56) — PASSIVE limit status per Claude account, for GET /cmux/accounts/usage.
//
// No network call and no token read, ever: HyprMux only reads what the official `claude` CLI itself
// wrote. For each account, the sessions launched on it (lib/accounts-launches.js) point at their
// transcripts; the newest relevant assistant row in each transcript's tail decides:
//   error 'rate_limit' + quotaLimits.status 'rejected' -> limited (resetsAt = quotaLimits.resetsAt) while
//     the reset is ahead; a passed reset says nothing (unknown)
//   error 'authentication_failed' / "OAuth token revoked" / "Invalid API key" text -> invalid
//   a normal assistant reply                             -> ok
//   nothing                                              -> unknown
// lastUsedAt = newest normal assistant reply on that account (any state).
// -> { keychain, accounts: [{ name, state, resetsAt, lastUsedAt, limit: 'weekly'|'session'|null }] }
// Spec: _specs/p41-native-apps/multi-account.md §1 (no HyperMux API call with a token) + §3.5 (revoked
// detected from transcript text only).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const launches = require('./accounts-launches');
const { claudeTranscriptOf } = require('../sessions/procs');

const USAGE_CACHE_MS = 60000;           // accountUsageCacheMs
const WINDOW_MS = 8 * 24 * 3600 * 1000; // accountUsageWindowMs: launches older than this are ignored
const PER_ACCOUNT = 20;                 // accountUsageLaunchesPerAccount: newest launches scanned
const TAIL_BYTES = 256 * 1024;          // accountUsageTailBytes per transcript
const slugOf = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
const LIMIT_KIND = { seven_day: 'weekly', seven_day_opus: 'weekly', seven_day_sonnet: 'weekly', five_hour: 'session' };

async function tail(file, bytes = TAIL_BYTES) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch (_) { return ''; } finally { if (fh) await fh.close().catch(() => {}); }
}

const DEAD_TEXT = /OAuth token revoked|OAuth token has expired|Invalid API key|authentication_error|\b401\b/i;
const textOf = (r) => {
  const c = r.message && r.message.content;
  return Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ') : (typeof c === 'string' ? c : '');
};

// newest normal assistant reply time in a tail (ms) | null
function lastOkAt(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let r; try { r = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!r || r.type !== 'assistant' || r.isSidechain || r.isApiErrorMessage || r.error) continue;
    if (r.message && r.message.model === '<synthetic>') continue;
    const at = Date.parse(r.timestamp);
    if (Number.isFinite(at)) return at;
  }
  return null;
}

// newest event in a transcript tail: { kind: 'limited'|'dead'|'ok', at, resetAt?, limit? } | null
function lastEvent(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"assistant"')) continue;
    let r; try { r = JSON.parse(l); } catch (_) { continue; }
    if (!r || r.type !== 'assistant' || r.isSidechain) continue;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) continue;
    if (r.error === 'rate_limit') {
      const q = r.quotaLimits || (r.apiErrorParams && r.apiErrorParams.rate_limit_info) || {};
      if (q.status !== 'rejected') continue;
      const rs = Number(q.resetsAt);
      return { kind: 'limited', at, resetAt: Number.isFinite(rs) && rs > 0 ? rs * 1000 : null, limit: LIMIT_KIND[q.rateLimitType] || null };
    }
    if (r.error === 'authentication_failed') return { kind: 'dead', at };
    if (r.isApiErrorMessage && DEAD_TEXT.test(textOf(r))) return { kind: 'dead', at };
    if (r.isApiErrorMessage || r.error) continue;
    if (r.message && r.message.model === '<synthetic>') continue;
    return { kind: 'ok', at };
  }
  return null;
}

function createUsage(opts = {}) {
  const accounts = opts.accounts;
  const home = opts.home || os.homedir();
  const clock = opts.now || Date.now;
  const readLaunches = opts.readLaunches || (() => launches.read());
  const transcriptOfPid = opts.transcriptOfPid || ((pid) => claudeTranscriptOf(pid, { home }));
  const resolved = new Map();   // `${pid}:${at}` -> transcript path (a live pid is resolved once)
  let cache = null, cacheAt = -Infinity, inflight = null;

  async function transcriptOf(l) {
    if (l.sessionId) return path.join(home, '.claude', 'projects', slugOf(l.cwd), l.sessionId + '.jsonl');
    const k = `${l.pid}:${l.at}`;
    if (resolved.has(k)) return resolved.get(k);
    const t = await transcriptOfPid(l.pid).catch(() => null);
    // a pid file written before this launch is a recycled pid's: never bind it
    if (t && t.transcriptPath) { resolved.set(k, t.transcriptPath); if (resolved.size > 2000) resolved.delete(resolved.keys().next().value); }
    return t ? t.transcriptPath : null;
  }

  async function statusOf(name, all, now) {
    const mine = all.filter((l) => l.account === name && now - l.at <= WINDOW_MS).slice(-PER_ACCOUNT);
    let best = null, okAt = null;
    const seen = new Set();
    for (const l of mine) {
      const file = await transcriptOf(l);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const text = await tail(file);
      const ev = lastEvent(text);
      if (ev && ev.at >= l.at - 60000 && (!best || ev.at > best.at)) best = ev;
      const o = lastOkAt(text);
      if (o != null && o >= l.at - 60000 && (okAt == null || o > okAt)) okAt = o;
    }
    const iso = (t) => (t == null ? null : new Date(t).toISOString());
    const row = (state, resetsAt = null, limit = null) => ({ name, state, resetsAt: iso(resetsAt), lastUsedAt: iso(okAt), limit });
    if (!best) return row('unknown');
    if (best.kind === 'limited') {
      if (best.resetAt != null && best.resetAt <= now) return row('unknown');
      return row('limited', best.resetAt, best.limit);
    }
    if (best.kind === 'dead') return row('invalid');
    return row('ok');
  }

  async function compute() {
    const l = await accounts.list({});
    if (l.keychain !== 'ok') return { keychain: 'locked', accounts: [] };
    const all = readLaunches();
    const now = clock();
    const out = [];
    for (const a of l.accounts) out.push(await statusOf(a.name, all, now));
    return { keychain: 'ok', accounts: out };
  }

  function usage() {
    if (cache && clock() - cacheAt < USAGE_CACHE_MS) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = compute().then((v) => { cache = v; cacheAt = clock(); return v; }).finally(() => { inflight = null; });
    return inflight;
  }
  return { usage, invalidate() { cache = null; } };
}

module.exports = { createUsage, lastEvent, lastOkAt, tail, USAGE_CACHE_MS, WINDOW_MS, PER_ACCOUNT, TAIL_BYTES };
