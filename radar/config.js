'use strict';
// ~/.radar/config.json — an explicit allowlist. Radar NEVER discovers repos by walking the disk
// (that is how you end up inside app-api's ELOOP node_modules).
//
// Failure policy, per spec §M1: a malformed config is never a crash and never a silent default.
// Bad entries are skipped and named in `sources.config.error`; the good ones still scan.
const path = require('path');
const { readJson } = require('./store');

const CONFIG_VERSION = 1;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  role: 'leader',
  collectorId: null,              // null -> os.hostname() at collector construction
  leaderBaseUrl: null,
  leaderTokenRef: null,
  scanIntervalMin: 10,
  sessionSweepSec: 60,
  timeouts: { gitFetchSec: 20, bridgeMs: 8000, deployMs: 10000 },
  repos: [],
  // ---- p6 handoff (spec §4.7) — eleven keys. normalizeConfig builds an explicit object literal,
  // i.e. a WHITELIST, so a key absent from here is silently dropped and reads as its default
  // forever. Every one of these must therefore also appear in the `config` literal below.
  polyrepoRoot: null,              // null -> unconfigured; a multi-repo dispatch then 422s workdir_unresolved
  claudeBin: null,                // null -> $HOME/.local/bin/claude, resolved at use time
  serverBaseUrl: 'http://127.0.0.1:8080',
  serverTokenRef: 'SERVER_TOKEN', // the NAME of the env var; never the value
  captureQuietMs: 600000,
  sessionQuietMs: 1800000,
  goneGraceMs: 600000,
  confirmMs: 20000,
  discardKillMs: 5000,
  previewTtlMs: 120000,
  seedMaxBytes: 12288,
  // ---- p9 §5.1.4 — the classifier block. The inbox classifier does NOT call an HTTP API and holds
  // no credential: it shells out to a local agent CLI in print mode, the same way the handoff
  // dispatcher does. There is therefore nothing secret to name here, only which CLI and how to
  // invoke it. Every key exists so the classifier can be retuned WITHOUT a code change, because the
  // sweep runs every 60 seconds and an untuned classifier is a recurring bill.
  //
  // `claude` is the default for continuity — a machine that can dispatch a handoff can already
  // classify — not because it is the better host. `codex` enforces the answer shape with
  // `--output-schema` and can shed its ambient config without falling back to an API key, which
  // claude's `--bare` cannot. See PROVIDERS in classify.js.
  classifierProvider: 'claude',    // claude | codex
  classifierBin: null,             // null -> `claudeBin` (claude only) -> $HOME/.local/bin/<provider>
  //
  // MODEL AND FLAGS DEFAULT TO NULL, MEANING "LET THE PROVIDER DECIDE", and that is load-bearing
  // now that there are two. A concrete default here would be one CLI's vocabulary imposed on the
  // other — a claude model name handed to codex, or claude's `--strict-mcp-config` sent to a CLI
  // that has never heard of it. Each provider carries its own pair in classify.js; these keys
  // override that choice, they do not seed it.
  classifierModel: null,
  classifierEffort: 'low',         // low | medium | high | xhigh | max
  //
  // An explicit `[]` is honoured and means "no flags at all" — see strList. Levers deliberately NOT
  // defaulted because neither has been measured here: a hard per-call spend cap (`--max-budget-usd`
  // on claude) — set it once the eval reports a real per-classification cost, since an uncalibrated
  // cap turns every verdict into `unknown` and silently restores the noise feed — and dropping the
  // built-in tool definitions from the prompt entirely, where the fixed tool ban only forbids
  // calling them.
  classifierFlags: null,
};

// §5.2.5. `claude --help`: "Effort level for the current session (low, medium, high, xhigh, max)".
// codex spells the same idea as a config override (`model_reasoning_effort`), which is why the
// provider owns the spelling and this list stays the single vocabulary an operator writes.
const CLASSIFIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Kept in step with PROVIDERS in classify.js. Duplicated rather than imported because config.js is
// the schema layer and must not take a dependency on the module it configures.
const CLASSIFIER_PROVIDERS = ['claude', 'codex'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
// The string counterpart of `num`, same silence: a non-empty trimmed string wins, anything else
// takes the default, and no issue is pushed. `leaderBaseUrl` already worked this way inline.
const str = (v, dflt) => (typeof v === 'string' && v.trim() ? v.trim() : dflt);
// The array counterpart. An explicit `[]` is HONOURED — an operator who empties the classifier flag
// list means it, and silently restoring the defaults would make the emptiest possible config the one
// that cannot be expressed. Only a non-array falls back.
// A null default is not an empty list — it is "no opinion, let the provider choose", and it must
// survive normalization as null so classify.js can tell the two apart.
const strList = (v, dflt) => (Array.isArray(v)
  ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
  : (Array.isArray(dflt) ? dflt.slice() : null));

// Every early return hands out its own copy of the mutable defaults; a caller that pushes onto
// `config.classifierFlags` must not be editing DEFAULTS for the rest of the process.
const defaultConfig = () => Object.assign({}, DEFAULTS, {
  timeouts: Object.assign({}, DEFAULTS.timeouts),
  repos: DEFAULTS.repos.slice(),
  classifierFlags: Array.isArray(DEFAULTS.classifierFlags) ? DEFAULTS.classifierFlags.slice() : DEFAULTS.classifierFlags,
});

// Only the shape P1 consumes is validated hard. `deploy` is carried through untouched for S-005;
// unknown keys are ignored so an additive schema bump never breaks an older collector.
function validateRepo(raw, index, seenIds) {
  if (!isObj(raw)) return { error: `repos[${index}]: not an object` };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return { error: `repos[${index}]: missing id` };
  if (seenIds.has(id)) return { error: `repos[${index}] (${id}): duplicate id` };
  const p = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!p) return { error: `repos[${index}] (${id}): missing path` };
  if (!path.isAbsolute(p)) return { error: `repos[${index}] (${id}): path is not absolute` };

  let defaultBranches = ['develop', 'main'];
  if (raw.defaultBranches !== undefined) {
    if (!Array.isArray(raw.defaultBranches)) return { error: `repos[${index}] (${id}): defaultBranches is not an array` };
    defaultBranches = raw.defaultBranches.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim());
    if (defaultBranches.length === 0) return { error: `repos[${index}] (${id}): defaultBranches is empty` };
  }
  return { repo: { id, path: p, defaultBranches, deploy: isObj(raw.deploy) ? raw.deploy : null } };
}

// Pure — takes parsed JSON, returns a usable config plus the list of things it refused.
function normalizeConfig(raw) {
  const issues = [];
  if (!isObj(raw)) {
    return { config: defaultConfig(), issues: ['config root is not an object'] };
  }

  const version = raw.configVersion === undefined ? CONFIG_VERSION : raw.configVersion;
  // An unrecognised configVersion means we do not know what the keys mean. Reporting facts derived
  // from a schema we cannot read is exactly the "false green" the spec forbids, so we degrade to
  // ZERO repos and say so. Migrations are additive: absent keys take defaults, they never bump this.
  if (version !== CONFIG_VERSION) {
    return { config: defaultConfig(), issues: [`unknown configVersion ${JSON.stringify(version)} (this collector understands ${CONFIG_VERSION}); no repos scanned`] };
  }

  const role = raw.role === 'viewer' ? 'viewer' : 'leader';
  if (raw.role !== undefined && raw.role !== 'leader' && raw.role !== 'viewer') {
    issues.push(`role ${JSON.stringify(raw.role)} is not leader|viewer; defaulted to leader`);
  }

  // p9 §5.1.4. An out-of-enum effort is a typo, not a preference: it takes the default AND is named
  // in `sources.config.error`, the same treatment `role` gets. Silently running at `max` — or
  // silently running at `low` when the operator asked for `high` and misspelled it — is the kind of
  // quiet wrong answer this loader exists to refuse.
  const effort = CLASSIFIER_EFFORTS.indexOf(raw.classifierEffort) === -1 ? DEFAULTS.classifierEffort : raw.classifierEffort;
  if (raw.classifierEffort !== undefined && effort !== raw.classifierEffort) {
    issues.push(`classifierEffort ${JSON.stringify(raw.classifierEffort)} is not one of ${CLASSIFIER_EFFORTS.join('|')}; defaulted to ${DEFAULTS.classifierEffort}`);
  }

  // Same treatment, and it matters MORE here than for effort: an unrecognised provider silently
  // falling back to claude would spawn a different CLI than the operator configured, with a
  // different model behind it, while the config file on disk says otherwise. Named, not guessed.
  const provider = CLASSIFIER_PROVIDERS.indexOf(raw.classifierProvider) === -1 ? DEFAULTS.classifierProvider : raw.classifierProvider;
  if (raw.classifierProvider !== undefined && provider !== raw.classifierProvider) {
    issues.push(`classifierProvider ${JSON.stringify(raw.classifierProvider)} is not one of ${CLASSIFIER_PROVIDERS.join('|')}; defaulted to ${DEFAULTS.classifierProvider}`);
  }

  const t = isObj(raw.timeouts) ? raw.timeouts : {};
  const config = {
    configVersion: CONFIG_VERSION,
    role,
    collectorId: typeof raw.collectorId === 'string' && raw.collectorId.trim() ? raw.collectorId.trim() : null,
    leaderBaseUrl: typeof raw.leaderBaseUrl === 'string' && raw.leaderBaseUrl.trim() ? raw.leaderBaseUrl.trim() : null,
    leaderTokenRef: typeof raw.leaderTokenRef === 'string' && raw.leaderTokenRef.trim() ? raw.leaderTokenRef.trim() : null,
    scanIntervalMin: num(raw.scanIntervalMin, DEFAULTS.scanIntervalMin, 1, 24 * 60),
    sessionSweepSec: num(raw.sessionSweepSec, DEFAULTS.sessionSweepSec, 5, 3600),
    timeouts: {
      gitFetchSec: num(t.gitFetchSec, DEFAULTS.timeouts.gitFetchSec, 1, 300),
      bridgeMs: num(t.bridgeMs, DEFAULTS.timeouts.bridgeMs, 100, 120000),
      deployMs: num(t.deployMs, DEFAULTS.timeouts.deployMs, 100, 120000),
    },
    repos: [],
    // p6 §4.7. Numerics use `num`, which is the store's EXISTING convention and not what a reader
    // would guess: non-finite -> default, finite -> SILENT CLAMP into [min,max], never an issue.
    // Adopted unchanged so there is one answer to "what happens to a bad config value".
    polyrepoRoot: str(raw.polyrepoRoot, DEFAULTS.polyrepoRoot),
    claudeBin: str(raw.claudeBin, DEFAULTS.claudeBin),
    serverBaseUrl: str(raw.serverBaseUrl, DEFAULTS.serverBaseUrl),
    serverTokenRef: str(raw.serverTokenRef, DEFAULTS.serverTokenRef),
    captureQuietMs: num(raw.captureQuietMs, DEFAULTS.captureQuietMs, 1000, 86400000),
    sessionQuietMs: num(raw.sessionQuietMs, DEFAULTS.sessionQuietMs, 1000, 86400000),
    goneGraceMs: num(raw.goneGraceMs, DEFAULTS.goneGraceMs, 1000, 86400000),
    confirmMs: num(raw.confirmMs, DEFAULTS.confirmMs, 1000, 120000),
    discardKillMs: num(raw.discardKillMs, DEFAULTS.discardKillMs, 250, 60000),
    previewTtlMs: num(raw.previewTtlMs, DEFAULTS.previewTtlMs, 5000, 3600000),
    seedMaxBytes: num(raw.seedMaxBytes, DEFAULTS.seedMaxBytes, 1024, 1048576),
    // p9 §5.1.4 — `str` is exactly the spec's rule: a non-empty trimmed string wins, anything else
    // (absent, empty, whitespace, a number, an object) takes the default. classify.js reads THESE,
    // the normalized values; nothing reads the raw file for any classifier setting.
    //
    // `classifierBin` is null far more often than not, and that is the intended shape: for the
    // claude provider null falls through to `claudeBin`, so a machine with a non-standard claude
    // install names it ONCE. The separate key exists for the case the fallback cannot express —
    // pointing the classifier at a different or cheaper binary than the one that spawns interactive
    // sessions, or naming the codex binary, for which `claudeBin` is deliberately NOT consulted.
    classifierProvider: provider,
    classifierBin: str(raw.classifierBin, DEFAULTS.classifierBin),
    classifierModel: str(raw.classifierModel, DEFAULTS.classifierModel),
    classifierEffort: effort,
    classifierFlags: strList(raw.classifierFlags, DEFAULTS.classifierFlags),
  };

  if (config.role === 'viewer' && !config.leaderBaseUrl) issues.push('role=viewer but leaderBaseUrl is unset');

  if (raw.repos === undefined) {
    issues.push('no repos configured');
  } else if (!Array.isArray(raw.repos)) {
    issues.push('repos is not an array');
  } else {
    const seen = new Set();
    raw.repos.forEach((r, i) => {
      const v = validateRepo(r, i, seen);
      if (v.error) { issues.push(v.error); return; }
      seen.add(v.repo.id);
      config.repos.push(v.repo);
    });
    if (config.repos.length === 0 && raw.repos.length > 0) issues.push('every repo entry was rejected');
  }

  return { config, issues };
}

// Returns { config, source } where source is the `sources.config` fragment. Never throws.
async function loadConfig(configPath, now) {
  const observedAt = new Date(now == null ? Date.now() : now).toISOString();
  const read = await readJson(configPath, undefined);
  if (!read.ok) {
    const { config } = normalizeConfig(null);
    return { config, source: { status: 'error', observedAt, error: read.error } };
  }
  if (read.missing) {
    const { config } = normalizeConfig(null);
    return { config, source: { status: 'error', observedAt, error: `config missing: ${configPath}` } };
  }
  const { config, issues } = normalizeConfig(read.value);
  const source = issues.length
    ? { status: 'error', observedAt, error: issues.join('; ') }
    : { status: 'ok', observedAt };
  return { config, source };
}

module.exports = { CONFIG_VERSION, DEFAULTS, CLASSIFIER_EFFORTS, CLASSIFIER_PROVIDERS, normalizeConfig, loadConfig, validateRepo };
