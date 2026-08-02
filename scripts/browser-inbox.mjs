// p9 S-011 — the browser harness the UI tier-2 ACs name: `npm run test:browser:inbox`.
//
// Playwright is BORROWED, not depended on. This repo has zero dependencies of its own and keeps it
// that way, so there is no node_modules here to resolve a browser driver from. Point PLAYWRIGHT_DIR
// at any Playwright install you have:
//
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs npm run test:browser:inbox
//
// WHAT THIS HARNESS BOOTS, AND WHY IT IS ONE PROCESS.
//
// `radar-server.js` is NOT standalone — it has no listener and no CLI of its own. It is created and
// mounted INSIDE `server.js` by `createRadar()` when RADAR_ENABLED is set. So there is exactly ONE
// child here: a real `server.js` from THIS worktree, on an ephemeral port, over an isolated
// RADAR_DIR carrying an injected fixture `state.json`. Everything the page loads — index.html,
// app.js, inbox.js, sw.js — is the shipped file off disk, served by the shipped routes.
//
// THE SCAN SWITCH IS CONSUMED HERE, NOT BUILT HERE. S-006 landed the RADAR_SCAN_ON_START guard and
// its ACs prove it (a real collector under a fake clock wound past 60 s, the env-to-option wiring,
// option precedence, and a control child that DOES republish). This harness simply sets
// RADAR_SCAN_ON_START=0 in the child's environment. Without it the boot scan — or the 60-second
// session sweep — would republish state.json over the fixture, and "the suite usually finishes
// inside the first tick" is a race, not a guarantee.
//
// PORT=0 IS EPHEMERAL. The server logs its BOUND port; this parses it. No port number is ever
// assumed, so a harness run can never collide with a real server on :8080.
//
// SCOPE — the deterministic fixture suite ONLY. This runs S-008's browser ACs and S-009's
// fixture-driven browser ACs, with stubbed reply responses where a live bridge would otherwise be
// needed. It configures NO bridge, selects NO live session, and does not require CMUX_BIN. The live
// on-device items — S-007's sacrificial-session probe and S-009's answered-row-gone proof — belong
// to the operator's HG-1 pass, not to this harness (spec §9).
//
// PRECONDITIONS ARE LOUD. A harness that quietly passes when it did not run is worse than no
// harness, so every external requirement is asserted BY NAME before anything is booted:
//
//   exit 0  every check passed
//   exit 1  the browser suite reported a failure
//   exit 2  a precondition failed — nothing was booted, nothing was left running
//
// Teardown runs in a `finally` on every path, including a precondition failure and a throw.
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import fsp from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.join(HERE, '..');
export const SERVER_JS = path.join(REPO, 'server.js');
export const SUITE_JS = path.join(REPO, 'test', 'browser', 'inbox.browser.mjs');

const BOOT_TIMEOUT_MS = 20000;

// The child's token. Synthetic, local to one temp tree, and gone with it.
export const TOKEN = 'fixture-inbox-token';
// Every identifier below is INVENTED. This repository is public: no fixture may carry a real
// session id, machine name, host, branch or absolute home path.
export const MACHINE = 'fixture-box';
// A value no scan would ever mint, so "the fixture survived" and "a scan republished it" are told
// apart by reading one field rather than by timing.
export const FIXTURE_GENERATED_AT = '2026-01-02T03:04:05.000Z';
// The instant the list-rendering contexts pin their clock to. Chosen so the three fixture rows have
// three DISTINCT relative ages (59m / 29m / 9m) — without pinning it, every row's age would round to
// the same number of days and "distinct ages" would be untestable.
export const FIXTURE_NOW = '2026-01-02T03:59:00.000Z';

// A question long enough that the card must scroll to show all of it (S-008 AC8 wants 2000+).
// Built from an invented sentence so the bytes are ours, not a transcript's.
const LONG_QUESTION = (() => {
  const para = 'The retry budget can be charged per request or per batch, and the two disagree once a '
    + 'batch is partially retried. Per request is simpler to reason about and harder to bound; per '
    + 'batch bounds the blast radius but hides which item actually failed. ';
  let out = 'Which retry accounting should the dispatcher use?\n\n';
  while (out.length < 2400) out += para;
  return out + '\n\nSay per-request or per-batch and I will wire it that way.';
})();

export const FIXTURE_LONG_QUESTION = LONG_QUESTION;

// The exact §5.3 row, written out in full rather than assembled by a helper with defaults hidden
// somewhere else: the shape IS the contract, and a reader should be able to check it against the
// spec without chasing an indirection.
export function inboxRow(over) {
  return Object.assign({
    sessionKey: { machine: MACHINE, sessionId: 'fixture-inbox-1' },
    blockedSince: '2026-01-02T03:00:00.000Z',
    lastStopAt: '2026-01-02T02:58:57.000Z',
    cacheExpiresAt: null,
    cacheApprox: true,
    notificationType: 'idle_prompt',
    turn: { blockedSince: '2026-01-02T03:00:00.000Z', assistantTs: '2026-01-02T02:58:57.000Z' },
    repo: 'sample-service',
    worktree: null,
    epic: null,
    question: 'Should the retry budget be per request or per batch?',
    intent: {
      verdict: 'needs-decision', reason: 'ends on a direct question',
      model: 'fixture-model', at: '2026-01-02T03:00:04.000Z', inferred: true,
    },
    surface: { workspace: 'fixture-workspace', tabRef: 'w0/t1', tabUuid: 'fixture-tab-uuid-1', via: 'recorded' },
    surfaceReason: null,
    answerable: true,
    actions: [{ kind: 'reply' }],
  }, over || {});
}

// The three rows the INJECTED state.json carries — the only payload in this harness that reaches the
// page through the real collector and the real route. Oldest first, per §5.4's ordering contract.
// One row is `unknown`, which is also what makes the real route report `classifier: degraded`.
export const FIXTURE_ROWS = [
  inboxRow({
    sessionKey: { machine: MACHINE, sessionId: 'fixture-inbox-1' },
    blockedSince: '2026-01-02T03:00:00.000Z',
    turn: { blockedSince: '2026-01-02T03:00:00.000Z', assistantTs: '2026-01-02T02:58:57.000Z' },
    repo: 'sample-service',
    epic: 'PROJ-201',
    question: LONG_QUESTION,
  }),
  inboxRow({
    sessionKey: { machine: MACHINE, sessionId: 'fixture-inbox-2' },
    blockedSince: '2026-01-02T03:30:00.000Z',
    lastStopAt: null,
    turn: { blockedSince: '2026-01-02T03:30:00.000Z', assistantTs: null },
    repo: 'sample-tools',
    question: 'Ready when you are.',
    intent: {
      verdict: 'unknown', reason: 'no credential',
      model: null, at: '2026-01-02T03:30:04.000Z', inferred: true,
    },
    surface: { workspace: 'fixture-workspace', tabRef: 'w0/t2', tabUuid: 'fixture-tab-uuid-2', via: 'recorded' },
  }),
  inboxRow({
    sessionKey: { machine: MACHINE, sessionId: 'fixture-inbox-3' },
    blockedSince: '2026-01-02T03:50:00.000Z',
    lastStopAt: '2026-01-02T03:49:12.000Z',
    turn: { blockedSince: '2026-01-02T03:50:00.000Z', assistantTs: '2026-01-02T03:49:12.000Z' },
    repo: 'sample-web',
    question: 'Do you want the migration split into two steps, or one?',
    surface: { workspace: 'fixture-workspace', tabRef: 'w0/t3', tabUuid: 'fixture-tab-uuid-3', via: 'recorded' },
  }),
];

// A snapshot the shipped schema validates (the tier-1 harness test checks exactly that). Everything
// outside `inbox` is the minimum a leader snapshot carries; the collector never runs here.
export const FIXTURE_STATE = {
  v: 1,
  generatedAt: FIXTURE_GENERATED_AT,
  collectorId: MACHINE,
  machines: [{ id: MACHINE, bridge: 'unknown', lastSeenAt: null }],
  sources: {
    git: { status: 'disabled' },
    sessions: { status: 'disabled' },
    deploy: { status: 'disabled' },
    jira: { status: 'disabled' },
    specs: { status: 'disabled' },
    config: { status: 'disabled' },
  },
  counts: {
    blocked: 0, decisions: 0, mergeable: 0, orphans: 0,
    staleWorktrees: 0, handoffsLive: 0, inbox: FIXTURE_ROWS.length,
  },
  repos: {},
  epics: [],
  sessions: [],
  attention: [],
  handoffs: [],
  handoffRecovery: null,
  inbox: FIXTURE_ROWS,
  role: 'leader',
};

// ---- preconditions ------------------------------------------------------------------------------

// Thrown only for things the operator has to fix before a run can mean anything. It carries exit
// code 2 so a precondition can never be mistaken for a red suite.
export class PreconditionError extends Error {
  constructor(message) { super(message); this.name = 'PreconditionError'; this.exitCode = 2; }
}

export const PLAYWRIGHT_HINT =
  'Set PLAYWRIGHT_DIR to a Playwright entry point, e.g.\n'
  + '    PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs npm run test:browser:inbox';

// Resolve the BORROWED driver. Named failures on every branch: unset, unresolvable, and resolvable
// but not actually Playwright are three different operator problems and get three different
// sentences. There is deliberately NO bare-specifier fallback — this repo has no node_modules, so a
// silent `import('playwright')` would only ever resolve someone else's global install and make the
// run unreproducible.
export async function resolvePlaywright(env) {
  const e = env || process.env;
  const dir = e.PLAYWRIGHT_DIR;
  if (!dir || !String(dir).trim()) {
    throw new PreconditionError('PLAYWRIGHT_DIR is not set — Playwright is borrowed, not a dependency of this repo.\n  ' + PLAYWRIGHT_HINT);
  }
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.resolve(String(dir).trim())).href);
  } catch (err) {
    throw new PreconditionError(`PLAYWRIGHT_DIR (${dir}) could not be imported: ${(err && err.message) || err}\n  ` + PLAYWRIGHT_HINT);
  }
  const chromium = mod && (mod.chromium || (mod.default && mod.default.chromium));
  if (!chromium || typeof chromium.launch !== 'function') {
    throw new PreconditionError(`PLAYWRIGHT_DIR (${dir}) resolved, but it exports no usable \`chromium\`.\n  ` + PLAYWRIGHT_HINT);
  }
  return { chromium, module: mod };
}

// The suite file and the server this harness drives both live in THIS worktree. Asserted by name so
// a half-checked-out tree fails at the top instead of somewhere inside a browser context.
export function assertLocalFiles() {
  if (!existsSync(SERVER_JS)) throw new PreconditionError(`server.js not found at ${path.relative(REPO, SERVER_JS) || 'server.js'} — the harness boots the server from THIS worktree.`);
  if (!existsSync(SUITE_JS)) throw new PreconditionError(`the browser suite ${path.relative(REPO, SUITE_JS)} is missing — nothing to run.`);
}

// ---- the one server child -----------------------------------------------------------------------

// Boots a REAL `server.js` from this worktree, with radar mounted inside it.
//
// Two isolations, both of which have bitten this kind of test before:
//   * cwd is a scratch dir, never the repo — loadenv.js reads ./.env from the CWD, so a run inside
//     the repo would silently inherit a developer's real SERVER_TOKEN, PORT and machine registry.
//   * HOME points at the scratch dir, so anything falling back to os.homedir() (radar's default
//     ~/.radar) lands in the temp tree. No run can touch real radar state.
//
// CMUX_MACHINES declares ONE synthetic machine pointed at a closed port. That is not a bridge: it
// is the minimum that lets app.js get past its "No machines configured" gate so the inbox tab is
// reachable at all. Every bridge call refuses immediately and the page renders `bridge_unreachable`,
// which is exactly the state this harness wants — no live tabs, no live sessions, no cmux.
// `tmpRoot` overrides where the scratch tree is made. Only the tier-1 harness test passes it, so
// that "exactly ONE scratch tree, for exactly ONE child" can be counted in a directory nothing else
// writes to — a scan of the shared /tmp is a race against every other test in the run.
export async function bootHarnessServer(opts) {
  const o = opts || {};
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(o.tmpRoot || tmpdir(), 'p9-browser-')));
  const radarDir = path.join(scratch, 'radar-home');
  await fsp.mkdir(radarDir);
  await fsp.writeFile(path.join(radarDir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', scanIntervalMin: 10, sessionSweepSec: 60, repos: [],
  }));
  const statePath = path.join(radarDir, 'state.json');
  await fsp.writeFile(statePath, JSON.stringify(o.state || FIXTURE_STATE, null, 2));

  const token = o.token || TOKEN;
  const env = Object.assign({
    PATH: process.env.PATH,
    HOME: scratch,
    TMPDIR: process.env.TMPDIR || '/tmp',
    HOST: '127.0.0.1',
    PORT: '0',                       // ephemeral — the BOUND port is parsed from stdout below
    SERVER_TOKEN: token,
    RADAR_ENABLED: '1',
    RADAR_SCAN_ON_START: '0',        // consumed here; S-006 built and proved the guard
    RADAR_DIR: radarDir,
    CMUX_MACHINES: JSON.stringify([{ id: MACHINE, label: MACHINE, baseUrl: 'http://127.0.0.1:1' }]),
  }, o.env || {});

  const child = spawn(process.execPath, [SERVER_JS], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } }, 3000);
      await exited;
      clearTimeout(hard);
    }
    await fsp.rm(scratch, { recursive: true, force: true });
  };

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const fail = (m) => reject(new Error(`${m}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
      const timer = setTimeout(() => fail(`server did not announce a port in ${BOOT_TIMEOUT_MS}ms`), BOOT_TIMEOUT_MS);
      // The BOUND port, never the requested one — they differ precisely because PORT=0.
      const check = () => {
        const m = /cmux-remote server on http:\/\/[^:\s]+:(\d+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      };
      child.stdout.on('data', check);
      child.on('exit', (code, signal) => { clearTimeout(timer); fail(`server exited early (code=${code} signal=${signal})`); });
      child.on('error', (e) => { clearTimeout(timer); fail(`spawn failed: ${e.message}`); });
      check();
    });
  } catch (e) {
    await cleanup();
    throw e;
  }

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    token,
    child,
    scratch,
    radarDir,
    statePath,
    stdout: () => out,
    stderr: () => err,
    alive: () => child.exitCode === null && child.signalCode === null,
    stop: cleanup,
  };
}

// ---- main ---------------------------------------------------------------------------------------

export async function main(argv, env) {
  const e = env || process.env;
  let server = null;
  try {
    // Everything external, by name, BEFORE anything is booted. Nothing below this block can leave a
    // process behind, because nothing below this block has started one.
    assertLocalFiles();
    const { chromium } = await resolvePlaywright(e);

    const suite = await import(pathToFileURL(SUITE_JS).href);
    if (typeof suite.run !== 'function') {
      throw new PreconditionError(`${path.relative(REPO, SUITE_JS)} exports no \`run\` — the harness has nothing to call.`);
    }

    server = await bootHarnessServer({});
    // The line the tier-1 harness test parses, and the only place a port is ever printed. It is
    // emitted BEFORE the suite runs so a failed suite still tells the operator where it ran.
    console.log(`harness: server on ${server.base}`);
    console.log(`harness: radar dir ${server.radarDir}`);

    const outcome = await suite.run({
      chromium,
      base: server.base,
      token: server.token,
      fixture: FIXTURE_STATE,
      now: FIXTURE_NOW,
      log: (line) => console.log(line),
    });

    const passed = Number(outcome && outcome.passed) || 0;
    const failed = Number(outcome && outcome.failed) || 0;
    console.log(`\n${passed}/${passed + failed} checks passed`);
    if (failed) {
      console.error(`${failed} FAILED`);
      return 1;
    }
    console.log('p9 inbox browser harness: OK');
    return 0;
  } catch (err) {
    if (err instanceof PreconditionError) {
      console.error(`PRECONDITION FAILED: ${err.message}`);
      return 2;
    }
    console.error(`p9 inbox browser harness: ${(err && err.stack) || err}`);
    return 1;
  } finally {
    // Always. A failed suite, a thrown assertion and a precondition all land here, and a harness
    // that leaks a server is a harness that poisons the next run.
    if (server) { try { await server.stop(); } catch (_) { /* leaving anyway */ } }
  }
}

// Only when EXECUTED, never when imported — the tier-1 harness test imports this module to drive the
// boot path directly, and an auto-run would spawn a server the moment `node --test` loaded it.
const invokedDirectly = !!(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
