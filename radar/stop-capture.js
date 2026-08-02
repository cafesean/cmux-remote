'use strict';
// stop-capture — §M1's capture-at-stop observation ledger. One line per settled Stop, and the
// relation is named lastObservedBy in every rendering, because that is all a line here claims:
// "this session was last seen on this branch, at this commit". Causal attribution is a non-goal
// (spec §8) — a session that merely visited an already-dirty branch would otherwise out-shout the
// session that did the work and overwrite the truth with a guess. Pre-existing facts stay unknown.
//
// Runs on the p5 session sweep, inside the server — the single writer (spec principle 8). The
// sweep hands in its clock, the normalized config and the current published snapshot:
//
//     sweepStopCapture({ now, machine, config, aliases, state, paths })   // or { radarDir }
//
// CAPTURE IS DUE iff ALL THREE hold (spec §M1, conjunct 1 as amended by the U5 measurement):
//   1. the session's newest DECISIVE event is a Stop — where decisive means Stop or
//      UserPromptSubmit. Equivalently: the newest event is a Stop, or a Stop followed only by
//      events that are neither Stop nor UserPromptSubmit.
//   2. now - that Stop's ts >= captureQuietMs,
//   3. the capture cursor does not already hold that stopTs.
// WHY conjunct 1 is scoped to decisive events — measured, not theorised (the U5 hunt): a real
// claude session emits `Notification {idle_prompt}` about a minute AFTER its Stop, then goes
// silent. Under a plain "newest event is a Stop" rule that notification cancels the capture
// forever, so real ended-and-left sessions — exactly the population this module exists to
// observe — are never captured, while every synthetic fixture (no idle_prompt) passes. The
// predicate's intent is "this session ended and nobody came back": a UserPromptSubmit means
// somebody came back and must cancel; a newer Stop supersedes and must win; but an idle_prompt
// is the system observing that nobody came back, which STRENGTHENS the case. Treating any
// trailing event as a cancellation confuses "someone returned" with "time passed". There is
// still no second cancellation rule to forget — only the two decisive kinds decide.
//
// The quiet clock runs from the STOP's ts, never a trailing notification's: the window measures
// how long ago the session ended, and taking the notification's ts would restart the clock and
// delay every capture by however long the notification lagged.
//
// WRITE ORDER IS LOAD-BEARING. The observation line is appended FIRST, the cursor is written
// SECOND. A crash between the two repeats one line on the next sweep, which §6.5's reader absorbs
// (it takes the newest line); the reverse order would lose the observation forever, because the
// cursor would claim a capture that never landed. Losing the cursor file entirely costs nothing:
// it is rebuilt from observations.jsonl (max stopTs per (machine, sessionId)) — the ledger is the
// durable artifact, the cursor a cache (spec §4.4).
//
// M1 owns NO queue slot: it runs between requests, not inside a store transaction, so it uses the
// QUEUED store forms — appendLine, writeJsonAtomic. The unqueued pair is for callers that already
// hold a slot; calling it here would drop these writes out of the single-writer serialisation
// (spec §4.8, trap 14 is the inverse mistake).
//
// No hook install: Stop already fires (p5 S-004). radar/hook-receiver.js and ~/.claude/settings.json
// are not touched by this module, ever.
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const store = require('./store');        // called through the namespace so tests can stub exports
const eventlog = require('./eventlog');
const { mapCwd } = require('./mod-sessions');

const DEFAULT_CAPTURE_QUIET_MS = 600000; // spec §4.7 — silence after a Stop before capture

const iso = (ms) => new Date(ms).toISOString();
const trimSlash = (p) => (p && p.length > 1 ? p.replace(/\/+$/, '') : p);

// §4.4's cursor key. A space separator is safe because a machine id never carries one and the
// sessionId is a uuid; the pair is the same identity every p5 derivation uses.
const cursorKey = (machine, sessionId) => `${machine} ${sessionId}`;

// ---- event folding ------------------------------------------------------------------------------
// One pass, in readEvents ORDER — ascending ts, ties broken by file offset — and NO re-sort:
// re-sorting here could only disagree with the ordering every other p5 derivation trusts, and a
// same-ms Stop/UserPromptSubmit pair would then flip which decisive event is newest. The last
// DECISIVE element a session contributes (Stop or UserPromptSubmit — see the header for why a
// trailing Notification must not count) is what the capture predicate reads; transcriptPath and
// cwd fold latest-wins over ALL events, the same rule mod-sessions :: foldSession applies, so
// §M1's "as mod-sessions folds it" is literally true.
const DECISIVE = new Set(['Stop', 'UserPromptSubmit']);

function newestBySession(events) {
  const by = new Map();
  for (const ev of events || []) {
    let s = by.get(ev.sessionId);
    if (!s) { s = { decisive: null, transcriptPath: null, cwd: null }; by.set(ev.sessionId, s); }
    if (DECISIVE.has(ev.event)) s.decisive = ev;
    if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath;
    if (ev.cwd) s.cwd = ev.cwd;
  }
  return by;
}

// ---- worktree lookup ----------------------------------------------------------------------------
// The worktree RECORD covering a cwd: longest path prefix on a segment boundary over
// state.repos[repo].worktrees[] — p5 trap 8's rule, reused. The boundary check is what stops
// `.claude/worktrees/p5` from claiming `.claude/worktrees/p51`.
//
// TRAP 13, the decoy this function exists to sidestep: mapCwd() also returns a field named
// `worktree`, and it is `target` — the trimmed cwd STRING itself, not a worktrees[] entry. A field
// of the right name, sitting exactly where an implementer would reach, carrying the wrong KIND of
// value: read it and every branch/head/dirty lookup silently nulls out or mis-keys. Only `repo` is
// taken from mapCwd; the record is found here, from the snapshot.
function findWorktree(worktrees, cwd) {
  if (!cwd || !Array.isArray(worktrees)) return null;
  const target = trimSlash(String(cwd).trim());
  if (!target) return null;
  let best = null;
  for (const w of worktrees) {
    if (!w || typeof w.path !== 'string' || !w.path.trim()) continue;
    const wp = trimSlash(w.path.trim());
    if (target !== wp && !target.startsWith(wp === '/' ? '/' : wp + path.sep)) continue;
    if (!best || trimSlash(best.path.trim()).length < wp.length) best = w;
  }
  return best;
}

// ---- field lookup -------------------------------------------------------------------------------
// §M1's table, exactly. Nulls are stated, never guessed: a mapped worktree that no longer exists
// in the snapshot is simply not found by the prefix scan, so branch/headSha/dirtyCount/unpushed
// are all null while repo keeps its mapped value. Nothing is inferred to fill them.
function gitFacts(cwd, config, state, aliases) {
  const out = { repo: null, branch: null, headSha: null, dirtyCount: null, unpushed: null };
  const repo = mapCwd(cwd || null, config || {}, aliases || {}).repo;   // ONLY repo — trap 13
  if (!repo) return out;                        // cwd maps to no configured repo — never a guess
  out.repo = repo;
  const r = state && state.repos ? state.repos[repo] : null;
  const wt = r ? findWorktree(r.worktrees, cwd) : null;
  if (!wt) return out;                          // no covering worktree -> all four git fields null
  out.branch = typeof wt.branch === 'string' && wt.branch ? wt.branch : null;  // null = detached HEAD
  out.headSha = wt.head == null ? null : wt.head;
  // staged + unstaged + untracked — all three counters, so a build that reads only one produces a
  // smaller number that a fixture with three distinct non-zero counts will catch.
  const d = wt.dirty;
  out.dirtyCount = d && typeof d === 'object'
    ? (Number(d.staged) || 0) + (Number(d.unstaged) || 0) + (Number(d.untracked) || 0)
    : null;
  if (out.branch && Array.isArray(r.branches)) {
    const b = r.branches.find((x) => x && x.name === out.branch);
    // null means UNKNOWN and stays null. Coercing it to 0 would publish "nothing to push" about a
    // branch p5 could not measure — exactly the false green the whole system forbids.
    out.unpushed = b && b.unpushed != null ? b.unpushed : null;
  }
  return out;
}

// ---- transcript title ---------------------------------------------------------------------------
// The LAST transcript record with type === "custom-title" AND a string customTitle — a session
// retitled twice carries several and the newest one is current. A record failing either condition
// is skipped, and an earlier qualifying one stands. Failure is a null, never a throw, and never a
// skipped observation: the git facts and the timestamp are knowable without the transcript.
async function readCustomTitle(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try { text = await fsp.readFile(transcriptPath, 'utf8'); } catch (_) { return null; }
  let title = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }    // a damaged line costs itself only
    if (obj && obj.type === 'custom-title' && typeof obj.customTitle === 'string') title = obj.customTitle;
  }
  return title;
}

// ---- cursor -------------------------------------------------------------------------------------
// Rebuild by MAX stopTs per (machine, sessionId). Max, not last-line-wins: a crash-repeated line
// (see the write order above) puts the same stopTs twice and an older line may sit later in the
// file after a partial restore — the greatest value is the one the cursor had reached.
async function rebuildCursor(observationsPath) {
  const captured = {};
  let text;
  try { text = await fsp.readFile(observationsPath, 'utf8'); } catch (_) { return { v: 1, captured }; }
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!obj || typeof obj.machine !== 'string' || typeof obj.sessionId !== 'string') continue;
    const ts = Number(obj.stopTs);
    if (!Number.isFinite(ts)) continue;
    const key = cursorKey(obj.machine, obj.sessionId);
    if (!(key in captured) || captured[key] < ts) captured[key] = ts;
  }
  return { v: 1, captured };
}

// Missing and unreadable take the same road — rebuild. A corrupt cache and a lost one have the
// same safe answer (§4.4: at worst one repeated line, never a lost one), and refusing to capture
// until a human repairs a cache would be the wrong failure direction.
async function loadCursor(cursorPath, observationsPath) {
  const r = await store.readJson(cursorPath, null);
  const v = r.ok && !r.missing ? r.value : null;
  if (v && typeof v === 'object' && !Array.isArray(v)
      && v.captured && typeof v.captured === 'object' && !Array.isArray(v.captured)) {
    return { v: 1, captured: Object.assign({}, v.captured) };
  }
  return rebuildCursor(observationsPath);
}

// ---- entry --------------------------------------------------------------------------------------
async function sweepStopCapture(opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const config = o.config || {};
  const aliases = o.aliases || {};
  const dir = (o.paths && o.paths.dir) || o.radarDir || process.env.RADAR_DIR || store.defaultRadarDir();
  const eventsDir = (o.paths && o.paths.events) || eventlog.eventsDir(dir);
  const observationsPath = (o.paths && o.paths.observations) || path.join(dir, 'observations.jsonl');
  const cursorPath = (o.paths && o.paths.cursor) || path.join(dir, 'handoffs', 'capture-cursor.json');
  const machine = o.machine || config.collectorId || os.hostname();
  const quietRaw = Number(config.captureQuietMs);
  const quietMs = Number.isFinite(quietRaw) ? quietRaw : DEFAULT_CAPTURE_QUIET_MS;

  // The current published snapshot: handed in by the sweep, or read off disk when absent. A
  // missing snapshot degrades to null git fields, never to a skipped capture — the timestamped
  // sighting is worth writing even when the git facts are unknowable.
  let state = o.state;
  if (state === undefined) {
    const r = await store.readJson((o.paths && o.paths.state) || path.join(dir, 'state.json'), null);
    state = r.ok ? r.value : null;
  }

  // The same retained window every p5 reader folds; the log itself is pruned at this horizon.
  const { events } = await eventlog.readEvents({ eventsDir, since: now - eventlog.RETENTION_MS });
  const sessions = newestBySession(events);
  const cursor = await loadCursor(cursorPath, observationsPath);

  const captured = [];
  const warnings = [];
  for (const [sessionId, s] of sessions) {
    const dec = s.decisive;
    if (!dec || dec.event !== 'Stop') continue;                // conjunct 1 — newest DECISIVE event
    if (now - dec.ts < quietMs) continue;                      // conjunct 2 — the STOP's clock
    const key = cursorKey(machine, sessionId);
    if (cursor.captured[key] === dec.ts) continue;             // conjunct 3 — already captured

    const facts = gitFacts(s.cwd, config, state, aliases);
    const customTitle = await readCustomTitle(s.transcriptPath);
    const line = {                                             // §4.5's fields, in §4.5's order
      machine,
      sessionId,
      stopTs: dec.ts,                                          // the STOP's hook-receiver ms clock
      at: iso(now),
      repo: facts.repo,
      branch: facts.branch,
      headSha: facts.headSha,
      dirtyCount: facts.dirtyCount,
      unpushed: facts.unpushed,
      transcriptPath: s.transcriptPath,
      customTitle,
    };
    try {
      // Line first, cursor second — see the header. Both queued; the sequential awaits keep the
      // order on the store's single chain. A cursor advanced past an unappended line is the one
      // state this module may never produce.
      await store.appendLine(observationsPath, line);
      cursor.captured[key] = dec.ts;
      await store.writeJsonAtomic(cursorPath, cursor);
      captured.push(line);
    } catch (e) {
      // One session's failed write neither blocks the others nor advances the on-disk cursor: the
      // next sweep retries this capture from scratch, and a repeat costs one duplicate line at
      // worst — the recoverable side of the crash boundary, by design.
      warnings.push(`stop-capture ${key}: ${e && e.message ? e.message : String(e)}`);
    }
  }

  return { captured, warnings };
}

module.exports = {
  sweepStopCapture,
  newestBySession, findWorktree, gitFacts, readCustomTitle,
  loadCursor, rebuildCursor, cursorKey,
  DECISIVE, DEFAULT_CAPTURE_QUIET_MS,
};
