'use strict';
// p6 S-006 (protocol) — commit: the claim rule, the write order, the reservation precedence, the
// three-slots-two-gaps shape, and the complete §M2 failure table, in process, no restart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const store = require('../radar/store.js');
const hk = require('../radar/handoff-keys.js');
const { createHandoff, ERROR_MESSAGES } = require('../radar/handoff.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-handoff-'));
process.env.HOME = tmpdir();          // plans resolve ~ against a scratch HOME, never the real one

const LSTART = 'Sat Aug  1 07:00:00 2026';
const T0 = Date.parse('2026-08-01T07:00:00.000Z');

function standin(dir) {
  const p = path.join(dir, 'claude-standin.sh');
  fs.writeFileSync(p, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "9.9.9 (stand-in)"; exit 0; fi\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return p;
}

function fixtureState(dir) {
  return {
    v: 1, generatedAt: new Date(T0).toISOString(), collectorId: 'mac-test',
    machines: [], counts: {}, sessions: [],
    sources: { git: { status: 'ok' }, sessions: { status: 'ok' }, deploy: { status: 'ok' }, jira: { status: 'ok' }, specs: { status: 'ok' }, config: { status: 'ok' } },
    repos: {
      repoA: {
        branches: [
          { name: 'feature/x', epic: 'PROJ-1', unpushed: 3, mergedIntoDevelop: false, mergedIntoMain: null },
          { name: 'feature/y', epic: 'PROJ-2', unpushed: 2, mergedIntoDevelop: null, mergedIntoMain: null },
        ],
        worktrees: [{ path: path.join(dir, 'wt1'), branch: 'feature/x', stale: true, dirty: { staged: 1, unstaged: 2, untracked: 3 }, head: 'abc123' }],
      },
      repoB: { branches: [{ name: 'feature/z', epic: 'PROJ-2', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null }], worktrees: [] },
    },
    epics: [{ key: 'PROJ-1', signals: ['merged-not-deployed'], repos: ['repoA'] }, { key: 'PROJ-2', signals: [], repos: ['repoA', 'repoB'] }],
    attention: [{ type: 'orphan', repo: 'repoA', branch: 'stray' }],
  };
}

function fakeSpawn(o = {}) {
  const fn = (bin, args, opts) => {
    fn.calls.push({ bin, args, opts });
    if (o.fail) {
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
  fs.mkdirSync(path.join(dir, 'wt1'), { recursive: true });
  const bin = standin(dir);
  const state = o.state === undefined ? fixtureState(dir) : o.state;
  let t = T0;
  const logs = [];
  const kills = [];
  const psBox = { text: `    1     0 ${LSTART} /sbin/launchd` };
  const cfg = Object.assign({
    collectorId: 'mac-test',
    repos: [{ id: 'repoA', path: dir }, { id: 'repoB', path: dir }],
    polyrepoRoot: path.join(dir, 'poly'),
    claudeBin: bin,
    confirmMs: 200, goneGraceMs: 600000, sessionQuietMs: 1800000,
    discardKillMs: 60, previewTtlMs: 120000, seedMaxBytes: 12288,
  }, o.config);
  fs.mkdirSync(cfg.polyrepoRoot, { recursive: true });
  const spawn = o.spawn || fakeSpawn();
  const api = createHandoff({
    dir, config: cfg,
    getState: o.getState || (() => state),
    now: () => t,
    spawn,
    ps: o.ps || (async () => psBox.text),
    kill: o.kill || ((pid, sig) => { kills.push([pid, sig]); const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }),
    log: (...a) => logs.push(a.join(' ')),
    buildBrief: (s, sels) => ({ text: `BRIEF ${sels.join(' ')}` }),
  });
  return { dir, state, cfg, api, spawn, psBox, kills, logs, advance: (ms) => { t += ms; } };
}

const ledgerPath = (dir) => path.join(dir, 'handoffs', 'ledger.jsonl');
const ledger = (dir) => {
  try { return fs.readFileSync(ledgerPath(dir), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; }
};
const locksOf = (dir) => {
  // Before the first post-intent republication no locks.json exists — nothing was ever reserved
  // durably, which reads as an empty lock table.
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'handoffs', 'locks.json'), 'utf8')).locks; } catch (_) { return {}; }
};
const previewFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'handoffs', 'previews')).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
};

async function mkPreview(w, selectors, seedOverride) {
  const r = await w.api.preview(seedOverride === undefined ? { selectors } : { selectors, seedOverride });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const confirmTranscript = (plan) => {
  fs.mkdirSync(path.dirname(plan.transcriptPath), { recursive: true });
  fs.writeFileSync(plan.transcriptPath, '{"type":"probe"}\n');
};
let seq = 0;
const key = () => `k-${process.pid}-${seq++}`;

// ---- the happy path and the write order ----------------------------------------------------------

test('commit: full 201 — write order claim,intent,process,status,result; adapter args; seed on disk', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  confirmTranscript(env.plan);
  const k = key();
  const r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body, {
    handoffId: env.plan.handoffId, status: 'active', sessionId: env.plan.sessionUuid,
    transcriptPath: env.plan.transcriptPath, logPath: env.plan.logPath, factKeys: env.plan.factKeys,
  });

  const recs = ledger(w.dir);
  assert.deepStrictEqual(recs.map((x) => x.t), ['claim', 'intent', 'process', 'status', 'result']);
  assert.deepStrictEqual({ p: recs[0].previewId, h: recs[0].hash, s: recs[0].state }, { p: env.plan.previewId, h: env.hash, s: 'in_progress' });
  assert.deepStrictEqual(recs[1].plan, env.plan, 'the intent carries the stored plan verbatim');
  assert.deepStrictEqual({ from: recs[3].from, to: recs[3].to, reason: recs[3].reason }, { from: 'launching', to: 'active', reason: 'confirmed' });
  assert.deepStrictEqual({ st: recs[4].status, cs: recs[4].claimState }, { st: 201, cs: 'complete' });
  assert.deepStrictEqual(recs[4].body, r.body);

  // The adapter call (asserted from what spawn RECEIVED, never from source text — §9 trap 10):
  // bash -c WRAPPER, $0='bash', $1=claudeBin, then plan.argv element-for-element, and never
  // --dangerously-skip-permissions.
  assert.strictEqual(w.spawn.calls.length, 1);
  const call = w.spawn.calls[0];
  assert.strictEqual(call.bin, '/bin/bash');
  assert.strictEqual(call.args[0], '-c');
  assert.strictEqual(call.args[2], 'bash');
  assert.strictEqual(call.args[3], env.plan.claudeBin);
  assert.deepStrictEqual(call.args.slice(4), env.plan.argv);
  assert.ok(!call.args.includes('--dangerously-skip-permissions'));
  assert.deepStrictEqual({ cwd: call.opts.cwd, detached: call.opts.detached }, { cwd: env.plan.workdir, detached: true });

  // The seed file is the byte-exact Markdown (the TEXT primitive, not writeJsonAtomic).
  assert.strictEqual(fs.readFileSync(env.plan.seedPath, 'utf8'), env.plan.seedText);
  // Locks published; preview deleted on the outcome.
  assert.deepStrictEqual(Object.values(locksOf(w.dir)), env.plan.factKeys.map(() => env.plan.handoffId));
  assert.strictEqual(previewFiles(w.dir).length, 0);
  // publish(): live, suppressing.
  const pub = w.api.publish();
  assert.strictEqual(pub.handoffsLive, 1);
  assert.deepStrictEqual(pub.handoffs[0].session, { machine: 'mac-test', sessionId: env.plan.sessionUuid });
  assert.deepStrictEqual([...w.api.suppressedKeys()].sort(), env.plan.factKeys.slice().sort());
});

test('commit invents nothing: no uuid minted on the clean path; every value comes from the stored plan', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-2']);
  confirmTranscript(env.plan);
  const orig = crypto.randomUUID.bind(crypto);
  let minted = 0;
  crypto.randomUUID = () => { minted++; return orig(); };
  try {
    const r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: key() });
    assert.strictEqual(r.status, 201);
  } finally { crypto.randomUUID = orig; }
  assert.strictEqual(minted, 0, 'no id, path or timestamp is minted inside a successful commit');
});

test('commit: a replay returns the stored envelope verbatim and appends nothing, spawns nothing', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  confirmTranscript(env.plan);
  const k = key();
  const first = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  const lines = ledger(w.dir).length;
  const again = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.strictEqual(again.status, first.status);
  assert.deepStrictEqual(again.body, first.body);
  assert.strictEqual(ledger(w.dir).length, lines, 'a completed replay appends nothing');
  assert.strictEqual(w.spawn.calls.length, 1, 'and spawns nothing');
});

test('commit: 409 in_flight from the IN-MEMORY executing set; the first request settles its own claim', async () => {
  const w = world({ config: { confirmMs: 1500 } });
  const env = await mkPreview(w, ['epic:PROJ-1']);   // no transcript -> the poll keeps p1 in flight
  const k = key();
  const p1 = w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  // Anchor on the intent record (end of slot A): p1 owns the claim and is still executing — a
  // fixed sleep here would race slot A under load and let p2 take the claim instead.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !ledger(w.dir).some((x) => x.t === 'intent')) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(ledger(w.dir).some((x) => x.t === 'intent'), 'p1 committed its claim');
  const p2 = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.strictEqual(p2.status, 409);
  assert.strictEqual(p2.body.error, 'in_flight');
  assert.strictEqual(p2.body.incidentId, undefined, 'in_flight mints no incidentId');
  const r1 = await p1;
  assert.strictEqual(r1.status, 202);
  assert.strictEqual(ledger(w.dir).filter((x) => x.t === 'result').length, 1, 'only the owner wrote a result');
  assert.strictEqual(w.spawn.calls.length, 1, 'exactly one child was created');
});

test('commit: 202 keeps every lock (the dispatch is alive); 502 spawn_failed releases them', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: key() });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.status, 'unconfirmed');
  assert.strictEqual(Object.keys(locksOf(w.dir)).length, env.plan.factKeys.length, 'unconfirmed KEEPS the keys');
  assert.strictEqual(w.api.publish().handoffsLive, 1);

  const w2 = world({ spawn: fakeSpawn({ fail: true }) });
  const env2 = await mkPreview(w2, ['epic:PROJ-1']);
  const r2 = await w2.api.commit({ previewId: env2.plan.previewId, hash: env2.hash, idempotencyKey: key() });
  assert.strictEqual(r2.status, 502);
  assert.strictEqual(r2.body.error, 'spawn_failed');
  assert.ok(r2.body.incidentId && r2.body.logPath);
  const recs = ledger(w2.dir);
  const st = recs.find((x) => x.t === 'status');
  assert.deepStrictEqual({ from: st.from, to: st.to, reason: st.reason }, { from: 'pending', to: 'abandoned', reason: 'spawn_failed' });
  assert.deepStrictEqual(locksOf(w2.dir), {}, 'no process was ever created, so the keys are RELEASED');
  // The stored 502 replays.
  const recs2 = recs.filter((x) => x.t === 'result');
  assert.strictEqual(recs2.length, 1);
  assert.strictEqual(recs2[0].status, 502);
});

// ---- claim rules ---------------------------------------------------------------------------------

test('commit: field validation fails before a key is parsed — no ledger line, ever', async () => {
  const w = world();
  const cases = [
    [{}, 'previewId', 'required'],
    [{ previewId: 'not-a-uuid', hash: '0'.repeat(64), idempotencyKey: 'k' }, 'previewId', 'malformed'],
    [{ previewId: crypto.randomUUID(), hash: 'XYZ', idempotencyKey: 'k' }, 'hash', 'malformed'],
    [{ previewId: crypto.randomUUID(), hash: '0'.repeat(64) }, 'idempotencyKey', 'required'],
    [{ previewId: crypto.randomUUID(), hash: '0'.repeat(64), idempotencyKey: 'bad key!' }, 'idempotencyKey', 'malformed'],
  ];
  for (const [args, field, reason] of cases) {
    const r = await w.api.commit(args);
    assert.deepStrictEqual({ s: r.status, f: r.body.field, re: r.body.reason }, { s: 400, f: field, re: reason });
  }
  // Commit never carries seed bytes — there is exactly one route by which a seed enters.
  const r2 = await w.api.commit({ previewId: crypto.randomUUID(), hash: '0'.repeat(64), idempotencyKey: 'k', seedText: 'sneak' });
  assert.deepStrictEqual({ f: r2.body.field, re: r2.body.reason }, { f: 'seedText', re: 'unknown_field' });
  assert.strictEqual(ledger(w.dir).length, 0, 'no request without a validated key writes anything');
});

test('commit: preview_not_found / preview_expired / hash_mismatch own the claim and settle it', async () => {
  const w = world();
  // not_found
  const r1 = await w.api.commit({ previewId: crypto.randomUUID(), hash: '0'.repeat(64), idempotencyKey: key() });
  assert.deepStrictEqual({ s: r1.status, e: r1.body.error }, { s: 409, e: 'preview_not_found' });
  // expired — the file is still on disk, expiry is the leader's clock
  const env = await mkPreview(w, ['epic:PROJ-1']);
  w.advance(w.cfg.previewTtlMs + 1);
  const k2 = key();
  const r2 = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k2 });
  assert.deepStrictEqual({ s: r2.status, e: r2.body.error }, { s: 409, e: 'preview_expired' });
  assert.strictEqual(previewFiles(w.dir).length, 0, 'the plan is deleted on every outcome');
  // hash_mismatch
  const env3 = await mkPreview(w, ['epic:PROJ-1']);
  const r3 = await w.api.commit({ previewId: env3.plan.previewId, hash: '0'.repeat(64), idempotencyKey: key() });
  assert.deepStrictEqual({ s: r3.status, e: r3.body.error }, { s: 409, e: 'hash_mismatch' });
  // Each wrote claim + result and nothing else; each replays verbatim.
  const results = ledger(w.dir).filter((x) => x.t === 'result');
  assert.strictEqual(results.length, 3);
  assert.strictEqual(ledger(w.dir).filter((x) => x.t === 'intent').length, 0);
  const replay = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k2 });
  assert.deepStrictEqual({ s: replay.status, e: replay.body.error }, { s: 409, e: 'preview_expired' });
});

test('commit: 409 idempotency_key_reused for a different fingerprint; the stored result is untouched', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  confirmTranscript(env.plan);
  const k = key();
  const first = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.strictEqual(first.status, 201);
  const lines = ledger(w.dir).length;
  const env2 = await mkPreview(w, ['epic:PROJ-2']);
  const r = await w.api.commit({ previewId: env2.plan.previewId, hash: env2.hash, idempotencyKey: k });
  assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 409, e: 'idempotency_key_reused' });
  assert.strictEqual(ledger(w.dir).length, lines, 'writes nothing and does not overwrite the stored result');
  const replay = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.deepStrictEqual(replay.body, first.body);
});

// ---- reservation precedence (§M2) ----------------------------------------------------------------

test('reservation: equal set resumes, intersecting-but-unequal is a non-enumerating 423, disjoint acquires', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const r1 = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: key() });
  assert.strictEqual(r1.status, 202);
  const locksBefore = fs.readFileSync(path.join(w.dir, 'handoffs', 'locks.json'), 'utf8');

  // Row 2 — equal fact set: 200 {resumed:true}, no second spawn.
  const envEq = await mkPreview(w, ['epic:PROJ-1']);
  const req = await w.api.commit({ previewId: envEq.plan.previewId, hash: envEq.hash, idempotencyKey: key() });
  assert.strictEqual(req.status, 200);
  assert.strictEqual(req.body.resumed, true);
  assert.strictEqual(req.body.handoff.id, env.plan.handoffId);
  assert.strictEqual(w.spawn.calls.length, 1, 'no second spawn, no second writer');

  // Row 3 — intersecting but unequal: 423, NO holder and NO sharedKeys in the body, locks unchanged.
  const envSub = await mkPreview(w, ['branch:repoA:feature/x']);
  const r423 = await w.api.commit({ previewId: envSub.plan.previewId, hash: envSub.hash, idempotencyKey: key() });
  assert.strictEqual(r423.status, 423);
  assert.deepStrictEqual(Object.keys(r423.body).sort(), ['error', 'incidentId', 'message']);
  assert.strictEqual(fs.readFileSync(path.join(w.dir, 'handoffs', 'locks.json'), 'utf8'), locksBefore, 'locks.json byte-unchanged');
  const line = w.logs.find((l) => l.includes(r423.body.incidentId));
  assert.ok(line && line.includes('unpushed'), 'the overlap appears only in the server log');

  // Row 4 — disjoint: both acquire.
  const env2 = await mkPreview(w, ['epic:PROJ-2']);
  const r2 = await w.api.commit({ previewId: env2.plan.previewId, hash: env2.hash, idempotencyKey: key() });
  assert.strictEqual(r2.status, 202);
  const locks = locksOf(w.dir);
  for (const k2 of env.plan.factKeys) assert.strictEqual(locks[k2], env.plan.handoffId);
  for (const k2 of env2.plan.factKeys) assert.strictEqual(locks[k2], env2.plan.handoffId);
});

// ---- three slots, two gaps (§9 trap 14) ----------------------------------------------------------

test('commit holds no queue slot during the confirm poll, and never calls the QUEUED append', async () => {
  const w = world({ config: { confirmMs: 5000 } });
  const env = await mkPreview(w, ['epic:PROJ-1']);   // no transcript yet -> commit sits in the 6b poll
  const origAppendLine = store.appendLine;
  let queuedCalls = 0;
  store.appendLine = (...a) => { queuedCalls++; return origAppendLine(...a); };
  try {
    const p = w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: key() });
    // Anchor: the process record on disk = slot B was taken, so commit is at or past the 6b gap.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !ledger(w.dir).some((x) => x.t === 'process')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(ledger(w.dir).some((x) => x.t === 'process'), 'commit reached slot B');
    // The SLOT-BOUNDARY oracle — no wall-clock sampling, immune to load: while the poll runs, an
    // independent queue slot must be able to COMPLETE. A commit that held (or nested) a slot
    // through the poll starves this probe until commit itself settles, so 'commit' wins the race;
    // a trap-14 deadlock starves it forever and the test times out. Either way it fails.
    const winner = await Promise.race([
      store.enqueue(async () => 'probe'),
      p.then(() => 'commit'),
    ]);
    assert.strictEqual(winner, 'probe', 'the queue makes progress while the confirm poll runs');
    // End the poll early instead of waiting out confirmMs: the transcript appears, the next stat
    // confirms, and the commit settles 201.
    confirmTranscript(env.plan);
    const r = await p;
    assert.strictEqual(r.status, 201);
  } finally { store.appendLine = origAppendLine; }
  assert.strictEqual(queuedCalls, 0, 'every append inside commit is appendLineUnqueued — a nested enqueue deadlocks forever');
});

// ---- the failure table (§M2), in process, no restart --------------------------------------------

function armAppendFailure(t, err) {
  const orig = store.appendLineUnqueued;
  let armed = true;
  store.appendLineUnqueued = (file, obj) => {
    if (armed && obj && obj.t === t) { armed = false; throw (err || Object.assign(new Error(`injected ${t} failure`), { code: 'EIO' })); }
    return orig(file, obj);
  };
  return () => { store.appendLineUnqueued = orig; };
}

test('failure: claim append -> 500, nothing on disk, a same-key retry is a first attempt', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const k = key();
  const undo = armAppendFailure('claim');
  try {
    const r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
    assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 500, e: 'ledger_write_failed' });
    assert.ok(r.body.incidentId);
  } finally { undo(); }
  assert.strictEqual(ledger(w.dir).length, 0, 'nothing on disk — the request never happened');
  const retry = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.strictEqual(retry.status, 202, 'treated as a first attempt');
});

test('failure: seed write -> stored 500 seed_write_failed, reservation dropped, retry REPLAYS it', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const k = key();
  const orig = store.writeTextAtomicUnqueued;
  store.writeTextAtomicUnqueued = () => { throw new Error('injected seed failure'); };
  let r;
  try { r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k }); }
  finally { store.writeTextAtomicUnqueued = orig; }
  assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 500, e: 'seed_write_failed' });
  assert.deepStrictEqual(locksOf(w.dir), {}, 'reservation dropped — nothing was reserved durably');
  assert.strictEqual(ledger(w.dir).filter((x) => x.t === 'intent').length, 0);
  const retry = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.deepStrictEqual(retry, { status: r.status, body: r.body }, 'the remedy is to re-preview, never to re-run this key');
});

test('failure: intent append -> stored 500, reservation dropped (intent IS the commit point)', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const k = key();
  const undo = armAppendFailure('intent');
  let r;
  try { r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k }); }
  finally { undo(); }
  assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 500, e: 'ledger_write_failed' });
  assert.deepStrictEqual(locksOf(w.dir), {}, 'a crash before intent leaves nothing to release');
  const env2 = await mkPreview(w, ['epic:PROJ-1']);
  const fresh = await w.api.commit({ previewId: env2.plan.previewId, hash: env2.hash, idempotencyKey: key() });
  assert.strictEqual(fresh.status, 202, 'the keys are free afterwards');
});

test('failure: process append -> the dispatch set is KILLED FIRST, then 502 spawn_unrecorded, keys released', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const undo = armAppendFailure('process');
  let r;
  try { r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: key() }); }
  finally { undo(); }
  assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 502, e: 'spawn_unrecorded' });
  assert.ok(r.body.incidentId && r.body.logPath);
  assert.deepStrictEqual(locksOf(w.dir), {}, 'released only after the kill proved absence');
  const st = ledger(w.dir).find((x) => x.t === 'status');
  assert.deepStrictEqual({ to: st.to, reason: st.reason }, { to: 'abandoned', reason: 'spawn_failed' });
});

test('failure: status append -> 500 with keys KEPT; the next sweep writes the status exactly as startup would', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  const k = key();
  const undo = armAppendFailure('status');
  let r;
  try { r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k }); }
  finally { undo(); }
  assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 500, e: 'ledger_write_failed' });
  assert.strictEqual(Object.keys(locksOf(w.dir)).length, env.plan.factKeys.length, 'the dispatch is alive — keys KEPT');
  // The handoff is `launching` (process, no status); the sweep resolves it and settles the claim.
  await w.api.sweep();
  const recs = ledger(w.dir);
  const st = recs.filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ from: st.from, to: st.to }, { from: 'launching', to: 'unconfirmed' });
  const res = recs.filter((x) => x.t === 'result').pop();
  assert.strictEqual(res.status, 202);
  const replay = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.strictEqual(replay.status, 202, 'the sweep-settled claim replays');
});

test('failure: result append -> the computed status is returned; a same-key retry settles 409 request_incomplete', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  confirmTranscript(env.plan);
  const k = key();
  const undo = armAppendFailure('result');
  let r;
  try { r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k }); }
  finally { undo(); }
  assert.strictEqual(r.status, 201, 'the step\'s own status, sent as computed');
  // The claim is durable-but-not-executing now: §M2 rule 1 settles it ON SIGHT, terminally.
  const retry = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.deepStrictEqual({ s: retry.status, e: retry.body.error }, { s: 409, e: 'request_incomplete' });
  const third = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: k });
  assert.deepStrictEqual({ s: third.status, e: third.body.error }, { s: 409, e: 'request_incomplete' }, 'terminal — no retry loop is possible');
});

test('cache republication failure is NOT an error: the request keeps its own status', async () => {
  const w = world();
  const env = await mkPreview(w, ['epic:PROJ-1']);
  confirmTranscript(env.plan);
  const orig = store.writeJsonAtomicUnqueued;
  store.writeJsonAtomicUnqueued = () => { throw new Error('injected republication failure'); };
  let r;
  try { r = await w.api.commit({ previewId: env.plan.previewId, hash: env.hash, idempotencyKey: key() }); }
  finally { store.writeJsonAtomicUnqueued = orig; }
  assert.strictEqual(r.status, 201, 'the caches are output only — a failed publication changes no decision');
  assert.ok(w.logs.some((l) => l.includes('republication failed')));
});
