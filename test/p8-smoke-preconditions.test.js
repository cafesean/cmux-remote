'use strict';
// p8 STORY-009 — the runner's own guarantees, provable on a machine with no Playwright and no cmux.
//
// The browser proof itself is a tier-2 artefact: it needs a real browser, a real cmux and a real
// pair of processes. What CAN be pinned here is the part of it that decides whether the proof means
// anything at all:
//
//   * it fails LOUDLY AND BY NAME on a missing external, and does so BEFORE the dynamic Playwright
//     import — otherwise the first thing an operator sees is a module-resolution stack trace that
//     names nothing they can fix;
//   * its fixture root comes from os.homedir() at runtime and is guarded against the production
//     deny-set — a tmpdir root realpaths into /private, which §3.4 correctly calls BROAD, and the
//     whole suite would then pass for the wrong reason;
//   * nothing machine-specific is committed. This repo is public.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const RUNNER = path.join(REPO, 'test', 'p8-browser-run.mjs');
const SMOKE = path.join(REPO, 'test', 'p8-gitbar-smoke.mjs');

// A file that certainly exists and certainly is not Playwright — enough to get past the first gate
// so the second one can be observed.
const A_REAL_FILE = path.join(REPO, 'package.json');

// Source assertions read CODE, not prose. Both files explain at length why os.tmpdir() is wrong
// here, and a naive scan would read the explanation as the offence.
const codeOf = (file) => fs.readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

function runRunner(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }));
    child.on('error', (e) => resolve({ code: null, signal: null, out, err: String(e) }));
  });
}

test('an emptied environment fails non-zero, naming PLAYWRIGHT_DIR, without importing Playwright', async () => {
  const r = await runRunner({});
  assert.notStrictEqual(r.code, 0, 'the runner must not exit 0 with no externals present');
  assert.match(r.err, /PRECONDITION FAILED/);
  assert.match(r.err, /PLAYWRIGHT_DIR/);
  // The tell of an attempted import is a module-resolution error, and it must not be there: the
  // assertion has to come FIRST or the operator gets a stack trace instead of an instruction.
  assert.doesNotMatch(r.err + r.out, /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/);
  // And it must not have reached the fixtures, the cmux calls or the boot.
  assert.doesNotMatch(r.out, /fixtures|workspaces/);
});

test('CMUX_BIN is asserted by its own name once PLAYWRIGHT_DIR resolves', async () => {
  const r = await runRunner({ PLAYWRIGHT_DIR: A_REAL_FILE, CMUX_BIN: path.join(REPO, 'no-such-cmux-binary') });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.err, /PRECONDITION FAILED/);
  assert.match(r.err, /CMUX_BIN/);
  assert.doesNotMatch(r.err, /PLAYWRIGHT_DIR does not point at a file/);
});

test('a precondition failure is exit 2 — distinguishable from a suite failure (1)', async () => {
  const r = await runRunner({});
  assert.strictEqual(r.code, 2);
});

test('a precondition that fails AFTER the fixtures exist still tears them down', () => {
  // Measured, not theorised: the first version of the runner called process.exit() for every
  // precondition and left a home-rooted fixture tree behind each time one fired past the build —
  // an exit inside try/finally never runs the finally.
  const src = codeOf(RUNNER);
  assert.match(src, /class PreconditionError/);
  assert.match(src, /\}\s*finally\s*\{\s*\n\s*await cleanup\(\);/);
  const body = src.slice(src.indexOf('async function main()'), src.indexOf('let exitCode'));
  assert.ok(body.length > 100, 'main() was not located');
  assert.doesNotMatch(body, /process\.exit\(/,
    'nothing inside main() may exit directly — cleanup would be skipped');
});

test('the fixture root derives from os.homedir() at runtime and never from os.tmpdir()', () => {
  const src = codeOf(RUNNER);
  assert.match(src, /os\.homedir\(\)/, 'the fixture root must be home-derived');
  // The offence is BUILDING the root out of the temp dir, not naming it in an error message.
  assert.doesNotMatch(src, /(join|resolve|mkdtemp)\(\s*os\.tmpdir\(\)/,
    'os.tmpdir() realpaths into /private on macOS, which §3.4 classifies BROAD — a temp-rooted parent anchors nothing');
  assert.match(src, /path\.join\(home, /, 'the root is built under the real home');
});

test('the runner guards its own fixture root against the production deny-set', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /PLATFORM_DENY/, 'the guard must use the shipped constant, not a copy of it');
  assert.match(src, /classifyBreadth/, 'and the shipped classifier, so the guard cannot drift from §3.4');
  assert.match(src, /require\(path\.join\(REPO, 'gitread\.js'\)\)/,
    'both must be imported from gitread.js rather than restated');
});

test('the runner boots THIS worktree on ephemeral ports, never the operator’s live pair', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /helpers', 'bridge-child\.js'/, 'the shipped bridge boot helper is reused');
  assert.match(src, /helpers', 'server-boot\.js'/, 'the shipped server boot helper is reused');
  // The helpers bind port 0; the runner additionally refuses if it somehow lands on the live pair.
  assert.match(src, /server\.port === 8080 \|\| bridge\.port === 8799/);
});

test('B4 gets a browsable-but-out-of-scope repo, which the default FS_ROOTS cannot provide', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /FS_ROOTS: `workspace-cwds:\$\{fixtureRoot\}`/);
});

test('the runner opens three workspace cwds, so the cold burst is more than one limiter round', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /fixtures\.parent, fixtures\.anchorA, fixtures\.anchorB/);
  assert.match(src, /fewer than three scratch workspaces/);
});

test('the fixture tree carries dirt, nesting, a detached child, hostile names, an out-of-scope repo, a shared clone and a retargetable symlink', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  for (const needed of [
    /checkout', '-q', '--detach'/,          // detached child (B6)
    /clone', '--shared'/,                   // an alternate pointing INSIDE the union
    /fsp\.symlink\(anchorA, link/,          // the retargetable symlink (B10)
    /outside-repo/,                         // out of scope (B4)
    /untracked\.txt/,                       // real dirt
    /objects', 'info', 'alternates'/,       // the rule-4 escape fixture
    /info', 'attributes'/,                  // the rule-3 fourth-door fixture
  ]) assert.match(src, needed, `the fixture tree is missing ${needed}`);
});

test('every §8.3 precondition is asserted, not assumed', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /assertFixtures/, 'the fixture checklist runs');
  assert.match(src, /pass vacuously|vacuously/, 'and says why an unmet precondition matters');
  assert.match(src, /the server does not classify the fixtures as the suite assumes/,
    'the runner asks the RUNNING server how it classifies each fixture before launching the browser');
  assert.match(src, /canWrite/, 'and pins the §6.5 capability split B9 rests on');
});

test('the smoke asserts absence by TEXT, never by a child count alone', () => {
  const src = fs.readFileSync(SMOKE, 'utf8');
  assert.match(src, /st\.text === ''/, 'a bar left attached and merely emptied must not satisfy a "no bar" assertion');
  assert.match(src, /domcontentloaded/);
  assert.doesNotMatch(src, /networkidle/, 'networkidle never settles against a polling mirror');
  assert.match(src, /width: 390, height: 844/);
});

test('navigation waits on the app’s own readiness signal, never on a sleep', () => {
  // The measured failure: leaving a directory whose fs/list is still in flight lets the held
  // response repaint that directory's rows over the roots screen, breadcrumb empty — rows present,
  // no root row, and the suite aborts six assertions from the end. A longer sleep would have hidden
  // it at a random threshold; waiting on #ffoot and re-checking the breadcrumb cannot.
  const src = codeOf(SMOKE);
  assert.match(src, /async function settleListing/);
  assert.match(src, /waitForFunction/, 'readiness is a waited condition, not an interval');
  assert.match(src, /ffoot/, 'and the condition is the listing’s own footer state');
  const nav = src.slice(src.indexOf('async function toFixtureRoot'), src.indexOf('async function waitForBarName'));
  assert.match(nav, /await settleListing\(page\)/, 'toFixtureRoot settles before it acts');
  assert.match(nav, /crumbPath\(page\) === F\.root/, 'and verifies it ARRIVED rather than assuming it');
  assert.match(nav, /deadline/, 'with a bounded converging loop');
});

test('the timed assertions are deliberately left unsettled, or they would measure nothing', () => {
  // settleListing() inside clickRow would dissolve B2's per-level probe count, B3's TTL window and
  // B7's out-of-order race — the three assertions whose whole subject is timing.
  const src = codeOf(SMOKE);
  const clickRow = src.slice(src.indexOf('async function clickRow'), src.indexOf('async function ensureFiles'));
  assert.doesNotMatch(clickRow, /settleListing/,
    'clickRow must stay raw: B2, B3 and B7 drive it directly to observe races');
});

test('the smoke carries p7’s precedent proofs: the index and HEAD are unchanged', () => {
  const src = fs.readFileSync(SMOKE, 'utf8');
  assert.match(src, /diff', '--cached', '--name-only'/);
  assert.match(src, /rev-parse', 'HEAD'/);
  assert.match(src, /NOTHING was committed/);
});

test('no runtime dependency is added — package.json declares scripts only', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies, 'no dependencies key may appear');
  assert.ok(!pkg.devDependencies, 'no devDependencies key may appear');
  assert.strictEqual(pkg.scripts['test:browser'], 'node test/p8-browser-run.mjs');
  // p8's own entry points must still be there…
  for (const k of ['bridge', 'radar', 'server', 'test', 'test:browser']) {
    assert.ok(pkg.scripts[k], 'p8 declared script ' + k + ' and it must survive');
  }
  // …but the roster is no longer FROZEN. It was a deepStrictEqual on the sorted key list, which made
  // every later feature that adds a script fail this test — p9's inbox eval/browser runners did, and
  // p9 branched before p8 existed, so it could not have updated a pin it never saw. The claim in the
  // title is about DEPENDENCIES, and freezing the script names asserts something else.
  //
  // What actually keeps the claim true is that every script runs node against a file IN THIS REPO:
  // no package manager, no binary resolved from node_modules, nothing to install.
  for (const [k, v] of Object.entries(pkg.scripts)) {
    const argv = String(v).trim().split(/\s+/);
    assert.strictEqual(argv[0], 'node',
      'script ' + k + ' must invoke node directly, not a package-manager binary: ' + v);
    const target = argv.slice(1).find((a) => !a.startsWith('-'));   // skip flags like --test
    assert.ok(target, 'script ' + k + ' must name something to run: ' + v);
    // `test` is a glob (node --test test/*.test.js), so the directory is what can be checked there.
    const probe = target.includes('*') ? path.dirname(target) : target;
    assert.ok(fs.existsSync(path.join(REPO, probe)),
      'script ' + k + ' must point into this repo, not an installed dependency: ' + target);
  }
});

test('public-repo hygiene: nothing machine-specific is committed', () => {
  // A node scan, deliberately: the shell `grep` on this machine is a ugrep wrapper that honours
  // .gitignore and returns false all-clears.
  //
  // The identifiers are DERIVED AT RUNTIME, never listed. A hygiene test that spells out the very
  // strings it forbids is itself a file containing them — which is the thing being forbidden.
  const machine = [
    [os.homedir(), 'this machine’s home directory'],
    [os.hostname(), 'this machine’s hostname'],
    [(() => { try { return os.userInfo().username; } catch (_) { return null; } })(), 'this machine’s username'],
  ].filter(([v]) => v && String(v).length > 2);

  const shapes = [
    [/\/Users\/[A-Za-z0-9._-]+/, 'an absolute home path'],
    [/\/Volumes\/[A-Za-z0-9._-]+/, 'an absolute volume path'],
    // Assembled from fragments for the same reason as above: spelled out, this line would BE the
    // offence it looks for, and the scan would fail on itself forever.
    [new RegExp(['Co', 'Authored', 'By'].join('-') + '|' + ['Agent', 'Session'].join('-')), 'a commit trailer'],
  ];

  for (const file of [RUNNER, SMOKE, __filename]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [value, what] of machine) {
      assert.ok(!src.includes(value), `${path.basename(file)} contains ${what}`);
    }
    for (const [re, what] of shapes) {
      const m = re.exec(src);
      assert.strictEqual(m, null, `${path.basename(file)} contains ${what}: ${m && m[0]}`);
    }
  }
});

test('both externals are placeholder defaults overridden by env, the p7 pattern', () => {
  const runner = fs.readFileSync(RUNNER, 'utf8');
  const smoke = fs.readFileSync(SMOKE, 'utf8');
  assert.match(runner, /process\.env\.PLAYWRIGHT_DIR\s*\n?\s*\|\|\s*'\/path\/to\//);
  assert.match(smoke, /process\.env\.PLAYWRIGHT_DIR \|\| '\/path\/to\//);
  assert.match(runner, /process\.env\.CMUX_BIN \|\|/);
});
