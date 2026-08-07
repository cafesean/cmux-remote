'use strict';
// p11 S-006 (spawn arm) — the EXTRACTED launch primitive and the dispatch route that now reaches it.
//
// WHY THIS FILE EXISTS. radar/dispatch.js has always had a `spawn` dep and radar-server.js always
// left it empty, so the spawn arm answered 501 spawn_unavailable. The reason given was a good one:
// p6 owned the only session spawn in the repository, it lived in the middle of commit()'s
// preview->commit sequence, and writing a second one here would have forked the launch whose
// recovery path is the tested one. The fix is not a second spawn — it is ONE primitive, extracted
// out of commit(), that both callers reach.
//
// So the load-bearing assertion in this file is an IDENTITY one: the confirm-gated p6 press and the
// p11 dispatch arm must enter the same function at the same line. Everything else here is the
// contract around it — the seed, the wrapper, the permission mode, the failure mapping — and the
// deliberate gap (no ledger reservation for a work packet that mints no fact keys).
//
// SYNTHETIC EVERYTHING (spec F19): PROJ/ALPHA identifiers, /repo/<name> paths, loopback bridges.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');

const { createHandoff } = require('../radar/handoff.js');
const { createRadar } = require('../radar-server');
const { call } = require('./helpers/server-boot');

// §6.8's appended line, as the LITERAL — radar/handoff.js exports exactly three names and that
// contract is pinned by the p6 suite, so this is compared against the sentence rather than against
// the constant that produces it.
const FIRST_TURN_LINE = 'FIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until the operator replies.';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p11-spawn-'));
process.env.HOME = tmpdir();          // transcript paths resolve ~ against a scratch HOME

const T0 = Date.parse('2026-08-01T07:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const WORK_REF = {
  urn: 'urn:work:jira:PROJ-1', source: 'jira', sourceId: 'PROJ-1', kind: 'epic',
  title: 'a thing', status: { native: 'In Progress', nativeCategory: 'indeterminate', canonical: 'active' },
  cluster: 'PROJ-1', links: ['urn:work:git:example-web/feature/PROJ-1-thing'], selectable: true, route: null,
};

// Answers --version like the real binary and then exits; nothing is left running after a test.
function standin(dir) {
  const p = path.join(dir, 'claude-standin.sh');
  fs.writeFileSync(p, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "9.9.9 (stand-in)"; exit 0; fi\nexit 0\n');
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

// Records what the adapter was CALLED WITH plus the stack it was called FROM — the stack is what
// makes the identity assertion possible without exporting an internal.
function recordingSpawn(o = {}) {
  const fn = (bin, args, opts) => {
    fn.calls.push({ bin, args, opts, stack: new Error().stack });
    if (o.fail) {
      const { EventEmitter } = require('events');
      const c = new EventEmitter();
      c.pid = undefined; c.unref = () => {};
      setImmediate(() => c.emit('error', new Error('spawn ENOENT stand-in')));
      return c;
    }
    return { pid: o.pid || 99991, unref() {}, once() {} };
  };
  fn.calls = [];
  return fn;
}

function world(o = {}) {
  const dir = tmpdir();
  const bin = o.claudeBin === undefined ? standin(dir) : o.claudeBin;
  const poly = path.join(dir, 'poly');
  fs.mkdirSync(poly, { recursive: true });
  const spawn = o.spawn || recordingSpawn();
  const logs = [];
  const api = createHandoff({
    dir,
    config: Object.assign({
      collectorId: 'mac-test', repos: [{ id: 'repoA', path: dir }],
      polyrepoRoot: o.polyrepoRoot === undefined ? poly : o.polyrepoRoot,
      claudeBin: bin,
      confirmMs: 50, goneGraceMs: 600000, sessionQuietMs: 1800000,
      discardKillMs: 60, previewTtlMs: 120000, seedMaxBytes: 12288,
    }, o.config),
    getState: () => fixtureState(),
    now: () => T0,
    spawn,
    ps: async () => `    1     0 Sat Aug  1 07:00:00 2026 /sbin/launchd`,
    kill: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; },
    log: (...a) => logs.push(a.join(' ')),
    buildBrief: (s, sels) => ({ text: `BRIEF ${sels.join(' ')}` }),
  });
  return { dir, poly, bin, api, spawn, logs };
}

const ledgerLines = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'handoffs', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
};
const PACKET = 'You are receiving a scoped work packet from radar (run run-1).';

// The frame the adapter was entered from, normalised to `name (file:line)` so two calls can be
// compared. If the two callers ever stop sharing the recipe, these stop matching.
function launchFrame(stack) {
  const line = String(stack).split('\n').find((l) => l.includes('launchPlan'));
  return line ? line.trim().replace(/^at\s+(async\s+)?/, '') : null;
}

// ---- the primitive ---------------------------------------------------------------------------------

test('spawnSession writes the seed, then launches it through the §M2 wrapper with DEFAULT permissions', async () => {
  const w = world();
  const r = await w.api.spawnSession({ workRef: WORK_REF, seed: PACKET, runId: 'run-1' });

  // The four fields radar/dispatch.js reads, and it reads exactly these.
  assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(r.machine, 'mac-test', 'the collectorId off the live snapshot, never a guess');
  assert.strictEqual(r.seedPath, path.join(w.dir, 'handoffs', `${r.dispatchId}.md`));
  assert.strictEqual(r.permissionMode, 'default');

  // The seed exists BEFORE the process that reads it, byte-exact, with §6.8's first-turn line — an
  // unattended dispatch is exactly the case where "inspect and plan only, then ask" must hold.
  assert.strictEqual(fs.readFileSync(r.seedPath, 'utf8'), `${PACKET}\n${FIRST_TURN_LINE}`);

  assert.strictEqual(w.spawn.calls.length, 1);
  const c = w.spawn.calls[0];
  assert.strictEqual(c.bin, '/bin/bash');
  assert.strictEqual(c.args[0], '-c');
  assert.ok(c.args[1].includes('exec /usr/bin/script -q /dev/null "$1" "${@:2}"'), 'the scrub+script wrapper, not a bare exec');
  assert.strictEqual(c.args[2], 'bash');
  assert.strictEqual(c.args[3], w.bin, 'the binary travels POSITIONALLY — the scrub eats CLAUDE_BIN');
  assert.deepStrictEqual(c.args.slice(4), [
    '--remote-control', '-n', `${r.dispatchId}-urn-work-jira-proj-1`,
    '--session-id', r.sessionId, `${PACKET}\n${FIRST_TURN_LINE}`,
  ], 'the seed is ONE unmodified argument');
  assert.ok(!c.args.includes('--dangerously-skip-permissions'), 'read from what the adapter was CALLED WITH, never source text');
  assert.deepStrictEqual({ cwd: c.opts.cwd, detached: c.opts.detached }, { cwd: w.poly, detached: true });

  // The log file exists because radar opened it; `script` writes the bytes into it.
  assert.ok(fs.existsSync(r.logPath), 'the pty capture file is created by the launch');
  assert.match(r.dispatchId, /^d-\d{8}-\d{4}-[0-9a-f]{6}$/, 'p6 ids start h-, a dispatch starts d- — the directory stays readable');
  assert.ok(w.logs.some((l) => l.includes('p11 dispatch spawn') && l.includes(r.sessionId)),
    'the ledger holds nothing about this session, so the server log is its only trace');
});

test('IDENTITY: the p6 press and the dispatch arm enter the SAME launch function at the SAME line', async () => {
  const w = world();

  // (1) the confirm-gated p6 press, all the way through preview -> commit
  const pv = await w.api.preview({ selectors: ['epic:PROJ-1'] });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.body));
  const cm = await w.api.commit({ previewId: pv.body.plan.previewId, hash: pv.body.hash, idempotencyKey: 'k-identity' });
  assert.strictEqual(cm.status, 202, 'no transcript was written, so the press is unconfirmed — it still launched');

  // (2) the p11 dispatch arm
  await w.api.spawnSession({ workRef: WORK_REF, seed: PACKET, runId: 'run-1' });

  assert.strictEqual(w.spawn.calls.length, 2, 'two launches');
  const [press, dispatched] = w.spawn.calls.map((c) => launchFrame(c.stack));
  assert.ok(press, 'the p6 press goes through launchPlan');
  assert.ok(dispatched, 'so does the dispatch arm');
  assert.strictEqual(press, dispatched,
    'ONE recipe: same function, same call site. A second spawn implementation would show a different frame here.');

  // and the two launches agree on everything the recipe owns
  const a = w.spawn.calls[0];
  const b = w.spawn.calls[1];
  assert.strictEqual(a.bin, b.bin);
  assert.strictEqual(a.args[1], b.args[1], 'the same wrapper body, byte for byte');
  assert.deepStrictEqual(
    { cwd: a.opts.cwd, detached: a.opts.detached, stdio: a.opts.stdio.slice(0, 1) },
    { cwd: b.opts.cwd, detached: b.opts.detached, stdio: b.opts.stdio.slice(0, 1) },
  );
});

test('a dispatch spawn writes NO ledger record and reserves NO fact key — the documented gap, asserted', async () => {
  const w = world();
  await w.api.spawnSession({ workRef: WORK_REF, seed: PACKET, runId: 'run-1' });
  assert.deepStrictEqual(ledgerLines(w.dir), [], 'a work packet mints no fact keys, so there is nothing to reserve');
  assert.deepStrictEqual([...w.api.suppressedKeys()], [], 'and nothing on the board is suppressed by it');
  assert.deepStrictEqual(w.api.publish().handoffs, []);
  // The p6 press that follows is completely unaffected by it.
  const pv = await w.api.preview({ selectors: ['epic:PROJ-1'] });
  assert.strictEqual(pv.status, 200);
});

test('the preflight refuses rather than launching: no seed, no workdir, no usable binary, oversize seed', async () => {
  const empty = world();
  await assert.rejects(() => empty.api.spawnSession({ workRef: WORK_REF, seed: '   ', runId: 'r' }), /no seed text/);
  assert.deepStrictEqual(empty.spawn.calls, [], 'nothing is launched by a refused packet');

  const noWorkdir = world({ polyrepoRoot: null });
  await assert.rejects(() => noWorkdir.api.spawnSession({ workRef: WORK_REF, seed: PACKET }), /polyrepoRoot/);
  assert.deepStrictEqual(noWorkdir.spawn.calls, []);

  const noBin = world({ claudeBin: '/nonexistent/claude-does-not-exist' });
  await assert.rejects(() => noBin.api.spawnSession({ workRef: WORK_REF, seed: PACKET }), /claude binary/);
  assert.deepStrictEqual(noBin.spawn.calls, []);

  const tiny = world({ config: { seedMaxBytes: 64 } });
  await assert.rejects(() => tiny.api.spawnSession({ workRef: WORK_REF, seed: PACKET }), /seed text exceeds/);
  assert.deepStrictEqual(tiny.spawn.calls, [], 'the cap is measured on the bytes that would be DELIVERED');
});

test('a launch that never gets a pid throws — which is the dispatcher\'s documented 502, not a silent success', async () => {
  const w = world({ spawn: recordingSpawn({ fail: true }) });
  await assert.rejects(
    () => w.api.spawnSession({ workRef: WORK_REF, seed: PACKET, runId: 'run-1' }),
    /could not be started/,
  );
});

test('the reported permission mode AGREES with the command line the adapter was called with', () => {
  // §8.1: `default` is a configuration assumption until something observes it, so the primitive
  // derives the mode from the argv it is about to exec. This pins the two together — a launch that
  // grows a permission flag without the derivation following it fails here.
  const w = world();
  return w.api.spawnSession({ workRef: WORK_REF, seed: PACKET, runId: 'run-1' }).then((r) => {
    const args = w.spawn.calls[0].args;
    assert.strictEqual(r.permissionMode, 'default');
    assert.ok(!args.includes('--dangerously-skip-permissions'), 'the mode says default and the argv agrees');
    assert.ok(!args.includes('--permission-mode'));
  });
});

// ---- the route, end to end ---------------------------------------------------------------------------

const BRIDGE_ID = 'leader-1';
const SECRET_REF = 'ALPHA_BRIDGE_SECRET';
const OPERATOR_REF = 'ALPHA_OPERATOR_TOKEN';
const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

const SESSION = (over) => Object.assign({
  key: { machine: BRIDGE_ID, sessionId: 'sess-a' },
  surface: { tabRef: 'surface:2' }, surfaceReason: null,
  repo: 'example-web', worktree: 'feature/PROJ-1-thing', epic: 'PROJ-1',
  status: 'idle', lastEventAt: agoMin(10), lastSubmitAt: agoMin(11),
}, over);

const STATE = (sessions) => ({ collectorId: BRIDGE_ID, sessions: sessions || [], workRefs: [WORK_REF] });

const REQ = (over) => Object.assign(
  { workRefUrns: ['urn:work:jira:PROJ-1'], authority: 'operator', authorityToken: 'operator-secret', runId: 'run-1' },
  over || {},
);

// A radar dir with the switch ON and a real polyrepoRoot + stand-in binary on disk: the spawn arm is
// the one arm that touches the filesystem, so nothing about it can be proved against a config that
// only exists in memory.
async function radarDirWith(over) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p11-spawn-')));
  const poly = path.join(dir, 'poly');
  await fsp.mkdir(poly, { recursive: true });
  const bin = standin(dir);
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify(Object.assign({
    configVersion: 1,
    role: 'leader',
    collectorId: BRIDGE_ID,
    repos: [{ id: 'example-web', path: '/repo/example-web' }],
    resume: { minIdleSec: 90, maxIdleHours: 24, requireSurface: true },
    bridges: [{ id: BRIDGE_ID, baseUrl: 'http://127.0.0.1:9', secretRef: SECRET_REF }],
    polyrepoRoot: poly,
    claudeBin: bin,
    // The §8.1 switch, ON only inside this file's fixtures. The shipped default is false and
    // radar-p11-dispatch-route.test.js is what pins that.
    dispatch: { enabled: true, authorityTokenRef: OPERATOR_REF },
  }, over || {}), null, 2));
  return { dir, poly, bin };
}

async function dispatchWith(opts) {
  const o = opts || {};
  const fx = await radarDirWith(o.config);
  const bridgeCalls = [];
  const state = o.state || STATE([]);
  const radar = createRadar({
    createCollector: () => ({
      paths: { dir: fx.dir, config: path.join(fx.dir, 'config.json') },
      getState: async () => state,
      lastStateSync: () => state,
      scan: async () => ({ ok: true, published: true, warnings: [], error: null, durationMs: 1, state: null }),
      start: () => {}, stop: () => {}, isScanning: () => false,
    }),
    scanOnStart: false,
    log: () => {},
    now: () => NOW,
    env: { [SECRET_REF]: 'bridge-secret', [OPERATOR_REF]: 'operator-secret' },
    bridgeHttp: async (url, o2) => {
      bridgeCalls.push({ url, opts: o2 });
      return o.bridgeAnswer || { ok: true, status: 200, json: { ok: true } };
    },
  });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/radar/')) return radar.handle(req, res, u);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await call(`http://127.0.0.1:${srv.address().port}`, 'POST', '/api/radar/dispatch', { body: o.body === undefined ? REQ() : o.body });
    return { res, fx, bridgeCalls };
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

test('the spawn arm is REACHED through the route: nothing eligible -> a session is started and reported', async () => {
  // This is the assertion the old "honest gap" test made in the negative. The 501 is gone because
  // the primitive exists, not because a second spawn was written here.
  const { res, fx, bridgeCalls } = await dispatchWith({});
  try {
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.route.kind, 'spawn');
    assert.strictEqual(res.json.route.reason, 'no eligible session');
    assert.strictEqual(res.json.route.fellBackFrom, null);
    assert.ok(res.json.route.sessionId, 'the dispatcher reports the session the primitive minted');
    assert.strictEqual(res.json.route.machine, BRIDGE_ID);
    assert.strictEqual(res.json.dispatched, true);
    assert.strictEqual(res.json.permissionMode, 'default', 'observed off the argv, not assumed');

    // The seed the caller is told about is on disk, and it is the packet the dispatcher built.
    assert.ok(res.json.seedPath.startsWith(path.join(fx.dir, 'handoffs')), res.json.seedPath);
    const onDisk = fs.readFileSync(res.json.seedPath, 'utf8');
    assert.ok(onDisk.startsWith(res.json.seed), 'the file begins with the exact packet the response carries');
    assert.ok(onDisk.endsWith(FIRST_TURN_LINE), 'and every radar-launched session keeps the first-turn restriction');
    assert.match(onDisk, /Never delete branches/);

    assert.deepStrictEqual(bridgeCalls, [], 'a spawn injects into nothing');
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true });
  }
});

test('a failed injection FALLS BACK to a real spawn, and the fallback is recorded as such', async () => {
  // The cluster gate already proved nothing live is on this cluster, which is what makes the
  // fallback safe here and only here. Before the dep was wired this path answered 501 — the
  // recorded history said "fell back" and nothing had.
  const { res, fx, bridgeCalls } = await dispatchWith({
    state: STATE([SESSION()]),
    bridgeAnswer: { ok: false, status: 502, json: { error: 'pane is gone' } },
  });
  try {
    assert.strictEqual(bridgeCalls.length, 1, 'the resume was attempted first');
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.route.kind, 'spawn');
    assert.strictEqual(res.json.route.fellBackFrom, 'resume');
    assert.match(res.json.route.reason, /resume failed/);
    assert.ok(res.json.route.sessionId && res.json.seedPath);
    assert.ok(fs.existsSync(res.json.seedPath), 'the fallback actually started something');
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true });
  }
});

test('a spawn that cannot run is 502 spawn_failed — the dispatcher\'s code, not a 500 and not a 501', async () => {
  const { res, fx } = await dispatchWith({ config: { claudeBin: '/nonexistent/claude-does-not-exist' } });
  try {
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.json.error, 'spawn_failed');
    assert.match(res.json.detail, /claude binary/);
    assert.notStrictEqual(res.json.error, 'radar_error', 'a refused launch is an answer, not a fault');
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true });
  }
});

test('WIRING CAPABILITY IS NOT ENABLING AUTONOMY: every gate still stands in front of the spawn arm', async () => {
  // The switch off (the shipped default) — refused before the primitive is consulted at all.
  const off = await dispatchWith({ config: { dispatch: { enabled: false, authorityTokenRef: OPERATOR_REF } } });
  try {
    assert.strictEqual(off.res.status, 503);
    assert.strictEqual(off.res.json.error, 'dispatch_disabled');
    assert.deepStrictEqual(fs.readdirSync(off.fx.dir).filter((n) => n === 'handoffs'), [], 'nothing was written on the way to that refusal');
  } finally { await fsp.rm(off.fx.dir, { recursive: true, force: true }); }

  // The switch on, the token wrong.
  const wrong = await dispatchWith({ body: REQ({ authorityToken: 'nope' }) });
  try {
    assert.strictEqual(wrong.res.status, 403);
    assert.strictEqual(wrong.res.json.error, 'authority_refused');
  } finally { await fsp.rm(wrong.fx.dir, { recursive: true, force: true }); }

  // A viewer, refused before the body is even read.
  const viewer = await dispatchWith({ config: { role: 'viewer', leaderBaseUrl: 'http://leader.invalid:8080' } });
  try {
    assert.strictEqual(viewer.res.status, 409);
    assert.strictEqual(viewer.res.json.error, 'viewer_readonly');
  } finally { await fsp.rm(viewer.fx.dir, { recursive: true, force: true }); }

  // A RUNNING session on the cluster: the eligibility re-check refuses, and there is no spawn
  // fallback from a busy cluster — never two writers.
  const busy = await dispatchWith({ state: STATE([SESSION({ status: 'running' })]) });
  try {
    assert.strictEqual(busy.res.status, 409);
    assert.strictEqual(busy.res.json.error, 'cluster_busy');
    assert.ok(!fs.existsSync(path.join(busy.fx.dir, 'handoffs')), 'a refused dispatch starts nothing');
  } finally { await fsp.rm(busy.fx.dir, { recursive: true, force: true }); }
});
