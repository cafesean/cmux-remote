'use strict';
// mod-sessions — hook events + bridge tree -> session facts (spec §M2).
//
// IDENTITY IS {machine, session_id}. NEVER cwd. Two Claude sessions running in the same worktree
// are two independent rows that block, clear and expire independently; cwd is used for exactly one
// thing, repo/epic mapping, and a session with no cwd is still a first-class session.
//
// BLOCKED IS NARROW AND CLEARS THREE WAYS. It is set only by a Notification whose notification_type
// is permission_prompt or idle_prompt (or by the PermissionRequest hook, which the installed CLI
// does expose). Every other notification subtype — auth_success, the rest — is INERT: it neither
// sets nor clears. Blocked then clears on:
//     (a) any later UserPromptSubmit   — the operator answered
//     (b) any later Stop               — the turn ended without them
//     (c) the session vanishing from the bridge tree — the tab is gone
// Missing any of the three leaves a permanently-red queue item, which trains the human to ignore
// the queue, which kills the product.
//
// U1 (probed against cmux 2026-07 + Claude Code 2.1.220, see radar/HOOK-INSTALL.md):
//   `cmux list-status --surface <anything>` IGNORES --surface and answers for the CALLER's
//   workspace ($CMUX_WORKSPACE_ID). It returns the identical string for a bogus surface ref. So
//   cmux's per-tab status is NOT a per-session waiting signal and this module never derives
//   `blocked` from it. Status is carried as advisory metadata only. Hook events are the sole
//   blocked oracle.
//
// DEGRADATION IS THE POINT. Every remote input can vanish independently, and each vanishing has a
// defined answer that produces ZERO attention churn:
//   events unreadable  -> that machine's previous sessions carry forward, marked stale
//   tree unreadable    -> sessions still fold from events; surfaces carry forward; no vanish drops
// Unknown beats false green, and an outage must never look like a state change.
const os = require('os');
const path = require('path');
const { readJson } = require('./store');
const eventlog = require('./eventlog');
const { mapBranchToEpic } = require('./mod-git');

const RUNNING_WINDOW_MS = 120 * 1000;          // activity inside 2 min = running; else idle
const CACHE_TTL_MS = 60 * 60 * 1000;           // prompt-cache window, APPROXIMATE — see below
// How long a session may sit `blocked` before radar stops calling it blocked. Set well past the
// cache window: inside CACHE_TTL_MS answering still saves the context, past it there is nothing
// left to save, and a killed session (which emits no Stop) would otherwise block forever.
const ABANDON_MS = 4 * 60 * 60 * 1000;         // 4h
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8799';

// The only notification subtypes that mean "a human has to do something".
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'idle_prompt']);
// Hook events that clear a block, whatever set it.
const CLEARING_EVENTS = new Set(['UserPromptSubmit', 'Stop']);

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const trimSlash = (p) => (p && p.length > 1 ? p.replace(/\/+$/, '') : p);

// ---- config: the bridge list --------------------------------------------------------------------
// Deliberately read straight from the raw config file rather than through normalizeConfig(): the
// v1 config schema does not model `bridges`, and teaching it to would mean editing a file three
// other P2/P4 modules also need to edit. Problems land in sources.sessions, which is where a
// session-collection problem belongs anyway.
//
//   "bridges": [
//     { "id": "machine-a",  "baseUrl": "http://127.0.0.1:8799", "secretRef": "BRIDGE_SECRET", "local": true },
//     { "id": "machine-b", "baseUrl": "http://machine-b.local:8799", "secretRef": "BRIDGE_SECRET_MINI" }
//   ]
//
// `local: true` means "read this machine's events off disk instead of over HTTP" — the leader's own
// events are then still collected when its own bridge is down.
const implicitLocal = (collectorId) =>
  // `implicit` = nobody configured a bridge, so we read this machine's own event log off disk and
  // probe NOTHING. Speculatively poking 127.0.0.1:8799 on every scan of an unconfigured install
  // would make the collector's behaviour depend on whatever else happens to be listening there.
  ({ id: collectorId, baseUrl: DEFAULT_BRIDGE_URL, secretRef: 'BRIDGE_SECRET', local: true, implicit: true });

function normalizeBridges(raw, collectorId, issues) {
  const list = raw && Array.isArray(raw.bridges) ? raw.bridges : null;
  if (!list) return [implicitLocal(collectorId)];
  const out = [];
  const seen = new Set();
  list.forEach((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) { issues.push(`bridges[${i}]: not an object`); return; }
    const id = str(b.id);
    if (!id) { issues.push(`bridges[${i}]: missing id`); return; }
    if (seen.has(id)) { issues.push(`bridges[${i}] (${id}): duplicate id`); return; }
    const baseUrl = str(b.baseUrl) || DEFAULT_BRIDGE_URL;
    if (!/^https?:\/\//.test(baseUrl)) { issues.push(`bridges[${i}] (${id}): baseUrl is not http(s)`); return; }
    seen.add(id);
    out.push({
      id,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      secretRef: str(b.secretRef) || 'BRIDGE_SECRET',
      local: b.local === true || id === collectorId,
      implicit: false,
    });
  });
  if (out.length === 0) issues.push('no usable bridges configured; falling back to the local one');
  return out.length ? out : [implicitLocal(collectorId)];
}

// ---- transport ------------------------------------------------------------------------------------
// Node >= 18 global fetch; zero dependencies. Injectable so every test runs without a socket.
function defaultHttp(url, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs || 8000);
  return fetch(url, { headers: o.headers || {}, signal: ctl.signal })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* non-JSON body -> treated as failure below */ }
      return { ok: r.ok, status: r.status, json };
    })
    .finally(() => clearTimeout(timer));
}

// ---- event folding --------------------------------------------------------------------------------

// One session's whole history in a single ascending pass. Ordering is what makes this correct:
// "blocked, then answered, then blocked again" must end blocked, and "blocked, then answered" must
// end clear — a set-membership check over the same events cannot express either.
function foldSession(machine, sessionId, events) {
  let lastEventAt = null;
  let lastSubmitAt = null;
  let lastStopAt = null;
  let transcriptPath = null;
  let cwd = null;
  let surfaceId = null;
  let tabId = null;
  let blockedSince = null;
  let notificationType = null;

  for (const ev of events) {
    lastEventAt = ev.ts;
    if (ev.transcriptPath) transcriptPath = ev.transcriptPath;   // secondary identity, latest wins
    if (ev.cwd) cwd = ev.cwd;
    // Latest wins: a session survives being moved between tabs, and the newest event is the truth.
    if (ev.surfaceId) surfaceId = ev.surfaceId;
    if (ev.tabId) tabId = ev.tabId;
    if (ev.event === 'UserPromptSubmit') { lastSubmitAt = ev.ts; blockedSince = null; notificationType = null; continue; }
    if (ev.event === 'Stop') { lastStopAt = ev.ts; blockedSince = null; notificationType = null; continue; }
    if (ev.event === 'Notification') {
      // INERT unless the subtype is one of the two that mean a human is required. auth_success and
      // friends fall through untouched — they must not set a block and must not clear one either.
      if (BLOCKING_NOTIFICATIONS.has(ev.notificationType)) {
        blockedSince = ev.ts;
        notificationType = ev.notificationType;
      }
      continue;
    }
    if (ev.event === 'PermissionRequest') {
      blockedSince = ev.ts;
      notificationType = notificationType || 'permission_request';
      continue;
    }
    // every other hook event: pure activity, no effect on blocked
  }

  return { machine, sessionId, lastEventAt, lastSubmitAt, lastStopAt, transcriptPath, cwd, surfaceId, tabId, blockedSince, notificationType };
}

function groupEvents(events) {
  const by = new Map();
  for (const ev of events) {
    if (!by.has(ev.sessionId)) by.set(ev.sessionId, []);
    by.get(ev.sessionId).push(ev);
  }
  for (const list of by.values()) list.sort((a, b) => a.ts - b.ts);
  return by;
}

// ---- repo / epic mapping (cwd is used HERE and nowhere else) ---------------------------------------
function mapCwd(cwd, config, aliases) {
  const empty = { repo: null, worktree: null, epic: null };
  if (!cwd) return empty;                                    // absent cwd -> listed, unmapped
  const target = trimSlash(cwd);
  const repos = (config && Array.isArray(config.repos)) ? config.repos : [];
  let best = null;
  for (const r of repos) {
    const rp = trimSlash(r.path);
    if (target === rp || target.startsWith(rp + path.sep)) {
      if (!best || rp.length > trimSlash(best.path).length) best = r;   // longest prefix wins
    }
  }
  if (!best) return empty;
  const rel = target === trimSlash(best.path) ? '' : target.slice(trimSlash(best.path).length + 1);
  // Reuse mod-git's mapper so a session and a branch agree on what "p5" or "PROJ-108" means. The
  // path tail plays the branch's role: `.claude/worktrees/p5-sessions` matches the p5 alias on the
  // same delimiter boundary rule that stops p5 from claiming p51.
  const m = mapBranchToEpic(best.id, rel || path.basename(target), aliases || {});
  return { repo: best.id, worktree: target, epic: m.epic };
}

// ---- surface join ------------------------------------------------------------------------------
// Best-effort, and AMBIGUITY ALWAYS LOSES. `cmux tree` carries no cwd (spec trap 7), so the join
// goes cwd -> workspace (via the bridge's fs/roots, which does carry current_directory) -> its
// single terminal tab. Any fork in that chain yields surface: null, which yields no Jump button.
// A Jump that lands on the wrong terminal is worse than no Jump at all.
function buildSurfaceIndex(tree, roots) {
  const idx = { byCwd: new Map(), uuids: new Set(), byUuid: new Map(), ok: false, statusTruncated: false };
  if (!tree || !Array.isArray(tree.workspaces)) return idx;
  idx.ok = true;
  idx.statusTruncated = tree.statusTruncated === true;

  const wsByLabel = new Map();
  for (const ws of tree.workspaces) {
    for (const t of (ws.tabs || [])) if (t && t.id) { idx.uuids.add(t.id); idx.byUuid.set(t.id, { ws, tab: t }); }
    for (const label of [ws.title, ws.ref]) {
      const k = str(label);
      if (!k) continue;
      if (!wsByLabel.has(k)) wsByLabel.set(k, []);
      if (wsByLabel.get(k).indexOf(ws) === -1) wsByLabel.get(k).push(ws);
    }
  }

  const rootList = (roots && Array.isArray(roots.roots)) ? roots.roots : [];
  for (const r of rootList) {
    if (!r || r.kind !== 'workspace') continue;               // only workspace roots carry a cwd
    const p = trimSlash(str(r.path));
    const label = str(r.label);
    if (!p || !label) continue;
    if (!idx.byCwd.has(p)) idx.byCwd.set(p, []);
    const hits = wsByLabel.get(label) || [];
    for (const ws of hits) if (idx.byCwd.get(p).indexOf(ws) === -1) idx.byCwd.get(p).push(ws);
    if (hits.length !== 1) idx.byCwd.get(p).push(null);        // ambiguous label -> poison this cwd
  }
  return idx;
}

// LONGEST-PREFIX, not exact equality (real-board fix, 2026-07-31). cmux's workspace roots are
// PARENT directories — the live board exposes exactly one, `/path/to/workspace` — while a
// Claude session's cwd is almost always a repo or a worktree several levels below it. An exact
// match therefore never fired for any real session, so the join was not "best-effort and ambiguous",
// it was never attempted. Longest prefix wins, the same rule mapCwd already uses for repos.
//
// Every refusal now carries a REASON, and the reason is the point: "no tab — surface unknown" told
// the operator nothing, while "4 terminal tabs in this workspace" tells them the join is impossible rather
// than broken. Reasons are a fixed vocabulary, never free text.
function surfaceCandidate(idx, cwd) {
  const target = trimSlash(cwd);
  let bestKey = null;
  for (const key of idx.byCwd.keys()) {
    if (target !== key && !target.startsWith(key === '/' ? '/' : key + '/')) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === null ? null : { key: bestKey, candidates: idx.byCwd.get(bestKey) };
}

function surfaceOf(ws, tab) {
  return {
    workspace: ws.ref || null,
    tabRef: tab.ref || null,
    tabUuid: tab.id,
    tabStatus: tab.statusCovered === false ? 'unknown' : (str(tab.status) || 'unknown'),
  };
}

// `recorded` is {surfaceId, tabId} captured by the hook inside the session itself (see
// radar/hook-receiver.js). When present it ends the guessing: no cwd, no workspace label, no
// terminal-count tiebreak. Spec trap 7 says `cmux tree` has no per-tab cwd — true, and irrelevant
// once the session names its own tab. The id is still VALIDATED against the tree, so a closed tab
// reports that rather than handing Jump a dead uuid.
function joinRecorded(idx, recorded) {
  if (!recorded) return null;
  for (const id of [recorded.surfaceId, recorded.tabId]) {
    if (!id) continue;
    const hit = idx.byUuid.get(id);
    if (hit) return { surface: surfaceOf(hit.ws, hit.tab), reason: null, recorded: true };
  }
  // It named a tab and the tree does not have it: the tab is closed. Saying so beats falling back
  // to a cwd guess that would point Jump at whatever terminal replaced it.
  if (recorded.surfaceId || recorded.tabId) return { surface: null, reason: 'recorded-tab-gone', recorded: true };
  return null;
}

function joinSurface(idx, cwd, cwdSessionCount, recorded) {
  if (!idx.ok) return { surface: null, reason: 'tree-unavailable' };
  const exact = joinRecorded(idx, recorded);
  if (exact) return exact;
  if (!cwd) return { surface: null, reason: 'no-cwd' };
  if (cwdSessionCount !== 1) return { surface: null, reason: 'shared-cwd' };   // two sessions, one cwd
  const hit = surfaceCandidate(idx, cwd);
  if (!hit) return { surface: null, reason: 'no-workspace-for-cwd' };
  const { candidates } = hit;
  if (!candidates || candidates.length !== 1 || !candidates[0]) return { surface: null, reason: 'ambiguous-workspace' };
  const ws = candidates[0];
  const terminals = (ws.tabs || []).filter((t) => t && t.type === 'terminal');
  // The information-theoretic wall (spec trap 7): `cmux tree` carries no per-tab cwd, so once a
  // workspace holds more than one terminal there is nothing left to disambiguate them with. A Jump
  // that lands on the wrong terminal is worse than no Jump, because you only find out after the
  // context switch — so this refuses, loudly, with the count.
  if (terminals.length === 0) return { surface: null, reason: 'no-terminal-tab' };
  if (terminals.length !== 1) return { surface: null, reason: `ambiguous-tabs:${terminals.length}` };
  const tab = terminals[0];
  if (!tab.id) return { surface: null, reason: 'no-tab-uuid' };                // UUID is the only stable identity
  // `statusCovered === false` means the 60-tab cap bit and nobody asked cmux about this tab.
  return { surface: surfaceOf(ws, tab), reason: null };
}

// ---- per-machine collection -----------------------------------------------------------------------

async function collectMachine(bridge, ctx) {
  const { now, http, timeoutMs, paths, network } = ctx;
  const secret = bridge.secretRef ? (process.env[bridge.secretRef] || '') : '';
  const headers = secret ? { 'x-bridge-secret': secret } : {};
  const since = now - eventlog.RETENTION_MS;

  // `fetch: false` (the collector's no-network scan mode) suppresses every HTTP call. The local
  // machine's events still come off disk — that is not the network — but nothing is PROBED, so
  // the machine reports `unknown`, never `offline`. "We did not ask" and "it did not answer" are
  // different facts and radar is not allowed to conflate them.
  if (network === false || bridge.implicit) {
    let events = null;
    let eventsError = null;
    if (bridge.local) {
      try {
        const r = await eventlog.readEvents({ eventsDir: paths.events, since });
        events = r.events;
      } catch (e) { eventsError = `local events: ${e && e.message ? e.message : String(e)}`; }
    }
    return { bridge, events, eventsError, tree: null, roots: null, treeError: null, networkSkipped: true };
  }

  // ---- events. The whole retained window, re-folded every sweep. No cursor to corrupt, and the
  // endpoint's at-least-once duplicates cost nothing because folding is idempotent.
  let events = null;
  let eventsError = null;
  if (bridge.local) {
    try {
      const r = await eventlog.readEvents({ eventsDir: paths.events, since });
      events = r.events;
    } catch (e) { eventsError = `local events: ${e && e.message ? e.message : String(e)}`; }
  } else {
    try {
      const r = await http(`${bridge.baseUrl}/cmux/session-events?since=${since}`, { headers, timeoutMs });
      if (!r || !r.ok || !r.json || !Array.isArray(r.json.events)) {
        eventsError = `session-events: ${r && r.status ? `HTTP ${r.status}` : 'unreachable'}`;
      } else {
        events = r.json.events.map((e) => eventlog.normalizeEvent(e, null)).filter(Boolean);
        // `more` = the page hit the cap. The remainder is older-than-this-page material we will
        // pick up next sweep; we say so rather than pretending the fold is complete.
        if (r.json.more) ctx.warnings.push(`${bridge.id}: session-events page truncated`);
      }
    } catch (e) { eventsError = `session-events: ${e && e.message ? e.message : String(e)}`; }
  }

  // ---- tree + workspace cwds. Only used for the surface join and vanish detection; their absence
  // degrades those two things and NOTHING else.
  let tree = null;
  let roots = null;
  let treeError = null;
  try {
    const r = await http(`${bridge.baseUrl}/cmux/tree`, { headers, timeoutMs });
    if (r && r.ok && r.json && Array.isArray(r.json.workspaces)) tree = r.json;
    else treeError = `tree: ${r && r.status ? `HTTP ${r.status}` : 'unreachable'}`;
  } catch (e) { treeError = `tree: ${e && e.message ? e.message : String(e)}`; }
  if (tree) {
    try {
      const r = await http(`${bridge.baseUrl}/cmux/fs/roots`, { headers, timeoutMs });
      if (r && r.ok && r.json) roots = r.json;
    } catch (_) { /* no roots -> no cwd->workspace join -> surface null. Not an error. */ }
  }

  return { bridge, events, eventsError, tree, roots, treeError, networkSkipped: false };
}

// ---- assembly ---------------------------------------------------------------------------------

function sessionsForMachine(raw, ctx) {
  const { now, config, aliases, prevByMachine } = ctx;
  const machineId = raw.bridge.id;
  const prev = prevByMachine.get(machineId) || [];

  // Events unavailable: carry the previous facts forward, marked stale. Re-deriving from nothing
  // would clear every block on this machine — an outage would read as "the operator answered everything".
  if (raw.events === null) {
    return {
      sessions: prev.map((s) => Object.assign({}, s, { stale: true })),
      machine: {
        id: machineId,
        bridge: raw.networkSkipped ? 'unknown' : (raw.treeError ? 'offline' : 'ok'),
        lastSeenAt: prev.length ? (prev[0].observedAt || null) : null,
        eventsStatus: raw.networkSkipped ? 'unknown' : 'offline',
        error: raw.eventsError,
        statusTruncated: false,
        stale: true,
      },
    };
  }

  const observedAt = iso(now);
  const grouped = groupEvents(raw.events);
  const folded = [];
  for (const [sessionId, evs] of grouped) folded.push(foldSession(machineId, sessionId, evs));

  // Identity is {machine, session_id}: two sessions sharing a cwd are two rows. The count is used
  // only to refuse the surface join, never to merge them.
  const cwdCount = new Map();
  for (const f of folded) if (f.cwd) cwdCount.set(trimSlash(f.cwd), (cwdCount.get(trimSlash(f.cwd)) || 0) + 1);

  const idx = buildSurfaceIndex(raw.tree, raw.roots);
  const prevById = new Map(prev.map((s) => [s.key.sessionId, s]));

  const sessions = [];
  for (const f of folded) {
    // Older than the event-retention horizon: the log that proved it existed is gone, so the row
    // goes too. Without this floor a surface-less session would live forever.
    if (f.lastEventAt != null && now - f.lastEventAt > eventlog.RETENTION_MS) continue;

    const prevSession = prevById.get(f.sessionId) || null;
    // Tree unreachable -> reuse the last known surface rather than flipping it to null. Flipping
    // would remove the Jump button, which is attention churn caused purely by the outage.
    const joined = idx.ok
      ? joinSurface(idx, f.cwd, f.cwd ? cwdCount.get(trimSlash(f.cwd)) : 0, { surfaceId: f.surfaceId, tabId: f.tabId })
      : { surface: (prevSession ? prevSession.surface || null : null), reason: 'tree-unavailable' };
    const surface = joined.surface;
    const surfaceReason = surface ? null : joined.reason;

    // Vanished from the tree = the tab we knew this session by is closed. Keyed on the PREVIOUS
    // surface, never the freshly joined one: the cwd heuristic would otherwise re-point a dead
    // session at whatever terminal now occupies that workspace, and Jump would open a stranger's
    // tab. Only ever concluded from a tree we actually got.
    if (idx.ok) {
      const prevUuid = prevSession && prevSession.surface && prevSession.surface.tabUuid;
      if (prevUuid && !idx.uuids.has(prevUuid)) continue;      // dropped -> blocked cleared with it
    }

    const map = mapCwd(f.cwd, config, aliases);
    // A session is cleared out of `blocked` ONLY by UserPromptSubmit or Stop. A session that is
    // killed emits neither, so without this it stays blocked forever — the board accumulated a
    // 13-hour-old "waiting" row that permanently owned the urgent slot. Past ABANDON_MS we stop
    // claiming it is waiting on anyone: the prompt cache died long ago, so nothing is recoverable
    // by answering it, and a corpse in the queue trains the eye to ignore the queue.
    const abandoned = f.blockedSince != null && (now - f.blockedSince) > ABANDON_MS;
    const blocked = f.blockedSince != null && !abandoned;
    const status = blocked
      ? 'blocked'
      : abandoned
      ? 'abandoned'
      // idle is a LIVE state. It means "this session is sitting there", never "this session is
      // finished" — nothing in radar may render it as completion.
      : (f.lastEventAt != null && now - f.lastEventAt <= RUNNING_WINDOW_MS ? 'running' : 'idle');

    sessions.push({
      key: { machine: machineId, sessionId: f.sessionId },
      transcriptPath: f.transcriptPath,
      surface,
      // Why there is no Jump. Null when there IS a surface. Additive to the v1 contract; a consumer
      // that ignores it behaves exactly as before.
      surfaceReason,
      repo: map.repo,
      worktree: map.worktree,
      epic: map.epic,
      status,
      blockedSince: iso(f.blockedSince),
      notificationType: blocked ? f.notificationType : null,
      lastEventAt: iso(f.lastEventAt),
      lastSubmitAt: iso(f.lastSubmitAt),
      // The prompt cache is ~60 min from the last submit, but the TTL drops to 5 min under usage
      // overage. We cannot see which regime we are in, so this is ALWAYS approximate and always
      // flagged as such — the UI renders "≈". An asserted deadline here would be a lie with a
      // clock on it.
      cacheExpiresAt: f.lastSubmitAt == null ? null : iso(f.lastSubmitAt + CACHE_TTL_MS),
      cacheApprox: true,
      stale: false,
      observedAt,
    });
  }

  sessions.sort((a, b) => (a.key.sessionId < b.key.sessionId ? -1 : a.key.sessionId > b.key.sessionId ? 1 : 0));

  return {
    sessions,
    machine: {
      id: machineId,
      bridge: raw.tree ? 'ok' : (raw.networkSkipped ? 'unknown' : 'offline'),
      lastSeenAt: observedAt,
      eventsStatus: 'ok',
      error: raw.treeError || null,
      statusTruncated: idx.statusTruncated,
      stale: false,
    },
  };
}

// ---- entry ---------------------------------------------------------------------------------------

async function collectSessions(opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const observedAt = iso(now);
  const config = o.config || {};
  const paths = o.paths || {};
  const warnings = [];
  const issues = [];

  const collectorId = o.collectorId || config.collectorId || os.hostname();
  // Raw config read: normalizeConfig drops `bridges` (not in the v1 schema). A missing or corrupt
  // config is not a crash — it degrades to the local bridge and says so.
  let rawConfig = null;
  if (o.bridges) {
    rawConfig = { bridges: o.bridges };
  } else if (paths.config) {
    const r = await readJson(paths.config, null);
    if (!r.ok) issues.push(r.error);
    rawConfig = r.value;
  }
  const bridges = normalizeBridges(rawConfig, collectorId, issues);

  const http = typeof o.http === 'function' ? o.http : defaultHttp;
  const timeoutMs = (config.timeouts && config.timeouts.bridgeMs) || 8000;
  const eventsPath = paths.events || eventlog.eventsDir(paths.dir);

  // Previous fragment, for the carry-forward contracts. The collector hands it in; without it the
  // first sweep after a restart simply has nothing to carry, which is correct.
  const prevSessions = (o.prev && Array.isArray(o.prev.sessions)) ? o.prev.sessions : [];
  const prevByMachine = new Map();
  for (const s of prevSessions) {
    const m = s && s.key && s.key.machine;
    if (!m) continue;
    if (!prevByMachine.has(m)) prevByMachine.set(m, []);
    prevByMachine.get(m).push(s);
  }

  const ctx = { now, http, timeoutMs, warnings, network: o.fetch !== false, paths: { events: eventsPath } };
  const raws = [];
  for (const b of bridges) {
    // Sequential, not Promise.all: two bridges is the real fan-out and a stuck one must not be
    // able to make the other look simultaneous-slow in the timeout accounting.
    raws.push(await collectMachine(b, ctx));
  }

  const sessions = [];
  const machines = [];
  for (const raw of raws) {
    const r = sessionsForMachine(raw, { now, config, aliases: o.aliases || {}, prevByMachine });
    for (const s of r.sessions) sessions.push(s);
    machines.push(r.machine);
    if (raw.eventsError) warnings.push(`${raw.bridge.id}: ${raw.eventsError}`);
    if (raw.treeError) warnings.push(`${raw.bridge.id}: ${raw.treeError}`);
  }

  // Source status. `stale` is the honest word for "some machine's facts are carried forward"; only
  // a total loss is an error. `unknown` (we chose not to probe) is neither. None of the three ever
  // blocks publication (spec §3).
  const anyEventsOk = machines.some((m) => m.eventsStatus === 'ok');
  const anyOffline = machines.some((m) => m.eventsStatus === 'offline' || m.bridge === 'offline');
  const allUnprobed = machines.length > 0 && machines.every((m) => m.eventsStatus === 'unknown');
  const detail = issues.concat(warnings).join('; ');

  let source;
  if (allUnprobed) source = { status: 'stale', observedAt, error: 'sessions not probed (fetch disabled)' };
  else if (!anyEventsOk) source = { status: 'error', observedAt, error: detail || 'no bridge reachable' };
  else if (anyOffline || issues.length) source = { status: 'stale', observedAt, error: detail || null };
  else source = { status: 'ok', observedAt };

  return { fragment: { sessions, machines }, source, warnings };
}

module.exports = {
  collectSessions,
  normalizeBridges, foldSession, groupEvents, mapCwd,
  buildSurfaceIndex, joinSurface, surfaceCandidate, sessionsForMachine, collectMachine,
  BLOCKING_NOTIFICATIONS, CLEARING_EVENTS, RUNNING_WINDOW_MS, CACHE_TTL_MS, ABANDON_MS, DEFAULT_BRIDGE_URL,
};
