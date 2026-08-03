'use strict';
// p6 S-005 (protocol half) — the §M2 spawn adapter against REAL processes: positional argv
// delivery through the env scrub, the /usr/bin/script leader, the measured process shape (worker
// in its OWN process group), the duplicate-worker hole and its closure by the sessionUuid dispatch
// set, the descent leg with persistence, and the pty log / bridgeSessionId parse.
//
// Every process spawned here is killed before the test ends. The real `claude` bullets of S-005
// (transcript at plan.transcriptPath from the real binary, retained replayable command) belong to
// fixtures/s005-spawn/run.sh and are NOT reproduced with stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { createHandoff } = require('../radar/handoff.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-handoff-'));
process.env.HOME = tmpdir();

const T0 = Date.parse('2026-08-01T07:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function standin(dir, body) {
  const p = path.join(dir, 'claude-standin.sh');
  fs.writeFileSync(p, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "9.9.9 (stand-in)"; exit 0; fi\n' + body);
  fs.chmodSync(p, 0o755);
  return p;
}

function fixtureState() {
  return {
    v: 1, generatedAt: iso(T0), collectorId: 'mac-test',
    machines: [], counts: {}, sessions: [],
    sources: { git: { status: 'ok' }, sessions: { status: 'ok' }, deploy: { status: 'ok' }, jira: { status: 'ok' }, specs: { status: 'ok' }, config: { status: 'ok' } },
    repos: { repoA: { branches: [{ name: 'b0', epic: 'PROJ-1', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null }], worktrees: [] } },
    epics: [{ key: 'PROJ-1', signals: [], repos: ['repoA'] }],
    attention: [],
  };
}

// REAL spawn, REAL ps, REAL kill — only the clock is injected.
function world(binBody, config) {
  const dir = tmpdir();
  const bin = standin(dir, binBody);
  let t = T0;
  const api = createHandoff({
    dir,
    config: Object.assign({
      collectorId: 'mac-test', repos: [{ id: 'repoA', path: dir }], polyrepoRoot: dir,
      claudeBin: bin, confirmMs: 400, goneGraceMs: 1000, sessionQuietMs: 1800000,
      discardKillMs: 100, previewTtlMs: 120000, seedMaxBytes: 12288,
    }, config),
    getState: () => fixtureState(),
    now: () => t,
    log: () => {},
    buildBrief: (s, sels) => ({ text: `BRIEF ${sels.join(' ')}` }),
  });
  return { dir, bin, api, advance: (ms) => { t += ms; } };
}

const ledger = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'handoffs', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; }
};
const locksOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'handoffs', 'locks.json'), 'utf8')).locks; } catch (_) { return {}; } };

const psTable = () => execSync('/bin/ps -axww -o pid=,ppid=,pgid=,command=', { maxBuffer: 32 * 1024 * 1024 }).toString();
function rowsFor(needle) {
  const out = [];
  for (const line of psTable().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && m[4].includes(needle)) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function killHard(pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ } }
function killAllByUuid(uuid) {
  for (const r of rowsFor(uuid)) killHard(r.pid);
}
async function until(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function dispatch(w, seedOverride) {
  const pr = await w.api.preview(seedOverride === undefined ? { selectors: ['epic:PROJ-1'] } : { selectors: ['epic:PROJ-1'], seedOverride });
  assert.strictEqual(pr.status, 200, JSON.stringify(pr.body));
  const r = await w.api.commit({ previewId: pr.body.plan.previewId, hash: pr.body.hash, idempotencyKey: `k-${pr.body.plan.previewId.slice(0, 8)}` });
  return { plan: pr.body.plan, res: r };
}

test('the wrapper source is the §M2 literal: scrub + exec script with the binary as $1', () => {
  const src = fs.readFileSync(require.resolve('../radar/handoff.js'), 'utf8');
  assert.ok(src.includes('for v in $(/usr/bin/env | /usr/bin/grep -iE "^(CLAUDE|CMUX|AI_AGENT|GHOSTTY)" | /usr/bin/cut -d= -f1); do'));
  assert.ok(src.includes('unset "$v"'));
  assert.ok(src.includes('exec /usr/bin/script -q /dev/null "$1" "${@:2}"'));
  // The one store-only-writes exemption, by name: script writes logPath, radar only opens it.
  assert.strictEqual((src.match(/fs\.openSync\(/g) || []).length, 1);
  assert.ok(src.includes("fs.openSync(plan.logPath, 'a')"));
});

test('adapter delivers exactly 6 argv elements through the scrub; the seed is ONE unmodified argument', async () => {
  const out = tmpdir();
  process.env.OUT_DIR = out;                       // not matched by the scrub — survives
  process.env.CLAUDE_BIN = '/tmp/trap-bin';        // the scrub MUST eat these four…
  process.env.CMUX_TEST_VAR = 'x';
  process.env.AI_AGENT_TEST = 'y';
  process.env.GHOSTTY_TEST = 'z';
  const w = world([
    'for a in "$@"; do printf \'%s\\0\' "$a" >> "$OUT_DIR/args.bin"; done',
    '/usr/bin/env > "$OUT_DIR/env.txt"',
    'exit 0',
  ].join('\n') + '\n');
  const seed = 'line one\nhas "double" \'single\' `tick` and a literal $HOME at the end';
  let plan;
  try {
    ({ plan } = await dispatch(w, seed));
    assert.ok(await until(() => fs.existsSync(path.join(out, 'env.txt')), 3000), 'the binary still executed — the scrub did not eat it');
    const args = fs.readFileSync(path.join(out, 'args.bin'), 'utf8').split('\0');
    assert.strictEqual(args.pop(), '');            // trailing NUL
    assert.deepStrictEqual(args, plan.argv, 'element-for-element, no shell re-parsing');
    assert.strictEqual(args.length, 6);
    assert.strictEqual(args[5], seed + '\nFIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until the operator replies.');
    assert.ok(!args.includes('--dangerously-skip-permissions'), 'read from what the adapter was CALLED WITH, never source text');
    const env = fs.readFileSync(path.join(out, 'env.txt'), 'utf8');
    for (const v of ['CLAUDE_BIN', 'CMUX_TEST_VAR', 'AI_AGENT_TEST', 'GHOSTTY_TEST']) {
      assert.ok(!env.split('\n').some((l) => l.startsWith(`${v}=`)), `${v} must be scrubbed from the child`);
    }
    assert.ok(env.split('\n').some((l) => l.startsWith('OUT_DIR=')), 'the scrub is targeted, not a wipe');
  } finally {
    delete process.env.CLAUDE_BIN; delete process.env.CMUX_TEST_VAR;
    delete process.env.AI_AGENT_TEST; delete process.env.GHOSTTY_TEST; delete process.env.OUT_DIR;
    if (plan) killAllByUuid(plan.sessionUuid);
  }
});

test('PROCESS SHAPE, measured: child.pid is the script leader; the worker is a different pid in a DIFFERENT pgid', async () => {
  const w = world('sleep 30\n');
  let plan, leader;
  try {
    const d = await dispatch(w);
    plan = d.plan;
    assert.strictEqual(d.res.status, 202);
    const proc = ledger(w.dir).find((x) => x.t === 'process');
    leader = proc.pid;
    assert.ok(typeof proc.psStartedAt === 'string' && proc.psStartedAt.length > 0, 'psStartedAt from /bin/ps -p <pid> -o lstart=');
    const cmd = execSync(`/bin/ps -p ${leader} -o command=`).toString().trim();
    assert.ok(cmd.startsWith('/usr/bin/script'), `child.pid names the live script leader: ${cmd}`);
    // One capture answers the whole shape question (the 2026-08-01 measurement, reproduced).
    const rows = rowsFor(plan.sessionUuid);
    const leaderRow = rows.find((r) => r.pid === leader);
    const worker = rows.find((r) => r.pid !== leader && r.ppid === leader);
    assert.ok(leaderRow && worker, 'both the leader and the worker carry the sessionUuid');
    assert.notStrictEqual(worker.pgid, leaderRow.pgid, 'script puts its child in its OWN process group');
  } finally {
    if (plan) killAllByUuid(plan.sessionUuid);
    if (leader) killHard(leader);
  }
});

test('THE DUPLICATE-WORKER HOLE, proven and then closed by the dispatch set', async () => {
  // A worker that traps HUP survives its leader — the §2.1 measured scenario. Leader-only
  // liveness would read `absent` here and release the fact keys of a live worker.
  const w = world("trap '' HUP\nsleep 30\n");
  let plan, leader, worker;
  try {
    const d = await dispatch(w);
    plan = d.plan;
    leader = ledger(w.dir).find((x) => x.t === 'process').pid;
    // One sweep first, so the worker pid is OBSERVED and PERSISTED while the leader lives.
    await w.api.sweep();
    const delta = ledger(w.dir).filter((x) => x.t === 'process').pop();
    const persisted = delta.observedPids.map((x) => x.pid);
    worker = rowsFor(plan.sessionUuid).find((r) => r.pid !== leader).pid;
    assert.ok(persisted.includes(worker), 'the sweep persisted the worker as a delta process record');

    process.kill(leader, 'SIGKILL');
    await until(() => !alive(leader), 2000);
    assert.ok(!alive(leader), 'the leader is ESRCH');
    assert.ok(alive(worker), 'and the worker is still alive');
    assert.throws(() => process.kill(-leader, 0), 'the leader pgid is NOT a remedy — the group is gone');

    // The module must read ALIVE (identity leg) and release nothing, indefinitely.
    w.advance(60 * 60 * 1000);
    await w.api.sweep();
    assert.ok(!ledger(w.dir).some((x) => x.t === 'status' && x.to === 'abandoned'), 'a live worker is never abandoned');
    assert.strictEqual(Object.keys(locksOf(w.dir)).length, plan.factKeys.length, 'and releases NO key');

    // Kill the WHOLE dispatch set — worker AND every persisted descendant. The sweep's descent
    // leg observed the stand-in's `sleep` child too (and now FOLDS it into memory), so killing
    // only leader+worker correctly leaves the handoff alive on the observed-descendant pin;
    // absence must hold over the entire set before anything releases.
    process.kill(worker, 'SIGKILL');
    const allObserved = ledger(w.dir).filter((x) => x.t === 'process').flatMap((x) => (x.observedPids || []).map((y) => y.pid));
    for (const pid of allObserved) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ } }
    await until(() => !alive(worker) && allObserved.every((pid) => !alive(pid)), 3000);
    await w.api.sweep();                 // first observation of absence starts the clock
    w.advance(1500);                     // goneGraceMs is 1000 in this world
    await w.api.sweep();
    assert.ok(ledger(w.dir).some((x) => x.t === 'status' && x.to === 'abandoned' && x.reason === 'process_gone'));
    assert.deepStrictEqual(locksOf(w.dir), {}, 'released only on proven whole-set absence');
  } finally {
    if (plan) killAllByUuid(plan.sessionUuid);
    if (leader) killHard(leader);
    if (worker) killHard(worker);
  }
});

test('descent leg: a uuid-less grandchild is found by the ppid closure while the leader lives, and persists after', async () => {
  const out = tmpdir();
  process.env.OUT_DIR = out;
  const w = world('/bin/sleep 30 &\necho $! > "$OUT_DIR/grandchild.pid"\nwait\n');
  let plan, leader, worker, grandchild;
  try {
    const d = await dispatch(w);
    plan = d.plan;
    leader = ledger(w.dir).find((x) => x.t === 'process').pid;
    assert.ok(await until(() => fs.existsSync(path.join(out, 'grandchild.pid')), 3000));
    grandchild = Number(fs.readFileSync(path.join(out, 'grandchild.pid'), 'utf8').trim());
    worker = rowsFor(plan.sessionUuid).find((r) => r.pid !== leader).pid;

    await w.api.sweep();     // the closure walks leader -> worker -> grandchild and PERSISTS all
    const persisted = ledger(w.dir).filter((x) => x.t === 'process').flatMap((x) => x.observedPids.map((y) => y.pid));
    assert.ok(persisted.includes(grandchild), 'its argv does not repeat the uuid — only the closure finds it, so it must be persisted');

    // Leader and worker die; the grandchild is reparented to pid 1 and the closure would lose it.
    process.kill(leader, 'SIGKILL'); killHard(worker);
    await until(() => !alive(leader) && !alive(worker), 2000);
    w.advance(60 * 60 * 1000);
    await w.api.sweep();
    assert.ok(!ledger(w.dir).some((x) => x.t === 'status' && x.to === 'abandoned'), 'the PERSISTED grandchild pins the set alive');

    killHard(grandchild);
    await until(() => !alive(grandchild), 2000);
    await w.api.sweep();
    w.advance(1500);
    await w.api.sweep();
    assert.ok(ledger(w.dir).some((x) => x.t === 'status' && x.to === 'abandoned'));
  } finally {
    delete process.env.OUT_DIR;
    if (plan) killAllByUuid(plan.sessionUuid);
    for (const p of [leader, worker, grandchild]) if (p) killHard(p);
  }
});

test('logPath is a pty capture: \\r\\n lines, and bridgeSessionId parses after stripping \\r', async () => {
  const w = world([
    'echo "Remote Control active session_01TESTABC"',
    'mkdir -p "$(dirname "$TP")"',
    ': > "$TP"',
    'sleep 5',
  ].join('\n') + '\n', { confirmMs: 5000 });
  let plan;
  try {
    // The stand-in needs the transcript path; TP survives the scrub.
    const pr = await w.api.preview({ selectors: ['epic:PROJ-1'] });
    process.env.TP = pr.body.plan.transcriptPath;
    const r = await w.api.commit({ previewId: pr.body.plan.previewId, hash: pr.body.hash, idempotencyKey: 'k-pty' });
    plan = pr.body.plan;
    assert.strictEqual(r.status, 201, 'the transcript the stand-in wrote confirmed the dispatch');
    const st = ledger(w.dir).find((x) => x.t === 'status' && x.to === 'active');
    assert.strictEqual(st.detail.bridgeSessionId, 'session_01TESTABC', 'the LAST session_ token on the Remote Control line');
    const log = fs.readFileSync(plan.logPath, 'utf8');
    const line = log.split('\n').find((l) => l.includes('Remote Control active'));
    assert.ok(line.endsWith('\r'), 'pty lines end \\r\\n — a whole-line comparison finds nothing');
  } finally {
    delete process.env.TP;
    if (plan) killAllByUuid(plan.sessionUuid);
  }
});
