'use strict';
// S-003 — §5.2.2 to §5.2.6: the classifier, the credential precedence rule, the intent cache, the
// negative cooldown, generation-scoped single-flight, and the stage deadline.
//
// EVERY FIXTURE IS INVENTED — invented prose, invented machine ids, invented session ids, invented
// timestamps, invented paths under a fresh temp directory. This repository is public. The
// "credential" below is a made-up string that has never been a key anywhere; the tests that assert
// it is absent from logs are asserting the SHAPE of the rule, and the shape is what protects a real
// key at runtime.
//
// NOTHING HERE TOUCHES THE NETWORK. `deps.http` is injected in every test that can reach a
// transport, and the two tests that do not inject one (the digest pin, the config loader) never
// reach the request path at all. That is a property of the suite, not a hope: `classify` calls
// `deps.http` and falls back to `defaultHttp` only when none is given.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const util = require('util');

const C = require('../radar/classify');
const store = require('../radar/store');
const { createCollector } = require('../radar/collector');
const { normalizeConfig, loadConfig, DEFAULTS } = require('../radar/config');
const { RETENTION_MS } = require('../radar/eventlog');

const {
  classify, classifyBlocked, classifierVersion, intentCacheKey,
  CLASSIFY_PROMPT, VERDICT_SCHEMA, CLASSIFIER_VERSION, CLASSIFY_DEADLINE_MS,
  CLASSIFIER_MODEL, COOLDOWN_MS, POOL_SIZE, _resetClassifyState,
} = C;

// ---- invented constants -------------------------------------------------------------------------
const KEY = 'fixture-classifier-key-000';        // invented; never a credential anywhere
const ALT_KEY = 'fixture-classifier-key-alt';    // invented
const KEY_REF = 'FIXTURE_CLASSIFIER_KEY';
const MACHINE = 'fixture-machine-1';
const TS = '2026-07-30T10:00:00.000Z';
const NOW = Date.parse('2026-07-30T10:05:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

const QUESTION = 'Two migration orders are viable and they are not equivalent. Which do you want?';
const OFFER = 'Migration landed and the suite is green. Want me to also wire the rollback path?';

// ---- scaffolding --------------------------------------------------------------------------------
const dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-classify-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

let seq = 0;
// One synthetic assistant record. `ts` undefined -> the valid fixture timestamp; a string -> that
// string verbatim (an unparseable one is how §5.2.1 yields ts null); null -> no timestamp field.
function transcript(dir, text, ts) {
  const p = path.join(dir, `fixture-transcript-${seq++}.jsonl`);
  const rec = {
    type: 'assistant',
    uuid: `fixture-uuid-${seq}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
  if (ts !== null) rec.timestamp = ts === undefined ? TS : ts;
  fs.writeFileSync(p, JSON.stringify(rec) + '\n');
  return p;
}

function blocked(dir, o) {
  const opts = o || {};
  const row = {
    key: { machine: opts.machine || MACHINE, sessionId: opts.sessionId || `fixture-inbox-${++seq}` },
    status: opts.status || 'blocked',
    epic: null,
    surface: null,
    surfaceReason: null,
    notificationType: 'idle_prompt',
    cacheExpiresAt: null,
    transcriptPath: opts.transcriptPath !== undefined
      ? opts.transcriptPath
      : transcript(dir, opts.text || QUESTION, opts.ts),
  };
  if (opts.vanished) row.vanished = true;
  return row;
}

// A recording transport. `handler(req, n)` decides the answer; `calls` is every request object it
// was handed, in order.
function stubHttp(handler) {
  const calls = [];
  const fn = async (req) => { calls.push(req); return handler(req, calls.length); };
  fn.calls = calls;
  return fn;
}

const jsonBlock = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }] });
const ok200 = (body) => ({ ok: true, status: 200, body });
const httpErr = (status) => ({ ok: false, status, body: { type: 'error' } });
const verdictOk = (verdict, reason) => ok200(jsonBlock({ verdict, reason }));

const alwaysOk = (verdict, reason) => stubHttp(async () => verdictOk(verdict || 'needs-decision', reason || 'asked a direct question'));

function baseDeps(over) {
  return Object.assign({
    config: normalizeConfig({ classifierKeyRef: KEY_REF }).config,
    env: { [KEY_REF]: KEY },
    now: () => NOW,
    network: true,
  }, over || {});
}

const readCache = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
};
const writeCache = (p, obj) => { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); return p; };

const entry = (verdict, at, reason) => ({ verdict, reason: reason || 'fixture reason', model: CLASSIFIER_MODEL, at });

// Real setImmediate turns — the deadline tests mock setTimeout and Date but never setImmediate, so
// this is how the suite waits for genuinely asynchronous progress under a frozen clock.
async function until(pred, tries) {
  const n = tries || 500;
  for (let i = 0; i < n; i++) {
    if (pred()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return pred();
}
const turns = async (n) => { for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r)); };

// A gate per HTTP call, so a test decides exactly when (and whether) each attempt settles.
function gatedHttp() {
  const calls = [];
  const gates = [];
  const fn = async (req) => {
    calls.push(req);
    let res;
    const p = new Promise((r) => { res = r; });
    gates.push({ p, res });
    return p;
  };
  fn.calls = calls;
  fn.gates = gates;
  fn.settle = (i, value) => gates[i].res(value);
  return fn;
}

// Captures everything a call could possibly print. The probe line proves the capture is live, so a
// "the key is absent" assertion cannot pass by capturing nothing at all.
function captureOutput(sink) {
  const outW = process.stdout.write;
  const errW = process.stderr.write;
  const swallow = (chunk) => { sink.push(String(chunk)); return true; };
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    saved[m] = console[m];
    console[m] = (...a) => { sink.push(a.map((x) => (typeof x === 'string' ? x : util.inspect(x))).join(' ')); };
  }
  return () => {
    process.stdout.write = outW;
    process.stderr.write = errW;
    for (const m of Object.keys(saved)) console[m] = saved[m];
  };
}

// ================================================================================================
// AC1 — the request shape, verbatim, and the credential's blast radius
// ================================================================================================
test('AC1 - the request is exactly the §5.2.2 shape and the credential reaches no log line', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const http = alwaysOk('needs-decision', 'it asked which migration order to use');

  const sink = [];
  const restore = captureOutput(sink);
  let r = null;
  let stageErr = null;
  try {
    console.log('capture-probe-line');                       // proves the capture is live
    r = await classify({ text: QUESTION }, { http, key: KEY });
    // The full stage too: the key travels further there (config -> env -> header) than in classify.
    await classifyBlocked([blocked(dir)], baseDeps({ http, cachePath: path.join(dir, 'intent-cache.json') }));
  } catch (e) { stageErr = e; } finally { restore(); }
  assert.equal(stageErr, null);

  const captured = sink.join('\n');
  assert.ok(captured.includes('capture-probe-line'), 'the log capture must actually capture');
  assert.ok(!captured.includes(KEY), 'the credential must never reach a log line');
  assert.ok(!captured.includes(KEY_REF), 'not even the variable name is logged');

  assert.deepEqual(r, { verdict: 'needs-decision', reason: 'it asked which migration order to use' });

  const req = http.calls[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-api-key'], KEY);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(req.headers).sort(), ['anthropic-version', 'content-type', 'x-api-key']);

  const body = JSON.parse(req.body);
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } });
  assert.equal(body.system, CLASSIFY_PROMPT);
  assert.deepEqual(body.messages, [{ role: 'user', content: QUESTION }]);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);

  // The schema itself, since the request carries it and CLASSIFIER_VERSION hashes it.
  assert.equal(VERDICT_SCHEMA.type, 'object');
  assert.equal(VERDICT_SCHEMA.additionalProperties, false);
  assert.deepEqual(VERDICT_SCHEMA.required, ['verdict', 'reason']);
  assert.deepEqual(VERDICT_SCHEMA.properties.verdict.enum, ['needs-decision', 'offer-more', 'status-only']);
  assert.ok(VERDICT_SCHEMA.properties.verdict.enum.indexOf('unknown') === -1, 'unknown is never a model answer');

  // §5.2.3's two load-bearing clauses.
  assert.ok(/A question mark does not make/.test(CLASSIFY_PROMPT), 'the question-mark caveat is in the prompt');
  assert.ok(/torn between needs-decision and offer-more, answer needs-decision/.test(CLASSIFY_PROMPT), 'the tie-break is in the prompt');
});

// ================================================================================================
// AC2 — the six-step predicate in order, and the exhaustive failure map
// ================================================================================================
test('AC2 - the success predicate runs in order and every failure maps to its stated unknown', async () => {
  _resetClassifyState();

  // A real envelope: a non-text block first, so "the FIRST block with type text" is exercised.
  const envelope = ok200({
    id: 'fixture-msg-1', type: 'message', role: 'assistant', model: CLASSIFIER_MODEL,
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'weighing the two branches' },
      { type: 'text', text: JSON.stringify({ verdict: 'offer-more', reason: 'work is complete, the ask is optional' }) },
      { type: 'text', text: 'trailing chatter that must be ignored' },
    ],
  });
  const okHttp = stubHttp(async () => envelope);
  assert.deepEqual(await classify({ text: OFFER }, { http: okHttp, key: KEY }),
    { verdict: 'offer-more', reason: 'work is complete, the ask is optional' });
  assert.equal(okHttp.calls.length, 1, 'a success costs exactly one attempt');

  // HTTP 500 twice -> exactly two attempts, then unreachable.
  const five = stubHttp(async () => httpErr(500));
  assert.deepEqual(await classify({ text: QUESTION }, { http: five, key: KEY }), { verdict: 'unknown', reason: 'classifier unreachable' });
  assert.equal(five.calls.length, 2, 'an operation makes AT MOST two HTTP attempts');

  // A transport that throws is the same class as a non-2xx.
  const thrown = stubHttp(async () => { throw new Error('fixture socket reset'); });
  assert.deepEqual(await classify({ text: QUESTION }, { http: thrown, key: KEY }), { verdict: 'unknown', reason: 'classifier unreachable' });
  assert.equal(thrown.calls.length, 2);

  // The retry is useful, not ceremonial: 500 then 200 answers.
  const flaky = stubHttp(async (_req, n) => (n === 1 ? httpErr(503) : verdictOk('status-only', 'a completion report')));
  assert.deepEqual(await classify({ text: OFFER }, { http: flaky, key: KEY }), { verdict: 'status-only', reason: 'a completion report' });
  assert.equal(flaky.calls.length, 2);

  // Step 2 BEFORE step 4: a refusal with EMPTY content must answer, not throw.
  const refusal = stubHttp(async () => ok200({ stop_reason: 'refusal', content: [] }));
  let out;
  await assert.doesNotReject(async () => { out = await classify({ text: QUESTION }, { http: refusal, key: KEY }); });
  assert.deepEqual(out, { verdict: 'unknown', reason: 'refused' });
  assert.equal(refusal.calls.length, 1, 'a refusal is an ANSWER and is never retried');

  // A refusal with content absent entirely — same answer, still no throw.
  const refusalBare = stubHttp(async () => ok200({ stop_reason: 'refusal' }));
  assert.deepEqual(await classify({ text: QUESTION }, { http: refusalBare, key: KEY }), { verdict: 'unknown', reason: 'refused' });

  const truncated = stubHttp(async () => ok200({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"verdict":"needs-' }] }));
  assert.deepEqual(await classify({ text: QUESTION }, { http: truncated, key: KEY }), { verdict: 'unknown', reason: 'truncated' });
  assert.equal(truncated.calls.length, 1, 'a truncation is an ANSWER and is never retried');

  const cases = [
    ['non-JSON text', ok200({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'needs-decision, obviously' }] })],
    ['out-of-enum verdict', ok200(jsonBlock({ verdict: 'unknown', reason: 'the model tried to answer unknown' }))],
    ['another out-of-enum verdict', ok200(jsonBlock({ verdict: 'maybe', reason: 'r' }))],
    ['missing reason', ok200({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ verdict: 'offer-more' }) }] })],
    ['non-string reason', ok200(jsonBlock({ verdict: 'offer-more', reason: 7 }))],
    ['no text block', ok200({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }] })],
    ['empty content on a 2xx', ok200({ stop_reason: 'end_turn', content: [] })],
    ['no body at all', ok200(null)],
    ['a JSON array', ok200({ stop_reason: 'end_turn', content: [{ type: 'text', text: '["needs-decision"]' }] })],
  ];
  for (const [name, res] of cases) {
    const h = stubHttp(async () => res);
    assert.deepEqual(await classify({ text: QUESTION }, { http: h, key: KEY }), { verdict: 'unknown', reason: 'unparseable' }, name);
    assert.equal(h.calls.length, 1, `${name} is an answer, never retried`);
  }

  // The two input-side rows of the failure table, at the classify boundary.
  const never = stubHttp(async () => { throw new Error('must not be reached'); });
  assert.deepEqual(await classify({ text: '' }, { http: never, key: KEY }), { verdict: 'unknown', reason: 'no transcript text' });
  assert.deepEqual(await classify({ text: '   ' }, { http: never, key: KEY }), { verdict: 'unknown', reason: 'no transcript text' });
  assert.deepEqual(await classify({ text: QUESTION }, { http: never, key: null }), { verdict: 'unknown', reason: 'no credential' });
  assert.equal(never.calls.length, 0, 'neither path may reach the transport');
});

// ================================================================================================
// AC3 — the pinned digest
// ================================================================================================
test('AC3 - CLASSIFIER_VERSION is sha256(model + space + prompt + space + schema), first 12 hex', () => {
  assert.equal(classifierVersion('m', 'p', { a: 1 }), '1c2689e6a453');
  assert.equal(CLASSIFIER_VERSION, classifierVersion(CLASSIFIER_MODEL, CLASSIFY_PROMPT, VERDICT_SCHEMA));
  assert.match(CLASSIFIER_VERSION, /^[0-9a-f]{12}$/);
  // The separator is ONE ASCII space and the recipe is order-sensitive.
  assert.notEqual(classifierVersion('m', 'p', { a: 1 }), classifierVersion('m ', 'p', { a: 1 }));
  assert.notEqual(classifierVersion('m', 'p', { a: 1 }), classifierVersion('p', 'm', { a: 1 }));
  assert.equal(CLASSIFY_DEADLINE_MS, 20000);
  assert.equal(COOLDOWN_MS, 300000);
  assert.equal(POOL_SIZE, 4);
});

// ================================================================================================
// AC4 — no valid timestamp
// ================================================================================================
test('AC4 - a transcript with no valid timestamp is unknown(no valid timestamp) and is never cached', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const http = alwaysOk();

  const rows = [
    blocked(dir, { ts: 'the day before yesterday' }),   // unparseable
    blocked(dir, { ts: null }),                          // absent
    blocked(dir, { ts: '   ' }),                         // blank
  ];
  await classifyBlocked(rows, baseDeps({ http, cachePath }));

  for (const s of rows) {
    assert.equal(s.lastAssistant.ts, null, 'the tail read still ran and reported an honest null');
    assert.equal(s.lastAssistant.text, QUESTION);
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'no valid timestamp', model: null, at: NOW_ISO, inferred: true });
  }
  assert.equal(http.calls.length, 0, 'a key without a timestamp is not a key; nothing is asked');
  assert.equal(readCache(cachePath), null, 'nothing is written at all');
});

// ================================================================================================
// AC5 — the cache key is (machine, sessionId, ts, CLASSIFIER_VERSION)
// ================================================================================================
test('AC5 - an unchanged ts and version is served from cache; a changed ts or version is not', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const http = alwaysOk('needs-decision', 'a direct question');
  const deps = baseDeps({ http, cachePath });

  const s1 = blocked(dir, { sessionId: 'fixture-inbox-5' });
  await classifyBlocked([s1], deps);
  assert.equal(http.calls.length, 1);
  assert.equal(s1.intent.verdict, 'needs-decision');

  // Sweep two, same identity and same ts: the cache answers.
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-5' });
  await classifyBlocked([s2], deps);
  assert.equal(http.calls.length, 1, 'an unchanged ts and version costs no HTTP');
  assert.deepEqual(s2.intent, s1.intent);

  // A changed ts is a different key.
  const s3 = blocked(dir, { sessionId: 'fixture-inbox-5', ts: '2026-07-30T11:00:00.000Z' });
  await classifyBlocked([s3], deps);
  assert.equal(http.calls.length, 2, 'a new turn is a new classification');

  // A changed prompt/model/schema is a different key, via CLASSIFIER_VERSION. Preloading a
  // suppressing entry under an OLD version proves the version is inside the key: if it were not,
  // this entry would serve and no call would be made.
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const s4 = blocked(dir2, { sessionId: 'fixture-inbox-6' });
  const staleKey = intentCacheKey(MACHINE, 'fixture-inbox-6', TS, 'aaaaaaaaaaaa');
  writeCache(cache2, { [staleKey]: entry('offer-more', NOW_ISO, 'a verdict from a previous classifier') });
  const http2 = alwaysOk('needs-decision', 'a direct question');
  await classifyBlocked([s4], baseDeps({ http: http2, cachePath: cache2 }));
  assert.equal(http2.calls.length, 1, 'a verdict from a different classifier version never serves');
  assert.equal(s4.intent.verdict, 'needs-decision');
  const after = readCache(cache2);
  assert.ok(Object.prototype.hasOwnProperty.call(after, intentCacheKey(MACHINE, 'fixture-inbox-6', TS)), 'the live entry lands under the CURRENT version');
});

// ================================================================================================
// AC6 — expiry is checked AT LOOKUP
// ================================================================================================
test('AC6 - a cache entry expires at lookup: just-under hits, exactly-at misses, over misses', async () => {
  _resetClassifyState();
  const at = '2026-07-28T09:00:00.000Z';
  const atMs = Date.parse(at);
  const key = intentCacheKey(MACHINE, 'fixture-inbox-7', TS);

  const cases = [
    ['just under 48h', atMs + RETENTION_MS - 1000, 0, 'offer-more'],
    ['exactly 48h', atMs + RETENTION_MS, 1, 'needs-decision'],
    ['48h + 1s', atMs + RETENTION_MS + 1000, 1, 'needs-decision'],
  ];
  for (const [name, now, expectedCalls, expectedVerdict] of cases) {
    const dir = tmpdir();
    const cachePath = path.join(dir, 'intent-cache.json');
    // Written directly, and read back with NO intervening write of any kind.
    writeCache(cachePath, { [key]: entry('offer-more', at, 'a stale suppressing verdict') });
    const http = alwaysOk('needs-decision', 'a direct question');
    const s = blocked(dir, { sessionId: 'fixture-inbox-7' });
    await classifyBlocked([s], baseDeps({ http, cachePath, now: () => now }));
    assert.equal(http.calls.length, expectedCalls, name);
    assert.equal(s.intent.verdict, expectedVerdict, name);
    if (expectedCalls === 0) assert.equal(s.intent.at, at, `${name} serves the cached at`);
  }
});

// ================================================================================================
// AC7 — unknown is never cached; expired entries are dropped on write
// ================================================================================================
test('AC7 - unknown is never cached, and an entry older than 48h is absent from the written file', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // (a) every unknown path leaves the cache untouched.
  const dead = stubHttp(async () => httpErr(500));
  const sDead = blocked(dir, { sessionId: 'fixture-inbox-8' });
  await classifyBlocked([sDead], baseDeps({ http: dead, cachePath }));
  assert.equal(sDead.intent.verdict, 'unknown');
  assert.equal(readCache(cachePath), null, 'an unknown writes no file at all');

  const refused = stubHttp(async () => ok200({ stop_reason: 'refusal', content: [] }));
  const sRef = blocked(dir, { sessionId: 'fixture-inbox-9' });
  await classifyBlocked([sRef], baseDeps({ http: refused, cachePath }));
  assert.equal(sRef.intent.reason, 'refused');
  assert.equal(readCache(cachePath), null);

  // (b) the write-time prune. `oldKey` is past retention, `freshKey` is not, and this sweep adds a
  // third — one serialized read-modify-write decides the fate of all three.
  const oldKey = intentCacheKey(MACHINE, 'fixture-inbox-old', TS);
  const freshKey = intentCacheKey(MACHINE, 'fixture-inbox-fresh', TS);
  writeCache(cachePath, {
    [oldKey]: entry('offer-more', new Date(NOW - RETENTION_MS - 1000).toISOString()),
    [freshKey]: entry('status-only', new Date(NOW - 1000).toISOString()),
  });
  const live = alwaysOk('needs-decision', 'a direct question');
  const sNew = blocked(dir, { sessionId: 'fixture-inbox-10' });
  await classifyBlocked([sNew], baseDeps({ http: live, cachePath }));

  const after = readCache(cachePath);
  assert.equal(Object.prototype.hasOwnProperty.call(after, oldKey), false, 'an entry past retention is dropped on write');
  assert.equal(Object.prototype.hasOwnProperty.call(after, freshKey), true, 'a fresh entry survives the same write');
  assert.deepEqual(after[intentCacheKey(MACHINE, 'fixture-inbox-10', TS)],
    { verdict: 'needs-decision', reason: 'a direct question', model: CLASSIFIER_MODEL, at: NOW_ISO });
  assert.equal(Object.keys(after).length, 2);
});

// ================================================================================================
// AC8 — single-flight within a stage, and one serialized write for the batch
// ================================================================================================
test('AC8 - two rows on one key cost one HTTP call; two keys survive one serialized write', async (t) => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // Same machine, same sessionId, same ts -> the same key, resolved concurrently by the pool.
  const tp = transcript(dir, QUESTION);
  const a = blocked(dir, { sessionId: 'fixture-inbox-11', transcriptPath: tp });
  const b = blocked(dir, { sessionId: 'fixture-inbox-11', transcriptPath: tp });
  const http = alwaysOk('needs-decision', 'a direct question');
  await classifyBlocked([a, b], baseDeps({ http, cachePath }));
  assert.equal(http.calls.length, 1, 'single-flight collapses one key to one call');
  assert.equal(a.intent.verdict, 'needs-decision');
  assert.deepEqual(b.intent, a.intent, 'both receive the verdict');

  // Two different keys -> two calls, ONE serialized write carrying both.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const spy = t.mock.method(store, 'updateJson');
  const c = blocked(dir2, { sessionId: 'fixture-inbox-12' });
  const d = blocked(dir2, { sessionId: 'fixture-inbox-13' });
  const http2 = alwaysOk('status-only', 'a completion report');
  await classifyBlocked([c, d], baseDeps({ http: http2, cachePath: cache2 }));

  assert.equal(http2.calls.length, 2);
  const writes = spy.mock.calls.filter((call) => call.arguments[0] === cache2);
  assert.equal(writes.length, 1, 'one serialized read-modify-write per sweep, for the whole batch');
  const file = readCache(cache2);
  assert.equal(Object.keys(file).length, 2, 'both entries survive the single write');
  assert.ok(file[intentCacheKey(MACHINE, 'fixture-inbox-12', TS)]);
  assert.ok(file[intentCacheKey(MACHINE, 'fixture-inbox-13', TS)]);
});

// ================================================================================================
// AC9 — a corrupt cache file
// ================================================================================================
test('AC9 - a corrupt intent-cache.json is rebuilt as {} plus this sweep entries', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  fs.writeFileSync(cachePath, '{"a": not json at all,,,');

  const http = alwaysOk('needs-decision', 'a direct question');
  const s = blocked(dir, { sessionId: 'fixture-inbox-14' });
  let threw = null;
  try { await classifyBlocked([s], baseDeps({ http, cachePath })); } catch (e) { threw = e; }

  assert.equal(threw, null, 'store.updateJson REJECTS a corrupt file; the stage must wrap that');
  assert.equal(s.intent.verdict, 'needs-decision', 'the sweep completed');
  const after = readCache(cachePath);
  assert.notEqual(after, null, 'the file parses again');
  assert.deepEqual(Object.keys(after), [intentCacheKey(MACHINE, 'fixture-inbox-14', TS)], '{} plus this sweep');
});

// ================================================================================================
// AC10 — KEY INJECTIVITY, the adversarial colon tuple
// ================================================================================================
test('AC10 - {machine:a, sessionId:b:c} and {machine:a:b, sessionId:c} never share a cache key', async () => {
  _resetClassifyState();
  // The encoding itself, first. A colon-joined template would make these two strings identical.
  assert.notEqual(intentCacheKey('a', 'b:c', TS), intentCacheKey('a:b', 'c', TS));
  assert.equal(['a', 'b:c', TS].join(':'), ['a:b', 'c', TS].join(':'), 'the naive encoding really does collide');

  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const tpA = transcript(dir, QUESTION);
  const tpB = transcript(dir, OFFER);
  const a = { key: { machine: 'a', sessionId: 'b:c' }, status: 'blocked', transcriptPath: tpA };
  const b = { key: { machine: 'a:b', sessionId: 'c' }, status: 'blocked', transcriptPath: tpB };

  // Distinct verdicts, routed by the text each session actually said.
  const http = stubHttp(async (req) => {
    const said = JSON.parse(req.body).messages[0].content;
    return said === QUESTION ? verdictOk('needs-decision', 'asked which order') : verdictOk('offer-more', 'offered optional work');
  });
  await classifyBlocked([a, b], baseDeps({ http, cachePath }));

  assert.equal(http.calls.length, 2, 'two distinct HTTP classifications occur');
  assert.equal(a.intent.verdict, 'needs-decision');
  assert.equal(b.intent.verdict, 'offer-more');
  const file = readCache(cachePath);
  assert.equal(Object.keys(file).length, 2, 'two distinct cache entries');
  assert.equal(file[intentCacheKey('a', 'b:c', TS)].verdict, 'needs-decision');
  assert.equal(file[intentCacheKey('a:b', 'c', TS)].verdict, 'offer-more');

  // The suppression that a shared key would cause: `b`'s cached offer-more must not answer for `a`
  // on a later sweep in a fresh cache holding only b's entry.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  writeCache(cache2, { [intentCacheKey('a:b', 'c', TS)]: entry('offer-more', NOW_ISO, 'the suppressing verdict') });
  const a2 = { key: { machine: 'a', sessionId: 'b:c' }, status: 'blocked', transcriptPath: transcript(dir2, QUESTION) };
  const http2 = alwaysOk('needs-decision', 'asked which order');
  await classifyBlocked([a2], baseDeps({ http: http2, cachePath: cache2 }));
  assert.equal(http2.calls.length, 1, 'one session\'s cached offer-more never serves the other');
  assert.equal(a2.intent.verdict, 'needs-decision', 'the genuine question is not suppressed');
});

// ================================================================================================
// AC11 — no credential bypasses the cache for publication
// ================================================================================================
test('AC11 - no credential: every blocked session is unknown(no credential) and the cache is untouched', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const suppressing = {
    [intentCacheKey(MACHINE, 'fixture-inbox-15', TS)]: entry('offer-more', NOW_ISO, 'optional further work'),
    [intentCacheKey(MACHINE, 'fixture-inbox-16', TS)]: entry('status-only', NOW_ISO, 'a completion report'),
  };
  writeCache(cachePath, suppressing);
  const before = fs.readFileSync(cachePath);

  const rows = [blocked(dir, { sessionId: 'fixture-inbox-15' }), blocked(dir, { sessionId: 'fixture-inbox-16' })];
  const http = stubHttp(async () => { throw new Error('must not be reached'); });
  // The env has the DEFAULT variable set but not the one the config names — an absent key, not an
  // absent environment.
  await classifyBlocked(rows, baseDeps({ http, cachePath, env: { ANTHROPIC_API_KEY: 'fixture-wrong-variable' } }));

  for (const s of rows) {
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'no credential', model: null, at: NOW_ISO, inferred: true });
    assert.deepEqual(s.lastAssistant, { text: QUESTION, ts: TS }, 'the transcript read still runs');
  }
  assert.equal(http.calls.length, 0);
  assert.deepEqual(fs.readFileSync(cachePath), before, 'existing entries stay on disk, byte-identical');
});

// ================================================================================================
// AC12 — PRECEDENCE: no credential outranks network === false
// ================================================================================================
test('AC12 - no credential AND network false: no credential wins, zero HTTP, zero cache reads', async (t) => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  writeCache(cachePath, { [intentCacheKey(MACHINE, 'fixture-inbox-17', TS)]: entry('offer-more', NOW_ISO, 'optional further work') });

  const spy = t.mock.method(store, 'readJson');
  const http = stubHttp(async () => { throw new Error('must not be reached'); });
  const s = blocked(dir, { sessionId: 'fixture-inbox-17' });
  await classifyBlocked([s], baseDeps({ http, cachePath, network: false, env: {} }));

  assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'no credential', model: null, at: NOW_ISO, inferred: true });
  assert.notEqual(s.intent.reason, 'classifier unreachable', 'fetch:false does not get to answer first');
  assert.equal(http.calls.length, 0, 'zero HTTP calls');
  const cacheReads = spy.mock.calls.filter((call) => call.arguments[0] === cachePath);
  assert.equal(cacheReads.length, 0, 'the cache is not even READ, let alone used for publication');
});

// ================================================================================================
// AC13 — the credential outranks a failed transcript read
// ================================================================================================
test('AC13 - no credential plus a missing transcript publishes no credential, never no transcript text', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  writeCache(cachePath, { [intentCacheKey(MACHINE, 'fixture-inbox-18', TS)]: entry('offer-more', NOW_ISO, 'optional further work') });

  const missing = path.join(dir, 'fixture-transcript-absent.jsonl');
  const http = stubHttp(async () => { throw new Error('must not be reached'); });
  const s = blocked(dir, { sessionId: 'fixture-inbox-18', transcriptPath: missing });
  await classifyBlocked([s], baseDeps({ http, cachePath, env: {} }));

  assert.equal(s.lastAssistant, null, 'lastAssistant publishes null, honestly');
  assert.equal(s.intent.reason, 'no credential');
  assert.notEqual(s.intent.reason, 'no transcript text');
  assert.equal(http.calls.length, 0);

  // The control that makes the precedence claim mean something: the SAME missing transcript with a
  // key present does report `no transcript text`.
  _resetClassifyState();
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-18', transcriptPath: missing });
  await classifyBlocked([s2], baseDeps({ http, cachePath }));
  assert.equal(s2.lastAssistant, null);
  assert.equal(s2.intent.reason, 'no transcript text', 'that reason requires a resolved credential');
  assert.equal(http.calls.length, 0, 'no text is nothing to ask about');
});

// ================================================================================================
// AC14 — classifierKeyRef, raw file to request header
// ================================================================================================
test('AC14 - a raw config classifierKeyRef names the env var end to end; absent means ANTHROPIC_API_KEY', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // The normalizer's own contract first.
  assert.equal(DEFAULTS.classifierKeyRef, null);
  assert.equal(normalizeConfig({}).config.classifierKeyRef, null);
  assert.equal(normalizeConfig({ classifierKeyRef: '  FIXTURE_ALT  ' }).config.classifierKeyRef, 'FIXTURE_ALT');
  assert.equal(normalizeConfig({ classifierKeyRef: '   ' }).config.classifierKeyRef, null);
  assert.equal(normalizeConfig({ classifierKeyRef: 42 }).config.classifierKeyRef, null);

  // A RAW config file on disk, through loadConfig, into the request header.
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ configVersion: 1, repos: [], classifierKeyRef: 'FIXTURE_ALT_KEY_REF' }));
  const loaded = await loadConfig(cfgPath, NOW);
  assert.equal(loaded.config.classifierKeyRef, 'FIXTURE_ALT_KEY_REF');

  const http = alwaysOk();
  const s = blocked(dir, { sessionId: 'fixture-inbox-19' });
  await classifyBlocked([s], {
    config: loaded.config, cachePath, now: () => NOW, http,
    env: { FIXTURE_ALT_KEY_REF: ALT_KEY, ANTHROPIC_API_KEY: 'fixture-default-variable-value' },
  });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].headers['x-api-key'], ALT_KEY, 'the NAMED variable is the one read');

  // Absent -> the default variable name.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cfg2 = path.join(dir2, 'config.json');
  fs.writeFileSync(cfg2, JSON.stringify({ configVersion: 1, repos: [] }));
  const loaded2 = await loadConfig(cfg2, NOW);
  assert.equal(loaded2.config.classifierKeyRef, null);

  const http2 = alwaysOk();
  const s2 = blocked(dir2, { sessionId: 'fixture-inbox-20' });
  await classifyBlocked([s2], {
    config: loaded2.config, cachePath: path.join(dir2, 'intent-cache.json'), now: () => NOW, http: http2,
    env: { ANTHROPIC_API_KEY: KEY },
  });
  assert.equal(http2.calls[0].headers['x-api-key'], KEY, 'null classifierKeyRef means ANTHROPIC_API_KEY');
});

// ================================================================================================
// AC15 — key present, network === false
// ================================================================================================
test('AC15 - fetch:false serves a warm hit with zero HTTP and starts NO cooldown on a miss', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const warmKey = intentCacheKey(MACHINE, 'fixture-inbox-21', TS);
  writeCache(cachePath, { [warmKey]: entry('offer-more', NOW_ISO, 'optional further work') });

  const http = stubHttp(async () => { throw new Error('must not be reached'); });
  const warm = blocked(dir, { sessionId: 'fixture-inbox-21' });
  await classifyBlocked([warm], baseDeps({ http, cachePath, network: false }));
  assert.equal(warm.intent.verdict, 'offer-more', 'a warm hit is served');
  assert.equal(warm.intent.at, NOW_ISO);
  assert.equal(http.calls.length, 0, 'cache reads are disk, not network');

  // A miss on the same offline sweep.
  const miss = blocked(dir, { sessionId: 'fixture-inbox-22' });
  await classifyBlocked([miss], baseDeps({ http, cachePath, network: false }));
  assert.deepEqual(miss.intent, { verdict: 'unknown', reason: 'classifier unreachable', model: null, at: NOW_ISO, inferred: true });
  assert.equal(http.calls.length, 0);

  // NO cooldown was started: the very next network-enabled sweep asks immediately, well inside the
  // 5-minute window. "We did not ask" must not be penalised like "it did not answer".
  const live = alwaysOk('needs-decision', 'a direct question');
  const retry = blocked(dir, { sessionId: 'fixture-inbox-22' });
  await classifyBlocked([retry], baseDeps({ http: live, cachePath, now: () => NOW + 1000 }));
  assert.equal(live.calls.length, 1, 'a fetch:false miss starts no cooldown');
  assert.equal(retry.intent.verdict, 'needs-decision');
});

// ================================================================================================
// AC16 — the 5-minute negative cooldown boundary
// ================================================================================================
test('AC16 - a failed operation backs off for exactly 5 minutes, then retries once', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const http = stubHttp(async () => httpErr(502));
  let clock = NOW;
  const deps = baseDeps({ http, cachePath, now: () => clock });

  const s1 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s1], deps);
  assert.equal(http.calls.length, 2, 'sweep one: exactly one attempt-pair');
  assert.equal(s1.intent.reason, 'classifier unreachable');

  // Inside the window — the row still shows unknown, but nothing is asked.
  clock = NOW + COOLDOWN_MS - 1;
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s2], deps);
  assert.equal(http.calls.length, 2, 'within 5 minutes: no HTTP attempt');
  assert.equal(s2.intent.reason, 'classifier unreachable', 'a cooldown is a back-off, never a suppression');

  // At the boundary — one fresh attempt-pair, and one only.
  clock = NOW + COOLDOWN_MS;
  const s3 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s3], deps);
  assert.equal(http.calls.length, 4, 'at the boundary: exactly one fresh attempt-pair');

  // ...which re-arms the cooldown rather than retrying every sweep.
  clock = NOW + COOLDOWN_MS + 1000;
  const s4 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s4], deps);
  assert.equal(http.calls.length, 4, 'the failed retry re-arms the window');
  assert.equal(readCache(cachePath), null, 'no unknown was ever cached');
});

// ================================================================================================
// AC17 — DEADLINE WITH TEETH
// ================================================================================================
test('AC17 - the stage resolves at 20s with unknown(deadline) at 1, 4, 5 and 12 blocked sessions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  // §5.2.6's literal, spelled out rather than read from POOL_SIZE: a bound asserted against the
  // constant it is bounding cannot catch that constant changing.
  const CONCURRENCY = 4;

  for (const n of [1, 4, 5, 12]) {
    _resetClassifyState();
    const dir = tmpdir();
    const cachePath = path.join(dir, 'intent-cache.json');
    const http = gatedHttp();                                    // never settles on its own
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(blocked(dir, { sessionId: `fixture-inbox-d${n}-${i}` }));

    const stage = classifyBlocked(rows, baseDeps({ http, cachePath }));
    const started = Math.min(CONCURRENCY, n);
    assert.ok(await until(() => http.calls.length === started), `n=${n}: the pool starts ${started}`);
    await turns(5);
    assert.equal(http.calls.length, started, `n=${n}: never more than ${CONCURRENCY} concurrent`);

    t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
    const out = await stage;
    assert.equal(out, rows, 'the stage returns the same array');

    for (const s of rows) {
      assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true }, `n=${n}`);
      assert.deepEqual(s.lastAssistant, { text: QUESTION, ts: TS }, `n=${n}: the transcript read still ran`);
    }
    // Queued tasks NEVER start.
    await turns(20);
    assert.equal(http.calls.length, started, `n=${n}: queued tasks are never started at the deadline`);
    // The stage's abort signal reaches every in-flight attempt.
    for (const req of http.calls) assert.equal(req.signal.aborted, true, `n=${n}: the signal is delivered`);
    // Nothing cached, no file at all.
    assert.equal(readCache(cachePath), null, `n=${n}: a deadline caches nothing`);

    // And no cooldown: the very next sweep for the SAME key asks immediately.
    if (n === 1) {
      const live = alwaysOk('needs-decision', 'a direct question');
      const again = blocked(dir, { sessionId: 'fixture-inbox-d1-0' });
      await classifyBlocked([again], baseDeps({ http: live, cachePath }));
      assert.equal(live.calls.length, 1, 'deadline starts no cooldown');
      assert.equal(again.intent.verdict, 'needs-decision');
    }
  }

  // A pool slot freeing up AFTER the deadline must still start nothing. This is the ONLY shape that
  // tests the rule: with every attempt hung forever no worker ever loops, so the queue would sit
  // untouched by accident rather than by rule, and a missing guard would read as a pass.
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const http = gatedHttp();
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(blocked(dir, { sessionId: `fixture-inbox-q${i}` }));

  const stage = classifyBlocked(rows, baseDeps({ http, cachePath }));
  assert.ok(await until(() => http.calls.length === CONCURRENCY));
  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stage;

  http.settle(0, verdictOk('needs-decision', 'an answer that arrived too late'));
  await turns(40);
  assert.equal(http.calls.length, CONCURRENCY, 'a freed slot after the deadline still starts no queued task');
  for (const s of rows) assert.equal(s.intent.reason, 'deadline');
  assert.equal(readCache(cachePath), null, 'and the late answer is not cached');
});

// ================================================================================================
// AC18 — GENERATION GUARD
// ================================================================================================
test('AC18 - a verdict that lands after the deadline mutates nothing at all', async (t) => {
  _resetClassifyState();
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // This transport IGNORES the abort signal entirely — the exact adversary §5.2.6 names.
  const http = gatedHttp();
  const s = blocked(dir, { sessionId: 'fixture-inbox-24' });
  const stage = classifyBlocked([s], baseDeps({ http, cachePath }));
  assert.ok(await until(() => http.calls.length === 1));

  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stage;
  assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true });

  // NOW it answers, schema-valid, well after the stage is over.
  http.settle(0, verdictOk('offer-more', 'a late suppressing verdict'));
  await turns(40);

  assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true },
    'the late result mutated no session');
  assert.equal(readCache(cachePath), null, 'the late result wrote no cache entry');

  // No cooldown either — a subsequent sweep asks immediately.
  const live = alwaysOk('needs-decision', 'a direct question');
  const again = blocked(dir, { sessionId: 'fixture-inbox-24' });
  await classifyBlocked([again], baseDeps({ http: live, cachePath }));
  assert.equal(live.calls.length, 1, 'the late result started no cooldown');
  assert.equal(again.intent.verdict, 'needs-decision', 'and the fresh verdict is the one that publishes');
});

// ================================================================================================
// AC19 — SINGLE-FLIGHT EVICTION ACROSS GENERATIONS
// ================================================================================================
test('AC19 - generation B never joins A stale work, and A late finally never evicts B live entry', async (t) => {
  _resetClassifyState();
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const http = gatedHttp();                                       // abort-ignoring, fully gated

  // The one session identity both generations share. K is its cache key.
  const tpK = transcript(dir, QUESTION);
  const kRow = () => ({ key: { machine: MACHINE, sessionId: 'fixture-inbox-25' }, status: 'blocked', transcriptPath: tpK });
  const K = intentCacheKey(MACHINE, 'fixture-inbox-25', TS);

  // ---- generation A: starts, deadline-expires while its call for K is still pending.
  const aRow = kRow();
  const stageA = classifyBlocked([aRow], baseDeps({ http, cachePath }));
  assert.ok(await until(() => http.calls.length === 1), 'A calls once for K');
  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stageA;
  assert.equal(aRow.intent.reason, 'deadline');

  // ---- generation B: the same key K, plus four fillers that occupy the pool so that a SECOND row
  // on key K is still queued when A's stale promise finally settles. That queued row is the only
  // observer of whether B's in-flight entry survived A's cleanup.
  const kA = kRow();
  const kB = kRow();
  const fillers = [];
  for (let i = 0; i < 4; i++) fillers.push(blocked(dir, { sessionId: `fixture-inbox-f${i}`, text: `Filler turn ${i}. Which one?` }));
  const stageB = classifyBlocked([kA].concat(fillers, [kB]), baseDeps({ http, cachePath }));

  // Pool of 4 -> kA + fillers 0,1,2. Calls 1..4 (index 1..4); filler 3 and kB are queued.
  assert.ok(await until(() => http.calls.length === 5), 'B starts four tasks: K and three fillers');
  await turns(5);
  assert.equal(http.calls.length, 5, 'B makes a FRESH call for K rather than joining A stale work');

  // A's stale promise settles NOW, with a schema-valid verdict, while B's entry for K is live.
  http.settle(0, verdictOk('offer-more', 'A late suppressing verdict'));
  await turns(30);
  assert.equal(http.calls.length, 5, 'A late settle starts nothing');

  // Drain one filler so its worker picks up filler 3, then another so a worker reaches kB.
  http.settle(2, verdictOk('status-only', 'filler 0'));
  assert.ok(await until(() => http.calls.length === 6), 'the queued filler starts');
  http.settle(3, verdictOk('status-only', 'filler 1'));
  await turns(40);
  // THE ASSERTION THIS TEST EXISTS FOR: kB found B's entry for K still in the map and JOINED it. If
  // A's late `finally` had deleted it, kB would have opened a seventh call.
  assert.equal(http.calls.length, 6, 'A late finally did not remove B live in-flight entry for K');

  http.settle(1, verdictOk('needs-decision', 'B verdict for K'));
  http.settle(4, verdictOk('status-only', 'filler 2'));
  http.settle(5, verdictOk('status-only', 'filler 3'));
  const out = await stageB;
  assert.equal(out.length, 6);

  assert.equal(kA.intent.verdict, 'needs-decision');
  assert.equal(kA.intent.reason, 'B verdict for K');
  assert.deepEqual(kB.intent, kA.intent, 'both rows on key K received the one verdict');
  assert.equal(aRow.intent.reason, 'deadline', 'generation A row is still exactly what the deadline wrote');

  const file = readCache(cachePath);
  assert.equal(file[K].verdict, 'needs-decision', 'B successful verdict is the one cached');
  assert.equal(file[K].reason, 'B verdict for K');
  assert.notEqual(file[K].reason, 'A late suppressing verdict', 'A late verdict was discarded whole');
  assert.equal(Object.keys(file).length, 5, 'K plus four fillers');
});

// ================================================================================================
// AC20 — a cache hit still populates lastAssistant; every unknown is model null at sweep time
// ================================================================================================
test('AC20 - a cache hit keeps lastAssistant, and every unknown carries model null at the sweep time', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const at = '2026-07-30T09:59:00.000Z';
  writeCache(cachePath, { [intentCacheKey(MACHINE, 'fixture-inbox-26', TS)]: entry('offer-more', at, 'optional further work') });

  const http = stubHttp(async () => { throw new Error('must not be reached'); });
  const hit = blocked(dir, { sessionId: 'fixture-inbox-26' });
  await classifyBlocked([hit], baseDeps({ http, cachePath }));
  assert.equal(http.calls.length, 0);
  assert.deepEqual(hit.lastAssistant, { text: QUESTION, ts: TS }, 'the tail read runs on a HIT too');
  assert.deepEqual(hit.intent, { verdict: 'offer-more', reason: 'optional further work', model: CLASSIFIER_MODEL, at, inferred: true });

  // Every unknown path in one sweep: refused, truncated, unparseable, no text, no timestamp.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const bodies = {
    refused: ok200({ stop_reason: 'refusal', content: [] }),
    truncated: ok200({ stop_reason: 'max_tokens', content: [] }),
    unparseable: ok200({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }),
  };
  const rows = {
    refused: blocked(dir2, { sessionId: 'fixture-inbox-27', text: 'Refusal probe. Which one?' }),
    truncated: blocked(dir2, { sessionId: 'fixture-inbox-28', text: 'Truncation probe. Which one?' }),
    unparseable: blocked(dir2, { sessionId: 'fixture-inbox-29', text: 'Unparseable probe. Which one?' }),
  };
  const noText = blocked(dir2, { sessionId: 'fixture-inbox-30', transcriptPath: path.join(dir2, 'absent.jsonl') });
  const noTs = blocked(dir2, { sessionId: 'fixture-inbox-31', ts: 'not a date' });
  const byText = new Map([
    ['Refusal probe. Which one?', bodies.refused],
    ['Truncation probe. Which one?', bodies.truncated],
    ['Unparseable probe. Which one?', bodies.unparseable],
  ]);
  const http2 = stubHttp(async (req) => byText.get(JSON.parse(req.body).messages[0].content));
  const all = [rows.refused, rows.truncated, rows.unparseable, noText, noTs];
  await classifyBlocked(all, baseDeps({ http: http2, cachePath: cache2 }));

  const expected = ['refused', 'truncated', 'unparseable', 'no transcript text', 'no valid timestamp'];
  all.forEach((s, i) => {
    assert.equal(s.intent.verdict, 'unknown', expected[i]);
    assert.equal(s.intent.reason, expected[i]);
    assert.equal(s.intent.model, null, `${expected[i]}: model is null on every unknown path`);
    assert.equal(s.intent.at, NOW_ISO, `${expected[i]}: at is the sweep time`);
    assert.equal(s.intent.inferred, true, 'an inferred fact is always labelled');
  });
  assert.equal(readCache(cache2), null, 'not one unknown was cached');
});

// ================================================================================================
// AC21 — vanished rows
// ================================================================================================
test('AC21 - vanished:true blocked rows gain lastAssistant and intent exactly like live ones', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const http = alwaysOk('needs-decision', 'a direct question');

  const live = blocked(dir, { sessionId: 'fixture-inbox-32' });
  const gone = blocked(dir, { sessionId: 'fixture-inbox-33', vanished: true, surfaceReason: 'recorded-tab-gone' });
  const idle = blocked(dir, { sessionId: 'fixture-inbox-34', status: 'idle' });
  await classifyBlocked([live, gone, idle], baseDeps({ http, cachePath }));

  assert.equal(gone.vanished, true, 'the flag is untouched');
  assert.deepEqual(gone.lastAssistant, { text: QUESTION, ts: TS });
  assert.equal(gone.intent.verdict, 'needs-decision');
  assert.equal(gone.intent.inferred, true);
  assert.deepEqual(Object.keys(gone.intent).sort(), Object.keys(live.intent).sort(), 'identical shape to a live row');

  assert.equal(idle.intent, undefined, 'a non-blocked session is returned untouched');
  assert.equal(idle.lastAssistant, undefined);
  assert.equal(http.calls.length, 2, 'both blocked rows were classified, the idle one was not');
});

// ================================================================================================
// AC22 — a throwing stage never stops the sweep
// ================================================================================================
test('AC22 - a classify stage that throws still publishes, with unknown(stage failed) everywhere', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-classify-collector-'));
  dirs.push(dir);
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 1, role: 'leader', repos: [] }));

  const rows = [
    { key: { machine: MACHINE, sessionId: 'fixture-inbox-35' }, status: 'blocked', epic: null, surface: null, surfaceReason: null, notificationType: 'idle_prompt', cacheExpiresAt: null, transcriptPath: transcript(dir, QUESTION) },
    { key: { machine: MACHINE, sessionId: 'fixture-inbox-36' }, status: 'blocked', epic: null, surface: null, surfaceReason: null, notificationType: 'idle_prompt', cacheExpiresAt: null, transcriptPath: transcript(dir, OFFER) },
    { key: { machine: MACHINE, sessionId: 'fixture-inbox-37' }, status: 'idle', epic: null, surface: null, surfaceReason: null, notificationType: null, cacheExpiresAt: null, transcriptPath: transcript(dir, OFFER) },
  ];
  const sessionsModule = async () => ({
    fragment: { sessions: rows, machines: [{ id: MACHINE, bridge: 'ok', lastSeenAt: NOW_ISO, eventsStatus: 'ok', error: null, statusTruncated: false, stale: false }] },
    source: { status: 'ok', observedAt: NOW_ISO },
    warnings: [],
  });

  let called = 0;
  const c = createCollector({
    radarDir: dir,
    modules: { sessions: sessionsModule },
    classifyBlocked: async () => { called++; throw new Error('fixture classifier exploded'); },
  });
  const res = await c.scan({ fetch: false });
  c.stop();

  assert.equal(called, 1, 'the stage really was invoked');
  assert.equal(res.ok, true);
  assert.equal(res.published, true, 'the sweep still publishes');
  assert.ok(res.warnings.some((w) => /classify: fixture classifier exploded/.test(w)), 'and says so in warnings');

  const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'));
  const blockedRows = onDisk.sessions.filter((s) => s.status === 'blocked');
  assert.equal(blockedRows.length, 2);
  for (const s of blockedRows) {
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'stage failed', model: null, at: onDisk.generatedAt, inferred: true });
  }
  assert.equal(onDisk.sessions.find((s) => s.status === 'idle').intent, undefined);
});

// ================================================================================================
// DoD — the suite makes zero network calls
// ================================================================================================
test('DoD - no test in this file can reach the network: the default transport is never used', async () => {
  _resetClassifyState();
  // `classify` reaches globalThis.fetch ONLY through defaultHttp, and only when deps.http is absent.
  // Proving that is the whole guarantee: every test above injects deps.http.
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(url); throw new Error('fixture: offline'); };
  try {
    const r = await classify({ text: QUESTION }, { key: KEY });
    assert.deepEqual(r, { verdict: 'unknown', reason: 'classifier unreachable' });
    assert.deepEqual(seen, ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages'],
      'the default transport is the ONLY path to the wire, and it is POST-capable');
  } finally { globalThis.fetch = realFetch; }

  // And it really is a POST with a body — neither existing radar client can do that.
  const captured = [];
  globalThis.fetch = async (url, init) => { captured.push(init); throw new Error('fixture: offline'); };
  try { await C.defaultHttp({ url: 'https://example.invalid/', method: 'POST', headers: { a: 'b' }, body: '{"x":1}' }); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].body, '{"x":1}');
  assert.ok(captured[0].signal, 'every attempt carries an AbortController signal');
});
