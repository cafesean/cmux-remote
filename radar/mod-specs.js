'use strict';
// mod-specs (S-009) — the spec vault as a ledger, and the real `spec` ladder cell.
//
// THE STAGE RULE IS TWO LINES AND ONE PROHIBITION (spec §M5):
//
//   folder exists                       -> draft
//   specs.md carries a GO verdict       -> done
//   NEVER read story_list.json statuses -> they demonstrably lie
//
// That last one is not stylistic. Verified on 2026-07-31: four stories of this very epic were
// built and the story file still said `pending` for all of them. A status field a human updates by
// hand is a wish; the folder and the verdict line are artifacts. Radar only reads artifacts.
//
// THE VERDICT LINE HAS FOUR SPELLINGS IN THE REAL VAULT. The spec writes `**Verdict:** GO`; the
// actual p5-radar specs.md says `**Verdict: GO**` (colon inside the bold) and wargame.md says
// `**Verdict: ACCEPT**`. Matching the spec's spelling literally would have marked every folder in
// the vault `draft` forever while every unit test passed. So the verdict is parsed as a TOKEN —
// find the word after `Verdict:`, strip markdown, compare to GO — which also means `NO-GO` and
// `ACCEPT` are correctly NOT done, where a naive /GO/ substring match would have called both done.
//
// SYMLINKS ARE SKIPPED, not followed. A vault with a symlink back into itself would otherwise walk
// forever, and this is the same class of bug as app-api's ELOOP node_modules (spec §9 trap 4).
// Radar's only defence against a cyclic filesystem is refusing to traverse links at all.
//
// AN UNREADABLE FOLDER COSTS THAT FOLDER, NOT THE SCAN. Every failure lands in `sources.specs` and
// the folder is skipped; the other 151 still report.
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const store = require('./store');

// No hardcoded home path: derived from os.homedir() so the module carries no username. Behaviour is
// unchanged for a machine whose vault sits at ~/Docs/_context, and any other layout sets
// `specs.root` in config.json, which every real deployment already does.
const DEFAULT_ROOT = path.join(os.homedir(), 'Main', '_context');
const SPECS_DIR = '_specs';
// `p5`, `p21.1`, `p108` — the numeral is everything before the first hyphen, and it is what the
// alias map keys on. `p5-radar` must never claim `p51-cache-layer`, which is why the boundary is
// the hyphen and not a prefix test.
const P_FOLDER_RE = /^(p\d+(?:\.\d+)*)(?:-(.*))?$/;
const VERDICT_RE = /Verdict\*{0,2}\s*:\s*\*{0,2}\s*([A-Za-z][A-Za-z0-9-]*)/i;
// A spec file large enough to be a mistake. specs.md in this vault tops out around 40 KB.
const MAX_SPEC_BYTES = 4 * 1024 * 1024;

// ---- config ------------------------------------------------------------------------------------

// Same rationale as mod-jira: normalizeConfig() drops sections it does not know about, so the P4
// modules read their own section straight from the config file.
//
// The block is REQUIRED to enable the module, and `{"specs": {}}` is enough. Defaulting to the
// vault path without being asked would make every collector — and every unrelated unit test —
// walk 152 real directories on a machine that may not even have the vault.
async function loadSpecsConfig(configPath) {
  if (!configPath) return { cfg: null, error: null };
  const read = await store.readJson(configPath, null);
  if (!read.ok) return { cfg: null, error: read.error };
  const raw = read.value && typeof read.value === 'object' ? read.value.specs : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { cfg: null, error: null };
  const root = typeof raw.root === 'string' && raw.root.trim() ? raw.root.trim() : DEFAULT_ROOT;
  if (!path.isAbsolute(root)) return { cfg: null, error: `specs.root is not absolute: ${root}` };
  return { cfg: { root }, error: null };
}

// ---- verdict parsing ------------------------------------------------------------------------------

// Returns the verdict TOKEN ("GO", "NO-GO", "ACCEPT", …) or null. Only the first Verdict line wins,
// which matches how the vault is written: the verdict lives in the header block.
function parseVerdict(text) {
  for (const line of String(text || '').split('\n')) {
    if (!/verdict/i.test(line)) continue;
    const m = line.match(VERDICT_RE);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

const isGo = (verdict) => verdict === 'GO';

// ---- scanning ---------------------------------------------------------------------------------------

// One readdir that never follows a link and never throws.
async function readDirSafe(dir, errors, label) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    errors.push(`${label}: ${e.code || 'read failed'} ${dir}`);
    return null;
  }
}

// Directory entries only, with symlinks refused outright — never resolved, never stat'ed through.
const realDirs = (entries) => (entries || []).filter((d) => d.isDirectory() && !d.isSymbolicLink());

async function scanSpecRoot(root, errors) {
  const folders = [];
  const skippedSymlinks = [];

  const projects = await readDirSafe(root, errors, 'specs root');
  if (projects === null) return { folders, skippedSymlinks, rootMissing: true };

  for (const entry of (projects || [])) {
    if (entry.isSymbolicLink()) { skippedSymlinks.push(path.join(root, entry.name)); continue; }
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

    const specsDir = path.join(root, entry.name, SPECS_DIR);
    const specEntries = await readDirSafe(specsDir, errors, `${entry.name}/_specs`);
    if (specEntries === null) continue;

    for (const d of specEntries) {
      if (d.isSymbolicLink()) { skippedSymlinks.push(path.join(specsDir, d.name)); continue; }
      if (!d.isDirectory()) continue;
      const m = d.name.match(P_FOLDER_RE);
      if (!m) continue;                                   // not a p<N> folder; not this module's business
      folders.push({
        specFolder: d.name,
        project: entry.name,
        path: path.join(specsDir, d.name),
        pNumeral: m[1].toLowerCase(),
        slug: m[2] || null,
        stage: 'draft',
        verdict: null,
      });
    }
  }
  return { folders, skippedSymlinks, rootMissing: false };
}

// Reads specs.md for one folder and promotes it to `done` on a GO verdict. An unreadable specs.md
// makes the FOLDER an error and skips it — never a guessed stage.
async function stageFolder(folder, errors) {
  const file = path.join(folder.path, 'specs.md');
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (e) {
    // No specs.md at all is not malformed: the folder exists, so the spec is a draft.
    if (e && e.code === 'ENOENT') return folder;
    errors.push(`${folder.project}/${folder.specFolder}: ${e.code || 'stat failed'} on specs.md`);
    return null;
  }
  // A symlinked specs.md is refused for the same reason a symlinked folder is.
  if (st.isSymbolicLink()) { errors.push(`${folder.project}/${folder.specFolder}: specs.md is a symlink, skipped`); return null; }
  if (!st.isFile()) { errors.push(`${folder.project}/${folder.specFolder}: specs.md is not a regular file, skipped`); return null; }
  if (st.size > MAX_SPEC_BYTES) { errors.push(`${folder.project}/${folder.specFolder}: specs.md is ${st.size} bytes, skipped`); return null; }

  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    errors.push(`${folder.project}/${folder.specFolder}: ${e.code || 'read failed'} on specs.md`);
    return null;
  }

  folder.verdict = parseVerdict(text);
  folder.stage = isGo(folder.verdict) ? 'done' : 'draft';
  return folder;
}

// ---- alias mapping -------------------------------------------------------------------------------------

// p-numeral -> epic key, from aliases.json. This is the same map mod-git uses for branches, which
// is what makes tagging a spec-orphan and tagging a branch the same act.
function buildNumeralIndex(aliases, warnings) {
  const index = new Map();
  const epics = (aliases && aliases.epics && typeof aliases.epics === 'object') ? aliases.epics : {};
  for (const key of Object.keys(epics).sort()) {
    for (const a of (Array.isArray(epics[key]) ? epics[key] : [])) {
      if (typeof a !== 'string') continue;
      const token = a.trim().toLowerCase();
      if (!P_FOLDER_RE.test(token)) continue;             // word aliases map branches, not folders
      if (index.has(token)) {
        if (warnings) warnings.push(`spec alias ${token} is claimed by both ${index.get(token)} and ${key}; kept ${index.get(token)}`);
        continue;
      }
      index.set(token, key);
    }
  }
  return index;
}

// A spec alias may be a BARE NUMERAL (`p5` — legacy, and the form mod-git needs for branches) or a
// FOLDER NAME, optionally project-qualified (`p1-agents`, `commerce/p1-foundation`).
const ALIAS_FOLDER_RE = /^(?:([a-z0-9._-]+)\/)?(p\d+(?:\.\d+)*)(?:-(.*))?$/;

// The alias map, split by specificity. A bare numeral claims EVERY folder sharing that numeral —
// 14 folders start `p1-` in this vault — so it can never be what a tag button writes. It stays only
// so existing aliases.json entries and mod-git's branch tokens keep resolving.
// Lookup order at the call site: project/folder -> folder -> numeral. Most specific wins.
function buildAliasIndex(aliases, warnings) {
  const byFolder = new Map();
  const byNumeral = new Map();
  const epics = (aliases && aliases.epics && typeof aliases.epics === 'object') ? aliases.epics : {};
  for (const key of Object.keys(epics).sort()) {
    for (const a of (Array.isArray(epics[key]) ? epics[key] : [])) {
      if (typeof a !== 'string') continue;
      const token = a.trim().toLowerCase();
      const m = token.match(ALIAS_FOLDER_RE);
      if (!m) continue;                                   // word aliases map branches, not folders
      const target = m[3] ? byFolder : byNumeral;         // has a slug => folder-specific
      if (target.has(token)) {
        if (warnings) warnings.push(`spec alias ${token} is claimed by both ${target.get(token)} and ${key}; kept ${target.get(token)}`);
        continue;
      }
      target.set(token, key);
    }
  }
  return { byFolder, byNumeral };
}

// ---- module entry ----------------------------------------------------------------------------------------

async function collectSpecs(opts) {
  const now = opts.now == null ? Date.now() : opts.now;
  const observedAt = new Date(now).toISOString();
  const configPath = opts.configPath || (opts.paths && opts.paths.config) || null;

  const loaded = opts.specsConfig !== undefined
    ? { cfg: opts.specsConfig, error: null }
    : await loadSpecsConfig(configPath);

  const warnings = [];
  if (loaded.error) {
    return { fragment: null, source: { status: 'error', observedAt, error: loaded.error }, warnings: [loaded.error] };
  }
  if (!loaded.cfg) {
    return { fragment: { epics: {}, specOrphans: [], folders: [] }, source: { status: 'disabled' }, warnings };
  }
  const root = loaded.cfg.root;

  const errors = [];
  const scan = await scanSpecRoot(root, errors);

  // No vault on this machine is `disabled` — an absent source, not a broken one. A permanent red
  // badge on every machine that is not machine-a would train the eye to ignore the badge.
  if (scan.rootMissing) {
    return {
      fragment: { epics: {}, specOrphans: [], folders: [] },
      source: { status: 'disabled' },
      warnings: warnings.concat(`specs root not found: ${root}`),
    };
  }

  const staged = [];
  for (const f of scan.folders) {
    const r = await stageFolder(f, errors);
    if (r) staged.push(r);                                 // null => malformed, folder skipped
  }
  staged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const link of scan.skippedSymlinks) warnings.push(`specs: skipped symlink ${link}`);

  // ---- map folders onto epics; anything unmapped is a spec-orphan.
  const index = buildAliasIndex(opts.aliases, warnings);
  const epics = {};
  const specOrphans = [];

  // A bare-numeral alias that covers more than one folder is reported once, by name. It is not an
  // error (p59 + p62 legitimately share PROJ-108) but it IS how a board silently mis-attributes 14
  // folders to one epic, so it must be visible rather than inferred from a wrong-looking count.
  if (index.byNumeral.size) {
    const hitsFor = new Map();
    for (const f of staged) {
      if (index.byFolder.has(`${f.project}/${f.specFolder}`.toLowerCase()) || index.byFolder.has(f.specFolder.toLowerCase())) continue;
      if (!index.byNumeral.has(f.pNumeral)) continue;
      if (!hitsFor.has(f.pNumeral)) hitsFor.set(f.pNumeral, []);
      hitsFor.get(f.pNumeral).push(f.specFolder);
    }
    for (const [numeral, folders] of hitsFor) {
      if (folders.length > 1) {
        warnings.push(`spec alias ${numeral} -> ${index.byNumeral.get(numeral)} claims ${folders.length} folders: ${folders.join(', ')}`);
      }
    }
  }

  for (const f of staged) {
    const key = index.byFolder.get(`${f.project}/${f.specFolder}`.toLowerCase())
      || index.byFolder.get(f.specFolder.toLowerCase())
      || index.byNumeral.get(f.pNumeral)
      || null;
    const entry = {
      specFolder: f.specFolder, project: f.project, path: f.path,
      pNumeral: f.pNumeral, stage: f.stage, verdict: f.verdict,
    };
    if (!key) { specOrphans.push(entry); continue; }
    if (!epics[key]) epics[key] = { stage: 'draft', folders: [] };
    epics[key].folders.push(entry);
    // Several folders can share one epic (p59 + p62 both map to PROJ-108). One accepted spec is
    // enough for the ladder cell: the epic HAS a GO'd spec.
    if (f.stage === 'done') epics[key].stage = 'done';
  }
  specOrphans.sort((a, b) => (a.specFolder < b.specFolder ? -1 : a.specFolder > b.specFolder ? 1 : 0));

  const source = errors.length
    ? { status: 'error', observedAt, error: `${errors.length} spec folder${errors.length === 1 ? '' : 's'} skipped: ${errors.slice(0, 3).join('; ')}` }
    : { status: 'ok', observedAt };
  for (const e of errors) warnings.push(`specs: ${e}`);

  return {
    fragment: { epics, specOrphans, folders: staged.map((f) => ({ specFolder: f.specFolder, project: f.project, pNumeral: f.pNumeral, stage: f.stage })) },
    source,
    warnings,
  };
}

// ---- the tag mutation (spec §M5, exact) ------------------------------------------------------------------------

// Tagging spec-orphan `p63-something` to epic `PROJ-120` appends `"p63"` — the P-NUMERAL, not the
// folder name — to aliases.json -> epics["PROJ-120"], creating the array if it is absent. The item
// then disappears on the next scan because the numeral index resolves it.
//
// Appending the folder name instead would be a silent no-op: the index keys on numerals, so the
// orphan would still be an orphan and the button would look broken while reporting success.
function specNumeral(specFolder) {
  const m = String(specFolder || '').trim().match(P_FOLDER_RE);
  return m ? m[1].toLowerCase() : null;
}

// Returns the mutated aliases object. Pure, so the exact mutation is testable without a filesystem;
// the collector wraps it in the ONE write queue (temp+rename) that every radar mutation uses.
// Writes the FOLDER NAME, never the bare numeral. Tagging `p1-agents -> PROJ-108` used to append
// `p1`, which then claimed all 14 folders starting `p1-` — a silent board corruption that reported
// success. `project` qualifies the token when the same folder name exists under more than one
// project (`p1-foundation` exists twice), so tagging one can never hide the other.
function applySpecTag(aliases, specFolder, epic, project) {
  const folder = String(specFolder || '').trim().toLowerCase();
  if (!specNumeral(folder)) throw new Error(`${specFolder} is not a p<N> spec folder`);
  const key = String(epic || '').trim();
  if (!key) throw new Error('spec tag requires an epic');
  const proj = String(project || '').trim().toLowerCase();
  const token = proj ? `${proj}/${folder}` : folder;

  const next = Object.assign({ epics: {}, branchOverrides: {}, flags: {} }, aliases);
  next.epics = Object.assign({}, next.epics);
  const current = Array.isArray(next.epics[key]) ? next.epics[key].slice() : [];
  // Idempotent: tagging twice must not grow the array.
  if (!current.some((a) => typeof a === 'string' && a.trim().toLowerCase() === token)) current.push(token);
  next.epics[key] = current;
  return next;
}

module.exports = {
  collectSpecs,
  loadSpecsConfig,
  parseVerdict,
  isGo,
  scanSpecRoot,
  stageFolder,
  buildNumeralIndex,
  buildAliasIndex,
  applySpecTag,
  specNumeral,
  DEFAULT_ROOT, P_FOLDER_RE, ALIAS_FOLDER_RE, VERDICT_RE,
};
