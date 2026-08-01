'use strict';
// S-009 — mod-specs, the real `spec` ladder cell, and the spec-orphan tag lifecycle.
//
// The vault fixture is a REAL directory tree with a REAL symlink and a REAL unreadable folder,
// because every rule this module has is about what the filesystem does, not about what a mock
// agrees to say.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  collectSpecs, loadSpecsConfig, parseVerdict, scanSpecRoot, buildNumeralIndex, buildAliasIndex,
  applySpecTag, specNumeral, DEFAULT_ROOT,
} = require('../radar/mod-specs');
const { derive, flattenAttention } = require('../radar/derive');
const { createCollector } = require('../radar/collector');
const store = require('../radar/store');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const OBSERVED = new Date(NOW).toISOString();

let vault = null;
before(async () => { vault = await buildVault(); });
after(async () => { if (vault) await fsp.rm(vault.root, { recursive: true, force: true }); });

// A miniature _context vault:
//   app/_specs/p59-search/specs.md        **Verdict:** GO            -> done   (mapped PROJ-108)
//   app/_specs/p62-images/specs.md          **Verdict: GO**            -> done   (mapped PROJ-108)
//   app/_specs/p70-draft/specs.md           **Verdict: NO-GO**         -> draft  (mapped PROJ-120)
//   app/_specs/p71-nofile/                  no specs.md                -> draft  (orphan)
//   cmux-remote/_specs/p5-radar/specs.md      **Verdict: GO** mid-line   -> done   (orphan)
//   cmux-remote/_specs/p63-something/specs.md no verdict                 -> draft  (orphan, tag target)
//   app/_specs/p80-linked -> p59-search   SYMLINK                    -> skipped
//   app/_specs/p81-broken/specs.md          a DIRECTORY, not a file    -> source error + skipped
//   app/_specs/not-a-p-folder/              ignored (not p<N>)
//   ml/_specs/p90-stories/{specs.md, story_list.json}  story file says pending, spec says GO
async function buildVault() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-specs-')));
  const mk = async (rel, files) => {
    const dir = path.join(root, rel);
    await fsp.mkdir(dir, { recursive: true });
    for (const name of Object.keys(files || {})) await fsp.writeFile(path.join(dir, name), files[name]);
    return dir;
  };

  await mk('app/_specs/p59-search', { 'specs.md': '# p59\n\n**Verdict:** GO (three rounds)\n' });
  await mk('app/_specs/p62-images', { 'specs.md': '# p62\n\n**Verdict: GO**\n' });
  await mk('app/_specs/p70-draft', { 'specs.md': '# p70\n\n**Verdict: NO-GO** — round 3 blocked\n' });
  await mk('app/_specs/p71-nofile', {});
  await mk('app/_specs/not-a-p-folder', { 'specs.md': '**Verdict:** GO\n' });
  // The real p5-radar header shape: the verdict is mid-line, inside a Status sentence.
  await mk('cmux-remote/_specs/p5-radar', { 'specs.md': '**Status:** spec v3 — **Verdict: GO** (Codex, 3 rounds)\n' });
  await mk('cmux-remote/_specs/p63-something', { 'specs.md': '# p63\n\nstill drafting\n' });
  await mk('ml/_specs/p90-stories', {
    'specs.md': '**Verdict:** GO\n',
    // The trap: this file says pending for work that is done. It must never be read.
    'story_list.json': JSON.stringify({ stories: [{ id: 'S-001', status: 'pending' }, { id: 'S-002', status: 'pending' }] }),
  });

  await fsp.symlink(path.join(root, 'app/_specs/p59-search'), path.join(root, 'app/_specs/p80-linked'), 'dir');
  // specs.md that is a DIRECTORY: unreadable in the "malformed" sense, and must cost only itself.
  await fsp.mkdir(path.join(root, 'app/_specs/p81-broken/specs.md'), { recursive: true });

  return { root };
}

const ALIASES = { epics: { 'PROJ-108': ['p59', 'p62', 'searchindex'], 'PROJ-120': ['p70'] } };
const run = (o) => collectSpecs(Object.assign({ now: NOW, specsConfig: { root: vault.root }, aliases: ALIASES }, o || {}));

// ---- verdict parsing ------------------------------------------------------------------------------

test('the verdict is parsed as a TOKEN, so every spelling in the real vault works', () => {
  assert.strictEqual(parseVerdict('**Verdict:** GO'), 'GO', "the spec's spelling");
  assert.strictEqual(parseVerdict('**Verdict: GO**'), 'GO', 'the spelling the vault actually uses');
  assert.strictEqual(parseVerdict('**Verdict**: GO'), 'GO');
  assert.strictEqual(parseVerdict('Verdict: GO'), 'GO');
  assert.strictEqual(parseVerdict('**Status:** spec v3 — **Verdict: GO** (Codex gpt-5.6, 3 rounds)'), 'GO', 'mid-line, as in p5-radar');
});

test('NO-GO and ACCEPT are NOT GO — a substring match would have called both of them done', () => {
  assert.strictEqual(parseVerdict('**Verdict: NO-GO**'), 'NO-GO');
  assert.strictEqual(parseVerdict('**Verdict: ACCEPT** — pending amendments'), 'ACCEPT');
  assert.strictEqual(parseVerdict('# a spec with no verdict at all'), null);
  assert.strictEqual(parseVerdict(''), null);
});

// ---- scanning -------------------------------------------------------------------------------------

test('scans _context/<project>/_specs/p* and ignores everything else', async () => {
  const r = await run();
  const names = r.fragment.folders.map((f) => f.specFolder).sort();
  assert.deepStrictEqual(names, ['p5-radar', 'p59-search', 'p62-images', 'p63-something', 'p70-draft', 'p71-nofile', 'p90-stories']);
  assert.ok(!names.includes('not-a-p-folder'));
});

test('a GO verdict is `done`; a folder without one is `draft`', async () => {
  const r = await run();
  const stage = {};
  for (const f of r.fragment.folders) stage[f.specFolder] = f.stage;
  assert.deepStrictEqual(stage, {
    'p5-radar': 'done',
    'p59-search': 'done',
    'p62-images': 'done',
    'p63-something': 'draft',
    'p70-draft': 'draft',
    'p71-nofile': 'draft',
    'p90-stories': 'done',
  });
});

test('a folder with no specs.md at all is `draft`, not an error — the folder existing IS the draft', async () => {
  const r = await run();
  assert.strictEqual(r.fragment.specOrphans.find((o) => o.specFolder === 'p71-nofile').stage, 'draft');
  assert.ok(!r.warnings.some((w) => w.includes('p71-nofile')), 'and it is not reported as malformed');
});

test('SYMLINKS ARE SKIPPED, never followed', async () => {
  const r = await run();
  assert.ok(!r.fragment.folders.some((f) => f.specFolder === 'p80-linked'), 'the linked folder is absent');
  assert.ok(r.warnings.some((w) => /skipped symlink .*p80-linked/.test(w)), 'and the skip is stated, not silent');
});

test('a malformed folder becomes a sources.specs error and is SKIPPED — the other folders survive', async () => {
  const r = await run();
  assert.strictEqual(r.source.status, 'error');
  assert.match(r.source.error, /1 spec folder skipped/);
  assert.match(r.source.error, /p81-broken/);
  assert.ok(!r.fragment.folders.some((f) => f.specFolder === 'p81-broken'));
  assert.strictEqual(r.fragment.folders.length, 7, 'every other folder still reports');
});

test('story_list.json statuses are NEVER read', async () => {
  // p90-stories: the story file says every story is `pending`; the spec carries a GO verdict.
  // The stage must come from the verdict.
  const r = await run();
  assert.strictEqual(r.fragment.folders.find((f) => f.specFolder === 'p90-stories').stage, 'done');
  const src = require('fs').readFileSync(require.resolve('../radar/mod-specs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/story_list/.test(code), 'the filename does not appear in the code at all');
});

test('the p-numeral is the token before the first hyphen, so p5 never claims p59', () => {
  assert.strictEqual(specNumeral('p5-radar'), 'p5');
  assert.strictEqual(specNumeral('p59-search'), 'p59');
  assert.strictEqual(specNumeral('p21.1-agent-connect'), 'p21.1', 'the vault really has one of these');
  assert.strictEqual(specNumeral('not-a-p-folder'), null);
  const index = buildNumeralIndex({ epics: { 'PROJ-1': ['p5'], 'PROJ-2': ['p59'] } }, []);
  assert.strictEqual(index.get('p5'), 'PROJ-1');
  assert.strictEqual(index.get('p59'), 'PROJ-2');
});

test('word aliases map branches, not folders — only p-numerals enter the folder index', () => {
  const warnings = [];
  const index = buildNumeralIndex({ epics: { 'PROJ-108': ['p59', 'searchindex', 'query-groupby'] } }, warnings);
  assert.deepStrictEqual(Array.from(index.keys()), ['p59']);
});

test('two epics claiming one numeral is reported, and resolution is deterministic', () => {
  const warnings = [];
  const index = buildNumeralIndex({ epics: { 'PROJ-9': ['p7'], 'PROJ-2': ['p7'] } }, warnings);
  assert.strictEqual(index.get('p7'), 'PROJ-2', 'sorted-first epic wins');
  assert.match(warnings.join(' '), /p7 is claimed by both PROJ-2 and PROJ-9/);
});

// ---- epic mapping + orphans ---------------------------------------------------------------------------

test('mapped folders become epic ledger entries; unmapped ones become spec-orphans', async () => {
  const r = await run();
  assert.deepStrictEqual(Object.keys(r.fragment.epics).sort(), ['PROJ-108', 'PROJ-120']);
  assert.deepStrictEqual(r.fragment.epics['PROJ-108'].folders.map((f) => f.specFolder), ['p59-search', 'p62-images']);
  assert.strictEqual(r.fragment.epics['PROJ-108'].stage, 'done');
  assert.strictEqual(r.fragment.epics['PROJ-120'].stage, 'draft', 'NO-GO does not accept a spec');
  assert.deepStrictEqual(
    r.fragment.specOrphans.map((o) => o.specFolder),
    ['p5-radar', 'p63-something', 'p71-nofile', 'p90-stories'],
  );
});

test('one accepted spec is enough for an epic that has several folders', async () => {
  // PROJ-108 owns p59 (GO) and p62 (GO). Make p62 the only GO and the epic is still done.
  const r = await collectSpecs({ now: NOW, specsConfig: { root: vault.root }, aliases: { epics: { 'PROJ-108': ['p62', 'p63'] } } });
  assert.strictEqual(r.fragment.epics['PROJ-108'].stage, 'done');
  assert.deepStrictEqual(r.fragment.epics['PROJ-108'].folders.map((f) => `${f.specFolder}:${f.stage}`), ['p62-images:done', 'p63-something:draft']);
});

// ---- the ladder cell ------------------------------------------------------------------------------------

function deriveWith(o) {
  const opts = o || {};
  return derive({
    now: NOW,
    collectorId: 'test',
    config: { repos: [] },
    sources: Object.assign({
      git: { status: 'ok', observedAt: OBSERVED },
      sessions: { status: 'disabled' },
      deploy: { status: 'disabled' },
      jira: { status: 'disabled' },
      specs: opts.specsSource || { status: 'ok', observedAt: OBSERVED },
      config: { status: 'ok' },
    }),
    aliases: {},
    decisions: [],
    fragments: {
      git: { repos: { r1: {
        path: '/r1',
        defaultBranches: { develop: 'd', main: 'm' },
        branches: [{
          name: 'feature/PROJ-108-x', sha: 's', epic: 'PROJ-108', isDefault: false, unpushed: 3,
          noRemote: false, mergedIntoDevelop: false, mergedIntoMain: false,
          lastCommitAt: new Date(NOW - 86400000).toISOString(), worktree: null,
        }],
        worktrees: [], deploy: null, fetch: { status: 'ok', error: null },
      } } },
      specs: opts.specs || { epics: {}, specOrphans: [] },
    },
  });
}

test('the S-003 placeholder is GONE — a branch no longer implies an accepted spec', () => {
  const src = require('fs').readFileSync(require.resolve('../radar/derive'), 'utf8');
  assert.ok(!/S-003 PLACEHOLDER/.test(src), 'the placeholder comment is removed');
  assert.ok(!/epicBranches\.length > 0 \? 'done'/.test(src), 'and so is the logic');

  // The behaviour it stood for: an epic with a branch and no spec must NOT read spec:done. Under
  // the placeholder this same world produced spec:done purely because a branch existed.
  const e = deriveWith().epics.find((x) => x.key === 'PROJ-108');
  assert.notStrictEqual(e.ladder.spec, 'done');
  assert.strictEqual(e.ladder.spec, 'todo', 'zero-progress epic: todo, never current (§6)');
  assert.ok(!Object.values(e.ladder).includes('done'), 'nothing in this epic is done');
});

test('a GO verdict sets ladder.spec = done', () => {
  const e = deriveWith({ specs: { epics: { 'PROJ-108': { stage: 'done', folders: [] } }, specOrphans: [] } }).epics.find((x) => x.key === 'PROJ-108');
  assert.strictEqual(e.ladder.spec, 'done');
  assert.strictEqual(e.ladder.pushed, 'current', 'and the current marker moves on to the next cell');
});

test('a drafted-but-not-accepted spec is progress, not completion', () => {
  const e = deriveWith({ specs: { epics: { 'PROJ-108': { stage: 'draft', folders: [] } }, specOrphans: [] } }).epics.find((x) => x.key === 'PROJ-108');
  assert.strictEqual(e.ladder.spec, 'current');
});

test('a specs source that could not be read is `unknown`, never a guess in either direction', () => {
  const e = deriveWith({ specsSource: { status: 'error', observedAt: OBSERVED, error: 'x' } }).epics.find((x) => x.key === 'PROJ-108');
  assert.strictEqual(e.ladder.spec, 'unknown');
  const disabled = deriveWith({ specsSource: { status: 'disabled' } }).epics.find((x) => x.key === 'PROJ-108');
  assert.strictEqual(disabled.ladder.spec, 'unknown');
});

test('spec-orphans reach the attention queue with a tag action, sorted last — folded into ONE group row', () => {
  const state = deriveWith({ specs: { epics: {}, specOrphans: [{ specFolder: 'p63-something' }, { specFolder: 'p5-radar' }] } });
  // Two same-type orphans are ONE queue row, not two (derive §ORPHAN_GROUP_MIN).
  const groups = state.attention.filter((a) => a.type === 'spec-orphan-group');
  assert.strictEqual(groups.length, 1, 'one triage row, whatever the member count');
  assert.strictEqual(groups.length && state.attention.filter((a) => a.type === 'spec-orphan').length, 0,
    'and no loose member rows beside it');
  assert.strictEqual(groups[0].count, 2);
  assert.deepStrictEqual(groups[0].actions, [{ kind: 'expand' }]);
  // Members survive intact, sorted, each with its own tag action — the group is expandable, never
  // a place where work goes to disappear.
  const items = flattenAttention(state.attention).filter((a) => a.type === 'spec-orphan');
  assert.deepStrictEqual(items.map((i) => i.specFolder), ['p5-radar', 'p63-something']);
  assert.deepStrictEqual(items[0].actions, [{ kind: 'tag' }]);
  // The COUNT is still the true number; folding rows must never fold the count.
  assert.strictEqual(state.counts.orphans, 2);
});

test('a lone spec-orphan is NOT grouped — one item behind a "1 orphan" expander is worse than the item', () => {
  const state = deriveWith({ specs: { epics: {}, specOrphans: [{ specFolder: 'p63-something' }] } });
  assert.strictEqual(state.attention.filter((a) => a.type === 'spec-orphan-group').length, 0);
  assert.deepStrictEqual(state.attention.filter((a) => a.type === 'spec-orphan').map((i) => i.specFolder), ['p63-something']);
  assert.strictEqual(state.counts.orphans, 1);
});

// ---- the tag mutation (spec §M5, exact) -----------------------------------------------------------------------

test('tagging appends the FOLDER NAME — never the bare numeral — creating the array if absent', () => {
  const next = applySpecTag({}, 'p63-something', 'PROJ-120');
  assert.deepStrictEqual(next.epics['PROJ-120'], ['p63-something'], 'the folder, not the numeral');

  const existing = applySpecTag({ epics: { 'PROJ-120': ['p59'] } }, 'p63-something', 'PROJ-120');
  assert.deepStrictEqual(existing.epics['PROJ-120'], ['p59', 'p63-something'], 'appended, never replacing');

  const qualified = applySpecTag({}, 'p1-foundation', 'PROJ-9', 'commerce');
  assert.deepStrictEqual(qualified.epics['PROJ-9'], ['commerce/p1-foundation'], 'project-qualified when given');
});

test('REGRESSION: a folder tag cannot claim its numeral siblings', () => {
  // The bug: tagging `p1-agents` wrote `p1`, which then claimed all 14 folders starting `p1-`.
  const aliases = applySpecTag({}, 'p1-agents', 'PROJ-108');
  const { byFolder, byNumeral } = buildAliasIndex(aliases, []);
  assert.strictEqual(byNumeral.size, 0, 'no bare-numeral alias is ever written by tagging');
  assert.strictEqual(byFolder.get('p1-agents'), 'PROJ-108');
  for (const sibling of ['p1-foundation', 'p1-mirror', 'p1-commerce-platform']) {
    assert.strictEqual(byFolder.get(sibling), undefined, `${sibling} must NOT be claimed`);
  }
});

test('REGRESSION: same folder name in two projects resolves independently', () => {
  let a = applySpecTag({}, 'p1-foundation', 'PROJ-9', 'commerce');
  a = applySpecTag(a, 'p1-foundation', 'PROJ-40', 'app');
  const { byFolder } = buildAliasIndex(a, []);
  assert.strictEqual(byFolder.get('commerce/p1-foundation'), 'PROJ-9');
  assert.strictEqual(byFolder.get('app/p1-foundation'), 'PROJ-40');
  assert.strictEqual(byFolder.get('p1-foundation'), undefined, 'the unqualified name claims neither');
});

test('a bare-numeral alias still resolves (legacy aliases.json + mod-git branch tokens)', () => {
  const { byFolder, byNumeral } = buildAliasIndex({ epics: { 'PROJ-108': ['p59', 'p62-image'] } }, []);
  assert.strictEqual(byNumeral.get('p59'), 'PROJ-108', 'legacy numeral entries keep working');
  assert.strictEqual(byFolder.get('p62-image'), 'PROJ-108', 'folder entries land in the folder map');
});

test('tagging is idempotent and leaves every other alias key untouched', () => {
  const before = { epics: { 'PROJ-108': ['p59'], 'PROJ-120': ['p63-something'] }, branchOverrides: { 'r:b': 'PROJ-1' }, flags: { 'PROJ-108': { state: 'off' } } };
  const once = applySpecTag(before, 'p63-something', 'PROJ-120');
  const twice = applySpecTag(once, 'p63-something', 'PROJ-120');
  assert.deepStrictEqual(twice.epics['PROJ-120'], ['p63-something'], 'no duplicate');
  assert.deepStrictEqual(twice.epics['PROJ-108'], ['p59']);
  assert.deepStrictEqual(twice.branchOverrides, before.branchOverrides);
  assert.deepStrictEqual(twice.flags, before.flags);
  assert.deepStrictEqual(before.epics['PROJ-120'], ['p63-something'], 'the input object is not mutated in place');
});

test('a folder that is not a p<N> folder cannot be tagged', () => {
  assert.throws(() => applySpecTag({}, 'not-a-p-folder', 'PROJ-1'), /not a p<N> spec folder/);
  assert.throws(() => applySpecTag({}, 'p63-x', ''), /requires an epic/);
});

// ---- lifecycle, through the real collector and the real write queue -------------------------------------------

test('LIFECYCLE: orphan -> tag -> alias append -> gone on the next scan', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-lifecycle-')));
  try {
    await store.writeJsonAtomic(path.join(dir, 'config.json'), {
      configVersion: 1, role: 'leader', repos: [], specs: { root: vault.root },
    });
    await store.writeJsonAtomic(path.join(dir, 'aliases.json'), ALIASES);
    const c = createCollector({ radarDir: dir, collectorId: 'test', now: () => NOW });

    // 1. p63-something is an open spec-orphan.
    const first = await c.scan({ fetch: false });
    const orphans = flattenAttention(first.state.attention).filter((a) => a.type === 'spec-orphan').map((a) => a.specFolder);
    assert.ok(orphans.includes('p63-something'), `expected p63-something in ${JSON.stringify(orphans)}`);
    assert.strictEqual(first.state.sources.specs.status, 'error', 'p81-broken is still reported, and the scan still published');

    // 2. Tag it to PROJ-120 through the collector's own mutation — the one write queue.
    await c.tagSpec({ specFolder: 'p63-something', epic: 'PROJ-120' });
    const aliasesOnDisk = (await store.readJson(path.join(dir, 'aliases.json'), null)).value;
    assert.deepStrictEqual(aliasesOnDisk.epics['PROJ-120'], ['p70', 'cmux-remote/p63-something'],
      'the project-qualified FOLDER NAME is appended; the project resolves itself when unambiguous');

    // 3. Next scan: the orphan is gone and the folder now belongs to the epic.
    const second = await c.scan({ fetch: false });
    const after = flattenAttention(second.state.attention).filter((a) => a.type === 'spec-orphan').map((a) => a.specFolder);
    assert.ok(!after.includes('p63-something'), 'the item disappears, exactly as spec §M5 requires');
    assert.strictEqual(second.state.counts.orphans, orphans.length - 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('tagSpec refuses a folder radar has never seen as an orphan', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-lifecycle2-')));
  try {
    await store.writeJsonAtomic(path.join(dir, 'config.json'), { configVersion: 1, repos: [], specs: { root: vault.root } });
    await store.writeJsonAtomic(path.join(dir, 'aliases.json'), ALIASES);
    const c = createCollector({ radarDir: dir, collectorId: 'test', now: () => NOW });
    await c.scan({ fetch: false });
    await assert.rejects(() => c.tagSpec({ specFolder: 'p999-typo', epic: 'PROJ-1' }), /unknown spec folder p999-typo/);
    await assert.rejects(() => c.tagSpec({ specFolder: '', epic: 'PROJ-1' }), /requires specFolder and epic/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('there is exactly ONE write path — tagSpec goes through store.updateJson like every mutation', () => {
  const src = require('fs').readFileSync(require.resolve('../radar/collector'), 'utf8');
  const body = src.slice(src.indexOf('async function tagSpec'), src.indexOf('async function setFlag'));
  assert.match(body, /store\.updateJson\(paths\.aliases/);
  assert.ok(!/writeFile|fsp\.|fs\./.test(body), 'no direct filesystem call anywhere in the mutation');
});

// ---- config -----------------------------------------------------------------------------------------------------

test('no specs block in the config is `disabled` — the module never walks a vault it was not pointed at', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-specs-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  await store.writeJsonAtomic(cfgPath, { configVersion: 1, repos: [] });
  const r = await collectSpecs({ now: NOW, paths: { config: cfgPath }, aliases: {} });
  assert.deepStrictEqual(r.source, { status: 'disabled' });
  assert.deepStrictEqual(r.fragment, { epics: {}, specOrphans: [], folders: [] });
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an empty specs block takes the vault path from the spec', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-specs-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  await store.writeJsonAtomic(cfgPath, { configVersion: 1, specs: {} });
  const { cfg } = await loadSpecsConfig(cfgPath);
  assert.deepStrictEqual(cfg, { root: DEFAULT_ROOT });
  // Derived from os.homedir() — the module carries no username.
  assert.strictEqual(DEFAULT_ROOT, path.join(os.homedir(), 'Main', '_context'));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a specs root that does not exist is `disabled`, not a permanent red badge', async () => {
  const r = await collectSpecs({ now: NOW, specsConfig: { root: '/nope/not/here' }, aliases: {} });
  assert.deepStrictEqual(r.source, { status: 'disabled' });
  assert.match(r.warnings.join(' '), /specs root not found/);
});

test('a relative specs.root is refused rather than resolved against an accidental cwd', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-specs-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  await store.writeJsonAtomic(cfgPath, { configVersion: 1, specs: { root: './Docs/_context' } });
  const r = await collectSpecs({ now: NOW, paths: { config: cfgPath }, aliases: {} });
  assert.strictEqual(r.source.status, 'error');
  assert.match(r.source.error, /not absolute/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('scanSpecRoot reports a missing root rather than throwing', async () => {
  const errors = [];
  const r = await scanSpecRoot('/definitely/not/a/vault', errors);
  assert.strictEqual(r.rootMissing, true);
  assert.deepStrictEqual(errors, []);
});
