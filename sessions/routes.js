'use strict';
// p41 A6 — the bridge routes that expose sessions (spec §4.1, sessions/CONTRACT.md "Routes"):
//
//   GET  /cmux/sessions                          -> {machineId, sessions: Session[]}
//   GET  /cmux/sessions/:id/thread?before=&limit= -> {title, messages, cursor}
//   GET  /cmux/sessions/:id/thread-stream        -> SSE of Stream events (msg | status | reset)
//   GET  /cmux/sessions/:id/attachment/:n        -> image bytes
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
const path = require('path');

const { detectKind, foregroundCommand, latestSurfaceEvent } = require('./detect');
const { readThread, tailThread, readAttachment, BadCursorError } = require('./transcript-claude');
const { transcriptFor, watchJoin, isAllowedTranscriptPath, WATCH_POLL_MS } = require('./join');
const { statusFor, contextUsage } = require('./status');
const eventlog = require('../radar/eventlog');
const tmuxIds = require('../lib/tmux-ids');
const procs = require('./procs');
const subagents = require('./subagents');

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
  attachmentIndexDigits: 6,           // longest attachment index accepted in /attachment/:n
  ...subagents.LIMITS,                // A10 sub-agent limits (sessions/subagents.js)
};
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function createSessionRoutes(deps) {
  const machineId = deps.machineId;
  const backend = deps.backend;
  const home = deps.home || os.homedir();
  const loadTree = deps.loadTree;
  const unreadBySurface = deps.unreadBySurface || (async () => null);
  const sseHead = deps.sseHead;
  const joinPollMs = deps.joinPollMs || WATCH_POLL_MS;
  const statusPollMs = deps.statusPollMs || LIMITS.streamStatusMs;
  const readEventsRaw = deps.readEvents || eventlog.readEvents;
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
  const withAgent = (base) => {
    base.procSnapshot = sharedSnapshot;
    base.agentFor = (s) => procs.agentFor(s, { home, procSnapshot: sharedSnapshot });
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

  // The full Session (CONTRACT.md) for one tab, plus its join for the caller.
  async function describe(entry, d, unread) {
    const { ws, tab } = entry;
    const id = `${machineId}:${tab.id}`;
    const s = { id, machine: machineId, workspace: ws.title || ws.ref, surface: tab.id, kind: 'terminal',
      title: tab.title || tab.ref || tab.id, status: 'idle', preview: '', lastActivity: 0,
      reach: tab.tmuxPane || backend === 'tmux' ? 'tmux' : 'cmux' };
    if (tab.type === 'browser') { s.kind = 'browser'; return { session: s, join: null }; }
    const js = joinSurface(tab);
    const be = tab.tmuxPane ? 'tmux' : backend;
    let join = null;
    try { join = await transcriptFor(js, d); } catch (_) { join = null; }
    let fg = null;
    try { fg = await foregroundCommand(js, be, d); } catch (_) { fg = null; }
    s.kind = detectKind({ surfaceType: tab.type, foregroundCmd: fg, transcriptPath: join && join.path });
    // A Codex transcript is never parsed with the Claude reader (no Codex normaliser yet): kind only.
    if (s.kind !== 'terminal' && join && join.kind === 'codex') s.kind = 'codex';
    if (s.kind !== 'claude' || !join) return { session: s, join: s.kind === 'codex' ? join : null };
    const o = await safeOpen(join.path);
    if (!o) return { session: s, join: null };
    s.lastActivity = Math.floor(o.st.mtimeMs);
    let thread = null;
    try { thread = await readThread(join.path, { limit: LIMITS.statusTailMsgs, sessionId: id, fs: shim(o.fh) }); } catch (_) { thread = null; }
    const o2 = await safeOpen(join.path);
    const cu = o2 ? await contextUsage(join.path, { fs: shim(o2.fh) }) : null;
    if (thread && thread.title) s.title = thread.title;
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
    if (cu && cu.model) s.model = cu.model;
    if (st.contextPct !== undefined) s.contextPct = st.contextPct;
    s.subagents = await subagents.countSubagents(join.path, { home, now: d.now() });
    return { session: s, join };
  }
  async function unreadFor(tab) {
    let by = null;
    try { by = await unreadBySurface(); } catch (_) { by = null; }
    if (!by) return null;
    return by.has(String(tab.id).toUpperCase());
  }

  async function list(res) {
    const d = requestDeps();
    const tabs = await treeTabs(d.procSnapshot);
    if (!tabs) return send(res, 502, { error: 'cmux_failed' });
    let by = null;
    try { by = await unreadBySurface(); } catch (_) { by = null; }
    const sessions = [];
    for (let i = 0; i < tabs.length; i += LIMITS.listConcurrency) {
      const part = await Promise.all(tabs.slice(i, i + LIMITS.listConcurrency).map((e) =>
        describe(e, d, by ? by.has(String(e.tab.id).toUpperCase()) : null).then((r) => r.session)));
      sessions.push(...part);
    }
    send(res, 200, { machineId, sessions });
  }

  async function thread(res, entry, u) {
    const d = requestDeps();
    const { session, join } = await describe(entry, d, await unreadFor(entry.tab));
    if (session.kind === 'codex') return send(res, 200, { title: session.title, messages: [], cursor: null, unsupported: 'codex' });
    const o = join && await safeOpen(join.path);
    if (!o) return send(res, 200, { title: session.title, messages: [], cursor: null });
    let amap = new Map();
    try { amap = await subagents.agentIdMap(join.path); } catch (_) { amap = new Map(); }
    return page(res, u, join.path, o, { sessionId: session.id, agentIdFor: (tu) => amap.get(tu) }, session.title);
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
    const { session, join } = await describe(entry, requestDeps(), null);
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

  // Kind is read once at open: a codex pane gets one `unsupported` event and heartbeats only. Every
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
    let sentUnsupported = false;
    let st = null;
    const emit = (ev) => { if (!closed) res.write(`data: ${JSON.stringify({ ...ev, session: id })}\n\n`); };
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
    try { first = await describe(entry, requestDeps(), await unreadFor(entry.tab)); } catch (_) { first = null; }
    if (closed) return;
    if (first && first.session.kind === 'codex') { emit({ type: 'unsupported', unsupported: 'codex' }); return; }
    if (first) lastStatus = first.session.status;
    let amap = new Map();
    const refreshAgents = async () => { if (path0) { try { amap = await subagents.agentIdMap(path0); } catch (_) { /* keep */ } } };
    const startTail = (p) => {
      if (tailAbort) tailAbort.abort();
      const ac = new AbortController();
      tailAbort = ac;
      (async () => {
        await refreshAgents();
        try {
          for await (const msg of tailThread(p, null, { signal: ac.signal, sessionId: id, fs: guardedFs, agentIdFor: (tu) => amap.get(tu), onReset: () => emit({ type: 'reset' }) })) {
            if (ac.signal.aborted) break;
            emit({ type: 'msg', msg });
          }
        } catch (_) { /* a broken tail ends quietly; the join watcher may start another */ }
      })();
    };
    const every = (fn) => setInterval(fn, joinPollMs);
    stopJoin = watchJoin(joinSurface(entry.tab), (j) => {
      if (closed) return;
      if (path0 != null && j.path !== path0) emit({ type: 'reset' });
      path0 = j.path;
      // The join moved to a Codex rollout: never tail it with the Claude reader.
      if (j.kind === 'codex') {
        if (tailAbort) { tailAbort.abort(); tailAbort = null; }
        if (!sentUnsupported) { sentUnsupported = true; emit({ type: 'unsupported', unsupported: 'codex' }); }
        return;
      }
      startTail(j.path);
    }, { ...liveDeps(), setInterval: every });
    const statusTick = async () => {
      try {
        const now = await findTab(id);
        if (closed || now === null) return;            // tree read failed: try again next poll
        if (!now) { emit({ type: 'gone' }); res.end(); done(); return; }
        await refreshAgents();
        const { session } = await describe(now, requestDeps(), await unreadFor(now.tab));
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
    const { session, join } = await describe(entry, requestDeps(), null);
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
    const emit = (ev) => { if (!closed) res.write(`data: ${JSON.stringify({ ...ev, session: id, agentId })}\n\n`); };
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
        if (agentId == null) return subagentList(res, entry);
        if (sm[3] === 'thread') return subagentThread(res, entry, agentId, u);
        return subagentStream(req, res, entry, agentId);
      })().catch(() => { if (!res.headersSent) send(res, 500, { error: 'sessions_failed' }); });
      return true;
    }
    const m = /^\/cmux\/sessions\/([^/]+)\/(thread|thread-stream|attachment\/([^/]+))$/.exec(p);
    if (!m || req.method !== 'GET') return false;
    let id;
    try { id = decodeURIComponent(m[1]); } catch (_) { send(res, 404, { error: 'not_found' }); return true; }
    (async () => {
      const entry = await findTab(id);
      if (entry === null) return send(res, 502, { error: 'cmux_failed' });
      if (!entry) return send(res, 404, { error: 'not_found' });
      if (m[2] === 'thread') return thread(res, entry, u);
      if (m[2] === 'thread-stream') return stream(req, res, entry);
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

  return { handle, tmuxTarget };
}

module.exports = { createSessionRoutes, LIMITS };
