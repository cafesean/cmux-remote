// eval-inbox.mjs — S-004. Score the SHIPPED classifier prompt against a synthesised labelled
// corpus, and refuse to score at all unless the corpus is still what it claims to be.
//
// Run it with `npm run test:eval:inbox`. It is NOT part of `node --test test/*.test.js`: it makes
// real API calls and costs real money. The tier-1 half of this story — the preconditions, the
// credential assertion, the source rule below — is proved offline in test/p9-eval-preconditions.test.js
// against the layers this file exports.
//
// ------------------------------------------------------------------------------------------------
// THE ONE PROMPT. This file imports CLASSIFY_PROMPT, VERDICT_SCHEMA and the model from
// radar/classify.js and restates none of them. It does not even rebuild the request: it calls the
// shipped `classify()`, so what gets scored is byte-identical to what runs in a sweep, including
// max_tokens and the success predicate. A second copy of the prompt would let the eval pass while
// the shipped classifier fails, which is the one failure mode an eval must not have. A source
// assertion in the tier-1 suite proves no second copy exists anywhere in the repo.
//
// ------------------------------------------------------------------------------------------------
// WHY THE PRECONDITIONS COME FIRST, AND WHY THEY ARE THIS PARANOID.
//
// This repository is PUBLIC. A corpus is the one artifact in this feature made of the exact
// material that must never ship: what sessions actually said, and which sessions said it. p7 walked
// this path already and the repo had to be deleted and recreated. So the corpus is SYNTHESISED
// throughout — invented prose, invented ids, invented file names, invented projects — and this file
// enforces as much of that as an offline check can.
//
// It cannot enforce all of it. An offline test cannot know the live machine's session ids, so it
// does not try: it enforces a RESERVED SYNTHETIC GRAMMAR instead. Every id must match
// ^fixture-inbox-\d+$, a shape no real id has, which turns "is this id real?" — unanswerable — into
// "is this id of the invented form?" — decidable, offline, forever. Alongside it sits a fixed set
// of shapes that are never invented: a UUID token, a session URL, an absolute home path, an owner
// identifier. Values no offline check can know are covered by the two backstops that already
// exist: the per-entry manual review in the story's DoD, and the B1 scratch-clone sweep.
//
// The preconditions run BEFORE the credential is even looked at, and long before anything is sent
// anywhere. A corpus that has drifted must never reach the wire.
// ------------------------------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classify, CLASSIFY_PROMPT, VERDICT_SCHEMA, CLASSIFIER_MODEL, CLASSIFIER_VERSION, DEFAULT_KEY_REF, VERDICTS } from '../radar/classify.js';
import { loadConfig } from '../radar/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

export const CORPUS_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'inbox-corpus.json');

// The gate. Overall accuracy is a percentage; a missed needs-decision is not. A needs-decision the
// classifier calls anything else is a question the operator never sees — principle 2, the one
// direction this feature is not allowed to fail in — so its budget is zero, not "few".
export const MIN_CORRECT = 14;
export const MIN_ENTRIES = 16;
export const MIN_NEEDS_DECISION = 2;

// Exit codes, distinct so a caller can tell WHY it refused.
export const EXIT_OK = 0;
export const EXIT_GATE_FAILED = 1;
export const EXIT_PRECONDITION = 2;
export const EXIT_NO_CREDENTIAL = 3;

export const ID_GRAMMAR = /^fixture-inbox-\d+$/;

// Assembled from fragments, deliberately. This file is itself a blob the B1 hygiene sweep scans
// with these very patterns — a literal owner name written here would make the eval script the hit
// it exists to prevent. Each fragment is chosen so that no fragment matches on its own.
const frag = (...parts) => parts.join('');
const alt = (...parts) => parts.join('|');

// The shapes that are never invented. A corpus entry containing one of these did not come from
// someone's imagination, whatever else it looks like.
export const FORBIDDEN_PATTERNS = [
  ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['session-url', /claude\.ai\/code\/session|\bsession_[A-Za-z0-9_-]{8,}/i],
  ['home-path', /\/(Users|Volumes)\//],
  ['issue-key', /\b(CAD|TRI|YMS)-\d+\b/],
  ['owner-name', new RegExp(alt(frag('sean', 'liao'), frag('cafe', 'sean')), 'i')],
  ['codename', new RegExp('\\b(' + alt(frag('cad', 'ra'), frag('cad', 'raos'), frag('yo', 'bo'), frag('yo', 'bolabs'), frag('jet', 'devs'), frag('qra', 'ved')) + ')\\b', 'i')],
  ['machine-name', /\bmac-(max|mini)\b/i],
  ['infra-id', /\b(prj|team)_[A-Za-z0-9]{6,}/],
  ['email', /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['credential', new RegExp(alt('gh[pousr]_[A-Za-z0-9]{20,}', 'xox[baprs]-', 'AKIA[0-9A-Z]{16}', frag('sk', '-ant-'), frag('gl', 'pat-'), 'BEGIN [A-Z ]*PRIVATE KEY'))],
];

// ---- the precondition layer ---------------------------------------------------------------------
// Pure, synchronous, offline, and separately importable: it takes the corpus file's TEXT and
// answers with a verdict. It reads no environment, resolves no credential and opens no socket, so
// the tier-1 suite can exercise every branch of it with nothing configured at all.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Names the offending entry the way an operator finds it again: by position AND by id. A text
// violation names the entry but never echoes the matched text — that text is the thing we are
// trying not to publish.
const where = (i, entry) => {
  const id = entry && typeof entry.id === 'string' ? entry.id : '(no id)';
  return `entry #${i + 1} (id ${JSON.stringify(id)})`;
};

/**
 * @param {string} rawText the corpus file, verbatim
 * @returns {{ok: boolean, checks: Array<{id: string, name: string, ok: boolean, detail: string}>, failures: string[], entries: Array|null}}
 */
export function checkPreconditions(rawText) {
  const checks = [];
  const record = (id, name, ok, detail) => { checks.push({ id, name, ok, detail }); return ok; };

  // P1 — the corpus parses, and is a list of {id, text, label} objects with string fields.
  let entries = null;
  let parseDetail = '';
  try {
    const parsed = JSON.parse(String(rawText));
    if (!Array.isArray(parsed)) {
      parseDetail = 'corpus is not a JSON array';
    } else {
      const bad = [];
      parsed.forEach((e, i) => {
        if (!isObj(e)) { bad.push(`${where(i, e)}: not an object`); return; }
        if (typeof e.id !== 'string' || !e.id) bad.push(`${where(i, e)}: missing string id`);
        if (typeof e.text !== 'string' || !e.text.trim()) bad.push(`${where(i, e)}: missing non-empty string text`);
        if (typeof e.label !== 'string' || !e.label) bad.push(`${where(i, e)}: missing string label`);
      });
      if (bad.length) parseDetail = bad.join('; ');
      else entries = parsed;
    }
  } catch (e) {
    parseDetail = `corpus does not parse as JSON: ${e && e.message ? e.message : String(e)}`;
  }
  record('P1', 'corpus parses into {id, text, label} entries', entries !== null, entries !== null ? `${entries.length} entries` : parseDetail);

  // Every later check reads `entries`. When P1 failed there is nothing to read, so they are
  // reported as not-run rather than silently passing on an empty list — a precondition that passes
  // vacuously is worse than one that fails.
  const skipped = (id, name) => record(id, name, false, 'not run — P1 failed');
  if (entries === null) {
    skipped('P2', `at least ${MIN_ENTRIES} entries`);
    skipped('P3', `at least ${MIN_NEEDS_DECISION} needs-decision entries`);
    skipped('P4', 'at least one offer-more entry ending in a question mark');
    skipped('P5', 'every label is in the verdict enum');
    skipped('P6', 'every id is synthetic and no entry carries a forbidden token');
    return { ok: false, checks, failures: failuresOf(checks), entries: null };
  }

  // P2 — size. A corpus small enough to be lucky proves nothing.
  record('P2', `at least ${MIN_ENTRIES} entries`, entries.length >= MIN_ENTRIES,
    `${entries.length} entries`);

  // P3 — the class the gate is strictest about must actually be present to be strict about.
  const needs = entries.filter((e) => e.label === 'needs-decision');
  record('P3', `at least ${MIN_NEEDS_DECISION} needs-decision entries`, needs.length >= MIN_NEEDS_DECISION,
    `${needs.length} needs-decision entries`);

  // P4 — trap 3. The loudest negative in the measured corpus ends in a question mark, and a corpus
  // without that case would score well while proving nothing about the only ambiguity that matters.
  const offerQ = entries.filter((e) => e.label === 'offer-more' && e.text.trim().endsWith('?'));
  record('P4', 'at least one offer-more entry ending in a question mark', offerQ.length >= 1,
    offerQ.length ? `${offerQ.length} such entries, first: ${JSON.stringify(offerQ[0].id)}` : 'none — trap 3 is unrepresented');

  // P5 — labels are the model's own enum. `unknown` is this module's answer, never a label.
  const badLabels = entries
    .map((e, i) => (VERDICTS.indexOf(e.label) === -1 ? `${where(i, e)}: label ${JSON.stringify(e.label)} is not one of ${VERDICTS.join(' | ')}` : null))
    .filter(Boolean);
  record('P5', 'every label is in the verdict enum', badLabels.length === 0,
    badLabels.length ? badLabels.join('; ') : `all ${entries.length} labels in enum`);

  // P6 — the privacy precondition. Synthetic grammar on every id, plus the never-invented shapes on
  // both id and text.
  const privacy = [];
  entries.forEach((e, i) => {
    if (!ID_GRAMMAR.test(e.id)) {
      privacy.push(`${where(i, e)}: id does not match the reserved synthetic grammar ${String(ID_GRAMMAR)}`);
    }
    for (const [name, re] of FORBIDDEN_PATTERNS) {
      // The id is named because naming it is how the entry gets found; the text never is.
      if (re.test(e.id)) privacy.push(`${where(i, e)}: id matches forbidden pattern ${name}`);
      if (re.test(e.text)) privacy.push(`${where(i, e)}: text matches forbidden pattern ${name}`);
    }
  });
  record('P6', 'every id is synthetic and no entry carries a forbidden token', privacy.length === 0,
    privacy.length ? privacy.join('; ') : `${entries.length} ids synthetic, 0 forbidden tokens`);

  const failures = failuresOf(checks);
  return { ok: failures.length === 0, checks, failures, entries: failures.length === 0 ? entries : null };
}

function failuresOf(checks) {
  return checks.filter((c) => !c.ok).map((c) => `precondition ${c.id} FAILED (${c.name}): ${c.detail}`);
}

/** Read the corpus file. A read failure is a P1 failure, not an exception. */
export function readCorpusText(file) {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { ok: false, text: '', error: e && e.message ? e.message : String(e) };
  }
}

// ---- the credential, asserted by name -----------------------------------------------------------
// The config names the variable and never carries the secret (§5.2.5), so the failure message can
// name the variable safely — and must, because "no API key" without a name is a message the
// operator cannot act on. The VALUE is never printed, interpolated or logged anywhere in this file.

export async function resolveKeyRef(env, opts) {
  const o = opts || {};
  const radarDir = o.radarDir || (env && env.RADAR_DIR) || path.join(os.homedir(), '.radar');
  const configPath = o.configPath || path.join(radarDir, 'config.json');
  const { config } = await loadConfig(configPath);
  return (config && config.classifierKeyRef) || DEFAULT_KEY_REF;
}

export function readKey(env, ref) {
  const raw = env ? env[ref] : undefined;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key || null;
}

// ---- the scoring layer --------------------------------------------------------------------------
// Separately importable and separately callable, so the tier-1 suite can run every precondition
// without ever reaching this half of the file — no key, no network, no cost.

const COLUMNS = VERDICTS.concat(['unknown']);

export function emptyMatrix() {
  const m = {};
  for (const actual of VERDICTS) {
    m[actual] = {};
    for (const predicted of COLUMNS) m[actual][predicted] = 0;
  }
  return m;
}

/**
 * Score the corpus with the SHIPPED classifier. `deps.http` is injectable purely so the scoring
 * layer is testable at all; the real run passes none and `classify` uses its own transport.
 */
export async function scoreCorpus(entries, deps) {
  const d = deps || {};
  const key = d.key;
  const concurrency = Number.isFinite(Number(d.concurrency)) ? Number(d.concurrency) : 4;
  const rows = new Array(entries.length);
  const queue = entries.map((e, i) => ({ e, i }));

  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const verdict = await classify({ text: job.e.text }, { key, http: d.http });
      rows[job.i] = {
        id: job.e.id,
        expected: job.e.label,
        got: verdict.verdict,
        reason: verdict.reason,
        correct: verdict.verdict === job.e.label,
      };
      if (typeof d.onResult === 'function') d.onResult(rows[job.i]);
    }
  };
  const pool = [];
  for (let i = 0; i < Math.min(concurrency, entries.length); i++) pool.push(worker());
  await Promise.all(pool);

  const matrix = emptyMatrix();
  let correct = 0;
  let needsDecisionMisses = 0;
  for (const r of rows) {
    if (matrix[r.expected] && matrix[r.expected][r.got] !== undefined) matrix[r.expected][r.got]++;
    if (r.correct) correct++;
    else if (r.expected === 'needs-decision') needsDecisionMisses++;
  }
  return { rows, matrix, correct, total: rows.length, needsDecisionMisses };
}

export function formatMatrix(matrix) {
  const label = (s) => s.padEnd(15);
  const cell = (n) => String(n).padStart(14);
  const lines = [];
  lines.push(label('actual \\ pred') + COLUMNS.map(cell).join(''));
  for (const actual of VERDICTS) {
    lines.push(label(actual) + COLUMNS.map((p) => cell(matrix[actual][p])).join(''));
  }
  return lines.join('\n');
}

// ---- the runner ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { corpus: CORPUS_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus' && argv[i + 1]) { out.corpus = argv[++i]; continue; }
  }
  return out;
}

/**
 * @returns {Promise<number>} the process exit code. Every refusal is non-zero and says why.
 */
export async function main(argv, env, io) {
  const out = (io && io.stdout) || process.stdout;
  const err = (io && io.stderr) || process.stderr;
  const args = parseArgs(argv || []);

  out.write(`corpus:     ${args.corpus}\n`);
  out.write(`model:      ${CLASSIFIER_MODEL}\n`);
  out.write(`classifier: ${CLASSIFIER_VERSION} (sha of model + prompt + schema)\n`);
  out.write(`prompt:     ${CLASSIFY_PROMPT.split('\n').length} lines, ${CLASSIFY_PROMPT.length} chars, imported from radar/classify.js\n`);
  out.write(`schema:     ${Object.keys(VERDICT_SCHEMA.properties).join(', ')}\n\n`);

  // 1 — preconditions. Before the credential, before the network, before anything is scored.
  const read = readCorpusText(args.corpus);
  if (!read.ok) {
    err.write(`precondition P1 FAILED (corpus parses into {id, text, label} entries): cannot read ${args.corpus}: ${read.error}\n`);
    err.write('eval-inbox: corpus preconditions failed — nothing was scored and no request was made.\n');
    return EXIT_PRECONDITION;
  }
  const verdict = checkPreconditions(read.text);
  for (const c of verdict.checks) out.write(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}  ${c.name} — ${c.ok ? c.detail : ''}\n`);
  out.write('\n');
  if (!verdict.ok) {
    for (const f of verdict.failures) err.write(`${f}\n`);
    err.write('eval-inbox: corpus preconditions failed — nothing was scored and no request was made.\n');
    return EXIT_PRECONDITION;
  }

  // 2 — the credential, BY NAME. The name is safe to print; the value is never touched.
  const ref = await resolveKeyRef(env || process.env, {});
  const key = readKey(env || process.env, ref);
  if (!key) {
    err.write(`eval-inbox: no classifier key. Set the ${ref} environment variable (the config names the variable, never the secret).\n`);
    err.write('eval-inbox: nothing was scored.\n');
    return EXIT_NO_CREDENTIAL;
  }

  // 3 — score. This is the part that costs money, and it is the last thing that happens.
  const scored = await scoreCorpus(verdict.entries, { key });

  out.write(formatMatrix(scored.matrix) + '\n\n');
  for (const r of scored.rows) {
    if (r.correct) continue;
    out.write(`  MISS ${r.id}  expected ${r.expected}, got ${r.got} — ${r.reason}\n`);
  }
  if (scored.correct !== scored.total) out.write('\n');
  out.write(`overall:              ${scored.correct}/${scored.total} (gate: >= ${MIN_CORRECT}/${scored.total})\n`);
  out.write(`needs-decision misses: ${scored.needsDecisionMisses} (gate: 0)\n`);

  const pass = scored.correct >= MIN_CORRECT && scored.needsDecisionMisses === 0;
  out.write(`\n${pass ? 'PASS' : 'FAIL'}\n`);
  return pass ? EXIT_OK : EXIT_GATE_FAILED;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`eval-inbox: ${e && e.stack ? e.stack : String(e)}\n`);
    process.exitCode = EXIT_GATE_FAILED;
  });
}
