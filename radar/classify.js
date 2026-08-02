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
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
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
// THE TRANSPORT IS A LOCAL AGENT CLI IN PRINT MODE, NOT AN HTTP API — and WHICH CLI is an operator
// choice. This project does not call a model API directly and holds no API key for one;
// `radar/handoff.js` already establishes the house pattern — resolve a binary from config, check it
// is executable, probe `--version`, and fail with a distinct code for each of those two ways of
// being unresolvable. This module mirrors that resolution and adds print mode, for either of two
// providers (see PROVIDERS for the argv each one builds and the envelope each one returns):
//
//   claude -p --output-format json --model <m> --effort <e> <flags…>
//          --allowed-tools "" --system-prompt <CLASSIFY_PROMPT> <TEXT>
//   codex  exec --json -c model_reasoning_effort="<e>" --output-schema <schema> <flags…>
//          <CLASSIFY_PROMPT + TEXT>
//
// so the only credential involved is whatever the chosen CLI is already logged in with. That is also
// why claude's `--bare` is disqualified despite looking like the obvious cost fix: `claude --help`
// states that under `--bare`, "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth
// and keychain are never read)" — it would reintroduce the exact API key this transport removes.
// codex's equivalent lever, `--ignore-user-config`, has no such catch: its help states auth still
// comes from CODEX_HOME. That, plus `--output-schema` enforcing the answer shape at the CLI rather
// than asking the prompt nicely for it, is why codex is the better host for this job — claude is
// merely the DEFAULT, for continuity with handoff.js.
//
// COST IS A FIRST-CLASS CONSTRAINT HERE, NOT AN AFTERTHOUGHT. `collector.js` sweeps every 60
// seconds over every blocked session, so an untuned invocation is a standing bill: a single probe
// with default settings loaded the whole plugin/skill/MCP environment and cost real money in
// cache-creation tokens alone. Three things hold that down, and all three are deliberate:
//   1. the intent cache (§5.2.4) — one paid verdict per session-turn, good for 48 h;
//   2. the default flags — per provider, and CONFIG-DRIVEN so the set can be retuned without a code
//      change (radar/config.js names the further levers);
//   3. a small model at low effort by default, likewise config-driven.
//
// ⚠️ THE CODEX PATH IS UNVERIFIED AGAINST A LIVE RUN. Its flags come from `codex exec --help` on the
// installed CLI; no live classification has been made with it. Its parser is written to survive that
// ignorance, and it is deliberately not the default. One live probe promotes it.
//
// ONE RULE ORDERS EVERYTHING BELOW: the classifier's binary is resolved FIRST, before any network
// or cache decision, and an unresolvable binary outranks every other rule including a failed
// transcript read. The reason is not tidiness. An absent classifier with cache reads still
// permitted would keep serving the previous run's `offer-more` and `status-only` verdicts for up to
// 48 hours — which is to say it would keep SUPPRESSING rows, silently, from a classifier that is
// not running. Suppression is the one direction this feature is not allowed to fail in (principle
// 2), so an unresolvable binary means: read the transcript anyway (`lastAssistant` is honest data
// and may publish as null), touch no cache, attach `unknown · classifier binary missing` (or
// `· classifier binary unusable`) to every blocked session, and leave the entries on disk.
// `no transcript text` is therefore a reason that can only ever appear when the binary resolved.
//
// THE SECOND RULE IS THAT THE DEADLINE HAS TEETH. The collector awaits this stage, so a hung
// classifier is a hung sweep — and a sweep that never publishes is worse than one that publishes
// `unknown`. At CLASSIFY_DEADLINE_MS the stage attaches `unknown · deadline` to everything
// unresolved and resolves immediately. That is not a soft bound: a classification that lands after
// the deadline — including from a transport that ignores the abort signal — is discarded WHOLE. It
// mutates no session, writes no cache entry and starts no cooldown, because every side effect
// checks the stage generation that spawned it before applying. There is no background completion
// and no provisional-then-updated row. Under this transport the deadline also KILLS THE CHILD
// PROCESS rather than merely ignoring its answer: a classifier that outlives its stage is a cost
// leak as well as a correctness one.
// ================================================================================================

// Which CLI does the classifying. Both are agent CLIs already installed on an operator's machine and
// already authenticated; neither needs an API key held by radar. `claude` is the default only because
// `radar/handoff.js` already spawns it, so a machine that can dispatch a handoff can classify with no
// extra setup — NOT because it is the better host for this job. It is not; see PROVIDERS.
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_EFFORT = 'low';

// The transport contract, hashed into CLASSIFIER_VERSION. Bump the trailing number whenever the
// invocation or the output-parsing rule changes in a way that could change what a verdict MEANS —
// that bump is what invalidates 48 hours of cached verdicts produced under the old contract.
const TRANSPORT_SHAPE = 'cli-print-mode/2';

// One attempt's own timeout, and it is deliberately EQUAL to the stage deadline rather than shorter.
// A CLI classification is a process launch plus a model turn, so "slow" is normal in a way it never
// was over HTTP. If this timeout fired first, ordinary slowness would report `classifier
// unreachable` and arm a 5-minute cooldown — punishing the sweep for the classifier being busy. Set
// equal, the STAGE deadline wins every slowness race instead, which reports `deadline`, starts no
// cooldown, and simply retries on the next sweep. What still fails fast — a spawn error, a nonzero
// exit — is exactly what a second attempt can plausibly fix.
const ATTEMPT_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 5000;         // `--version`, which reaches no model and costs nothing
const CLASSIFY_DEADLINE_MS = 20000;    // the whole stage's bound (§5.2.6)
const COOLDOWN_MS = 5 * 60 * 1000;     // the negative cooldown window (§5.2.4)
const POOL_SIZE = 4;                   // at most four concurrent classifications

// The classified text travels as an argv element, so it is bounded twice: §5.2.1 already caps the
// transcript read at 256 KB, and this caps what reaches the command line. Exceeding ARG_MAX is a
// spawn failure — E2BIG — which would read as `classifier unreachable` forever for one unlucky
// session. The TAIL is what survives a trim, never the head: §5.2.1's whole premise is that the
// operative sentence is at the end of the turn, and a message long enough to trim is one whose
// question is certainly not in its first 32 KB.
const MAX_PROMPT_BYTES = 32768;
const TRIM_MARKER = '[…earlier output trimmed…]\n';

// `unknown` is deliberately NOT in this list. It is only ever this module's own answer, never a
// value the model is allowed to return and never a value that can be cached.
const VERDICTS = ['needs-decision', 'offer-more', 'status-only'];

// §5.2.3. This exact string is scored against the labelled corpus in S-004 and is hashed into
// CLASSIFIER_VERSION, so editing it invalidates every cached verdict — which is the point.
//
// The two lines that carry the whole discriminator are the question-mark caveat and the tie-break.
// The loudest false positive in the measured corpus is a completed piece of work whose last
// sentence is "Want me to also wire the retry path?" — a question mark, an offer, and nothing
// blocked. And the tie-break is asymmetric ON PURPOSE (principle 2): a question wrongly hidden is
// a session that waits forever, a report wrongly shown is one line the operator skims past.
// A THIRD CLAUSE EARNS ITS PLACE UNDER THIS TRANSPORT: the output contract. Over HTTP the answer
// shape was enforced on the wire by a json_schema, and the prompt could stay silent about it. A CLI
// in print mode returns whatever the model wrote, so the shape has to be ASKED for — and asked for
// precisely, because the whole feature reads as `unknown` if the model wraps its JSON in prose.
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
  'Reply with one JSON object and nothing else: no preamble, no explanation, no code fence.',
  'It has exactly two keys. verdict is one of needs-decision, offer-more, status-only.',
  'reason is one short sentence naming the evidence you decided on.',
  'Use no tools. Do not read any file. Decide only from the text below.',
].join('\n');

// §5.2.4. Exposed as a pure function so the pinned-digest test can hand it the four known inputs
// without monkey-patching module constants. The separator is a single ASCII space (0x20).
//
// ITS INPUTS ARE EXACTLY WHAT DETERMINES WHAT A VERDICT MEANS, and under this transport that is no
// longer a fixed list of module constants: the provider, the model and the effort level all come
// from config, so a module-constant digest would let an operator switch CLI or model and keep
// serving 48 hours of verdicts the new classifier never produced. The version is therefore computed
// PER STAGE from the resolved settings; `CLASSIFIER_VERSION` below is that same computation over the
// defaults, which is what an unconfigured collector actually runs.
//
// THE PROVIDER IS IN THE DIGEST AND THAT IS NOT COSMETIC. Two CLIs asked the same question with the
// same prompt still answer as different models behind different harnesses. Leaving the provider out
// would let a switch from claude to codex silently inherit two days of the other one's verdicts.
function classifierVersion(provider, model, effort, prompt, transport) {
  return crypto.createHash('sha256')
    .update(String(provider) + ' ' + String(model) + ' ' + String(effort) + ' ' + String(prompt) + ' ' + JSON.stringify(transport))
    .digest('hex')
    .slice(0, 12);
}

const transportOf = (flags) => ({ shape: TRANSPORT_SHAPE, flags: flags.slice() });

// CLASSIFIER_VERSION is defined below PROVIDERS, because it is now computed FROM the default
// provider's own model and flags rather than from free-standing constants.

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
// A child process, not a socket. `radar/http.js` is GET-only and irrelevant here; what this needs is
// the shape `handoff.js` already uses for `claude` — spawn, collect stdout, never throw.
//
// Shape: { ok, code, stdout, stderr, error }. `ok` is true only on a clean exit 0 — a spawn failure,
// a nonzero exit, a timeout and a kill are all `ok:false` with `error` naming which. It never
// throws: a dead classifier is a fact to report, not an exception that ends a sweep.
//
// THE SIGNAL IS THE POINT. Node's `spawn` accepts an AbortSignal and kills the child when it fires,
// so the stage deadline does not merely stop caring about the answer — it stops the process that was
// going to produce it. The per-attempt `timeout` is the backstop for a child that outlives even
// that, and `killSignal` stays SIGTERM so the CLI gets to shut down its own children.
function defaultRun(req) {
  const spawn = typeof req.spawn === 'function' ? req.spawn : childProcess.spawn;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    let child;
    try {
      child = spawn(req.bin, req.args, {
        signal: req.signal,
        timeout: req.timeoutMs,
        killSignal: 'SIGTERM',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return finish({ ok: false, code: null, stdout: '', stderr: '', error: e && e.message ? e.message : String(e) });
    }

    let out = '';
    let err = '';
    // A classifier answer is a few hundred bytes; anything unbounded here is a memory leak wearing a
    // buffer. Past the cap the tail is dropped — the JSON we need is at the start of a sane answer,
    // and an answer this long is not a sane one.
    const cap = (s, chunk) => (s.length >= MAX_PROMPT_BYTES ? s : s + String(chunk));
    if (child.stdout) child.stdout.on('data', (c) => { out = cap(out, c); });
    if (child.stderr) child.stderr.on('data', (c) => { err = cap(err, c); });

    child.on('error', (e) => finish({ ok: false, code: null, stdout: out, stderr: err, error: e && e.message ? e.message : String(e) }));
    child.on('close', (code, sig) => finish({
      ok: code === 0 && !sig,
      code,
      signal: sig || null,
      stdout: out,
      stderr: err,
      error: code === 0 && !sig ? null : (sig ? `killed by ${sig}` : `exit ${code}`),
    }));
  });
}

// ---- classify ----------------------------------------------------------------------------------

const unknown = (reason) => ({ verdict: 'unknown', reason });

function classifyArgv(settings, text) {
  return providerOf(settings.provider).argv(settings, text);
}

// Keep the TAIL. See MAX_PROMPT_BYTES.
function boundText(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_PROMPT_BYTES) return text;
  const buf = Buffer.from(text, 'utf8');
  return TRIM_MARKER + buf.slice(buf.length - MAX_PROMPT_BYTES).toString('utf8');
}

// The model was asked for bare JSON and usually gives it. A fence is the one deviation common enough
// to be worth absorbing rather than failing on — it costs a regex here and saves an `unknown` row
// there. Anything else is genuinely unparseable.
function parseAnswer(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  try { return JSON.parse(fenced ? fenced[1] : text); } catch (_) { return undefined; }
}

// THE ANSWER PREDICATE, shared by both providers and deliberately strict. Whatever a CLI wraps its
// output in, an answer only counts if it is an object carrying a verdict from the closed enum and a
// string reason. `unknown` is absent from VERDICTS on purpose, so no envelope can talk this function
// into returning one — `unknown` stays this module's own word for "I could not get an answer".
function verdictOf(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (VERDICTS.indexOf(parsed.verdict) === -1) return null;
  if (typeof parsed.reason !== 'string') return null;
  return { verdict: parsed.verdict, reason: parsed.reason };
}

// ---- providers ----------------------------------------------------------------------------------
// TWO CLIs, ONE CONTRACT. A provider owns exactly three decisions — how to invoke, how to read the
// answer back, and where its binary lives when unconfigured. Nothing else may live here: the cache,
// the cooldown, the deadline, the precedence rule and single-flight are transport-agnostic and stay
// that way, which is what makes adding a third CLI a change to this object and nothing else.
//
// The honest comparison, because it decides which one an operator should pick:
//
//   codex is the better host for THIS job. `--output-schema` enforces the answer shape at the CLI
//   rather than asking the prompt nicely for it, and `--ignore-user-config` drops the ambient
//   config that makes an agent CLI expensive to invoke WITHOUT forcing an API key — its own help
//   states auth still comes from CODEX_HOME. claude's equivalent cost lever, `--bare`, does the
//   opposite: it makes auth strictly ANTHROPIC_API_KEY, reintroducing the very credential this
//   transport exists to avoid holding. So claude is the default for continuity with handoff.js,
//   not for merit.
const PROVIDERS = {
  // Measured against the real CLI: `-p --output-format json` returns a JSON ARRAY of events —
  // system/init, one or more assistant, sometimes a rate-limit event, and a final `type:"result"`
  // carrying the answer in `.result`. The LAST result element wins: a run that emitted two has
  // answered twice and the last is the one it finished on. A bare object is the degenerate
  // one-element case the CLI's own help calls "json (single result)" — the same envelope read two
  // ways, not two answers to one question.
  claude: {
    id: 'claude',
    binParts: ['.local', 'bin', 'claude'],
    // Null means "do not pass a model flag and let the CLI choose". claude is pinned because the
    // digest has to mean something; a floating default would silently change what a cached verdict
    // was worth.
    defaultModel: 'claude-sonnet-5',
    defaultFlags: ['--strict-mcp-config', '--no-session-persistence'],

    // `--allowed-tools ""` is FIXED and sits immediately before `--system-prompt`, and both facts
    // are load-bearing. Fixed, because a classifier that can run tools is a classifier that can
    // spend money and touch the disk on the strength of text it was asked to judge. Positioned
    // there, because `claude --help` declares `--allowed-tools <tools…>` VARIADIC: an option-list
    // flag left adjacent to the trailing positional would swallow the transcript text as another
    // tool name. Every operator-supplied flag lands before it, so no configured flag can reach the
    // positional either.
    argv(settings, text) {
      const argv = ['-p', '--output-format', 'json'];
      if (settings.model) argv.push('--model', settings.model);
      argv.push('--effort', settings.effort);
      return argv
        .concat(settings.flags)
        .concat(['--allowed-tools', '', '--system-prompt', CLASSIFY_PROMPT, text]);
    },

    parse(res) {
      const envelope = parseAnswer(res.stdout);
      if (envelope === undefined) return unknown('unparseable');
      const events = Array.isArray(envelope) ? envelope : [envelope];
      let result = null;
      for (const e of events) if (e && typeof e === 'object' && e.type === 'result') result = e;
      if (!result) return unknown('unparseable');
      // Everything the envelope can say other than a clean success collapses to `unparseable`. A
      // refusal and a truncation were distinguishable over HTTP through `stop_reason` and are not
      // distinguishable here — inventing a distinction the wire cannot support would be a reason
      // string that lies.
      if (result.is_error === true) return unknown('unparseable');
      if (result.subtype !== 'success') return unknown('unparseable');
      return verdictOf(parseAnswer(result.result)) || unknown('unparseable');
    },
  },

  // ⚠️ THE CODEX ENVELOPE IS UNVERIFIED AGAINST A LIVE RUN. Its flags come from `codex exec --help`
  // on the installed CLI, but no live classification has been made with it — the operator is at the
  // top of a weekly limit and a single live probe on the other provider measured half a dollar. The
  // PARSER IS WRITTEN TO SURVIVE THAT IGNORANCE (see parse below), and codex is deliberately not the
  // default. One live probe promotes it; until then claude is the measured path.
  codex: {
    id: 'codex',
    binParts: ['.local', 'bin', 'codex'],
    // Deliberately null: this project's standing convention for codex is to omit `-m` and take the
    // CLI's own current default rather than pin a model name that ages badly.
    defaultModel: null,
    // `--ephemeral` writes no session file per classified row, `--skip-git-repo-check` lets the
    // classifier run from anywhere, `--ignore-user-config` drops the ambient config that is most of
    // the cost, and read-only sandbox is the codex spelling of "this thing judges text, it does not
    // act". These are defaults, not fixtures — an operator can replace them.
    defaultFlags: ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only'],

    // codex has no `--system-prompt`, so the instruction and the text travel as ONE positional
    // prompt. The separator is a blank line, which is also what the prompt's own last line assumes
    // when it says to decide from "the text below".
    //
    // `--output-schema` is the reason to prefer this provider: the answer shape is enforced by the
    // CLI instead of requested by the prompt. The schema is a STATIC FILE shipped beside this
    // module — never a per-call temp file, because a temp file written on the hot path of a sweep
    // that runs every 60 seconds is a leak waiting to happen.
    argv(settings, text) {
      const argv = ['exec', '--json'];
      if (settings.model) argv.push('-m', settings.model);
      argv.push('-c', 'model_reasoning_effort="' + settings.effort + '"');
      argv.push('--output-schema', VERDICT_SCHEMA_PATH);
      return argv.concat(settings.flags).concat([CLASSIFY_PROMPT + '\n\n' + text]);
    },

    // `--json` emits JSONL, and the EVENT VOCABULARY IS A MOVING TARGET across CLI versions — so
    // pinning an event name here would be a guess that fails silently on the next upgrade, turning
    // every session `unknown` with no signal that the parser, not the model, is what broke.
    //
    // Instead: scan every line, and let the LAST payload that yields a valid verdict win. This is
    // liberal in what it accepts and still strict in what it returns, because `verdictOf` admits
    // only the closed enum plus a string reason — reasoning traces, tool chatter and prose cannot
    // masquerade as an answer. A line's payload is tried both as the whole line and as any string
    // field one level in, which covers "the answer is the line" and "the answer is a field on an
    // event" without needing to know which one this version does.
    parse(res) {
      const lines = String(res.stdout == null ? '' : res.stdout).split('\n');
      let found = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        const direct = verdictOf(parseAnswer(line));
        if (direct) { found = direct; continue; }
        const event = parseAnswer(line);
        if (!event || typeof event !== 'object') continue;
        for (const v of Object.values(event)) {
          if (typeof v !== 'string') continue;
          const nested = verdictOf(parseAnswer(v));
          if (nested) found = nested;
        }
      }
      return found || unknown('unparseable');
    },
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

// An unknown provider id resolves to the default rather than throwing. normalizeConfig already
// rejects and reports a bad id; this is the second half of that defence, and a sweep that keeps
// classifying with the default beats a sweep that dies on a typo.
const providerOf = (id) => PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];

const VERDICT_SCHEMA_PATH = path.join(__dirname, 'verdict.schema.json');

// The digest an UNCONFIGURED collector runs under — the default provider's own model and flags, not
// a separate set of constants that could drift away from what the provider actually sends.
const CLASSIFIER_VERSION = classifierVersion(
  DEFAULT_PROVIDER,
  PROVIDERS[DEFAULT_PROVIDER].defaultModel,
  DEFAULT_EFFORT,
  CLASSIFY_PROMPT,
  transportOf(PROVIDERS[DEFAULT_PROVIDER].defaultFlags),
);

function readVerdict(res, provider) {
  const r = typeof res === 'string' ? { stdout: res } : (res || { stdout: '' });
  return providerOf(provider).parse(r);
}

// One classification operation: up to TWO runs, and only a transport-class failure (spawn error,
// nonzero exit, kill, timeout) is retried. An unparseable answer is an ANSWER — retrying it buys a
// second identical answer and a second bill.
async function classify(input, deps) {
  const d = deps || {};
  const text = input && typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) return unknown('no transcript text');

  const bin = d.bin;
  if (typeof bin !== 'string' || !bin) return unknown('classifier binary missing');

  const run = typeof d.run === 'function' ? d.run : defaultRun;
  const signal = d.signal;
  const provider = PROVIDERS[d.provider] ? d.provider : DEFAULT_PROVIDER;
  const p = PROVIDERS[provider];
  const settings = {
    provider,
    model: typeof d.model === 'string' && d.model ? d.model : p.defaultModel,
    effort: typeof d.effort === 'string' && d.effort ? d.effort : DEFAULT_EFFORT,
    flags: Array.isArray(d.flags) ? d.flags : p.defaultFlags,
  };

  const request = {
    bin,
    args: classifyArgv(settings, boundText(text)),
    timeoutMs: Number.isFinite(Number(d.timeoutMs)) ? Number(d.timeoutMs) : ATTEMPT_TIMEOUT_MS,
    signal,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // Retrying past an abort would launch a fresh process for a stage that is already over — the
    // precise cost leak the deadline exists to close.
    if (signal && signal.aborted) return unknown('classifier unreachable');
    let res = null;
    try { res = await run(request); } catch (_) { res = null; }
    if (!res || res.ok !== true) continue;                    // transport class — a second try may fix it
    return readVerdict(res, provider);
  }
  return unknown('classifier unreachable');
}

// §5.2.5, second half. `handoff.js` proves a binary in two steps and so does this: `accessSync` is
// free and synchronous, `--version` costs one process launch and reaches no model. They are separate
// reasons because they are separate operator actions — one installs claude, the other repairs it.
async function probeBinary(bin, o) {
  const opts = o || {};
  const run = typeof opts.run === 'function' ? opts.run : defaultRun;
  let res = null;
  try {
    res = await run({
      bin,
      args: ['--version'],
      timeoutMs: Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : PROBE_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch (_) { res = null; }
  if (!res || res.ok !== true) return { ok: false, version: null };
  const version = String(res.stdout == null ? '' : res.stdout).trim();
  // handoff.js treats empty `--version` output as unusable, and for the same reason: a PATH shim
  // that exits 0 and prints nothing is not the binary we asked for.
  return version ? { ok: true, version } : { ok: false, version: null };
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

// §5.2.5. Everything the transport needs, resolved from the NORMALIZED config in one place — the
// stage reads it, and so does the eval script, so what gets scored is what runs.
//
// The binary falls through THREE steps: `classifierBin`, then `claudeBin`, then the same
// `$HOME/.local/bin/claude` default `handoff.js` resolves to. The middle step is the one that
// matters day to day — a machine with claude installed somewhere unusual names it once, and both the
// dispatcher and the classifier find it. The third keeps that convenience from becoming a hard
// dependency: with no config at all this still resolves, and the answer is honest either way
// because the next thing that happens to it is an executability check.
function resolveClassifier(config, env) {
  const c = config && typeof config === 'object' ? config : {};
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const home = (env && typeof env.HOME === 'string' && env.HOME) ? env.HOME : os.homedir();

  const provider = PROVIDERS[pick(c.classifierProvider)] ? pick(c.classifierProvider) : DEFAULT_PROVIDER;
  const p = PROVIDERS[provider];

  // `claudeBin` is honoured as the middle step ONLY for the claude provider. Pointing the codex
  // provider at the configured claude binary because they share a config key would spawn the wrong
  // CLI with the other one's argv — a failure that reads as "classifier unreachable" forever while
  // the binary it names is installed and healthy.
  const legacyBin = provider === 'claude' ? pick(c.claudeBin) : null;
  const bin = pick(c.classifierBin) || legacyBin || path.join.apply(path, [home].concat(p.binParts));

  // A configured model wins; otherwise the provider's own default, which may be null meaning "pass
  // no model flag and let the CLI decide".
  //
  // ⚠️ An unpinned model is a real trade-off, stated here rather than discovered later: the digest
  // below hashes the model as sent, so `null` keeps hashing to the same version even if the CLI's
  // own default moves under us — and 48 hours of verdicts from the old default keep being served.
  // An operator who needs that invalidation to be automatic must pin `classifierModel`.
  const model = pick(c.classifierModel) || p.defaultModel;
  const effort = pick(c.classifierEffort) || DEFAULT_EFFORT;
  const flags = Array.isArray(c.classifierFlags)
    ? c.classifierFlags.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : p.defaultFlags.slice();
  // WHAT WE SEND AND WHAT WE RECORD ARE NOT THE SAME STRING, and conflating them corrupts a
  // published invariant. `model` is the argv value and may legitimately be null ("omit -m"), but
  // state.schema.json documents `intent.model` as "null on every unknown path" — so writing a null
  // model on a SUCCESSFUL verdict would forge the unknown marker, and a real codex answer would be
  // indistinguishable from a classifier that never answered. `modelLabel` is therefore always a
  // non-empty string: the pinned model when there is one, else the provider whose default ran.
  const modelLabel = model || (provider + ':default');
  return {
    provider, bin, model, modelLabel, effort, flags,
    version: classifierVersion(provider, model, effort, CLASSIFY_PROMPT, transportOf(flags)),
  };
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
//
// The `ac.abort()` here is also what KILLS the children — the signal is handed to `spawn`, so ending
// the generation ends the processes, not merely our interest in them.
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
  const run = typeof d.run === 'function' ? d.run : defaultRun;
  const network = d.network !== false;
  const deadlineMs = Number.isFinite(Number(d.deadlineMs)) ? Number(d.deadlineMs) : CLASSIFY_DEADLINE_MS;
  const cachePath = d.cachePath || path.join(d.radarDir || store.defaultRadarDir(), 'intent-cache.json');
  // Injected only so the "binary is missing" branch is provable without deleting anything real.
  const isExecutable = typeof d.isExecutable === 'function'
    ? d.isExecutable
    : (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } };

  const blocked = list.filter((s) => s && s.status === 'blocked');
  if (!blocked.length) return sessions;

  // ONE timestamp for the sweep. Every `unknown` carries it, so two unknowns from the same sweep
  // are never distinguishable by a clock that has nothing to do with either of them.
  const sweepAt = new Date(nowFn()).toISOString();

  // Step 1, for every blocked session, ALWAYS — hit, miss, or no credential at all. Hoisted out of
  // the pool because it is synchronous and bounded (§5.2.1 reads at most 256 KB) and because a
  // session whose pool task never starts must still publish honest `lastAssistant` data.
  //
  // THE STALE INTENT IS CLEARED HERE, AND THAT LINE IS LOAD-BEARING. Rows do not always arrive
  // blank: `mod-sessions`' events-outage branch carries the previous published rows forward
  // wholesale, and `collector.js :: fragmentsFromState` replays `state.sessions` verbatim after a
  // module throw — and published rows carry `intent`, because `derive` publishes the fragment
  // array as `state.sessions`. A carried verdict is last turn's answer, not this stage's.
  //
  // Without the clear, the deadline's final `if (!s.intent)` sweep sees a carried `offer-more`,
  // finds it truthy, and leaves it standing next to a `lastAssistant` that is already the NEW
  // question. §5.4 rule 3 admits only `needs-decision` and `unknown`, so the row is dropped and the
  // operator never sees a question that was genuinely asked — principle 2 inverted, silently, for
  // as long as both degradations last. Clearing first makes every exit path re-attach: no
  // credential overwrites unconditionally, `resolveOne` attaches, and the deadline sweep covers the
  // rest. Losing a valid carried verdict costs an `unknown`, which is SHOWN — the safe direction.
  for (const s of blocked) {
    s.lastAssistant = readLastAssistantText(s.transcriptPath) || null;
    delete s.intent;
  }

  // PRECEDENCE, STEP 1. Before any network or cache decision. See the block comment at the top.
  // `accessSync` costs nothing and spawns nothing, so the cheapest of the two dependency checks is
  // also the first — a machine without claude installed never launches a process to find that out.
  const settings = resolveClassifier(d.config, env);
  if (!isExecutable(settings.bin)) {
    for (const s of blocked) s.intent = unknownIntent('classifier binary missing', sweepAt);
    return sessions;
  }

  const gen = { id: ++generationSeq, alive: true };
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const writes = new Map();
  let expired = false;

  // The deadline is armed HERE, before the probe, because the probe is a child process too and a
  // stage bound that does not cover every process it starts is not a bound.
  let fire = null;
  const stageDone = new Promise((r) => { fire = r; });
  const timer = setTimeout(() => { expired = true; endGeneration(gen, ac); fire(); }, deadlineMs);
  const closeStage = () => {
    clearTimeout(timer);
    if (!expired) endGeneration(gen, ac);
    for (const s of blocked) if (!s.intent) s.intent = unknownIntent('deadline', sweepAt);
  };

  // PRECEDENCE, STEP 2. One `--version` per stage — not per session, and not memoised across
  // sweeps: a binary that broke since the last sweep must be reported as broken on this one, and
  // one free process launch per 60 s is the honest price of that. It happens before the cache is
  // read so an unusable classifier bypasses the cache exactly as a missing one does.
  const probe = probeBinary(settings.bin, { run, signal: ac ? ac.signal : undefined, timeoutMs: d.probeTimeoutMs });
  probe.catch(() => {});
  const probed = await Promise.race([probe.then((r) => r, () => ({ ok: false })), stageDone.then(() => null)]);
  if (expired || probed === null) { closeStage(); return sessions; }
  if (!probed.ok) {
    clearTimeout(timer);
    endGeneration(gen, ac);
    for (const s of blocked) s.intent = unknownIntent('classifier binary unusable', sweepAt);
    return sessions;
  }

  const read = await store.readJson(cachePath, {});
  const corrupt = !read.ok;
  const cache = (read.ok && read.value && typeof read.value === 'object' && !Array.isArray(read.value))
    ? read.value : {};

  const attach = (s, intent) => { if (gen.alive) s.intent = intent; };

  async function resolveOne(s) {
    const la = s.lastAssistant;
    if (!la || !la.text) { attach(s, unknownIntent('no transcript text', sweepAt)); return; }
    // No timestamp means no injective key, and a key built from `null` would fuse every
    // timestamp-less turn of a session into one entry. Refuse rather than cache a collision.
    if (!la.ts) { attach(s, unknownIntent('no valid timestamp', sweepAt)); return; }

    // The version comes from the RESOLVED settings, not the module default: a config that names a
    // different model or effort must not serve verdicts the default classifier produced.
    const k = intentCacheKey(s.key && s.key.machine, s.key && s.key.sessionId, la.ts, settings.version);

    const hit = cache[k];
    if (isFreshEntry(hit, nowFn())) {
      attach(s, { verdict: hit.verdict, reason: hit.reason, model: hit.model === undefined ? null : hit.model, at: hit.at, inferred: true });
      return;
    }

    // The binary resolved, so `fetch:false` finally gets to speak. `claude -p` reaches the network
    // on every call, so an offline sweep must not launch it; cache reads are disk, not network, and
    // a miss is honestly unreachable — but "we did not ask" must not be penalised like "it did not
    // answer", so no cooldown starts here.
    if (!network) { attach(s, unknownIntent('classifier unreachable', sweepAt)); return; }

    const until = cooldowns.get(k);
    if (until != null && nowFn() < until) { attach(s, unknownIntent('classifier unreachable', sweepAt)); return; }

    // Single-flight, GENERATION-SCOPED. Only an entry this stage owns may be joined.
    let rec = inflight.get(k);
    if (!rec || rec.gen !== gen) {
      const created = { gen, promise: null };
      created.promise = classify({ text: la.text }, {
        run,
        provider: settings.provider,
        bin: settings.bin,
        model: settings.model,
        effort: settings.effort,
        flags: settings.flags,
        timeoutMs: d.attemptTimeoutMs,
        signal: ac ? ac.signal : undefined,
      });
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

    const at = new Date(nowFn()).toISOString();  // the answer time, for a live verdict
    // `modelLabel`, never `model` — see resolveClassifier. A successful verdict must never write the
    // null that state.schema.json reserves for "no classifier answered".
    const value = { verdict: r.verdict, reason: r.reason, model: settings.modelLabel, at };
    writes.set(k, value);
    cache[k] = value;
    attach(s, Object.assign({}, value, { inferred: true }));
  }

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
  classifierVersion, intentCacheKey, transportOf,
  defaultRun, resolveClassifier, probeBinary, classifyArgv, readVerdict,
  PROVIDERS, PROVIDER_IDS, providerOf, verdictOf,
  CLASSIFY_PROMPT, CLASSIFIER_VERSION, CLASSIFY_DEADLINE_MS,
  DEFAULT_PROVIDER, DEFAULT_EFFORT, TRANSPORT_SHAPE, VERDICT_SCHEMA_PATH,
  ATTEMPT_TIMEOUT_MS, PROBE_TIMEOUT_MS, MAX_PROMPT_BYTES,
  COOLDOWN_MS, POOL_SIZE, VERDICTS,
  _resetClassifyState,
};
