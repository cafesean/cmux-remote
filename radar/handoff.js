'use strict';
// p6 — the handoff protocol core: preview, commit, spawn, lifecycle, recovery (specs §M2–§M4).
//
// ONE WRITER, ONE AUTHORITY. Every mutation here happens in the radar server process on
// radar/store.js's queue, and `handoffs/ledger.jsonl` is the only durable handoff state (§3).
// The in-memory index/lock/claim tables are the DERIVED AUTHORITY every rule reads; index.json
// and locks.json are published output that is never read back — reading them back would
// reintroduce the append/publish crash boundary §3 removes.
//
// THE QUEUE IS NOT RE-ENTRANT (§9 trap 14, measured). store.enqueue sets chain = p.then(...)
// where p is the running slot, so a nested enqueue awaited from inside a slot waits on its own
// caller forever — no error, no timeout. Every append made while holding a slot therefore uses
// appendLineUnqueued; appendLine (queued) is reserved for callers that own NO slot (the sweep,
// which runs on the session sweep and never holds one).
//
// ABSENCE IS IDENTITY, NOT A PID TREE (§9 trap 15, measured). child.pid is the /usr/bin/script
// leader; the claude worker is a different process in a DIFFERENT process group, so killing the
// leader can leave the worker alive with its group unreachable. Absence over the dispatch set
// requires ALL of: no process whose argv carries the sessionUuid, every persisted observedPid
// absent (each pinned by its lstart), and the leader gone.
//
// A DELIVERED SIGNAL CANNOT BE UN-SENT (§9 trap 16). A recovery press appends a `recovery-op`
// record BEFORE any signal, membership of an open op is the fifth conjunct of the undecidable
// condition, and closure is on SETTLED via §M4's member table — never on "every member reached
// `discarded`", which a self-resolved member would keep open forever.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');

const store = require('./store');
const hk = require('./handoff-keys');
const eventlog = require('./eventlog');
const { normalizeConfig } = require('./config');

// §4.8 fixes this at 131072; preview must PROVE compliance while the plan is still reversible.
const LINE_MAX = 131072;

// §7.2 — a fixed normative string, rendered by the sheet byte for byte. U4's hunt is a
// measurement, not a branch: whatever it finds, this ships unchanged in v1. The sentence is the
// PLAIN TEXT (334 bytes): the spec renders it with markdown emphasis, but emphasis is the spec
// document's formatting — a constant carrying `**` would print literal asterisks on every surface.
const SAFETY_NOTICE = 'The session is instructed to inspect and plan only on its first turn, and to ask before modifying, committing, pushing, merging or deleting anything. It runs without --dangerously-skip-permissions, so Claude\'s own permission prompts still apply — but your existing allowlists may already permit some commands. This is not a sandbox.';

// §6.8 — p6's entire contribution to the seed: exactly one appended line (108 bytes; its
// separator newline makes 109, so the largest acceptable override is seedMaxBytes - 109).
const FIRST_TURN_LINE = 'FIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until Sean replies.';

// §M2 — the literal wrapper body. The binary travels as $1, a POSITIONAL parameter, because the
// scrub unsets ^(CLAUDE|CMUX|AI_AGENT|GHOSTTY) and that includes CLAUDE_BIN — a wrapper reading
// the binary from the environment erases it before the exec (§9 trap 11). Absolute paths only:
// a PATH shim survives spawn and can fabricate output (§9 trap 10).
const WRAPPER = [
  'for v in $(/usr/bin/env | /usr/bin/grep -iE "^(CLAUDE|CMUX|AI_AGENT|GHOSTTY)" | /usr/bin/cut -d= -f1); do',
  '  unset "$v"',
  'done',
  'exec /usr/bin/script -q /dev/null "$1" "${@:2}"',
].join('\n');

// §7.1 — one fixed English sentence per code, so the sheet and the CLI render server text rather
// than inventing their own. The two inherited 401 envelopes (unauthorized, token_in_url) belong
// to server.js/radar-server.js and deliberately carry no message; they are not p6's to define.
const ERROR_MESSAGES = {
  bad_json: 'The request body is not valid JSON.',
  invalid_request: 'A request field is missing or malformed.',
  body_too_large: 'The request body exceeds the size limit.',
  seed_too_large: 'The seed text exceeds the configured size cap.',
  plan_too_large: 'The plan cannot be recorded within the ledger line limit.',
  selector_unresolved: 'The selection names nothing on the current board; change the selection and try again.',
  workdir_unresolved: 'The working directory for this selection does not exist.',
  claude_bin_missing: 'The configured claude binary does not exist or is not executable.',
  claude_bin_unusable: 'The configured claude binary did not answer --version.',
  no_snapshot: 'No radar snapshot exists yet; run a scan first.',
  viewer_readonly: 'This server is a viewer; handoffs dispatch only on the leader.',
  preview_not_found: 'The preview no longer exists; compose the selection again.',
  preview_expired: 'The preview expired; compose the selection again.',
  hash_mismatch: 'The plan on disk does not match the hash you confirmed; preview again.',
  idempotency_key_reused: 'This idempotency key was already used for a different request.',
  in_flight: 'This exact request is already executing.',
  request_incomplete: 'A previous attempt of this request did not complete; preview again.',
  facts_locked: 'Part of this selection is already held by a live handoff.',
  ledger_write_failed: 'The handoff ledger could not be written; nothing was changed.',
  seed_write_failed: 'The seed file could not be written; nothing was dispatched.',
  spawn_failed: 'The session process could not be started.',
  spawn_unrecorded: 'The session process could not be recorded and was terminated.',
  not_recoverable: 'The undecidable set changed; there is nothing left to recover.',
  handoff_not_found: 'No handoff exists with that id.',
};

const LIVE = new Set(['pending', 'launching', 'active', 'quiet', 'unconfirmed']);
const TERMINAL = new Set(['resolved', 'abandoned', 'discarded']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const IDEM_RE = /^[A-Za-z0-9_-]{1,128}$/;

// §6.3 — Claude Code's own ~/.claude/projects rule, read, never invented.
const slugifyPath = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

const selectionSlug = (selectors) => selectors.join('-').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// os.homedir() already prefers $HOME on POSIX; stating it here makes the seam explicit — the
// harness redirects ~ by exporting HOME, never by touching the real ~/.claude.
const home = () => process.env.HOME || os.homedir();

const iso = (ms) => new Date(ms).toISOString();

// h-<UTC yyyymmdd-hhmm>-<previewId.slice(0,6)> (§6.3)
function mintHandoffId(nowMs, previewId) {
  const d = iso(nowMs);
  return `h-${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 16).replace(':', '')}-${previewId.slice(0, 6)}`;
}

// §M2's one capture shape: /bin/ps -axww -o pid=,ppid=,lstart=,command=. `ppid` is not optional —
// the descent leg needs it. lstart is "EEE MMM d HH:mm:ss yyyy"; the row regex keeps the original
// spacing so the stored psStartedAt compares BYTE-identically.
const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

function parsePsCapture(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = PS_ROW_RE.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), lstart: m[3].trim(), command: m[4] });
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return { ok: rows.length > 0, rows, byPid };
}

const execFileP = (bin, args, opts) => new Promise((resolve) => {
  childProcess.execFile(bin, args, Object.assign({ maxBuffer: 16 * 1024 * 1024 }, opts),
    (err, stdout) => resolve({ err: err || null, stdout: String(stdout || '') }));
});

// §M2 — bridgeSessionId is the LAST session_… on a line containing `Remote Control active`,
// matched after stripping \r: logPath is a pty capture, lines end \r\n (§9 trap 12).
function extractBridgeSessionId(text) {
  let found = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r/g, '');
    if (!line.includes('Remote Control active')) continue;
    const ids = line.match(/session_[A-Za-z0-9]+/g);
    if (ids && ids.length) found = ids[ids.length - 1];
  }
  return found;
}

// A stored fact key maps back to exactly one selector, which is how "is this key still minted by
// the snapshot?" is answered with the SAME resolver reservation used — no second minting rule.
function selectorOfFactKey(key) {
  const parts = String(key).split(':');
  switch (parts[0]) {
    case 'branch': return `branch:${parts[1]}:${parts[2]}`;
    case 'wt': return `wt:${parts[1]}`;
    case 'orphan': return key;
    case 'epic': return `epic:${parts[1]}`;
    default: return null;
  }
}

// §M3 — which sources a fact key derives from. `resolved` is decided by facts being ABSENT, and
// absence is exactly what a broken collector produces, so the health test covers every source
// that could mint the key. Orphan provenance is config+git ONLY — requiring jira/specs would
// freeze every orphan handoff whenever an optional source is disabled.
function sourcesOfFactKey(key) {
  return String(key).startsWith('epic:') ? ['config', 'git', 'deploy'] : ['config', 'git'];
}

function createHandoff(opts) {
  const o = opts || {};
  const dir = o.dir || store.defaultRadarDir();
  // Config is re-read at every natural boundary — sweep start, preview entry, commit entry,
  // startup — matching the collector's per-scan re-read, so an operator edit to goneGraceMs /
  // confirmMs / claudeBin / polyrepoRoot takes effect without a restart. Boot-once was a silent
  // failure: "why did my claudeBin change do nothing" had no visible signal. The injected
  // `o.config` object stays the test seam AND the bare-install fallback: it governs exactly while
  // no config.json exists on disk. A config.json that stops PARSING keeps the last good config —
  // a broken edit must not silently flip every threshold to its default mid-flight.
  const bootConfig = o.config || {};
  const configPath = o.configPath || path.join(dir, 'config.json');
  let activeConfig = bootConfig;
  async function refreshConfig() {
    const read = await store.readJson(configPath, undefined);
    if (read.ok && !read.missing) activeConfig = normalizeConfig(read.value).config;
    else if (read.missing) activeConfig = bootConfig;
    // read error: keep the previous activeConfig, unchanged
    return activeConfig;
  }
  const getState = o.getState || (() => null);
  const now = o.now || (() => Date.now());
  const spawn = o.spawn || childProcess.spawn;
  // Injectable seams beyond the contract's five, each defaulting to the real thing. `ps` returns
  // the RAW capture text of §M3's one command; `kill` is process.kill; `log` matches
  // radar-server's convention; `buildBrief` is radar-cli's one assembler (lazy-required so the
  // CLI and this module never form a load cycle).
  const kill = o.kill || ((pid, sig) => process.kill(pid, sig));
  const ps = o.ps || (async () => {
    const r = await execFileP('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,command=']);
    if (r.err) throw r.err;
    return r.stdout;
  });
  const log = o.log || ((...a) => console.error(...a));
  const buildBrief = o.buildBrief || ((state, selectors, opts2) => require('./radar-cli').buildBrief(state, selectors, opts2));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const handoffsDir = path.join(dir, 'handoffs');
  const ledgerPath = path.join(handoffsDir, 'ledger.jsonl');
  const previewsDir = path.join(handoffsDir, 'previews');
  const indexPath = path.join(handoffsDir, 'index.json');
  const locksPath = path.join(handoffsDir, 'locks.json');

  // Config reads are late-bound against the CURRENT config (refreshed at the boundaries above) so
  // both an operator edit and a test adjusting a threshold between calls take effect; every
  // default is §4.7's (normalizeConfig already clamps, so no clamping is repeated here — one
  // answer to what happens to a bad value).
  const cfg = (k, dflt) => (activeConfig[k] == null ? dflt : activeConfig[k]);
  const confirmMs = () => cfg('confirmMs', 20000);
  const goneGraceMs = () => cfg('goneGraceMs', 600000);
  const sessionQuietMs = () => cfg('sessionQuietMs', 1800000);
  const discardKillMs = () => cfg('discardKillMs', 5000);
  const previewTtlMs = () => cfg('previewTtlMs', 120000);
  const seedMaxBytes = () => cfg('seedMaxBytes', 12288);

  // ---- the derived authority (§3): rebuilt from the ledger, updated on every append ------------
  const index = new Map();        // handoffId -> entry
  const claims = new Map();       // "<machine> <idempotencyKey>" -> claim
  const locks = new Map();        // factKey -> handoffId
  const ops = [];                 // recovery-op records, openness DERIVED per §M4
  const executing = new Set();    // §M2 rule 1: 409 in_flight is decided from THIS set, in memory
  let undecidable = [];           // handoffIds, recomputed each sweep (liveness needs a capture)
  let repairLogged = false;

  const ck = (machine, idem) => `${machine} ${idem}`;
  const machineId = () => {
    const s = getState();
    return (s && s.collectorId) || cfg('collectorId', null) || os.hostname();
  };

  const incident = (code, detail) => {
    const id = crypto.randomUUID();
    // §7.3 — the withheld detail lives in the server log, one line keyed by the id, NEVER in a
    // response body. A developer greps a log; Sean presses one button.
    log(`[radar] handoff incident ${id} ${code}: ${JSON.stringify(detail)}`);
    return id;
  };
  const err = (status, code, extra) => ({
    status,
    body: Object.assign({ error: code, message: ERROR_MESSAGES[code] }, extra || {}),
  });
  const invalid = (field, reason) => err(400, 'invalid_request', { field, reason });

  // ---- ledger fold --------------------------------------------------------------------------------
  function applyRecord(rec) {
    switch (rec.t) {
      case 'claim': {
        claims.set(ck(rec.machine, rec.idempotencyKey), {
          machine: rec.machine, idempotencyKey: rec.idempotencyKey,
          requestFingerprint: rec.requestFingerprint, previewId: rec.previewId, hash: rec.hash,
          state: 'in_progress', status: null, body: null,
        });
        break;
      }
      case 'intent': {
        const plan = rec.plan;
        index.set(rec.id, {
          id: rec.id, plan,
          selectors: plan.selectors, factKeys: plan.factKeys,
          machine: plan.machine, sessionId: plan.sessionUuid,
          idempotencyKey: rec.idempotencyKey,
          status: 'pending', pid: null, psStartedAt: null, observedPids: [],
          bridgeSessionId: null,
          dispatchedAt: rec.at, confirmedAt: null, unconfirmedAt: null, terminalAt: null,
          lastObservationAt: rec.at, pidGoneSince: null,
        });
        // §4.3 rebuild rule: every intent with no later terminal status holds every key.
        for (const k of plan.factKeys) locks.set(k, rec.id);
        break;
      }
      case 'process': {
        const e = index.get(rec.id);
        if (!e) break;
        if (e.pid == null && rec.pid != null) { e.pid = rec.pid; e.psStartedAt = rec.psStartedAt == null ? null : rec.psStartedAt; }
        // Delta records; the effective set is the UNION over every process record — it only grows,
        // so a reparented worker cannot leave it (§M2).
        for (const op of (rec.observedPids || [])) {
          if (!e.observedPids.some((x) => x.pid === op.pid)) e.observedPids.push({ pid: op.pid, lstart: op.lstart == null ? null : op.lstart });
        }
        if (e.status === 'pending') e.status = 'launching';
        break;
      }
      case 'status': {
        const e = index.get(rec.id);
        if (!e) break;
        e.status = rec.to;
        if (rec.to === 'active' && !e.confirmedAt) e.confirmedAt = rec.at;
        if (rec.to === 'unconfirmed' && !e.unconfirmedAt) e.unconfirmedAt = rec.at;
        if (rec.detail && typeof rec.detail.bridgeSessionId === 'string') e.bridgeSessionId = rec.detail.bridgeSessionId;
        if (TERMINAL.has(rec.to) && !e.terminalAt) {
          e.terminalAt = rec.at;
          // §4.3 — the release. Only a terminal status ever frees a key.
          for (const k of e.factKeys) if (locks.get(k) === e.id) locks.delete(k);
        }
        break;
      }
      case 'result': {
        const key = ck(rec.machine, rec.idempotencyKey);
        const c = claims.get(key) || { machine: rec.machine, idempotencyKey: rec.idempotencyKey, requestFingerprint: null, previewId: null };
        c.state = 'complete'; c.status = rec.status; c.body = rec.body;
        claims.set(key, c);
        break;
      }
      case 'recovery-op': {
        ops.push({ opId: rec.opId, op: rec.op, ids: (rec.ids || []).slice(), token: rec.token });
        break;
      }
      default: break;   // unknown record types are skipped, never fatal — forward compatibility
    }
  }

  async function appendApplyUnq(rec) {
    await store.appendLineUnqueued(ledgerPath, rec);
    applyRecord(rec);
  }
  // Sweep-side appends own NO queue slot, so the QUEUED form is correct there — the mirror image
  // of commit, which holds a slot and must use the unqueued form (§9 trap 14).
  async function appendApplyQ(rec) {
    await store.appendLine(ledgerPath, rec);
    applyRecord(rec);
  }

  const statusRec = (id, from, to, reason, detail) => ({ t: 'status', at: iso(now()), id, from, to, reason, detail: detail || {} });

  // §4.8 tail repair: a host crash mid-write can leave a partial final line. A line that does not
  // parse is not a record — skipped forever, one '\n' appended so the next append cannot fuse
  // onto it. A line that parses but lost its newline IS a record (indistinguishable from a normal
  // one later), accepted, newline restored. Nothing is rewritten, nothing deleted.
  async function loadLedger() {
    let text;
    try { text = await fsp.readFile(ledgerPath, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return;
      log(`[radar] handoff ledger unreadable: ${e.message}`);
      return;
    }
    if (text === '') return;
    const endsNl = text.endsWith('\n');
    const lines = text.split('\n');
    if (endsNl) lines.pop();
    let needRepair = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '') continue;
      let rec = null;
      try { rec = JSON.parse(lines[i]); } catch (_) { rec = null; }
      const isFinal = i === lines.length - 1;
      if (rec === null) {
        if (!repairLogged) { log(`[radar] handoff ledger: skipped unparseable line ${i + 1}`); repairLogged = true; }
        if (isFinal && !endsNl) needRepair = true;
        continue;
      }
      applyRecord(rec);
      if (isFinal && !endsNl) {
        if (!repairLogged) { log('[radar] handoff ledger: final line had no newline; repaired'); repairLogged = true; }
        needRepair = true;
      }
    }
    if (needRepair) {
      // The one-byte repair. Filehandle write, not a store primitive: the store has no "append a
      // raw byte" and MUST not — a bare newline is not a record. This appends, never rewrites.
      const fh = await fsp.open(ledgerPath, 'a');
      try { await fh.write('\n'); await fh.sync(); } finally { await fh.close(); }
    }
  }

  // ---- published output (§3): written after appends, NEVER read back ---------------------------
  const sortedEntries = () => [...index.values()].sort((a, b) =>
    (a.dispatchedAt < b.dispatchedAt ? 1 : a.dispatchedAt > b.dispatchedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const indexEntry = (e) => ({
    id: e.id, status: e.status, selectors: e.selectors, factKeys: e.factKeys, plan: e.plan,
    pid: e.pid, psStartedAt: e.psStartedAt, observedPids: e.observedPids,
    sessionId: e.sessionId, machine: e.machine, bridgeSessionId: e.bridgeSessionId,
    dispatchedAt: e.dispatchedAt, confirmedAt: e.confirmedAt, unconfirmedAt: e.unconfirmedAt,
    terminalAt: e.terminalAt, lastObservationAt: e.lastObservationAt, pidGoneSince: e.pidGoneSince,
  });

  async function republishUnqueued() {
    // A failed republication is logged and retried on the next append; it changes no decision, so
    // it is not a crash boundary (§3).
    try {
      await store.writeJsonAtomicUnqueued(indexPath, { v: 1, handoffs: sortedEntries().map(indexEntry) });
      await store.writeJsonAtomicUnqueued(locksPath, { v: 1, locks: Object.fromEntries([...locks.entries()].sort()) });
    } catch (e) {
      log(`[radar] handoff cache republication failed (retried on next append): ${e.message}`);
    }
  }

  async function deletePreview(previewId) {
    if (!previewId || !UUID_RE.test(previewId)) return;
    try { await fsp.unlink(path.join(previewsDir, `${previewId}.json`)); } catch (e) {
      if (!e || e.code !== 'ENOENT') log(`[radar] preview delete failed (expiry scan will retry): ${e.message}`);
    }
  }

  // ---- claims -------------------------------------------------------------------------------------
  // A request that OWNS a claim appends a result carrying exactly its response, in the same queue
  // slot, and deletes the preview (§M2). This helper IS that rule; everything that owns no claim
  // simply never calls it.
  async function settleClaimUnq(machine, idempotencyKey, status, body, previewId) {
    const rec = { t: 'result', at: iso(now()), machine, idempotencyKey, status, body, claimState: 'complete' };
    await store.appendLineUnqueued(ledgerPath, rec);
    applyRecord(rec);
    await deletePreview(previewId);
  }

  // ---- liveness (§M3) ----------------------------------------------------------------------------
  async function takeCapture() {
    try {
      const text = await ps();
      const cap = parsePsCapture(text);
      return cap.ok ? cap : { ok: false, rows: [], byPid: new Map() };  // empty output = unhealthy, never absent
    } catch (_) {
      return { ok: false, rows: [], byPid: new Map() };
    }
  }

  // 'alive' | 'absent' | 'unhealthy'. Absence requires ALL THREE legs gone — no single-pid
  // observation can release a key, and a reparented worker cannot leave the set (§M3).
  function liveness(e, capture) {
    if (!capture || !capture.ok) return 'unhealthy';
    // Leg 1 — identity. Exact: radar minted the uuid, the wrapper delivers --session-id verbatim,
    // and a reused pid cannot carry a uuid minted for another handoff, so no lstart pin is needed.
    if (e.sessionId && capture.rows.some((r) => r.command.includes(e.sessionId))) return 'alive';
    // Leg 2 — the persisted observed set, each entry pinned by lstart. A null lstart entry counts
    // alive on pid presence alone — the leader's documented rule, mirrored: it preserves a
    // suppression and delays a release, the safe direction.
    for (const op2 of e.observedPids) {
      const row = capture.byPid.get(op2.pid);
      if (row && (op2.lstart == null || row.lstart === op2.lstart)) return 'alive';
    }
    // Leg 3 — the leader.
    let leaderGone = e.pid == null;
    if (e.pid != null) {
      try {
        kill(e.pid, 0);
        if (e.psStartedAt == null) return 'alive';          // documented accepted risk: pid alone
        const row = capture.byPid.get(e.pid);
        if (row && row.lstart === e.psStartedAt) return 'alive';
        leaderGone = true;                                   // pid exists but is a RECYCLED number
      } catch (ex) {
        if (ex && ex.code === 'EPERM') return 'alive';       // exists, not ours
        if (!ex || ex.code !== 'ESRCH') return 'unhealthy';  // an unreadable process table must
        leaderGone = true;                                   // never look like a dead dispatch
      }
    }
    return leaderGone ? 'absent' : 'alive';
  }

  // The pids a discard signals: identity re-checked against the CURRENT capture immediately before
  // each round. The lstart pin makes LIVENESS reuse-safe, not signalling — the residual window
  // between this check and the kill syscall is accepted explicitly (§M2).
  function dispatchPids(e, capture) {
    const out = new Set();
    if (capture && capture.ok) {
      for (const r of capture.rows) if (e.sessionId && r.command.includes(e.sessionId)) out.add(r.pid);
      for (const op2 of e.observedPids) {
        const row = capture.byPid.get(op2.pid);
        if (row && (op2.lstart == null || row.lstart === op2.lstart)) out.add(op2.pid);
      }
      if (e.pid != null) {
        const row = capture.byPid.get(e.pid);
        if (row && (e.psStartedAt == null || row.lstart === e.psStartedAt)) out.add(e.pid);
      }
    }
    out.delete(process.pid);   // never the server itself, whatever a capture claims
    out.delete(0); out.delete(1);
    return [...out];
  }

  // Legs 2+3 discovery: every pid observed via identity or ppid-descent is PERSISTED as a delta
  // process record, because when the leader dies its children reparent to pid 1 and the closure
  // no longer finds them — the measured scenario this whole design exists for (§M2).
  async function observeNewPids(e, capture, append) {
    if (!capture.ok || e.pid == null) return;
    const known = new Set(e.observedPids.map((x) => x.pid));
    known.add(e.pid);
    const found = [];
    for (const r of capture.rows) {
      if (e.sessionId && r.command.includes(e.sessionId) && !known.has(r.pid)) { found.push({ pid: r.pid, lstart: r.lstart }); known.add(r.pid); }
    }
    // ppid-closure rooted at the leader — valid only while the leader lives.
    if (capture.byPid.has(e.pid)) {
      const queue = [e.pid];
      while (queue.length) {
        const parent = queue.shift();
        for (const r of capture.rows) {
          if (r.ppid === parent) {
            queue.push(r.pid);
            if (!known.has(r.pid)) { found.push({ pid: r.pid, lstart: r.lstart }); known.add(r.pid); }
          }
        }
      }
    }
    if (!found.length) return;
    try {
      const rec = { t: 'process', at: iso(now()), id: e.id, pid: e.pid, psStartedAt: e.psStartedAt, observedPids: found };
      await append(rec);
      // FOLD AFTER APPEND, always — the in-memory index is the derived authority (§3) and every
      // rule reads it. Skipping this fold left e.observedPids empty until a restart refolded the
      // ledger: the identical delta re-appended every sweep (§4.1 requires deltas), and the
      // persisted-{pid,lstart} liveness leg never fired LIVE — a worker whose argv lost the uuid
      // read absent and its keys released while it ran, the §4.3 direction. Found by the S-004
      // evidence run, not by the unit suite.
      applyRecord(rec);
    } catch (ex) {
      log(`[radar] observed-pid persist failed for ${e.id}: ${ex.message}`);
    }
  }

  // ---- fact-key world checks ---------------------------------------------------------------------
  // CIRCULARITY GUARD (§4.3 vs §6.6): an existence check must read the FACT BASE, never the
  // published attention[]. Suppression removes an orphan's attention item precisely BECAUSE this
  // handoff holds its key — resolving the key through keysForSelector's attention[] read would
  // then report the fact "absent" one sweep after dispatch, settle `resolved`, and release the
  // keys of a live worker: the one direction §4.3 forbids, arriving through our own output.
  // Orphan presence is therefore minted from state.repos — a non-default branch with no epic and
  // a matching name, the same predicate derive.js uses to build the item. branch:/wt:/epic: keys
  // already resolve through state.repos/state.epics, which suppression deliberately leaves intact;
  // attention[] remains correct for SELECTION (§6.2 — you select what is on the board), which is
  // why keysForSelector itself is untouched.
  const keyStillMinted = (state, key) => {
    if (String(key).startsWith('orphan:')) {
      const p = hk.parseSelector(key);       // an orphan KEY has the orphan SELECTOR's shape
      if (!p.ok) return false;
      const repo = (state.repos || {})[p.segs[0]];
      return !!(repo && (repo.branches || []).some((b) => b && b.name === p.segs[1] && !b.epic && !b.isDefault));
    }
    const sel = selectorOfFactKey(key);
    return sel != null && hk.keysForSelector(state, sel).includes(key);
  };
  const allFactsAbsent = (state, factKeys) => factKeys.every((k) => !keyStillMinted(state, k));

  // §M3 row 1 — per-fact-key source health, the union over the handoff's keys, plus sessions.
  // Only `ok` is healthy; the real vocabulary is ok|stale|error|disabled (`partial` is a
  // ladder-cell state, not a source status, and never appears here).
  function sourcesUnhealthy(e, state) {
    if (!state || !state.sources) return true;
    const need = new Set(['sessions']);
    for (const k of e.factKeys) for (const s of sourcesOfFactKey(k)) need.add(s);
    for (const s of need) {
      const src = state.sources[s];
      if (!src || src.status !== 'ok') return true;
    }
    return false;
  }

  function statTranscript(e) {
    try {
      const st = fs.statSync(e.plan.transcriptPath);
      return { exists: true, mtimeMs: st.mtimeMs, error: null };
    } catch (ex) {
      if (ex && ex.code === 'ENOENT') return { exists: false, mtimeMs: null, error: null };
      return { exists: false, mtimeMs: null, error: ex };   // a post-confirmation EACCES is row 1
    }
  }

  async function readBridgeSessionId(e) {
    try { return extractBridgeSessionId(await fsp.readFile(e.plan.logPath, 'utf8')); } catch (_) { return null; }
  }

  // §7.1 validation steps 3–4: not an object, then unknown fields — refused, never ignored, and
  // BEFORE per-field checks, so a body smuggling seed bytes into commit reports the unknown field.
  function shapeCheck(args, allowed) {
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      return invalid('', 'not_an_object');
    }
    for (const k of Object.keys(args || {})) if (!allowed.includes(k)) return invalid(k, 'unknown_field');
    return null;
  }

  // §6.5 / §4.5 — observations.jsonl, read for the seed's lastObservedBy lines. The same file the
  // CLI's brief path loads; an absent file is NO relation, never an error, and a truncated final
  // line costs exactly that one line (the eventlog rule, applied to radar's own NDJSON).
  async function readObservations() {
    let text;
    try { text = await fsp.readFile(path.join(dir, 'observations.jsonl'), 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* half-written tail — skip one line */ }
    }
    return out;
  }

  // ---- preview (§M2) ------------------------------------------------------------------------------
  function validateSelectorsField(selectors) {
    if (selectors === undefined) return invalid('selectors', 'required');
    if (!Array.isArray(selectors)) return invalid('selectors', 'not_an_array');
    if (selectors.length === 0) return invalid('selectors', 'empty');
    if (selectors.length > 64) return invalid('selectors', 'too_many');
    for (const s of selectors) {
      if (typeof s !== 'string') return invalid('selectors', 'not_a_string');
      const t = s.trim();
      if (t.length === 0) return invalid('selectors', 'empty');
      if (Buffer.byteLength(t, 'utf8') > 512) return invalid('selectors', 'too_long');
    }
    return null;
  }

  function reposForSelector(state, sel) {
    const p = hk.parseSelector(sel);
    if (!p.ok) return [];
    const [a] = p.segs;
    const out = new Set();
    const repos = state.repos || {};
    switch (p.kind) {
      case 'branch': case 'orphan': out.add(p.segs[0]); break;
      case 'epic':
        for (const [rid, repo] of Object.entries(repos)) {
          if ((repo.branches || []).some((b) => b.epic === a)) out.add(rid);
          for (const w of (repo.worktrees || [])) if (hk.epicOfWorktree(state, rid, w) === a) out.add(rid);
        }
        break;
      case 'wt':
        for (const [rid, repo] of Object.entries(repos)) if ((repo.worktrees || []).some((w) => w.path === a)) out.add(rid);
        break;
      case 'worktrees':
        for (const [rid, repo] of Object.entries(repos)) if ((repo.worktrees || []).some((w) => w.stale)) out.add(rid);
        break;
      case 'orphans':
        for (const it of hk.flattenAttention(state.attention)) if (it.type === 'orphan') out.add(it.repo);
        break;
      default: break;
    }
    return [...out];
  }

  async function preview(args) {
    await refreshConfig();                 // request boundary: operator edits apply, no restart
    const a = args || {};
    const shape = shapeCheck(args, ['selectors', 'seedOverride']);
    if (shape) return shape;
    const bad = validateSelectorsField(a.selectors);
    if (bad) return bad;
    if (a.seedOverride !== undefined && typeof a.seedOverride !== 'string') return invalid('seedOverride', 'not_a_string');

    const { selectors, malformed } = hk.normalizeSelectors(a.selectors);
    if (malformed.length) return invalid('selectors', 'malformed_selector');

    const state = getState();
    if (!state) return err(503, 'no_snapshot');

    // Unresolved is ALL-OR-NOTHING and NON-ENUMERATING (§6.1): the body names no selector; the
    // offending list goes to the server log under the incidentId. A body that lists them is the
    // chore §7.3 forbids.
    const fk = hk.factKeys(state, selectors);
    if (fk.unresolved.length) {
      return err(422, 'selector_unresolved', { incidentId: incident('selector_unresolved', { selectors: fk.unresolved }) });
    }

    // Workdir: ALWAYS polyrepoRoot, even when the selection resolves to a single repo. The owner
    // runs every session from the polyrepo root so all transcripts land in ONE project folder;
    // a per-repo workdir would scatter them per repo. The seed names the repo, and the session
    // cds itself. Unconfigured polyrepoRoot is an honest 422, never a guessed path.
    const workdir = cfg('polyrepoRoot', null);
    let workdirOk = false;
    try { workdirOk = workdir != null && fs.statSync(workdir).isDirectory(); } catch (_) { workdirOk = false; }
    if (!workdirOk) return err(422, 'workdir_unresolved', { workdir: workdir == null ? '' : workdir });

    const claudeBin = cfg('claudeBin', null) || path.join(home(), '.local', 'bin', 'claude');
    try { fs.accessSync(claudeBin, fs.constants.X_OK); } catch (_) {
      return err(422, 'claude_bin_missing', { path: claudeBin });
    }
    const ver = await execFileP(claudeBin, ['--version'], { timeout: 15000 });
    const claudeVersion = ver.stdout.trim();
    if (ver.err || !claudeVersion) {
      return err(422, 'claude_bin_unusable', { path: claudeBin, detail: ver.err ? String(ver.err.message || ver.err) : 'empty --version output' });
    }

    // §6.8 — the seed, cap measured on the bytes that will be DELIVERED, appended line included.
    // buildBrief reads the §6.5 lastObservedBy relation from opts.observations; without this the
    // seed — the one consumer that matters — would render `origin unknown` on every dispatch.
    const base = typeof a.seedOverride === 'string'
      ? a.seedOverride
      : buildBrief(state, selectors, { observations: await readObservations() }).text;
    const seedText = base + '\n' + FIRST_TURN_LINE;
    if (Buffer.byteLength(seedText, 'utf8') > seedMaxBytes()) {
      return err(413, 'seed_too_large', { limit: seedMaxBytes() });
    }

    const t = now();
    const previewId = crypto.randomUUID();
    const handoffId = mintHandoffId(t, previewId);
    const sessionUuid = crypto.randomUUID();
    const plan = {
      previewId,
      handoffId,
      sessionUuid,
      windowName: `${handoffId}-${selectionSlug(selectors)}`,
      machine: state.collectorId,
      selectors,
      factKeys: fk.factKeys,
      workdir,
      claudeBin,
      claudeVersion,
      seedPath: path.join(handoffsDir, `${handoffId}.md`),
      logPath: path.join(handoffsDir, `${handoffId}.log`),
      transcriptPath: path.join(home(), '.claude', 'projects', slugifyPath(workdir), `${sessionUuid}.jsonl`),
      argv: ['--remote-control', '-n', `${handoffId}-${selectionSlug(selectors)}`, '--session-id', sessionUuid, seedText],
      seedText,
      createdAt: iso(t),
      expiresAt: iso(t + previewTtlMs()),
    };
    const hash = hk.hashOf(plan);

    // LINE_MAX is decided while it is still REVERSIBLE (§4.8): serialise the exact intent record
    // commit would write (worst-case idempotencyKey, 128 bytes) and the largest result envelope
    // the plan admits (the 201 body with the longer status word). A plan the sheet has shown can
    // then never fail on size at commit.
    const worstIntent = JSON.stringify({ t: 'intent', at: iso(t), id: handoffId, idempotencyKey: 'k'.repeat(128), hash, plan }) + '\n';
    const worstResult = JSON.stringify({
      t: 'result', at: iso(t), machine: plan.machine, idempotencyKey: 'k'.repeat(128), status: 201,
      body: { handoffId, status: 'unconfirmed', sessionId: sessionUuid, transcriptPath: plan.transcriptPath, logPath: plan.logPath, factKeys: plan.factKeys },
      claimState: 'complete',
    }) + '\n';
    if (Buffer.byteLength(worstIntent, 'utf8') > LINE_MAX || Buffer.byteLength(worstResult, 'utf8') > LINE_MAX) {
      return err(413, 'plan_too_large', { incidentId: incident('plan_too_large', { previewId, intentBytes: Buffer.byteLength(worstIntent, 'utf8') }) });
    }

    const envelope = { v: 1, plan, hash };
    await store.writeJsonAtomic(path.join(previewsDir, `${previewId}.json`), envelope);
    return { status: 200, body: envelope };
  }

  // ---- commit (§M2) — three queue slots with two unqueued gaps ------------------------------------
  const dispatchBody = (plan, status) => ({
    handoffId: plan.handoffId, status,
    sessionId: plan.sessionUuid, transcriptPath: plan.transcriptPath, logPath: plan.logPath,
    factKeys: plan.factKeys,
  });

  async function commit(args) {
    await refreshConfig();                 // request boundary; cfg() reads live, so a concurrent
    const a = args || {};                  // sweep's refresh is visible — same as the collector
    // Field validation fails BEFORE an idempotencyKey is parsed and validated — no key, no claim,
    // no ledger line (§M2's "owns no claim" table). Commit never carries seed bytes: there is
    // exactly one route by which a seed enters the system, and it is preview.
    const shape = shapeCheck(args, ['previewId', 'hash', 'idempotencyKey']);
    if (shape) return shape;
    if (a.previewId === undefined) return invalid('previewId', 'required');
    if (typeof a.previewId !== 'string' || !UUID_RE.test(a.previewId)) return invalid('previewId', 'malformed');
    if (a.hash === undefined) return invalid('hash', 'required');
    if (typeof a.hash !== 'string' || !HEX64_RE.test(a.hash)) return invalid('hash', 'malformed');
    if (a.idempotencyKey === undefined) return invalid('idempotencyKey', 'required');
    if (typeof a.idempotencyKey !== 'string' || !IDEM_RE.test(a.idempotencyKey)) return invalid('idempotencyKey', 'malformed');

    const machine = machineId();
    const key = ck(machine, a.idempotencyKey);
    const fingerprint = hk.sha256(hk.canon({ previewId: a.previewId, hash: a.hash }));

    let mine = false;   // did THIS request add the key to the executing set?
    try {
      // ---- slot A: claim -> validate -> reserve -> seed -> intent (steps 1-5) --------------------
      const slotA = await store.enqueue(async () => {
        // 1. Claim.
        const stored = claims.get(key);
        if (stored) {
          if (stored.requestFingerprint !== fingerprint && stored.requestFingerprint !== null) {
            return { done: true, res: err(409, 'idempotency_key_reused') };            // no write
          }
          if (stored.state === 'complete') {
            await deletePreview(a.previewId);       // the plan reached an outcome; replay appends NOTHING
            return { done: true, res: { status: stored.status, body: stored.body } };
          }
          if (executing.has(key)) return { done: true, res: err(409, 'in_flight') };   // no write
          // Durable-but-not-executing: the request that owned it already returned without settling
          // (a result-append failure, or a crash before this process started). Settled ON SIGHT —
          // terminal, so the sheet re-previews and no retry loop is possible (§M2 rule 1).
          const body = { error: 'request_incomplete', message: ERROR_MESSAGES.request_incomplete, incidentId: incident('request_incomplete', { idempotencyKey: a.idempotencyKey }) };
          await settleClaimUnq(machine, a.idempotencyKey, 409, body, stored.previewId);
          return { done: true, res: { status: 409, body } };
        }
        executing.add(key); mine = true;
        try {
          await appendApplyUnq({ t: 'claim', at: iso(now()), machine, idempotencyKey: a.idempotencyKey, requestFingerprint: fingerprint, previewId: a.previewId, hash: a.hash, state: 'in_progress' });
        } catch (ex) {
          // Nothing on disk -> the request never happened; a same-key retry is a first attempt.
          claims.delete(key);
          return { done: true, res: err(500, 'ledger_write_failed', { incidentId: incident('ledger_write_failed', { step: 'claim', detail: String(ex.message || ex) }) }) };
        }

        // 2. Validate.
        const read = await store.readJson(path.join(previewsDir, `${a.previewId}.json`), null);
        const env = read.ok && read.value && read.value.plan ? read.value : null;
        if (!env) {
          const body = { error: 'preview_not_found', message: ERROR_MESSAGES.preview_not_found };
          await settleClaimUnq(machine, a.idempotencyKey, 409, body, a.previewId);
          return { done: true, res: { status: 409, body } };
        }
        const plan = env.plan;
        if (now() >= Date.parse(plan.expiresAt)) {
          const body = { error: 'preview_expired', message: ERROR_MESSAGES.preview_expired };
          await settleClaimUnq(machine, a.idempotencyKey, 409, body, a.previewId);
          return { done: true, res: { status: 409, body } };
        }
        if (hk.hashOf(plan) !== a.hash) {
          const body = { error: 'hash_mismatch', message: ERROR_MESSAGES.hash_mismatch };
          await settleClaimUnq(machine, a.idempotencyKey, 409, body, a.previewId);
          return { done: true, res: { status: 409, body } };
        }

        // 3. Reserve, by the ordered precedence table — first match wins, all inside this slot, so
        // two intersecting selections can never both hold a key.
        const planKeys = new Set(plan.factKeys);
        let equalHolder = null;
        let overlaps = false;
        for (const k of plan.factKeys) {
          const holder = locks.get(k);
          if (holder == null) continue;
          overlaps = true;
          const h = index.get(holder);
          if (h && LIVE.has(h.status) && h.factKeys.length === planKeys.size && h.factKeys.every((x) => planKeys.has(x))) equalHolder = h;
        }
        if (equalHolder) {
          const body = { resumed: true, handoff: handoffProjection(equalHolder) };
          await settleClaimUnq(machine, a.idempotencyKey, 200, body, a.previewId);
          return { done: true, res: { status: 200, body } };
        }
        if (overlaps) {
          const shared = plan.factKeys.filter((k) => locks.has(k));
          const body = { error: 'facts_locked', message: ERROR_MESSAGES.facts_locked, incidentId: incident('facts_locked', { sharedKeys: shared }) };
          await settleClaimUnq(machine, a.idempotencyKey, 423, body, a.previewId);
          return { done: true, res: { status: 423, body } };
        }
        for (const k of plan.factKeys) locks.set(k, plan.handoffId);   // real only once intent lands

        // 4. Seed — byte-exact Markdown via the TEXT primitive; writeJsonAtomic would quote it.
        try {
          await store.writeTextAtomicUnqueued(plan.seedPath, plan.seedText);
        } catch (ex) {
          for (const k of plan.factKeys) if (locks.get(k) === plan.handoffId) locks.delete(k);   // dropped
          const body = { error: 'seed_write_failed', message: ERROR_MESSAGES.seed_write_failed, incidentId: incident('seed_write_failed', { seedPath: plan.seedPath, detail: String(ex.message || ex) }) };
          await settleClaimUnq(machine, a.idempotencyKey, 500, body, a.previewId);
          return { done: true, res: { status: 500, body } };
        }

        // 5. Intent — THE COMMIT POINT. A failure here drops the reservation, which is why a crash
        // before this append leaves nothing to release.
        try {
          await appendApplyUnq({ t: 'intent', at: iso(now()), id: plan.handoffId, idempotencyKey: a.idempotencyKey, hash: a.hash, plan });
        } catch (ex) {
          for (const k of plan.factKeys) if (locks.get(k) === plan.handoffId) locks.delete(k);
          const body = { error: 'ledger_write_failed', message: ERROR_MESSAGES.ledger_write_failed, incidentId: incident('ledger_write_failed', { step: 'intent', detail: String(ex.message || ex) }) };
          await settleClaimUnq(machine, a.idempotencyKey, 500, body, a.previewId);
          return { done: true, res: { status: 500, body } };
        }
        await republishUnqueued();
        return { done: false, plan };
      });
      if (slotA.done) return slotA.res;
      const plan = slotA.plan;
      const entry = index.get(plan.handoffId);

      // ---- gap: 6a spawn. A spawn() must not hold the queue; the reservation is already durable,
      // so nothing else can take these keys while we are out here.
      let child = null;
      let spawnError = null;
      let fd;
      try {
        fd = fs.openSync(plan.logPath, 'a');    // the ONE store-only-writes exemption: `script`
        try {                                   // writes the bytes, radar only creates the file
          child = spawn('/bin/bash', ['-c', WRAPPER, 'bash', plan.claudeBin, ...plan.argv], {
            cwd: plan.workdir, detached: true, stdio: ['ignore', fd, fd],
          });
        } finally {
          // The child holds its own duplicate; Node does NOT close a synchronously-opened fd for
          // the caller, and one leaked descriptor per dispatch is an unbounded leak (§M2).
          try { fs.closeSync(fd); } catch (_) { /* already closed */ }
        }
        if (child && typeof child.unref === 'function') child.unref();
      } catch (ex) { spawnError = ex; }

      if (!spawnError && child && child.pid == null) {
        // ENOENT-style failures surface on the async 'error' event with no pid ever assigned.
        spawnError = await new Promise((resolve) => {
          let settled = false;
          const finish = (e) => { if (!settled) { settled = true; resolve(e); } };
          if (typeof child.once === 'function') {
            child.once('error', (e) => finish(e || new Error('spawn error')));
            child.once('exit', () => finish(new Error('exited before a pid could be recorded')));
          }
          setTimeout(() => finish(new Error('no pid and no error event')), 2000);
        });
      }

      if (spawnError || !child || child.pid == null) {
        return await store.enqueue(async () => {
          const body = { error: 'spawn_failed', message: ERROR_MESSAGES.spawn_failed, incidentId: incident('spawn_failed', { detail: String((spawnError && spawnError.message) || spawnError || 'no child') }), logPath: plan.logPath };
          try {
            await appendApplyUnq(statusRec(plan.handoffId, 'pending', 'abandoned', 'spawn_failed', { detail: String((spawnError && spawnError.message) || 'spawn failed'), logPath: plan.logPath }));
            await settleClaimUnq(machine, a.idempotencyKey, 502, body, a.previewId);
          } catch (ex) {
            log(`[radar] spawn-failure settle failed: ${ex.message}`);
          }
          await republishUnqueued();
          return { status: 502, body };
        });
      }

      const pid = child.pid;
      const lst = await execFileP('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
      const psStartedAt = (!lst.err && lst.stdout.trim()) ? lst.stdout.trim() : null;

      // ---- slot B: the process record, immediately after the pid exists --------------------------
      const slotB = await store.enqueue(async () => {
        try {
          await appendApplyUnq({ t: 'process', at: iso(now()), id: plan.handoffId, pid, psStartedAt, observedPids: [] });
          await republishUnqueued();
          return { ok: true };
        } catch (ex) { return { ok: false, error: ex }; }
      });
      if (!slotB.ok) {
        // §M2 failure table: the dispatch set is KILLED FIRST, and only proven absence releases.
        // An unkillable process is left for startup's argv scan to adopt — nothing is released.
        const gone = await killDispatchSet(entry);
        return await store.enqueue(async () => {
          if (!gone) {
            return err(500, 'ledger_write_failed', { incidentId: incident('ledger_write_failed', { step: 'process', detail: String(slotB.error.message || slotB.error), killed: false }) });
          }
          const body = { error: 'spawn_unrecorded', message: ERROR_MESSAGES.spawn_unrecorded, incidentId: incident('spawn_unrecorded', { detail: String(slotB.error.message || slotB.error) }), logPath: plan.logPath };
          try {
            await appendApplyUnq(statusRec(plan.handoffId, 'pending', 'abandoned', 'spawn_failed', { detail: 'process record unwritable; dispatch killed', logPath: plan.logPath }));
            await settleClaimUnq(machine, a.idempotencyKey, 502, body, a.previewId);
          } catch (ex) { log(`[radar] spawn_unrecorded settle failed: ${ex.message}`); }
          await republishUnqueued();
          return { status: 502, body };
        });
      }

      // ---- gap: 6b confirm — a <= confirmMs stat poll must not hold the queue --------------------
      const started = Date.now();
      let confirmed = false;
      for (;;) {
        try { fs.statSync(plan.transcriptPath); confirmed = true; break; } catch (_) { /* not yet */ }
        if (Date.now() - started >= confirmMs()) break;
        await sleep(Math.min(500, Math.max(25, confirmMs() / 10)));
      }
      const bridgeSessionId = confirmed ? await readBridgeSessionId(entry) : null;

      // ---- slot C: status + settle (steps 6b + 7) -------------------------------------------------
      return await store.enqueue(async () => {
        const status = confirmed ? 201 : 202;
        const body = dispatchBody(plan, confirmed ? 'active' : 'unconfirmed');
        try {
          await appendApplyUnq(confirmed
            ? statusRec(plan.handoffId, 'launching', 'active', 'confirmed', { bridgeSessionId })
            : statusRec(plan.handoffId, 'launching', 'unconfirmed', 'confirm_timeout', { logPath: plan.logPath }));
          if (confirmed) entry.lastObservationAt = entry.confirmedAt;
        } catch (ex) {
          // Keys KEPT — the dispatch is alive. The claim stays in_progress (a same-key retry sees
          // 409 in_flight until we return); the next sweep writes the status from launching,
          // exactly as startup would.
          return err(500, 'ledger_write_failed', { incidentId: incident('ledger_write_failed', { step: 'status', detail: String(ex.message || ex) }) });
        }
        try {
          await settleClaimUnq(machine, a.idempotencyKey, status, body, a.previewId);
        } catch (ex) {
          // The one row that cannot append the record whose append is failing: respond with the
          // computed status; the claim stays in_progress until the next sweep or startup settles
          // it 409 request_incomplete.
          log(`[radar] result append failed for ${plan.handoffId}: ${ex.message}`);
        }
        await republishUnqueued();
        return { status, body };
      });
    } finally {
      if (mine) executing.delete(key);
    }
  }

  // SIGTERM -> poll every 250ms for discardKillMs -> SIGKILL -> poll again. Identity is re-checked
  // against a FRESH capture immediately before each signal round; a pid whose lstart no longer
  // matches is dropped from the set instead of signalled (the accepted-residual TOCTOU, §M2).
  async function killDispatchSet(e) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      const cap = await takeCapture();
      if (cap.ok) {
        for (const pid of dispatchPids(e, cap)) { try { kill(pid, sig); } catch (_) { /* raced an exit */ } }
      }
      const deadline = Date.now() + discardKillMs();
      for (;;) {
        const c2 = await takeCapture();
        if (c2.ok && liveness(e, c2) === 'absent') return true;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(250, Math.max(25, discardKillMs() / 4)));
      }
    }
    const cap = await takeCapture();
    return cap.ok && liveness(e, cap) === 'absent';
  }

  // ---- lifecycle sweep (§M3) ----------------------------------------------------------------------
  async function readEventTimes() {
    try {
      const { events } = await eventlog.readEvents({ radarDir: dir });
      const newest = new Map();
      for (const ev of events) {
        if (!ev.sessionId) continue;
        const cur = newest.get(ev.sessionId);
        if (cur == null || ev.ts >= cur) newest.set(ev.sessionId, ev.ts);
      }
      return newest;
    } catch (_) { return new Map(); }
  }

  async function transitionQ(e, to, reason, detail) {
    const rec = statusRec(e.id, e.status, to, reason, detail);
    try { await appendApplyQ(rec); return true; } catch (ex) {
      log(`[radar] status append failed for ${e.id} (${e.status}->${to}): ${ex.message}`);
      return false;
    }
  }

  const claimOf = (e) => {
    const c = claims.get(ck(e.machine, e.idempotencyKey));
    return c && c.state === 'in_progress' && !executing.has(ck(e.machine, e.idempotencyKey)) ? c : null;
  };
  async function settleWaitingClaimQ(e, status, body) {
    const c = claimOf(e);
    if (!c) return;
    try {
      const rec = { t: 'result', at: iso(now()), machine: e.machine, idempotencyKey: e.idempotencyKey, status, body, claimState: 'complete' };
      await store.appendLine(ledgerPath, rec);
      applyRecord(rec);
      await deletePreview(c.previewId);
    } catch (ex) { log(`[radar] claim settle failed for ${e.id}: ${ex.message}`); }
  }

  // Startup's argv scan and the sweep's straggler resolution are ONE mechanism (§M2). `append` is
  // the queued form on the sweep and the unqueued form inside startup's slot.
  async function resolvePending(e, capture, append) {
    if (!capture.ok) return;                              // unreadable table decides nothing
    const matches = capture.rows.filter((r) => r.command.includes(e.sessionId));
    if (matches.length) {
      // Deterministic leader selection: the match whose command begins /usr/bin/script; else the
      // smallest pid, with the rest persisted as observedPids.
      const leader = matches.find((r) => r.command.startsWith('/usr/bin/script'))
        || matches.reduce((a2, b2) => (a2.pid < b2.pid ? a2 : b2));
      const others = matches.filter((r) => r.pid !== leader.pid).map((r) => ({ pid: r.pid, lstart: r.lstart }));
      try {
        const rec = { t: 'process', at: iso(now()), id: e.id, pid: leader.pid, psStartedAt: leader.lstart, observedPids: others };
        await append(rec); applyRecord(rec);
      } catch (ex) { log(`[radar] pending->process append failed for ${e.id}: ${ex.message}`); return; }
      await resolveLaunching(e, append);
      return;
    }
    try {
      const rec = statusRec(e.id, 'pending', 'abandoned', 'process_absent', {});
      await append(rec); applyRecord(rec);
    } catch (ex) { log(`[radar] pending->abandoned append failed for ${e.id}: ${ex.message}`); return; }
    const c = claimOf(e);
    if (c) {
      const body = { error: 'spawn_failed', message: ERROR_MESSAGES.spawn_failed, incidentId: incident('spawn_failed', { id: e.id, reason: 'process_absent' }), logPath: e.plan.logPath };
      try {
        const rec = { t: 'result', at: iso(now()), machine: e.machine, idempotencyKey: e.idempotencyKey, status: 502, body, claimState: 'complete' };
        await append(rec); applyRecord(rec);
        await deletePreview(c.previewId);
      } catch (ex) { log(`[radar] claim settle failed for ${e.id}: ${ex.message}`); }
    }
  }

  async function resolveLaunching(e, append) {
    const ts = statTranscript(e);
    if (ts.error) return;                                  // row 1: unreadable is never a verdict
    const rec = ts.exists
      ? statusRec(e.id, 'launching', 'active', 'confirmed', { bridgeSessionId: await readBridgeSessionId(e) })
      : statusRec(e.id, 'launching', 'unconfirmed', 'confirm_timeout', { logPath: e.plan.logPath });
    try { await append(rec); applyRecord(rec); } catch (ex) { log(`[radar] launching resolve failed for ${e.id}: ${ex.message}`); return; }
    if (ts.exists) e.lastObservationAt = e.confirmedAt;
    const c = claimOf(e);
    if (c) {
      const status = ts.exists ? 201 : 202;
      const body = dispatchBody(e.plan, ts.exists ? 'active' : 'unconfirmed');
      try {
        const r2 = { t: 'result', at: iso(now()), machine: e.machine, idempotencyKey: e.idempotencyKey, status, body, claimState: 'complete' };
        await append(r2); applyRecord(r2);
        await deletePreview(c.previewId);
      } catch (ex) { log(`[radar] claim settle failed for ${e.id}: ${ex.message}`); }
    }
  }

  // §M3's seven-row precedence, first match wins. The unhealthy row runs FIRST: a degraded source
  // carries stale facts forward, and a false `resolved` would release keys — the unsafe direction.
  async function evaluateEntry(e, state, capture, events, t) {
    const live = liveness(e, capture);
    const ts = statTranscript(e);

    await observeNewPids(e, capture, (rec) => store.appendLine(ledgerPath, rec));

    if (live === 'unhealthy' || ts.error || sourcesUnhealthy(e, state)) return;

    if (live === 'absent') { if (e.pidGoneSince == null) e.pidGoneSince = t; }
    else e.pidGoneSince = null;

    if (allFactsAbsent(state, e.factKeys)) {
      await transitionQ(e, 'resolved', 'facts_cleared', { clearedFacts: e.factKeys });
      return;
    }
    if (e.pidGoneSince != null && t - e.pidGoneSince >= goneGraceMs()) {
      await transitionQ(e, 'abandoned', 'process_gone', {});
      return;
    }
    if (e.status === 'unconfirmed' && ts.exists) {
      await transitionQ(e, 'active', 'adopted_auto', { bridgeSessionId: await readBridgeSessionId(e) });
      return;
    }
    if (e.status === 'unconfirmed') return;

    // Observation freshness: the newest radar event after dispatch, and the transcript mtime.
    // Neither existing contributes nothing; both absent falls back to confirmedAt || dispatchedAt.
    // `quiet` is purely informational — U5 says nothing bounds how long a healthy session sits
    // silent, so abandonment is a PROCESS fact and quiet appears in no other rule.
    const evTs = events.get(e.sessionId);
    const dispatchTs = Date.parse(e.dispatchedAt);
    let obs = Math.max(
      evTs != null && evTs > dispatchTs ? evTs : 0,
      ts.exists && ts.mtimeMs != null ? ts.mtimeMs : 0,
    );
    if (obs === 0) obs = Date.parse(e.confirmedAt || e.dispatchedAt);
    e.lastObservationAt = iso(obs);

    if (t - obs >= sessionQuietMs()) {
      if (e.status !== 'quiet') await transitionQ(e, 'quiet', 'no_observation', {});
      return;
    }
    if (e.status === 'quiet') await transitionQ(e, 'active', 'observed', {});
  }

  // ---- recovery (§M4) -----------------------------------------------------------------------------
  const isOpMember = (id) => ops.some((op) => opOpen(op) && op.ids.includes(id));

  // Settled: any terminal status, or `active` for an adopt. Closure is DERIVED — no close record,
  // nothing to keep in sync, and a member that self-resolved cannot hold the op open forever.
  function memberSettled(op, id) {
    const e = index.get(id);
    if (!e) return true;
    if (TERMINAL.has(e.status)) return true;
    return op.op === 'adopt' && e.status === 'active';
  }
  const opOpen = (op) => op.ids.some((id) => !memberSettled(op, id));

  function currentUndecidableIds() {
    // The liveness conjuncts are recomputed each sweep (they need a capture); the cheap ones are
    // re-verified HERE against the live index, because a press changes them between sweeps: an
    // adopt lands `active` on every member and must empty the element immediately, and the fifth
    // conjunct — membership of an open op — removes discard members the instant the record lands,
    // before the first signal. One press always empties the set.
    return undecidable.filter((id) => {
      const e = index.get(id);
      return !!e && e.status === 'unconfirmed' && !isOpMember(id);
    }).sort();
  }

  function recomputeUndecidable(capture, t) {
    const out = [];
    for (const e of index.values()) {
      if (e.status !== 'unconfirmed' || e.unconfirmedAt == null) continue;
      const ts = statTranscript(e);
      if (ts.exists || ts.error) continue;
      if (liveness(e, capture) !== 'alive') continue;
      if (t - Date.parse(e.unconfirmedAt) < goneGraceMs()) continue;
      out.push(e.id);
    }
    undecidable = out.sort();
  }

  async function pressOp(op, token) {
    if (token === undefined || token === null || token === '') return invalid('token', 'required');
    // (shapeCheck runs in the exported wrappers; token is the routes' only field.)
    if (typeof token !== 'string' || !HEX64_RE.test(token)) return invalid('token', 'malformed');
    return store.enqueue(async () => {
      const ids = currentUndecidableIds();
      // The token names the exact set the user was looking at; a mismatch means the set changed —
      // which happens precisely when it resolved itself. Not an error to the user (§M4).
      if (ids.length === 0 || hk.sha256(hk.canon(ids)) !== token) return err(409, 'not_recoverable');
      const rec = { t: 'recovery-op', at: iso(now()), opId: crypto.randomUUID(), op, ids, token };
      try {
        // BEFORE any signal, as the first durable act of the press — a delivered signal cannot be
        // un-sent, and this record surviving a crash one millisecond later is the whole design.
        await store.appendLineUnqueued(ledgerPath, rec);
      } catch (ex) {
        return err(500, 'ledger_write_failed', { incidentId: incident('ledger_write_failed', { step: 'recovery-op', detail: String(ex.message || ex) }) });
      }
      applyRecord(rec);   // members leave U here — before the first kill, before the response
      if (op === 'adopt') {
        // Idempotent by construction: an id already active is skipped, so a crash that landed
        // three of five lines is completed by replay, not repeated.
        for (const id of ids) {
          const e = index.get(id);
          if (!e || e.status !== 'unconfirmed') continue;
          try { await appendApplyUnq(statusRec(id, 'unconfirmed', 'active', 'adopted_operator', {})); }
          catch (ex) { log(`[radar] adopt line failed for ${id} (replayed by the open op): ${ex.message}`); }
        }
      }
      // Discard signals nothing here: the record made the operation durable and the server-owned
      // drive (every sweep, and startup replay) carries it to completion. Once the record is on
      // disk the answer is 200 {} unconditionally — a later kill failure stays owned by the open
      // operation and can never become a synchronous 5xx (§M4).
      await republishUnqueued();
      return { status: 200, body: {} };
    });
  }

  // One drive per sweep (and one at startup for open discards). §M4's member table takes
  // precedence over ordinary lifecycle evaluation for members of an open op.
  async function driveOpenOps(state, capture, t) {
    for (const op of ops) {
      if (!opOpen(op)) continue;
      for (const id of op.ids) {
        if (memberSettled(op, id)) continue;
        const e = index.get(id);
        if (op.op === 'adopt') {
          if (e.status === 'unconfirmed') await transitionQ(e, 'active', 'adopted_operator', {});
          continue;
        }
        // discard — §M3 row 1 applies here too: an unreadable table or a degraded source decides
        // nothing (no record, no release, retried next sweep). It must not kill on stale identity
        // and must not settle a false `resolved`.
        const live = liveness(e, capture);
        if (live === 'unhealthy' || !state || sourcesUnhealthy(e, state)) continue;
        if (allFactsAbsent(state, e.factKeys)) {
          // The work is gone, so killing it is moot — settled, or the op stays open forever.
          await transitionQ(e, 'resolved', 'facts_cleared', { clearedFacts: e.factKeys });
          continue;
        }
        if (live === 'absent' && e.pidGoneSince != null && t - e.pidGoneSince >= goneGraceMs()) {
          // `gone` reached by ordinary means before the kill was proven: same end state,
          // different cause.
          await transitionQ(e, 'abandoned', 'process_gone', {});
          continue;
        }
        if (live === 'absent') {
          await transitionQ(e, 'discarded', 'discarded_operator', { pid: e.pid });
          continue;
        }
        // Alive — a late transcript does not revoke a discard: Sean pressed it. Keep signalling;
        // release still requires PROOF, per dispatch, so a half-succeeded discard frees exactly
        // the halves it proved and holds the rest, invisibly, forever if need be.
        const gone = await killDispatchSet(e);
        if (gone) await transitionQ(e, 'discarded', 'discarded_operator', { pid: e.pid });
      }
    }
  }

  async function sweep() {
    await refreshConfig();                 // sweep boundary — same cadence as the collector's scan
    const t = now();
    await expirePreviews(t);
    const state = getState();
    const capture = await takeCapture();
    const events = await readEventTimes();

    await driveOpenOps(state, capture, t);

    for (const e of [...index.values()]) {
      if (!LIVE.has(e.status)) continue;
      if (executing.has(ck(e.machine, e.idempotencyKey))) continue;   // a commit in a gap owns it
      if (isOpMember(e.id)) continue;                                 // §M4 precedence
      // Stragglers a crashed or half-failed commit left behind resolve exactly as startup would.
      if (e.status === 'pending') { await resolvePending(e, capture, (r) => store.appendLine(ledgerPath, r)); continue; }
      if (e.status === 'launching') { await resolveLaunching(e, (r) => store.appendLine(ledgerPath, r)); continue; }
      if (state && !sourcesUnhealthy(e, state)) {
        await evaluateEntry(e, state, capture, events, t);
      } else {
        // No snapshot / degraded source: still observe pids (growing the set delays a release,
        // the safe direction) but decide nothing.
        await observeNewPids(e, capture, (rec) => store.appendLine(ledgerPath, rec));
      }
      // A live handoff with a settled outcome and an unsettled claim (a result-append failure)
      // is settled here, exactly as startup would.
      if (e.status === 'active') await settleWaitingClaimQ(e, 201, dispatchBody(e.plan, 'active'));
      else if (e.status === 'unconfirmed') await settleWaitingClaimQ(e, 202, dispatchBody(e.plan, 'unconfirmed'));
    }
    for (const e of [...index.values()]) {
      if ((e.status === 'abandoned' || e.status === 'discarded') && claimOf(e)) {
        await settleWaitingClaimQ(e, 502, { error: 'spawn_failed', message: ERROR_MESSAGES.spawn_failed, incidentId: incident('spawn_failed', { id: e.id, reason: e.status }), logPath: e.plan.logPath });
      }
    }
    recomputeUndecidable(capture, t);
    await store.enqueue(republishUnqueued);
  }

  async function expirePreviews(t) {
    let names = [];
    try { names = await fsp.readdir(previewsDir); } catch (_) { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const read = await store.readJson(path.join(previewsDir, name), null);
      const exp = read.ok && read.value && read.value.plan ? Date.parse(read.value.plan.expiresAt) : NaN;
      if (!Number.isFinite(exp) || t >= exp) {
        try { await fsp.unlink(path.join(previewsDir, name)); } catch (_) { /* already gone */ }
      }
    }
  }

  // ---- startup recovery (§M2) ---------------------------------------------------------------------
  async function recoverAtStartup() {
    await refreshConfig();
    await loadLedger();
    // The two observation fields are NOT records (§4.2): a rebuild seeds them and the next sweep
    // recomputes both. A restart can therefore delay an `abandoned` by at most one grace window —
    // that delays a release, the safe direction.
    for (const e of index.values()) {
      e.lastObservationAt = e.confirmedAt || e.dispatchedAt;
      e.pidGoneSince = null;
    }
    const capture = await takeCapture();
    const intentIdems = new Set([...index.values()].map((e) => e.idempotencyKey));

    await store.enqueue(async () => {
      // A claim with no intent and no result: the process died mid-slot. The claim record stores
      // previewId precisely so this needs no reverse lookup from requestFingerprint (one-way).
      for (const c of [...claims.values()]) {
        if (c.state !== 'in_progress' || intentIdems.has(c.idempotencyKey)) continue;
        const body = { error: 'request_incomplete', message: ERROR_MESSAGES.request_incomplete, incidentId: incident('request_incomplete', { idempotencyKey: c.idempotencyKey, at: 'startup' }) };
        try {
          await appendApplyUnq({ t: 'result', at: iso(now()), machine: c.machine, idempotencyKey: c.idempotencyKey, status: 409, body, claimState: 'complete' });
          await deletePreview(c.previewId);
        } catch (ex) { log(`[radar] startup claim settle failed: ${ex.message}`); }
      }

      for (const e of [...index.values()]) {
        if (e.status === 'pending') { await resolvePending(e, capture, (r) => store.appendLineUnqueued(ledgerPath, r)); continue; }
        if (e.status === 'launching') { await resolveLaunching(e, (r) => store.appendLineUnqueued(ledgerPath, r)); continue; }
        const c = claimOf(e);
        if (!c) continue;
        const settle = async (status, body) => {
          try {
            await appendApplyUnq({ t: 'result', at: iso(now()), machine: e.machine, idempotencyKey: e.idempotencyKey, status, body, claimState: 'complete' });
            await deletePreview(c.previewId);
          } catch (ex) { log(`[radar] startup claim settle failed for ${e.id}: ${ex.message}`); }
        };
        if (e.status === 'active' || e.status === 'quiet') await settle(201, dispatchBody(e.plan, 'active'));
        else if (e.status === 'unconfirmed') await settle(202, dispatchBody(e.plan, 'unconfirmed'));
        else if (e.status === 'abandoned' || e.status === 'discarded') {
          await settle(502, { error: 'spawn_failed', message: ERROR_MESSAGES.spawn_failed, incidentId: incident('spawn_failed', { id: e.id, at: 'startup' }), logPath: e.plan.logPath });
        }
      }

      // Adopt replays append only the MISSING lines; ids already active are skipped.
      for (const op of ops) {
        if (op.op !== 'adopt' || !opOpen(op)) continue;
        for (const id of op.ids) {
          const e = index.get(id);
          if (!e || e.status !== 'unconfirmed') continue;
          try { await appendApplyUnq(statusRec(id, 'unconfirmed', 'active', 'adopted_operator', {})); }
          catch (ex) { log(`[radar] adopt replay failed for ${id}: ${ex.message}`); }
        }
      }
      await republishUnqueued();
    });

    // Open discards resume signalling from the CURRENT process state, before the first sweep.
    // Kills and their polls never hold the queue.
    if (ops.some((op) => op.op === 'discard' && opOpen(op))) {
      await driveOpenOps(getState(), await takeCapture(), now());
      await store.enqueue(republishUnqueued);
    }
  }

  // ---- projections (§4.6, §7.1) -------------------------------------------------------------------
  function handoffProjection(e) {
    return {
      id: e.id, status: e.status, selectors: e.selectors, factKeys: e.factKeys,
      sessionId: e.sessionId, machine: e.machine, pid: e.pid, psStartedAt: e.psStartedAt,
      bridgeSessionId: e.bridgeSessionId, logPath: e.plan.logPath, transcriptPath: e.plan.transcriptPath,
      dispatchedAt: e.dispatchedAt, confirmedAt: e.confirmedAt, unconfirmedAt: e.unconfirmedAt,
      terminalAt: e.terminalAt,
    };
  }

  async function get(id) {
    const e = index.get(id);
    if (!e) return err(404, 'handoff_not_found');
    return { status: 200, body: handoffProjection(e) };
  }

  function publish() {
    const live = sortedEntries().filter((e) => LIVE.has(e.status));
    const ids = currentUndecidableIds();
    let since = null;
    for (const id of ids) {
      const e = index.get(id);
      if (e && e.unconfirmedAt && (since == null || e.unconfirmedAt < since)) since = e.unconfirmedAt;
    }
    return {
      // §4.6 — only handoffs that HOLD fact keys; a terminal handoff lives in the ledger alone.
      handoffs: live.map((e) => ({ id: e.id, status: e.status, selectors: e.selectors, factKeys: e.factKeys, session: { machine: e.machine, sessionId: e.sessionId } })),
      // One object for the WHOLE undecidable set: no ids, no count, nothing that changes visibly
      // when |U| goes from 1 to 3 (§M4).
      handoffRecovery: ids.length ? { token: hk.sha256(hk.canon(ids)), since } : null,
      handoffsLive: live.length,
    };
  }

  function suppressedKeys() {
    // From the IN-MEMORY index — never index.json/locks.json read back off disk (§3, §6.6).
    const out = new Set();
    for (const e of index.values()) if (LIVE.has(e.status)) for (const k of e.factKeys) out.add(k);
    return out;
  }

  const pressWrapped = (op) => async (args) => {
    const shape = shapeCheck(args, ['token']);
    if (shape) return shape;
    return pressOp(op, (args || {}).token);
  };

  return {
    preview, commit,
    adopt: pressWrapped('adopt'),
    discard: pressWrapped('discard'),
    get, sweep, recoverAtStartup, publish, suppressedKeys,
  };
}

module.exports = { SAFETY_NOTICE, ERROR_MESSAGES, createHandoff };
