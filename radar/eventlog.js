'use strict';
// The hook-event NDJSON log under ~/.radar/events/ — one file per UTC day, append-only.
//
// Three processes touch it and they must agree byte-for-byte on the format, which is why the
// format lives here and nowhere else:
//
//   hook-receiver.js   WRITES  (a short-lived process Claude Code spawns per hook)
//   bridge.js          SERVES  (GET /cmux/session-events — this machine's log, over HTTP)
//   mod-sessions.js    READS   (the leader's own log, straight off disk)
//
// Invariants:
//  * Append-only NDJSON. One JSON object per line, '\n'-terminated, never rewritten in place.
//  * A malformed line is SKIPPED, never fatal. A half-written trailing line (the writer was killed
//    mid-append) must cost exactly that one line and nothing else — reading is the hot path for the
//    whole attention system, and a single bad byte must not blind it.
//  * File names are UTC dates. Local-date names would make "is this the current file?" depend on
//    the reader's timezone, and the prune rule below is a delete.
//  * Pruning removes DATED files whose day ended >= 48 h ago. The current day's file is never
//    prunable, at any clock skew, because deleting the file being appended to loses live events.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// How far back a reader looks and how long a dated file survives. The same number on purpose:
// mod-sessions re-folds the whole retained window every sweep (no cursor to corrupt), so retention
// IS the session-history horizon.
const RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_PAGE = 5000;

// Radar's home. RADAR_DIR exists so the bridge, the receiver and the tests can all be pointed at a
// scratch directory without touching the real one.
const defaultRadarDir = () => process.env.RADAR_DIR || path.join(os.homedir(), '.radar');
const eventsDir = (radarDir) => path.join(radarDir || defaultRadarDir(), 'events');

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayFile = (dir, ms) => path.join(dir, `${utcDay(ms)}.ndjson`);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ---- normalization ----------------------------------------------------------------------------
// Claude Code hands a hook its payload on stdin. We keep only the fields §M2 names, so a future
// payload gaining `tool_input` (which can be a whole file's contents) never bloats the log.
//
// Accepts both the raw hook shape (session_id / hook_event_name) and the already-normalized shape,
// so the receiver, the bridge and a fixture file can all feed the same function.
function normalizeEvent(raw, fallbackTs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = str(raw.sessionId) || str(raw.session_id);
  const event = str(raw.event) || str(raw.hook_event_name);
  if (!sessionId || !event) return null;               // identity-less events are unusable — drop
  const tsRaw = Number(raw.ts);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : (fallbackTs == null ? null : Math.floor(fallbackTs));
  if (ts == null) return null;
  const out = {
    ts,
    sessionId,
    transcriptPath: str(raw.transcriptPath) || str(raw.transcript_path),
    cwd: str(raw.cwd),
    event,
    notificationType: str(raw.notificationType) || str(raw.notification_type),
  };
  // Surface identity RECORDED AT BIRTH. The hook runs inside the session's own process tree, so
  // cmux's CMUX_SURFACE_ID / CMUX_TAB_ID are simply in its environment — an exact answer to "which
  // tab is this?", captured at the only moment it is knowable for free. Everything downstream that
  // tries to infer it from cwd is a guess; this is not. Absent for a session not hosted by cmux,
  // in which case the guess is still all there is.
  const surfaceId = str(raw.surfaceId) || str(raw.surface_id);
  const tabId = str(raw.tabId) || str(raw.tab_id);
  const workspaceId = str(raw.workspaceId) || str(raw.workspace_id);
  if (surfaceId) out.surfaceId = surfaceId;
  if (tabId) out.tabId = tabId;
  if (workspaceId) out.workspaceId = workspaceId;
  return out;
}

// ---- writing -----------------------------------------------------------------------------------
// Synchronous by design: the caller is a hook process whose entire job is this one line. An async
// write would race the process exit.
function appendEventSync(radarDir, raw, now) {
  const ts = now == null ? Date.now() : now;
  const ev = normalizeEvent(raw, ts);
  if (!ev) return null;
  const dir = eventsDir(radarDir);
  fs.mkdirSync(dir, { recursive: true });
  // One write, one line. O_APPEND on a local filesystem keeps concurrent hook processes from
  // interleaving inside a line — several Claude sessions fire hooks at the same instant routinely.
  fs.appendFileSync(dayFile(dir, ts), JSON.stringify(ev) + '\n', 'utf8');
  return ev;
}

// ---- reading -----------------------------------------------------------------------------------

// Parse a whole file body. Returns only the lines that survive; `skipped` is the honest count of
// what did not, so a caller can surface "the log is damaged" instead of silently under-reporting.
function parseNdjson(text) {
  const events = [];
  let skipped = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { skipped++; continue; }   // incl. the truncated tail
    const ev = normalizeEvent(obj, null);
    if (!ev) { skipped++; continue; }
    events.push(ev);
  }
  return { events, skipped };
}

async function listEventFiles(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return [];                 // no events yet is not an error
    throw e;
  }
  return names.filter((n) => FILE_RE.test(n)).sort();        // date names sort chronologically
}

// GET /cmux/session-events and mod-sessions both land here.
//
//   since  EXCLUSIVE lower bound on ts (ms epoch). Absent -> everything retained.
//   limit  soft cap, default/max MAX_PAGE.
//
// `limit` is soft on purpose: the page is extended to include every event sharing the last ts.
// A hard cap could split a group of same-ms events across pages, and since the next request uses
// `since = lastTs` (exclusive), the remainder of that group would be skipped forever. Overshooting
// a page by a few rows is free; losing events is not.
async function readEvents(opts) {
  const o = opts || {};
  const dir = o.eventsDir || eventsDir(o.radarDir);
  const since = Number.isFinite(Number(o.since)) ? Number(o.since) : null;
  const limit = Math.max(1, Math.min(MAX_PAGE, Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : MAX_PAGE));

  const files = await listEventFiles(dir);
  const all = [];
  let skipped = 0;
  for (const name of files) {
    let text;
    try { text = await fsp.readFile(path.join(dir, name), 'utf8'); } catch (_) { skipped++; continue; }
    const r = parseNdjson(text);
    skipped += r.skipped;
    for (const ev of r.events) if (since === null || ev.ts > since) all.push(ev);
  }

  // Stable ascending sort. Files are already chronological and a file is append-ordered, but a
  // clock step (or two machines' logs merged by a future reader) must not be able to hand a
  // consumer a descending page — the whole `since` protocol rests on ascending order.
  all.forEach((ev, i) => { ev.__i = i; });
  all.sort((a, b) => (a.ts - b.ts) || (a.__i - b.__i));
  for (const ev of all) delete ev.__i;

  let end = Math.min(limit, all.length);
  if (end < all.length) {
    const boundary = all[end - 1].ts;
    while (end < all.length && all[end].ts === boundary) end++;   // never split a same-ms group
  }
  return { events: all.slice(0, end), more: end < all.length, skipped };
}

// ---- pruning ------------------------------------------------------------------------------------
// A dated file is prunable once the day it covers ENDED at least keepMs ago. Today's file is
// excluded by name before any arithmetic runs, so no clock skew can make it a deletion candidate.
async function pruneEvents(opts) {
  const o = opts || {};
  const dir = o.eventsDir || eventsDir(o.radarDir);
  const now = o.now == null ? Date.now() : o.now;
  const keepMs = Number.isFinite(Number(o.keepMs)) ? Number(o.keepMs) : RETENTION_MS;
  const today = utcDay(now);

  const files = await listEventFiles(dir);
  const removed = [];
  for (const name of files) {
    if (name === `${today}.ndjson`) continue;                  // NEVER the current file
    const day = name.slice(0, 10);
    const dayEnd = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
    if (!Number.isFinite(dayEnd)) continue;
    if (now - dayEnd < keepMs) continue;
    try { await fsp.unlink(path.join(dir, name)); removed.push(name); } catch (_) { /* already gone */ }
  }
  return removed;
}

module.exports = {
  defaultRadarDir, eventsDir, dayFile, utcDay,
  normalizeEvent, appendEventSync,
  parseNdjson, listEventFiles, readEvents, pruneEvents,
  FILE_RE, MAX_PAGE, RETENTION_MS, DAY_MS,
};
