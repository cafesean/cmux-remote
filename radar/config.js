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
  // ---- p9 §5.1.4. The NAME of the environment variable holding the classifier key, never the key.
  // Same convention as `serverTokenRef`/`BRIDGE_SECRET`: this file is world-readable config, so it
  // may only ever carry a pointer. `null` means the default, `ANTHROPIC_API_KEY`, resolved in
  // classify.js. It belongs here rather than on mod-sessions' raw-config path because
  // normalizeConfig is a WHITELIST — a key absent from this literal is silently dropped forever.
  classifierKeyRef: null,
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
// The string counterpart of `num`, same silence: a non-empty trimmed string wins, anything else
// takes the default, and no issue is pushed. `leaderBaseUrl` already worked this way inline.
const str = (v, dflt) => (typeof v === 'string' && v.trim() ? v.trim() : dflt);

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
    return { config: Object.assign({}, DEFAULTS, { timeouts: Object.assign({}, DEFAULTS.timeouts) }), issues: ['config root is not an object'] };
  }

  const version = raw.configVersion === undefined ? CONFIG_VERSION : raw.configVersion;
  // An unrecognised configVersion means we do not know what the keys mean. Reporting facts derived
  // from a schema we cannot read is exactly the "false green" the spec forbids, so we degrade to
  // ZERO repos and say so. Migrations are additive: absent keys take defaults, they never bump this.
  if (version !== CONFIG_VERSION) {
    const cfg = Object.assign({}, DEFAULTS, { timeouts: Object.assign({}, DEFAULTS.timeouts) });
    return { config: cfg, issues: [`unknown configVersion ${JSON.stringify(version)} (this collector understands ${CONFIG_VERSION}); no repos scanned`] };
  }

  const role = raw.role === 'viewer' ? 'viewer' : 'leader';
  if (raw.role !== undefined && raw.role !== 'leader' && raw.role !== 'viewer') {
    issues.push(`role ${JSON.stringify(raw.role)} is not leader|viewer; defaulted to leader`);
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
    // (absent, empty, whitespace, a number, an object) takes the default. classify.js reads THIS,
    // the normalized value; nothing reads the raw file for the credential ref.
    classifierKeyRef: str(raw.classifierKeyRef, DEFAULTS.classifierKeyRef),
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

module.exports = { CONFIG_VERSION, DEFAULTS, normalizeConfig, loadConfig, validateRepo };
