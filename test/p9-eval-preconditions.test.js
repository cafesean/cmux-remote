'use strict';
// S-004 — the tier-1 half of the classifier eval: the preconditions, the credential assertion, and
// the source rule that keeps the eval honest.
//
// WHAT THIS FILE IS FOR. `npm run test:eval:inbox` costs money and needs a key, so it cannot be a
// unit test. What CAN be proved offline is everything that decides whether it is allowed to run at
// all: that the corpus is still synthetic, that a drifted corpus refuses to be scored rather than
// scored anyway, that a missing credential is named rather than guessed at, and that the prompt
// being scored is the prompt that ships. Those are the parts that fail silently if unproved.
//
// NOTHING HERE TOUCHES THE NETWORK, AND THAT IS STRUCTURAL, NOT LUCK. The precondition layer and
// the scoring layer are separate exports of scripts/eval-inbox.mjs: the precondition tests import
// and call the first one, which reads a string and returns a verdict — no env, no credential, no
// socket. The one test that exercises the scoring layer injects `http`. And every child-process run
// below is arranged to exit BEFORE scoring: either a precondition fails, or the key env is unset.
// The children are spawned with an env of exactly one variable, so a real key in the developer's
// shell cannot leak in and turn a refusal into a billed run.
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
// lookup lands in an empty temp directory and no ambient credential exists to be found.
function runEval(corpusPath, opts) {
  const o = opts || {};
  const env = Object.assign({ RADAR_DIR: o.radarDir || tmpdir() }, o.env || {});
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
  // The control: the shipped corpus clears every precondition and stops at the credential, not
  // before it. If this run refused earlier, the violations below would prove nothing.
  const control = runEval(CORPUS);
  assert.notEqual(control.status, 0);
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
  // The set is the story's list plus B1's fixed owner-identifier patterns.
  for (const n of ['uuid', 'session-url', 'home-path', 'issue-key', 'owner-name', 'codename', 'machine-name', 'infra-id', 'email', 'credential']) {
    assert.ok(names.includes(n), `no pattern named ${n}`);
  }
  // Each pattern is live: a constructed sample of its shape trips it, one at a time.
  const samples = {
    uuid: SYNTHETIC_UUID,
    'session-url': 'https://claude.ai/code/session' + '/x',
    'home-path': '/Volumes/fixture-disk/work',
    'issue-key': ['ABC', 'DEF'].join('').slice(0, 0) + 'CAD' + '-1234',
    'owner-name': ['sean', 'liao'].join(''),
    codename: ['cad', 'ra'].join(''),
    'machine-name': ['mac', '-mini'].join(''),
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

// ---- AC 3 — the credential is asserted BY NAME ----------------------------------------------------

test('AC3: with the key env unset the run exits non-zero naming the variable and reports no score', () => {
  const r = runEval(CORPUS);
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 3, 'expected the no-credential exit code');
  assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  assert.match(r.stderr, /nothing was scored/);
  // Every precondition passed first — this refusal is the credential's, not a corpus failure.
  assert.match(r.stdout, /ok\s+P6/);
  assertScoredNothing(r);
});

test('AC3: the named variable comes from the normalized config, not a hardcoded default', () => {
  const dir = tmpdir();
  // §5.1.4 — the config names the variable and never carries the secret.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierKeyRef: 'FIXTURE_CLASSIFIER_KEY', repos: [] }));
  const r = runEval(CORPUS, { radarDir: dir });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /FIXTURE_CLASSIFIER_KEY/);
  assert.equal(/ANTHROPIC_API_KEY/.test(r.stderr), false, 'fell back to the default despite a configured ref');
  assertScoredNothing(r);
});

test('AC3: resolveKeyRef defaults to the shipped key ref and readKey never returns whitespace', async () => {
  const { resolveKeyRef, readKey } = await evalMod();
  const dir = tmpdir();
  assert.equal(await resolveKeyRef({ RADAR_DIR: dir }, {}), classifyModule.DEFAULT_KEY_REF);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ classifierKeyRef: '  FIXTURE_REF  ', repos: [] }));
  assert.equal(await resolveKeyRef({ RADAR_DIR: dir }, {}), 'FIXTURE_REF');
  assert.equal(readKey({ FIXTURE_REF: '   ' }, 'FIXTURE_REF'), null);
  assert.equal(readKey({}, 'FIXTURE_REF'), null);
  assert.equal(readKey({ FIXTURE_REF: ' fixture-key-value ' }, 'FIXTURE_REF'), 'fixture-key-value');
});

// ---- AC 4 — one prompt, no second copy ------------------------------------------------------------

test('AC4: the eval imports CLASSIFY_PROMPT from radar/classify.js and scores that exact string', async () => {
  const mod = await evalMod();
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // The import is in the source, from the shipped module — not a local constant, not a re-read.
  assert.match(src, /import\s*\{[^}]*\bCLASSIFY_PROMPT\b[^}]*\}\s*from\s*'\.\.\/radar\/classify\.js'/);
  assert.match(src, /import\s*\{[^}]*\bVERDICT_SCHEMA\b[^}]*\}\s*from\s*'\.\.\/radar\/classify\.js'/);
  assert.match(src, /import\s*\{[^}]*\bclassify\b[^}]*\}\s*from\s*'\.\.\/radar\/classify\.js'/);
  // And what the eval scores is the module's own request builder: `classify` is called, so the
  // prompt, the schema, the model and max_tokens all come from one place by construction.
  assert.match(src, /await classify\(\{ text: job\.e\.text \}/);
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

  // An injected transport: it answers with each entry's own label, except two deliberate errors —
  // one on a needs-decision entry (the hard-zero class) and one on an offer-more entry.
  const wrong = new Map([
    [entries.find((e) => e.label === 'needs-decision').text, 'offer-more'],
    [entries.find((e) => e.label === 'offer-more').text, 'status-only'],
  ]);
  const byText = new Map(entries.map((e) => [e.text, e.label]));
  let calls = 0;
  const http = async (req) => {
    calls++;
    const sent = JSON.parse(req.body);
    // The request really is the shipped one: same prompt, same schema, same model.
    assert.equal(sent.system, classifyModule.CLASSIFY_PROMPT);
    assert.equal(sent.model, classifyModule.CLASSIFIER_MODEL);
    assert.deepEqual(sent.output_config.format.schema, classifyModule.VERDICT_SCHEMA);
    const text = sent.messages[0].content;
    const verdict = wrong.get(text) || byText.get(text);
    return { ok: true, status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ verdict, reason: 'fixture' }) }] } };
  };

  const r = await scoreCorpus(entries, { key: 'fixture-key-not-a-credential', http });
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

test('an unknown verdict counts as a miss, and as a needs-decision miss when the entry was one', async () => {
  const { scoreCorpus } = await evalMod();
  const entries = shippedEntries().filter((e) => e.label === 'needs-decision').slice(0, 2);
  // A transport that always fails: `classify` answers `unknown · classifier unreachable`.
  const http = async () => ({ ok: false, status: 0, body: null });
  const r = await scoreCorpus(entries, { key: 'fixture-key-not-a-credential', http });
  assert.equal(r.correct, 0);
  assert.equal(r.needsDecisionMisses, 2);
  assert.equal(r.rows.every((row) => row.got === 'unknown'), true);
  assert.equal(r.matrix['needs-decision'].unknown, 2);
});
