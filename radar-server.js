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
const { loadConfig, normalizeConfig } = require('./radar/config');

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

  // ---- the automatic-scan switch (p9 spec §8, S-006) --------------------------------------------
  // OPT-OUT ONLY: absent, this is `true` and radar behaves exactly as it always has. Present, it
  // means NO AUTOMATIC SCANNING OF ANY KIND — not the boot scan, and not one timer. Both halves are
  // load-bearing. A boot-scan-only switch leaves anything that injects a state.json fixture racing
  // the 60-second session sweep (radar/collector.js), and "the test usually finishes inside the
  // first tick" is a race, not a guarantee: one slow sweep republishes the fixture out from under
  // the assertion and the failure reads as a route bug.
  //
  // Two ways in, because there are two callers. `o.scanOnStart === false` is the in-process seam the
  // unit tests already use; `RADAR_SCAN_ON_START=0` is the only one a spawned `server.js` child has,
  // since server.js constructs radar with NO options. Either alone suffices — a caller asking for
  // quiet through one channel is not overruled by silence on the other.
  //
  // What stays live: every route, including POST /api/radar/scan. This suppresses what radar does on
  // its own, never what it is asked to do.
  const autoScan = !(o.scanOnStart === false || String(env.RADAR_SCAN_ON_START || '').trim() === '0');

  // ---- p6 handoff (spec §7.1) -----------------------------------------------------------------
  // The protocol lives in radar/handoff.js and is required LAZILY, on the first p6 request: this
  // file must keep serving p5 verbatim on a checkout where the handoff module is broken — the
  // require lands inside handle()'s try/catch and answers a radar-scoped 500, not a dead server.
  // `o.createHandoff` is the test seam, exactly like `o.createCollector` above.
  let handoff = null;
  async function getHandoff() {
    if (handoff) return handoff;
    const factory = o.createHandoff || require('./radar/handoff').createHandoff;
    // No config file on disk (a stubbed collector, a bare install) still yields a usable config:
    // normalizeConfig(null) is pure defaults, which is exactly what loadConfig degrades to anyway.
    const cfg = typeof paths.config === 'string' && paths.config
      ? (await loadConfig(paths.config, Date.now())).config
      : normalizeConfig(null).config;
    handoff = factory({
      dir: paths.dir,
      config: cfg,
      // SYNC on purpose — handoff.js consumes this inside preview/commit/sweep and branches on
      // `if (!state)`. collector.getState() is async, and a Promise is truthy, so wiring it here
      // would make every preview 422 with an undefined board. See collector.lastStateSync.
      getState: () => collector.lastStateSync(),
      now: () => Date.now(),
      spawn: require('child_process').spawn,
    });
    return handoff;
  }

  // Every p6 route on a viewer answers 409 viewer_readonly and writes nothing (spec §3): a dispatch
  // from a viewer would spawn a process on the wrong machine against a plan.machine taken from the
  // leader's snapshot. The check runs BEFORE the body is read and BEFORE the handoff module is even
  // required — "does nothing" starts at zero side effects.
  async function viewerRefusal(res) {
    if (!(typeof paths.config === 'string' && paths.config)) return false;
    const { config } = await loadConfig(paths.config, Date.now());
    if (config.role !== 'viewer') return false;
    sendJson(res, 409, {
      error: 'viewer_readonly',
      message: 'this server is a viewer; handoffs are dispatched by the leader',
      leaderBaseUrl: config.leaderBaseUrl,
    });
    return true;
  }

  // p6's own body reader. The shared body() helper answers 400 bad_json WITHOUT a message, which is
  // fine for p5 but p6's envelope rule (spec §7.1) allows a missing `message` on exactly two
  // inherited 401s and nothing else. Object-shape and field validation (steps 3-7) belong to
  // radar/handoff.js, which owns the per-route tables.
  async function p6Body(req, res) {
    const r = await readJsonBody(req);
    if (r.tooLarge) { sendJson(res, 413, { error: 'body_too_large', message: `bodies are capped at ${BODY_CAP} bytes` }); return null; }
    if (r.badJson) { sendJson(res, 400, { error: 'bad_json', message: 'the request body is not valid JSON' }); return null; }
    if (r.aborted) { try { res.end(); } catch (_) {} return null; }
    return r.value;
  }

  // One relay for all five routes: the handoff module resolves {status, body} and this layer
  // answers it verbatim — no reshaping, or the route table would exist twice.
  async function routeHandoffCall(res, call, opts) {
    const h = await getHandoff();
    const out = await call(h);
    // A recovery press must clear the element NOW, not at the next sweep. The discard drive runs
    // its kill rounds inside the sweep that would otherwise republish, so without this the
    // PRE-PRESS element stays on disk for the whole drive — up to 2 x discardKillMs — and a
    // polling tab keeps showing something the operator already dismissed. §7.2 says one press
    // always clears it; this is what makes that true.
    // Best-effort: the press has already succeeded and its record is durable, so a failed
    // republication must not turn a 200 into an error. The next sweep publishes anyway.
    if (opts && opts.republish && out.status >= 200 && out.status < 300) {
      try { await collector.republishHandoffView(handoffPublish()); }
      catch (e) { log(`radar: republish after recovery press failed: ${(e && e.message) || e}`); }
    }
    return sendJson(res, out.status, out.body);
  }

  // derive() must SEE the live handoffs on EVERY publication path or suppression flickers: a scan
  // that omits this publishes handoffs:[] and every suppressed row flashes back onto the board
  // until the next sweep. One closure, passed to the timer scans, the boot scan AND the forced
  // POST /api/radar/scan — the forced path was measured doing exactly that flicker. Synchronous by
  // design (it runs inside runScan before publication, off the in-memory index, no disk); before
  // the first p6 request constructs the instance it answers null, which suppresses nothing — the
  // safe direction.
  const handoffPublish = () => (handoff ? handoff.publish() : null);

  // ---- lifecycle ------------------------------------------------------------------------------
  // start()/stop() are the ENTIRE rollback mechanism. stop() clears the collector's single
  // setInterval; with RADAR_ENABLED unset start() is never called, so there is no timer to clear.
  function start() {
    if (started) return;
    started = true;
    // p6: the handoff lifecycle rides the session sweep, handed in through runOpts because the
    // SERVER owns the single writer (spec principle 8) — the collector must never construct it, or
    // `radar scan` in a CLI process would become a second p6 writer. Lazy + isolated: a broken
    // handoff module degrades to "no lifecycle", never to "no radar", and a viewer runs none of it.
    const handoffSweep = async () => {
      if (!(typeof paths.config === 'string' && paths.config)) return;
      const { config } = await loadConfig(paths.config, Date.now());
      if (config.role === 'viewer') return;
      const h = await getHandoff();
      await h.sweep();
    };
    // The other half of the same wiring is handoffPublish, defined beside routeHandoffCall above
    // so the forced-scan route shares the exact same closure.
    // The scheduler is the first half of `autoScan` (see the switch above): not starting it is what
    // makes "no timer ever arms" structural rather than a promise — there is no interval to fire,
    // so neither the 10-minute git scan nor the 60-second session sweep can exist.
    if (autoScan) {
      try {
        collector.start({ fetch: true, handoffSweep, handoffPublish });
      } catch (e) {
        log(`radar: scheduler failed to start: ${(e && e.message) || e}`);
      }
    }
    // Startup recovery runs before the first sweep can fire (spec §M2): it settles every
    // non-terminal handoff, unsettled claim and open recovery-op exactly once.
    const recovered = (async () => {
      if (!(typeof paths.config === 'string' && paths.config)) return;
      const { config } = await loadConfig(paths.config, Date.now());
      if (config.role === 'viewer') return;
      const h = await getHandoff();
      await h.recoverAtStartup();
    })().catch((e) => log(`radar: handoff startup recovery failed: ${(e && e.message) || e}`));
    // One scan at boot, fire-and-forget. Without it an operator who has just set RADAR_ENABLED
    // cannot tell "radar is off" from "radar has not reached its first 10-minute tick yet".
    // The second half of `autoScan`. Startup recovery above is deliberately NOT gated: it settles
    // the handoff ledger and republishes only handoffs/index.json + locks.json, never state.json —
    // so it cannot disturb an injected snapshot, and suppressing it would turn a scan switch into a
    // p6 lifecycle switch.
    if (!autoScan) return;
    try {
      // handoffPublish must be passed here too, and startup recovery must finish FIRST. Without
      // either, the first snapshot after a restart carries handoffs:[] even when the ledger holds
      // live ones — so every suppressed row flashes back onto the board until the next sweep, which
      // is the feature visibly forgetting itself for up to a minute. Recovery before the scan also
      // makes the ordering structural instead of a race between a millisecond and a 60s tick.
      Promise.resolve(recovered).catch(() => {}).then(() => collector.scan({ fetch: true, handoffPublish })).then(
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
      if (req.method === 'GET' && p === '/api/radar/inbox') return await routeInbox(res);
      if (req.method === 'POST' && p === '/api/radar/scan') return await routeScan(res);
      if (req.method === 'POST' && p === '/api/radar/tag') return await routeTag(req, res);
      if (req.method === 'POST' && p === '/api/radar/decide') return await routeDecide(req, res);
      if (req.method === 'POST' && p === '/api/radar/flag') return await routeFlag(req, res);
      const close = /^\/api\/radar\/decisions\/([^/]+)\/close$/.exec(p);
      if (req.method === 'POST' && close) return await routeCloseDecision(res, decodeURIComponent(close[1]));

      // ----- p6 handoff routes (spec §7.1) — five, no collection route, mounted inside the same
      // dispatch so they inherit authed() and the token-in-url refusal above.
      if (req.method === 'POST' && p === '/api/radar/handoff/preview') {
        if (await viewerRefusal(res)) return;
        const b = await p6Body(req, res);
        if (b === null) return;
        return await routeHandoffCall(res, (h) => h.preview(b));
      }
      if (req.method === 'POST' && p === '/api/radar/handoff') {
        if (await viewerRefusal(res)) return;
        const b = await p6Body(req, res);
        if (b === null) return;
        return await routeHandoffCall(res, (h) => h.commit(b));
      }
      if (req.method === 'POST' && p === '/api/radar/recovery/adopt') {
        if (await viewerRefusal(res)) return;
        const b = await p6Body(req, res);
        if (b === null) return;
        return await routeHandoffCall(res, (h) => h.adopt(b), { republish: true });
      }
      if (req.method === 'POST' && p === '/api/radar/recovery/discard') {
        if (await viewerRefusal(res)) return;
        const b = await p6Body(req, res);
        if (b === null) return;
        return await routeHandoffCall(res, (h) => h.discard(b), { republish: true });
      }
      const hid = /^\/api\/radar\/handoff\/([^/]+)$/.exec(p);
      if (req.method === 'GET' && hid) {
        if (await viewerRefusal(res)) return;
        return await routeHandoffCall(res, (h) => h.get(decodeURIComponent(hid[1])));
      }
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

  // The inbox as its own resource (p9 spec §5.5). Deliberately NOT a slice of the state route: a
  // client that wants the queue should not have to fetch and re-derive the whole board, and the
  // classifier's health is a property of THIS resource — a snapshot carrying rows nobody could
  // classify is still a perfectly valid snapshot.
  //
  // Three states a client must be able to tell apart, and the codes are the whole point:
  //   * no snapshot at all          → 503 no_snapshot   (radar has never published)
  //   * a snapshot with no `inbox`  → 200 items: []     (a pre-p9 file; the queue really is empty)
  //   * a snapshot with an empty [] → 200 items: []     (nothing is waiting)
  // The first must never masquerade as the last two — "never computed" and "computed, empty" are
  // different facts, and an empty-looking 200 would erase that distinction (spec §2).
  async function routeInbox(res) {
    // Same viewer hop as the state route, for the same reason: on a viewer the queue of record is
    // the leader's, and the LEADER's token may never reach a browser served by a different host.
    if (typeof paths.config === 'string' && paths.config) {
      const { config } = await loadConfig(paths.config, Date.now());
      if (config.role === 'viewer') return await proxyInboxFromLeader(res, config);
    }

    const state = await collector.getState();
    if (!state) return sendJson(res, 503, { error: 'no_snapshot', message: 'radar has not published a snapshot yet' });
    const items = Array.isArray(state.inbox) ? state.inbox : [];
    // `generatedAt` is the SNAPSHOT's, verbatim — never Date.now(). It is what tells a client how
    // old this queue is, and minting a fresh timestamp here would make a stale board look current.
    //
    // `degraded` is a claim about the classifier, read back off the rows it produced: any row whose
    // verdict is `unknown` means the classifier could not speak for that session — no credential, a
    // transport failure, a missing transcript. §5.3 synthesizes a full `intent` for a row that
    // arrives without one, so the nested read is safe; it is still written defensively, because a
    // hand-built or hand-edited state.json is exactly the input that would otherwise throw a 500
    // out of a read-only route.
    const degraded = items.some((it) => !!(it && it.intent && it.intent.verdict === 'unknown'));
    return sendJson(res, 200, {
      items,
      generatedAt: state.generatedAt,
      sources: { classifier: degraded ? 'degraded' : 'ok' },
    });
  }

  // ONE viewer hop, shared by both GET routes. p9 §5.5 requires the inbox proxy to mirror the state
  // proxy exactly — same five failure codes, same `lastGood: false`, same bridgeMs timeout, same
  // Bearer-header-never-query-string rule — and the only way to guarantee "exactly" over time is for
  // there to be a single copy of that vocabulary. Each route supplies only what actually differs:
  // the upstream path, and an optional rewrite of the body on the way back.
  //
  // Every failure here is 502 + `lastGood: false` rather than a synthesised empty snapshot: the UI's
  // stale-state contract keeps rendering the last snapshot IT holds and badges the failure, and it
  // can only do that if a failed proxy is distinguishable from a real empty board (spec §2).
  async function proxyFromLeader(res, config, apiPath, rewrite) {
    const base = config.leaderBaseUrl;
    if (!base) return sendJson(res, 502, { error: 'leader_unconfigured', message: 'role=viewer but leaderBaseUrl is unset', lastGood: false });
    const token = config.leaderTokenRef ? env[config.leaderTokenRef] : null;
    if (config.leaderTokenRef && !token) {
      return sendJson(res, 502, { error: 'leader_token_missing', message: `env ${config.leaderTokenRef} is unset`, lastGood: false });
    }
    const url = base.replace(/\/+$/, '') + apiPath;
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
      if (typeof rewrite === 'function') body = rewrite(body);
      return sendJson(res, 200, body);
    } catch (e) {
      const why = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e);
      return sendJson(res, 502, { error: 'leader_unreachable', message: why, lastGood: false });
    } finally { clearTimeout(timer); }
  }

  // VIEWER ROLE OVERLAY (p6 spec §3). The leader's snapshot says "leader" — the truth about the
  // machine that derived it, and the wrong answer on the one machine that needs the right one: the
  // tab reads state.role to decide whether to render select at all, and a select affordance that can
  // only 409 is itself a chore. The ONLY field either proxy rewrites, unconditionally, on the
  // response — the leader's stored snapshot is untouched.
  const proxyStateFromLeader = (res, config) => proxyFromLeader(res, config, '/api/radar/state', (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) body.role = 'viewer';
    return body;
  });

  // The inbox envelope carries no `role` and nothing else a viewer must reinterpret, so it is
  // returned verbatim: the leader already decided what is waiting and how healthy the classifier
  // was, and a viewer that second-guessed either would be publishing a second, quieter truth.
  const proxyInboxFromLeader = (res, config) => proxyFromLeader(res, config, '/api/radar/inbox', null);

  // Coalesced by the collector itself: concurrent callers join the single in-flight scan rather
  // than starting a second fan-out over a few hundred git spawns. The response is a receipt, not
  // the snapshot — clients read state through GET /api/radar/state, which has the schema.
  async function routeScan(res) {
    // handoffPublish rides along (p6): a forced scan without it publishes a handoff-less snapshot
    // and every suppressed row flashes back until the next sweep — measured by the S-009 proof.
    const r = await collector.scan({ fetch: true, handoffPublish });
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
