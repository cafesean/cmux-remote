'use strict';
// radar-server — the /api/radar/* surface (p5 spec §7, story S-001b).
//
// THIS FILE IS NEVER REQUIRED UNLESS RADAR_ENABLED IS SET. That is the point of it living outside
// server.js rather than inside it: "RADAR_ENABLED unset means zero radar code paths active" is then
// a structural property of the require graph — nothing under radar/ is loaded, no timer exists, no
// handler is registered — instead of a flag that some future branch forgets to check.
//
// Radar is an ADD-ON to a terminal mirror that people depend on, so the second rule is: it can fail
// however it likes, but it may only ever break itself. Every handler runs inside a try/catch and
// answers with a radar-scoped error; server.js wraps the dispatch a second time so an escaped
// rejection cannot become an unhandled rejection and kill the process serving every other route.
//
// Read-only outside ~/.radar/: the routes here can publish a snapshot and edit radar's own three
// JSON files. Nothing else. No git write, no Jira, no DB, no deploy.
const store = require('./radar/store');
const { loadConfig } = require('./radar/config');

const BODY_CAP = 16 * 1024;            // spec §7
const HARD_CAP = 16 * BODY_CAP;        // give up on a body that keeps coming after the 413

const NO_STORE = {
  'content-type': 'application/json',
  'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'surrogate-control': 'no-store',
};

function sendJson(res, code, obj) {
  res.writeHead(code, NO_STORE);
  res.end(JSON.stringify(obj));
}

// Body reader with the §7 16 KB cap. Deliberately does NOT destroy the socket at the cap the way
// server.js's readBody does — a destroyed socket cannot carry the 413 back, and a client that gets
// no answer retries, which is how a size limit turns into a load problem. It drains instead, and
// only cuts the connection if the sender keeps going long past the limit.
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0;
    let over = false;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (c) => {
      len += c.length;
      if (len > BODY_CAP) {
        over = true;
        chunks.length = 0;
        if (len > HARD_CAP) { req.destroy(); finish({ aborted: true }); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return finish({ tooLarge: true });
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return finish({ value: {} });
      try { finish({ value: JSON.parse(text) }); } catch (_) { finish({ badJson: true }); }
    });
    req.on('error', () => finish({ aborted: true }));
    req.on('aborted', () => finish({ aborted: true }));
  });
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function createRadar(opts) {
  const o = opts || {};
  const log = o.log || ((...a) => console.error(...a));
  const radarDir = o.radarDir || process.env.RADAR_DIR || undefined;
  const factory = o.createCollector || require('./radar/collector').createCollector;
  const isRefusal = require('./radar/collector').isRefusal;
  const collector = factory({ radarDir, configPath: o.configPath });
  const httpGet = o.fetchImpl || ((...a) => fetch(...a));
  const env = o.env || process.env;
  const paths = collector.paths || { dir: radarDir || store.defaultRadarDir() };
  let started = false;

  // ---- lifecycle ------------------------------------------------------------------------------
  // start()/stop() are the ENTIRE rollback mechanism. stop() clears the collector's single
  // setInterval; with RADAR_ENABLED unset start() is never called, so there is no timer to clear.
  function start() {
    if (started) return;
    started = true;
    try {
      collector.start({ fetch: true });
    } catch (e) {
      log(`radar: scheduler failed to start: ${(e && e.message) || e}`);
    }
    // One scan at boot, fire-and-forget. Without it an operator who has just set RADAR_ENABLED
    // cannot tell "radar is off" from "radar has not reached its first 10-minute tick yet".
    if (o.scanOnStart === false) return;
    try {
      Promise.resolve(collector.scan({ fetch: true })).then(
        (r) => { if (r && !r.published) log(`radar: boot scan did not publish: ${r.error}`); },
        (e) => log(`radar: boot scan failed: ${(e && e.message) || e}`),
      );
    } catch (e) { log(`radar: boot scan failed: ${(e && e.message) || e}`); }
  }

  function stop() {
    started = false;
    try { collector.stop(); } catch (e) { log(`radar: stop failed: ${(e && e.message) || e}`); }
  }

  // ---- routes ---------------------------------------------------------------------------------
  // Mounted by server.js AFTER authed(), so everything below is already token-gated. The one thing
  // this layer adds to that gate is the §7 rule the shared gate cannot express: authed() also
  // accepts ?token= (EventSource cannot set headers), and no radar route is an EventSource. A radar
  // URL carrying a token would put the key to the whole UI into browser history and every access
  // log that records query strings, so radar refuses to be authenticated that way at all.
  async function handle(req, res, u) {
    const p = u.pathname;
    if (u.searchParams.has('token')) return sendJson(res, 401, { error: 'token_in_url' });

    try {
      if (req.method === 'GET' && p === '/api/radar/state') return await routeState(res);
      if (req.method === 'POST' && p === '/api/radar/scan') return await routeScan(res);
      if (req.method === 'POST' && p === '/api/radar/tag') return await routeTag(req, res);
      if (req.method === 'POST' && p === '/api/radar/decide') return await routeDecide(req, res);
      if (req.method === 'POST' && p === '/api/radar/flag') return await routeFlag(req, res);
      const close = /^\/api\/radar\/decisions\/([^/]+)\/close$/.exec(p);
      if (req.method === 'POST' && close) return await routeCloseDecision(res, decodeURIComponent(close[1]));
      // GET /api/radar/scan lands here on purpose: a force-scan is a mutation, so it is POST-only
      // and must not be reachable from a link, a prefetch, or an <img src>.
      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      // The error boundary. Anything the collector throws — a corrupt state file, a git spawn that
      // exploded, a bug in a module — stops here as a radar-scoped 500. No other route is touched.
      log(`radar: ${req.method} ${p} failed: ${(e && e.stack) || e}`);
      if (!res.headersSent) return sendJson(res, 500, { error: 'radar_error', message: (e && e.message) || String(e) });
      try { res.end(); } catch (_) { /* already gone */ }
    }
  }

  // The last atomic snapshot, VERBATIM — the schema in radar/state.schema.json is the contract and
  // reshaping it here would fork it. No snapshot yet is 503, never an empty-looking 200: an empty
  // board and a board that has never been computed must not look the same (spec §2, unknown beats
  // false green).
  async function routeState(res) {
    // VIEWER PROXY (spec §3). On a viewer the state of record lives on the leader, and the browser
    // must never be the thing that reaches for it: a cross-origin fetch would need the LEADER's
    // token in a page served by a different host, which is how a credential ends up in a second
    // machine's localStorage. So the viewer's own SERVER fetches it, and the browser stays
    // same-origin with the token it already has. Exactly one hop, held server-side.
    if (typeof paths.config === 'string' && paths.config) {
      const { config } = await loadConfig(paths.config, Date.now());
      if (config.role === 'viewer') return await proxyStateFromLeader(res, config);
    }

    const state = await collector.getState();
    if (!state) return sendJson(res, 503, { error: 'no_snapshot', message: 'radar has not published a snapshot yet' });
    return sendJson(res, 200, state);
  }

  // Every failure here is 502 + `lastGood: false` rather than a synthesised empty snapshot: the UI's
  // stale-state contract keeps rendering the last snapshot IT holds and badges the failure, and it
  // can only do that if a failed proxy is distinguishable from a real empty board (spec §2).
  async function proxyStateFromLeader(res, config) {
    const base = config.leaderBaseUrl;
    if (!base) return sendJson(res, 502, { error: 'leader_unconfigured', message: 'role=viewer but leaderBaseUrl is unset', lastGood: false });
    const token = config.leaderTokenRef ? env[config.leaderTokenRef] : null;
    if (config.leaderTokenRef && !token) {
      return sendJson(res, 502, { error: 'leader_token_missing', message: `env ${config.leaderTokenRef} is unset`, lastGood: false });
    }
    const url = base.replace(/\/+$/, '') + '/api/radar/state';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (config.timeouts && config.timeouts.bridgeMs) || 8000);
    try {
      // Bearer header, never a query string — the same rule this file enforces on its own callers.
      const up = await httpGet(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: ac.signal,
      });
      const text = await up.text();
      if (!up.ok) return sendJson(res, 502, { error: 'leader_error', message: `leader answered ${up.status}`, lastGood: false });
      let body;
      try { body = JSON.parse(text); } catch (_) {
        return sendJson(res, 502, { error: 'leader_bad_json', message: 'leader did not answer JSON', lastGood: false });
      }
      return sendJson(res, 200, body);
    } catch (e) {
      const why = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e);
      return sendJson(res, 502, { error: 'leader_unreachable', message: why, lastGood: false });
    } finally { clearTimeout(timer); }
  }

  // Coalesced by the collector itself: concurrent callers join the single in-flight scan rather
  // than starting a second fan-out over a few hundred git spawns. The response is a receipt, not
  // the snapshot — clients read state through GET /api/radar/state, which has the schema.
  async function routeScan(res) {
    const r = await collector.scan({ fetch: true });
    const body = {
      ok: !!(r && r.ok),
      published: !!(r && r.published),
      durationMs: (r && r.durationMs) || null,
      generatedAt: (r && r.state && r.state.generatedAt) || null,
      warnings: (r && r.warnings) || [],
      error: (r && r.error) || null,
    };
    return sendJson(res, body.ok ? 200 : 500, body);
  }

  // Mutations. Two failure classes, kept distinct because they mean different things to a caller:
  // a malformed request is 400 and is the caller's bug; a well-formed request naming something
  // radar does not know ("unknown repo", "no open decision with id X") is 422 — a stale UI or a
  // typo. Every one of them goes through the collector, which is the single write queue; there is
  // no second write path in this file.
  //
  // The collector marks its VALIDATION throws as refusals (radar/collector.js RadarRefusal). Only
  // those are 422. Anything else escaping a mutation is a genuine fault — disk full, a bug — and
  // reports 500, because a fault wearing a 4xx tells the caller to fix input when the thing to fix
  // is this process. The message is carried verbatim in both cases, so the reason is never hidden.
  const bad = (res, message) => sendJson(res, 400, { error: 'bad_request', message });

  async function body(req, res) {
    const r = await readJsonBody(req);
    if (r.tooLarge) { sendJson(res, 413, { error: 'body_too_large', message: `bodies are capped at ${BODY_CAP} bytes` }); return null; }
    if (r.badJson) { sendJson(res, 400, { error: 'bad_json' }); return null; }
    if (r.aborted) { try { res.end(); } catch (_) {} return null; }
    if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) { bad(res, 'body must be a JSON object'); return null; }
    return r.value;
  }

  const unprocessable = (res, e) => (isRefusal(e)
    ? sendJson(res, 422, { error: 'unprocessable', message: (e && e.message) || String(e) })
    : sendJson(res, 500, { error: 'radar_error', message: (e && e.message) || String(e) }));

  async function routeTag(req, res) {
    const b = await body(req, res);
    if (!b) return;
    const kind = str(b.kind) || 'branch';
    // {kind:"spec"} lands mod-specs' alias append (spec §M5): the folder's p-numeral is appended to
    // aliases.epics[epic], so the orphan resolves on the next scan. It is a DIFFERENT write from a
    // branch tag — treating it as one would put a branchOverrides entry that can never match
    // anything into the file — hence two shapes behind one route rather than one lenient one.
    if (kind === 'spec') {
      const specFolder = str(b.specFolder); const epic = str(b.epic);
      if (!specFolder || !epic) return bad(res, 'spec tag requires specFolder and epic');
      try { await collector.tagSpec({ specFolder, epic }); } catch (e) { return unprocessable(res, e); }
      return sendJson(res, 200, { ok: true, kind: 'spec', specFolder, epic });
    }
    if (kind !== 'branch') return bad(res, 'kind must be "branch" or "spec"');
    const repo = str(b.repo); const branch = str(b.branch); const epic = str(b.epic);
    if (!repo || !branch || !epic) return bad(res, 'tag requires repo, branch and epic');
    try { await collector.tagBranch({ repo, branch, epic }); } catch (e) { return unprocessable(res, e); }
    return sendJson(res, 200, { ok: true, repo, branch, epic });
  }

  async function routeDecide(req, res) {
    const b = await body(req, res);
    if (!b) return;
    const title = str(b.title);
    if (!title) return bad(res, 'decide requires a title');
    let created;
    try {
      created = await collector.addDecision({ title, context: b.context == null ? undefined : String(b.context), epic: str(b.epic) || undefined });
    } catch (e) { return unprocessable(res, e); }
    return sendJson(res, 200, { ok: true, decision: created });
  }

  async function routeCloseDecision(res, id) {
    if (!str(id)) return bad(res, 'a decision id is required');
    try { await collector.closeDecision(id); } catch (e) { return unprocessable(res, e); }
    return sendJson(res, 200, { ok: true, id });
  }

  async function routeFlag(req, res) {
    const b = await body(req, res);
    if (!b) return;
    const epic = str(b.epic); const state = str(b.state);
    if (!epic) return bad(res, 'flag requires an epic');
    if (['on', 'off', 'n/a'].indexOf(state) === -1) return bad(res, 'flag state must be on|off|n/a');
    try { await collector.setFlag({ epic, state }); } catch (e) { return unprocessable(res, e); }
    // Asserted truth, returned as such: radar never detects a flag, and the API should not let a
    // caller believe otherwise (spec §2).
    return sendJson(res, 200, { ok: true, epic, state, asserted: true });
  }

  return {
    handle, start, stop, collector, paths,
    isStarted: () => started,
  };
}

module.exports = { createRadar, BODY_CAP, readJsonBody };
