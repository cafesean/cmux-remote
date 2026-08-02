// p8 STORY-009 — the ONE cold-runnable entry point for the browser proof (specs.md §8.3).
//
//   npm run test:browser
//
// This runner owns everything the proof needs except two external values it asserts LOUDLY BY NAME
// before it does anything else:
//
//   PLAYWRIGHT_DIR   a playwright/index.mjs to borrow (this repo installs nothing)
//   CMUX_BIN         the real cmux, because the anchors under test are cmux workspace cwds
//
// Everything else is minted, built, booted and torn down here:
//
//   * a HOME-ROOTED fixture tree. NOT os.tmpdir(): on macOS that realpaths into /private/…, which
//     the production deny-set (§3.4) correctly classifies BROAD — a temp-rooted parent would anchor
//     nothing, every containment assertion would fail, and the ones that "passed" would be passing
//     for the wrong reason. The runner refuses to start if its computed root lands in a deny-set
//     entry, and it asserts every anchor is NARROW using gitread's OWN exported classifier fed by
//     the REAL mount table — not a copy of the rule that could drift away from it.
//   * SERVER_TOKEN and BRIDGE_SECRET, freshly minted per run.
//   * bridge.js and server.js booted FROM THIS WORKTREE on EPHEMERAL ports. Never :8080/:8799 —
//     those are the operator's live pair, and they run from a release copy of an older tree, so a
//     proof aimed at them would exercise p7 code and pass vacuously. test/helpers/server-boot.js and
//     test/helpers/bridge-child.js are the boot pattern and are reused as-is.
//   * three scratch cmux workspaces, so the cold discovery burst is more than one limiter round —
//     with a single cwd "one probe per level" is measured on the easiest possible value of the only
//     variable that matters.
//   * a PREFLIGHT that asks the running server what it thinks of every fixture and refuses to launch
//     the browser unless each one is classified as the suite assumes. An unmet precondition does not
//     fail the suite, it FAKES A PASS: p4's paging test passed against a 59-entry directory and p7's
//     git smoke only worked because it seeded dirt first.
//
// Public-repo hygiene: no real path, host or personal name is committed here. The fixture root is
// computed from os.homedir() at runtime; both externals are placeholder defaults overridden by env,
// exactly as test/p7-git-smoke.mjs:16 does.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- preconditions, by name, before anything else --------------------------------------------
// Each one has its own message naming the variable, because "it failed" is not a precondition
// report — the operator has to know which knob to turn. Exit 2, distinct from a suite failure (1).

const PRECONDITION_EXIT = 2;
// TWO SHAPES, because they differ in what has to be undone. `die()` is for the externals checked
// before anything exists — there is nothing to clean up and an immediate exit is the clearest
// possible report. `fail()` is for everything after the fixture tree is on disk: it throws, so the
// finally-block tears the tree, the processes and the scratch workspaces down. (Measured: the first
// version used die() throughout and left a home-rooted fixture directory behind on every
// precondition failure — an exit inside try/finally never runs the finally.)
function die(msg) {
  console.error(`\nPRECONDITION FAILED: ${msg}\n`);
  process.exit(PRECONDITION_EXIT);
}
class PreconditionError extends Error {}
function fail(msg) { throw new PreconditionError(msg); }
function requireFile(label, p, hint) {
  let st = null;
  try { st = fs.statSync(p); } catch (_) { st = null; }
  if (!st || !st.isFile()) die(`${label} does not point at a file: ${p}\n  ${hint}`);
  return p;
}

const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR
  || '/path/to/workspace/app-web/node_modules/playwright/index.mjs';
const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const GIT = '/usr/bin/git';

requireFile('PLAYWRIGHT_DIR', PLAYWRIGHT_DIR,
  'This repo has no dependencies and vendors no browser. Point PLAYWRIGHT_DIR at any\n'
  + '  playwright entry point you already have:\n'
  + '    PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs npm run test:browser');
requireFile('CMUX_BIN', CMUX_BIN,
  'The repos under test are discovered from cmux WORKSPACE CWDS, so a real cmux is not\n'
  + '  optional here — without it the bridge discovers no anchors and every bar assertion\n'
  + '  would pass by being unreachable. Set CMUX_BIN to the cmux executable.');
try { fs.accessSync(CMUX_BIN, fs.constants.X_OK); }
catch (_) { die(`CMUX_BIN is not executable: ${CMUX_BIN}`); }
requireFile('git', GIT, 'The fixtures are REAL repositories; nothing here mocks porcelain.');

// The target instance must be THIS worktree (§8.3). Asserted rather than assumed, because the
// failure mode — booting some other checkout — is invisible in a green run.
const SERVER_JS = requireFile('server.js', path.join(REPO, 'server.js'), 'run from the worktree');
const BRIDGE_JS = requireFile('bridge.js', path.join(REPO, 'bridge.js'), 'run from the worktree');
const SMOKE_JS = requireFile('the smoke suite', path.join(HERE, 'p8-gitbar-smoke.mjs'),
  'test/p8-gitbar-smoke.mjs is committed alongside this runner');

// gitread's OWN breadth rule, imported rather than restated. If §3.4 changes, this guard changes
// with it; a private copy would keep passing after the rule it claims to enforce had moved.
const gitread = require(path.join(REPO, 'gitread.js'));
const { PLATFORM_DENY, classifyBreadth, parseMounts } = gitread;

const isInside = (parent, child) => {
  const p = path.resolve(parent), c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
};

// ---- fixture tree ------------------------------------------------------------------------------

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'P8 Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'P8 Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
});
const git = async (cwd, args) => (await exec(GIT, args, { cwd, env: GIT_ENV, maxBuffer: 16 << 20 })).stdout;

// The B8 payloads. Both are LEGAL: git refs may contain `<`, `>` and `=`; a path component may
// contain anything but `/` and NUL. They are written once, here, and travel to the smoke in the
// fixture map so the assertion compares against the same bytes the fixture was built from.
const XSS_BRANCH = '<img/src=x/onerror=window.p8BranchXss=1>';
const XSS_REPO_DIR = '<svg onload=window.p8RepoXss=1>';

async function initRepo(dir, branch) {
  await fsp.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', branch || 'main']);
  await fsp.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

// Dirt of every kind the panel groups. A CLEAN repo satisfies every SCM assertion vacuously —
// this is the same failure p7's smoke header calls out.
async function dirty(repo) {
  await fsp.writeFile(path.join(repo, 'kept.txt'), 'one\n');
  await git(repo, ['add', 'kept.txt']);
  await git(repo, ['commit', '-q', '-m', 'kept']);
  await fsp.writeFile(path.join(repo, 'kept.txt'), 'one\ntwo\n');        // unstaged modify
  await fsp.writeFile(path.join(repo, 'staged.txt'), 'staged\n');
  await git(repo, ['add', 'staged.txt']);                               // staged add
  await fsp.writeFile(path.join(repo, 'untracked.txt'), 'new\n');       // untracked
}

async function buildFixtures(root) {
  const parent = path.join(root, 'parent');
  await initRepo(parent, 'main');
  // `*` plus an allowlist (§8.3): the nested child repos must not appear in the PARENT's status, or
  // the parent's own dirt assertions would be measuring the children.
  await fsp.writeFile(path.join(parent, '.gitignore'),
    ['*', '!.gitignore', '!seed.txt', '!kept.txt', '!staged.txt', '!untracked.txt', ''].join('\n'));
  await git(parent, ['add', '.gitignore']);
  await git(parent, ['commit', '-q', '-m', 'ignore the nested fixtures']);
  await dirty(parent);

  // B2's three-level descent, inside ONE repo. Plain directories: the bar must keep naming `parent`
  // all the way down, and each level must cost exactly one probe.
  const deep = path.join(parent, 'deep');
  const l1 = path.join(deep, 'l1'), l2 = path.join(l1, 'l2'), l3 = path.join(l2, 'l3');
  await fsp.mkdir(l3, { recursive: true });
  for (const d of [deep, l1, l2, l3]) await fsp.writeFile(path.join(d, 'note.txt'), 'x\n');

  const nested = path.join(parent, 'nested');
  await fsp.mkdir(nested, { recursive: true });

  const childDirty = path.join(nested, 'child-dirty');
  await initRepo(childDirty, 'child-branch');
  await dirty(childDirty);

  const childDetached = path.join(nested, 'child-detached');
  await initRepo(childDetached, 'main');
  await dirty(childDetached);
  const head = (await git(childDetached, ['rev-parse', 'HEAD'])).trim();
  await git(childDetached, ['checkout', '-q', '--detach', head]);

  const childXss = path.join(nested, 'child-xss-branch');
  await initRepo(childXss, 'main');
  await git(childXss, ['checkout', '-q', '-b', XSS_BRANCH]);
  await dirty(childXss);

  const xssRepo = path.join(nested, XSS_REPO_DIR);
  await initRepo(xssRepo, 'main');
  await dirty(xssRepo);

  // The row §3.3 rule 4 exists for, in its ADMIT direction. Every other fixture in this tree is a
  // fresh `init`, so without this one B1–B11 would pass with the object-store boundary entirely
  // inert — and an over-refusing rule 4 would look identical to a correct one.
  const sharedChild = path.join(nested, 'shared-child');
  await git(nested, ['clone', '--shared', '-q', parent, sharedChild]);
  await fsp.writeFile(path.join(sharedChild, 'untracked.txt'), 'new\n');

  // Rule 4's REFUSE direction: a tuple wholly inside the union whose object store points outside it.
  const outside = path.join(root, 'outside');
  const outsideRepo = path.join(outside, 'outside-repo');
  await initRepo(outsideRepo, 'main');
  await dirty(outsideRepo);

  const altEscape = path.join(nested, 'alt-escape');
  await initRepo(altEscape, 'main');
  await fsp.mkdir(path.join(altEscape, '.git', 'objects', 'info'), { recursive: true });
  await fsp.writeFile(path.join(altEscape, '.git', 'objects', 'info', 'alternates'),
    path.join(outsideRepo, '.git', 'objects') + '\n');

  // Rule 3's fourth door: an attribute layer no flag can bound, which p8 refuses rather than reads.
  const attrRefuse = path.join(nested, 'attr-refuse');
  await initRepo(attrRefuse, 'main');
  await git(attrRefuse, ['config', 'filter.p8probe.clean', 'true']);
  await fsp.mkdir(path.join(attrRefuse, '.git', 'info'), { recursive: true });
  await fsp.writeFile(path.join(attrRefuse, '.git', 'info', 'attributes'), 'seed.txt filter=p8probe\n');

  // A directory that is not a repo at all — the fourth reachable refusal class. It lives OUTSIDE
  // the parent, not inside it: measured against the running server, a plain directory nested in a
  // repo correctly resolves to that repo and shows its bar, so an inside-the-repo "non-repo" fixture
  // would have been asserting the opposite of the truth.
  const plainDir = path.join(root, 'plain-dir');
  await fsp.mkdir(plainDir, { recursive: true });
  await fsp.writeFile(path.join(plainDir, 'note.txt'), 'not a repo\n');

  // B10: a symlink that is retargeted from A to B under the bar's feet. A is dirty so an accidental
  // stage would be visible in its index, which is the assertion that gives B10 its teeth.
  const anchorA = path.join(root, 'anchor-a');
  await initRepo(anchorA, 'main');
  await dirty(anchorA);
  const anchorB = path.join(root, 'anchor-b');
  await initRepo(anchorB, 'b-branch');
  await dirty(anchorB);
  const link = path.join(root, 'link');
  await fsp.symlink(anchorA, link, 'dir');

  return {
    root, parent, deep, l1, l2, l3, nested,
    childDirty, childDetached, childXss, xssRepo, sharedChild,
    altEscape, attrRefuse, plainDir,
    anchorA, anchorB, link, outside, outsideRepo,
    xssBranch: XSS_BRANCH, xssRepoDir: XSS_REPO_DIR,
  };
}

// ---- fixture self-checks -----------------------------------------------------------------------
// §8.3 as an EXECUTABLE checklist. Every one of these has a silent-pass failure mode behind it.

async function assertFixtures(f) {
  const problems = [];
  const check = (cond, msg) => { if (!cond) problems.push(msg); };

  const porcelain = async (repo) => (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']))
    .split('\n').filter(Boolean);

  for (const repo of [f.parent, f.childDirty, f.anchorA, f.anchorB, f.childDetached, f.childXss, f.xssRepo]) {
    const st = await porcelain(repo);
    check(st.some((l) => /^[AMD]/.test(l)), `fixture ${path.basename(repo)} has NO staged change — every staging assertion would pass vacuously`);
    check(st.some((l) => /^.[MD]/.test(l)), `fixture ${path.basename(repo)} has NO unstaged change`);
    check(st.some((l) => l.startsWith('??')), `fixture ${path.basename(repo)} has NO untracked file`);
  }

  // The parent must not see its children, or "the parent is dirty" would be a statement about them.
  const parentSt = await porcelain(f.parent);
  check(!parentSt.some((l) => /nested|deep/.test(l)),
    `the parent repo's .gitignore does not hide the nested fixtures: ${parentSt.join(' | ')}`);

  // Nesting is the whole point (§8.3): without it U4/U10 and B3/B4 pass without testing scope.
  check(isInside(f.parent, f.childDirty), 'child-dirty is not nested inside the parent repo');
  check(!isInside(f.parent, f.outsideRepo), 'the out-of-scope repo is nested inside the parent — it would be IN scope');
  check(isInside(f.root, f.outsideRepo), 'the out-of-scope repo is outside the fs root — B4 would pass by being unreachable');

  const detachedHead = (await git(f.childDetached, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  check(detachedHead === 'HEAD', `the detached fixture is not detached (HEAD reads ${detachedHead})`);

  const xssBranch = (await git(f.childXss, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  check(xssBranch === XSS_BRANCH, `the hostile branch name did not survive git: ${JSON.stringify(xssBranch)}`);
  check(path.basename(f.xssRepo) === XSS_REPO_DIR, 'the hostile repo directory name did not survive the filesystem');

  // The shared clone must genuinely carry an alternate, and it must point INSIDE the union — that
  // is the row that keeps rule 4 from being inert AND catches an over-refusal.
  let alt = '';
  try { alt = await fsp.readFile(path.join(f.sharedChild, '.git', 'objects', 'info', 'alternates'), 'utf8'); } catch (_) {}
  check(alt.trim().length > 0, 'shared-child has no objects/info/alternates — `git clone --shared` did not share');
  check(isInside(f.parent, alt.trim()),
    `shared-child's alternate does not point inside the union: ${alt.trim()}`);

  let escape = '';
  try { escape = await fsp.readFile(path.join(f.altEscape, '.git', 'objects', 'info', 'alternates'), 'utf8'); } catch (_) {}
  check(escape.trim().length > 0, 'alt-escape has no objects/info/alternates — rule 4 would have nothing to refuse');
  check(escape.trim().length > 0 && !isInside(f.parent, escape.trim()),
    `alt-escape points its object store INSIDE the union (${escape.trim()}) — it would be admitted, correctly, and prove nothing`);

  check((await fsp.realpath(f.link)) === f.anchorA, 'the retargetable symlink does not resolve to repo A');

  if (problems.length) fail(`the fixture tree is not what the suite assumes:\n  - ${problems.join('\n  - ')}`);
}

// ---- boot ---------------------------------------------------------------------------------------

const cmux = async (args) => (await exec(CMUX_BIN, args, { maxBuffer: 32 << 20 })).stdout;
const wsIds = async () => new Set(JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']))
  .windows.flatMap((w) => w.workspaces).map((w) => w.id));

async function openWorkspace(cwd) {
  const before = await wsIds();
  await cmux(['new-workspace', '--focus', 'false', '--cwd', cwd]);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const t = JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']));
    const made = t.windows.flatMap((w) => w.workspaces).find((w) => !before.has(w.id));
    if (made) return made.id;
  }
  fail(`cmux did not open a scratch workspace at ${cwd} — the anchors under test come from workspace cwds`);
}

async function apiJson(base, token, pathAndQuery) {
  const r = await fetch(`${base}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep the text */ }
  return { status: r.status, json, text };
}

// ---- main ---------------------------------------------------------------------------------------

let bridge = null, server = null, fixtureRoot = null, workspaces = [];

async function cleanup() {
  for (const id of workspaces) { try { await cmux(['close-workspace', '--workspace', id]); } catch (_) {} }
  workspaces = [];
  if (server) { try { await server.stop(); } catch (_) {} server = null; }
  if (bridge) { try { await bridge.stop(); } catch (_) {} bridge = null; }
  if (fixtureRoot) { try { await fsp.rm(fixtureRoot, { recursive: true, force: true }); } catch (_) {} fixtureRoot = null; }
}

async function main() {
  // --- the home-rooted fixture root, guarded by the production rule -----------------------------
  const home = await fsp.realpath(os.homedir());
  const stem = path.join(home, '.cmux-remote-p8-fixtures', `run-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(stem, { recursive: true });
  fixtureRoot = await fsp.realpath(stem);

  if (PLATFORM_DENY.some((d) => fixtureRoot === d || isInside(d, fixtureRoot))) {
    fail(`the computed fixture root realpaths into a deny-set entry (${fixtureRoot}).\n`
      + '  Everything under it would be classified BROAD and anchor nothing — the whole suite\n'
      + '  would pass for the wrong reason. This is exactly what os.tmpdir() does on macOS.');
  }

  const fixtures = await buildFixtures(fixtureRoot);
  await assertFixtures(fixtures);

  // Breadth, measured through gitread's own classifier with the REAL mount table — the same inputs
  // production feeds it. A "narrow" claim asserted any other way is a claim about a copy of the rule.
  let mountSet = null;
  try {
    const raw = (await exec('/sbin/mount', [], { encoding: 'utf8', maxBuffer: 4 << 20 })).stdout;
    mountSet = new Set();
    for (const p of parseMounts(raw)) mountSet.add(await fsp.realpath(p));
  } catch (_) { mountSet = null; }
  if (mountSet == null) fail('/sbin/mount could not be read or parsed — gitread classifies EVERY anchor broad in that state, so no fixture would anchor anything');
  for (const top of [fixtures.parent, fixtures.anchorA, fixtures.anchorB]) {
    const breadth = classifyBreadth(top, { mounts: mountSet, home, deny: PLATFORM_DENY });
    if (breadth !== 'narrow') {
      fail(`anchor ${top} classifies as ${breadth}, not narrow — a broad anchor anchors NO nested repo,\n`
        + '  so every containment assertion below it would pass by being unreachable');
    }
  }

  // --- three workspace cwds, opened BEFORE the bridge boots so cold discovery sees them ----------
  for (const cwd of [fixtures.parent, fixtures.anchorA, fixtures.anchorB]) workspaces.push(await openWorkspace(cwd));
  if (workspaces.length < 3) fail('fewer than three scratch workspaces opened — with K=1 the cold burst is a single limiter round and B2 measures nothing');

  // --- the pair, from THIS worktree, on ephemeral ports ------------------------------------------
  const SERVER_TOKEN = crypto.randomBytes(24).toString('hex');
  const BRIDGE_SECRET = crypto.randomBytes(24).toString('hex');
  const { bootBridge } = require(path.join(REPO, 'test', 'helpers', 'bridge-child.js'));
  const { bootServer } = require(path.join(REPO, 'test', 'helpers', 'server-boot.js'));

  bridge = await bootBridge({
    env: {
      BRIDGE_SECRET,
      CMUX_BIN,
      // The real home, so gitread's §3.4 home rule is the one the operator runs rather than an
      // inert stub pointed at a scratch directory.
      HOME: home,
      UPLOAD_DIR: path.join(fixtureRoot, '_uploads'),
      GIT_PANEL_ENABLED: '1',
      GIT_WRITES_ENABLED: '1',
      // B4 needs a repo that is BROWSABLE but OUT OF SCOPE. Under the default `workspace-cwds` no
      // such directory exists and B4 would pass because the path is unreachable (§8.3).
      FS_ROOTS: `workspace-cwds:${fixtureRoot}`,
    },
  });
  server = await bootServer({
    env: {
      SERVER_TOKEN,
      CMUX_MACHINE_URL: bridge.base,
      CMUX_MACHINE_SECRET: BRIDGE_SECRET,
      CMUX_MACHINE_LABEL: 'p8 fixture',
      RADAR_ENABLED: '0',
    },
  });
  if (server.port === 8080 || bridge.port === 8799) {
    fail('the boot landed on the operator\'s live ports — those run a RELEASE copy, not this worktree');
  }

  // --- preflight: ask the running pair what it thinks of every fixture --------------------------
  const base = server.base;
  let ready = null;
  for (let i = 0; i < 40; i++) {
    ready = await apiJson(base, SERVER_TOKEN, '/api/cmux/fs/roots?machine=default');
    if (ready.status === 200 && ready.json && Array.isArray(ready.json.roots)) break;
    await sleep(500);
  }
  if (!ready || ready.status !== 200) fail(`the worktree pair never became ready: ${ready && ready.status} ${ready && ready.text}`);
  const rootPaths = (ready.json.roots || []).map((r) => r.path);
  if (!rootPaths.includes(fixtureRoot)) {
    fail(`the fixture root is not a browsable root (${rootPaths.join(', ')}) — B4's out-of-scope repo would be unreachable rather than refused`);
  }

  const probe = async (dir) => apiJson(base, SERVER_TOKEN,
    `/api/cmux/gitread/probe?machine=default&dir=${encodeURIComponent(dir)}`);

  const expectations = [
    ['parent (equality anchor)', fixtures.parent, fixtures.parent],
    ['anchor-a (equality anchor, B10 A)', fixtures.anchorA, fixtures.anchorA],
    ['anchor-b (equality anchor, B10 B)', fixtures.anchorB, fixtures.anchorB],
    ['the symlink resolves to A', fixtures.link, fixtures.anchorA],
    ['a plain directory inside the anchor', fixtures.l3, fixtures.parent],
    ['nested child repo (containment)', fixtures.childDirty, fixtures.childDirty],
    ['detached child repo', fixtures.childDetached, fixtures.childDetached],
    ['hostile-branch child repo', fixtures.childXss, fixtures.childXss],
    ['hostile-named repo directory', fixtures.xssRepo, fixtures.xssRepo],
    ['shared clone (alternate INSIDE the union — rule 4 must admit)', fixtures.sharedChild, fixtures.sharedChild],
    ['out-of-scope repo (B4)', fixtures.outsideRepo, null],
    ['object-store escape (rule 4 refuses)', fixtures.altEscape, null],
    ['unbounded attribute source (rule 3 refuses)', fixtures.attrRefuse, null],
    ['a directory that is not a repo', fixtures.plainDir, null],
  ];
  const wrong = [];
  for (const [label, dir, want] of expectations) {
    const r = await probe(dir);
    const got = r.status === 200 && r.json ? r.json.repo : `HTTP ${r.status} ${r.text.slice(0, 120)}`;
    if (got !== want) wrong.push(`${label}: probe(${dir}) resolved ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (wrong.length) {
    fail(`the server does not classify the fixtures as the suite assumes — every assertion below\n`
      + `  would be measuring something other than what it claims:\n  - ${wrong.join('\n  - ')}`);
  }

  // canWrite is the §6.5 split B9 rests on. If both sides answered the same, B9 would prove nothing.
  const anchorStatus = await apiJson(base, SERVER_TOKEN, `/api/cmux/gitread/status?machine=default&dir=${encodeURIComponent(fixtures.parent)}`);
  const childStatus = await apiJson(base, SERVER_TOKEN, `/api/cmux/gitread/status?machine=default&dir=${encodeURIComponent(fixtures.childDirty)}`);
  if (!(anchorStatus.json && anchorStatus.json.canWrite === true)) {
    fail(`the anchor repo reports canWrite=${anchorStatus.json && anchorStatus.json.canWrite} — B9's stage/unstage half cannot run`);
  }
  if (!(childStatus.json && childStatus.json.canWrite === false)) {
    fail(`the nested child reports canWrite=${childStatus.json && childStatus.json.canWrite} — B9's read-only half would pass vacuously`);
  }

  console.log(`p8 browser proof — worktree ${REPO}`);
  console.log(`  server ${base}   bridge ${bridge.base}   (never the live pair)`);
  console.log(`  fixtures ${fixtureRoot}`);
  console.log(`  workspaces ${workspaces.length}   preconditions: all asserted\n`);

  // --- the suite ---------------------------------------------------------------------------------
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SMOKE_JS], {
      cwd: REPO,
      stdio: 'inherit',
      env: Object.assign({}, process.env, {
        PLAYWRIGHT_DIR,
        CMUX_BIN,
        P8_BASE: base,
        SERVER_TOKEN,
        P8_FIXTURES: JSON.stringify(fixtures),
      }),
    });
    child.on('exit', (c, sig) => resolve(sig ? 1 : (c == null ? 1 : c)));
    child.on('error', () => resolve(1));
  });
  return code;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  if (e instanceof PreconditionError) {
    console.error(`\nPRECONDITION FAILED: ${e.message}\n`);
    exitCode = PRECONDITION_EXIT;
  } else {
    console.error(`\nRUNNER ERROR: ${(e && e.stack) || e}\n`);
    exitCode = 1;
  }
} finally {
  await cleanup();
}
process.exit(exitCode);
