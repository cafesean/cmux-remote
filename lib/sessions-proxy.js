'use strict';
// p41 B1 — /api/sessions* : pass-through to the bridges' /cmux/sessions* routes (A6, sessions/routes.js;
// shapes in sessions/CONTRACT.md "Routes"; spec _specs/p41-native-apps/specs.md §4.1, §7).
//
//   GET /api/sessions                          merge of every machine's GET /cmux/sessions
//   GET /api/sessions/:id/thread?before=&limit=   -> the owning bridge, status + body passed through
//   GET /api/sessions/:id/thread-stream        -> the owning bridge's SSE, bytes streamed unbuffered
//   GET /api/sessions/:id/attachment/:n        -> the owning bridge's image bytes
//   GET /api/sessions/:id/upload/:rel          -> an uploaded image's bytes (D57)
//   POST /api/sessions/:id/name {name}         -> the owning bridge's POST /cmux/session-name (A16; '' clears)
//   GET /api/sessions/:id/subagents[/:agentId/thread|thread-stream] -> the owning bridge (A10; stream is SSE)
//
// SESSION IDS. The bridge already mints `<bridgeMachineId>:<surfaceId>` (CONTRACT.md Session.id,
// "unique across all machines"), where bridgeMachineId = RADAR_MACHINE_ID || hostname — NOT the id in
// this server's registry. So ids pass through UNCHANGED (the contract and the thread-stream events
// carry that id) and the server learns bridgeMachineId -> registry machine from each list reply.
// Routing an id: ?machine=<registry id> (explicit) > learned map (longest `<bridgeMachineId>:` prefix)
// > a registry id equal to the prefix > one refresh of every list > the sole machine, if there is one.
// If two registry machines report the same bridgeMachineId the first in registry order wins the map
// (the other stays reachable via ?machine=); set distinct RADAR_MACHINE_ID per host.
//
// No transcript or pane content is stored or logged here (spec §7): bodies are relayed, never kept
// (the id->machine map holds ids only). Nothing is logged per request.

const { AGENT_ID_RE } = require('../sessions/transcript-claude');

const LIMITS = {
  idMax: 256,                // longest session id accepted in a path; more -> 400
  listTimeoutMs: 10000,      // one machine's list; a slower machine is reported ok:false, not waited for
  threadTimeoutMs: 25000,    // thread page read
  attachmentTimeoutMs: 30000,
  refreshDebounceMs: 5000,   // min gap between id->machine refresh sweeps triggered by an unknown machine id
  nameBodyMax: 4096,         // POST /api/sessions/:id/name body cap (A16); more -> 413
  nameTimeoutMs: 20000,
  streamConnectMs: 15000,    // time for the bridge to answer a thread-stream request (the stream itself is unbounded)
};
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  pragma: 'no-cache', expires: '0', 'surrogate-control': 'no-store',
};

function createSessionsProxy({ machines, upstream, accessHeaders, findMachine }) {
  const owner = new Map();   // bridgeMachineId -> registry machine

  const call = (m, pq, signal) => upstream(m, pq, { headers: { 'x-bridge-secret': m.secret, ...accessHeaders(m) }, signal });
  const json = (res, code, obj) => { res.writeHead(code, JSON_HEADERS); res.end(JSON.stringify(obj)); };

  async function listOne(m) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.listTimeoutMs);
    try {
      const r = await call(m, '/cmux/sessions', ctrl.signal);
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !Array.isArray(body.sessions)) return { m, ok: false, error: r.ok ? 'bad_upstream' : `http_${r.status}` };
      return { m, ok: true, machineId: String(body.machineId || m.id), sessions: body.sessions };
    } catch (_) { return { m, ok: false, error: 'bridge_unreachable' }; } finally { clearTimeout(timer); }
  }
  async function listAll() {
    const rs = await Promise.all(machines.map(listOne));
    // Replace the mapping per ANSWERING machine only. A machine whose list failed (tunnel blip) keeps
    // its old entries, so its ids stay routable and a reconnect gets 502, not "no such machine" (404).
    for (const r of rs) if (r.ok) for (const [k, v] of owner) if (v === r.m) owner.delete(k);
    for (const r of rs) if (r.ok && !owner.has(r.machineId)) owner.set(r.machineId, r.m);
    return rs;
  }

  function byPrefix(id) {
    let best = null;
    for (const k of owner.keys()) if (id.startsWith(`${k}:`) && (!best || k.length > best.length)) best = k;
    return best ? owner.get(best) : null;
  }
  async function resolve(id, machineParam) {
    if (machineParam) return findMachine(machineParam);
    let m = byPrefix(id);
    if (m) return m;
    m = machines.find((x) => id.startsWith(`${x.id}:`));
    if (m) return m;
    const rs = await listAll();
    m = byPrefix(id) || (machines.length === 1 ? machines[0] : null);
    if (m) return m;
    // Not found, but a machine did not answer: it may own this id. Unknown-because-unreachable is 502.
    return rs.some((r) => !r.ok) ? 'unreachable' : null;
  }

  // Status + a small header allowlist + the body stream, untouched. `abortOnClose` ties the upstream
  // request to the client so a left client does not leave the bridge streaming into the void.
  async function pipeThrough(req, res, m, pq, { timeoutMs, sse }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // res 'close' with !writableEnded = the caller left (req 'close' also fires for a finished GET).
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    let up;
    try { up = await call(m, pq, ctrl.signal); } catch (_) { clearTimeout(timer); return json(res, 502, { error: 'bridge_unreachable' }); }
    if (sse) clearTimeout(timer);   // the connect window only; a stream has no end-to-end deadline
    const ct = up.headers.get('content-type') || 'application/octet-stream';
    if (sse && !(up.ok && up.body)) {
      clearTimeout(timer);
      const body = await up.json().catch(() => ({ error: 'bad_upstream' }));
      return json(res, up.status || 502, body);
    }
    const h = { 'content-type': ct, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const len = up.headers.get('content-length');
    if (len && !sse) h['content-length'] = len;
    if (sse) { h['cache-control'] = 'no-cache, no-transform'; h.connection = 'keep-alive'; h['x-accel-buffering'] = 'no'; }
    res.writeHead(up.status, h);
    if (!up.body) { clearTimeout(timer); return res.end(); }
    try {
      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => {
            const fin = () => { res.removeListener('drain', fin); res.removeListener('close', fin); r(); };
            res.once('drain', fin); res.once('close', fin);
          });
        }
        if (res.destroyed) break;
      }
    } catch (_) { /* client or bridge closed */ }
    clearTimeout(timer);
    try { res.end(); } catch (_) {}
  }

  // BUG2: the app sends session.machine (the BRIDGE's machineId, e.g. "mac-a.local") to the
  // /api/cmux/* routes, which only know registry ids. lookup() is the sync half (learned map);
  // ensure() is the async half: on a miss, refresh the map from one list sweep (coalesced, and at most
  // one sweep per LIMITS.refreshDebounceMs so an unknown id cannot turn into a fan-out per request).
  const lookup = (bridgeId) => (bridgeId ? owner.get(bridgeId) || null : null);
  let sweep = null;
  let sweptAt = 0;
  async function ensure(bridgeId) {
    if (!bridgeId || lookup(bridgeId)) return;
    if (!sweep && Date.now() - sweptAt >= LIMITS.refreshDebounceMs) {
      sweep = listAll().finally(() => { sweep = null; sweptAt = Date.now(); });
    }
    if (sweep) await sweep;
  }

  function readSmallBody(req) {
    return new Promise((resolve) => {
      let body = ''; let over = false;
      req.on('data', (c) => { if (over) return; body += c; if (body.length > LIMITS.nameBodyMax) { over = true; body = ''; resolve({ over }); } });
      req.on('end', () => { if (over) return; try { resolve({ b: JSON.parse(body || '{}') }); } catch (_) { resolve({ b: null }); } });
      req.on('error', () => resolve({ b: null }));
    });
  }
  // A16: POST /api/sessions/:id/name {name} -> bridge POST /cmux/session-name {sessionId, name}.
  async function rename(req, res, u) {
    let id;
    try { id = decodeURIComponent(u.pathname.split('/')[3]); } catch (_) { id = ''; }
    if (!id || id.length > LIMITS.idMax) return json(res, 400, { error: 'bad_id' });
    const { b, over } = await readSmallBody(req);
    if (over) return json(res, 413, { error: 'too_large' });
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'bad_json' });
    if (typeof b.name !== 'string') return json(res, 400, { error: 'bad_name' });
    const m = await resolve(id, u.searchParams.get('machine'));
    if (m === 'unreachable') return json(res, 502, { error: 'bridge_unreachable' });
    if (!m) return json(res, 404, { error: 'no_machine' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.nameTimeoutMs);
    try {
      const up = await upstream(m, '/cmux/session-name', { method: 'POST', body: JSON.stringify({ sessionId: id, name: b.name }),
        headers: { 'content-type': 'application/json', 'x-bridge-secret': m.secret, ...accessHeaders(m) }, signal: ctrl.signal });
      const body = await up.json().catch(() => ({ error: 'bad_upstream' }));
      json(res, up.status || 502, body);
    } catch (_) { json(res, 502, { error: 'bridge_unreachable' }); } finally { clearTimeout(timer); }
  }

  // Returns true when it answered. Auth has already happened (handleApi's gate).
  async function handle(req, res, u) {
    const p = u.pathname;
    if (p !== '/api/sessions' && !p.startsWith('/api/sessions/')) return false;
    if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/name$/.test(p)) { await rename(req, res, u); return true; }
    if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return true; }
    const mp = u.searchParams.get('machine');
    if (p === '/api/sessions') {
      const one = mp ? findMachine(mp) : null;
      if (mp && !one) { json(res, 404, { error: 'no_machine' }); return true; }
      const rs = mp ? [await listOne(one)] : await listAll();
      const sessions = [];
      for (const r of rs) if (r.ok) sessions.push(...r.sessions);
      json(res, 200, { sessions, machines: rs.map((r) => ({ id: r.m.id, label: r.m.label, machineId: r.machineId, ok: r.ok, ...(r.ok ? {} : { error: r.error }) })) });
      return true;
    }
    const parts = p.slice('/api/sessions/'.length).split('/');
    let id;
    try { id = decodeURIComponent(parts[0]); } catch (_) { id = ''; }
    if (!id || id.length > LIMITS.idMax) { json(res, 400, { error: 'bad_id' }); return true; }
    const kind = parts[1];
    const n = parts[2];
    let sub = null;
    let aid = '';   // validated agentId: letters, digits, '-' only
    if (kind === 'subagents' && parts.length === 4 && (parts[3] === 'thread' || parts[3] === 'thread-stream')) {
      try { aid = decodeURIComponent(n); } catch (_) { aid = ''; }
      if (!AGENT_ID_RE.test(aid)) { json(res, 400, { error: 'bad_agent_id' }); return true; }   // CONTRACT.md: 400
      sub = parts[3];
    }
    const ok = (kind === 'thread' && parts.length === 2) || (kind === 'thread-stream' && parts.length === 2)
      || (kind === 'attachment' && parts.length === 3 && n !== '')
      || (kind === 'upload' && parts.length === 3 && n !== '' && n.length <= 2048)
      || (kind === 'subagents' && parts.length === 2) || sub;
    if (!ok) { json(res, 404, { error: 'not_found' }); return true; }
    const m = await resolve(id, mp);
    if (m === 'unreachable') { json(res, 502, { error: 'bridge_unreachable' }); return true; }
    if (!m) { json(res, 404, { error: 'no_machine' }); return true; }
    const base = `/cmux/sessions/${encodeURIComponent(id)}/${kind}`;
    const pageQuery = () => {
      const q = new URLSearchParams();
      for (const k of ['before', 'limit']) { const v = u.searchParams.get(k); if (v != null && v !== '') q.set(k, v); }
      return q.toString() ? '?' + q : '';
    };
    if (kind === 'subagents') {
      // A10: the sub-agent list, a sub-agent's thread page, or its SSE stream. agentId was validated above.
      if (!sub) await pipeThrough(req, res, m, base, { timeoutMs: LIMITS.threadTimeoutMs, sse: false });
      else if (sub === 'thread') await pipeThrough(req, res, m, `${base}/${aid}/thread${pageQuery()}`, { timeoutMs: LIMITS.threadTimeoutMs, sse: false });
      else await pipeThrough(req, res, m, `${base}/${aid}/thread-stream`, { timeoutMs: LIMITS.streamConnectMs, sse: true });
    } else if (kind === 'thread') {
      // Re-serialised: only before/limit reach the bridge; the cursor is opaque and untouched.
      const q = new URLSearchParams();
      for (const k of ['before', 'limit']) { const v = u.searchParams.get(k); if (v != null && v !== '') q.set(k, v); }
      await pipeThrough(req, res, m, `${base}${q.toString() ? '?' + q : ''}`, { timeoutMs: LIMITS.threadTimeoutMs, sse: false });
    } else if (kind === 'thread-stream') {
      await pipeThrough(req, res, m, base, { timeoutMs: LIMITS.streamConnectMs, sse: true });
    } else if (kind === 'upload') {
      // D57: one path segment, decoded and re-encoded so the bridge sees exactly one segment.
      let rel;
      try { rel = decodeURIComponent(n); } catch (_) { json(res, 400, { error: 'bad_path' }); return true; }
      await pipeThrough(req, res, m, `${base}/${encodeURIComponent(rel)}`, { timeoutMs: LIMITS.attachmentTimeoutMs, sse: false });
    } else {
      await pipeThrough(req, res, m, `${base}/${encodeURIComponent(n)}`, { timeoutMs: LIMITS.attachmentTimeoutMs, sse: false });
    }
    return true;
  }
  return { handle, lookup, ensure, LIMITS };
}

module.exports = { createSessionsProxy, LIMITS };
