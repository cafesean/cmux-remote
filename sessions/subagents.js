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

const LIMITS = {
  subagentsMax: 100,               // sub-agents returned by one list (newest first); `total` still counts all
  subagentLiveMs: 2 * 60 * 1000,   // an unfinished sub-agent written to within this is `running`, else `done`
  subagentCountTtlMs: 2000,        // the {running,total} count on a Session is cached this long per session
  subagentMetaMaxBytes: 64 * 1024, // a meta.json larger than this is ignored
  subagentEdgeBytes: 64 * 1024,    // bytes read at each end of a sub-agent transcript (start time, last record)
  subagentPreviewMax: 200,
  agentIdMax: 80,
};
// Real ids: `a` + 17 hex (plain Agent calls) or `a<name>-<16 hex>` (named teammates, e.g.
// `adeploy-test-send-2de020c0d2623678`). Letters, digits and `-` only: never `.`, `/` or `\`.
const AGENT_ID_RE = new RegExp(`^a[A-Za-z0-9][A-Za-z0-9-]{4,${LIMITS.agentIdMax - 2}}$`);
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
  const out = (await Promise.all(top.map((e) => describeOne(transcriptPath, dir, e.agentId, d)))).filter(Boolean);
  out.sort((a, b) => b.startedAt - a.startedAt || b.lastActivity - a.lastActivity);
  return { total: list.length, subagents: out };
}

const countCache = new Map();   // transcriptPath -> {at, p}
async function countSubagents(transcriptPath, deps) {
  const now = Date.now();
  const hit = countCache.get(transcriptPath);
  if (hit && now - hit.at < LIMITS.subagentCountTtlMs) return hit.p;
  const p = listSubagents(transcriptPath, deps)
    .then((r) => ({ running: r.subagents.filter((s) => s.status === 'running').length, total: r.total }))
    .catch(() => ({ running: 0, total: 0 }));
  countCache.set(transcriptPath, { at: now, p });
  if (countCache.size > 512) countCache.delete(countCache.keys().next().value);
  return p;
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
async function agentIdMap(transcriptPath) {
  const { dir, list } = await entries(transcriptPath);
  const map = new Map();
  await Promise.all(list.map(async (e) => {
    const m = await readMeta(dir, e.agentId);
    if (m && typeof m.toolUseId === 'string' && m.toolUseId) map.set(m.toolUseId, e.agentId);
  }));
  return map;
}

const subagentMeta = (tp, agentId) => (isAgentId(agentId) ? readMeta(subagentsDirOf(tp), agentId) : Promise.resolve(null));

module.exports = { subagentMeta, listSubagents, countSubagents, openSubagent, agentIdMap, isAgentId, AGENT_ID_RE, LIMITS };
