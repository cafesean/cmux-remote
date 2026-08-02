'use strict';
// classify.js — the inbox classifier (spec §5.2).
//
// This file currently holds exactly one contract: §5.2.1, the transcript reader. It answers the
// only question the classifier needs off disk — what did this session LAST SAY — and it answers it
// without reading the transcript.
//
// TWO RULES SHAPE EVERY LINE BELOW.
//
// 1. BOUNDED READ. A transcript is an append-only NDJSON log that grows without limit; a long
//    session is tens of megabytes. This runs inside a sweep, over every blocked session, so the
//    cost of an answer must not scale with how long the session has been alive. We read at most
//    the trailing 256 KB, positioned, and never the whole path. The last thing said is at the end
//    by construction, so a bounded tail is not an approximation of the answer — it IS the answer,
//    with a stated blind spot: a session whose final 256 KB contains no assistant text at all
//    reads as null. That is the honest outcome and rule 2 catches it.
//
// 2. NEVER THROWS. null is the caller's `unknown`, and by principle 2 an `unknown` row is SHOWN,
//    not suppressed. A missing file, a permission error, a directory where a file was expected, a
//    half-written final line — every one of them is null, because the risky direction here is
//    hiding a question the operator needed to see. Nothing in this function is allowed to abort a
//    sweep.
//
// THE BOUNDARY BYTE. Slicing a byte range out of a line-oriented file lands mid-record almost
// every time, and the leading fragment that results is not a record — it is the back half of one.
// Discarding it unconditionally is wrong too: when the window happens to begin exactly after a
// newline, the first element is a whole record and throwing it away silently loses a message. So
// the read that decides this is explicit — one extra byte, at `offset - 1`. `\n` there means the
// window opens on a record boundary and the first element is kept; anything else means it is a
// severed tail and it is dropped. A file at or under 256 KB is read from byte 0, has no byte at
// -1, and its first line is always a whole record.
//
// A severed fragment usually fails JSON.parse and would be dropped anyway. "Usually" is not a
// contract: a record ending in a nested object can be severed at that object's opening brace, and
// what remains parses cleanly as a complete record that was never a record. That is the case this
// byte exists for.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { RETENTION_MS } = require('./eventlog');

// 256 KB. The tail window, in bytes — never the file.
const MAX_TAIL_BYTES = 262144;

const NEWLINE = 0x0a;

// Every non-empty text block of one record, in array order, trimmed, joined by a blank line.
// A model turn is frequently several text blocks around a tool call, and the question is as often
// in the last one as the first — concatenating all of them is what makes the classifier see the
// whole utterance rather than a fragment of it.
function textOfRecord(rec) {
  if (!rec || typeof rec !== 'object' || rec.type !== 'assistant') return null;
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    const trimmed = block.text.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// The record's own timestamp, or null. Only a non-empty string that Date.parse resolves is kept —
// the value keys a cache downstream, and a key built from `undefined` or `Invalid Date` collides
// across sessions.
function tsOfRecord(rec) {
  const raw = rec && rec.timestamp;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

function readLastAssistantText(transcriptPath) {
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const offset = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const length = size - offset;

    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    // A short read is legal on any fd; loop until the window is filled or the file stops giving.
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }

    // The one boundary byte. Read only when there is a byte before the window to read.
    let firstElementIsWhole = true;
    if (offset > 0) {
      const edge = Buffer.allocUnsafe(1);
      const n = fs.readSync(fd, edge, 0, 1, offset - 1);
      firstElementIsWhole = n === 1 && edge[0] === NEWLINE;
    }

    // Decoding the window as utf8 can mangle a multi-byte character split by the window start —
    // but that can only ever be inside the first element, and the first element is kept only when
    // the byte before it was a newline, which is by definition a character boundary too.
    const lines = buf.slice(0, got).toString('utf8').split('\n');
    const stopAt = firstElementIsWhole ? 0 : 1;

    for (let i = lines.length - 1; i >= stopAt; i--) {
      const line = lines[i];
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const text = textOfRecord(rec);
      if (text === null) continue;
      return { text, ts: tsOfRecord(rec) };
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* nothing left to salvage */ } }
  }
}

// ================================================================================================
// §5.2.2 – §5.2.6 — the classifier, the intent cache, and the bounded stage.
//
// ONE RULE ORDERS EVERYTHING BELOW: the credential is resolved FIRST, before any network or cache
// decision, and its absence outranks every other rule including a failed transcript read. The
// reason is not tidiness. An absent key with cache reads still permitted would keep serving the
// previous run's `offer-more` and `status-only` verdicts for up to 48 hours — which is to say it
// would keep SUPPRESSING rows, silently, from a classifier that is not running. Suppression is the
// one direction this feature is not allowed to fail in (principle 2), so no-key means: read the
// transcript anyway (`lastAssistant` is honest data and may publish as null), touch no cache,
// attach `unknown · no credential` to every blocked session, and leave the entries on disk.
// `no transcript text` is therefore a reason that can only ever appear when a credential resolved.
//
// THE SECOND RULE IS THAT THE DEADLINE HAS TEETH. The collector awaits this stage, so a hung
// classifier is a hung sweep — and a sweep that never publishes is worse than one that publishes
// `unknown`. At CLASSIFY_DEADLINE_MS the stage attaches `unknown · deadline` to everything
// unresolved and resolves immediately. That is not a soft bound: a classification that lands after
// the deadline — including from a transport that ignores the abort signal — is discarded WHOLE. It
// mutates no session, writes no cache entry and starts no cooldown, because every side effect
// checks the stage generation that spawned it before applying. There is no background completion
// and no provisional-then-updated row.
// ================================================================================================

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODEL = 'claude-opus-5';

// §5.2.2, and this number is LOAD-BEARING. Thinking is on by default on this model when `thinking`
// is omitted, and `max_tokens` caps thinking PLUS response text together. A small budget truncates
// before the JSON closes: `stop_reason: "max_tokens"`, an unparseable body, `unknown` for every
// session — the exact all-noise feed this feature exists to remove, with an API bill attached.
const MAX_TOKENS = 2048;

const HTTP_TIMEOUT_MS = 8000;          // one attempt's own timeout (§5.2.2 failure table)
const CLASSIFY_DEADLINE_MS = 20000;    // the whole stage's bound (§5.2.6)
const COOLDOWN_MS = 5 * 60 * 1000;     // the negative cooldown window (§5.2.4)
const POOL_SIZE = 4;                   // at most four concurrent classifications
const DEFAULT_KEY_REF = 'ANTHROPIC_API_KEY';

// `unknown` is deliberately NOT in this list. It is only ever this module's own answer, never a
// value the model is allowed to return and never a value that can be cached.
const VERDICTS = ['needs-decision', 'offer-more', 'status-only'];

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS.slice() },
    reason: { type: 'string' },
  },
};

// §5.2.3. This exact string is scored against the labelled corpus in S-004 and is hashed into
// CLASSIFIER_VERSION, so editing it invalidates every cached verdict — which is the point.
//
// The two lines that carry the whole discriminator are the question-mark caveat and the tie-break.
// The loudest false positive in the measured corpus is a completed piece of work whose last
// sentence is "Want me to also wire the retry path?" — a question mark, an offer, and nothing
// blocked. And the tie-break is asymmetric ON PURPOSE (principle 2): a question wrongly hidden is
// a session that waits forever, a report wrongly shown is one line the operator skims past.
const CLASSIFY_PROMPT = [
  'Decide whether this Claude Code session is blocked on its operator.',
  '',
  'You are given the last thing the session said. Answer with exactly one verdict.',
  '',
  'needs-decision - it cannot proceed without an answer: it asked a direct question, presented',
  'options to choose between, needs a credential or a fact only the operator has, or stopped',
  'mid-work pending approval.',
  '',
  'offer-more - the work is complete and it is proposing optional further work ("Want me to',
  'also...", "Offer stands to...", "Say the word and I\'ll..."). A question mark does not make',
  'this needs-decision.',
  '',
  'status-only - a progress or completion report with nothing asked.',
  '',
  'When genuinely torn between needs-decision and offer-more, answer needs-decision. A missed',
  'question costs more than a shown one.',
  '',
  'reason is one short sentence naming the evidence you decided on.',
].join('\n');

// §5.2.4. Exposed as a pure function so the pinned-digest test can hand it the three known inputs
// without monkey-patching module constants. The separator is a single ASCII space (0x20).
function classifierVersion(model, prompt, schema) {
  return crypto.createHash('sha256')
    .update(String(model) + ' ' + String(prompt) + ' ' + JSON.stringify(schema))
    .digest('hex')
    .slice(0, 12);
}

const CLASSIFIER_VERSION = classifierVersion(MODEL, CLASSIFY_PROMPT, VERDICT_SCHEMA);

// §5.2.4 — the ONE key encoding, used identically for cache lookup, cache write, the negative
// cooldown and single-flight.
//
// IT IS INJECTIVE, AND THAT IS THE WHOLE REQUIREMENT. A colon-joined template is not: the base
// accepts ':' in machine ids (normalizeBridges) and in session ids (normalizeEvent), so
// {machine:'a', sessionId:'b:c'} and {machine:'a:b', sessionId:'c'} would collide — and a collision
// here lets one session's cached `offer-more` suppress a DIFFERENT session's genuine question for
// 48 hours. JSON.stringify of the tuple escapes the separator problem out of existence.
//
// CLASSIFIER_VERSION is inside the key so a prompt, model or schema change invalidates every entry
// rather than serving verdicts a different classifier produced.
const intentCacheKey = (machine, sessionId, ts, version) =>
  JSON.stringify([machine, sessionId, ts, version === undefined ? CLASSIFIER_VERSION : version]);

// ---- transport ---------------------------------------------------------------------------------
// radar/http.js hardcodes `method:'GET'` and passes no body, so it cannot be reused here. This is
// classify's own transport and stays local to this file rather than widening the shared client.
//
// Shape: { ok, status, body } on any completed request; { ok:false, status:0 } when the request
// never completed. It never throws — a dead classifier is a fact to report, not an exception.
async function defaultHttp(req) {
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, status: 0, body: null, error: 'no fetch implementation (node >= 18 required)' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  // The stage's signal and this attempt's timeout must BOTH be able to kill the request. A listener
  // added after a signal has already fired never replays, so an already-aborted signal is checked
  // first rather than merely subscribed to.
  const outer = req.signal;
  const onAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    if (outer) { try { outer.removeEventListener('abort', onAbort); } catch (_) { /* already gone */ } }
  }
}

// ---- classify ----------------------------------------------------------------------------------

const unknown = (reason) => ({ verdict: 'unknown', reason });

// The success predicate, §5.2.2, IN ORDER. Structured output constrains the generated text, not the
// HTTP envelope, so every step is explicit. Step 2 is checked BEFORE `content` is read — a refusal
// can carry an empty content array, and a reader that indexes into it first throws instead of
// answering `refused`.
function readVerdict(body) {
  const obj = body && typeof body === 'object' ? body : null;
  const stop = obj ? obj.stop_reason : undefined;
  if (stop === 'refusal') return unknown('refused');          // 2
  if (stop === 'max_tokens') return unknown('truncated');     // 3

  const content = obj ? obj.content : null;                   // 4
  if (!Array.isArray(content) || content.length === 0) return unknown('unparseable');
  let block = null;
  for (const b of content) { if (b && typeof b === 'object' && b.type === 'text') { block = b; break; } }
  if (!block || typeof block.text !== 'string') return unknown('unparseable');

  let parsed;                                                 // 5
  try { parsed = JSON.parse(block.text); } catch (_) { return unknown('unparseable'); }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unknown('unparseable');
  if (VERDICTS.indexOf(parsed.verdict) === -1) return unknown('unparseable');   // 6
  if (typeof parsed.reason !== 'string') return unknown('unparseable');
  return { verdict: parsed.verdict, reason: parsed.reason };
}

// One classification operation: up to TWO HTTP attempts, and only a transport-class failure (non-2xx,
// timeout, network error) is retried. A refusal, a truncation and an unparseable body are ANSWERS —
// retrying them buys a second identical answer and a second bill.
async function classify(input, deps) {
  const d = deps || {};
  const text = input && typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) return unknown('no transcript text');

  const key = d.key;
  if (typeof key !== 'string' || !key) return unknown('no credential');

  const http = typeof d.http === 'function' ? d.http : defaultHttp;
  const signal = d.signal;

  const request = {
    url: API_URL,
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
    signal,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // Retrying past an abort would put a fresh request on the wire for a stage that is already over.
    if (signal && signal.aborted) return unknown('classifier unreachable');
    let res = null;
    try { res = await http(request); } catch (_) { res = null; }
    const status = res ? Number(res.status) : NaN;
    if (!Number.isFinite(status) || status < 200 || status >= 300) continue;   // 1 — transport class
    return readVerdict(res.body);
  }
  return unknown('classifier unreachable');
}

// ---- the intent cache, the cooldown, and single-flight -------------------------------------------

// PROCESS-LIFETIME state, deliberately. The cooldown exists because collector.js runs a 60-second
// session sweep: an uncached failure path otherwise costs two HTTP attempts per blocked session per
// minute. Neither map is persisted — a restart is allowed to retry immediately.
const cooldowns = new Map();      // cache key -> ms epoch at which a retry is permitted again
const inflight = new Map();       // cache key -> { gen, promise }
let generationSeq = 0;

// A hit is valid only while `at` is within RETENTION_MS of now, CHECKED AT LOOKUP — an older entry
// is a miss even when no write ever occurs to prune it. The verdict-enum check is the second half
// of "never cache unknown": even a hand-edited file cannot serve one back.
function isFreshEntry(v, now) {
  if (!v || typeof v !== 'object') return false;
  if (VERDICTS.indexOf(v.verdict) === -1) return false;
  const at = Date.parse(v.at);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < RETENTION_MS;
}

// §5.2.5. The config names the variable; it never carries the secret.
function resolveCredential(config, env) {
  const ref = (config && typeof config.classifierKeyRef === 'string' && config.classifierKeyRef.trim())
    ? config.classifierKeyRef.trim()
    : DEFAULT_KEY_REF;
  const raw = env ? env[ref] : undefined;
  if (typeof raw !== 'string') return null;
  // Trimmed because a key sourced from a dotenv file routinely arrives with a trailing newline and
  // a credential with surrounding whitespace is never the valid one.
  const key = raw.trim();
  return key || null;
}

const unknownIntent = (reason, at) => ({ verdict: 'unknown', reason, model: null, at, inferred: true });

// One serialized read-modify-write per sweep for the whole batch. Atomic rename prevents torn
// files; it does NOT prevent lost updates, which is why this is a single queued mutation rather
// than one write per entry.
async function flushCache(cachePath, writes, now) {
  const merge = (cur) => {
    const base = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
    const next = {};
    // Entries past retention are additionally dropped on write — the lookup already treats them as
    // misses, this is what stops the file growing without bound.
    for (const k of Object.keys(base)) if (isFreshEntry(base[k], now)) next[k] = base[k];
    for (const [k, v] of writes) next[k] = v;
    return next;
  };
  try {
    await store.updateJson(cachePath, {}, merge);
  } catch (e) {
    // updateJson REJECTS a corrupt file rather than defaulting (trap 7). That rejection is the one
    // case we overwrite: the cache is derived data, so a file we cannot parse is worth less than
    // this sweep's verdicts. A read/permission failure is NOT ours to paper over — clobbering a
    // file we merely failed to open would lose entries that are perfectly good.
    const msg = e && e.message ? String(e.message) : '';
    if (!/^parse /.test(msg)) return;
    const next = {};
    for (const [k, v] of writes) next[k] = v;
    try { await store.writeJsonAtomic(cachePath, next); } catch (_) { /* unwritable cache is a slow classifier, not a failure */ }
  }
}

// The generation's lifetime ends here, and the in-flight map's lifetime ends WITH it. Evicting our
// own entries is not housekeeping: a later sweep that joined a stale promise from an abort-ignoring
// transport would publish `unknown · deadline` for that key forever, because `deadline` deliberately
// starts no cooldown and so never backs off.
function endGeneration(gen, ac) {
  if (!gen.alive) return;
  gen.alive = false;
  if (ac) { try { ac.abort(); } catch (_) { /* nothing to cancel */ } }
  for (const [k, rec] of inflight) if (rec.gen === gen) inflight.delete(k);
}

// §5.2.6 — the stage. Returns the same array it was handed, with `lastAssistant` and `intent`
// attached to every blocked row.
async function classifyBlocked(sessions, deps) {
  const list = Array.isArray(sessions) ? sessions : [];
  const d = deps || {};
  const nowFn = typeof d.now === 'function' ? d.now : Date.now;
  const env = d.env || process.env;
  const http = typeof d.http === 'function' ? d.http : defaultHttp;
  const network = d.network !== false;
  const deadlineMs = Number.isFinite(Number(d.deadlineMs)) ? Number(d.deadlineMs) : CLASSIFY_DEADLINE_MS;
  const cachePath = d.cachePath || path.join(d.radarDir || store.defaultRadarDir(), 'intent-cache.json');

  const blocked = list.filter((s) => s && s.status === 'blocked');
  if (!blocked.length) return sessions;

  // ONE timestamp for the sweep. Every `unknown` carries it, so two unknowns from the same sweep
  // are never distinguishable by a clock that has nothing to do with either of them.
  const sweepAt = new Date(nowFn()).toISOString();

  // Step 1, for every blocked session, ALWAYS — hit, miss, or no credential at all. Hoisted out of
  // the pool because it is synchronous and bounded (§5.2.1 reads at most 256 KB) and because a
  // session whose pool task never starts must still publish honest `lastAssistant` data.
  for (const s of blocked) s.lastAssistant = readLastAssistantText(s.transcriptPath) || null;

  // PRECEDENCE. Before any network or cache decision. See the block comment at the top.
  const credential = resolveCredential(d.config, env);
  if (!credential) {
    for (const s of blocked) s.intent = unknownIntent('no credential', sweepAt);
    return sessions;
  }

  const read = await store.readJson(cachePath, {});
  const corrupt = !read.ok;
  const cache = (read.ok && read.value && typeof read.value === 'object' && !Array.isArray(read.value))
    ? read.value : {};

  const gen = { id: ++generationSeq, alive: true };
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const writes = new Map();
  let expired = false;

  const attach = (s, intent) => { if (gen.alive) s.intent = intent; };

  async function resolveOne(s) {
    const la = s.lastAssistant;
    if (!la || !la.text) { attach(s, unknownIntent('no transcript text', sweepAt)); return; }
    // No timestamp means no injective key, and a key built from `null` would fuse every
    // timestamp-less turn of a session into one entry. Refuse rather than cache a collision.
    if (!la.ts) { attach(s, unknownIntent('no valid timestamp', sweepAt)); return; }

    const k = intentCacheKey(s.key && s.key.machine, s.key && s.key.sessionId, la.ts);

    const hit = cache[k];
    if (isFreshEntry(hit, nowFn())) {
      attach(s, { verdict: hit.verdict, reason: hit.reason, model: hit.model === undefined ? null : hit.model, at: hit.at, inferred: true });
      return;
    }

    // A key resolved, so `fetch:false` finally gets to speak: cache reads are disk, not network, and
    // a miss is honestly unreachable — but "we did not ask" must not be penalised like "it did not
    // answer", so no cooldown starts here.
    if (!network) { attach(s, unknownIntent('classifier unreachable', sweepAt)); return; }

    const until = cooldowns.get(k);
    if (until != null && nowFn() < until) { attach(s, unknownIntent('classifier unreachable', sweepAt)); return; }

    // Single-flight, GENERATION-SCOPED. Only an entry this stage owns may be joined.
    let rec = inflight.get(k);
    if (!rec || rec.gen !== gen) {
      const created = { gen, promise: null };
      created.promise = classify({ text: la.text }, { http, key: credential, signal: ac ? ac.signal : undefined });
      inflight.set(k, created);
      // IDENTITY-SAFE cleanup: delete only while the map still holds THIS promise. An expired
      // generation's late `finally` must never remove a newer generation's live entry for the key.
      const cleanup = () => { if (inflight.get(k) === created) inflight.delete(k); };
      created.promise.then(cleanup, cleanup);
      rec = created;
    }

    let r;
    try { r = await rec.promise; } catch (_) { r = unknown('classifier unreachable'); }

    // THE GENERATION GUARD. Everything below is a side effect; a result from a stage that is over
    // applies none of them.
    if (!gen.alive) return;

    if (r.verdict === 'unknown') {
      // Only a REAL failed attempt-pair backs off. `deadline` never reaches this line, and
      // `fetch:false` returned above.
      if (r.reason === 'classifier unreachable') cooldowns.set(k, nowFn() + COOLDOWN_MS);
      attach(s, unknownIntent(r.reason, sweepAt));
      return;                                    // never cache unknown
    }

    const at = new Date(nowFn()).toISOString();  // the API-response time, for a live verdict
    const value = { verdict: r.verdict, reason: r.reason, model: MODEL, at };
    writes.set(k, value);
    cache[k] = value;
    attach(s, Object.assign({}, value, { inferred: true }));
  }

  let fire = null;
  const stageDone = new Promise((r) => { fire = r; });
  const timer = setTimeout(() => { expired = true; endGeneration(gen, ac); fire(); }, deadlineMs);

  const queue = blocked.slice();
  const worker = async () => {
    for (;;) {
      if (expired) return;              // queued tasks are never started once the deadline has passed
      const s = queue.shift();
      if (!s) return;
      await resolveOne(s);
    }
  };
  const pool = [];
  for (let i = 0; i < Math.min(POOL_SIZE, blocked.length); i++) pool.push(worker());
  const all = Promise.all(pool);
  all.catch(() => {});                  // the race may leave this dangling; never an unhandled rejection
  await Promise.race([all, stageDone]);

  clearTimeout(timer);
  if (!expired) endGeneration(gen, ac);

  for (const s of blocked) if (!s.intent) s.intent = unknownIntent('deadline', sweepAt);

  if (writes.size || corrupt) await flushCache(cachePath, writes, nowFn());
  return sessions;
}

// Test-only. `cooldowns` and `inflight` outlive any one stage by design, which is exactly why a
// suite running many stages in one process needs a way back to a clean slate.
function _resetClassifyState() { cooldowns.clear(); inflight.clear(); }

module.exports = {
  readLastAssistantText,
  classify, classifyBlocked,
  classifierVersion, intentCacheKey, defaultHttp,
  CLASSIFY_PROMPT, VERDICT_SCHEMA, CLASSIFIER_VERSION, CLASSIFY_DEADLINE_MS,
  CLASSIFIER_MODEL: MODEL, CLASSIFY_MAX_TOKENS: MAX_TOKENS, COOLDOWN_MS, POOL_SIZE,
  DEFAULT_KEY_REF, VERDICTS,
  _resetClassifyState,
};
