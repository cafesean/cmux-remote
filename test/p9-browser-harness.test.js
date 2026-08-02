'use strict';
// p9 S-011 — the tier-1 proof of the HARNESS ITSELF.
//
// The browser suite this harness drives is tier-2 and runs once, on a live Mac, with PLAYWRIGHT_DIR
// set. What is provable offline — and what this file proves — is the thing that decides whether that
// single on-device pass means anything:
//
//   1. The command the UI tier-2 ACs name actually exists and points at the script.
//   2. A missing precondition EXITS LOUDLY (code 2, naming PLAYWRIGHT_DIR), having booted nothing
//      and left nothing running. A harness that skips silently reports green for a run that never
//      happened, which is worse than having no harness at all.
//   3. The boot path really does bring up ONE server.js child FROM THIS WORKTREE, with radar mounted
//      and the automatic-scan switch set, on an ephemeral port parsed from its own startup line,
//      serving the injected fixture — and tears it down completely.
//
// The exit codes are a contract, not a convention: 0 green, 1 red, 2 precondition. Conflating 1 and
// 2 is how "the browser suite is green" comes to mean "Playwright was not installed".
//
// The scan switch is NOT re-proved here — S-006 owns it, under a real collector and a fake clock
// wound past 60 s, with a control child that DOES republish. This file proves the harness SETS it,
// and reads the fixture's own `generatedAt` back as the witness.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { validate } = require('../radar/schema-lite');
const stateSchema = require('../radar/state.schema.json');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'browser-inbox.mjs');
const SUITE = path.join(REPO, 'test', 'browser', 'inbox.browser.mjs');
const HARNESS_URL = pathToFileURL(SCRIPT).href;

const harness = () => import(HARNESS_URL);

// ---- small probes --------------------------------------------------------------------------------

// A process GROUP with no members is the strongest available "no orphan" answer: the harness's own
// children are spawned into its group, so anything it leaked — a server, a browser — is still a
// member after it exits. A port probe alone cannot say this, because on the precondition paths no
// port is ever bound to probe.
function groupHasMembers(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

function tcpProbe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (_) { /* already gone */ } resolve(v); };
    s.setTimeout(2000);
    s.on('connect', () => done('open'));
    s.on('timeout', () => done('timeout'));
    s.on('error', () => done('refused'));
  });
}

// The definitive liveness question, asked at the layer that matters: is THIS server still answering
// with THIS fixture? A bare TCP probe can be fooled by a sandbox that accepts every connect.
async function servesFixture(base, token, generatedAt) {
  try {
    const r = await fetch(`${base}/api/radar/inbox`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.generatedAt === generatedAt);
  } catch (_) { return false; }
}

// Run the harness as a real process, in its own group, and collect everything it said.
function runHarness(env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* already gone */ }
      reject(new Error(`harness did not exit in ${timeoutMs}ms\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    }, timeoutMs || 30000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, all: out + err, pgid: child.pid });
    });
  });
}

const scrubbedEnv = (over) => {
  const e = Object.assign({}, process.env, over || {});
  if (!over || !('PLAYWRIGHT_DIR' in over)) delete e.PLAYWRIGHT_DIR;
  return e;
};

// A private scratch root per assertion. `node --test` runs the tests in this file CONCURRENTLY, so
// counting `p9-browser-*` directories in the shared /tmp is a race against the neighbouring test —
// it is also how the first draft of this file failed. Every count below happens in a directory
// nothing else in the run can write to.
const privateRoot = async () => fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-harness-root-')));

// ==================================================================================================
// AC1 — the command exists (source assertion)
// ==================================================================================================

test('AC1: package.json declares test:browser:inbox and it invokes scripts/browser-inbox.mjs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const script = pkg.scripts && pkg.scripts['test:browser:inbox'];
  assert.strictEqual(typeof script, 'string', 'the UI tier-2 ACs name this script by name — it has to exist');
  assert.match(script, /scripts\/browser-inbox\.mjs/, `expected the script to invoke the harness, got ${JSON.stringify(script)}`);
  assert.ok(fs.existsSync(SCRIPT), 'and the file it names has to be there');
  assert.ok(fs.existsSync(SUITE), 'as does the browser suite it runs');
  // No new dependency crept in with it: zero-dependency CommonJS is a property of this repo, and
  // Playwright is BORROWED through PLAYWRIGHT_DIR precisely so it stays that way.
  assert.ok(!pkg.dependencies, 'the repo still declares no runtime dependencies');
  assert.ok(!pkg.devDependencies, 'and no devDependencies — Playwright is borrowed, never installed here');
});

test('the harness wires the child environment the story specifies, and never auto-runs on import', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // The env channel is the ONLY one a spawned server.js has: production server.js calls
  // createRadar() with no options, so an option would be inert here.
  assert.match(src, /RADAR_ENABLED:\s*'1'/, 'radar must be mounted inside the server child');
  assert.match(src, /RADAR_SCAN_ON_START:\s*'0'/, 'the automatic-scan switch is CONSUMED here (S-006 built it)');
  assert.match(src, /PORT:\s*'0'/, 'the port is ephemeral — never assumed');
  assert.match(src, /cmux-remote server on http/, 'and the BOUND port is parsed from the startup line');
  // server.js is resolved from this file's own directory, so the child is THIS worktree's server —
  // not whichever checkout the shell happened to be sitting in.
  assert.match(src, /SERVER_JS\s*=\s*path\.join\(REPO,\s*'server\.js'\)/);
  assert.match(src, /import\.meta\.url/, 'main() runs only when the script is EXECUTED, never when imported');
  // The suite is run in-process, which is what makes teardown-in-a-finally able to guarantee no
  // orphan: there is no second process holding the browser.
  assert.match(src, /finally\s*\{/, 'teardown runs on every path');
});

// ==================================================================================================
// The injected fixture — shape, and the privacy grammar
// ==================================================================================================

test('the injected state.json fixture is schema-valid, and its rows are the exact §5.3 shape', async () => {
  const { FIXTURE_STATE, FIXTURE_ROWS } = await harness();
  const v = validate(stateSchema, FIXTURE_STATE);
  assert.strictEqual(v.valid, true, v.errors.join('; '));
  assert.strictEqual(FIXTURE_STATE.counts.inbox, FIXTURE_ROWS.length, 'counts.inbox === inbox.length');
  assert.strictEqual(FIXTURE_STATE.inbox.length, 3);
  // The three rows the list ACs stand on: strictly ascending `blockedSince` (§5.4's ordering is the
  // server's contract, and the client is asserted NOT to re-sort), and one `unknown` verdict so the
  // REAL route computes `classifier: degraded` rather than the suite stubbing that line into being.
  const times = FIXTURE_ROWS.map((r) => Date.parse(r.blockedSince));
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
  assert.strictEqual(new Set(times).size, 3, 'three distinct ages, or "distinct ages" is untestable');
  assert.ok(FIXTURE_ROWS.some((r) => r.intent.verdict === 'unknown'), 'one unknown row → the route reports degraded');
  assert.ok(FIXTURE_ROWS.some((r) => r.question.length > 2000), 'one 2000+ character question for the card AC');
  assert.ok(FIXTURE_ROWS.every((r) => r.answerable === true && r.surface && r.surface.via === 'recorded'));
});

test('every fixture identifier is synthetic — the reserved grammar, and nothing that could identify a machine', async () => {
  const { FIXTURE_STATE } = await harness();
  for (const row of FIXTURE_STATE.inbox) {
    assert.match(row.sessionKey.sessionId, /^fixture-inbox-\d+$/, 'the reserved synthetic session grammar');
    assert.strictEqual(row.sessionKey.machine, 'fixture-box');
  }
  // Read the FILES, not the objects: a real identifier could just as easily sit in a comment, a
  // selector or a fixture the suite builds inline. Verified with node and a real regex — the shell
  // `grep` here is a ugrep wrapper that skips gitignored files and produces false all-clears.
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const HOME_PATH = /(^|[^\w])\/(Users|Volumes|home)\//;
  for (const f of [SCRIPT, SUITE, __filename]) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!UUID.test(src), `${path.basename(f)} carries a UUID-shaped token`);
    assert.ok(!HOME_PATH.test(src), `${path.basename(f)} carries an absolute home path`);
  }
});

// ==================================================================================================
// AC2 — preconditions exit 2, LOUDLY, having booted nothing
// ==================================================================================================

test('AC2: PLAYWRIGHT_DIR unset → exit 2 naming it, nothing booted, no process left behind', async () => {
  // TMPDIR is redirected into a private tree, so "it created no scratch RADAR_DIR" is a direct
  // reading of an empty directory rather than a guess about a shared /tmp.
  const root = await privateRoot();
  try {
    const r = await runHarness(scrubbedEnv({ TMPDIR: root }), 30000);

    assert.strictEqual(r.code, 2, `expected the precondition code, got ${r.code}\n${r.all}`);
    assert.match(r.err, /PRECONDITION FAILED/, 'it has to say what kind of failure this is');
    assert.match(r.err, /PLAYWRIGHT_DIR/, 'and name the thing the operator must set');
    assert.match(r.err, /PLAYWRIGHT_DIR=/, 'with a runnable example, not just a noun');
    // "Boots nothing" — read off the harness's own output. The bound-port line is printed the
    // instant the child comes up, so its absence is the observation, not an inference.
    assert.ok(!/harness: server on/.test(r.all), `no server may be announced:\n${r.all}`);
    assert.ok(!/cmux-remote server on/.test(r.all), 'and none may leak through from a child');
    // "Leaves no process" — the harness's own process group, probed after it exited. A port probe
    // cannot answer this on the precondition path, because no port is ever bound to probe.
    assert.strictEqual(groupHasMembers(r.pgid), false, 'the harness process group must be empty after exit');
    assert.deepStrictEqual(await fsp.readdir(root), [], 'a precondition failure must not create a scratch RADAR_DIR');
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('AC2: an unresolvable PLAYWRIGHT_DIR is the same loud failure, not a crash', async () => {
  const r = await runHarness(scrubbedEnv({ PLAYWRIGHT_DIR: path.join(os.tmpdir(), 'p9-no-such-playwright-' + Date.now(), 'index.mjs') }), 30000);
  assert.strictEqual(r.code, 2, `expected 2, got ${r.code}\n${r.all}`);
  assert.match(r.err, /PRECONDITION FAILED/);
  assert.match(r.err, /PLAYWRIGHT_DIR/, 'the message names the variable, not just the path');
  assert.ok(!/harness: server on/.test(r.all), 'still nothing booted');
  assert.strictEqual(groupHasMembers(r.pgid), false, 'still no process left behind');
});

test('AC2: all three resolution failures name PLAYWRIGHT_DIR and carry exit code 2', async () => {
  const { resolvePlaywright, PreconditionError } = await harness();
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-pwstub-')));
  try {
    const notPlaywright = path.join(dir, 'not-playwright.mjs');
    await fsp.writeFile(notPlaywright, 'export const somethingElse = 1;\n');
    const cases = [
      ['unset', {}],
      ['blank', { PLAYWRIGHT_DIR: '   ' }],
      ['unresolvable', { PLAYWRIGHT_DIR: path.join(dir, 'missing.mjs') }],
      ['resolvable but not Playwright', { PLAYWRIGHT_DIR: notPlaywright }],
    ];
    for (const [label, env] of cases) {
      await assert.rejects(
        () => resolvePlaywright(env),
        (e) => {
          assert.ok(e instanceof PreconditionError, `${label}: must be a PreconditionError`);
          assert.strictEqual(e.exitCode, 2, `${label}: precondition, never a red suite`);
          assert.match(e.message, /PLAYWRIGHT_DIR/, `${label}: names the variable`);
          return true;
        },
      );
    }
    // …and the positive control, or every assertion above is equally consistent with a resolver that
    // can never succeed.
    const stub = path.join(dir, 'playwright-stub.mjs');
    await fsp.writeFile(stub, 'export const chromium = { launch: async () => ({ stub: true }) };\n');
    const ok = await resolvePlaywright({ PLAYWRIGHT_DIR: stub });
    assert.strictEqual(typeof ok.chromium.launch, 'function');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ==================================================================================================
// AC3 — the boot path: ONE server child, from this worktree, serving the injected fixture
// ==================================================================================================

test('AC3: the boot path brings up ONE server.js child from THIS worktree, serving the injected fixture, and tears it down', async () => {
  const mod = await harness();
  const { bootHarnessServer, resolvePlaywright, FIXTURE_STATE, FIXTURE_GENERATED_AT, TOKEN } = mod;

  const stubDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-pwstub-')));
  const stub = path.join(stubDir, 'playwright-stub.mjs');
  await fsp.writeFile(stub, 'export const chromium = { launch: async () => ({ stub: true }) };\n');

  // A stub in place of Playwright: the boot path is what is under test, and a real browser would add
  // nothing to it. Resolving first also proves the ORDER — preconditions before anything is spawned.
  const { chromium } = await resolvePlaywright({ PLAYWRIGHT_DIR: stub });
  assert.strictEqual(typeof chromium.launch, 'function');

  const root = await privateRoot();
  const srv = await bootHarnessServer({ tmpRoot: root });
  let stopped = false;
  try {
    // ONE child, and exactly one scratch tree. Importing the module spawned nothing — this is the
    // first and only server, which is also what proves the no-auto-run guard at runtime.
    assert.deepStrictEqual(await fsp.readdir(root), [path.basename(srv.scratch)],
      'exactly one scratch tree, for exactly one child');
    assert.ok(srv.alive(), 'the child is up');
    assert.strictEqual(typeof srv.child.pid, 'number');

    // The port was PARSED from the child's own startup output, and it is ephemeral — never the
    // requested 0, and never the real server's 8080.
    assert.ok(Number.isInteger(srv.port) && srv.port > 1024, `expected an ephemeral port, got ${srv.port}`);
    assert.notStrictEqual(srv.port, 8080);
    assert.match(srv.stdout(), new RegExp(`cmux-remote server on http://127\\.0\\.0\\.1:${srv.port}\\b`));
    assert.strictEqual(srv.base, `http://127.0.0.1:${srv.port}`);
    assert.strictEqual(await tcpProbe(srv.port), 'open', 'the parsed port is the one actually listening');

    // RADAR_ENABLED reached the child: with radar off, /api/radar/* is not mounted at all.
    const r = await fetch(`${srv.base}/api/radar/inbox`, { headers: { authorization: `Bearer ${srv.token}` } });
    const raw = await r.text();
    assert.strictEqual(r.status, 200, raw);
    const body = JSON.parse(raw);
    assert.strictEqual(body.generatedAt, FIXTURE_GENERATED_AT, 'the FIXTURE generatedAt, not one a boot scan minted');
    assert.deepStrictEqual(body.items, FIXTURE_STATE.inbox, 'the injected rows, verbatim');
    assert.strictEqual(body.sources.classifier, 'degraded', 'read back off the unknown row the fixture carries');

    // SERVER_TOKEN reached it too — "with the token" is half the AC, and a route that answered
    // without one would make every browser assertion untrustworthy.
    assert.strictEqual(TOKEN, srv.token);
    const noAuth = await fetch(`${srv.base}/api/radar/inbox`);
    assert.strictEqual(noAuth.status, 401, 'the API is gated');

    // It is THIS worktree's server: the bytes it serves for /inbox.js are the bytes on disk here.
    const served = await (await fetch(`${srv.base}/inbox.js`)).text();
    assert.strictEqual(served, fs.readFileSync(path.join(REPO, 'public', 'inbox.js'), 'utf8'),
      '/inbox.js must be this worktree\'s file, not another checkout\'s');

    // RADAR_SCAN_ON_START reached it: give a boot scan every chance to fire before claiming it did
    // not. S-006 proves the guard itself under a fake clock; this proves the harness SETS it.
    const beforeBytes = await fsp.readFile(srv.statePath);
    await new Promise((res) => setTimeout(res, 1500));
    const afterBytes = await fsp.readFile(srv.statePath);
    assert.ok(beforeBytes.equals(afterBytes), 'state.json is byte-identical — nothing rescanned over the fixture');
    const again = await fetch(`${srv.base}/api/radar/inbox`, { headers: { authorization: `Bearer ${srv.token}` } });
    assert.strictEqual((await again.json()).generatedAt, FIXTURE_GENERATED_AT);
    assert.ok(srv.alive(), 'and the child is still serving');

    // ---- teardown, and the port probed after it ------------------------------------------------
    await srv.stop();
    stopped = true;
    assert.ok(!srv.alive(), 'the child exited');
    assert.strictEqual(fs.existsSync(srv.scratch), false, 'the scratch tree — RADAR_DIR included — is gone');
    assert.strictEqual(await servesFixture(srv.base, srv.token, FIXTURE_GENERATED_AT), false,
      'nothing is answering on the parsed port after teardown');
    const probe = await tcpProbe(srv.port);
    assert.notStrictEqual(probe, 'open', `the parsed port must not still be listening (probe: ${probe})`);
  } finally {
    if (!stopped) { try { await srv.stop(); } catch (_) { /* leaving anyway */ } }
    await fsp.rm(stubDir, { recursive: true, force: true });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC3: a FAILING run exits 1 (never 2), and teardown still leaves no orphan on the parsed port', async () => {
  // The other half of the exit-code contract, at the process level. A stub driver that resolves and
  // then refuses to launch takes the harness all the way through the boot — server up, port
  // announced — and fails in the suite. That must read as a RED SUITE, not as a precondition, and
  // the `finally` must still take the server down.
  const root = await privateRoot();
  const stubDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-pwstub-')));
  try {
    const stub = path.join(stubDir, 'playwright-stub.mjs');
    await fsp.writeFile(stub, "export const chromium = { launch: async () => { throw new Error('stub driver refuses to launch'); } };\n");

    const r = await runHarness(scrubbedEnv({ PLAYWRIGHT_DIR: stub, TMPDIR: root }), 60000);
    assert.strictEqual(r.code, 1, `a failing suite is exit 1, never 2\n${r.all}`);
    assert.ok(!/PRECONDITION FAILED/.test(r.all), 'and it must not be reported as a precondition');
    assert.match(r.err, /stub driver refuses to launch/, 'the real reason reaches the operator');

    // The server DID come up on this path — so here the port probe is meaningful, and it is the
    // parsed port, read back out of the harness's own announcement.
    const m = /harness: server on http:\/\/127\.0\.0\.1:(\d+)/.exec(r.out);
    assert.ok(m, `the harness must announce the port it bound:\n${r.all}`);
    const port = Number(m[1]);
    assert.ok(port > 1024 && port !== 8080, `expected an ephemeral port, got ${port}`);

    assert.strictEqual(groupHasMembers(r.pgid), false, 'teardown runs on the failure path too — no orphan');
    const probe = await tcpProbe(port);
    assert.notStrictEqual(probe, 'open', `nothing may still be listening on the parsed port (probe: ${probe})`);
    assert.deepStrictEqual(await fsp.readdir(root), [], 'and the scratch RADAR_DIR is gone with it');
  } finally {
    await fsp.rm(stubDir, { recursive: true, force: true });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('AC3: a second boot gets its OWN ephemeral port and its OWN isolated RADAR_DIR', async () => {
  const { bootHarnessServer } = await harness();
  const root = await privateRoot();
  const a = await bootHarnessServer({ tmpRoot: root });
  let b = null;
  try {
    b = await bootHarnessServer({ tmpRoot: root });
    assert.notStrictEqual(a.port, b.port, 'PORT=0 means two harness runs can never collide');
    assert.notStrictEqual(a.radarDir, b.radarDir, 'and neither can their radar state');
    assert.ok(a.radarDir.startsWith(a.scratch) && b.radarDir.startsWith(b.scratch));
    assert.strictEqual((await fsp.readdir(root)).length, 2, 'two boots, two scratch trees, no sharing');
    // HOME is the scratch tree, so anything falling back to ~/.radar lands in the temp tree and no
    // run can touch the operator's real radar state.
    assert.ok(a.scratch !== os.homedir());
  } finally {
    await a.stop();
    if (b) await b.stop();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
