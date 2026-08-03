'use strict';
// S-004 — the tier-1 half of the classifier eval: the preconditions, the classifier-resolution
// gate, and the source rule that keeps the eval honest.
//
// WHAT THIS FILE IS FOR. `npm run test:eval:inbox` costs money and needs a working `claude` CLI, so
// it cannot be a unit test. What CAN be proved offline is everything that decides whether it is
// allowed to run at all: that the corpus is still synthetic, that a drifted corpus refuses to be
// scored rather than scored anyway, that an unresolvable classifier is NAMED rather than guessed at,
// and that the prompt being scored is the prompt that ships. Those are the parts that fail silently
// if unproved.
//
// NOTHING HERE REACHES A MODEL, AND THAT IS STRUCTURAL, NOT LUCK. Three independent things hold it:
//
//   1. The precondition layer and the scoring layer are separate exports of scripts/eval-inbox.mjs.
//      The precondition tests call the first, which reads a string and returns a verdict — no env,
//      no binary, no process.
//   2. Every in-process test that reaches the scoring layer injects `run`, the spawn seam, so
//      `classify` never launches anything.
//   3. Every CHILD process is spawned with an env of exactly two variables, RADAR_DIR and HOME, both
//      pointing at empty temp directories. Under the CLI transport the classifier resolves to
//      `$HOME/.local/bin/claude` when unconfigured, so a scratch HOME is what makes a child
//      structurally incapable of finding a classifier — a real install in the developer's shell
//      cannot leak in and turn a refusal into a billed run.
//
// EVERY FIXTURE IS INVENTED. The adversarial UUID marker is BUILT from hex digits inside this file
// rather than written as a literal — a real-looking id pasted in as a negative test case is still a
// real-looking id in a public repo, which is the exact failure this story exists to prevent.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'eval-inbox.mjs');
const CORPUS = path.join(__dirname, 'fixtures', 'inbox-corpus.json');
const CLASSIFY_PATH = path.join(REPO_ROOT, 'radar', 'classify.js');

const classifyModule = require('../radar/classify');

// The eval script is ESM; the suite is CommonJS. One dynamic import, memoised.
let evalModPromise = null;
const evalMod = () => (evalModPromise || (evalModPromise = import('../scripts/eval-inbox.mjs')));

// ---- scaffolding --------------------------------------------------------------------------------
const dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-eval-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

const shippedEntries = () => JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

// The unconfigured fall-through, per resolveClassifier. Derived from the shipped provider table
// rather than written as a literal, so a change to the default install path is a failure of the
// eval's message, not of this helper.
const DEFAULT_PROVIDER = classifyModule.PROVIDERS[classifyModule.DEFAULT_PROVIDER];
const defaultBinUnder = (home) => path.join.apply(path, [home].concat(DEFAULT_PROVIDER.binParts));

// Write a scratch corpus and hand back its path. `mutate` receives a deep copy of the shipped
// corpus so every violation below is exactly one deliberate change away from a passing file.
function scratchCorpus(mutate) {
  const entries = shippedEntries();
  const out = mutate(entries);
  const dir = tmpdir();
  const p = path.join(dir, 'scratch-corpus.json');
  fs.writeFileSync(p, typeof out === 'string' ? out : JSON.stringify(out === undefined ? entries : out, null, 2));
  return p;
}

// Run the real script as a child. The env is built from nothing: exactly RADAR_DIR, so the config
// lookup lands in an empty temp directory, and HOME, so the unconfigured classifier resolves inside
// that same emptiness and cannot exist.
function runEval(corpusPath, opts) {
  const o = opts || {};
  const env = Object.assign({ RADAR_DIR: o.radarDir || tmpdir(), HOME: o.home || tmpdir() }, o.env || {});
  const r = spawnSync(process.execPath, [SCRIPT, '--corpus', corpusPath], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// "Rather than scoring" is an assertion about what did NOT happen, so it needs its own witness:
// the two lines only the scoring path can ever write.
function assertScoredNothing(r) {
  assert.equal(/actual \\ pred/.test(r.stdout), false, 'a confusion matrix was printed');
  assert.equal(/^overall:/m.test(r.stdout), false, 'a score was printed');
  assert.equal(/^\s*MISS /m.test(r.stdout), false, 'per-entry results were printed');
}

// A stub for the spawn seam. It answers with the CLI's measured `--output-format json` envelope —
// a JSON ARRAY of events ending in a `type:"result"` element whose `.result` is the answer text —
// so the scoring layer is exercised through the shipped `readVerdict`, not around it.
function envelope(verdict) {
  return JSON.stringify([
    { type: 'system', subtype: 'init', session_id: 'fixture-session' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'fixture' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ verdict, reason: 'fixture' }), total_cost_usd: 0 },
  ]);
}

const FIXTURE_SETTINGS = {
  provider: classifyModule.DEFAULT_PROVIDER,
  bin: path.join(path.sep, 'fixture', 'bin', 'claude'),
  model: 'fixture-model',
  effort: 'low',
  flags: ['--fixture-flag'],
};

// The argv `classify` builds, read positionally. The tail is fixed by §5.2.2 —
// `--allowed-tools "" --system-prompt <PROMPT> <TEXT>` — and the text is always last.
function readArgv(args) {
  return {
    text: args[args.length - 1],
    prompt: args[args.length - 2],
    promptFlag: args[args.length - 3],
    toolsValue: args[args.length - 4],
    toolsFlag: args[args.length - 5],
    model: args[args.indexOf('--model') + 1],
    effort: args[args.indexOf('--effort') + 1],
  };
}

// ---- AC 1 — the six preconditions pass, and each one violated refuses to score -------------------

test('AC1: all six preconditions pass on the shipped corpus', async () => {
  const { checkPreconditions } = await evalMod();
  const v = checkPreconditions(fs.readFileSync(CORPUS, 'utf8'));
  assert.equal(v.ok, true, v.failures.join('\n'));
  assert.deepEqual(v.checks.map((c) => c.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  for (const c of v.checks) assert.equal(c.ok, true, `${c.id} ${c.name}: ${c.detail}`);
  assert.deepEqual(v.failures, []);
  // The layer hands the parsed corpus back only when every check held — a caller cannot score a
  // corpus it just failed.
  assert.equal(Array.isArray(v.entries), true);
  assert.equal(v.entries.length, shippedEntries().length);
});

test('AC1: the shipped corpus satisfies the story shape, entry by entry', () => {
  const entries = shippedEntries();
  assert.ok(entries.length >= 16, `expected >= 16 entries, got ${entries.length}`);
  const by = (label) => entries.filter((e) => e.label === label);
  assert.ok(by('needs-decision').length >= 2, 'fewer than two needs-decision entries');
  assert.ok(by('offer-more').some((e) => e.text.trim().endsWith('?')),
    'trap 3 is unrepresented: no offer-more entry ends in a question mark');
  // Every class present — a corpus missing a class cannot produce a meaningful confusion matrix.
  for (const label of classifyModule.VERDICTS) assert.ok(by(label).length > 0, `no ${label} entries`);
  // Ids are unique; a duplicate would silently collapse two rows of the matrix into one.
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'duplicate corpus ids');
});

test('AC1: the shipped corpus scores through the eval and refuses to score when a precondition is violated', () => {
  // The control: the shipped corpus clears every precondition and stops at the CLASSIFIER, not
  // before it. If this run refused earlier, the violations below would prove nothing.
  const control = runEval(CORPUS);
  assert.notEqual(control.status, 0);
  assert.equal(control.status, 3, `expected the no-classifier exit code, got ${control.status}:\n${control.stderr}`);
  assert.equal(/precondition P\d FAILED/.test(control.stderr), false, control.stderr);
  assertScoredNothing(control);

  const cases = [
    // P1 — the file no longer parses.
    ['P1', () => '{ this is not json'],
    // P2 — one entry short of the floor.
    ['P2', (entries) => entries.slice(0, 15)],
    // P3 — a single needs-decision entry left, one below the floor.
    ['P3', (entries) => {
      let kept = 0;
      for (const e of entries) if (e.label === 'needs-decision' && kept++ > 0) e.label = 'status-only';
      return entries;
    }],
    // P4 — trap 3 removed: no offer-more entry ends in a question mark any more.
    ['P4', (entries) => {
      for (const e of entries) if (e.label === 'offer-more') e.text = e.text.replace(/\?\s*$/, '.');
      return entries;
    }],
    // P5 — a label outside the verdict enum. `unknown` is the classifier's own answer, never a label.
    ['P5', (entries) => { entries[3].label = 'unknown'; return entries; }],
    // P6 — an id outside the reserved synthetic grammar.
    ['P6', (entries) => { entries[5].id = 'fixture-inbox-six'; return entries; }],
  ];

  for (const [id, mutate] of cases) {
    const r = runEval(scratchCorpus(mutate));
    assert.notEqual(r.status, 0, `${id}: expected a non-zero exit`);
    assert.equal(r.status, 2, `${id}: expected the precondition exit code`);
    assert.match(r.stderr, new RegExp(`precondition ${id} FAILED`), `${id}: stderr did not name the precondition:\n${r.stderr}`);
    assert.match(r.stderr, /nothing was scored and no request was made/);
    assertScoredNothing(r);
  }
});

test('AC1: a corpus that cannot be read at all is a P1 refusal, not a crash', () => {
  const r = runEval(path.join(tmpdir(), 'no-such-corpus.json'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /precondition P1 FAILED/);
  assertScoredNothing(r);
});

test('AC1: a failed precondition reports the later checks as not-run rather than vacuously passing', async () => {
  const { checkPreconditions } = await evalMod();
  const v = checkPreconditions('[]not json');
  assert.equal(v.ok, false);
  assert.equal(v.entries, null);
  assert.equal(v.checks.length, 6);
  for (const c of v.checks.slice(1)) assert.match(c.detail, /not run/);
  assert.equal(v.failures.length, 6);
});

// ---- AC 2 — the privacy preconditions name the offending entry -----------------------------------

// A UUID-SHAPED MARKER, BUILT HERE. Never a literal, never copied from anywhere: the digits are
// generated, so this file contains no id-looking string at rest. It matches the shape the
// precondition hunts for, which is the only property the test needs.
const HEX = '0123456789abcdef';
const hexRun = (n, seed) => Array.from({ length: n }, (_, i) => HEX[(i * 7 + seed) % 16]).join('');
const SYNTHETIC_UUID = [hexRun(8, 1), hexRun(4, 2), hexRun(4, 3), hexRun(4, 4), hexRun(12, 5)].join('-');

test('AC2: a synthetic UUID-shaped marker in an entry refuses the run and names the entry', () => {
  // Sanity: the marker really is the shape under test, or the assertion below is empty.
  assert.match(SYNTHETIC_UUID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // In the text …
  const inText = runEval(scratchCorpus((entries) => {
    entries[2].text = `${entries[2].text} The run id was ${SYNTHETIC_UUID}.`;
    return entries;
  }));
  assert.notEqual(inText.status, 0);
  assert.equal(inText.status, 2);
  assert.match(inText.stderr, /precondition P6 FAILED/);
  assert.match(inText.stderr, /entry #3 \(id "fixture-inbox-003"\)/);
  assert.match(inText.stderr, /text matches forbidden pattern uuid/);
  // The offending TEXT is named by entry, never echoed — the point is not to publish it.
  assert.equal(inText.stderr.includes(SYNTHETIC_UUID), false, 'the matched text was echoed back');
  assertScoredNothing(inText);

  // … and in the id, where the grammar catches it too.
  const inId = runEval(scratchCorpus((entries) => { entries[0].id = SYNTHETIC_UUID; return entries; }));
  assert.equal(inId.status, 2);
  assert.match(inId.stderr, /precondition P6 FAILED/);
  assert.match(inId.stderr, /entry #1/);
  assert.match(inId.stderr, /id matches forbidden pattern uuid/);
  assert.match(inId.stderr, /does not match the reserved synthetic grammar/);
  assertScoredNothing(inId);
});

test('AC2: an id outside the reserved synthetic grammar refuses the run and names the entry', () => {
  const r = runEval(scratchCorpus((entries) => { entries[9].id = 'inbox-10'; return entries; }));
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /precondition P6 FAILED/);
  assert.match(r.stderr, /entry #10 \(id "inbox-10"\)/);
  assert.match(r.stderr, /does not match the reserved synthetic grammar/);
  assertScoredNothing(r);
});

test('AC2: an absolute home path in an entry text refuses the run and names the entry', () => {
  const r = runEval(scratchCorpus((entries) => {
    entries[7].text = `${entries[7].text} The notes are in /Users/fixture-operator/notes/plan.md.`;
    return entries;
  }));
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /precondition P6 FAILED/);
  assert.match(r.stderr, /entry #8 \(id "fixture-inbox-008"\)/);
  assert.match(r.stderr, /text matches forbidden pattern home-path/);
  assertScoredNothing(r);
});

test('AC2: every forbidden shape is detected, and none of them fires on the shipped corpus', async () => {
  const { FORBIDDEN_PATTERNS, checkPreconditions } = await evalMod();
  const names = FORBIDDEN_PATTERNS.map(([n]) => n);
  // The STRUCTURAL set — shapes that identify regardless of who owns the machine. Owner-specific
  // words are deliberately absent from this file and from the script: they are derived at runtime
  // (see the identity-term test below), so nothing identifying is committed to the repo.
  for (const n of ['uuid', 'session-url', 'home-path', 'issue-key', 'infra-id', 'email', 'credential']) {
    assert.ok(names.includes(n), `no pattern named ${n}`);
  }
  // Each pattern is live: a constructed sample of its shape trips it, one at a time.
  const samples = {
    uuid: SYNTHETIC_UUID,
    'session-url': 'https://claude.ai/code/session' + '/x',
    'home-path': '/Volumes/fixture-disk/work',
    'issue-key': ['ABC', '-1234'].join(''),
    'infra-id': ['prj', '_abc123def'].join(''),
    email: ['someone', '@', 'fixture-host.example'].join(''),
    credential: ['sk', '-ant-', 'fixture'].join(''),
  };
  for (const [name, sample] of Object.entries(samples)) {
    const v = checkPreconditions(JSON.stringify(shippedEntries().map((e, i) => (
      i === 4 ? Object.assign({}, e, { text: `${e.text} ${sample}` }) : e
    ))));
    assert.equal(v.ok, false, `pattern ${name} did not fire on ${JSON.stringify(sample)}`);
    const p6 = v.checks.find((c) => c.id === 'P6');
    assert.match(p6.detail, new RegExp(`forbidden pattern ${name}\\b`), `${name}: P6 named the wrong pattern: ${p6.detail}`);
  }
});

test('AC2: identity terms are derived from the machine, and no owner word is written in the repo', async () => {
  const { forbiddenPatterns } = await evalMod();

  // Derived from env, from RADAR_PRIVACY_TERMS, and from git identity — none of it hardcoded.
  const built = forbiddenPatterns(
    { USER: 'fixtureowner', RADAR_PRIVACY_TERMS: 'acmecorp, widgetco' },
    (key) => (key === 'user.name' ? 'Fixture Person' : 'fixture.person@fixture-host.example'),
  );
  const identity = built.find(([n]) => n === 'identity-term');
  assert.ok(identity, 'no identity-term pattern when the machine supplied terms');
  for (const term of ['fixtureowner', 'acmecorp', 'WIDGETCO', 'Fixture', 'person']) {
    assert.ok(identity[1].test(`a corpus line mentioning ${term} inline`), `identity term not caught: ${term}`);
  }

  // A term under three characters is noise, not identity — it would flag half the corpus.
  const short = forbiddenPatterns({ USER: 'ab', RADAR_PRIVACY_TERMS: 'x' }, () => null);
  assert.ok(!short.some(([n]) => n === 'identity-term'), 'a 2-char term must not become a pattern');

  // THE FAIL-OPEN GUARD. With nothing derivable the pattern is ABSENT, never an empty alternation —
  // `new RegExp('')` matches every string, which would refuse every corpus on every line.
  const bare = forbiddenPatterns({}, () => null);
  assert.ok(!bare.some(([n]) => n === 'identity-term'), 'empty machine identity must not add a pattern');
  assert.ok(!bare.some(([, re]) => re.test('an entirely invented sentence about a slot planner')),
    'with no identity terms the structural patterns must still not fire on clean text');

  // Structural coverage survives regardless of identity: a pasted real session is caught by shape.
  assert.ok(bare.some(([, re]) => re.test('see /Users/someone/notes.md')), 'home-path must fire without identity terms');

  // And the source itself carries no owner word — the property this whole change exists for.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/\bfrag\s*\(/.test(src), 'the fragment-assembly helper is gone; identity is derived, not spelled');
});

// ---- AC 3 — the classifier is asserted BY PATH -----------------------------------------------------
// There is no credential under this transport, so the question changed: not "is the variable set?"
// but "does a classifier binary resolve, and does it answer?". What did NOT change is the property
// worth having — the refusal names the thing it could not resolve, and that name comes from the
// normalized config rather than a default this file restates.

test('AC3: with no classifier binary the run exits non-zero naming the path it could not resolve, and reports no score', () => {
  const home = tmpdir();
  const r = runEval(CORPUS, { home });
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 3, `expected the no-classifier exit code:\n${r.stderr}`);
  assert.match(r.stderr, /classifier binary missing/);
  // The PATH is named, not merely the failure — a refusal the operator cannot act on is a bug.
  assert.ok(r.stderr.includes(defaultBinUnder(home)), `stderr did not name the resolved path:\n${r.stderr}`);
  assert.match(r.stderr, /nothing was scored/);
  // Every precondition passed first — this refusal is the classifier's, not a corpus failure.
  assert.match(r.stdout, /ok\s+P6/);
  assertScoredNothing(r);
});

test('AC3: the named binary comes from the normalized config, not a hardcoded default', () => {
  const dir = tmpdir();
  const home = tmpdir();
  const configured = path.join(path.sep, 'fixture', 'no-such-classifier', 'claude');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierBin: configured, repos: [] }));
  const r = runEval(CORPUS, { radarDir: dir, home });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /classifier binary missing/);
  assert.ok(r.stderr.includes(configured), `stderr did not name the configured binary:\n${r.stderr}`);
  assert.equal(r.stderr.includes(defaultBinUnder(home)), false, 'fell back to the default despite a configured bin');
  assertScoredNothing(r);
});

test('AC3: the refusal names WHICH provider could not be resolved, for every provider', () => {
  // Naming only the path is not enough when two CLIs are selectable: "install it" and "install the
  // right one" are different operator actions. Every provider is exercised, and none of them
  // reaches a model — each run refuses at the binary that does not exist under a scratch HOME.
  for (const id of classifyModule.PROVIDER_IDS) {
    const dir = tmpdir();
    const home = tmpdir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: id, repos: [] }));
    const r = runEval(CORPUS, { radarDir: dir, home });
    const bin = path.join.apply(path, [home].concat(classifyModule.PROVIDERS[id].binParts));
    assert.equal(r.status, 3, `${id}: expected the no-classifier exit code:\n${r.stderr}`);
    assert.match(r.stderr, /classifier binary missing/, `${id}: the two refusals were not kept distinct`);
    assert.ok(r.stderr.includes(bin), `${id}: the refusal did not name the path:\n${r.stderr}`);
    // The provider must be named OUTSIDE the binary path. Every provider id is a substring of its
    // own default install path, so checking raw stderr would pass on a message that names neither —
    // the path alone would satisfy it. Mutation-caught: this assertion was vacuous before the strip.
    assert.ok(r.stderr.split(bin).join('<bin>').includes(id),
      `${id}: the refusal names the provider only inside the binary path:\n${r.stderr}`);

    // The header reported the run's identity before refusing, and never as `null`.
    assert.match(r.stdout, new RegExp(`^provider:\\s+${id}$`, 'm'));
    assert.match(r.stdout, /^model:\s+\S/m);
    assert.equal(/^model:\s+null/m.test(r.stdout), false, `${id}: the header printed a null model`);
    assert.match(r.stdout, /^shape:\s+(enforced by the CLI|asked for in the prompt only)/m);
    assertScoredNothing(r);
  }
});

test('AC3: resolveSettings falls through config to the shipped resolver, and reports the resolved model and effort', async () => {
  const { resolveSettings } = await evalMod();
  const dir = tmpdir();
  const home = tmpdir();

  // Unconfigured: the three-step fall-through lands on the default install path and the shipped
  // model/effort defaults — all of them the resolver's answer, none of them restated in the eval.
  const bare = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
  assert.equal(bare.provider, classifyModule.DEFAULT_PROVIDER);
  assert.equal(bare.bin, defaultBinUnder(home));
  assert.equal(bare.model, DEFAULT_PROVIDER.defaultModel);
  assert.equal(bare.effort, classifyModule.DEFAULT_EFFORT);
  assert.deepEqual(bare.flags, DEFAULT_PROVIDER.defaultFlags);
  assert.equal(bare.version, classifyModule.CLASSIFIER_VERSION);

  // Configured: every field is taken from the file, and the version moves with them — an eval run
  // under a different model must not claim the default classifier's identity.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    classifierBin: '  /fixture/bin/claude  ',
    classifierModel: 'fixture-model',
    classifierEffort: 'high',
    classifierFlags: ['--fixture-flag'],
    repos: [],
  }));
  const configured = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
  assert.equal(configured.bin, '/fixture/bin/claude');
  assert.equal(configured.model, 'fixture-model');
  assert.equal(configured.effort, 'high');
  assert.deepEqual(configured.flags, ['--fixture-flag']);
  assert.notEqual(configured.version, bare.version);

  // The provider is config too, and it reaches the eval. A provider the resolver does not know
  // falls back rather than resolving to a binary nothing can drive.
  const other = classifyModule.PROVIDER_IDS.find((id) => id !== classifyModule.DEFAULT_PROVIDER);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: other, repos: [] }));
  const switched = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
  assert.equal(switched.provider, other);
  assert.equal(switched.bin, path.join.apply(path, [home].concat(classifyModule.PROVIDERS[other].binParts)));
  assert.notEqual(switched.version, bare.version, 'the provider must move the classifier version');

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: 'fixture-not-a-provider', repos: [] }));
  assert.equal((await resolveSettings({ RADAR_DIR: dir, HOME: home }, {})).provider, classifyModule.DEFAULT_PROVIDER);
});

test('AC3: claudeBin moves only the claude provider, never another provider binary', async () => {
  const { resolveSettings } = await evalMod();
  const dir = tmpdir();
  const home = tmpdir();
  const forged = path.join(path.sep, 'fixture', 'bin', 'some-other-cli');

  // Sharing one config key across two CLIs would spawn the wrong binary with the other one's argv —
  // a failure that reads as `classifier unreachable` forever while the binary it names is installed
  // and perfectly healthy. Every non-default provider is checked, not just the one that exists today.
  for (const id of classifyModule.PROVIDER_IDS.filter((p) => p !== 'claude')) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: id, claudeBin: forged, repos: [] }));
    const s = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
    assert.equal(s.provider, id);
    assert.notEqual(s.bin, forged, `claudeBin moved the ${id} binary`);
    assert.equal(s.bin, path.join.apply(path, [home].concat(classifyModule.PROVIDERS[id].binParts)));
  }

  // The positive control: for claude it IS the fallback, or the assertions above prove only that
  // the key is ignored everywhere.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: 'claude', claudeBin: forged, repos: [] }));
  assert.equal((await resolveSettings({ RADAR_DIR: dir, HOME: home }, {})).bin, forged);
});

test('AC3: every provider resolves a printable model label, including the ones that pin no model', async () => {
  const { resolveSettings } = await evalMod();
  const dir = tmpdir();
  const home = tmpdir();

  // `intent.model` is declared null on every UNKNOWN path, so a successful verdict recording null
  // would forge the unknown marker. `modelLabel` is what the eval prints for the same reason it is
  // what the sweep records: a header answering "which classifier produced this score" cannot say
  // `null`. It must be a non-empty string for every provider, whether or not a model flag is passed.
  for (const id of classifyModule.PROVIDER_IDS) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: id, repos: [] }));
    const s = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
    assert.equal(typeof s.modelLabel, 'string', `${id}: modelLabel is not a string`);
    assert.ok(s.modelLabel.trim().length > 0, `${id}: modelLabel is empty`);
    // A pinned model labels itself; an unpinned one still labels itself as something.
    if (s.model) assert.equal(s.modelLabel, s.model, `${id}: a pinned model must label itself`);
  }

  // And a pinned model on the provider that otherwise passes none collapses the two back together.
  const unpinned = classifyModule.PROVIDER_IDS.find((id) => classifyModule.PROVIDERS[id].defaultModel === null);
  if (unpinned) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: unpinned, classifierModel: 'fixture-pinned', repos: [] }));
    const s = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
    assert.equal(s.model, 'fixture-pinned');
    assert.equal(s.modelLabel, 'fixture-pinned');
  }
});

test('the eval reports whether the answer shape is enforced by the CLI or only asked for in the prompt', async () => {
  const { enforcesAnswerShape, resolveSettings } = await evalMod();
  const dir = tmpdir();
  const home = tmpdir();

  // The claim is derived from the shipped argv builder, so it is checked against that same builder
  // rather than against a list of provider names this test would have to maintain.
  for (const id of classifyModule.PROVIDER_IDS) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierProvider: id, repos: [] }));
    const s = await resolveSettings({ RADAR_DIR: dir, HOME: home }, {});
    const argv = classifyModule.classifyArgv(s, 'fixture text');
    assert.equal(enforcesAnswerShape(s), argv.includes(classifyModule.VERDICT_SCHEMA_PATH),
      `${id}: the reported answer-shape enforcement disagrees with the invocation`);
  }

  // The schema is a shipped file, not a per-call temp file — a run that reports "enforced" while
  // pointing at nothing would be the most confident possible lie about what was measured.
  assert.equal(fs.existsSync(classifyModule.VERDICT_SCHEMA_PATH), true, 'the verdict schema file is not on disk');
});

test('AC3: the two ways of being unresolvable are separate refusals, and a working binary is neither', async () => {
  const { checkClassifier } = await evalMod();

  // Not on disk: the free syscall answers, and nothing is ever spawned.
  let spawned = 0;
  const counting = async () => { spawned++; return { ok: true, code: 0, stdout: '2.0.0\n', stderr: '', error: null }; };
  const missing = await checkClassifier(FIXTURE_SETTINGS, { isExecutable: () => false, run: counting });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'classifier binary missing');
  assert.equal(missing.bin, FIXTURE_SETTINGS.bin);
  assert.equal(spawned, 0, 'a missing binary must not be probed');

  // On disk but mute: `--version` exits nonzero, or exits 0 printing nothing. Both are unusable.
  for (const res of [
    { ok: false, code: 1, stdout: '', stderr: 'boom', error: 'exit 1' },
    { ok: true, code: 0, stdout: '   \n', stderr: '', error: null },
  ]) {
    const unusable = await checkClassifier(FIXTURE_SETTINGS, { isExecutable: () => true, run: async () => res });
    assert.equal(unusable.ok, false);
    assert.equal(unusable.reason, 'classifier binary unusable');
    assert.equal(unusable.bin, FIXTURE_SETTINGS.bin);
  }

  // And the positive control, or the two refusals above would prove nothing.
  const probeArgs = [];
  const ok = await checkClassifier(FIXTURE_SETTINGS, {
    isExecutable: () => true,
    run: async (req) => { probeArgs.push(req.args); return { ok: true, code: 0, stdout: '2.0.0 (fixture)\n', stderr: '', error: null }; },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.version, '2.0.0 (fixture)');
  // The probe reaches no model: it is `--version` and nothing else.
  assert.deepEqual(probeArgs, [['--version']]);
});

// ---- AC 4 — one prompt, no second copy ------------------------------------------------------------

test('AC4: the eval imports CLASSIFY_PROMPT from radar/classify.js and scores that exact string', async () => {
  const mod = await evalMod();
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // The imports are in the source, from the shipped module — not local constants, not re-reads.
  // Under the CLI transport the list is the prompt, the classifier, and the two halves of
  // resolution: nothing about which binary or which model is decided in this file.
  for (const name of ['CLASSIFY_PROMPT', 'classify', 'resolveClassifier', 'probeBinary', 'TRANSPORT_SHAPE']) {
    assert.match(src, new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\.\\./radar/classify\\.js'`),
      `the eval does not import ${name} from the shipped module`);
  }
  // And what the eval scores is the module's own invocation builder: `classify` is called, so the
  // prompt, the argv, the fixed tool ban and the envelope predicate all come from one place.
  assert.match(src, /await classify\(\{ text: job\.e\.text \}/);
  // No restated defaults. A model id or a flag written here is a second source of truth that can
  // drift away from the classifier the sweep actually runs. Every provider's literals are hunted,
  // not just the default one's, and the short ones are skipped because a two-character flag matches
  // incidental prose rather than a restatement. Provider NAMES are deliberately not on this list:
  // they belong in operator-facing help text, which is the one place naming them is the point.
  const restated = [classifyModule.TRANSPORT_SHAPE];
  for (const id of classifyModule.PROVIDER_IDS) {
    const p = classifyModule.PROVIDERS[id];
    restated.push(...p.defaultFlags);
    if (p.defaultModel) restated.push(p.defaultModel);
  }
  for (const literal of restated.filter((s) => s.length > 4)) {
    assert.equal(src.includes(literal), false, `the eval restates ${JSON.stringify(literal)} instead of importing it`);
  }
  // The exported surface the scoring layer uses is the shipped one, not a re-declaration.
  assert.equal(mod.CORPUS_PATH, CORPUS);
});

test('AC4: no second copy of the prompt exists anywhere in the repo', () => {
  // The needles are DERIVED from the shipped module at runtime, never typed here — so this test
  // file cannot itself become the second copy it is hunting for. Every substantial prompt line is
  // hunted separately, because a partial copy is as dangerous as a whole one: the eval would score
  // a prompt the sweep does not use. Lines carrying an apostrophe are skipped — the shipped source
  // escapes it, so the on-disk bytes differ from the runtime string for those lines only.
  const prompt = classifyModule.CLASSIFY_PROMPT;
  const needles = prompt.split('\n').filter((l) => l.trim().length > 20 && !l.includes("'"));
  assert.ok(needles.length >= 5, `only ${needles.length} needles — the prompt scan is too thin`);

  // node, never the shell `grep` (trap 16): that wrapper skips ignored files and never reads .git,
  // and produced three false "clean" verdicts on this repo.
  const skipDirs = new Set(['.git', 'node_modules', '.claude']);
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  })(REPO_ROOT);
  assert.ok(files.length > 50, `the walk found only ${files.length} files — it is not scanning the repo`);

  for (const needle of needles) {
    const hits = files.filter((p) => {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return false; }
      return text.includes(needle);
    });
    assert.deepEqual(hits, [CLASSIFY_PATH],
      `the prompt appears in more than one file: ${hits.map((p) => path.relative(REPO_ROOT, p)).join(', ')}`);
  }
});

// ---- the scoring layer, offline -------------------------------------------------------------------

test('the scoring layer is separately callable, builds the confusion matrix, and counts needs-decision misses apart', async () => {
  const { scoreCorpus, formatMatrix, MIN_CORRECT } = await evalMod();
  const entries = shippedEntries();

  // An injected spawn seam: it answers with each entry's own label, except two deliberate errors —
  // one on a needs-decision entry (the hard-zero class) and one on an offer-more entry.
  const wrong = new Map([
    [entries.find((e) => e.label === 'needs-decision').text, 'offer-more'],
    [entries.find((e) => e.label === 'offer-more').text, 'status-only'],
  ]);
  const byText = new Map(entries.map((e) => [e.text, e.label]));
  let calls = 0;
  const run = async (req) => {
    calls++;
    // The invocation really is the shipped one: same binary, same settings, same fixed tail.
    assert.equal(req.bin, FIXTURE_SETTINGS.bin);
    const a = readArgv(req.args);
    assert.equal(a.prompt, classifyModule.CLASSIFY_PROMPT);
    assert.equal(a.promptFlag, '--system-prompt');
    assert.equal(a.toolsFlag, '--allowed-tools');
    assert.equal(a.toolsValue, '', 'the tool ban must sit immediately before the system prompt');
    assert.equal(a.model, FIXTURE_SETTINGS.model);
    assert.equal(a.effort, FIXTURE_SETTINGS.effort);
    assert.ok(req.args.includes('--fixture-flag'), 'the configured flags did not reach the invocation');
    return { ok: true, code: 0, stdout: envelope(wrong.get(a.text) || byText.get(a.text)), stderr: '', error: null };
  };

  const r = await scoreCorpus(entries, { settings: FIXTURE_SETTINGS, run });
  assert.equal(calls, entries.length);
  assert.equal(r.total, entries.length);
  assert.equal(r.correct, entries.length - 2);
  assert.equal(r.needsDecisionMisses, 1);
  // The gate is two independent conditions: 14/16 alone does not pass with a needs-decision miss.
  assert.ok(r.correct >= MIN_CORRECT, 'the fixture run should clear the accuracy floor');
  assert.equal(r.correct >= MIN_CORRECT && r.needsDecisionMisses === 0, false,
    'a needs-decision miss must fail the gate even at passing accuracy');

  // The matrix accounts for every entry exactly once.
  let cells = 0;
  for (const actual of Object.keys(r.matrix)) for (const p of Object.keys(r.matrix[actual])) cells += r.matrix[actual][p];
  assert.equal(cells, entries.length);
  const rendered = formatMatrix(r.matrix);
  assert.match(rendered, /actual \\ pred/);
  for (const v of classifyModule.VERDICTS.concat(['unknown'])) assert.ok(rendered.includes(v), `matrix has no ${v} column`);
});

test('the scoring layer forwards the resolved provider, so a configured CLI is the one that gets invoked', async () => {
  const { scoreCorpus } = await evalMod();
  const entries = shippedEntries().slice(0, 2);
  const other = classifyModule.PROVIDER_IDS.find((id) => id !== classifyModule.DEFAULT_PROVIDER);

  // Each provider builds a different argv from the same settings. Scoring under one and seeing the
  // other's command line is the silent bug this asserts against: `classify` falls back to the
  // default provider when handed none, so a dropped field reads as a working run that measured the
  // wrong classifier.
  const argvFor = async (provider) => {
    const seen = [];
    await scoreCorpus(entries, {
      settings: Object.assign({}, FIXTURE_SETTINGS, { provider }),
      run: async (req) => { seen.push(req.args); return { ok: true, code: 0, stdout: envelope('status-only'), stderr: '', error: null }; },
    });
    return seen[0];
  };

  const asDefault = await argvFor(classifyModule.DEFAULT_PROVIDER);
  const asOther = await argvFor(other);
  assert.notDeepEqual(asOther, asDefault, `provider ${other} produced the same argv as ${classifyModule.DEFAULT_PROVIDER}`);
  assert.deepEqual(asDefault, classifyModule.classifyArgv(Object.assign({}, FIXTURE_SETTINGS), entries[0].text));
  assert.deepEqual(asOther, classifyModule.classifyArgv(Object.assign({}, FIXTURE_SETTINGS, { provider: other }), entries[0].text));
});

test('an unknown verdict counts as a miss, and as a needs-decision miss when the entry was one', async () => {
  const { scoreCorpus } = await evalMod();
  const entries = shippedEntries().filter((e) => e.label === 'needs-decision').slice(0, 2);
  // A transport that always fails: `classify` retries once, then answers `unknown · classifier
  // unreachable`.
  const run = async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: 'exit 1' });
  const r = await scoreCorpus(entries, { settings: FIXTURE_SETTINGS, run });
  assert.equal(r.correct, 0);
  assert.equal(r.needsDecisionMisses, 2);
  assert.equal(r.rows.every((row) => row.got === 'unknown'), true);
  assert.equal(r.matrix['needs-decision'].unknown, 2);
});

test('the whole runner scores end to end against a stubbed classifier, and the gate does the arithmetic', async () => {
  const { main, EXIT_OK, EXIT_GATE_FAILED } = await evalMod();
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    classifierBin: FIXTURE_SETTINGS.bin,
    classifierModel: FIXTURE_SETTINGS.model,
    classifierEffort: FIXTURE_SETTINGS.effort,
    classifierFlags: FIXTURE_SETTINGS.flags,
    repos: [],
  }));
  const entries = shippedEntries();
  const byText = new Map(entries.map((e) => [e.text, e.label]));
  const firstNeedsDecision = entries.find((e) => e.label === 'needs-decision');

  const capture = () => {
    const chunks = [];
    return { write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
  };
  const invoke = async (answer) => {
    const stdout = capture();
    const stderr = capture();
    const code = await main([], { RADAR_DIR: dir, HOME: tmpdir() }, {
      stdout,
      stderr,
      isExecutable: () => true,
      run: async (req) => {
        if (req.args.length === 1 && req.args[0] === '--version') {
          return { ok: true, code: 0, stdout: '2.0.0 (fixture)\n', stderr: '', error: null };
        }
        return { ok: true, code: 0, stdout: envelope(answer(readArgv(req.args).text)), stderr: '', error: null };
      },
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };

  // A perfect classifier passes, and says so with the settings it actually ran under.
  const perfect = await invoke((text) => byText.get(text));
  assert.equal(perfect.code, EXIT_OK, perfect.stderr);
  assert.match(perfect.stdout, /actual \\ pred/);
  assert.match(perfect.stdout, /^overall:\s+16\/16/m);
  assert.match(perfect.stdout, /^needs-decision misses: 0/m);
  assert.match(perfect.stdout, /\nPASS\n/);
  assert.ok(perfect.stdout.includes(FIXTURE_SETTINGS.bin), 'the run did not report which binary it used');
  assert.ok(perfect.stdout.includes(FIXTURE_SETTINGS.model), 'the run did not report which model it used');

  // One needs-decision miss fails the gate on its own, at 15/16 — well clear of the accuracy floor.
  const oneMiss = await invoke((text) => (text === firstNeedsDecision.text ? 'offer-more' : byText.get(text)));
  assert.equal(oneMiss.code, EXIT_GATE_FAILED);
  assert.match(oneMiss.stdout, /^overall:\s+15\/16/m);
  assert.match(oneMiss.stdout, /^needs-decision misses: 1/m);
  assert.match(oneMiss.stdout, /^\s*MISS fixture-inbox-\d+\s+expected needs-decision, got offer-more/m);
  assert.match(oneMiss.stdout, /\nFAIL\n/);
});
