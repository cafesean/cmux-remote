'use strict';
// p41 A6 — the bridge routes that expose sessions (spec §4.1, sessions/CONTRACT.md "Routes"):
//
//   GET  /cmux/sessions                          -> {machineId, sessions: Session[]}
//   GET  /cmux/sessions/:id/thread?before=&limit= -> {title, messages, cursor}
//   GET  /cmux/sessions/:id/thread-stream        -> SSE of Stream events (msg | status | reset)
//   GET  /cmux/sessions/:id/attachment/:n        -> image bytes
//   POST /cmux/notify  {kind, title, body?, surface?} -> appends a normalized event to the radar log
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

// Every limit this module adds (LIMITS.md rows).
const LIMITS = {
  pageMax: 500,                       // thread page size cap (readThread clamps to the same value); default 80
  statusTailMsgs: 20,                 // newest messages read per session to derive its status
  listConcurrency: 8,                 // sessions resolved at once in one list call
  maxStreams: 32,                     // open thread-streams per bridge; more -> 429
  streamStatusMs: WATCH_POLL_MS,      // how often a stream re-derives status
  streamHeartbeatMs: 25000,           // SSE comment keep-alive
  attachmentMaxBytes: 20 * 1024 * 1024,
  notifyKindMax: 64,
  notifyTitleMax: 200,
  notifyBodyMax: 2000,
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
  const readEventsRaw = deps.readEvents || eventlog.readEvents;
  let streams = 0;

  // One event-log read per request: the join, detect and status lookups all ask the same log.
  function requestDeps() {
    const now = Date.now();
    const cache = new Map();
    const readEvents = (q) => {
      const k = JSON.stringify(q || {});
      if (!cache.has(k)) cache.set(k, readEventsRaw(q));
      return cache.get(k);
    };
    const base = { home, now: () => now, readEvents };
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
    const d = { home, readEvents: readEventsRaw };
    if (backend === 'cmux') d.cwdFor = async (id) => { const ev = await latestSurfaceEvent({ id }, d, (e) => !!e.cwd); return ev ? ev.cwd : null; };
    return d;
  };

  // A loadTree tab as the join/detect modules address it: on tmux the minted surface id names pane %N.
  function joinSurface(tab) {
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

  async function treeTabs() {
    const ws = await loadTree();
    if (!ws) return null;
    const out = [];
    for (const w of ws) for (const t of w.tabs || []) {
      if (backend === 'tmux' && t.type === 'browser') continue;
      out.push({ ws: w, tab: t });
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
    let since = d.now() - 6 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i++) {
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
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
    try { return JSON.parse(await fsp.readFile(path.join(home, '.claude', 'needs-you', sessionId), 'utf8')); } catch (_) { return null; }
  }

  // The full Session (CONTRACT.md) for one tab, plus its join for the caller.
  async function describe(entry, d, unread) {
    const { ws, tab } = entry;
    const id = `${machineId}:${tab.id}`;
    const s = { id, machine: machineId, workspace: ws.title || ws.ref, surface: tab.id, kind: 'terminal',
      title: tab.title || tab.ref || tab.id, status: 'idle', preview: '', lastActivity: 0 };
    if (tab.type === 'browser') { s.kind = 'browser'; return { session: s, join: null }; }
    const js = joinSurface(tab);
    let join = null;
    try { join = await transcriptFor(js, d); } catch (_) { join = null; }
    let fg = null;
    try { fg = await foregroundCommand(js, backend, d); } catch (_) { fg = null; }
    s.kind = detectKind({ surfaceType: tab.type, foregroundCmd: fg, transcriptPath: join && join.path });
    if ((s.kind !== 'claude' && s.kind !== 'codex') || !join) return { session: s, join: null };
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
    return { session: s, join };
  }
  async function unreadFor(tab) {
    let by = null;
    try { by = await unreadBySurface(); } catch (_) { by = null; }
    if (!by) return null;
    return by.has(String(tab.id).toUpperCase());
  }

  async function list(res) {
    const tabs = await treeTabs();
    if (!tabs) return send(res, 502, { error: 'cmux_failed' });
    const d = requestDeps();
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
    const o = join && await safeOpen(join.path);
    if (!o) return send(res, 200, { title: session.title, messages: [], cursor: null });
    const before = u.searchParams.get('before');
    const lim = Number(u.searchParams.get('limit'));
    try {
      const t = await readThread(join.path, { before: before == null || before === '' ? undefined : before,
        limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, LIMITS.pageMax) : undefined, sessionId: session.id, fs: shim(o.fh) });
      send(res, 200, { title: t.title || session.title, messages: t.messages, cursor: t.cursor });
    } catch (e) {
      if (e instanceof BadCursorError || (e && e.code === 'bad_cursor')) return send(res, 400, { error: 'bad_cursor' });
      send(res, 500, { error: 'thread_failed' });
    }
  }

  async function attachment(res, entry, nRaw) {
    if (!/^\d{1,6}$/.test(nRaw)) return send(res, 400, { error: 'bad_index' });
    const { join } = await describe(entry, requestDeps(), null);
    const o = join && await safeOpen(join.path);
    if (!o) return send(res, 404, { error: 'not_found' });
    let a = null;
    try { a = await readAttachment(join.path, Number(nRaw), { fs: shim(o.fh) }); } catch (_) { a = null; }
    if (!a) return send(res, 404, { error: 'not_found' });
    if (!IMAGE_MIME.test(a.mime)) return send(res, 415, { error: 'unsupported_media' });
    if (a.data.length > LIMITS.attachmentMaxBytes) return send(res, 413, { error: 'too_large' });
    res.writeHead(200, { 'content-type': a.mime, 'content-length': a.data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(a.data);
  }

  function stream(req, res, entry) {
    if (streams >= LIMITS.maxStreams) return send(res, 429, { error: 'too_many_streams' });
    streams++;
    const id = `${machineId}:${entry.tab.id}`;
    sseHead(res);
    let closed = false;
    let tailAbort = null;
    let path0 = null;
    let lastStatus = null;
    const emit = (ev) => { if (!closed) res.write(`data: ${JSON.stringify({ ...ev, session: id })}\n\n`); };
    const startTail = (p) => {
      if (tailAbort) tailAbort.abort();
      const ac = new AbortController();
      tailAbort = ac;
      (async () => {
        try {
          for await (const msg of tailThread(p, null, { signal: ac.signal, sessionId: id, fs: guardedFs, onReset: () => emit({ type: 'reset' }) })) {
            if (ac.signal.aborted) break;
            emit({ type: 'msg', msg });
          }
        } catch (_) { /* a broken tail ends quietly; the join watcher may start another */ }
      })();
    };
    const every = (fn) => setInterval(fn, joinPollMs);
    const stopJoin = watchJoin(joinSurface(entry.tab), (j) => {
      if (closed) return;
      if (path0 != null && j.path !== path0) emit({ type: 'reset' });
      path0 = j.path;
      startTail(j.path);
    }, { ...liveDeps(), setInterval: every });
    const statusTick = async () => {
      try {
        const { session } = await describe(entry, requestDeps(), await unreadFor(entry.tab));
        if (!closed && session.status !== lastStatus) {
          if (lastStatus != null) emit({ type: 'status', status: session.status });
          lastStatus = session.status;
        }
      } catch (_) { /* next tick */ }
    };
    const st = setInterval(statusTick, LIMITS.streamStatusMs);
    const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, LIMITS.streamHeartbeatMs);
    statusTick();
    const done = () => {
      if (closed) return;
      closed = true;
      streams--;
      stopJoin();
      if (tailAbort) tailAbort.abort();
      clearInterval(st);
      clearInterval(hb);
    };
    req.on('close', done);
    res.on('close', done);
  }

  function notify(req, res) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      let b;
      try { b = JSON.parse(body || '{}'); } catch (_) { return send(res, 400, { error: 'bad_json' }); }
      const str = (v, n) => (typeof v === 'string' && v.trim() && v.length <= n ? v.trim() : null);
      const kind = str(b && b.kind, LIMITS.notifyKindMax);
      const title = str(b && b.title, LIMITS.notifyTitleMax);
      if (!kind || !title) return send(res, 400, { error: 'bad_notify' });
      if (b.body != null && !str(b.body, LIMITS.notifyBodyMax)) return send(res, 400, { error: 'bad_notify' });
      const surface = b.surface != null ? str(b.surface, 128) : null;
      const ev = eventlog.appendEventSync(undefined, {
        sessionId: `notify:${machineId}`, event: 'Notify', notificationType: kind,
        ...(surface ? { surfaceId: surface } : {}),
      });
      if (!ev) return send(res, 500, { error: 'notify_failed' });
      send(res, 200, { ok: true, event: { ...ev, title, ...(b.body ? { body: b.body } : {}) } });
    });
  }

  // true when answered. `u` is the parsed URL.
  function handle(req, res, u) {
    const p = u.pathname;
    if (req.method === 'POST' && p === '/cmux/notify') { notify(req, res); return true; }
    if (p === '/cmux/sessions') {
      if (req.method !== 'GET') return false;
      list(res).catch(() => send(res, 500, { error: 'sessions_failed' }));
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

  return { handle };
}

module.exports = { createSessionRoutes, LIMITS };
