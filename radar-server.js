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
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./radar/store');
const { loadConfig, normalizeConfig } = require('./radar/config');
// p9 §5.5. The reply route consumes ONLY exported primitives, and it consumes them off the module
// namespace rather than by destructuring so there is visibly one implementation of each: the fold,
// the status calculation, the event read and the recorded-only join are the collector's own, and a
// second copy of any of them would be a second answer to "is this session still waiting?".
const sessions = require('./radar/mod-sessions');
const { readLastAssistantText } = require('./radar/classify');
// The one prompt-detection implementation in this repository. Gate 3 classifies a pane by importing
// it, never by re-deriving it — a private heuristic here would drift from the one the UI shows.
const { paneKind } = require('./public/menuparse.js');
// p11 S-006. The dispatch mechanism and, above all, its refusals. Every decision it makes — the
// authority gate, the leader gate, the eligibility re-check, the whole error table — is ITS, and the
// route below is wiring plus a verbatim relay. The operator arm stays off until a config on disk
// sets dispatch.enabled, which nothing in this phase does.
const { createDispatcher } = require('./radar/dispatch');

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

// ================================================================================================
// p9 §5.5 — POST /api/radar/inbox/reply
//
// This is the one route in radar that WRITES INTO A TERMINAL, and §2.1 principle 4 is the whole
// reason the pipeline below has nine steps instead of one: text sent to a pane that is not at a
// prompt goes wherever the cursor happens to be. Every gate exists to make that impossible, and
// every failure code exists so the operator is told which gate refused and whether retrying is safe.
//
// The asymmetry that decides every mapping in this file (§5.5 step 8): an outcome may only read as
// "nothing was typed" when the bridge's contract PROVES the rejection preceded typing. Everything
// unprovable answers `send_unconfirmed` and takes the lease. `send_failed` tells the operator to
// retry immediately — if that is ever wrong they double-type into a live terminal.

const REPLY_LEASE_MS = 120000;         // §5.5 step 4 — the `ok` lease only; see leaseHeld()
const SEND_TIMEOUT_MS = 20000;         // §5.5 step 8
const REPLY_TEXT_CAP = 8192;           // §5.5 step 1, in UTF-8 BYTES

// §5.5 gate 1. An allowlist, exactly like BLOCKING_NOTIFICATIONS: `permission_request` is a session
// waiting on a MENU, and typing a sentence at a menu presses whatever the letters happen to select.
const TEXT_ANSWERABLE = new Set(['idle_prompt', 'agent_needs_input']);

// §6.1's lease column, verbatim: the three outcomes where text MAY have reached the pane. Nothing
// else takes a lease, so an immediate retry after any other outcome is legal and the table's Retry
// column stays true.
const LEASE_OUTCOMES = new Set(['ok', 'send_unconfirmed', 'text_inserted_submit_failed']);

// §6.1, THE AUTHORITATIVE OUTCOME TABLE — one row per code, status and message byte-for-byte. The
// client renders its own `copyForCode` map and never trusts server text (§5.6), so these two copies
// of each sentence must agree; this object is the server's half and the spec table is the source.
// `ok` is deliberately absent: it is the one row with NO message, and its body is exactly {ok:true}.
const REPLY_OUTCOMES = {
  bad_json: [400, 'Malformed request.'],
  bad_request: [400, 'Malformed request.'],
  unknown_machine: [400, 'No bridge is configured for this machine.'],
  empty_reply: [400, 'Reply is empty.'],
  body_too_large: [413, 'Reply exceeds the request size cap.'],
  reply_too_large: [413, 'Reply exceeds 8192 bytes.'],
  unauthenticated_server: [403, 'Set SERVER_TOKEN to enable replies.'],
  viewer_refused: [409, 'This install is a viewer — answer from the leader.'],
  session_not_found: [404, 'No trace of this session in the retained events.'],
  already_answered: [409, 'This session is no longer waiting.'],
  question_changed: [409, 'The question changed — waiting for the update…'],
  surface_reassigned: [409, 'Another session has taken over this tab.'],
  not_text_answerable: [409, 'This session is waiting at a permission prompt — open the tab to answer it.'],
  tab_gone: [409, "This session's tab is closed."],
  not_at_prompt: [409, "The tab isn't at a Claude prompt right now."],
  pane_changed: [409, 'The tab changed while sending — nothing was sent.'],
  events_unavailable: [502, "The event log isn't readable right now — nothing was sent."],
  bridge_unreachable: [502, "The machine isn't reachable right now."],
  send_failed: [502, 'Sending failed — nothing was typed into the tab.'],
  send_unconfirmed: [502, "The send wasn't confirmed — check the tab before retrying."],
  text_inserted_submit_failed: [502, 'Text was placed in the tab but not submitted — finish it there.'],
};

// The route's transport. radar/http.js and mod-sessions' defaultHttp are both GET-only, and the send
// is a POST — so this is the one place a bridge-bound method/body exists. It owns NO timeout: the
// ROUTE owns every deadline through an AbortController it created (§5.5 steps 6-8), which is what
// makes an injected transport time out exactly like the real one instead of ignoring the clock.
function bridgeFetch(url, opts) {
  const o = opts || {};
  return fetch(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body, signal: o.signal })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      // A non-JSON body is not an exception here: it is EVIDENCE, and each gate decides what it
      // means (bridge_unreachable for tree/grid, send_unconfirmed for the send).
      try { json = JSON.parse(text); } catch (_) { /* json stays null */ }
      return { ok: r.ok, status: r.status, json };
    });
}

// The canonical per-session key — the same shape §5.3 uses for row identity, so the mutex, the lease
// and the row a client clicked are all keyed by value and never by object identity.
const replyKey = (machine, sessionId) => JSON.stringify([machine, sessionId]);

// §5.5 step 4, LIFETIME BY OUTCOME with an exact comparator.
//   * `ok`      — expired precisely when now - at >= REPLY_LEASE_MS. Held at 119999, gone at 120000.
//                 It exists only to bridge the ~63 s hook latency; gate 1 protects everything after.
//   * the two uncertain writes — NEVER time-expire, at any elapsed distance. §6.1 marks them not
//                 retryable, and a timer that silently reopened the send after two minutes would
//                 make that a lie while the text may already be sitting in the pane. Their only
//                 release is a complete fold showing a NEW turn.
function leaseHeld(lease, now) {
  if (!lease) return false;
  if (lease.outcome !== 'ok') return true;
  return (now - lease.at) < REPLY_LEASE_MS;
}

// The completeness predicate, one rule everywhere it appears (gate 1 and the lease re-check). A read
// that SUCCEEDED while omitting history is not a complete read, and a partial history may never be
// allowed to claim `already_answered` — so this fails closed.
const eventsComplete = (r) => !!r && !r.error && Array.isArray(r.events) && (r.skipped || 0) === 0 && r.more !== true;

const isoMs = (ms) => (ms == null ? null : new Date(ms).toISOString());

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

  // ---- p9 §5.5 reply-route seams ---------------------------------------------------------------
  // Four injections, each because the route owns something a test must be able to drive: the clock
  // (the lease boundary is an exact comparator, not an approximation), the bridge transport (the
  // suite is offline), the timer factory (every deadline is the route's, so a fake clock can fire
  // it), and the logger (observability is an acceptance criterion, not a debug aid).
  const nowMs = typeof o.now === 'function' ? o.now : () => Date.now();
  const bridgeHttp = typeof o.bridgeHttp === 'function' ? o.bridgeHttp : bridgeFetch;
  const timers = o.timers || { setTimeout, clearTimeout };
  const inboxLog = typeof o.inboxLog === 'function' ? o.inboxLog : (line) => console.error(JSON.stringify(line));
  const eventsPath = paths.events || (paths.dir ? path.join(paths.dir, 'events') : undefined);

  // The mutex and the leases are IN-PROCESS state (§5.5 step 4, §10): one radar-server owns one
  // machine's replies in v1. A restart forgets every chain and every lease INCLUDING the two that
  // never time-expire — gate 1 and the bridge's own seq precondition are the backstops, and that is
  // stated rather than papered over.
  const replyChains = new Map();
  const replyLeases = new Map();

  // A promise chain per canonical key. `run` is installed on BOTH settlement paths so one rejected
  // reply cannot wedge the session's queue forever, and the tail is dropped when it is still the
  // tail so the map does not grow one entry per session for the life of the process.
  function withReplyLock(key, fn) {
    const prev = replyChains.get(key) || Promise.resolve();
    const run = () => fn();
    const next = prev.then(run, run);
    const tail = next.then(() => {}, () => {});
    replyChains.set(key, tail);
    tail.then(() => { if (replyChains.get(key) === tail) replyChains.delete(key); });
    return next;
  }

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

  // ---- p11 dispatch (spec S-006) ---------------------------------------------------------------
  // radar/dispatch.js owns every judgment; this is five deps and nothing else. A copy of any of its
  // rules here would be a second answer to "may this dispatch happen?", and the one that runs at
  // dispatch time is the only one that can enforce "never two writers".
  //
  // Every dep is a CLOSURE THAT RE-READS AT CALL TIME, never a captured value. The §8.1 switch only
  // means something if flipping `dispatch.enabled` on disk takes effect without a restart, and the
  // server-side eligibility re-check only means something against the CURRENT snapshot — a config
  // or a state read hoisted to construction time would quietly restore the stale-snapshot race the
  // re-check exists to close.
  const radarConfig = async () => ((typeof paths.config === 'string' && paths.config)
    ? (await loadConfig(paths.config, nowMs())).config
    : normalizeConfig(null).config);

  // The injection transport: the SAME bridge resolution and the SAME /cmux/send contract the p9
  // reply route uses (§5.5 steps 3 and 8), through the same injectable http so the suite stays
  // offline. It carries no expect_seq — that precondition guards a pane a human is watching, while a
  // dispatch is gated by eligibility: an idle session on a cluster the re-check proved free. This
  // function decides nothing about whether to send; it sends, and reports what the bridge said.
  async function dispatchSend(args) {
    const a = args || {};
    const cfg = await radarConfig();
    // The RAW file through the EXPORTED normalizeBridges, exactly as the reply route does it: the
    // v1 config schema does not model bridges, so the normalized config carries none at all.
    const rawCfg = (typeof paths.config === 'string' && paths.config)
      ? (await store.readJson(paths.config, null)).value
      : null;
    const bridges = sessions.normalizeBridges(rawCfg, cfg.collectorId || os.hostname(), []);
    const bridge = bridges.find((x) => x.id === a.machine) || null;
    if (!bridge) return { ok: false, error: 'unknown_machine' };
    const secret = bridge.secretRef ? (env[bridge.secretRef] || '') : '';
    // The deadline is the ROUTE's, on a controller it created — an injected transport then times out
    // exactly like the real one instead of ignoring the clock.
    const ctl = new AbortController();
    const timer = timers.setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      const r = await bridgeHttp(`${bridge.baseUrl}/cmux/send`, {
        method: 'POST',
        headers: secret ? { 'x-bridge-secret': secret } : {},
        body: JSON.stringify({ surface: a.surface, text: a.text, submit: a.submit === true }),
        signal: ctl.signal,
        timeoutMs: SEND_TIMEOUT_MS,
      });
      // Only the bridge's own {ok:true} is a send. A 4xx, a non-JSON body, a 200 that does not say
      // so — each is a failure the dispatcher records and falls back from, never a silent success.
      if (r && r.ok && r.json && r.json.ok === true) return { ok: true };
      return { ok: false, error: (r && r.json && r.json.error) || `bridge status ${(r && r.status) || 0}` };
    } catch (e) {
      // A thrown transport is evidence, not a crash: same shape, so the dispatcher has one rule.
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      timers.clearTimeout(timer);
    }
  }

  const dispatcher = (o.createDispatcher || createDispatcher)({
    config: radarConfig,
    readState: () => collector.getState(),
    now: nowMs,
    // The config names the env var; the ENVIRONMENT holds the value (radar/config.js — an
    // authorityTokenRef never carries a secret). A config file that leaks therefore tells a reader
    // which variable to want and nothing more.
    authorityToken: async () => {
      const cfg = await radarConfig();
      const ref = cfg.dispatch && cfg.dispatch.authorityTokenRef;
      return ref ? (env[ref] || null) : null;
    },
    bridgeSend: dispatchSend,
    // `spawn` IS DELIBERATELY NOT WIRED, and the dispatcher's own 501 spawn_unavailable is the
    // honest answer for it. p6 owns the only session spawn in this repository and it exists only at
    // the end of preview -> commit, which is what makes the seed file, the durable reservation and
    // the stop-capture wrapper exist; there is no spawn({workRef, seed}) to hand over. A second
    // implementation here would be a second way to start a session, competing with the one whose
    // recovery path is tested. So this route surfaces the resume arm, and says so when asked for
    // the other.
  });

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
      if (req.method === 'POST' && p === '/api/radar/inbox/reply') return await routeInboxReply(req, res);
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

      // ----- p11 dispatch (spec S-006) — ONE route, mounted here with the p6 five so it inherits
      // the same three gates rather than restating them: authed() from server.js, the token-in-url
      // refusal above, and the §7 16 KB body cap through p6Body. A dispatch from a VIEWER is refused
      // for the same reason a handoff is (§3) and one gate earlier than the dispatcher's own
      // not_leader: a viewer would inject into its own machine's pane against a route computed from
      // the leader's snapshot, so it is stopped before the body is read.
      if (req.method === 'POST' && p === '/api/radar/dispatch') {
        if (await viewerRefusal(res)) return;
        const b = await p6Body(req, res);
        if (b === null) return;
        // VERBATIM, exactly like routeHandoffCall. radar/dispatch.js already answers the right code
        // for every refusal — 503 dispatch_disabled while the switch is off, 403 authority_refused,
        // 409 for not_leader / cluster_busy / target_mismatch / no_surface, 404 for an unknown
        // workRef, 501 when no spawn is wired — and a mapping layer here would be a second copy of
        // that table, free to drift from the one the module's own tests pin.
        const out = await dispatcher.dispatch(b);
        return sendJson(res, out.status, out.payload);
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

  // ---- POST /api/radar/inbox/reply (p9 §5.5) ----------------------------------------------------
  //
  // Nine steps, in order, each one's failure stopping everything after it:
  //   0 admission · 1 validation · 2 authorisation · 3 machine · 4 lease/mutex
  //   5 gate 1, the session · 6 gate 2, the tab · 7 gate 3, the pane · 8 the send
  //
  // Read §6.1 beside this function: every code below appears there exactly once, with the status and
  // the message string this file emits.
  async function routeInboxReply(req, res) {
    const requestId = crypto.randomUUID();
    // The log line's fields, filled in as the pipeline learns them. tabUuid and seq stay null when
    // their gates never ran — "we never looked" and "we looked and it was null" are different facts.
    const line = { machine: null, sessionId: null, tabUuid: null, seq: null };
    let logged = false;

    // Request scope. A client that disconnects after admission is a NAMED terminal outcome, not a
    // silent abandonment: pending bridge calls are aborted, nothing is sent, no lease is taken, no
    // response is written (the socket is gone) and exactly one `client_closed` line is logged.
    const reqAc = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (res.writableEnded) return;             // a normal finish also emits 'close'
      clientGone = true;
      reqAc.abort();
    });

    const respond = (status, obj) => {
      if (res.writableEnded || res.destroyed) return;
      try { sendJson(res, status, obj); } catch (_) { /* the socket went away mid-write */ }
    };

    // OBSERVABILITY (§5.5). Exactly one line per terminal outcome of an ADMITTED, PARSED request.
    // `outcome` is `sent` exactly when a lease was taken — i.e. when text may have reached the pane.
    // That is the operationally honest split: a log that called `text_inserted_submit_failed`
    // "refused" would read, to someone grepping, as "nothing happened" while the text sits in a tab.
    const emit = (code) => {
      if (logged) return;
      logged = true;
      inboxLog({
        evt: 'inbox_reply',
        requestId,
        machine: line.machine,
        sessionId: line.sessionId,
        tabUuid: line.tabUuid,
        seq: line.seq,
        outcome: LEASE_OUTCOMES.has(code) ? 'sent' : 'refused',
        code,
        at: isoMs(nowMs()),
      });
    };

    // A terminal outcome AFTER admission: log, then answer. `client_closed` has no writable response
    // and `ok` is §6.1's one row with no message — its body is exactly {ok:true}.
    const finish = (code) => {
      emit(code);
      if (code === 'client_closed') return;
      if (code === 'ok') return respond(200, { ok: true });
      const row = REPLY_OUTCOMES[code];
      return respond(row[0], { code, message: row[1] });
    };

    // A step-0 outcome. It answers from the same §6.1 table but emits NO log line: admission never
    // completed, so the route does not yet own the request. Stated, not implied (§5.5).
    const refuseAdmission = (code) => {
      const row = REPLY_OUTCOMES[code];
      return respond(row[0], { code, message: row[1] });
    };

    // ---- 0 · ADMISSION -------------------------------------------------------------------------
    // The SHARED reader, two boundaries. Over BODY_CAP and up to HARD_CAP it drains and we answer
    // 413; over HARD_CAP the reader itself destroys the socket, so there is nothing to answer and
    // nothing to log — we must not even attempt a write. A client abort during the body read lands
    // in the same branch for the same reason.
    const raw = await readJsonBody(req);
    if (raw.aborted) return;
    if (raw.tooLarge) return refuseAdmission('body_too_large');
    if (raw.badJson) return refuseAdmission('bad_json');
    const b = raw.value;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return refuseAdmission('bad_request');

    // ---- 1 · VALIDATION ------------------------------------------------------------------------
    const machine = str(b.machine);
    const sessionId = str(b.sessionId);
    line.machine = machine || null;
    line.sessionId = sessionId || null;
    if (!machine || !sessionId) return finish('bad_request');
    const turn = b.turn;
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return finish('bad_request');
    if (typeof turn.blockedSince !== 'string' || !turn.blockedSince.trim()) return finish('bad_request');
    if (!(typeof turn.assistantTs === 'string' || turn.assistantTs === null)) return finish('bad_request');
    const text = b.text;
    // A non-string text is the SAME failure as an empty one, and deliberately so: the bridge coerces
    // a non-string to '', skips the text send, and would still submit Enter — answering the pending
    // question with nothing.
    if (typeof text !== 'string' || text.trim().length === 0) return finish('empty_reply');
    // In BYTES, and before any transport. An enormous argv makes the bridge's execFile throw
    // synchronously, which is a failure shape no phase mapping can classify — so the cap is enforced
    // here, where refusing is free and provably pre-typing.
    if (Buffer.byteLength(text, 'utf8') > REPLY_TEXT_CAP) return finish('reply_too_large');

    // ---- 2 · AUTHORISATION ---------------------------------------------------------------------
    // An empty SERVER_TOKEN makes the whole API open, and this is the one route that types into a
    // terminal. A viewer resolves its OWN local bridge and would write into its own machine's pane.
    if (!str(env.SERVER_TOKEN)) return finish('unauthenticated_server');
    const cfg = (typeof paths.config === 'string' && paths.config)
      ? (await loadConfig(paths.config, nowMs())).config
      : normalizeConfig(null).config;
    if (clientGone) return finish('client_closed');
    if (cfg.role === 'viewer') return finish('viewer_refused');

    // ---- 3 · MACHINE, and the bridge auth header, once -----------------------------------------
    // The RAW config file through the EXPORTED normalizeBridges — byte-for-byte the path
    // collectSessions uses (§5.1.4). There is no normalized bridges[]: the v1 config schema does not
    // model it, so a route that read the normalized config would find no bridges at all.
    const rawCfg = (typeof paths.config === 'string' && paths.config)
      ? (await store.readJson(paths.config, null)).value
      : null;
    const bridges = sessions.normalizeBridges(rawCfg, cfg.collectorId || os.hostname(), []);
    const bridge = bridges.find((x) => x.id === machine) || null;
    if (!bridge) return finish('unknown_machine');
    // Exactly as collectMachine resolves it, and it rides on EVERY bridge call this route makes:
    // remote events, tree, grid, send. The bridge's own rejection is 403 {error:'forbidden'};
    // `unauthorized` is the shared server's vocabulary and never comes from a bridge.
    const secret = bridge.secretRef ? (process.env[bridge.secretRef] || '') : '';
    const headers = secret ? { 'x-bridge-secret': secret } : {};
    const bridgeMs = (cfg.timeouts && cfg.timeouts.bridgeMs) || 8000;

    // Every deadline in this route is the ROUTE's, held on an AbortController it created and
    // composed with the request scope. `outer` is omitted only for the send.
    async function callBridge(url, opts) {
      const o2 = opts || {};
      const ctl = new AbortController();
      const timer = timers.setTimeout(() => ctl.abort(), o2.timeoutMs);
      const onAbort = () => ctl.abort();
      let listening = false;
      if (o2.outer) {
        if (o2.outer.aborted) ctl.abort();
        else { o2.outer.addEventListener('abort', onAbort, { once: true }); listening = true; }
      }
      try {
        return await bridgeHttp(url, {
          method: o2.method || 'GET', headers, body: o2.body, signal: ctl.signal, timeoutMs: o2.timeoutMs,
        });
      } catch (e) {
        // A thrown transport — DNS, connection refused, an abort — is evidence, not a crash. Each
        // caller decides what it means; none of them may let it escape as a 500.
        return { ok: false, status: 0, json: null, threw: e };
      } finally {
        timers.clearTimeout(timer);
        if (listening) o2.outer.removeEventListener('abort', onAbort);
      }
    }

    // The gate-1 read, and the lease re-check's read, are the SAME call — that is the point. A
    // "local fold" would be unimplementable for a configured remote bridge, whose events exist only
    // behind /cmux/session-events, so both paths go through the one exported primitive.
    async function readEvents() {
      const ctl = new AbortController();
      const timer = timers.setTimeout(() => ctl.abort(), bridgeMs);
      const onAbort = () => ctl.abort();
      let listening = false;
      if (reqAc.signal.aborted) ctl.abort();
      else { reqAc.signal.addEventListener('abort', onAbort, { once: true }); listening = true; }
      try {
        return await sessions.readMachineEvents(bridge, {
          now: nowMs(),
          http: bridgeHttp,
          timeoutMs: bridgeMs,
          signal: ctl.signal,
          paths: { events: eventsPath },
        });
      } finally {
        timers.clearTimeout(timer);
        if (listening) reqAc.signal.removeEventListener('abort', onAbort);
      }
    }

    const key = replyKey(machine, sessionId);

    // ---- 4-8, under the per-session mutex ------------------------------------------------------
    return await withReplyLock(key, async () => {
      if (clientGone) return finish('client_closed');

      // ---- 4 · THE LEASE ---------------------------------------------------------------------
      // A request arriving while a lease is held re-reads the events EXACTLY as gate 1 does, for
      // EVERY machine. Three outcomes, and the read itself is the only transport permitted here.
      let read = null;
      const lease = replyLeases.get(key);
      // A lease that has aged out of its window is dropped here rather than left behind: the map
      // holds one entry per session that has ever been replied to, and an expired `ok` lease is
      // indistinguishable from no lease anyway.
      if (lease && !leaseHeld(lease, nowMs())) replyLeases.delete(key);
      if (leaseHeld(lease, nowMs())) {
        read = await readEvents();
        if (clientGone) return finish('client_closed');
        // Fail closed, LEASE RETAINED: a read that cannot prove the turn moved on may not release a
        // lease that is standing between an operator and a second blind write.
        if (!eventsComplete(read)) return finish('events_unavailable');
        const held = foldOf(read, machine, sessionId);
        if (held && isoMs(held.blockedSince) === lease.turn.blockedSince) return finish('already_answered');
        // A complete fold showing a NEW turn is the ONLY release — including for the two leases that
        // never time-expire. The read is then REUSED as gate 1: exactly one events fetch, not two.
        //
        // NO FOLD AT ALL IS NOT THAT RELEASE. A complete read can legitimately stop carrying a
        // session — a prune, the retention boundary moving, a bridge whose day file rolled — and
        // that read proves nothing whatever about the turn. Releasing on it drops the guard §6.1
        // relies on for the two outcomes it marks not-retryable, and when the same turn reappears
        // the pipeline runs again and types the same reply into the same pane a second time. So the
        // lease survives, and the request falls through to gate 1, which answers `session_not_found`
        // without touching the tab.
        if (held) replyLeases.delete(key);
      }

      // ---- 5 · GATE 1 — the session, from the event log ---------------------------------------
      if (!read) {
        read = await readEvents();
        if (clientGone) return finish('client_closed');
      }
      if (!eventsComplete(read)) return finish('events_unavailable');

      const fold = foldOf(read, machine, sessionId);
      if (!fold) return finish('session_not_found');
      if (sessions.sessionStatusOf(fold, nowMs()) !== 'blocked') return finish('already_answered');
      if (!TEXT_ANSWERABLE.has(fold.notificationType)) return finish('not_text_answerable');

      // TRAP 23. The fold speaks NUMERIC MS and the published row speaks ISO; a strict compare of
      // the raw values rejects every valid reply. The conversion IS the contract.
      if (turn.blockedSince !== isoMs(fold.blockedSince)) return finish('question_changed');
      const lastAssistant = readLastAssistantText(fold.transcriptPath);
      const assistantTs = lastAssistant && lastAssistant.ts != null ? lastAssistant.ts : null;
      if (turn.assistantTs !== assistantTs) return finish('question_changed');

      // CANDIDATE-SET REASSIGNMENT, by value, across BOTH fields. The fold's identity is the
      // §5.1.2a per-field snapshot, so a field the latest event omitted is null here, is not a
      // candidate, and is not reachable by gate 2's fallthrough either. joinRecorded tries
      // [surfaceId, tabId] through the SAME byUuid namespace — a value claimed in either field is
      // the same pane claim — so each candidate must still be this session's latest claim. This is
      // what closes the cross-field takeover and the dual-field fallback in one rule.
      const candidates = [];
      for (const v of [fold.surfaceId, fold.tabId]) if (v && candidates.indexOf(v) === -1) candidates.push(v);
      for (const v of candidates) {
        let best = null;
        let bestAt = -1;
        read.events.forEach((ev, i) => {
          if (ev.surfaceId !== v && ev.tabId !== v) return;
          if (!best || ev.ts > best.ts || (ev.ts === best.ts && i > bestAt)) { best = ev; bestAt = i; }
        });
        if (best && best.sessionId !== sessionId) return finish('surface_reassigned');
      }

      // ---- 6 · GATE 2 — the tab, from a FRESH tree -------------------------------------------
      // Fetched every time. A cached tree would let a tab that closed between two replies still
      // look live, which is exactly the state this gate exists to catch.
      const treeRes = await callBridge(`${bridge.baseUrl}/cmux/tree`, { timeoutMs: bridgeMs, outer: reqAc.signal });
      if (clientGone) return finish('client_closed');
      // BRIDGE FAILURE IS NOT TAB ABSENCE. A machine we could not reach must never be reported as a
      // closed tab — one is retryable and the other tells the operator to give up.
      if (!treeRes.ok || !treeRes.json || !Array.isArray(treeRes.json.workspaces)) return finish('bridge_unreachable');
      // `roots` is deliberately null: the cwd index is what surfaceCandidate reads, and this route
      // may never re-point a session at whatever terminal now occupies its folder. With no byCwd
      // there is structurally nothing for a heuristic to fall through to.
      const idx = sessions.buildSurfaceIndex(treeRes.json, null);
      const join = sessions.joinRecorded(idx, { surfaceId: fold.surfaceId, tabId: fold.tabId });
      if (!join || !join.surface || !join.surface.tabUuid) return finish('tab_gone');
      const tabUuid = join.surface.tabUuid;
      line.tabUuid = tabUuid;

      // ---- 7 · GATE 3 — the pane, from a FRESH grid, GRID EVIDENCE ONLY ----------------------
      const gridRes = await callBridge(
        `${bridge.baseUrl}/cmux/grid?surface=${encodeURIComponent(tabUuid)}`,
        { timeoutMs: bridgeMs, outer: reqAc.signal },
      );
      if (clientGone) return finish('client_closed');
      const gj = gridRes.json;
      const gridOk = gridRes.ok && gj && typeof gj.grid === 'object' && gj.grid !== null && !Array.isArray(gj.grid)
        && Number.isFinite(gj.seq);
      if (!gridOk) return finish('bridge_unreachable');
      // The ENVELOPE seq — never the one paneKind hands back, which reads a phantom field on the
      // grid object that is always undefined on real data (trap 19). An undefined expect_seq would
      // silently disable the bridge's whole precondition.
      const seq = gj.seq;
      line.seq = seq;
      // status: '' — ALWAYS. cmux status is WORKSPACE-scoped: one list-status per workspace, the
      // same string stamped onto every terminal tab, and it is paneKind's highest-precedence agent
      // signal. So in a workspace where any tab runs Claude, a status-fed gate would classify a
      // SHELL tab as `agent` before looking at its grid. Status is display provenance only; this
      // gate passes only when the SELECTED tab's own grid proves it.
      if (paneKind({ grid: gj.grid, status: '' }).kind !== 'agent') return finish('not_at_prompt');

      // ---- 8 · THE SEND ----------------------------------------------------------------------
      // Direct to the bridge, never through the server.js proxy. No `outer`: once this is dispatched
      // it runs to completion regardless of the client, because the only thing worse than an
      // unanswered request is an abandoned one whose text landed anyway with nobody recording it.
      if (clientGone) return finish('client_closed');
      const sendRes = await callBridge(`${bridge.baseUrl}/cmux/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ surface: tabUuid, text, submit: true, expect_seq: seq }),
        timeoutMs: SEND_TIMEOUT_MS,
      });
      const code = mapSendOutcome(sendRes);
      // §6.1's lease column. Taken here, after the mapping, so there is exactly one rule about which
      // outcomes may leave a lease behind.
      if (LEASE_OUTCOMES.has(code)) replyLeases.set(key, { at: nowMs(), turn: { blockedSince: turn.blockedSince }, outcome: code });
      return finish(code);
    });
  }

  // The §5.5 step 8 mapping, EXHAUSTIVE and BY PROVABLE PHASE. Read the table in §6.1 with it: an
  // outcome may only read as "nothing was typed" when the bridge's contract proves the rejection
  // preceded typing. Everything else — unknown code, unknown 409, unlisted 5xx, a malformed body of
  // any status, a timeout, a connection lost after dispatch — is `send_unconfirmed` and takes the
  // lease, because telling an operator to retry blind is how a reply gets typed into a pane twice.
  function mapSendOutcome(r) {
    const j = r && r.json;
    if (r && r.ok && j && j.ok === true) return 'ok';
    const err = j && typeof j.error === 'string' ? j.error : null;
    const s = r ? r.status : 0;
    if (s === 409 && err === 'seq_changed') return 'pane_changed';                       // nothing typed
    if (s === 409 && err === 'seq_unavailable') return 'send_failed';                    // fail-closed precondition
    if (s === 502 && err === 'send_failed') return 'send_failed';                        // bridge proved pre-dispatch
    if (s === 502 && err === 'text_command_unconfirmed') return 'send_unconfirmed';      // dispatched, side effect unproved
    if (s === 502 && err === 'submit_failed_text_inserted') return 'text_inserted_submit_failed';
    // The bridge's pre-typing rejections, all applied before a child process is ever spawned.
    if (s >= 400 && s < 500 && (err === 'bad_json' || err === 'bad_surface' || err === 'forbidden')) return 'send_failed';
    return 'send_unconfirmed';
  }

  // One session's fold out of a completed read, using only the exported primitives. Returns null
  // when the session left no trace in the retained events at all.
  function foldOf(read, machine, sessionId) {
    const evs = sessions.groupEvents(read.events).get(sessionId);
    if (!evs || evs.length === 0) return null;
    return sessions.foldSession(machine, sessionId, evs);
  }

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
