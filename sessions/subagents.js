'use strict';
// p41 A10 — the Claude Code sub-agents of one session (CONTRACT.md "Subagent").
//
// A main transcript <dir>/<sessionId>.jsonl keeps its sub-agents beside it:
//   <dir>/<sessionId>/subagents/agent-<agentId>.jsonl       the sub-agent's own transcript (isSidechain rows)
//   <dir>/<sessionId>/subagents/agent-<agentId>.meta.json   {agentType, description, toolUseId, model, finished?, ...}
//
//   listSubagents(transcriptPath, {home, now})  -> Promise<{total, subagents: Subagent[]}>  newest first, capped
//   countSubagents(transcriptPath, {home, now}) -> Promise<{running, total}>
//   openSubagent(transcriptPath, agentId, {home}) -> Promise<{fh, st, path} | null>
//   agentIdMap(transcriptPath)                  -> Promise<Map<toolUseId, agentId>>
//
// `transcriptPath` is always the already-checked real path of the main transcript (routes.js safeOpen).
// A sub-agent path is built only from that path and a validated agentId, then realpath'ed: it must sit
// directly in the session's own (non-symlinked) subagents dir and pass isAllowedTranscriptPath; it is
// opened O_NOFOLLOW and fstat'ed as a regular file. Anything else is "no such sub-agent".
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { isAllowedTranscriptPath } = require('./join');
const { AGENT_ID_RE } = require('./transcript-claude');

const LIMITS = {
  subagentsMax: 100,               // sub-agents returned by one list (newest first); `total` still counts all
  subagentLiveMs: 2 * 60 * 1000,   // an unfinished sub-agent written to within this is `running`, else `done`
  subagentCountTtlMs: 2000,        // the {running,total} count on a Session is cached this long per session
  subagentMetaMaxBytes: 64 * 1024, // a meta.json larger than this is ignored
  subagentEdgeBytes: 64 * 1024,    // bytes read at each end of a sub-agent transcript (start time, last record)
  subagentPreviewMax: 200,
  subagentCountTtlIdleMs: 30000,   // ...and this long when nothing was running and no file appeared since
  subagentConcurrency: 4,          // sub-agent files opened at once (list, count)
  subagentCountOpenMax: 16,        // most files a count opens; more live ones count as running unread
  agentIdMapMax: 1000,             // toolUseId -> agentId entries kept per session
  cacheSessionsMax: 256,           // sessions kept in the count and agentId caches
};
// Real ids: `a` + 17 hex (plain Agent calls) or `a<name>-<16 hex>` (named teammates, e.g.
// `adeploy-test-send-2de020c0d2623678`). Letters, digits and `-` only: never `.`, `/` or `\`.
// (AGENT_ID_RE is defined once, in transcript-claude.js.)
const FILE_RE = /^agent-(.+)\.jsonl$/;
const isAgentId = (s) => typeof s === 'string' && AGENT_ID_RE.test(s);

const sessionDirOf = (tp) => tp.slice(0, -'.jsonl'.length);
const subagentsDirOf = (tp) => path.join(sessionDirOf(tp), 'subagents');

const short = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

async function readSmall(p, max) {
  let fh;
  try {
    fh = await fsp.open(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return null;
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(st.size), 0, st.size, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch (_) { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}
async function readMeta(dir, agentId) {
  const raw = await readSmall(path.join(dir, `agent-${agentId}.meta.json`), LIMITS.subagentMetaMaxBytes);
  if (!raw) return null;
  try { const m = JSON.parse(raw); return m && typeof m === 'object' ? m : null; } catch (_) { return null; }
}

// First record (start time) and last user/assistant record (status, preview) from the file's two ends.
async function edges(fh, size) {
  const n = LIMITS.subagentEdgeBytes;
  const read = async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.toString('utf8', 0, bytesRead); };
  const parse = (l) => { try { return JSON.parse(l); } catch (_) { return null; } };
  const head = size ? await read(0, Math.min(n, size)) : '';
  const nl = head.indexOf('\n');
  const first = parse(nl < 0 ? head : head.slice(0, nl));
  const tail = size > n ? await read(size - n, n) : head;
  const lines = tail.split('\n');
  if (size > n) lines.shift();   // torn first line
  let last = null;
  let lastText = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = lines[i].trim() ? parse(lines[i]) : null;
    if (!r || (r.type !== 'user' && r.type !== 'assistant')) continue;
    if (!last) last = r;
    if (!lastText && r.type === 'assistant') {
      const c = r.message && r.message.content;
      const t = Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ') : '';
      if (t.trim()) lastText = t;
    }
    if (last && lastText) break;
  }
  return { first, last, lastText };
}

// done: meta says finished, or the last record is an assistant turn with no tool call pending.
// Otherwise running while the file is fresh, else done (a sub-agent that stopped writing is over).
function statusOf(meta, last, mtimeMs, now) {
  if (meta && meta.finished === true) return 'done';
  if (last && last.type === 'assistant') {
    const c = (last.message && last.message.content) || [];
    const toolPending = (Array.isArray(c) && c.some((b) => b && b.type === 'tool_use')) || (last.message && last.message.stop_reason === 'tool_use');
    if (!toolPending) return 'done';
  }
  return now - mtimeMs <= LIMITS.subagentLiveMs ? 'running' : 'done';
}

// Run fn over items, at most n at once.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
const cachePut = (m, k, v) => { m.delete(k); m.set(k, v); if (m.size > LIMITS.cacheSessionsMax) m.delete(m.keys().next().value); };

// Regular-file entries of the session's subagents dir, newest mtime first. A symlinked dir or entry is skipped.
async function entries(transcriptPath) {
  const dir = subagentsDirOf(transcriptPath);
  // transcriptPath is real, so a symlink-free subagents dir is its own realpath.
  try { if ((await fsp.realpath(dir)) !== dir || !(await fsp.lstat(dir)).isDirectory()) return { dir, list: [] }; } catch (_) { return { dir, list: [] }; }
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { names = []; }
  const list = [];
  await Promise.all(names.map(async (name) => {
    const m = FILE_RE.exec(name);
    if (!m || !isAgentId(m[1])) return;
    try {
      const st = await fsp.lstat(path.join(dir, name));
      if (st.isFile()) list.push({ agentId: m[1], mtimeMs: st.mtimeMs });
    } catch (_) { /* vanished */ }
  }));
  list.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.agentId < b.agentId ? -1 : 1));
  return { dir, list };
}

async function describeOne(transcriptPath, dir, agentId, opts) {
  const o = await openSubagent(transcriptPath, agentId, opts);
  if (!o) return null;
  try {
    const meta = (await readMeta(dir, agentId)) || {};
    const { first, last, lastText } = await edges(o.fh, o.st.size);
    const t0 = first && Date.parse(first.timestamp);
    const tl = last && Date.parse(last.timestamp);
    const mtime = Math.floor(o.st.mtimeMs);
    const str = (v) => (typeof v === 'string' ? v : '');
    return {
      agentId, description: str(meta.description), agentType: str(meta.agentType), model: str(meta.model),
      toolUseId: str(meta.toolUseId), status: statusOf(meta, last, o.st.mtimeMs, opts.now),
      startedAt: Number.isFinite(t0) ? t0 : Math.floor(o.st.birthtimeMs || o.st.mtimeMs),
      lastActivity: Number.isFinite(tl) ? Math.max(tl, mtime) : mtime,
      preview: short(lastText, LIMITS.subagentPreviewMax),
    };
  } finally { await o.fh.close().catch(() => {}); }
}

async function listSubagents(transcriptPath, deps) {
  const d = { home: os.homedir(), ...(deps || {}) };
  d.now = typeof d.now === 'function' ? d.now() : (d.now || Date.now());
  const { dir, list } = await entries(transcriptPath);
  const top = list.slice(0, LIMITS.subagentsMax);
  const out = (await mapLimit(top, LIMITS.subagentConcurrency, (e) => describeOne(transcriptPath, dir, e.agentId, d))).filter(Boolean);
  out.sort((a, b) => b.startedAt - a.startedAt || b.lastActivity - a.lastActivity);
  return { total: list.length, subagents: out };
}

// {running, total} for a Session row: readdir + lstat; a file not written within the live window is done
// without being opened; only live files are opened (bounded). Cached per session for subagentCountTtlMs,
// or subagentCountTtlIdleMs when nothing was live; a changed dir mtime (a new sub-agent) drops the entry.
const countCache = new Map();   // transcriptPath -> {at, dirMtime, ttl, p}
async function countLive(transcriptPath, dir, live, d) {
  const toOpen = live.slice(0, LIMITS.subagentCountOpenMax);
  const st = await mapLimit(toOpen, LIMITS.subagentConcurrency, async (e) => {
    const o = await openSubagent(transcriptPath, e.agentId, d);
    if (!o) return 'gone';
    try {
      const meta = await readMeta(dir, e.agentId);
      const { last } = await edges(o.fh, o.st.size);
      return statusOf(meta, last, o.st.mtimeMs, d.now);
    } finally { await o.fh.close().catch(() => {}); }
  });
  return st.filter((x) => x === 'running').length + (live.length - toOpen.length);
}
async function countSubagents(transcriptPath, deps) {
  const now = Date.now();
  const d = { home: os.homedir(), ...(deps || {}), now };
  const hit = countCache.get(transcriptPath);
  if (hit && now - hit.at < LIMITS.subagentCountTtlMs) return hit.p;
  let dirMtime = 0;
  try { dirMtime = (await fsp.lstat(subagentsDirOf(transcriptPath))).mtimeMs; } catch (_) { dirMtime = 0; }
  if (hit && hit.dirMtime === dirMtime && now - hit.at < hit.ttl) return hit.p;
  const entry = { at: now, dirMtime, ttl: LIMITS.subagentCountTtlMs, p: null };
  entry.p = (async () => {
    const { dir, list } = await entries(transcriptPath);
    const live = list.filter((e) => now - e.mtimeMs <= LIMITS.subagentLiveMs);
    const running = live.length ? await countLive(transcriptPath, dir, live, d) : 0;
    if (!live.length) entry.ttl = LIMITS.subagentCountTtlIdleMs;   // nothing live: only a new file (dir mtime) can change it soon
    return { running, total: list.length };
  })().catch(() => ({ running: 0, total: 0 }));
  cachePut(countCache, transcriptPath, entry);
  return entry.p;
}

async function openSubagent(transcriptPath, agentId, deps) {
  const home = (deps && deps.home) || os.homedir();
  if (!isAgentId(agentId) || typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  const dir = subagentsDirOf(transcriptPath);
  const p = path.join(dir, `agent-${agentId}.jsonl`);
  let real;
  let realDir;
  try {
    realDir = await fsp.realpath(dir);
    if (realDir !== dir) return null;   // transcriptPath is real: no symlink between it and the subagents dir
    real = await fsp.realpath(p);
  } catch (_) { return null; }
  if (path.dirname(real) !== realDir || path.basename(real) !== `agent-${agentId}.jsonl`) return null;
  if (!(await isAllowedTranscriptPath(real, { home }))) return null;
  let fh;
  try {
    fh = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = await fh.stat();
    if (!st.isFile()) { await fh.close(); return null; }
    return { fh, st, path: real };
  } catch (_) { if (fh) await fh.close().catch(() => {}); return null; }
}

// toolUseId -> agentId from the meta files, for linking a main-thread Agent/Task row to its sub-agent.
// Cached per session; a changed dir mtime (a new sub-agent or meta file) reads only the ids not seen yet.
// At most agentIdMapMax entries per session (the newest files first).
const idCache = new Map();   // transcriptPath -> {dirMtime, seen: Set<agentId>, p}
async function agentIdMap(transcriptPath) {
  let dirMtime = 0;
  try { dirMtime = (await fsp.lstat(subagentsDirOf(transcriptPath))).mtimeMs; } catch (_) { dirMtime = 0; }
  const hit = idCache.get(transcriptPath);
  if (hit && hit.dirMtime === dirMtime) return hit.p;
  const prev = hit ? await hit.p.catch(() => null) : null;
  const seen = new Set(hit ? hit.seen : []);
  const map = new Map(prev || []);
  const p = (async () => {
    const { dir, list } = await entries(transcriptPath);
    const fresh = list.filter((e) => !seen.has(e.agentId)).slice(0, Math.max(0, LIMITS.agentIdMapMax - map.size));
    await mapLimit(fresh, LIMITS.subagentConcurrency, async (e) => {
      const m = await readMeta(dir, e.agentId);
      if (m) seen.add(e.agentId);   // no meta yet: read again on the next dir change
      if (m && typeof m.toolUseId === 'string' && m.toolUseId) map.set(m.toolUseId, e.agentId);
    });
    return map;
  })().catch(() => map);
  cachePut(idCache, transcriptPath, { dirMtime, seen, p });
  return p;
}

// A sync toolUseId -> agentId lookup for a live tail: answers from the cached map and, on a miss, refreshes
// it in the background (cheap: keyed by dir mtime), so the row's re-send at its tool_result links.
function agentIdLookup(transcriptPath) {
  let map = new Map();
  let busy = false;
  const refresh = () => {
    if (busy) return;
    busy = true;
    agentIdMap(transcriptPath).then((m) => { map = m; }, () => {}).finally(() => { busy = false; });
  };
  refresh();
  return (toolUseId) => { const a = map.get(toolUseId); if (!a) refresh(); return a; };
}

const subagentMeta = (tp, agentId) => (isAgentId(agentId) ? readMeta(subagentsDirOf(tp), agentId) : Promise.resolve(null));

module.exports = { subagentMeta, listSubagents, countSubagents, openSubagent, agentIdMap, agentIdLookup, isAgentId, AGENT_ID_RE, LIMITS };
