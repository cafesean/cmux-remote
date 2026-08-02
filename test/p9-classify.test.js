'use strict';
// S-003 — §5.2.2 to §5.2.6: the classifier, the binary precedence rule, the intent cache, the
// negative cooldown, generation-scoped single-flight, and the stage deadline.
//
// EVERY FIXTURE IS INVENTED — invented prose, invented machine ids, invented session ids, invented
// timestamps, invented binary paths, invented paths under a fresh temp directory. This repository is
// public.
//
// NOTHING HERE TOUCHES THE NETWORK AND NOTHING HERE STARTS A PROCESS. The transport is a child
// process, not a socket, so the property to guarantee changed shape with it: `deps.run` is injected
// in every test that can reach the transport, and the module's real `child_process.spawn` is
// replaced at load with a guard that records and refuses. The DoD test at the foot of this file
// asserts that guard recorded ZERO calls — which is what makes "no test spawns anything" a measured
// property of the suite rather than a claim about it.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const util = require('util');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const C = require('../radar/classify');
const store = require('../radar/store');
const { createCollector } = require('../radar/collector');
const { normalizeConfig, loadConfig, DEFAULTS } = require('../radar/config');
const { RETENTION_MS } = require('../radar/eventlog');

const {
  classify, classifyBlocked, classifierVersion, intentCacheKey, transportOf,
  resolveClassifier, probeBinary, classifyArgv, readVerdict, defaultRun, verdictOf,
  PROVIDERS, PROVIDER_IDS, providerOf,
  CLASSIFY_PROMPT, CLASSIFIER_VERSION, CLASSIFY_DEADLINE_MS, TRANSPORT_SHAPE,
  DEFAULT_PROVIDER, DEFAULT_EFFORT, VERDICT_SCHEMA_PATH,
  ATTEMPT_TIMEOUT_MS, PROBE_TIMEOUT_MS, MAX_PROMPT_BYTES,
  COOLDOWN_MS, POOL_SIZE, _resetClassifyState,
} = C;

// What an UNCONFIGURED collector runs: the default provider's own model and flag set. Read off the
// provider rather than restated, because a literal here would silently stop matching what ships.
const CLAUDE = PROVIDERS.claude;
const CODEX = PROVIDERS.codex;
const DEFAULT_MODEL = CLAUDE.defaultModel;
const DEFAULT_FLAGS = CLAUDE.defaultFlags;

// ---- THE SPAWN GUARD --------------------------------------------------------------------------
// Installed before the first test runs and removed after the last. `classify.js` resolves
// `childProcess.spawn` at CALL time, so replacing the property here really does intercept the only
// path this module has to a process.
const realSpawn = childProcess.spawn;
const spawnGuard = { calls: [] };
childProcess.spawn = function guardedSpawn(...args) {
  spawnGuard.calls.push(args);
  throw new Error('fixture: no test in this file may spawn a real process');
};
after(() => { childProcess.spawn = realSpawn; });

// ---- invented constants -------------------------------------------------------------------------
const BIN = '/fixture/bin/fixture-classifier';       // invented; nothing at this path exists
const ALT_BIN = '/fixture/bin/fixture-alt-classifier';
const PROBE_VERSION = '0.0.0-fixture (Fixture Build)';
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

// ---- the transport stub -------------------------------------------------------------------------
// `--version` is a DIFFERENT kind of call from a classification: it reaches no model and costs
// nothing, and the stage fires exactly one per sweep before any cache decision. Keeping the two
// tallies apart is what lets a test say "no classification was launched" without having to pretend
// the free probe did not happen.
const isProbe = (req) => Array.isArray(req.args) && req.args[0] === '--version';

const runOk = (stdout) => ({ ok: true, code: 0, signal: null, stdout, stderr: '', error: null });
const runExit = (code) => ({ ok: false, code, signal: null, stdout: '', stderr: 'fixture stderr', error: `exit ${code}` });
const runSpawnError = (msg) => ({ ok: false, code: null, stdout: '', stderr: '', error: msg });

// `handler(req, n)` decides each CLASSIFICATION answer; n is the 1-based classification index.
// `opts.probe` overrides the probe answer.
function stubRun(handler, opts) {
  const o = opts || {};
  const calls = [];
  const classifyCalls = [];
  const probeCalls = [];
  const fn = async (req) => {
    calls.push(req);
    if (isProbe(req)) {
      probeCalls.push(req);
      return o.probe !== undefined ? o.probe : runOk(PROBE_VERSION);
    }
    classifyCalls.push(req);
    return handler(req, classifyCalls.length);
  };
  fn.calls = calls;
  fn.classifyCalls = classifyCalls;
  fn.probeCalls = probeCalls;
  return fn;
}

// `--output-format json` emits a JSON ARRAY of CLI events ending in a `type:"result"` object that
// carries the model's answer as a STRING in `.result`.
function cliEvents(resultText, over) {
  return JSON.stringify([
    { type: 'system', subtype: 'init', session_id: 'fixture-cli-session', tools: [] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: resultText }] } },
    Object.assign({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 11, num_turns: 1, result: resultText, session_id: 'fixture-cli-session',
    }, over || {}),
  ]);
}
const verdictOut = (verdict, reason) => runOk(cliEvents(JSON.stringify({ verdict, reason })));
const alwaysOk = (verdict, reason) =>
  stubRun(async () => verdictOut(verdict || 'needs-decision', reason || 'asked a direct question'));

// The text a classification was asked about: the trailing positional, by construction (§5.2.2).
const askedAbout = (req) => req.args[req.args.length - 1];

function baseDeps(over) {
  return Object.assign({
    config: normalizeConfig({ classifierBin: BIN }).config,
    env: { HOME: '/fixture/home' },
    now: () => NOW,
    network: true,
    // Injected so the two dependency branches are provable without touching a real filesystem.
    isExecutable: () => true,
  }, over || {});
}

const readCache = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
};
const writeCache = (p, obj) => { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); return p; };

const entry = (verdict, at, reason) => ({ verdict, reason: reason || 'fixture reason', model: DEFAULT_MODEL, at });

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

// A gate per CLASSIFICATION, so a test decides exactly when (and whether) each attempt settles. The
// probe still answers immediately: gating it would make every deadline fixture expire before the
// pool ever started, which would prove nothing about the pool.
function gatedRun(opts) {
  const o = opts || {};
  const calls = [];
  const classifyCalls = [];
  const probeCalls = [];
  const gates = [];
  const fn = async (req) => {
    calls.push(req);
    if (isProbe(req)) {
      probeCalls.push(req);
      return o.probe !== undefined ? o.probe : runOk(PROBE_VERSION);
    }
    classifyCalls.push(req);
    let res;
    const p = new Promise((r) => { res = r; });
    gates.push({ p, res });
    return p;
  };
  fn.calls = calls;
  fn.classifyCalls = classifyCalls;
  fn.probeCalls = probeCalls;
  fn.gates = gates;
  fn.settle = (i, value) => gates[i].res(value);
  return fn;
}

// Captures everything a call could possibly print. The probe line proves the capture is live, so an
// "it is absent" assertion cannot pass by capturing nothing at all.
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

// A fake child process for the DoD test's direct exercise of `defaultRun`. It is an EventEmitter
// shaped exactly like the part of a real child `defaultRun` touches, and it starts nothing.
function fakeChild(o) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  setImmediate(() => {
    // A string is one chunk; an array is several, which is the only way to observe the output cap —
    // the cap is checked BEFORE appending, so a single oversized chunk is always kept whole.
    for (const chunk of [].concat(o.stdout || [])) c.stdout.emit('data', chunk);
    if (o.stderr) c.stderr.emit('data', o.stderr);
    if (o.emitError) { c.emit('error', new Error(o.emitError)); return; }
    c.emit('close', o.code === undefined ? 0 : o.code, o.signal || null);
  });
  return c;
}

// ================================================================================================
// AC1 — the invocation, verbatim, and what must never reach a log line
//
// The credential half of this AC has no counterpart under this transport: there IS no credential —
// the CLI uses whatever it is already logged in with, which is why `--bare` is disqualified (it
// would force ANTHROPIC_API_KEY back into existence). What DID survive the move is the property the
// credential clause was protecting: the one sensitive thing this stage handles must not reach a log
// line. That is now the session's own transcript text, which travels as an argv element.
// ================================================================================================
test('AC1 - the invocation is exactly the §5.2.2 argv and the classified text reaches no log line', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const run = alwaysOk('needs-decision', 'it asked which migration order to use');

  const sink = [];
  const restore = captureOutput(sink);
  let r = null;
  let stageErr = null;
  try {
    console.log('capture-probe-line');                       // proves the capture is live
    r = await classify({ text: QUESTION }, { run, bin: BIN });
    // The full stage too: there the settings travel further (config -> resolveClassifier -> argv).
    await classifyBlocked([blocked(dir)], baseDeps({ run, cachePath: path.join(dir, 'intent-cache.json') }));
  } catch (e) { stageErr = e; } finally { restore(); }
  assert.equal(stageErr, null);

  const captured = sink.join('\n');
  assert.ok(captured.includes('capture-probe-line'), 'the log capture must actually capture');
  assert.ok(!captured.includes(QUESTION), 'the classified transcript text must never reach a log line');
  assert.ok(!captured.includes(BIN), 'nor the resolved binary path');

  assert.deepEqual(r, { verdict: 'needs-decision', reason: 'it asked which migration order to use' });

  // The argv, spelled out literally rather than rebuilt from `classifyArgv` — an expectation built
  // by the code under test cannot catch that code changing.
  const req = run.classifyCalls[0];
  assert.equal(req.bin, BIN);
  assert.deepEqual(req.args, [
    '-p', '--output-format', 'json',
    '--model', 'claude-sonnet-5',
    '--effort', 'low',
    '--strict-mcp-config', '--no-session-persistence',
    '--allowed-tools', '',
    '--system-prompt', CLASSIFY_PROMPT,
    QUESTION,
  ]);
  assert.equal(req.timeoutMs, ATTEMPT_TIMEOUT_MS);
  assert.deepEqual(Object.keys(req).sort(), ['args', 'bin', 'signal', 'timeoutMs']);

  // The two adjacency rules that make the argv SAFE, asserted as rules rather than as this one
  // literal: `--allowed-tools ""` is fixed, sits immediately before `--system-prompt`, and every
  // operator-supplied flag lands before it. `--allowed-tools` is variadic, so a configured flag
  // after it would be read as another tool name — and the trailing positional would be too.
  const tuned = classifyArgv({ model: 'fixture-model', effort: 'max', flags: ['--fixture-a', '--fixture-b'] }, 'FIXTURE TEXT');
  const at = tuned.indexOf('--allowed-tools');
  assert.equal(tuned[at + 1], '', 'the allow-list is empty and FIXED');
  assert.equal(tuned[at + 2], '--system-prompt', 'and nothing may be inserted between the two');
  assert.ok(tuned.indexOf('--fixture-a') < at && tuned.indexOf('--fixture-b') < at, 'configured flags land BEFORE the variadic flag');
  assert.equal(tuned[tuned.length - 1], 'FIXTURE TEXT', 'the classified text is the trailing positional');
  assert.equal(tuned.indexOf('--bare'), -1, '--bare would reintroduce the API key this transport removed');

  // The text is bounded a second time here, because exceeding ARG_MAX is a spawn failure — E2BIG —
  // that would read as `classifier unreachable` forever for one unlucky session. The TAIL is what
  // survives: §5.2.1's whole premise is that the operative sentence is at the END of the turn, and
  // a message long enough to trim is one whose question is certainly not in its first 32 KB. The
  // bound is applied on the way INTO the argv, so it is observed through a classification.
  const long = 'FIXTURE-HEAD-MARKER ' + 'a'.repeat(MAX_PROMPT_BYTES + 8000) + ' FIXTURE-TAIL-MARKER';
  const trimRun = alwaysOk();
  await classify({ text: long }, { run: trimRun, bin: BIN });
  const sent = askedAbout(trimRun.classifyCalls[0]);
  assert.ok(Buffer.byteLength(sent, 'utf8') <= MAX_PROMPT_BYTES + 256, 'the argv element is bounded');
  assert.ok(sent.endsWith('FIXTURE-TAIL-MARKER'), 'the TAIL survives a trim');
  assert.ok(!sent.includes('FIXTURE-HEAD-MARKER'), 'the head is what is dropped');
  assert.ok(/trimmed/.test(sent), 'and the trim is disclosed in the text itself');

  // §5.2.3's load-bearing clauses — two carried over, and one this transport ADDED: over HTTP the
  // answer shape was enforced on the wire by a json_schema, so the prompt could stay silent about
  // it. A CLI in print mode returns whatever the model wrote, so the shape must be asked for.
  assert.ok(/A question mark does not make/.test(CLASSIFY_PROMPT), 'the question-mark caveat is in the prompt');
  assert.ok(/torn between needs-decision and offer-more, answer needs-decision/.test(CLASSIFY_PROMPT), 'the tie-break is in the prompt');
  assert.ok(/one JSON object and nothing else/.test(CLASSIFY_PROMPT), 'the output contract is in the prompt');
  assert.ok(/no code fence/.test(CLASSIFY_PROMPT), 'including the fence it must not write');
});

// ================================================================================================
// AC1b — the SECOND provider's invocation
//
// AC1 is one AC about one thing — what this classifier sends — and it now has two answers, because
// a provider owns exactly three decisions: how to invoke, how to read the answer back, and where
// its binary lives unconfigured. This is the first of those for codex. The stage around it (cache,
// cooldown, deadline, precedence, single-flight) is transport-agnostic and is NOT re-tested here;
// that is the whole claim of the provider split.
// ================================================================================================
test('AC1b - the codex provider invokes exec with a schema file and one fused positional', async () => {
  _resetClassifyState();
  const dir = tmpdir();

  const run = alwaysOk('needs-decision', 'a direct question');
  const s = blocked(dir, { sessionId: 'fixture-inbox-codex-1' });
  await classifyBlocked([s], baseDeps({
    run, cachePath: path.join(dir, 'intent-cache.json'),
    config: normalizeConfig({ classifierProvider: 'codex', classifierBin: BIN }).config,
  }));

  const args = run.classifyCalls[0].args;
  assert.deepEqual(args, [
    'exec', '--json',
    '-c', 'model_reasoning_effort="low"',
    '--output-schema', VERDICT_SCHEMA_PATH,
    '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only',
    CLASSIFY_PROMPT + '\n\n' + QUESTION,
  ]);

  // codex has no `--system-prompt`, so instruction and text travel as ONE positional. The separator
  // is a blank line, which is what the prompt's own last line assumes when it says "the text below".
  assert.equal(args.length, args.lastIndexOf(CLASSIFY_PROMPT + '\n\n' + QUESTION) + 1, 'the fused prompt is the trailing positional');
  assert.equal(args.indexOf('-m'), -1, 'a null model passes no model flag at all, letting the CLI choose');
  assert.equal(args.indexOf('--bare'), -1);
  assert.ok(args.indexOf('--ignore-user-config') !== -1,
    'the cost lever that does NOT force an API key — unlike claude --bare, codex auth still comes from its own home');

  // The schema is what makes codex the better host for this job: the answer SHAPE is enforced by the
  // CLI rather than asked for by the prompt. It is a STATIC file shipped beside the module — never a
  // per-call temp file, because a temp file on the hot path of a 60-second sweep is a leak waiting
  // to happen.
  assert.equal(path.basename(VERDICT_SCHEMA_PATH), 'verdict.schema.json');
  assert.ok(fs.existsSync(VERDICT_SCHEMA_PATH), 'the schema really is on disk beside the module');
  const schema = JSON.parse(fs.readFileSync(VERDICT_SCHEMA_PATH, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['verdict', 'reason']);
  assert.deepEqual(schema.properties.verdict.enum, ['needs-decision', 'offer-more', 'status-only']);
  assert.equal(schema.properties.verdict.enum.indexOf('unknown'), -1, 'unknown is never a model answer');

  // A second classification names the SAME path — the file is static, not minted per call.
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-codex-2' });
  await classifyBlocked([s2], baseDeps({
    run, cachePath: path.join(dir, 'intent-cache.json'),
    config: normalizeConfig({ classifierProvider: 'codex', classifierBin: BIN }).config,
  }));
  assert.equal(run.classifyCalls[1].args[5], VERDICT_SCHEMA_PATH, 'the same static schema path, never a fresh temp file');

  // A pinned model and a configured effort both reach the command line in codex's own spelling.
  const pinned = classifyArgv({ provider: 'codex', model: 'fixture-codex-model', effort: 'high', flags: ['--fixture-flag'] }, 'FIXTURE TEXT');
  assert.equal(pinned[2], '-m');
  assert.equal(pinned[3], 'fixture-codex-model');
  assert.ok(pinned.includes('model_reasoning_effort="high"'), 'effort travels as a -c override, not a flag');
  assert.equal(pinned[pinned.length - 1], CLASSIFY_PROMPT + '\n\nFIXTURE TEXT', 'still one fused positional');
  assert.ok(pinned.indexOf('--fixture-flag') < pinned.length - 1, 'configured flags land before the positional');
});

// ================================================================================================
// AC2 — the success predicate in order, and the exhaustive failure map
// ================================================================================================
test('AC2 - the success predicate runs in order and every failure maps to its stated unknown', async () => {
  _resetClassifyState();

  // A real CLI envelope: several events, the answer in the LAST `type:"result"`.
  const okRun = stubRun(async () => verdictOut('offer-more', 'work is complete, the ask is optional'));
  assert.deepEqual(await classify({ text: OFFER }, { run: okRun, bin: BIN }),
    { verdict: 'offer-more', reason: 'work is complete, the ask is optional' });
  assert.equal(okRun.classifyCalls.length, 1, 'a success costs exactly one attempt');

  // Step 2's degenerate case: a BARE result object, which the CLI help calls "json (single result)".
  const bare = stubRun(async () => runOk(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify({ verdict: 'status-only', reason: 'a completion report' }),
  })));
  assert.deepEqual(await classify({ text: OFFER }, { run: bare, bin: BIN }),
    { verdict: 'status-only', reason: 'a completion report' });

  // The LAST result element wins: a run that emitted two has answered twice.
  const twice = stubRun(async () => runOk(JSON.stringify([
    { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ verdict: 'status-only', reason: 'the first answer' }) },
    { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ verdict: 'needs-decision', reason: 'the answer it finished on' }) },
  ])));
  assert.deepEqual(await classify({ text: QUESTION }, { run: twice, bin: BIN }),
    { verdict: 'needs-decision', reason: 'the answer it finished on' });

  // A fence around the answer is the one deviation common enough to absorb rather than fail on.
  const fenced = stubRun(async () => runOk(cliEvents('```json\n' + JSON.stringify({ verdict: 'needs-decision', reason: 'asked a direct question' }) + '\n```')));
  assert.deepEqual(await classify({ text: QUESTION }, { run: fenced, bin: BIN }),
    { verdict: 'needs-decision', reason: 'asked a direct question' });

  // A nonzero exit twice -> exactly two attempts, then unreachable.
  const dead = stubRun(async () => runExit(1));
  assert.deepEqual(await classify({ text: QUESTION }, { run: dead, bin: BIN }), { verdict: 'unknown', reason: 'classifier unreachable' });
  assert.equal(dead.classifyCalls.length, 2, 'an operation makes AT MOST two attempts');

  // A spawn failure is the same class as a nonzero exit.
  const nospawn = stubRun(async () => runSpawnError('spawn ENOENT'));
  assert.deepEqual(await classify({ text: QUESTION }, { run: nospawn, bin: BIN }), { verdict: 'unknown', reason: 'classifier unreachable' });
  assert.equal(nospawn.classifyCalls.length, 2);

  // A kill — the per-attempt timeout's own shape — likewise.
  const killed = stubRun(async () => ({ ok: false, code: null, signal: 'SIGTERM', stdout: '', stderr: '', error: 'killed by SIGTERM' }));
  assert.deepEqual(await classify({ text: QUESTION }, { run: killed, bin: BIN }), { verdict: 'unknown', reason: 'classifier unreachable' });
  assert.equal(killed.classifyCalls.length, 2);

  // A transport that THROWS is absorbed, not propagated — `classify` treats it as a failed attempt.
  const thrown = stubRun(async () => { throw new Error('fixture transport exploded'); });
  assert.deepEqual(await classify({ text: QUESTION }, { run: thrown, bin: BIN }), { verdict: 'unknown', reason: 'classifier unreachable' });
  assert.equal(thrown.classifyCalls.length, 2);

  // The retry is useful, not ceremonial: a failed launch then a clean one answers.
  const flaky = stubRun(async (_req, n) => (n === 1 ? runExit(1) : verdictOut('status-only', 'a completion report')));
  assert.deepEqual(await classify({ text: OFFER }, { run: flaky, bin: BIN }), { verdict: 'status-only', reason: 'a completion report' });
  assert.equal(flaky.classifyCalls.length, 2);

  // Everything the envelope can say other than a clean success is `unparseable`, and every one of
  // them is an ANSWER — never retried. `refused` and `truncated` were distinguishable over HTTP
  // through `stop_reason` and are NOT distinguishable here; inventing the distinction back would be
  // a reason string that lies, so the two cases live on as their honest collapse.
  const answer = (o) => JSON.stringify({ verdict: 'needs-decision', reason: 'r' });
  const cases = [
    ['is_error true', runOk(cliEvents(answer(), { is_error: true }))],
    ['subtype not success (the CLI error envelope)', runOk(cliEvents('', { subtype: 'error_during_execution', result: '' }))],
    ['subtype error_max_turns', runOk(cliEvents('', { subtype: 'error_max_turns', result: '' }))],
    ['no result element at all', runOk(JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: {} }]))],
    ['empty stdout', runOk('')],
    ['stdout that is not JSON', runOk('claude: command failed\n')],
    ['a refusal, which this wire cannot distinguish', runOk(cliEvents('I will not classify that.'))],
    ['a truncated answer, likewise', runOk(cliEvents('{"verdict":"needs-'))],
    ['out-of-enum verdict', runOk(cliEvents(JSON.stringify({ verdict: 'unknown', reason: 'the model tried to answer unknown' })))],
    ['another out-of-enum verdict', runOk(cliEvents(JSON.stringify({ verdict: 'maybe', reason: 'r' })))],
    ['missing reason', runOk(cliEvents(JSON.stringify({ verdict: 'offer-more' })))],
    ['non-string reason', runOk(cliEvents(JSON.stringify({ verdict: 'offer-more', reason: 7 })))],
    ['a JSON array where an object was asked for', runOk(cliEvents('["needs-decision"]'))],
    ['a JSON null', runOk(cliEvents('null'))],
    ['prose around the JSON', runOk(cliEvents('Sure! Here you go: {"verdict":"offer-more","reason":"r"}'))],
  ];
  for (const [name, res] of cases) {
    const h = stubRun(async () => res);
    assert.deepEqual(await classify({ text: QUESTION }, { run: h, bin: BIN }), { verdict: 'unknown', reason: 'unparseable' }, name);
    assert.equal(h.classifyCalls.length, 1, `${name} is an answer, never retried`);
  }

  // The predicate is also reachable directly, and an empty envelope must never throw.
  assert.deepEqual(readVerdict(undefined), { verdict: 'unknown', reason: 'unparseable' });
  assert.deepEqual(readVerdict(null), { verdict: 'unknown', reason: 'unparseable' });

  // The two input-side rows of the failure table, at the classify boundary. `no credential` became
  // `classifier binary missing`: an unresolvable binary is this transport's version of "there is
  // nothing to ask with", and it is refused before any process is launched.
  const never = stubRun(async () => { throw new Error('must not be reached'); });
  assert.deepEqual(await classify({ text: '' }, { run: never, bin: BIN }), { verdict: 'unknown', reason: 'no transcript text' });
  assert.deepEqual(await classify({ text: '   ' }, { run: never, bin: BIN }), { verdict: 'unknown', reason: 'no transcript text' });
  assert.deepEqual(await classify({ text: QUESTION }, { run: never, bin: null }), { verdict: 'unknown', reason: 'classifier binary missing' });
  assert.deepEqual(await classify({ text: QUESTION }, { run: never, bin: '' }), { verdict: 'unknown', reason: 'classifier binary missing' });
  assert.equal(never.calls.length, 0, 'neither path may reach the transport');
});

// ================================================================================================
// AC2b — the SECOND provider's answer predicate
//
// The codex envelope is UNVERIFIED against a live run — its flags come from the CLI's own help and
// no classification has been made with it, because the operator is at the top of a weekly limit.
// That is an argument for MORE coverage here, not less: the parser is deliberately written to
// survive not knowing the event vocabulary, and this is what pins that survival down. Pinning an
// event name instead would fail silently on the next CLI upgrade, turning every session `unknown`
// with no signal that the parser — not the model — is what broke.
// ================================================================================================
test('AC2b - the codex parse is liberal in what it accepts and strict in what it returns', async () => {
  _resetClassifyState();
  const answer = JSON.stringify({ verdict: 'needs-decision', reason: 'asked a direct question' });
  const expected = { verdict: 'needs-decision', reason: 'asked a direct question' };
  const codexRun = (stdout) => stubRun(async () => runOk(stdout));
  const viaCodex = async (stdout) => classify({ text: QUESTION }, { run: codexRun(stdout), bin: BIN, provider: 'codex' });

  // "The answer IS the line" and "the answer is a string field on an event" — both, without the
  // parser needing to know which one this CLI version does.
  assert.deepEqual(await viaCodex(answer), expected);
  assert.deepEqual(await viaCodex(JSON.stringify({ type: 'item.completed', text: answer })), expected);
  assert.deepEqual(await viaCodex(JSON.stringify({ type: 'fixture.future.event.name', payload: answer })), expected);
  assert.deepEqual(await viaCodex('```json\n' + answer + '\n```'), expected, 'a fence is absorbed here too');

  // The LAST valid verdict wins, over a realistic JSONL stream with noise on both sides.
  const stream = [
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }),
    JSON.stringify({ type: 'item.started', text: 'Reading the transcript...' }),
    JSON.stringify({ type: 'item.completed', text: JSON.stringify({ verdict: 'status-only', reason: 'a first pass' }) }),
    '',
    JSON.stringify({ type: 'item.completed', text: answer }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }),
  ].join('\n');
  assert.deepEqual(await viaCodex(stream), expected, 'the last valid verdict is the one it finished on');

  // Strict in what it RETURNS: reasoning traces, tool chatter and prose cannot masquerade as an
  // answer, and `unknown` is not a verdict a model is allowed to hand back.
  const notAnswers = [
    ['empty stdout', ''],
    ['blank lines only', '\n\n   \n'],
    ['prose', 'I think this session is blocked.\nProbably needs-decision.'],
    ['reasoning chatter that mentions the enum', JSON.stringify({ type: 'item.started', text: 'weighing needs-decision against offer-more' })],
    ['a verdict with no reason', JSON.stringify({ verdict: 'needs-decision' })],
    ['a non-string reason', JSON.stringify({ verdict: 'needs-decision', reason: 7 })],
    ['an out-of-enum verdict', JSON.stringify({ verdict: 'maybe', reason: 'r' })],
    ['the model answering unknown', JSON.stringify({ verdict: 'unknown', reason: 'I cannot tell' })],
    ['an array', JSON.stringify(['needs-decision'])],
    ['a bare string', JSON.stringify('needs-decision')],
  ];
  for (const [name, stdout] of notAnswers) {
    assert.deepEqual(await viaCodex(stdout), { verdict: 'unknown', reason: 'unparseable' }, name);
  }

  // A truncated JSONL stream — the shape a killed process leaves behind — must not throw, and must
  // still surrender the last COMPLETE verdict rather than losing it to the broken final line.
  assert.deepEqual(await viaCodex(JSON.stringify({ type: 'item.completed', text: answer }) + '\n{"type":"turn.comp'), expected);

  // The shared strict predicate both providers return through, directly.
  assert.deepEqual(verdictOf({ verdict: 'offer-more', reason: 'r' }), { verdict: 'offer-more', reason: 'r' });
  assert.equal(verdictOf({ verdict: 'unknown', reason: 'r' }), null, 'unknown stays this module own word');
  assert.equal(verdictOf({ verdict: 'needs-decision' }), null);
  assert.equal(verdictOf(null), null);
  assert.equal(verdictOf(['needs-decision']), null);
  assert.equal(verdictOf('needs-decision'), null);

  // And `readVerdict` routes by provider: the SAME bytes read two ways. A claude envelope is not a
  // codex one, and a parser that answered for both would be reading neither.
  const claudeEnvelope = cliEvents(answer);
  assert.deepEqual(readVerdict(claudeEnvelope, 'claude'), expected);
  assert.deepEqual(readVerdict(answer, 'codex'), expected);
  assert.deepEqual(readVerdict(answer, 'claude'), { verdict: 'unknown', reason: 'unparseable' },
    'a bare answer is not a claude envelope');
  // An unrecognised provider id falls back to the default rather than throwing — a sweep that keeps
  // classifying beats one that dies on a typo.
  assert.deepEqual(readVerdict(claudeEnvelope, 'fixture-not-a-provider'), expected);
  assert.deepEqual(readVerdict(claudeEnvelope, undefined), expected);
});

// ================================================================================================
// AC3 — the pinned digest
// ================================================================================================
test('AC3 - CLASSIFIER_VERSION is sha256(provider + model + effort + prompt + transport), space-joined, first 12 hex', () => {
  assert.equal(classifierVersion('pr', 'm', 'e', 'p', { a: 1 }), 'b2f79b044d68');
  assert.equal(CLASSIFIER_VERSION, classifierVersion(DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_EFFORT, CLASSIFY_PROMPT, transportOf(DEFAULT_FLAGS)));
  assert.match(CLASSIFIER_VERSION, /^[0-9a-f]{12}$/);

  // The separator is ONE ASCII space and the recipe is order-sensitive.
  assert.notEqual(classifierVersion('pr', 'm', 'e', 'p', { a: 1 }), classifierVersion('pr', 'm ', 'e', 'p', { a: 1 }));
  assert.notEqual(classifierVersion('pr', 'm', 'e', 'p', { a: 1 }), classifierVersion('pr', 'e', 'm', 'p', { a: 1 }));

  // EVERY input that can change what a verdict MEANS is inside it. Provider, model, effort and
  // flags all come from config now, so a module-constant digest would let an operator retune the
  // classifier and keep serving 48 hours of verdicts the new one never produced.
  const T = transportOf(DEFAULT_FLAGS);
  const v = (over) => classifierVersion(
    (over && over.provider) || DEFAULT_PROVIDER,
    over && 'model' in over ? over.model : DEFAULT_MODEL,
    (over && over.effort) || DEFAULT_EFFORT,
    (over && over.prompt) || CLASSIFY_PROMPT,
    (over && over.transport) || T,
  );
  assert.notEqual(v(), v({ model: 'claude-opus-5' }), 'the model is in the digest');
  assert.notEqual(v(), v({ effort: 'max' }), 'the effort is in the digest');
  assert.notEqual(v(), v({ prompt: CLASSIFY_PROMPT + ' ' }), 'the prompt is in the digest');
  assert.notEqual(v(), v({ transport: transportOf(['--fixture-flag']) }), 'the flag set is in the digest');
  // THE PROVIDER, and it is not cosmetic: two CLIs asked the same question with the same prompt
  // still answer as different models behind different harnesses. Leaving it out would let a switch
  // from claude to codex silently inherit two days of the other one's verdicts.
  assert.notEqual(v(), v({ provider: 'codex' }), 'the provider is in the digest');
  assert.notEqual(
    resolveClassifier({ classifierProvider: 'claude' }, { HOME: '/fixture/home' }).version,
    resolveClassifier({ classifierProvider: 'codex' }, { HOME: '/fixture/home' }).version,
    'and two resolved providers never share a cache namespace',
  );

  // The transport descriptor names the invocation contract and copies the flags it was handed, so a
  // caller cannot retro-edit the thing a cached verdict was hashed under.
  assert.equal(transportOf(DEFAULT_FLAGS).shape, TRANSPORT_SHAPE);
  // The shape is a CONTRACT VERSION, not a command line — it went provider-neutral when the second
  // provider landed, and its trailing number is what an operator bumps to invalidate 48 hours of
  // cached verdicts after changing what an invocation or a parse rule MEANS.
  assert.match(TRANSPORT_SHAPE, /\/\d+$/, 'the transport shape carries a bumpable revision');
  const src = ['--x'];
  const t = transportOf(src);
  t.flags.push('--mutated');
  assert.deepEqual(src, ['--x'], 'transportOf copies the flag list');

  assert.equal(CLASSIFY_DEADLINE_MS, 20000);
  assert.equal(COOLDOWN_MS, 300000);
  assert.equal(POOL_SIZE, 4);
  // The per-attempt timeout is deliberately EQUAL to the stage deadline: were it shorter, ordinary
  // CLI slowness would report `classifier unreachable` and arm a 5-minute cooldown instead of
  // letting the stage deadline report `deadline` and simply retry next sweep.
  assert.equal(ATTEMPT_TIMEOUT_MS, CLASSIFY_DEADLINE_MS);
  assert.ok(PROBE_TIMEOUT_MS < CLASSIFY_DEADLINE_MS, 'the free probe is bounded well inside the stage');
});

// ================================================================================================
// AC4 — no valid timestamp
// ================================================================================================
test('AC4 - a transcript with no valid timestamp is unknown(no valid timestamp) and is never cached', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const run = alwaysOk();

  const rows = [
    blocked(dir, { ts: 'the day before yesterday' }),   // unparseable
    blocked(dir, { ts: null }),                          // absent
    blocked(dir, { ts: '   ' }),                         // blank
  ];
  await classifyBlocked(rows, baseDeps({ run, cachePath }));

  for (const s of rows) {
    assert.equal(s.lastAssistant.ts, null, 'the tail read still ran and reported an honest null');
    assert.equal(s.lastAssistant.text, QUESTION);
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'no valid timestamp', model: null, at: NOW_ISO, inferred: true });
  }
  assert.equal(run.classifyCalls.length, 0, 'a key without a timestamp is not a key; nothing is asked');
  assert.equal(readCache(cachePath), null, 'nothing is written at all');
});

// ================================================================================================
// AC5 — the cache key is (machine, sessionId, ts, CLASSIFIER_VERSION)
// ================================================================================================
test('AC5 - an unchanged ts and version is served from cache; a changed ts, model or effort is not', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const run = alwaysOk('needs-decision', 'a direct question');
  const deps = baseDeps({ run, cachePath });

  const s1 = blocked(dir, { sessionId: 'fixture-inbox-5' });
  await classifyBlocked([s1], deps);
  assert.equal(run.classifyCalls.length, 1);
  assert.equal(s1.intent.verdict, 'needs-decision');

  // Sweep two, same identity and same ts: the cache answers.
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-5' });
  await classifyBlocked([s2], deps);
  assert.equal(run.classifyCalls.length, 1, 'an unchanged ts and version costs no classification');
  assert.deepEqual(s2.intent, s1.intent);

  // A changed ts is a different key.
  const s3 = blocked(dir, { sessionId: 'fixture-inbox-5', ts: '2026-07-30T11:00:00.000Z' });
  await classifyBlocked([s3], deps);
  assert.equal(run.classifyCalls.length, 2, 'a new turn is a new classification');

  // A changed prompt, model, effort or flag set is a different key, via CLASSIFIER_VERSION.
  // Preloading a suppressing entry under an OLD version proves the version is inside the key: if it
  // were not, this entry would serve and no call would be made.
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const s4 = blocked(dir2, { sessionId: 'fixture-inbox-6' });
  const staleKey = intentCacheKey(MACHINE, 'fixture-inbox-6', TS, 'aaaaaaaaaaaa');
  writeCache(cache2, { [staleKey]: entry('offer-more', NOW_ISO, 'a verdict from a previous classifier') });
  const run2 = alwaysOk('needs-decision', 'a direct question');
  await classifyBlocked([s4], baseDeps({ run: run2, cachePath: cache2 }));
  assert.equal(run2.classifyCalls.length, 1, 'a verdict from a different classifier version never serves');
  assert.equal(s4.intent.verdict, 'needs-decision');
  const written = readCache(cache2);
  assert.ok(Object.prototype.hasOwnProperty.call(written, intentCacheKey(MACHINE, 'fixture-inbox-6', TS)), 'the live entry lands under the CURRENT version');

  // And the config-driven half of the same rule, which is what this transport ADDED: retuning the
  // classifier through config must invalidate the verdicts the old tuning produced. A sweep at
  // `--effort max` does not serve the entry the default `--effort low` sweep just wrote.
  _resetClassifyState();
  const retuned = alwaysOk('needs-decision', 'a direct question');
  const s5 = blocked(dir2, { sessionId: 'fixture-inbox-6' });
  await classifyBlocked([s5], baseDeps({
    run: retuned, cachePath: cache2,
    config: normalizeConfig({ classifierBin: BIN, classifierEffort: 'max' }).config,
  }));
  assert.equal(retuned.classifyCalls.length, 1, 'a retuned classifier does not serve the old tuning\'s verdicts');
  assert.equal(retuned.classifyCalls[0].args[retuned.classifyCalls[0].args.indexOf('--effort') + 1], 'max', 'and it really did run at the configured effort');
  assert.equal(Object.keys(readCache(cache2)).length, 3, 'three keys: the stale version, low effort, and max effort');
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
    const run = alwaysOk('needs-decision', 'a direct question');
    const s = blocked(dir, { sessionId: 'fixture-inbox-7' });
    await classifyBlocked([s], baseDeps({ run, cachePath, now: () => now }));
    assert.equal(run.classifyCalls.length, expectedCalls, name);
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
  const dead = stubRun(async () => runExit(1));
  const sDead = blocked(dir, { sessionId: 'fixture-inbox-8' });
  await classifyBlocked([sDead], baseDeps({ run: dead, cachePath }));
  assert.equal(sDead.intent.verdict, 'unknown');
  assert.equal(readCache(cachePath), null, 'an unknown writes no file at all');

  const garbled = stubRun(async () => runOk(cliEvents('not json at all')));
  const sBad = blocked(dir, { sessionId: 'fixture-inbox-9' });
  await classifyBlocked([sBad], baseDeps({ run: garbled, cachePath }));
  assert.equal(sBad.intent.reason, 'unparseable');
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
  await classifyBlocked([sNew], baseDeps({ run: live, cachePath }));

  const written = readCache(cachePath);
  assert.equal(Object.prototype.hasOwnProperty.call(written, oldKey), false, 'an entry past retention is dropped on write');
  assert.equal(Object.prototype.hasOwnProperty.call(written, freshKey), true, 'a fresh entry survives the same write');
  assert.deepEqual(written[intentCacheKey(MACHINE, 'fixture-inbox-10', TS)],
    { verdict: 'needs-decision', reason: 'a direct question', model: DEFAULT_MODEL, at: NOW_ISO });
  assert.equal(Object.keys(written).length, 2);
});

// ================================================================================================
// AC8 — single-flight within a stage, and one serialized write for the batch
// ================================================================================================
test('AC8 - two rows on one key cost one classification; two keys survive one serialized write', async (t) => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // Same machine, same sessionId, same ts -> the same key, resolved concurrently by the pool.
  const tp = transcript(dir, QUESTION);
  const a = blocked(dir, { sessionId: 'fixture-inbox-11', transcriptPath: tp });
  const b = blocked(dir, { sessionId: 'fixture-inbox-11', transcriptPath: tp });
  const run = alwaysOk('needs-decision', 'a direct question');
  await classifyBlocked([a, b], baseDeps({ run, cachePath }));
  assert.equal(run.classifyCalls.length, 1, 'single-flight collapses one key to one call');
  assert.equal(a.intent.verdict, 'needs-decision');
  assert.deepEqual(b.intent, a.intent, 'both receive the verdict');

  // Two different keys -> two classifications, ONE serialized write carrying both.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const spy = t.mock.method(store, 'updateJson');
  const c = blocked(dir2, { sessionId: 'fixture-inbox-12' });
  const d = blocked(dir2, { sessionId: 'fixture-inbox-13' });
  const run2 = alwaysOk('status-only', 'a completion report');
  await classifyBlocked([c, d], baseDeps({ run: run2, cachePath: cache2 }));

  assert.equal(run2.classifyCalls.length, 2);
  assert.equal(run2.probeCalls.length, 1, 'and ONE --version probe for the whole stage, not one per session');
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

  const run = alwaysOk('needs-decision', 'a direct question');
  const s = blocked(dir, { sessionId: 'fixture-inbox-14' });
  let threw = null;
  try { await classifyBlocked([s], baseDeps({ run, cachePath })); } catch (e) { threw = e; }

  assert.equal(threw, null, 'store.updateJson REJECTS a corrupt file; the stage must wrap that');
  assert.equal(s.intent.verdict, 'needs-decision', 'the sweep completed');
  const written = readCache(cachePath);
  assert.notEqual(written, null, 'the file parses again');
  assert.deepEqual(Object.keys(written), [intentCacheKey(MACHINE, 'fixture-inbox-14', TS)], '{} plus this sweep');
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
  const run = stubRun(async (req) =>
    (askedAbout(req) === QUESTION ? verdictOut('needs-decision', 'asked which order') : verdictOut('offer-more', 'offered optional work')));
  await classifyBlocked([a, b], baseDeps({ run, cachePath }));

  assert.equal(run.classifyCalls.length, 2, 'two distinct classifications occur');
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
  const run2 = alwaysOk('needs-decision', 'asked which order');
  await classifyBlocked([a2], baseDeps({ run: run2, cachePath: cache2 }));
  assert.equal(run2.classifyCalls.length, 1, 'one session\'s cached offer-more never serves the other');
  assert.equal(a2.intent.verdict, 'needs-decision', 'the genuine question is not suppressed');
});

// ================================================================================================
// AC11 — an unresolvable classifier binary bypasses the cache for publication
//
// This is where `no credential` went. The rule is unchanged in every respect that matters: a
// classifier that is not running must never keep serving the previous run's suppressing verdicts,
// because that would hide questions for 48 hours from a classifier nobody is watching. Only the
// dependency changed — from a key in the environment to a binary on disk — and the binary is
// unresolvable in TWO distinct ways, because they are two distinct operator repairs.
// ================================================================================================
test('AC11 - a missing or unusable binary: every blocked session is unknown, and the cache is untouched', async (t) => {
  const suppressing = () => ({
    [intentCacheKey(MACHINE, 'fixture-inbox-15', TS)]: entry('offer-more', NOW_ISO, 'optional further work'),
    [intentCacheKey(MACHINE, 'fixture-inbox-16', TS)]: entry('status-only', NOW_ISO, 'a completion report'),
  });

  // (a) NOT EXECUTABLE — the cheapest check, and the first thing the stage does. No process at all.
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  writeCache(cachePath, suppressing());
  const before = fs.readFileSync(cachePath);

  const readSpy = t.mock.method(store, 'readJson');
  const rows = [blocked(dir, { sessionId: 'fixture-inbox-15' }), blocked(dir, { sessionId: 'fixture-inbox-16' })];
  const never = stubRun(async () => { throw new Error('must not be reached'); });
  await classifyBlocked(rows, baseDeps({ run: never, cachePath, isExecutable: () => false }));

  for (const s of rows) {
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'classifier binary missing', model: null, at: NOW_ISO, inferred: true });
    assert.deepEqual(s.lastAssistant, { text: QUESTION, ts: TS }, 'the transcript read still runs');
  }
  assert.equal(never.calls.length, 0, 'not even the free --version probe is launched');
  assert.deepEqual(fs.readFileSync(cachePath), before, 'existing entries stay on disk, byte-identical');
  assert.equal(readSpy.mock.calls.filter((c) => c.arguments[0] === cachePath).length, 0,
    'the cache is not even READ, let alone used for publication');
  readSpy.mock.restore();

  // (b) EXECUTABLE BUT UNUSABLE — the probe runs, and its answer outranks the cache exactly as (a)
  // does. This is the branch that costs one free process launch to discover.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  writeCache(cache2, suppressing());
  const before2 = fs.readFileSync(cache2);

  const readSpy2 = t.mock.method(store, 'readJson');
  const rows2 = [blocked(dir2, { sessionId: 'fixture-inbox-15' }), blocked(dir2, { sessionId: 'fixture-inbox-16' })];
  const brokenProbe = stubRun(async () => { throw new Error('must not be reached'); }, { probe: runExit(127) });
  await classifyBlocked(rows2, baseDeps({ run: brokenProbe, cachePath: cache2 }));

  for (const s of rows2) {
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'classifier binary unusable', model: null, at: NOW_ISO, inferred: true });
    assert.deepEqual(s.lastAssistant, { text: QUESTION, ts: TS });
  }
  assert.equal(brokenProbe.probeCalls.length, 1, 'exactly one --version, for the whole stage');
  assert.deepEqual(brokenProbe.probeCalls[0].args, ['--version']);
  assert.equal(brokenProbe.probeCalls[0].timeoutMs, PROBE_TIMEOUT_MS);
  assert.equal(brokenProbe.classifyCalls.length, 0, 'and no classification is attempted');
  assert.deepEqual(fs.readFileSync(cache2), before2, 'the suppressing entries stay on disk, byte-identical');
  assert.equal(readSpy2.mock.calls.filter((c) => c.arguments[0] === cache2).length, 0, 'the cache is bypassed entirely');
  readSpy2.mock.restore();

  // (c) A PATH SHIM that exits 0 and prints nothing is unusable too — exiting cleanly is not the
  // same as being the binary we asked for.
  _resetClassifyState();
  const dir3 = tmpdir();
  const shim = stubRun(async () => { throw new Error('must not be reached'); }, { probe: runOk('   \n') });
  const s3 = blocked(dir3, { sessionId: 'fixture-inbox-15' });
  await classifyBlocked([s3], baseDeps({ run: shim, cachePath: path.join(dir3, 'intent-cache.json') }));
  assert.equal(s3.intent.reason, 'classifier binary unusable');

  // And the probe's own contract, directly. `stubRun` is deliberately NOT used here: it answers
  // `--version` itself, so it would report its own canned version rather than the case under test.
  assert.deepEqual(await probeBinary(BIN, { run: async () => runOk('') }), { ok: false, version: null }, 'a shim that exits 0 and prints nothing is not the binary we asked for');
  assert.deepEqual(await probeBinary(BIN, { run: async () => runOk('   \n') }), { ok: false, version: null });
  assert.deepEqual(await probeBinary(BIN, { run: async () => runExit(1) }), { ok: false, version: null });
  assert.deepEqual(await probeBinary(BIN, { run: async () => { throw new Error('fixture'); } }), { ok: false, version: null }, 'and a throwing transport never escapes');
  assert.deepEqual(await probeBinary(BIN, { run: async () => runOk(' 9.9.9-fixture \n') }), { ok: true, version: '9.9.9-fixture' });
});

// ================================================================================================
// AC12 — PRECEDENCE: an unresolvable binary outranks network === false
// ================================================================================================
test('AC12 - binary missing AND network false: the binary wins, zero processes, zero cache reads', async (t) => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  writeCache(cachePath, { [intentCacheKey(MACHINE, 'fixture-inbox-17', TS)]: entry('offer-more', NOW_ISO, 'optional further work') });

  const spy = t.mock.method(store, 'readJson');
  const run = stubRun(async () => { throw new Error('must not be reached'); });
  const s = blocked(dir, { sessionId: 'fixture-inbox-17' });
  await classifyBlocked([s], baseDeps({ run, cachePath, network: false, isExecutable: () => false }));

  assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'classifier binary missing', model: null, at: NOW_ISO, inferred: true });
  assert.notEqual(s.intent.reason, 'classifier unreachable', 'fetch:false does not get to answer first');
  assert.equal(run.calls.length, 0, 'zero processes launched');
  const cacheReads = spy.mock.calls.filter((call) => call.arguments[0] === cachePath);
  assert.equal(cacheReads.length, 0, 'the cache is not even READ, let alone used for publication');
});

// ================================================================================================
// AC13 — the binary outranks a failed transcript read
// ================================================================================================
test('AC13 - binary missing plus a missing transcript publishes the binary reason, never no transcript text', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  writeCache(cachePath, { [intentCacheKey(MACHINE, 'fixture-inbox-18', TS)]: entry('offer-more', NOW_ISO, 'optional further work') });

  const missing = path.join(dir, 'fixture-transcript-absent.jsonl');
  const run = stubRun(async () => { throw new Error('must not be reached'); });
  const s = blocked(dir, { sessionId: 'fixture-inbox-18', transcriptPath: missing });
  await classifyBlocked([s], baseDeps({ run, cachePath, isExecutable: () => false }));

  assert.equal(s.lastAssistant, null, 'lastAssistant publishes null, honestly');
  assert.equal(s.intent.reason, 'classifier binary missing');
  assert.notEqual(s.intent.reason, 'no transcript text');
  assert.equal(run.calls.length, 0);

  // The control that makes the precedence claim mean something: the SAME missing transcript with a
  // resolved binary does report `no transcript text`.
  _resetClassifyState();
  const ok = stubRun(async () => { throw new Error('must not be reached'); });
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-18', transcriptPath: missing });
  await classifyBlocked([s2], baseDeps({ run: ok, cachePath }));
  assert.equal(s2.lastAssistant, null);
  assert.equal(s2.intent.reason, 'no transcript text', 'that reason requires a resolved binary');
  assert.equal(ok.classifyCalls.length, 0, 'no text is nothing to ask about');
});

// ================================================================================================
// AC14 — the classifier block, raw config file to command line
//
// `classifierKeyRef` is gone with the credential it named. What replaced it is a four-key block that
// exists for a different reason and carries the same end-to-end obligation: what the file says is
// what runs. It matters MORE here than a key ref did, because these four are the cost levers — the
// sweep runs every 60 seconds, so an untuned classifier is a standing bill, and the whole point of
// putting the tuning in config is that it must not need a code change.
// ================================================================================================
test('AC14 - a raw config classifier block reaches the command line end to end; absent means the defaults', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // The normalizer's own contract first. Every classifier key defaults to null — "unconfigured",
  // which the resolver then reads as "take the PROVIDER's default". A literal default here would be
  // a second source of truth able to drift away from what the provider actually sends.
  assert.equal(DEFAULTS.classifierProvider, DEFAULT_PROVIDER);
  assert.equal(DEFAULTS.classifierBin, null);
  assert.equal(DEFAULTS.classifierModel, null);
  assert.equal(DEFAULTS.classifierEffort, 'low');
  assert.equal(DEFAULTS.classifierFlags, null);
  assert.equal(normalizeConfig({}).config.classifierBin, null);
  assert.equal(normalizeConfig({ classifierBin: '  /fixture/trimmed  ' }).config.classifierBin, '/fixture/trimmed');
  assert.equal(normalizeConfig({ classifierBin: '   ' }).config.classifierBin, null);
  assert.equal(normalizeConfig({ classifierBin: 42 }).config.classifierBin, null);
  // An explicit empty flag list is HONOURED — an operator who empties it means it, and silently
  // restoring the defaults would make the emptiest possible config the one that cannot be expressed.
  assert.deepEqual(normalizeConfig({ classifierFlags: [] }).config.classifierFlags, []);
  assert.deepEqual(resolveClassifier(normalizeConfig({ classifierFlags: [] }).config, { HOME: '/fixture/home' }).flags, []);
  assert.equal(normalizeConfig({ classifierFlags: 'not an array' }).config.classifierFlags, null);
  // An out-of-enum effort or provider is a typo, not a preference: it takes the default AND is named
  // in the loader's issues. Silently running at the wrong one is the quiet wrong answer this loader
  // exists to refuse.
  const badEffort = normalizeConfig({ classifierEffort: 'sideways' });
  assert.equal(badEffort.config.classifierEffort, 'low');
  assert.ok(badEffort.issues.some((i) => /classifierEffort/.test(i) && /sideways/.test(i)), 'and the loader says so');
  const badProvider = normalizeConfig({ classifierProvider: 'fixture-not-a-provider' });
  assert.equal(badProvider.config.classifierProvider, DEFAULT_PROVIDER);
  assert.ok(badProvider.issues.some((i) => /classifierProvider/.test(i) && /fixture-not-a-provider/.test(i)), 'and names the bad id');
  // The resolver is the second half of that defence: a bad id that reached it anyway still classifies
  // under the default rather than throwing. A sweep that keeps working beats a sweep that dies on a typo.
  assert.equal(resolveClassifier({ classifierProvider: 'fixture-not-a-provider' }, { HOME: '/fixture/home' }).provider, DEFAULT_PROVIDER);
  assert.equal(providerOf('fixture-not-a-provider'), PROVIDERS[DEFAULT_PROVIDER]);
  assert.deepEqual(PROVIDER_IDS, ['claude', 'codex']);

  // The three-step binary fall-through, which is the whole reason `classifierBin` may be null.
  assert.equal(resolveClassifier({ classifierBin: BIN, claudeBin: ALT_BIN }, {}).bin, BIN, 'classifierBin wins');
  assert.equal(resolveClassifier({ claudeBin: ALT_BIN }, {}).bin, ALT_BIN, 'then claudeBin, named once for both dispatcher and classifier');
  assert.equal(resolveClassifier({}, { HOME: '/fixture/home' }).bin, path.join('/fixture/home', '.local', 'bin', 'claude'), 'then the default install path');
  assert.equal(resolveClassifier(null, { HOME: '/fixture/home' }).bin, path.join('/fixture/home', '.local', 'bin', 'claude'), 'a missing config resolves too');
  // `claudeBin` is the claude provider's fall-through ONLY. Pointing codex at the configured claude
  // binary because they share a config key would spawn the WRONG CLI with the other one's argv — a
  // failure that reads as `classifier unreachable` forever while the named binary is installed and
  // healthy.
  assert.equal(resolveClassifier({ classifierProvider: 'codex', claudeBin: ALT_BIN }, { HOME: '/fixture/home' }).bin,
    path.join('/fixture/home', '.local', 'bin', 'codex'), 'codex never inherits claudeBin');
  assert.equal(resolveClassifier({ classifierProvider: 'codex', classifierBin: BIN }, {}).bin, BIN, 'but the explicit key still wins');

  // WHAT WE SEND AND WHAT WE RECORD ARE NOT THE SAME STRING. `model` is the argv value and may be
  // null ("omit the model flag, let the CLI choose"); `modelLabel` is what lands in the cache and is
  // always a non-empty string. Writing a null model on a SUCCESSFUL verdict would forge the marker
  // that state.schema.json reserves for unknowns, making a real answer indistinguishable from a
  // classifier that never answered.
  const claudeSettings = resolveClassifier({}, { HOME: '/fixture/home' });
  assert.equal(claudeSettings.model, CLAUDE.defaultModel);
  assert.equal(claudeSettings.modelLabel, CLAUDE.defaultModel, 'a pinned model labels itself');
  const codexSettings = resolveClassifier({ classifierProvider: 'codex' }, { HOME: '/fixture/home' });
  assert.equal(codexSettings.model, null, 'codex deliberately pins no model');
  assert.equal(codexSettings.modelLabel, 'codex:default');
  assert.ok(codexSettings.modelLabel, 'and the recorded label is never falsy');

  // A RAW config file on disk, through loadConfig, onto the command line.
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    configVersion: 1, repos: [],
    classifierBin: ALT_BIN,
    classifierModel: 'fixture-configured-model',
    classifierEffort: 'high',
    classifierFlags: ['--fixture-configured-flag'],
  }));
  const loaded = await loadConfig(cfgPath, NOW);
  assert.equal(loaded.config.classifierBin, ALT_BIN);

  const run = alwaysOk();
  const s = blocked(dir, { sessionId: 'fixture-inbox-19' });
  await classifyBlocked([s], {
    config: loaded.config, cachePath, now: () => NOW, run, network: true,
    env: { HOME: '/fixture/home' }, isExecutable: () => true,
  });
  assert.equal(run.classifyCalls.length, 1);
  const req = run.classifyCalls[0];
  assert.equal(req.bin, ALT_BIN, 'the NAMED binary is the one invoked');
  assert.equal(run.probeCalls[0].bin, ALT_BIN, 'and the one probed');
  assert.deepEqual(req.args, [
    '-p', '--output-format', 'json',
    '--model', 'fixture-configured-model',
    '--effort', 'high',
    '--fixture-configured-flag',
    '--allowed-tools', '',
    '--system-prompt', CLASSIFY_PROMPT,
    QUESTION,
  ], 'every configured value reaches the command line, and the fixed tail still follows them');

  // Absent -> the defaults, and the cache entry records the model that actually answered.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const cfg2 = path.join(dir2, 'config.json');
  fs.writeFileSync(cfg2, JSON.stringify({ configVersion: 1, repos: [], claudeBin: BIN }));
  const loaded2 = await loadConfig(cfg2, NOW);
  assert.equal(loaded2.config.classifierBin, null);

  const run2 = alwaysOk();
  const s2 = blocked(dir2, { sessionId: 'fixture-inbox-20' });
  await classifyBlocked([s2], {
    config: loaded2.config, cachePath: cache2, now: () => NOW, run: run2, network: true,
    env: { HOME: '/fixture/home' }, isExecutable: () => true,
  });
  assert.equal(run2.classifyCalls[0].bin, BIN, 'null classifierBin falls through to claudeBin');
  assert.equal(run2.classifyCalls[0].args[4], DEFAULT_MODEL);
  assert.equal(run2.classifyCalls[0].args[6], DEFAULT_EFFORT);
  assert.equal(readCache(cache2)[intentCacheKey(MACHINE, 'fixture-inbox-20', TS)].model, DEFAULT_MODEL);
});

// ================================================================================================
// AC15 — binary resolved, network === false
// ================================================================================================
test('AC15 - fetch:false serves a warm hit without classifying and starts NO cooldown on a miss', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const warmKey = intentCacheKey(MACHINE, 'fixture-inbox-21', TS);
  writeCache(cachePath, { [warmKey]: entry('offer-more', NOW_ISO, 'optional further work') });

  const run = stubRun(async () => { throw new Error('must not be reached'); });
  const warm = blocked(dir, { sessionId: 'fixture-inbox-21' });
  await classifyBlocked([warm], baseDeps({ run, cachePath, network: false }));
  assert.equal(warm.intent.verdict, 'offer-more', 'a warm hit is served');
  assert.equal(warm.intent.at, NOW_ISO);
  assert.equal(run.classifyCalls.length, 0, 'cache reads are disk, not network');
  assert.equal(run.probeCalls.length, 1, 'the only process launched is the free --version probe');

  // A miss on the same offline sweep.
  const miss = blocked(dir, { sessionId: 'fixture-inbox-22' });
  await classifyBlocked([miss], baseDeps({ run, cachePath, network: false }));
  assert.deepEqual(miss.intent, { verdict: 'unknown', reason: 'classifier unreachable', model: null, at: NOW_ISO, inferred: true });
  assert.equal(run.classifyCalls.length, 0);

  // NO cooldown was started: the very next network-enabled sweep asks immediately, well inside the
  // 5-minute window. "We did not ask" must not be penalised like "it did not answer".
  const live = alwaysOk('needs-decision', 'a direct question');
  const retry = blocked(dir, { sessionId: 'fixture-inbox-22' });
  await classifyBlocked([retry], baseDeps({ run: live, cachePath, now: () => NOW + 1000 }));
  assert.equal(live.classifyCalls.length, 1, 'a fetch:false miss starts no cooldown');
  assert.equal(retry.intent.verdict, 'needs-decision');
});

// ================================================================================================
// AC16 — the 5-minute negative cooldown boundary
// ================================================================================================
test('AC16 - a failed operation backs off for exactly 5 minutes, then retries once', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const run = stubRun(async () => runExit(2));
  let clock = NOW;
  const deps = baseDeps({ run, cachePath, now: () => clock });

  const s1 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s1], deps);
  assert.equal(run.classifyCalls.length, 2, 'sweep one: exactly one attempt-pair');
  assert.equal(s1.intent.reason, 'classifier unreachable');

  // Inside the window — the row still shows unknown, but nothing is asked.
  clock = NOW + COOLDOWN_MS - 1;
  const s2 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s2], deps);
  assert.equal(run.classifyCalls.length, 2, 'within 5 minutes: no classification attempt');
  assert.equal(s2.intent.reason, 'classifier unreachable', 'a cooldown is a back-off, never a suppression');

  // At the boundary — one fresh attempt-pair, and one only.
  clock = NOW + COOLDOWN_MS;
  const s3 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s3], deps);
  assert.equal(run.classifyCalls.length, 4, 'at the boundary: exactly one fresh attempt-pair');

  // ...which re-arms the cooldown rather than retrying every sweep.
  clock = NOW + COOLDOWN_MS + 1000;
  const s4 = blocked(dir, { sessionId: 'fixture-inbox-23' });
  await classifyBlocked([s4], deps);
  assert.equal(run.classifyCalls.length, 4, 'the failed retry re-arms the window');
  assert.equal(readCache(cachePath), null, 'no unknown was ever cached');

  // The probe is NOT memoised across sweeps: a binary that broke since the last sweep must be
  // reported broken on this one, and the cooldown is a per-key back-off, never a stage-wide one.
  assert.equal(run.probeCalls.length, 4, 'one free --version per sweep, cooled-down sweeps included');
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
    const run = gatedRun();                                      // classifications never settle
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(blocked(dir, { sessionId: `fixture-inbox-d${n}-${i}` }));

    const stage = classifyBlocked(rows, baseDeps({ run, cachePath }));
    const started = Math.min(CONCURRENCY, n);
    assert.ok(await until(() => run.classifyCalls.length === started), `n=${n}: the pool starts ${started}`);
    await turns(5);
    assert.equal(run.classifyCalls.length, started, `n=${n}: never more than ${CONCURRENCY} concurrent`);

    t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
    const out = await stage;
    assert.equal(out, rows, 'the stage returns the same array');

    for (const s of rows) {
      assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true }, `n=${n}`);
      assert.deepEqual(s.lastAssistant, { text: QUESTION, ts: TS }, `n=${n}: the transcript read still ran`);
    }
    // Queued tasks NEVER start.
    await turns(20);
    assert.equal(run.classifyCalls.length, started, `n=${n}: queued tasks are never started at the deadline`);
    // The stage's abort signal reaches every process it started — the probe included, because a
    // stage bound that does not cover every process it launched is not a bound. Under this
    // transport that signal is handed to `spawn`, so ending the generation ends the CHILDREN, not
    // merely our interest in their answers.
    for (const req of run.calls) assert.equal(req.signal.aborted, true, `n=${n}: the signal is delivered`);
    // Nothing cached, no file at all.
    assert.equal(readCache(cachePath), null, `n=${n}: a deadline caches nothing`);

    // And no cooldown: the very next sweep for the SAME key asks immediately.
    if (n === 1) {
      const live = alwaysOk('needs-decision', 'a direct question');
      const again = blocked(dir, { sessionId: 'fixture-inbox-d1-0' });
      await classifyBlocked([again], baseDeps({ run: live, cachePath }));
      assert.equal(live.classifyCalls.length, 1, 'deadline starts no cooldown');
      assert.equal(again.intent.verdict, 'needs-decision');
    }
  }

  // A pool slot freeing up AFTER the deadline must still start nothing. This is the ONLY shape that
  // tests the rule: with every attempt hung forever no worker ever loops, so the queue would sit
  // untouched by accident rather than by rule, and a missing guard would read as a pass.
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const run = gatedRun();
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(blocked(dir, { sessionId: `fixture-inbox-q${i}` }));

  const stage = classifyBlocked(rows, baseDeps({ run, cachePath }));
  assert.ok(await until(() => run.classifyCalls.length === CONCURRENCY));
  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stage;

  run.settle(0, verdictOut('needs-decision', 'an answer that arrived too late'));
  await turns(40);
  assert.equal(run.classifyCalls.length, CONCURRENCY, 'a freed slot after the deadline still starts no queued task');
  for (const s of rows) assert.equal(s.intent.reason, 'deadline');
  assert.equal(readCache(cachePath), null, 'and the late answer is not cached');
});

// ================================================================================================
// AC17b — the deadline also covers the PROBE
//
// New under this transport, and it belongs to the same rule: the probe is a child process too. A
// stage whose deadline armed only after the probe would hang for as long as a wedged `claude
// --version` did, and the collector awaits this stage.
// ================================================================================================
test('AC17b - a probe that never answers still resolves the stage at the deadline', async (t) => {
  _resetClassifyState();
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // A transport that hangs on EVERYTHING, `--version` included.
  const probeCalls = [];
  const run = async (req) => { probeCalls.push(req); return new Promise(() => {}); };

  const rows = [blocked(dir, { sessionId: 'fixture-inbox-probe-1' }), blocked(dir, { sessionId: 'fixture-inbox-probe-2' })];
  const stage = classifyBlocked(rows, baseDeps({ run, cachePath }));
  assert.ok(await until(() => probeCalls.length === 1), 'the probe is in flight');
  await turns(5);
  assert.equal(probeCalls.length, 1, 'and nothing else was launched behind it');

  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  const out = await stage;
  assert.equal(out, rows);
  for (const s of rows) {
    assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true });
    assert.deepEqual(s.lastAssistant, { text: QUESTION, ts: TS });
  }
  assert.equal(probeCalls[0].signal.aborted, true, 'and the wedged probe process is killed with the generation');
  assert.equal(readCache(cachePath), null);
});

// ================================================================================================
// AC18 — GENERATION GUARD
// ================================================================================================
test('AC18 - a verdict that lands after the deadline mutates nothing at all', async (t) => {
  _resetClassifyState();
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');

  // This transport IGNORES the abort signal entirely — the exact adversary §5.2.6 names, and one a
  // child process can genuinely be: a CLI that traps SIGTERM and keeps writing.
  const run = gatedRun();
  const s = blocked(dir, { sessionId: 'fixture-inbox-24' });
  const stage = classifyBlocked([s], baseDeps({ run, cachePath }));
  assert.ok(await until(() => run.classifyCalls.length === 1));

  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stage;
  assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true });

  // NOW it answers, perfectly well formed, well after the stage is over.
  run.settle(0, verdictOut('offer-more', 'a late suppressing verdict'));
  await turns(40);

  assert.deepEqual(s.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true },
    'the late result mutated no session');
  assert.equal(readCache(cachePath), null, 'the late result wrote no cache entry');

  // No cooldown either — a subsequent sweep asks immediately.
  const live = alwaysOk('needs-decision', 'a direct question');
  const again = blocked(dir, { sessionId: 'fixture-inbox-24' });
  await classifyBlocked([again], baseDeps({ run: live, cachePath }));
  assert.equal(live.classifyCalls.length, 1, 'the late result started no cooldown');
  assert.equal(again.intent.verdict, 'needs-decision', 'and the fresh verdict is the one that publishes');

  // ---- the SECOND shape of a late result, and the only one whose side effect outlives the stage.
  //
  // Above, the late answer is a VERDICT: its session write is refused, and its cache write lands in
  // a `writes` map that was already flushed — so both are unobservable by construction. A late
  // TRANSPORT FAILURE is different. It resolves to `classifier unreachable`, and that is the one
  // reason that arms a five-minute cooldown — process-lifetime state that outlives the generation
  // and would silently gag the NEXT sweep for this key. Without the generation guard, a stage that
  // already published `deadline` would still be punishing the key it gave up on.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const failLate = gatedRun();
  const s2 = blocked(dir2, { sessionId: 'fixture-inbox-24b' });
  const stage2 = classifyBlocked([s2], baseDeps({ run: failLate, cachePath: cache2 }));
  assert.ok(await until(() => failLate.classifyCalls.length === 1));
  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stage2;
  assert.equal(s2.intent.reason, 'deadline');

  // The attempt fails AFTER the stage is over. `classify` sees the aborted signal on its retry and
  // gives up with `classifier unreachable` — the exact input that arms a cooldown.
  failLate.settle(0, runExit(1));
  await turns(40);
  assert.equal(failLate.classifyCalls.length, 1, 'and it never launches a second process past the abort');

  const after = alwaysOk('needs-decision', 'a direct question');
  const retry = blocked(dir2, { sessionId: 'fixture-inbox-24b' });
  await classifyBlocked([retry], baseDeps({ run: after, cachePath: cache2, now: () => NOW + 1000 }));
  assert.equal(after.classifyCalls.length, 1, 'the late failure armed NO cooldown; the next sweep asks immediately');
  assert.equal(retry.intent.verdict, 'needs-decision');
});

// ================================================================================================
// AC19 — SINGLE-FLIGHT EVICTION ACROSS GENERATIONS
// ================================================================================================
test('AC19 - generation B never joins A stale work, and A late finally never evicts B live entry', async (t) => {
  _resetClassifyState();
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const run = gatedRun();                                         // abort-ignoring, fully gated

  // The one session identity both generations share. K is its cache key.
  const tpK = transcript(dir, QUESTION);
  const kRow = () => ({ key: { machine: MACHINE, sessionId: 'fixture-inbox-25' }, status: 'blocked', transcriptPath: tpK });
  const K = intentCacheKey(MACHINE, 'fixture-inbox-25', TS);

  // ---- generation A: starts, deadline-expires while its call for K is still pending.
  const aRow = kRow();
  const stageA = classifyBlocked([aRow], baseDeps({ run, cachePath }));
  assert.ok(await until(() => run.classifyCalls.length === 1), 'A calls once for K');
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
  const stageB = classifyBlocked([kA].concat(fillers, [kB]), baseDeps({ run, cachePath }));

  // Pool of 4 -> kA + fillers 0,1,2. Classifications 1..4 (index 1..4); filler 3 and kB are queued.
  assert.ok(await until(() => run.classifyCalls.length === 5), 'B starts four tasks: K and three fillers');
  await turns(5);
  assert.equal(run.classifyCalls.length, 5, 'B makes a FRESH call for K rather than joining A stale work');

  // A's stale promise settles NOW, with a well-formed verdict, while B's entry for K is live.
  run.settle(0, verdictOut('offer-more', 'A late suppressing verdict'));
  await turns(30);
  assert.equal(run.classifyCalls.length, 5, 'A late settle starts nothing');

  // Drain one filler so its worker picks up filler 3, then another so a worker reaches kB.
  run.settle(2, verdictOut('status-only', 'filler 0'));
  assert.ok(await until(() => run.classifyCalls.length === 6), 'the queued filler starts');
  run.settle(3, verdictOut('status-only', 'filler 1'));
  await turns(40);
  // THE ASSERTION THIS TEST EXISTS FOR: kB found B's entry for K still in the map and JOINED it. If
  // A's late `finally` had deleted it, kB would have opened a seventh call.
  assert.equal(run.classifyCalls.length, 6, 'A late finally did not remove B live in-flight entry for K');

  run.settle(1, verdictOut('needs-decision', 'B verdict for K'));
  run.settle(4, verdictOut('status-only', 'filler 2'));
  run.settle(5, verdictOut('status-only', 'filler 3'));
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

  const run = stubRun(async () => { throw new Error('must not be reached'); });
  const hit = blocked(dir, { sessionId: 'fixture-inbox-26' });
  await classifyBlocked([hit], baseDeps({ run, cachePath }));
  assert.equal(run.classifyCalls.length, 0);
  assert.deepEqual(hit.lastAssistant, { text: QUESTION, ts: TS }, 'the tail read runs on a HIT too');
  assert.deepEqual(hit.intent, { verdict: 'offer-more', reason: 'optional further work', model: DEFAULT_MODEL, at, inferred: true });

  // Every unknown path in one sweep: unparseable, unreachable, no text, no timestamp.
  _resetClassifyState();
  const dir2 = tmpdir();
  const cache2 = path.join(dir2, 'intent-cache.json');
  const rows = {
    unparseable: blocked(dir2, { sessionId: 'fixture-inbox-27', text: 'Unparseable probe. Which one?' }),
    unreachable: blocked(dir2, { sessionId: 'fixture-inbox-28', text: 'Unreachable probe. Which one?' }),
  };
  const noText = blocked(dir2, { sessionId: 'fixture-inbox-30', transcriptPath: path.join(dir2, 'absent.jsonl') });
  const noTs = blocked(dir2, { sessionId: 'fixture-inbox-31', ts: 'not a date' });
  const byText = new Map([
    ['Unparseable probe. Which one?', runOk(cliEvents('not json'))],
    ['Unreachable probe. Which one?', runExit(1)],
  ]);
  const run2 = stubRun(async (req) => byText.get(askedAbout(req)));
  const all = [rows.unparseable, rows.unreachable, noText, noTs];
  await classifyBlocked(all, baseDeps({ run: run2, cachePath: cache2 }));

  const expected = ['unparseable', 'classifier unreachable', 'no transcript text', 'no valid timestamp'];
  all.forEach((s, i) => {
    assert.equal(s.intent.verdict, 'unknown', expected[i]);
    assert.equal(s.intent.reason, expected[i]);
    assert.equal(s.intent.model, null, `${expected[i]}: model is null on every unknown path`);
    assert.equal(s.intent.at, NOW_ISO, `${expected[i]}: at is the sweep time`);
    assert.equal(s.intent.inferred, true, 'an inferred fact is always labelled');
  });
  assert.equal(readCache(cache2), null, 'not one unknown was cached');

  // The two dependency unknowns carry the same shape, on their own stages.
  _resetClassifyState();
  const dir3 = tmpdir();
  const gone = blocked(dir3, { sessionId: 'fixture-inbox-32b' });
  await classifyBlocked([gone], baseDeps({ run: alwaysOk(), cachePath: path.join(dir3, 'c.json'), isExecutable: () => false }));
  assert.deepEqual(gone.intent, { verdict: 'unknown', reason: 'classifier binary missing', model: null, at: NOW_ISO, inferred: true });

  _resetClassifyState();
  const broken = blocked(dir3, { sessionId: 'fixture-inbox-32c' });
  await classifyBlocked([broken], baseDeps({
    run: stubRun(async () => { throw new Error('must not be reached'); }, { probe: runOk('') }),
    cachePath: path.join(dir3, 'c.json'),
  }));
  assert.deepEqual(broken.intent, { verdict: 'unknown', reason: 'classifier binary unusable', model: null, at: NOW_ISO, inferred: true });
});

// ================================================================================================
// AC21 — vanished rows
// ================================================================================================
test('AC21 - vanished:true blocked rows gain lastAssistant and intent exactly like live ones', async () => {
  _resetClassifyState();
  const dir = tmpdir();
  const cachePath = path.join(dir, 'intent-cache.json');
  const run = alwaysOk('needs-decision', 'a direct question');

  const live = blocked(dir, { sessionId: 'fixture-inbox-32' });
  const gone = blocked(dir, { sessionId: 'fixture-inbox-33', vanished: true, surfaceReason: 'recorded-tab-gone' });
  const idle = blocked(dir, { sessionId: 'fixture-inbox-34', status: 'idle' });
  await classifyBlocked([live, gone, idle], baseDeps({ run, cachePath }));

  assert.equal(gone.vanished, true, 'the flag is untouched');
  assert.deepEqual(gone.lastAssistant, { text: QUESTION, ts: TS });
  assert.equal(gone.intent.verdict, 'needs-decision');
  assert.equal(gone.intent.inferred, true);
  assert.deepEqual(Object.keys(gone.intent).sort(), Object.keys(live.intent).sort(), 'identical shape to a live row');

  assert.equal(idle.intent, undefined, 'a non-blocked session is returned untouched');
  assert.equal(idle.lastAssistant, undefined);
  assert.equal(run.classifyCalls.length, 2, 'both blocked rows were classified, the idle one was not');
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
// CARRIED INTENT — a row does not always arrive blank, and last turn's verdict must never survive
//
// `mod-sessions`' events-outage branch carries the previous published rows forward wholesale, and
// `collector.js :: fragmentsFromState` replays `state.sessions` verbatim after a module throw.
// Published rows carry `intent`, because `derive` publishes the fragment array as `state.sessions`.
// So the stage is genuinely handed rows that already hold a verdict from a PRIOR turn.
//
// Every deadline fixture above builds a fresh row with no `intent`, which is exactly the blind spot
// this section exists to cover: with a carried verdict present, the deadline's final `if (!s.intent)`
// sweep finds it truthy and leaves it standing beside a `lastAssistant` that is already the NEW
// question. A carried `offer-more` then fails §5.4 rule 3 and the row is dropped — a question the
// operator asked for, silently suppressed. That is principle 2 inverted.
// ================================================================================================
test('a carried suppressing intent never survives the stage - deadline, live verdict, and binary missing', async (t) => {
  // 1 — THE SUPPRESSION CASE. Carried `offer-more`, a NEW question on disk, classification hangs
  //     past the deadline. The verdict must be `deadline`, never the carried one.
  t.mock.timers.enable({ apis: ['setTimeout'], now: NOW });
  _resetClassifyState();
  const dir = tmpdir();
  const run = gatedRun();                                     // classifications never settle
  const row = blocked(dir, { sessionId: 'fixture-inbox-carry-1', text: QUESTION });
  row.intent = { verdict: 'offer-more', reason: 'fixture prior turn', model: 'fixture-model', at: TS, inferred: true };

  const stage = classifyBlocked([row], baseDeps({ run, cachePath: path.join(dir, 'intent-cache.json') }));
  assert.ok(await until(() => run.classifyCalls.length === 1), 'the classification is in flight');
  t.mock.timers.tick(CLASSIFY_DEADLINE_MS);
  await stage;

  assert.deepEqual(row.intent, { verdict: 'unknown', reason: 'deadline', model: null, at: NOW_ISO, inferred: true },
    'the carried offer-more is gone; the deadline owns the verdict');
  assert.deepEqual(row.lastAssistant, { text: QUESTION, ts: TS }, 'and the NEW question is published beside it');
  t.mock.timers.reset();

  // 2 — the ordinary path still overwrites: a carried verdict loses to this sweep's live answer.
  _resetClassifyState();
  const dir2 = tmpdir();
  const live = alwaysOk('needs-decision', 'fixture live reason');
  const row2 = blocked(dir2, { sessionId: 'fixture-inbox-carry-2', text: QUESTION });
  row2.intent = { verdict: 'offer-more', reason: 'fixture prior turn', model: 'fixture-model', at: TS, inferred: true };
  await classifyBlocked([row2], baseDeps({ run: live, cachePath: path.join(dir2, 'intent-cache.json') }));
  assert.equal(row2.intent.verdict, 'needs-decision', 'this sweep answered, so this sweep wins');
  assert.equal(row2.intent.reason, 'fixture live reason');

  // 3 — and the binary-missing exit, which returns before the cache is even read, still clears it.
  //     Without the clear this path is safe by luck (it assigns unconditionally); asserting it
  //     keeps that luck from quietly becoming the only reason the case passes.
  _resetClassifyState();
  const dir3 = tmpdir();
  const row3 = blocked(dir3, { sessionId: 'fixture-inbox-carry-3', text: QUESTION });
  row3.intent = { verdict: 'status-only', reason: 'fixture prior turn', model: 'fixture-model', at: TS, inferred: true };
  await classifyBlocked([row3], baseDeps({
    run: stubRun(async () => { throw new Error('must not be reached'); }),
    cachePath: path.join(dir3, 'intent-cache.json'),
    isExecutable: () => false,
  }));
  assert.deepEqual(row3.intent, { verdict: 'unknown', reason: 'classifier binary missing', model: null, at: NOW_ISO, inferred: true });

  // 3b — and the binary-unusable exit, which is the other early return the same clear must cover.
  _resetClassifyState();
  const dir3b = tmpdir();
  const row3b = blocked(dir3b, { sessionId: 'fixture-inbox-carry-3b', text: QUESTION });
  row3b.intent = { verdict: 'status-only', reason: 'fixture prior turn', model: 'fixture-model', at: TS, inferred: true };
  await classifyBlocked([row3b], baseDeps({
    run: stubRun(async () => { throw new Error('must not be reached'); }, { probe: runExit(127) }),
    cachePath: path.join(dir3b, 'intent-cache.json'),
  }));
  assert.deepEqual(row3b.intent, { verdict: 'unknown', reason: 'classifier binary unusable', model: null, at: NOW_ISO, inferred: true });

  // 4 — a NON-blocked carried row is returned untouched (§5.2.6), so the clear must not reach it.
  _resetClassifyState();
  const dir4 = tmpdir();
  const idle = blocked(dir4, { sessionId: 'fixture-inbox-carry-4', status: 'idle' });
  const keep = { verdict: 'offer-more', reason: 'fixture prior turn', model: 'fixture-model', at: TS, inferred: true };
  idle.intent = keep;
  const alive = blocked(dir4, { sessionId: 'fixture-inbox-carry-5', text: QUESTION });
  await classifyBlocked([idle, alive], baseDeps({ run: alwaysOk('needs-decision'), cachePath: path.join(dir4, 'intent-cache.json') }));
  assert.deepEqual(idle.intent, keep, 'non-blocked sessions are returned untouched, carried intent included');
});

// ================================================================================================
// DoD — the suite starts no process, and the default transport is the ONLY thing that could
//
// This runs LAST on purpose. `spawnGuard` has been in place since module load, so its call count at
// this point is the measured answer to "did anything above start a process" — not an assertion
// about the tests, but a reading off the one seam every one of them would have had to pass through.
// ================================================================================================
test('DoD - no test in this file starts a process; defaultRun is the only path to one', async () => {
  _resetClassifyState();
  assert.deepEqual(spawnGuard.calls, [], 'no test in this file reached a real spawn');

  // `classify` reaches `child_process.spawn` ONLY through `defaultRun`, and only when `deps.run` is
  // absent. Proving that is the whole guarantee: every test above injects `deps.run`.
  const seen = [];
  childProcess.spawn = (bin, args, opts) => {
    seen.push({ bin, args, opts });
    return fakeChild({ code: 1, stderr: 'fixture: offline' });
  };
  try {
    const r = await classify({ text: QUESTION }, { bin: BIN });
    assert.deepEqual(r, { verdict: 'unknown', reason: 'classifier unreachable' });
    assert.equal(seen.length, 2, 'the default transport is the ONLY path to a process, and it retried once');
    assert.equal(seen[0].bin, BIN);
    assert.equal(seen[0].args[0], '-p');
    assert.equal(seen[0].args[seen[0].args.length - 1], QUESTION);
    // And it really is a child process, launched the way the deadline can reach: a signal it can
    // abort, a timeout it cannot outlive, SIGTERM so the CLI shuts its own children down, and no
    // stdin at all — a classifier that could read stdin could block forever waiting for it.
    assert.equal(seen[0].opts.killSignal, 'SIGTERM');
    assert.equal(seen[0].opts.timeout, ATTEMPT_TIMEOUT_MS);
    assert.deepEqual(seen[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok('signal' in seen[0].opts, 'the abort signal is handed to spawn, so ending the stage ends the child');
  } finally {
    childProcess.spawn = function guardedSpawn(...args) {
      spawnGuard.calls.push(args);
      throw new Error('fixture: no test in this file may spawn a real process');
    };
  }

  // `defaultRun`'s own envelope, through its injectable `req.spawn` seam — still no real process.
  // It NEVER throws: a dead classifier is a fact to report, not an exception that ends a sweep.
  const runWith = (child, over) => defaultRun(Object.assign({
    bin: BIN, args: ['--version'], timeoutMs: PROBE_TIMEOUT_MS,
    spawn: () => child,
  }, over || {}));

  assert.deepEqual(await runWith(fakeChild({ code: 0, stdout: 'fixture-out', stderr: 'fixture-err' })),
    { ok: true, code: 0, signal: null, stdout: 'fixture-out', stderr: 'fixture-err', error: null });
  const bad = await runWith(fakeChild({ code: 3 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'exit 3');
  const killed = await runWith(fakeChild({ code: null, signal: 'SIGTERM' }));
  assert.equal(killed.ok, false);
  assert.equal(killed.signal, 'SIGTERM');
  assert.equal(killed.error, 'killed by SIGTERM');
  const errored = await runWith(fakeChild({ emitError: 'spawn ENOENT' }));
  assert.equal(errored.ok, false);
  assert.equal(errored.code, null);
  assert.equal(errored.error, 'spawn ENOENT');
  // A spawn that throws SYNCHRONOUSLY — the shape a bad binary path takes on some platforms.
  const threw = await defaultRun({
    bin: BIN, args: ['--version'], timeoutMs: PROBE_TIMEOUT_MS,
    spawn: () => { throw new Error('fixture EACCES'); },
  });
  assert.deepEqual(threw, { ok: false, code: null, stdout: '', stderr: '', error: 'fixture EACCES' });

  // Output is capped: an answer this long is not a sane one, and unbounded accumulation here is a
  // memory leak wearing a buffer. Past the cap the TAIL is dropped — the JSON we need is at the
  // start of a sane answer.
  const flood = await runWith(fakeChild({ code: 0, stdout: ['x'.repeat(MAX_PROMPT_BYTES), 'FIXTURE-DROPPED-TAIL'] }));
  assert.equal(flood.stdout.length, MAX_PROMPT_BYTES, 'accumulation stops at the cap');
  assert.ok(!flood.stdout.includes('FIXTURE-DROPPED-TAIL'), 'and it is the tail that is dropped');
  // Under the cap, every chunk survives — the cap must not truncate an ordinary answer.
  const small = await runWith(fakeChild({ code: 0, stdout: ['{"a":', '1}'] }));
  assert.equal(small.stdout, '{"a":1}');

  assert.deepEqual(spawnGuard.calls, [], 'and the guard is still untouched on the way out');
});
