'use strict';
// push.js — the transition WAL that feeds an external notifier (a chat bot, a briefing job) (spec §7).
//
// DELIVERY IS AT-LEAST-ONCE. Not "exactly-once" — that is not available to a file on a laptop that
// gets closed mid-write, and pretending otherwise is how transitions get lost. The contract we can
// actually honour, and do:
//
//     every transition reaches the queue at least once
//     a re-emission of the same transition carries a BYTE-IDENTICAL eventId
//     eventId = sha1(type|ref|transitionAt)   — pure, no clock, no counter, no randomness
//     the consumer (the `radar-push-consumer` task) dedups on eventId
//
// push-queue.jsonl IS THE RECORD. push-state.json is a derived cursor and nothing else: delete it,
// corrupt it, fill it with zeroes, and the next emit rebuilds the whole emitted set by reading the
// WAL back. Any design where the cursor holds facts the WAL does not is a design where losing a
// file loses transitions.
//
// CRASH WINDOWS, both sides of the append:
//   crash BEFORE the append — the WAL is unchanged and the cursor is unchanged. The transition is
//     still derivable from state.json, so the next emit appends it. Nothing lost.
//   crash AFTER the append, before the cursor lands — the WAL has the row and the cursor does not.
//     The next emit rebuilds from the WAL, sees the eventId, and skips. And in the case where the
//     row is no longer visible (rotated past the retained file), it re-appends — a duplicate whose
//     eventId is identical to the original, which is exactly what at-least-once means and exactly
//     what the consumer's dedup absorbs.
//
// THE LEADER IS THE SOLE PRODUCER. A viewer emits nothing — it does not create the file, does not
// touch the cursor, does not append. Two producers writing one WAL would interleave two views of
// "what is blocked" and double-notify the operator for every event.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_NAME = 'push-queue.jsonl';
const ROTATED_NAME = 'push-queue.1.jsonl';
const CURSOR_NAME = 'push-state.json';

const MAX_QUEUE_BYTES = 1024 * 1024;        // rotate at 1 MB, always on a line boundary
const CURSOR_CAP = 5000;                    // ids retained in the cursor; the WAL is the truth
const BLOCKED_AFTER_MS = 10 * 60 * 1000;    // "blocked > 10 min" (spec §7)
const CACHE_WARN_MS = 20 * 60 * 1000;       // "cacheExpiresAt < 20 min" (spec §7)

const eventId = (type, ref, transitionAt) =>
  crypto.createHash('sha1').update(`${type}|${ref}|${transitionAt}`).digest('hex');

const iso = (ms) => new Date(ms).toISOString();

// ---- candidate transitions ------------------------------------------------------------------
// Derived from the CURRENT snapshot every time, never from a diff of two snapshots. That is what
// makes "blocked clears on a later submit" free: a cleared session is simply not a candidate, so
// no amount of replaying can resurrect it.
function candidates(state, now) {
  const out = [];
  const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];

  for (const s of sessions) {
    if (!s || !s.key || !s.key.sessionId) continue;
    // THE PUSH HALF OF THE §5.4 SHIELD. A vanished session is published so the collector's
    // carry-forward keeps it sticky across sweeps — but the tab it was known by is closed, so
    // paging the operator toward it would send them to a terminal that no longer exists. The
    // session stays visible in the inbox, which is the surface that can actually still act on it.
    // This filter and derive's `liveSessions` are the ONLY two: the carry-forward reader
    // (`collector.js :: fragmentsFromState`) deliberately does not filter, and filtering it there
    // would delete the very carry that makes a vanish survive the next sweep.
    if (s.vanished === true) continue;
    const ref = `${s.key.machine}/${s.key.sessionId}`;

    if (s.status === 'blocked' && s.blockedSince) {
      const since = Date.parse(s.blockedSince);
      if (Number.isFinite(since) && now - since >= BLOCKED_AFTER_MS) {
        out.push({
          type: 'blocked',
          ref,
          transitionAt: s.blockedSince,
          payload: {
            machine: s.key.machine, sessionId: s.key.sessionId,
            epic: s.epic || null, repo: s.repo || null,
            notificationType: s.notificationType || null,
            blockedSince: s.blockedSince,
            // Approximate, and labelled — see mod-sessions on the 5-minute overage regime.
            cacheExpiresAt: s.cacheExpiresAt || null, cacheApprox: s.cacheApprox !== false,
            surface: s.surface || null,
          },
        });
      }
    }

    // A running session is refreshing its own cache, so its expiry is not news. A blocked or idle
    // one is the case where the window closes while nobody is looking — the loss this feature was
    // built for.
    if (s.status !== 'running' && s.cacheExpiresAt) {
      const exp = Date.parse(s.cacheExpiresAt);
      if (Number.isFinite(exp) && exp - now <= CACHE_WARN_MS && exp > now) {
        out.push({
          type: 'cache-expiring',
          ref,
          transitionAt: s.cacheExpiresAt,
          payload: {
            machine: s.key.machine, sessionId: s.key.sessionId,
            epic: s.epic || null, repo: s.repo || null, status: s.status,
            cacheExpiresAt: s.cacheExpiresAt, cacheApprox: s.cacheApprox !== false,
            surface: s.surface || null,
          },
        });
      }
    }
  }

  for (const a of (Array.isArray(state && state.attention) ? state.attention : [])) {
    if (!a || a.type !== 'rule-violation') continue;
    const env = a.env || '';
    const deploy = state.repos && state.repos[a.repo] && state.repos[a.repo].deploy;
    const sha = (deploy && deploy[env] && deploy[env].sha) || 'unknown';
    // The ref carries the offending SHA so a NEW bad deploy is a new event, while the same bad
    // deploy sitting there is not re-announced every 10 minutes.
    out.push({
      type: 'rule-violation',
      ref: `${a.repo}/${env}/${sha}`,
      transitionAt: null,                     // resolved from the WAL below: first sight wins
      payload: { repo: a.repo, env, sha, note: a.note || null },
    });
  }

  return out;
}

// ---- WAL / cursor -------------------------------------------------------------------------------

function parseWalLines(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }   // torn tail line: skip, never fatal
    if (obj && typeof obj.eventId === 'string') rows.push(obj);
  }
  return rows;
}

function createPusher(opts) {
  const o = opts || {};
  const dir = o.dir;                                  // ~/.radar/events
  if (!dir) throw new Error('createPusher requires dir');
  const cursorPath = o.cursorPath || path.join(path.dirname(dir), CURSOR_NAME);
  const queuePath = path.join(dir, QUEUE_NAME);
  const rotatedPath = path.join(dir, ROTATED_NAME);
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_QUEUE_BYTES;
  const isLeader = () => (o.role ? o.role : 'leader') === 'leader';
  const hooks = o.hooks || {};                        // {beforeAppend, afterAppend} — crash injection

  let index = null;    // { byId: Map<id,row>, byTypeRef: Map<"type|ref", transitionAt> }

  function emptyIndex() { return { byId: new Map(), byTypeRef: new Map() }; }

  function addToIndex(idx, row) {
    idx.byId.set(row.eventId, row);
    const k = `${row.type}|${row.ref}`;
    if (!idx.byTypeRef.has(k)) idx.byTypeRef.set(k, row.transitionAt);
  }

  // The rebuild path. Reads the rotated file first so first-seen ordering survives a rotation.
  function rebuildFromWal() {
    const idx = emptyIndex();
    for (const f of [rotatedPath, queuePath]) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      for (const row of parseWalLines(text)) addToIndex(idx, row);
    }
    return idx;
  }

  function loadIndex() {
    if (index) return index;
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(cursorPath, 'utf8')); } catch (_) { cur = null; }
    if (!cur || cur.v !== 1 || !Array.isArray(cur.emitted)) {
      // Missing, corrupt, or a version we do not understand: the cursor is DERIVED, so throwing it
      // away costs nothing. Trusting a cursor we cannot parse would cost transitions.
      index = rebuildFromWal();
      return index;
    }
    const idx = emptyIndex();
    for (const r of cur.emitted) {
      if (r && typeof r.eventId === 'string') addToIndex(idx, r);
    }
    index = idx;
    return index;
  }

  function saveCursor() {
    const rows = Array.from(index.byId.values()).slice(-CURSOR_CAP);
    const body = JSON.stringify({
      v: 1,
      updatedAt: iso(clock()),
      emitted: rows.map((r) => ({ eventId: r.eventId, type: r.type, ref: r.ref, transitionAt: r.transitionAt })),
    }, null, 2) + '\n';
    const tmp = `${cursorPath}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, cursorPath);                   // same temp+rename discipline as state.json
  }

  // Rotation happens BEFORE a write, never during one, so the retired file always ends on a '\n'
  // and no line is ever split across the two files.
  function rotateIfNeeded(lineBytes) {
    let size = 0;
    try { size = fs.statSync(queuePath).size; } catch (_) { return; }
    if (size + lineBytes <= maxBytes) return;
    try { fs.renameSync(queuePath, rotatedPath); } catch (_) { /* keep appending to the current file */ }
  }

  function appendRow(row) {
    const line = JSON.stringify(row) + '\n';
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(Buffer.byteLength(line));
    const fd = fs.openSync(queuePath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);                               // the crash window is the point of a WAL
    } finally {
      fs.closeSync(fd);
    }
  }

  // Returns { emitted: [rows], skipped, duplicates } and NEVER throws for a state problem — a push
  // failure must not be able to fail the scan that produced the state.
  function emit(state) {
    if (!isLeader()) return { emitted: [], skipped: 'viewer', duplicates: 0 };
    const now = clock();
    const idx = loadIndex();
    const emitted = [];
    let duplicates = 0;

    for (const c of candidates(state, now)) {
      // rule-violation has no intrinsic clock: its transitionAt is when WE first saw it, recovered
      // from the WAL so the id is stable across restarts and cursor loss alike.
      const transitionAt = c.transitionAt || idx.byTypeRef.get(`${c.type}|${c.ref}`) || iso(now);
      const id = eventId(c.type, c.ref, transitionAt);
      if (idx.byId.has(id)) continue;

      const row = {
        v: 1,
        eventId: id,
        type: c.type,
        ref: c.ref,
        transitionAt,
        emittedAt: iso(now),
        payload: c.payload,
      };

      if (typeof hooks.beforeAppend === 'function') hooks.beforeAppend(row);   // crash injection A
      appendRow(row);
      if (typeof hooks.afterAppend === 'function') hooks.afterAppend(row);     // crash injection B

      // A row already present in the WAL under a different cursor generation is still a duplicate
      // delivery — counted, never suppressed, and identical in eventId by construction.
      if (idx.byId.has(id)) duplicates++;
      addToIndex(idx, row);
      emitted.push(row);
    }

    if (emitted.length) saveCursor();
    return { emitted, skipped: null, duplicates };
  }

  return {
    emit, candidates: (state, now) => candidates(state, now == null ? clock() : now),
    queuePath, rotatedPath, cursorPath,
    _loadIndex: loadIndex, _rebuildFromWal: rebuildFromWal,
    _reset: () => { index = null; },
    readQueue: () => {
      const rows = [];
      for (const f of [rotatedPath, queuePath]) {
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
        for (const r of parseWalLines(text)) rows.push(r);
      }
      return rows;
    },
  };
}

module.exports = {
  createPusher, candidates, eventId, parseWalLines,
  QUEUE_NAME, ROTATED_NAME, CURSOR_NAME,
  MAX_QUEUE_BYTES, BLOCKED_AFTER_MS, CACHE_WARN_MS, CURSOR_CAP,
};
