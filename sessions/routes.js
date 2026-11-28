'use strict';
// p41 A6 — the bridge routes that expose sessions (spec §4.1, sessions/CONTRACT.md "Routes"):
//
//   GET  /cmux/sessions                          -> {machineId, sessions: Session[], screen?}  (D189 screen: Remote Desktop setup)
//   GET  /cmux/sessions/:id/thread?before=&limit= -> {title, messages, cursor}
//   GET  /cmux/sessions/:id/thread-stream        -> SSE of Stream events (msg | status | reset)
//   GET  /cmux/sessions/:id/attachment/:n        -> image bytes
//   GET  /cmux/sessions/:id/upload/:rel          -> an uploaded image's bytes (D57, sessions/uploads.js)
//   GET  /cmux/sessions/:id/subagents            -> {subagents: Subagent[], total}       (A10)
//   GET  /cmux/sessions/:id/subagents/:agentId/thread?before=&limit= -> Thread       (A10)
//   GET  /cmux/sessions/:id/subagents/:agentId/thread-stream        -> SSE msg | reset | gone (A10)
//
// createSessionRoutes(deps).handle(req, res, url) returns true when it answered. bridge.js calls it
// AFTER its own secret check, so every route here is auth-gated exactly like the rest of /cmux/*.
//
// Transcript reads are defended at open time: the joined path is checked with isAllowedTranscriptPath,
// opened, and the fd fstat'ed as a regular file; the reader then gets THAT fd (a one-shot fs shim), so
// a swap between check and read cannot redirect it. A refusal is "no transcript", never served.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { redactTokens } = require('../lib/redact-tokens');
const path = require('path');

const { detectKind, foregroundCommand, harnessOf, isCodeMode, latestSurfaceEvent } = require('./detect');
const { readThread, tailThread, readAttachment, uploadRefs, BadCursorError } = require('./transcript-claude');
const codexT = require('./transcript-codex');
const uploads = require('./uploads');
const thumbs = require('./thumbs');
const { transcriptFor, watchJoin, isAllowedTranscriptPath, WATCH_POLL_MS } = require('./join');
const { statusFor, contextUsage } = require('./status');
const eventlog = require('../radar/eventlog');
const tmuxIds = require('../lib/tmux-ids');
const procs = require('./procs');
const subagents = require('./subagents');
const { pickTitle } = require('./titles');
const statusline = require('./statusline');
const choice = require('./choice');
const names = require('./names');

// Every limit this module adds (LIMITS.md rows).
const LIMITS = {
  pageMax: 500,                       // thread page size cap (readThread clamps to the same value); default 80
  statusTailMsgs: 20,                 // newest messages read per session to derive its status
  listConcurrency: 8,                 // sessions resolved at once in one list call
  maxStreams: 32,                     // open thread-streams per bridge; more -> 429
  streamStatusMs: WATCH_POLL_MS,      // how often a stream re-derives status
  streamHeartbeatMs: 25000,           // SSE comment keep-alive
  attachmentMaxBytes: 20 * 1024 * 1024,
  eventWindowMs: 6 * 60 * 60 * 1000,  // hook events read for a session's status (= detect.js EVENT_LIVE_MS)
  eventMaxPages: 20,                  // event-log pages followed per read (= detect.js MAX_EVENT_PAGES)
  markerIdMax: 128,
  procSnapshotTtlMs: 2000,           // one ps+tmux snapshot is shared for this long (list, describe, streams)
  lineageMs: 1500,                   // p45 D16: a build waits at most this long for task-file lineage, then publishes without outline fields
  listSnapshotMs: 2000,              // D272: the sessions list is rebuilt locally at most this often, however many clients poll
  listSnapshotMaxAgeMs: 300000,      // D296: an older snapshot still answers at once, flagged stale: true (a rebuild runs behind it)
  listBuildStuckMs: 120000,          // D296: a build in flight longer than this no longer blocks a new one
  listIdleStopMs: 30000,             // D272/D278: no client asked for this long = idle; the loop slows to listIdleRefreshMs
  listIdleRefreshMs: 15000,          // D278: while idle the list is still rebuilt this often, so a new client gets it at once
  listWarmStartMs: 3000,             // D278: the first build runs this long after the bridge starts (not on the first GET)
  kindStickyMs: 120000,              // D279: an inconclusive probe keeps a pane's last agent kind (and transcript) this long
  claimsWaitMs: 4000,                // D299: a single-row read with a cwd-guessed join and no list build yet waits this long for one
  attachmentIndexDigits: 6,           // longest attachment index accepted in /attachment/:n
  ...statusline.LIMITS,               // A12 status-line limits (sessions/statusline.js)
  ...choice.LIMITS,                   // A14 answer-choice limits (sessions/choice.js)
  ...names.LIMITS,                    // A16 session-name limits (sessions/names.js)
  ...subagents.LIMITS,                // A10 sub-agent limits (sessions/subagents.js)
  ...uploads.LIMITS,                  // D57 inline upload images (sessions/uploads.js)
  ...thumbs.LIMITS,                   // D65 upload thumbnails (sessions/thumbs.js)
};
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(redactTokens(JSON.stringify(obj)));   // S2r
}

// p41 S2d: transcript tail -> 'revoked' | 'auth_failed' | null. Keys on Claude Code's STRUCTURED
// API-error entry (the reader carries `apiError` from isApiErrorMessage / error), never on prose: an
// answer that merely quotes the phrase sets nothing. A real revoked token is written as
// {type:"assistant", isApiErrorMessage:true, error:"authentication_failed",
//  text:"Failed to authenticate: OAuth token revoked. Please log in again…"} (seen in a real transcript).
// Only the NEWEST assistant entry counts: a later answer clears it.
const AUTH_FAIL_TEXT_RE = /^\s*(API Error: )?Failed to authenticate/i;   // fallback when the code is absent
const REVOKED_RE = /OAuth token revoked/i;
function accountErrorOf(lastMsgs) {
  for (let i = (lastMsgs || []).length - 1; i >= 0; i--) {
    const m = lastMsgs[i];
    if (!m || m.kind !== 'assistant') continue;
    if (!m.apiError) return null;
    const text = String(m.text || '');
    const auth = m.apiError.code === 'authentication_failed' || AUTH_FAIL_TEXT_RE.test(text);
    if (!auth) return null;
    return REVOKED_RE.test(text) ? 'revoked' : 'auth_failed';
  }
  return null;
}

function createSessionRoutes(deps) {
  const machineId = deps.machineId;
  const backend = deps.backend;
  const home = deps.home || os.homedir();
  const loadTree = deps.loadTree;
  // D57: the bridge's upload directory (a getter: bridge.js defines it after this module is built).
  const thumbStore = thumbs.createThumbs({ resize: deps.thumbResize, limits: deps.thumbLimits });   // D65
  const uploadRoot = () => { try { return (typeof deps.uploadRoot === 'function' ? deps.uploadRoot() : deps.uploadRoot) || null; } catch (_) { return null; } };
  // p41 S2p: (refs) -> Promise<(ref) -> 'private' | 'unavailable' | null>. A private (or unproven)
  // surface is never listed; its thread/stream/attachment/subagents/rename answer 423 `private`
  // (503 `gate_unavailable` when the gate could not decide).
  const privateCheck = deps.privateCheck || (async () => () => false);
  const unreadBySurface = deps.unreadBySurface || (async () => null);
  const sseHead = deps.sseHead;
  const joinPollMs = deps.joinPollMs || WATCH_POLL_MS;
  const statusPollMs = deps.statusPollMs || LIMITS.streamStatusMs;
  const readEventsRaw = deps.readEvents || eventlog.readEvents;
  // A14: the surface's current screen (bridge gridPayload) for the live-menu choice source.
  // D179: a tmux-only session (minted tmux id, no cmux pane) is read with tmux capture-pane instead.
  const readGridCmux = deps.readGrid || null;
  const tmuxGridOf = deps.tmuxGrid || procs.tmuxGrid;
  const choices = choice.createChoiceReader({ readGrid: async (surface) => {
    const t = await tmuxTarget(surface);
    if (t) return tmuxGridOf(t);
    return readGridCmux ? readGridCmux(surface) : null;
  } });
  // Process/tmux snapshot for the agent probe (sessions/procs.js). On tmux only the bridge's own
  // socket is looked at, so a pane id never matches another server's pane. Tests inject procSnapshot.
  const procOpts = { home };
  if (backend === 'tmux') procOpts.tmuxSockets = [procs.defaultSockets()[0]];   // TMUX_SOCKET, else tmux's default
  const procSnapshotRaw = deps.procSnapshot || (() => procs.snapshot(procOpts));
  // ONE snapshot shared by list, describe, findTab and every stream tick for LIMITS.procSnapshotTtlMs:
  // each snapshot is a ps plus tmux calls, and 32 streams polling must not each spawn their own.
  let snapCache = null;
  const sharedSnapshot = () => {
    const now = Date.now();
    if (!snapCache || now - snapCache.at >= LIMITS.procSnapshotTtlMs) {
      snapCache = { at: now, p: Promise.resolve().then(procSnapshotRaw).catch(() => null) };
    }
    return snapCache.p;
  };
  let streams = 0;
  // D264: a cmux surface's screen as text rows, for matching it to a tmux client that lost its
  // CMUX_SURFACE_ID (procs.screenOwner). Only read for a surface nothing else claims.
  const surfaceLines = backend === 'cmux' && readGridCmux
    ? async (id) => { const g = await readGridCmux(id); return g && g.grid ? procs.gridLines(g.grid) : null; }
    : null;
  const withAgent = (base) => {
    base.procSnapshot = sharedSnapshot;
    base.agentFor = (s) => procs.agentFor(s, { home, procSnapshot: sharedSnapshot, surfaceLines, codexOpenFiles: deps.codexOpenFiles });
    return base;
  };

  // One event-log read per request: the join, detect and status lookups all ask the same log.
  function requestDeps() {
    const now = Date.now();
    const cache = new Map();
    const readEvents = (q) => {
      const k = JSON.stringify(q || {});
      if (!cache.has(k)) cache.set(k, readEventsRaw(q));
      return cache.get(k);
    };
    const base = withAgent({ home, now: () => now, readEvents });
    // The pane's OWN cwd. On cmux the tree carries none and the workspace cwd may belong to another
    // pane, so the cwd is the one the pane's own hooks recorded; no cwd -> no fallback join.
    if (backend === 'cmux') {
      base.cwdFor = async (id) => {
        const ev = await latestSurfaceEvent({ id }, base, (e) => !!e.cwd);
        return ev ? ev.cwd : null;
      };
    }
    return base;
  }
  const liveDeps = () => {   // for long-lived watchers: a fresh clock and log on every tick
    const d = withAgent({ home, readEvents: readEventsRaw });
    if (backend === 'cmux') d.cwdFor = async (id) => { const ev = await latestSurfaceEvent({ id }, d, (e) => !!e.cwd); return ev ? ev.cwd : null; };
    return d;
  };

  // A loadTree tab as the join/detect modules address it: on tmux the minted surface id names pane %N.
  function joinSurface(tab) {
    if (tab.tmuxPane) return { id: tab.tmuxPane, socket: tab.tmuxSocket };   // a tmux session no cmux pane shows
    if (backend === 'tmux') {
      const p = tmuxIds.parse(tab.id);
      return { id: p ? `%${p.n}` : tab.id };
    }
    return { id: tab.id, ref: tab.ref, type: tab.type, tty: tab.tty };
  }

  // Open-time defense: allowed path, regular file, then hand the reader this fd and nothing else.
  async function safeOpen(p) {
    if (!p || !(await isAllowedTranscriptPath(p, { home }))) return null;
    let fh;
    try {
      fh = await fsp.open(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));   // p is already real
      const st = await fh.stat();
      if (!st.isFile()) { await fh.close(); return null; }
      return { fh, st };
    } catch (_) { if (fh) await fh.close().catch(() => {}); return null; }
  }
  const shim = (fh) => ({ open: async () => fh });
  // For readers that open again and again (tailThread): every open re-runs the check.
  const guardedFs = { async open(p) { const o = await safeOpen(p); if (!o) { const e = new Error('refused'); e.code = 'ENOENT'; throw e; } return o.fh; } };

  async function treeTabs(snap) {
    const ws = await loadTree();
    if (!ws) return null;
    const out = [];
    for (const w of ws) for (const t of w.tabs || []) {
      if (backend === 'tmux' && t.type === 'browser') continue;
      out.push({ ws: w, tab: t });
    }
    // cmux host: tmux sessions running claude/codex that no cmux pane shows (detached, or their cmux
    // pane closed) are listed too, under a `tmux` workspace, so they never silently drop off the list.
    if (backend === 'cmux') {
      let orphans = [];
      try { orphans = await procs.orphanTmuxTabs(new Set(out.map((x) => x.tab.id)), { home, procSnapshot: sharedSnapshot }); } catch (_) { orphans = []; }
      const tw = { ref: 'tmux', id: 'tmux', title: 'tmux', tabs: orphans };
      for (const t of orphans) out.push({ ws: tw, tab: t });
    }
    return out;
  }
  async function findTab(id) {
    const prefix = `${machineId}:`;
    if (typeof id !== 'string' || !id.startsWith(prefix)) return undefined;
    const sf = id.slice(prefix.length);
    const tabs = await treeTabs();
    if (!tabs) return null;
    return tabs.find((x) => x.tab.id === sf);
  }
  // S2p: true when the 423 was sent.
  async function refusePrivate(res, entry) {
    const v = (await privateCheck([entry.tab.id]))(entry.tab.id);
    if (!v) return false;
    if (v === 'private') send(res, 423, { error: 'private' });
    else send(res, 503, { error: 'gate_unavailable' });
    return true;
  }

  async function sessionEvents(d, sessionId) {
    if (!sessionId) return [];
    const all = [];
    let since = d.now() - LIMITS.eventWindowMs;
    for (let i = 0; i < LIMITS.eventMaxPages; i++) {
      let r;
      try { r = await d.readEvents({ since }); } catch (_) { break; }
      const evs = (r && r.events) || [];
      all.push(...evs);
      if (!r.more || !evs.length || !(evs[evs.length - 1].ts > since)) break;
      since = evs[evs.length - 1].ts;
    }
    return all.filter((e) => e.sessionId === sessionId);
  }
  async function readMarker(sessionId) {
    if (!sessionId || sessionId.length > LIMITS.markerIdMax || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    try { return JSON.parse(await fsp.readFile(path.join(home, '.claude', 'needs-you', sessionId), 'utf8')); } catch (_) { return null; }
  }

  // D299: sessionId -> tab id, for every session a pane holds by its own process or hook event, from the
  // newest list build. A single-row read (thread, stream, rename...) excludes the sessions OTHER panes hold
  // from its cwd guess, so opening a pane never shows another pane's transcript in the same cwd.
  let lastClaims = null;
  // p46 D5: Codex rollout ids that two or more panes resolve by the cwd guess alone (nothing ties either pane
  // to its own rollout), as of the newest list build; null until the first build. Such panes answer
  // `unsupported: 'codex-ambiguous'` instead of showing one thread to both.
  let lastAmbiguous = null;
  function codexAmbiguous(j) {
    if (!j || j.kind !== 'codex' || j.via !== 'cwd') return false;   // process/event joins are the pane's own
    return lastAmbiguous === null ? true : lastAmbiguous.has(j.sessionId);   // no build yet: cannot tell one pane from two
  }
  function excludeFor(tabId) {
    if (!lastClaims) return null;
    const s = new Set();
    for (const [sid, t] of lastClaims) if (t !== tabId) s.add(sid);
    return s.size ? s : null;
  }
  function withExclude(d, tabId) {
    const x = excludeFor(tabId);
    if (x) d.excludeSessionIds = x; else delete d.excludeSessionIds;
    return d;
  }
  // No build yet: start one (or join the one in flight) and wait at most claimsWaitMs for it.
  async function ensureClaims() {
    if (lastClaims) return;
    let t = null;
    await Promise.race([rebuildList().catch(() => {}), new Promise((ok) => { t = setTimeout(ok, LIMITS.claimsWaitMs); })]);
    clearTimeout(t);
  }
  // describe() for one row outside a list build.
  async function describeRow(entry, d, unread) {
    let r = await describe(entry, withExclude(d, entry.tab.id), unread);
    if (r.join && r.join.via === 'cwd' && !lastClaims) {
      await ensureClaims();
      const x = excludeFor(entry.tab.id);
      if (x && x.has(r.join.sessionId)) r = await describe(entry, withExclude(d, entry.tab.id), unread);
    }
    return r;
  }
  async function joinRow(entry, d) {
    let j = await transcriptFor(joinSurface(entry.tab), withExclude(d, entry.tab.id));
    if (j && j.via === 'cwd' && !lastClaims) {
      await ensureClaims();
      const x = excludeFor(entry.tab.id);
      if (x && x.has(j.sessionId)) j = await transcriptFor(joinSurface(entry.tab), withExclude(d, entry.tab.id));
    }
    return j;
  }

  // D279: surface id -> { kind, join, at } of the last conclusive agent answer (see describe).
  const kindMemo = new Map();
  const kindNow = deps.now || Date.now;
  // The full Session (CONTRACT.md) for one tab, plus its join for the caller.
  // p45 S2: the row's task-file key candidates, in order tmuxName, userName, title (internal, never serialized).
  async function describe(entry, d, unread) {
    const k = {};
    const r = await describeInner(entry, d, unread, k);
    return { ...r, keys: [k.tmuxName, k.userName, r.session.title].filter((x) => typeof x === 'string' && x) };
  }
  async function describeInner(entry, d, unread, keys) {
    const { ws, tab } = entry;
    const id = `${machineId}:${tab.id}`;
    const s = { id, machine: machineId, workspace: ws.title || ws.ref, surface: tab.id, kind: 'terminal',
      title: tab.title || tab.ref || tab.id, status: 'idle', preview: '', lastActivity: 0,
      reach: tab.tmuxPane || backend === 'tmux' ? 'tmux' : 'cmux' };
    if (tab.type === 'browser') { s.kind = 'browser'; return { session: s, join: null }; }
    const js = joinSurface(tab);
    const be = tab.tmuxPane ? 'tmux' : backend;
    // A11: title never comes from a process/wrapper name (cswap, zsh...); see sessions/titles.js.
    let tmuxName = tab.tmuxPane ? tab.title : null;
    if (!tmuxName && d.procSnapshot) { try { tmuxName = procs.tmuxNameFor(await d.procSnapshot(), js); } catch (_) { tmuxName = null; } }
    keys.tmuxName = tmuxName;
    // D280: the tmux panes of the session this tab shows, so hook events with no surface id find it.
    if (tmuxName && d.procSnapshot) {
      try {
        const snap = await d.procSnapshot();
        const sess = ((snap && snap.sessions) || []).filter((x) => x.name === tmuxName && (!tab.tmuxSocket || x.socket === tab.tmuxSocket));
        if (sess.length === 1) js.tmuxPanes = new Set(sess[0].panes.map((p) => `${sess[0].socket}|${p.id}`));
      } catch (_) { /* no snapshot: events with a surface id still match */ }
    }
    let userName = '';
    const titleOf = (customTitle, preferTab) => pickTitle({ customTitle, tmuxName, preferTab, userName,
      workspaceTitle: ws.title || ws.ref, surfaceRef: tab.ref || tab.id, tabTitle: tab.title });
    s.title = titleOf('', true);
    let join = null;
    try { join = await transcriptFor(js, d); } catch (_) { join = null; }
    let fg = null;
    try { fg = await foregroundCommand(js, be, d); } catch (_) { fg = null; }
    s.kind = detectKind({ surfaceType: tab.type, foregroundCmd: fg, transcriptPath: join && join.path });
    // D279 (Sean 2026-11-21: "panes are flipping between terminal format and agent format"): on a slow cmux the
    // agent probe can come back empty (no process match, no recent hook event, no transcript join). That is
    // "unknown", not "terminal", so the pane keeps the agent kind it had within kindStickyMs. A real answer
    // (another command in front, or SessionEnd) still turns it into a terminal at once.
    const memo = kindMemo.get(tab.id);
    if (s.kind === 'terminal' && fg == null && !join && memo && kindNow() - memo.at < LIMITS.kindStickyMs) {
      // D299: a remembered join another pane holds is not this pane's: keep the kind, drop the join.
      s.kind = memo.kind;
      join = memo.join && d.excludeSessionIds && d.excludeSessionIds.has(memo.join.sessionId) ? null : memo.join;
    } else if (s.kind !== 'terminal') kindMemo.set(tab.id, { kind: s.kind, join, at: kindNow() });
    else kindMemo.delete(tab.id);
    // A Codex transcript is never parsed with the Claude reader (p46: sessions/transcript-codex.js reads it): kind only here.
    if (s.kind !== 'terminal' && join && join.kind === 'codex') s.kind = 'codex';
    if (s.kind === 'claude' && isCodeMode(fg)) s.codeMode = true;                    // D287: Code Mode pilot build in front
    if (s.kind === 'terminal') { const h = harnessOf(fg); if (h) s.harness = h; }   // D262: pi, gemini, hermes… (terminal view)
    userName = nameStore.get(nameKey(join, tab));
    keys.userName = userName;
    if (userName) s.userNamed = true;
    s.title = titleOf('', s.kind === 'terminal');
    if (s.kind !== 'claude' || !join) return { session: s, join: s.kind === 'codex' ? join : null };
    const o = await safeOpen(join.path);
    if (!o) return { session: s, join: null };
    s.lastActivity = Math.floor(o.st.mtimeMs);
    let thread = null;
    try { thread = await readThread(join.path, { limit: LIMITS.statusTailMsgs, sessionId: id, fs: shim(o.fh) }); } catch (_) { thread = null; }
    const o2 = await safeOpen(join.path);
    const cu = o2 ? await contextUsage(join.path, { fs: shim(o2.fh) }) : null;
    s.title = titleOf(thread && thread.title, false);
    if (thread && thread.color) s.color = thread.color;   // D130: Claude Code /color; omitted when none
    const lastMsgs = thread ? thread.messages : [];
    const tail = lastMsgs[lastMsgs.length - 1];
    const running = tail && tail.kind === 'tools' ? (tail.items || []).filter((t) => t.status === 'running').pop() : null;
    const st = statusFor({
      lastMsgs, events: await sessionEvents(d, join.sessionId), marker: await readMarker(join.sessionId),
      toolRunning: running || false, surfaceId: tab.id, unread: unread == null ? true : unread,
      usage: cu && cu.usage, model: cu && cu.model, now: d.now(),
    });
    s.status = st.status;
    s.preview = st.preview || '';
    // p41 S2d: 'revoked' | 'auth_failed' from Claude Code's API-error entry (accountErrorOf)
    const accountError = accountErrorOf(lastMsgs);
    if (accountError) s.accountError = accountError;
    if (cu && cu.model) s.model = cu.model;
    if (cu && cu.at) s.modelAt = cu.at;   // D145: last model response (prompt-cache age); lastActivity stays file mtime
    if (st.contextPct !== undefined) s.contextPct = st.contextPct;
    s.subagents = await subagents.countSubagents(join.path, { home, now: d.now() });
    await addStatusLine(s, join, tab, d);
    if (choice.WAITING.has(s.status)) {
      try {
        const c = await choices.choiceFor({ status: s.status, lastMsgs, surface: tab.id, screen: true, fresh: !!d.freshChoice });
        if (c) s.choice = c;
      } catch (_) { /* optional */ }
    }
    return { session: s, join };
  }
  const nameStore = deps.nameStore || names.createNameStore({ home, limits: LIMITS });
  const nameKey = (join, tab) => (join && join.sessionId) || tab.id;
  const gitInfo = deps.gitInfo || statusline.createGitInfo({ git: deps.git });
  async function addStatusLine(s, join, tab, d) {
    let cwd = null;
    try { if (d.cwdFor) cwd = await d.cwdFor(joinSurface(tab).id); } catch (_) { cwd = null; }
    cwd = cwd || tab.cwd || null;
    try { s.statusLine = await statusline.statusLineFor({ sessionId: join.sessionId, home, session: s, cwd, gitInfo }); } catch (_) { /* optional */ }
  }
  async function unreadFor(tab) {
    let by = null;
    try { by = await unreadBySurface(); } catch (_) { by = null; }
    if (!by) return null;
    return by.has(String(tab.id).toUpperCase());
  }

  // p41 D272: the sessions list is a local heartbeat. The bridge builds it on its own loop (one build per
  // listSnapshotMs, however many devices poll) and every GET answers the newest snapshot at once, in one
  // response, with snapshotAt = when it was built. deps.listSnapshotMs = 0 turns it off (every GET builds).
  // D278 (Sean 2026-11-21: "It took about 30 seconds to load all the sessions"): on a slow cmux a build can
  // take 10-30 s, so a client must never be the one that waits for it. The loop never stops: idle (no GET for
  // listIdleStopMs) it rebuilds every listIdleRefreshMs instead of every listSnapshotMs, the first build runs
  // listWarmStartMs after start (deps.listWarm), a snapshot up to listSnapshotMaxAgeMs old answers at once
  // while one rebuild runs, and a write marks the snapshot stale (rebuild now) instead of dropping it.
  // D296 ("slow to answer" while /healthz answers): once a good snapshot exists a GET never waits on a
  // build. A failed build (cmux tree read null/timeout, or a throw) keeps the last good snapshot instead
  // of replacing it with a 502 that made the next GET wait a whole rebuild (up to 2 x 12 s tree reads);
  // a snapshot older than listSnapshotMaxAgeMs answers flagged stale; every answer carries snapshotAge.
  const listSnapshotMs = deps.listSnapshotMs ?? LIMITS.listSnapshotMs;
  const listNow = deps.now || Date.now;
  let listSnap = null;   // { at, code, body }
  let listBuild = null;  // the one build in flight (concurrent asks share it)
  let listBuildAt = 0;   // D296: when it started
  let listGen = 0;       // D296: build generation; a late, older build never overwrites a newer snapshot
  let listSnapGen = 0;
  let listAskedAt = 0;
  let listTimer = null;
  const goodSnap = () => (listSnap && listSnap.code === 200 ? listSnap : null);
  function rebuildList() {
    if (!listBuild || listNow() - listBuildAt > LIMITS.listBuildStuckMs) {
      const gen = ++listGen;
      listBuildAt = listNow();
      const p = buildList()
        .then((r) => {
          if (gen < listSnapGen) return goodSnap() || { at: listNow(), ...r };
          if (r.code === 200 || !goodSnap()) { listSnap = { at: listNow(), ...r }; listSnapGen = gen; }
          return goodSnap() || listSnap;   // D296: a failed build answers the last good snapshot
        }, (e) => { const g = goodSnap(); if (g) return g; throw e; })
        .finally(() => { if (listBuild === p) listBuild = null; });
      listBuild = p;
    }
    return listBuild;
  }
  // D272/D278: a write that changes what the list shows (rename, new/closed surface) starts a rebuild now;
  // the old snapshot still answers until it lands, so no client waits a full build after a write.
  function invalidateList() {
    if (!listSnapshotMs) { listSnap = null; return; }
    if (listSnap) listSnap.stale = true;   // still answers; a rebuild is due at once
    rebuildList().catch(() => {});
  }
  function listAge() { return listSnap ? listNow() - listSnap.at : Infinity; }
  const listDue = (every) => !listSnap || listSnap.stale || listAge() >= every;
  function armListLoop() {
    if (listTimer || !listSnapshotMs) return;
    listTimer = setInterval(() => {
      const idle = listNow() - listAskedAt > LIMITS.listIdleStopMs;
      if (listDue(idle ? LIMITS.listIdleRefreshMs : listSnapshotMs)) rebuildList().catch(() => {});
    }, listSnapshotMs);
    if (listTimer.unref) listTimer.unref();
  }
  if (deps.listWarm && listSnapshotMs) {
    const t = setTimeout(() => { rebuildList().catch(() => {}); armListLoop(); }, deps.listWarmStartMs ?? LIMITS.listWarmStartMs);
    if (t.unref) t.unref();
  }
  async function list(res) {
    listAskedAt = listNow();
    let snap = goodSnap();
    if (!listSnapshotMs || !snap) snap = await rebuildList();
    else if (listDue(listSnapshotMs)) rebuildList().catch(() => {});
    armListLoop();
    if (snap.code !== 200) return send(res, snap.code, snap.body);
    const age = Math.max(0, listNow() - snap.at);
    send(res, 200, { ...snap.body, snapshotAt: snap.at, snapshotAge: age, ...(age > LIMITS.listSnapshotMaxAgeMs ? { stale: true } : {}) });
  }

  // p45 S2 / D16 (+k176 lead / lane): stamp taskName / spawnedBy / continues from deps.lineage (lib/tasks.js lineage). At most one
  // call outstanding (a build while one is out skips enrichment); a call that does not settle within
  // lineageMs is abandoned (signal.aborted, so its late results never write the reader's cache) and the
  // build publishes without fields. The slot frees when the underlying call settles. Never throws.
  let lineageBusy = false;
  const lineageMs = deps.lineageMs ?? LIMITS.lineageMs;
  async function enrichLineage(rows) {
    if (typeof deps.lineage !== 'function' || lineageBusy) return;
    const want = [...new Set(rows.flatMap((r) => r.keys || []))];
    if (!want.length) return;
    const signal = { aborted: false };
    let call;
    try { call = Promise.resolve(deps.lineage(want, { signal })); } catch (_) { return; }
    lineageBusy = true;
    call.then(() => {}, () => {}).then(() => { lineageBusy = false; });
    const TIMEOUT = {};
    let timer;
    const late = new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), lineageMs); });
    let map = null;
    try { map = await Promise.race([call, late]); } catch (_) { map = null; } finally { clearTimeout(timer); }
    if (map === TIMEOUT) { signal.aborted = true; return; }
    if (!(map instanceof Map)) return;
    for (const r of rows) {
      const keys = r.keys || [];
      // k176: a key with its own task file wins; else a key resolved through its line file (lead/lane only).
      const name = keys.find((k) => map.has(k) && !(map.get(k) || {}).viaLine) || keys.find((k) => map.has(k));
      if (!name) continue;
      const v = map.get(name) || {};
      if (!v.viaLine) r.session.taskName = name;
      if (!v.viaLine && typeof v.spawnedBy === 'string') r.session.spawnedBy = v.spawnedBy;
      if (!v.viaLine && typeof v.continues === 'string') r.session.continues = v.continues;
      if (typeof v.lead === 'string') r.session.lead = v.lead;
      if (typeof v.lane === 'string') r.session.lane = v.lane;
    }
  }

  async function buildList() {
    const d = requestDeps();
    const all = await treeTabs(d.procSnapshot);
    if (!all) return { code: 502, body: { error: 'cmux_failed' } };
    const isPriv = await privateCheck(all.map((e) => e.tab.id));
    const tabs = all.filter((e) => !isPriv(e.tab.id));
    let by = null;
    try { by = await unreadBySurface(); } catch (_) { by = null; }
    const memoBefore = new Map(kindMemo);   // D299: what each pane remembered before this build
    const unreadOf = (e) => (by ? by.has(String(e.tab.id).toUpperCase()) : null);
    const results = [];
    for (let i = 0; i < tabs.length; i += LIMITS.listConcurrency) {
      const part = await Promise.all(tabs.slice(i, i + LIMITS.listConcurrency).map((e) => describe(e, d, unreadOf(e))));
      results.push(...part);
    }
    // D299 (Bridge 0.3.4, mini: a worker row vanished for 4-40 s, folded into the CHIEF pane in the same
    // cwd): a cwd-fallback join is the newest transcript in the cwd's project dir, which with two claude
    // panes there can be the OTHER pane's session. A session a pane holds by its own process or hook event
    // is that pane's; any other pane whose cwd guess landed on it is described again with every such
    // session excluded (it then finds its own transcript, or keeps its kind without a join).
    const claimed = new Map();   // sessionId -> the row that holds it by process/event
    results.forEach((r, i) => { if (r.join && r.join.via !== 'cwd' && !claimed.has(r.join.sessionId)) claimed.set(r.join.sessionId, i); });
    const redo = [];
    results.forEach((r, i) => {
      if (r.join && r.join.via === 'cwd' && claimed.has(r.join.sessionId) && claimed.get(r.join.sessionId) !== i) redo.push(i);
    });
    if (redo.length) {
      const dx = { ...d, excludeSessionIds: new Set(claimed.keys()) };
      for (let i = 0; i < redo.length; i += LIMITS.listConcurrency) {
        await Promise.all(redo.slice(i, i + LIMITS.listConcurrency).map(async (ri) => {
          const e = tabs[ri];
          const prev = memoBefore.get(e.tab.id);   // this build's first pass remembered the stolen join
          if (prev) kindMemo.set(e.tab.id, prev); else kindMemo.delete(e.tab.id);
          results[ri] = await describe(e, dx, unreadOf(e));
        }));
      }
    }
    // A11: one claude transcript session is one list row. A tmux session shown by a cmux surface
    // (attach client) can also surface as a tmux-only orphan; it folds into the cmux surface entry (it
    // takes input best), else into the first. Keyed by the transcript sessionId, never by surface/title.
    // D299: two live cmux panes are two rows even when they resolve to one sessionId; only rows that are
    // not cmux surfaces fold.
    const groups = new Map();
    const keyOf = (r) => (r.session.kind === 'claude' || r.session.kind === 'codex') && r.join && `${r.session.kind}:${r.join.sessionId}`;   // p46: a Codex cmux pane and its tmux orphan are one session too
    for (const r of results) {
      const k = keyOf(r);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    // The survivor lists the ids it replaced (aliases), so the app can move pins and unread to it.
    const folded = new Set();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const w = g.find((r) => r.session.reach === 'cmux') || g[0];
      for (const r of g) {
        if (r === w || r.session.reach === 'cmux') continue;
        (w.session.aliases = w.session.aliases || []).push(r.session.id);
        folded.add(r);
      }
    }
    const kept = results.filter((r) => !folded.has(r));
    await enrichLineage(kept);
    const sessions = kept.map((r) => r.session);
    const claims = new Map();
    results.forEach((r, i) => { if (r.join && r.join.via !== 'cwd' && !claims.has(r.join.sessionId)) claims.set(r.join.sessionId, tabs[i].tab.id); });
    lastClaims = claims;
    const codexByRollout = new Map();
    kept.forEach((r) => { if (r.join && r.join.kind === 'codex' && r.join.via === 'cwd') codexByRollout.set(r.join.sessionId, (codexByRollout.get(r.join.sessionId) || 0) + 1); });   // after the fold: one session = one pane
    lastAmbiguous = new Set([...codexByRollout].filter(([, n]) => n > 1).map(([sid]) => sid));
    // p41 D189 (additive): Remote Desktop TCC setup status, so the app can say "needs setup on this Mac".
    let screen = null;
    if (deps.screenStatus) { try { screen = await deps.screenStatus(); } catch (_) { screen = null; } }
    return { code: 200, body: { machineId, sessions, ...(screen ? { screen } : {}) } };
  }

  async function thread(res, entry, u) {
    const d = requestDeps();
    const { session, join } = await describeRow(entry, d, await unreadFor(entry.tab));
    if (session.kind === 'codex') return codexThread(res, session, join, u);
    const o = join && await safeOpen(join.path);
    if (!o) return send(res, 200, { title: session.title, messages: [], cursor: null });
    let amap = new Map();
    try { amap = await subagents.agentIdMap(join.path); } catch (_) { amap = new Map(); }
    return page(res, u, join.path, o, { sessionId: session.id, agentIdFor: (tu) => amap.get(tu), uploadRoot: uploadRoot() }, session.title);
  }

  // p46: a Codex pane's Thread. `unsupported` only when no thread can be shown honestly: no readable rollout
  // ('codex'), an old-format rollout ('codex', from the reader), or a pane that shares its rollout guess with
  // another pane ('codex-ambiguous'). The path goes through safeOpen like every transcript read.
  async function codexThread(res, session, join, u) {
    const none = (unsupported) => send(res, 200, { title: session.title, messages: [], cursor: null, unsupported });
    if (!join || join.kind !== 'codex') return none('codex');
    if (codexAmbiguous(join)) return none('codex-ambiguous');
    const o = await safeOpen(join.path);
    if (!o) return none('codex');
    const before = u.searchParams.get('before');
    const lim = Number(u.searchParams.get('limit'));
    try {
      const t = await codexT.readThread(join.path, { before: before == null || before === '' ? undefined : before,
        limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, LIMITS.pageMax) : undefined, fs: shim(o.fh) });
      if (t.unsupported) return none(t.unsupported);
      send(res, 200, { title: t.title || session.title, messages: t.messages, cursor: t.cursor });
    } catch (e) {
      if (e instanceof codexT.BadCursorError || (e && e.code === 'bad_cursor')) return send(res, 400, { error: 'bad_cursor' });
      send(res, 500, { error: 'thread_failed' });
    }
  }

  // One Thread page of an open transcript (main or sub-agent): the cursor is the reader's own.
  async function page(res, u, p, o, ro, fallbackTitle) {
    const before = u.searchParams.get('before');
    const lim = Number(u.searchParams.get('limit'));
    try {
      const t = await readThread(p, { ...ro, before: before == null || before === '' ? undefined : before,
        limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, LIMITS.pageMax) : undefined, fs: shim(o.fh) });
      send(res, 200, { title: t.title || fallbackTitle, messages: t.messages, cursor: t.cursor });
    } catch (e) {
      if (e instanceof BadCursorError || (e && e.code === 'bad_cursor')) return send(res, 400, { error: 'bad_cursor' });
      send(res, 500, { error: 'thread_failed' });
    }
  }

  async function attachment(res, entry, nRaw) {
    if (!/^\d+$/.test(nRaw) || nRaw.length > LIMITS.attachmentIndexDigits) return send(res, 400, { error: 'bad_index' });
    const { session, join } = await describeRow(entry, requestDeps(), null);
    const o = join && session.kind === 'claude' && await safeOpen(join.path);
    if (!o) return send(res, 404, { error: 'not_found' });
    let a = null;
    try { a = await readAttachment(join.path, Number(nRaw), { fs: shim(o.fh) }); } catch (_) { a = null; }
    if (!a) return send(res, 404, { error: 'not_found' });
    if (!IMAGE_MIME.test(a.mime)) return send(res, 415, { error: 'unsupported_media' });
    if (a.data.length > LIMITS.attachmentMaxBytes) return send(res, 413, { error: 'too_large' });
    res.writeHead(200, { 'content-type': a.mime, 'content-length': a.data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(a.data);
  }

  // M1: transcript path -> {root, dev, ino, size, mtimeMs, end, rels}. LRU, LIMITS.uploadRefsCacheMax
  // entries. Same file grown: only the appended lines are scanned; replaced/shrunk/touched-in-place or a
  // new root: rescanned. Takes ownership of o.fh (uploadRefs closes it).
  const refsCache = new Map();
  async function referencedUploads(p, o, root) {
    const st = o.st;
    let c = refsCache.get(p);
    if (c) refsCache.delete(p);
    const same = c && c.root === root && c.dev === st.dev && c.ino === st.ino;
    if (same && c.size === st.size && c.mtimeMs === st.mtimeMs) { await o.fh.close().catch(() => {}); refsCache.set(p, c); return c.rels; }
    const from = same && st.size > c.size ? c.end : 0;
    const r = await uploadRefs(p, { uploadRoot: root, from, fs: shim(o.fh) });
    const rels = from ? c.rels : new Set();
    for (const x of r.rels) if (rels.size < LIMITS.uploadRefsPerSession) rels.add(x);
    c = { root, dev: st.dev, ino: st.ino, size: r.size, mtimeMs: st.mtimeMs, end: r.end, rels };
    refsCache.set(p, c);
    while (refsCache.size > LIMITS.uploadRefsCacheMax) refsCache.delete(refsCache.keys().next().value);
    return rels;
  }

  // D57 GET /cmux/sessions/:id/upload/:rel — an uploaded image the thread shows inline. Only a file whose
  // real path is inside the upload directory, with an image extension, under the size cap.
  // M1: and only a rel THIS session's transcript (human messages) references; a rel another session
  // (a private one included) typed is 404 here.
  // D65: the default (?size=thumb) is a JPEG thumbnail (sessions/thumbs.js), immutable-cached; ?size=full
  // is the original. Same session binding and containment for both.
  async function upload(res, entry, relRaw, u) {
    let rel;
    try { rel = decodeURIComponent(relRaw); } catch (_) { return send(res, 400, { error: 'bad_path' }); }
    const size = (u && u.searchParams.get('size')) || 'thumb';
    if (size !== 'thumb' && size !== 'full') return send(res, 400, { error: 'bad_size' });
    const root = uploadRoot();
    const { session, join } = await describeRow(entry, requestDeps(), null);
    const o = root && join && session.kind === 'claude' && await safeOpen(join.path);
    if (!o) return send(res, 404, { error: 'not_found' });
    let refs = null;
    try { refs = await referencedUploads(join.path, o, root); } catch (_) { refs = null; }
    if (!refs || !refs.has(rel)) return send(res, 404, { error: 'not_found' });
    if (size === 'thumb') {
      const read = (r, rt, o2) => uploads.readUpload(r, rt, { ...(o2 || {}), maxBytes: LIMITS.uploadMaxBytes });
      const t = await thumbStore.get(rel, root, read);
      if (!t) return send(res, 404, { error: 'not_found' });
      if (t.kind === 'error') return send(res, t.status, { error: t.code });
      const thumb = t.kind === 'thumb';
      res.writeHead(200, { 'content-type': thumb ? 'image/jpeg' : t.mime, 'content-length': t.data.length,
        'cache-control': thumb ? 'private, max-age=31536000, immutable' : 'no-store', 'x-content-type-options': 'nosniff',
        'x-cmux-thumb': thumb ? (t.cached ? 'hit' : 'miss') : 'fallback' });
      return res.end(t.data);
    }
    const a = await uploads.readUpload(rel, root, { maxBytes: LIMITS.uploadMaxBytes });
    if (!a) return send(res, 404, { error: 'not_found' });
    if (a.tooLarge) return send(res, 413, { error: 'too_large' });
    res.writeHead(200, { 'content-type': a.mime, 'content-length': a.data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(a.data);
  }

  // A codex pane tails its rollout with the Codex reader, or gets one `unsupported` event when it has no readable
  // rollout or shares its guess with another pane (p46). Every
  // status poll re-reads the tree; a pane that is gone gets a `gone` event and the response ends.
  async function stream(req, res, entry) {
    if (streams >= LIMITS.maxStreams) return send(res, 429, { error: 'too_many_streams' });
    streams++;
    const id = `${machineId}:${entry.tab.id}`;
    let closed = false;
    let tailAbort = null;
    let path0 = null;
    let lastStatus = null;
    let stopJoin = () => {};
    let codexState = null;   // p46: 'tail' | 'ambiguous' | 'unreadable' for a Codex pane, else null
    let codexPath = null;
    let st = null;
    const emit = (ev) => { if (!closed) res.write(`data: ${redactTokens(JSON.stringify({ ...ev, session: id }))}\n\n`); };
    const done = () => {
      if (closed) return;
      closed = true;
      streams--;
      stopJoin();
      if (tailAbort) tailAbort.abort();
      if (st) clearInterval(st);
      clearInterval(hb);
    };
    req.on('close', done);
    res.on('close', done);
    sseHead(res);
    const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, LIMITS.streamHeartbeatMs);
    let first;
    try { first = await describeRow(entry, requestDeps(), await unreadFor(entry.tab)); } catch (_) { first = null; }
    if (closed) return;
    // p46: a Codex pane with no readable rollout yet says so once; the join watcher binds it when one appears.
    if (first && first.session.kind === 'codex' && !(first.join && first.join.kind === 'codex')) { codexState = 'unreadable'; emit({ type: 'unsupported', unsupported: 'codex' }); }
    if (first) lastStatus = first.session.status;
    const startTail = (p) => {
      if (tailAbort) tailAbort.abort();
      const ac = new AbortController();
      tailAbort = ac;
      const agentIdFor = subagents.agentIdLookup(p);   // cached per session; never re-read on a status tick
      (async () => {
        try {
          for await (const msg of tailThread(p, null, { signal: ac.signal, sessionId: id, fs: guardedFs, agentIdFor, uploadRoot: uploadRoot(), onReset: () => emit({ type: 'reset' }) })) {
            if (ac.signal.aborted) break;
            emit({ type: 'msg', msg });
          }
        } catch (_) { /* a broken tail ends quietly; the join watcher may start another */ }
      })();
    };
    // p46: tail a Codex rollout with the Codex reader (never the Claude one). Re-run by the join watcher on a
    // path change and by every status tick, so a second pane opening in the same cwd flips this one to
    // 'ambiguous' (one `unsupported` event, tail stopped) and back to 'tail' (`reset`, then the tail) when it
    // stops being ambiguous.
    const applyCodex = (j) => {
      if (closed) return;
      const want = codexAmbiguous(j) ? 'ambiguous' : 'tail';
      if (want === codexState && j.path === codexPath) return;
      const was = codexState;
      codexState = want;
      codexPath = j.path;
      if (tailAbort) { tailAbort.abort(); tailAbort = null; }
      if (want === 'ambiguous') { emit({ type: 'unsupported', unsupported: 'codex-ambiguous' }); return; }
      if (was === 'ambiguous' || was === 'unreadable') emit({ type: 'reset' });
      const ac = new AbortController();
      tailAbort = ac;
      (async () => {
        try {
          for await (const msg of codexT.tailThread(j.path, null, { signal: ac.signal, fs: guardedFs, onReset: () => emit({ type: 'reset' }) })) {
            if (ac.signal.aborted) break;
            emit({ type: 'msg', msg });
          }
          // The generator ends without an abort only for an old-format rollout: nothing to tail.
          if (!ac.signal.aborted) emit({ type: 'unsupported', unsupported: 'codex' });
        } catch (_) { /* a broken tail ends quietly; the join watcher may start another */ }
      })();
    };
    const every = (fn) => setInterval(fn, joinPollMs);
    // D299: every poll excludes the sessions other panes hold, as of the newest list build.
    const joinDeps = { ...liveDeps(), setInterval: every };
    Object.defineProperty(joinDeps, 'excludeSessionIds', { enumerable: true, get: () => excludeFor(entry.tab.id) || undefined });
    stopJoin = watchJoin(joinSurface(entry.tab), (j) => {
      if (closed) return;
      if (path0 != null && j.path !== path0) emit({ type: 'reset' });
      path0 = j.path;
      // The join moved to a Codex rollout: never tail it with the Claude reader.
      if (j.kind === 'codex') { applyCodex(j); return; }
      codexState = null;
      codexPath = null;
      startTail(j.path);
    }, joinDeps);
    const statusTick = async () => {
      try {
        const now = await findTab(id);
        if (closed || now === null) return;            // tree read failed: try again next poll
        if (!now) { emit({ type: 'gone' }); res.end(); done(); return; }
        const { session, join: nowJoin } = await describeRow(now, requestDeps(), await unreadFor(now.tab));
        if (!closed && session.kind === 'codex' && nowJoin && nowJoin.kind === 'codex') {
          if (path0 != null && nowJoin.path !== path0) emit({ type: 'reset' });   // same rule as the join watcher; it then sees path0 already moved
          path0 = nowJoin.path;
          applyCodex(nowJoin);
        }
        if (!closed && session.status !== lastStatus) {
          emit({ type: 'status', status: session.status });
          lastStatus = session.status;
        }
      } catch (_) { /* next tick */ }
    };
    st = setInterval(statusTick, statusPollMs);
  }

  // ---- A10 sub-agents ----------------------------------------------------------------------------
  // The session's main transcript, real and checked, or null (not claude / no join / refused).
  async function mainTranscript(entry) {
    const { session, join } = await describeRow(entry, requestDeps(), null);
    if (session.kind !== 'claude' || !join) return { session, path: null };
    const o = await safeOpen(join.path);
    if (!o) return { session, path: null };
    await o.fh.close().catch(() => {});
    return { session, path: join.path };
  }

  async function subagentList(res, entry) {
    const { path: tp } = await mainTranscript(entry);
    if (!tp) return send(res, 200, { subagents: [], total: 0 });
    const r = await subagents.listSubagents(tp, { home, now: Date.now() });
    send(res, 200, { subagents: r.subagents, total: r.total });
  }

  async function subagentThread(res, entry, agentId, u) {
    const { session, path: tp } = await mainTranscript(entry);
    const o = tp && await subagents.openSubagent(tp, agentId, { home });
    if (!o) return send(res, 404, { error: 'not_found' });
    const meta = await subagents.subagentMeta(tp, agentId);
    return page(res, u, o.path, o, { sessionId: session.id, sidechain: true }, (meta && typeof meta.description === 'string' && meta.description) || session.title);
  }

  async function subagentStream(req, res, entry, agentId) {
    const { session, path: tp } = await mainTranscript(entry);
    const probe = tp && await subagents.openSubagent(tp, agentId, { home });
    if (!probe) return send(res, 404, { error: 'not_found' });
    await probe.fh.close().catch(() => {});
    if (streams >= LIMITS.maxStreams) return send(res, 429, { error: 'too_many_streams' });
    streams++;
    const id = session.id;
    let closed = false;
    const ac = new AbortController();
    const emit = (ev) => { if (!closed) res.write(`data: ${redactTokens(JSON.stringify({ ...ev, session: id, agentId }))}\n\n`); };
    const done = () => {
      if (closed) return;
      closed = true;
      streams--;
      ac.abort();
      clearInterval(hb); clearInterval(st);
    };
    req.on('close', done);
    res.on('close', done);
    sseHead(res);
    const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, LIMITS.streamHeartbeatMs);
    // Every open re-runs the full sub-agent check (the path the reader passes is ignored).
    const subFs = { async open() { const o = await subagents.openSubagent(tp, agentId, { home }); if (!o) { const e = new Error('refused'); e.code = 'ENOENT'; throw e; } return o.fh; } };
    (async () => {
      try {
        for await (const msg of tailThread(probe.path, null, { signal: ac.signal, sessionId: id, sidechain: true, fs: subFs, onReset: () => emit({ type: 'reset' }) })) {
          if (ac.signal.aborted) break;
          emit({ type: 'msg', msg });
        }
      } catch (_) { /* a broken tail ends quietly */ }
    })();
    const st = setInterval(async () => {
      try {
        const now = await findTab(id);
        if (closed || now === null) return;
        if (!now) { emit({ type: 'gone' }); res.end(); done(); }
      } catch (_) { /* next tick */ }
    }, statusPollMs);
  }

  // true when answered. `u` is the parsed URL.
  function handle(req, res, u) {
    const p = u.pathname;
    if (p === '/cmux/sessions') {
      if (req.method !== 'GET') return false;
      list(res).catch(() => send(res, 500, { error: 'sessions_failed' }));
      return true;
    }
    const sm = /^\/cmux\/sessions\/([^/]+)\/subagents(?:\/([^/]+)\/(thread|thread-stream))?$/.exec(p);
    if (sm && req.method === 'GET') {
      let id;
      let agentId = null;
      try { id = decodeURIComponent(sm[1]); if (sm[2] != null) agentId = decodeURIComponent(sm[2]); } catch (_) { send(res, 404, { error: 'not_found' }); return true; }
      if (agentId != null && !subagents.isAgentId(agentId)) { send(res, 400, { error: 'bad_agent_id' }); return true; }
      (async () => {
        const entry = await findTab(id);
        if (entry === null) return send(res, 502, { error: 'cmux_failed' });
        if (!entry) return send(res, 404, { error: 'not_found' });
        if (await refusePrivate(res, entry)) return;
        if (agentId == null) return subagentList(res, entry);
        if (sm[3] === 'thread') return subagentThread(res, entry, agentId, u);
        return subagentStream(req, res, entry, agentId);
      })().catch(() => { if (!res.headersSent) send(res, 500, { error: 'sessions_failed' }); });
      return true;
    }
    const m = /^\/cmux\/sessions\/([^/]+)\/(thread|thread-stream|attachment\/([^/]+)|upload\/([^/]+))$/.exec(p);
    if (!m || req.method !== 'GET') return false;
    let id;
    try { id = decodeURIComponent(m[1]); } catch (_) { send(res, 404, { error: 'not_found' }); return true; }
    (async () => {
      const entry = await findTab(id);
      if (entry === null) return send(res, 502, { error: 'cmux_failed' });
      if (!entry) return send(res, 404, { error: 'not_found' });
      if (await refusePrivate(res, entry)) return;
      if (m[2] === 'thread') return thread(res, entry, u);
      if (m[2] === 'thread-stream') return stream(req, res, entry);
      if (m[4] != null) return upload(res, entry, m[4], u);
      return attachment(res, entry, m[3]);
    })().catch(() => { if (!res.headersSent) send(res, 500, { error: 'sessions_failed' }); });
    return true;
  }

  // A tmux-only session's surface (a minted tmux id no cmux pane has) -> {socket, pane}, for the
  // bridge's /cmux/send and /cmux/key to type into it with tmux. null for anything cmux owns.
  async function tmuxTarget(surface) {
    if (backend !== 'cmux') return null;
    try { return await procs.tmuxTargetFor(surface, { procSnapshot: sharedSnapshot }); } catch (_) { return null; }
  }
  // D140: where a KEY for this surface goes: a minted tmux-only id or a cmux pane attached to a tmux session.
  async function tmuxKeyTarget(surface) {
    if (backend !== 'cmux') return null;
    try { return await procs.tmuxKeyTargetFor(surface, { procSnapshot: sharedSnapshot }); } catch (_) { return null; }
  }

  // A14 POST /cmux/choose (bridge.js reads the body): recompute the surface's choice NOW and execute
  // the pick only if it is still the same question and the same option. io = {pressKey, sendText}.
  async function choose(b, io) {
    const surface = String((b && b.surface) || '');
    const index = b && Number.isInteger(b.index) ? b.index : -1;
    const form = !!b && Array.isArray(b.answers);   // A17 askForm: {choiceId, answers:[{q, picks}|{q, other}]}
    if (!b || typeof b.choiceId !== 'string' || (!form && (typeof b.label !== 'string' || index < 0))) return { code: 400, body: { error: 'bad_json' } };
    const tabs = await treeTabs();
    if (!tabs) return { code: 502, body: { error: 'cmux_failed' } };
    const entry = tabs.find((x) => x.tab.id === surface);
    if (!entry) return { code: 404, body: { error: 'not_found' } };
    const d = requestDeps();
    d.freshChoice = true;
    const { session } = await describeRow(entry, d, await unreadFor(entry.tab));
    if (form) return choices.commitForm({ current: session.choice || null, choiceId: b.choiceId, answers: b.answers, surface }, io);
    return choices.commit({ current: session.choice || null, choiceId: b.choiceId, index, label: b.label, surface }, io);
  }

  // A16 POST /cmux/session-name {sessionId, name}: sessionId is the Session.id. Empty name clears.
  async function rename(b) {
    if (!b || typeof b.sessionId !== 'string' || !b.sessionId || b.sessionId.length > LIMITS.idMax) return { code: 400, body: { error: 'bad_id' } };
    const v = names.validateName(b.name, LIMITS);
    if (v.error) return { code: 400, body: { error: v.error } };
    const entry = await findTab(b.sessionId);
    if (entry === null) return { code: 502, body: { error: 'cmux_failed' } };
    if (!entry) return { code: 404, body: { error: 'not_found' } };
    const pv = (await privateCheck([entry.tab.id]))(entry.tab.id);   // S2p
    if (pv) return pv === 'private' ? { code: 423, body: { error: 'private' } } : { code: 503, body: { error: 'gate_unavailable' } };
    const d = requestDeps();
    let join = null;
    if (entry.tab.type !== 'browser') { try { join = await joinRow(entry, d); } catch (_) { join = null; } }
    const r = nameStore.set(nameKey(join, entry.tab), v.name);
    if (!r.ok) return { code: r.error === 'names_full' ? 409 : 400, body: { error: r.error } };
    invalidateList();   // D272: the next list shows the new name, not the snapshot from before it
    const { session } = await describeRow(entry, d, await unreadFor(entry.tab));
    return { code: 200, body: { ok: true, sessionId: b.sessionId, name: r.name || null, title: session.title } };
  }

  return { handle, tmuxTarget, tmuxKeyTarget, choose, rename, invalidateList };
}

module.exports = { createSessionRoutes, LIMITS, accountErrorOf };
