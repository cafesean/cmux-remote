'use strict';
// p6 S-004 — lifecycle: liveness over the dispatch SET (never the leader pid alone), the seven-row
// precedence, per-fact-key source health, gone/goneGraceMs, quiet-as-display-only, and publish().
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const hk = require('../radar/handoff-keys.js');
const { createHandoff } = require('../radar/handoff.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-handoff-'));
process.env.HOME = tmpdir();

const LSTART = 'Sat Aug  1 07:00:00 2026';
const LSTART2 = 'Sat Aug  1 07:11:11 2026';
const T0 = Date.parse('2026-08-01T07:00:00.000Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function standin(dir) {
  const p = path.join(dir, 'claude-standin.sh');
  fs.writeFileSync(p, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "9.9.9 (stand-in)"; exit 0; fi\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return p;
}

function fixtureState(dir) {
  return {
    v: 1, generatedAt: iso(T0), collectorId: 'mac-test',
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
    },
    epics: [{ key: 'PROJ-1', signals: ['merged-not-deployed'], repos: ['repoA'] }, { key: 'PROJ-2', signals: [], repos: ['repoA'] }],
    attention: [{ type: 'orphan', repo: 'repoA', branch: 'stray' }],
  };
}

function world(o = {}) {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'wt1'), { recursive: true });
  const bin = standin(dir);
  const state = o.state === undefined ? fixtureState(dir) : o.state;
  let t = T0;
  const psBox = { text: `    1     0 ${LSTART} /sbin/launchd`, fail: false, calls: 0 };
  const killBox = { impl: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }, calls: [] };
  const cfg = Object.assign({
    collectorId: 'mac-test',
    repos: [{ id: 'repoA', path: dir }],
    polyrepoRoot: dir, claudeBin: bin,
    confirmMs: 120, goneGraceMs: 10 * MIN, sessionQuietMs: 30 * MIN,
    discardKillMs: 60, previewTtlMs: 120000, seedMaxBytes: 12288,
  }, o.config);
  const stateBox = { state };
  const api = createHandoff({
    dir, config: cfg,
    getState: () => stateBox.state,
    now: () => t,
    spawn: () => ({ pid: 99991, unref() {}, once() {} }),
    ps: async () => { psBox.calls++; if (psBox.fail) throw new Error('ps failed'); return psBox.text; },
    kill: (pid, sig) => { killBox.calls.push([pid, sig]); return killBox.impl(pid, sig); },
    log: () => {},
    buildBrief: (s, sels) => ({ text: `BRIEF ${sels.join(' ')}` }),
  });
  return { dir, cfg, api, psBox, killBox, stateBox, advance: (ms) => { t += ms; }, nowMs: () => t };
}

const ledger = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'handoffs', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; }
};
const statusRecs = (dir) => ledger(dir).filter((x) => x.t === 'status');
const locksFile = (dir) => { try { return fs.readFileSync(path.join(dir, 'handoffs', 'locks.json'), 'utf8'); } catch (_) { return '{}'; } };

function mkPlan(w, over = {}) {
  const previewId = crypto.randomUUID();
  const handoffId = over.handoffId || `h-20260801-0700-${previewId.slice(0, 6)}`;
  const wt = path.join(w.dir, 'wt1');
  return Object.assign({
    previewId, handoffId, sessionUuid: crypto.randomUUID(),
    windowName: `${handoffId}-t`, machine: 'mac-test',
    selectors: ['epic:PROJ-1'],
    factKeys: [
      `branch:repoA:feature/x:unmerged-develop`, `branch:repoA:feature/x:unpushed`,
      `epic:PROJ-1:merged-not-deployed`, `wt:${wt}:dirty`, `wt:${wt}:stale`,
    ],
    workdir: w.dir, claudeBin: w.cfg.claudeBin, claudeVersion: '9.9.9 (stand-in)',
    seedPath: path.join(w.dir, 'handoffs', `${handoffId}.md`),
    logPath: path.join(w.dir, 'handoffs', `${handoffId}.log`),
    transcriptPath: path.join(w.dir, 'transcripts', `${handoffId}.jsonl`),
    argv: ['--remote-control', '-n', `${handoffId}-t`, '--session-id', '<uuid>', 'seed'],
    seedText: 'seed', createdAt: iso(T0), expiresAt: iso(T0 + 120000),
  }, over);
}

const recIntent = (plan, at) => ({ t: 'intent', at: at || iso(T0), id: plan.handoffId, idempotencyKey: `fix-${plan.previewId.slice(0, 8)}`, hash: hk.hashOf(plan), plan });
const recProcess = (plan, pid, psStartedAt, at) => ({ t: 'process', at: at || iso(T0), id: plan.handoffId, pid, psStartedAt: psStartedAt === undefined ? null : psStartedAt, observedPids: [] });
const recStatus = (plan, from, to, reason, at) => ({ t: 'status', at: at || iso(T0), id: plan.handoffId, from, to, reason, detail: {} });
const writeLedger = (w, recs) => {
  fs.mkdirSync(path.join(w.dir, 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'handoffs', 'ledger.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
// Fixture ledgers are committed INPUTS read at startup — the ONE permitted way for a test to reach
// a starting state (specs §11); after this, the module is the only writer.
async function seeded(w, recs) { writeLedger(w, recs); await w.api.recoverAtStartup(); }

const aliveRow = (plan, pid) => `  ${pid}     1 ${LSTART} bash ${plan.claudeBin} --remote-control -n w --session-id ${plan.sessionUuid} seed`;

async function activeHandoff(w, over) {
  const plan = mkPlan(w, over);
  await seeded(w, [recIntent(plan), recProcess(plan, 4242, LSTART), recStatus(plan, 'launching', 'active', 'confirmed')]);
  return plan;
}

// ---- silence vs process fact ---------------------------------------------------------------------

test('THERE IS NO SILENCE-BASED ABANDONMENT: a live pid with zero observations for 24h is quiet and holds every key', async () => {
  // The rule the whole release invariant hangs on: a session waiting for Sean emits NOTHING, and
  // U5 says nothing bounds how long. quiet is a display, not a decision.
  assert.ok(!fs.readFileSync(require.resolve('../radar/handoff.js'), 'utf8').includes('abandonAfterMs'));
  const w = world();
  const plan = await activeHandoff(w);
  w.psBox.text += `\n${aliveRow(plan, 5001)}`;      // the worker is ALIVE (identity leg)
  w.advance(24 * 60 * MIN);
  await w.api.sweep();
  const h = (await w.api.get(plan.handoffId)).body;
  assert.strictEqual(h.status, 'quiet');
  assert.deepStrictEqual([...w.api.suppressedKeys()].sort(), plan.factKeys.slice().sort(), 'still holds every fact key');
  assert.ok(!statusRecs(w.dir).some((x) => x.to === 'abandoned'));

  // quiet -> active the moment an observation arrives (a radar event newer than dispatch).
  const day = iso(w.nowMs()).slice(0, 10);
  fs.mkdirSync(path.join(w.dir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'events', `${day}.ndjson`),
    JSON.stringify({ ts: w.nowMs() - 1000, sessionId: plan.sessionUuid, event: 'Stop' }) + '\n');
  await w.api.sweep();
  const h2 = (await w.api.get(plan.handoffId)).body;
  assert.strictEqual(h2.status, 'active');
  const last = statusRecs(w.dir).pop();
  assert.deepStrictEqual({ from: last.from, to: last.to, reason: last.reason }, { from: 'quiet', to: 'active', reason: 'observed' });
});

// ---- gone (§M3) ----------------------------------------------------------------------------------

test('gone = pidGoneSince + goneGraceMs: 5 min absent is nothing, 11 min is abandoned + release', async () => {
  const w = world();
  const plan = await activeHandoff(w);          // leader 4242: kill throws ESRCH, no uuid row -> absent
  await w.api.sweep();                          // first observation of absence starts the clock
  w.advance(5 * MIN);
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active', 'not abandoned inside the grace');
  w.advance(6 * MIN);
  await w.api.sweep();
  const h = (await w.api.get(plan.handoffId)).body;
  assert.strictEqual(h.status, 'abandoned');
  const last = statusRecs(w.dir).pop();
  assert.deepStrictEqual({ to: last.to, reason: last.reason }, { to: 'abandoned', reason: 'process_gone' });
  assert.deepStrictEqual(JSON.parse(locksFile(w.dir)).locks, {}, 'the release');
  const pub = w.api.publish();
  assert.deepStrictEqual({ live: pub.handoffsLive, listed: pub.handoffs.length }, { live: 0, listed: 0 }, 'terminal handoffs are absent from state entirely');
});

test('pid absent then alive again clears pidGoneSince — no abandonment after a flap', async () => {
  const w = world();
  const plan = await activeHandoff(w);
  await w.api.sweep();                                     // absent -> clock starts
  w.psBox.text += `\n${aliveRow(plan, 5002)}`;             // it reappears (uuid identity)
  await w.api.sweep();                                     // alive -> clock cleared
  w.psBox.text = w.psBox.text.split('\n')[0];              // gone again
  w.advance(9 * MIN);                                      // 9 < 10: the clock RESTARTED
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active');
  assert.ok(!statusRecs(w.dir).some((x) => x.to === 'abandoned'));
});

// ---- the dispatch set (§M2, §9 trap 15) ----------------------------------------------------------

test('a uuid-bearing worker keeps the handoff ALIVE when the leader is ESRCH — and is persisted as a delta', async () => {
  const w = world();
  const plan = await activeHandoff(w);
  w.psBox.text += `\n${aliveRow(plan, 777)}`;    // the worker survived its leader (measured shape)
  w.advance(20 * MIN);                           // well past goneGraceMs
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active', 'leader-only liveness would have released here');
  assert.deepStrictEqual([...w.api.suppressedKeys()].sort(), plan.factKeys.slice().sort());
  // The sweep PERSISTED the observed pid, so the set survives reparenting/renaming.
  const proc = ledger(w.dir).filter((x) => x.t === 'process').pop();
  assert.deepStrictEqual(proc.observedPids, [{ pid: 777, lstart: LSTART }]);
});

test('a persisted observedPid is pinned by lstart: same lstart alive, different lstart is a recycled pid', async () => {
  const w = world();
  const plan = await activeHandoff(w);
  w.psBox.text += `\n${aliveRow(plan, 777)}`;
  await w.api.sweep();                                               // persists {777, LSTART}
  // The worker loses its argv identity (exec'd/renamed) but keeps pid+lstart: STILL ALIVE. The
  // assertion runs only AFTER a full goneGraceMs has elapsed past a sweep that observed the
  // renamed row — an earlier version asserted before the grace could age, which passed even while
  // the pin leg was dead in memory (the S-004 evidence run caught what that mask hid).
  w.psBox.text = `    1     0 ${LSTART} /sbin/launchd\n  777     1 ${LSTART} something-unrecognisable`;
  await w.api.sweep();                                               // pre-fix: absence clock starts HERE
  w.advance(11 * MIN);                                               // a dead pin leg abandons at +10min
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active', 'the persisted pin holds the keys LIVE, not only after a restart refold');
  assert.ok(!statusRecs(w.dir).some((x) => x.to === 'abandoned'), 'no release while the worker is alive');
  assert.deepStrictEqual(Object.keys(JSON.parse(locksFile(w.dir)).locks).sort(), plan.factKeys.slice().sort());
  // Same pid number, DIFFERENT lstart: an unrelated process inherited the number. Absent.
  w.psBox.text = `    1     0 ${LSTART} /sbin/launchd\n  777     1 ${LSTART2} something-unrecognisable`;
  await w.api.sweep();                                               // clock starts
  w.advance(11 * MIN);
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'abandoned', 'a recycled pid must not suppress forever');
});

test('observed-pid deltas fold LIVE: no re-appended deltas, and the index equals a ledger refold', async () => {
  const w = world();
  const plan = await activeHandoff(w);
  w.psBox.text += `\n${aliveRow(plan, 777)}`;
  await w.api.sweep();
  await w.api.sweep();
  await w.api.sweep();
  // §4.1: each process record carries only the pids NEWLY observed by that sweep. A fold that
  // never lands in memory leaves `known` empty, so the identical delta re-appends every sweep and
  // the ledger grows without bound on a long-lived handoff.
  const deltas = ledger(w.dir).filter((x) => x.t === 'process' && (x.observedPids || []).length > 0);
  assert.strictEqual(deltas.length, 1, 'one delta, not one per sweep');

  // THE FOLD INVARIANT — the single check that catches this whole defect class: after a sweep,
  // the in-memory index (as republished) equals a fresh refold of the ledger, modulo the two
  // fields §4.2 declares sweep-local observations (lastObservationAt, pidGoneSince). Any append
  // that skips its applyRecord diverges the two and resurfaces later as a release bug.
  const dirB = tmpdir();
  fs.cpSync(path.join(w.dir, 'handoffs'), path.join(dirB, 'handoffs'), { recursive: true });
  const b = createHandoff({
    dir: dirB, config: w.cfg, getState: () => w.stateBox.state, now: () => w.nowMs(),
    spawn: () => { throw new Error('no spawn'); },
    ps: async () => w.psBox.text,
    kill: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; },
    log: () => {}, buildBrief: (s, sels) => ({ text: `BRIEF ${sels.join(' ')}` }),
  });
  await b.recoverAtStartup();
  const strip = (h) => { const c = Object.assign({}, h); delete c.lastObservationAt; delete c.pidGoneSince; return c; };
  const A = JSON.parse(fs.readFileSync(path.join(w.dir, 'handoffs', 'index.json'), 'utf8')).handoffs.map(strip);
  const B = JSON.parse(fs.readFileSync(path.join(dirB, 'handoffs', 'index.json'), 'utf8')).handoffs.map(strip);
  assert.deepStrictEqual(A, B, 'memory diverged from the ledger — some append skipped its fold');
  assert.deepStrictEqual(A[0].observedPids, [{ pid: 777, lstart: LSTART }], 'and the delta is IN the fold, live');
});

test('leader liveness: EPERM alive; EACCES unhealthy; ps failure unhealthy; kill-0 success with null psStartedAt alive', async () => {
  // EPERM — the pid exists and is not ours.
  const w1 = world();
  const p1 = await activeHandoff(w1);
  w1.killBox.impl = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  w1.advance(31 * MIN);
  await w1.api.sweep();
  assert.strictEqual((await w1.api.get(p1.handoffId)).body.status, 'quiet', 'EPERM is ALIVE (quiet is just the silence display)');
  assert.deepStrictEqual([...w1.api.suppressedKeys()].length, p1.factKeys.length);

  // EACCES — unhealthy: keep the previous status, write NO record, release NOTHING.
  const w2 = world();
  const p2 = await activeHandoff(w2);
  w2.killBox.impl = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  const before = { lines: ledger(w2.dir).length, locks: locksFile(w2.dir) };
  w2.advance(20 * MIN);
  await w2.api.sweep();
  assert.strictEqual((await w2.api.get(p2.handoffId)).body.status, 'active');
  assert.strictEqual(ledger(w2.dir).length, before.lines, 'no record');
  assert.strictEqual(locksFile(w2.dir), before.locks, 'locks byte-unchanged');

  // ps failing — unhealthy, never absent.
  const w3 = world();
  const p3 = await activeHandoff(w3);
  w3.psBox.fail = true;
  w3.advance(20 * MIN);
  await w3.api.sweep();
  assert.strictEqual((await w3.api.get(p3.handoffId)).body.status, 'active');

  // kill(pid,0) succeeds with psStartedAt null — alive on pid alone, the documented accepted risk.
  const w4 = world();
  const p4 = mkPlan(w4);
  await seeded(w4, [recIntent(p4), recProcess(p4, 4242, null), recStatus(p4, 'launching', 'active', 'confirmed')]);
  w4.killBox.impl = () => true;
  w4.advance(20 * MIN);
  await w4.api.sweep();
  assert.notStrictEqual((await w4.api.get(p4.handoffId)).body.status, 'abandoned');
});

test('kill-0 success with a DIFFERENT lstart in the capture means the leader is gone (recycled number)', async () => {
  const w = world();
  const plan = mkPlan(w);
  await seeded(w, [recIntent(plan), recProcess(plan, 4242, LSTART), recStatus(plan, 'launching', 'active', 'confirmed')]);
  w.killBox.impl = () => true;                          // the NUMBER is alive…
  w.psBox.text = `    1     0 ${LSTART} /sbin/launchd\n 4242     1 ${LSTART2} some-other-process`;   // …but it is not our leader
  await w.api.sweep();                                  // absent -> clock
  w.advance(11 * MIN);
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'abandoned');
});

// ---- precedence (§M3) ----------------------------------------------------------------------------

test('precedence row 1: an unhealthy source freezes the handoff even when every fact is absent', async () => {
  const w = world();
  const plan = await activeHandoff(w);
  w.stateBox.state = Object.assign({}, w.stateBox.state, {
    sources: Object.assign({}, w.stateBox.state.sources, { git: { status: 'error' } }),
    repos: {}, epics: [], attention: [],
  });
  const before = { lines: ledger(w.dir).length, locks: locksFile(w.dir) };
  w.advance(20 * MIN);
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active', 'a cold git source must never read as resolved');
  assert.strictEqual(ledger(w.dir).length, before.lines);
  assert.strictEqual(locksFile(w.dir), before.locks);
});

test('precedence row 2 beats row 3: all facts absent AND pid gone is resolved, never abandoned', async () => {
  const w = world();
  const plan = await activeHandoff(w);
  await w.api.sweep();                                   // absence clock starts (facts still true)
  w.advance(11 * MIN);                                   // gone would fire…
  w.stateBox.state = Object.assign({}, w.stateBox.state, { repos: {}, epics: [], attention: [] });   // …but the facts cleared
  await w.api.sweep();
  const last = statusRecs(w.dir).pop();
  assert.deepStrictEqual({ to: last.to, reason: last.reason }, { to: 'resolved', reason: 'facts_cleared' });
  assert.deepStrictEqual(last.detail.clearedFacts.sort(), plan.factKeys.slice().sort());
});

test('health is PER FACT KEY: deploy freezes epic: handoffs but not branch-only ones; orphans ignore jira/specs', async () => {
  // An epic: key requires config+git+deploy — deploy degraded freezes it.
  const w = world();
  const plan = await activeHandoff(w);
  w.stateBox.state = Object.assign({}, w.stateBox.state, {
    sources: Object.assign({}, w.stateBox.state.sources, { deploy: { status: 'stale' } }),
    repos: {}, epics: [], attention: [],
  });
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active', 'epic: key requires deploy ok');

  // A branch-only handoff needs config+git only — same degraded deploy, and it still resolves.
  const w2 = world();
  const p2 = mkPlan(w2, { selectors: ['branch:repoA:feature/y'], factKeys: ['branch:repoA:feature/y:unpushed'] });
  await seeded(w2, [recIntent(p2), recProcess(p2, 4242, LSTART), recStatus(p2, 'launching', 'active', 'confirmed')]);
  w2.stateBox.state = Object.assign({}, w2.stateBox.state, {
    sources: Object.assign({}, w2.stateBox.state.sources, { deploy: { status: 'stale' } }),
    repos: {}, epics: [], attention: [],
  });
  await w2.api.sweep();
  assert.strictEqual((await w2.api.get(p2.handoffId)).body.status, 'resolved');

  // Orphan provenance is config+git ONLY: jira and specs disabled must not freeze it forever.
  const w3 = world();
  const p3 = mkPlan(w3, { selectors: ['orphan:repoA:stray'], factKeys: ['orphan:repoA:stray'] });
  await seeded(w3, [recIntent(p3), recProcess(p3, 4242, LSTART), recStatus(p3, 'launching', 'active', 'confirmed')]);
  w3.stateBox.state = Object.assign({}, w3.stateBox.state, {
    sources: Object.assign({}, w3.stateBox.state.sources, { jira: { status: 'disabled' }, specs: { status: 'disabled' } }),
    attention: [],                                   // the orphan fact is gone
  });
  await w3.api.sweep();
  assert.strictEqual((await w3.api.get(p3.handoffId)).body.status, 'resolved', 'a predicate requiring jira/specs ok would suppress forever');
});

test('SUPPRESSION CANNOT RELEASE AN ORPHAN: key existence reads the fact base, never attention[]', async () => {
  // The circularity the S-008/S-009 evidence runs caught: §6.6 suppression removes the orphan's
  // attention item BECAUSE this handoff holds its key; resolving the key through the published
  // attention[] then reads our own output as "fact gone" and releases the keys of a live worker —
  // the §4.3 direction. Existence must come from state.repos: an untagged non-default branch.
  const w = world();
  // The fact base holds the orphan branch; the PUBLISHED attention[] is already suppressed (empty)
  // exactly as derive() publishes it while this handoff holds the key.
  w.stateBox.state = Object.assign({}, w.stateBox.state, {
    repos: { repoA: { branches: [{ name: 'stray', epic: null, isDefault: false, unpushed: 2, mergedIntoDevelop: null, mergedIntoMain: null }], worktrees: [] } },
    epics: [],
    attention: [],
  });
  const plan = mkPlan(w, { selectors: ['orphan:repoA:stray'], factKeys: ['orphan:repoA:stray'] });
  await seeded(w, [recIntent(plan), recProcess(plan, 4242, LSTART), recStatus(plan, 'launching', 'active', 'confirmed')]);
  w.psBox.text += `\n${aliveRow(plan, 5010)}`;                        // the worker is ALIVE
  await w.api.sweep();
  await w.api.sweep();                                                // one sweep was all it took, pre-fix
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'active', 'a suppressed rendering is not an absent fact');
  assert.deepStrictEqual(Object.keys(JSON.parse(locksFile(w.dir)).locks), plan.factKeys, 'the keys of a live worker stay held');

  // The real resolution path: Sean tags the branch, the orphan FACT leaves the fact base.
  w.stateBox.state = Object.assign({}, w.stateBox.state, {
    repos: { repoA: { branches: [{ name: 'stray', epic: 'PROJ-9', isDefault: false, unpushed: 2, mergedIntoDevelop: null, mergedIntoMain: null }], worktrees: [] } },
  });
  await w.api.sweep();
  const last = statusRecs(w.dir).pop();
  assert.deepStrictEqual({ to: last.to, reason: last.reason }, { to: 'resolved', reason: 'facts_cleared' });
  assert.deepStrictEqual(JSON.parse(locksFile(w.dir)).locks, {}, 'released because the FACT cleared, not the rendering');
});

test('a post-confirmation ENOENT on the transcript is NOT an error; an EACCES is', async () => {
  // ENOENT: contributes no freshness; the handoff quiets on the boundary and never errors.
  const w = world();
  const plan = await activeHandoff(w);
  w.psBox.text += `\n${aliveRow(plan, 5003)}`;
  w.advance(31 * MIN);
  await w.api.sweep();
  assert.strictEqual((await w.api.get(plan.handoffId)).body.status, 'quiet');

  // EACCES: row 1 — status unchanged, nothing written.
  const w2 = world();
  const p2 = mkPlan(w2);
  fs.mkdirSync(path.dirname(p2.transcriptPath), { recursive: true });
  await seeded(w2, [recIntent(p2), recProcess(p2, 4242, LSTART), recStatus(p2, 'launching', 'active', 'confirmed')]);
  fs.chmodSync(path.dirname(p2.transcriptPath), 0o000);
  try {
    w2.stateBox.state = Object.assign({}, w2.stateBox.state, { repos: {}, epics: [], attention: [] });
    await w2.api.sweep();
    assert.strictEqual((await w2.api.get(p2.handoffId)).body.status, 'active', 'an unreadable transcript must not read as resolved');
  } finally { fs.chmodSync(path.dirname(p2.transcriptPath), 0o755); }
});

// ---- publish / counts ----------------------------------------------------------------------------

test('publish(): only the live set, sorted by dispatchedAt desc; terminal handoffs live in the ledger alone', async () => {
  const w = world();
  const mk = (i) => mkPlan(w, { handoffId: `h-20260801-070${i}-aaaaa${i}`, factKeys: [`branch:repoA:b${i}:unpushed`], selectors: [`branch:repoA:b${i}`] });
  const plans = [0, 1, 2, 3, 4, 5].map((i) => mk(i));
  await seeded(w, [
    recIntent(plans[0], iso(T0 + 0)), recProcess(plans[0], 4240, LSTART, iso(T0)), recStatus(plans[0], 'launching', 'active', 'confirmed', iso(T0)),
    recIntent(plans[1], iso(T0 + 1000)), recProcess(plans[1], 4241, LSTART, iso(T0)), recStatus(plans[1], 'launching', 'active', 'confirmed', iso(T0)), recStatus(plans[1], 'active', 'quiet', 'no_observation', iso(T0)),
    recIntent(plans[2], iso(T0 + 2000)), recProcess(plans[2], 4242, LSTART, iso(T0)), recStatus(plans[2], 'launching', 'unconfirmed', 'confirm_timeout', iso(T0)),
    recIntent(plans[3], iso(T0 + 3000)), recProcess(plans[3], 4243, LSTART, iso(T0)), recStatus(plans[3], 'launching', 'active', 'confirmed', iso(T0)), recStatus(plans[3], 'active', 'resolved', 'facts_cleared', iso(T0)),
    recIntent(plans[4], iso(T0 + 4000)), recProcess(plans[4], 4244, LSTART, iso(T0)), recStatus(plans[4], 'launching', 'active', 'confirmed', iso(T0)), recStatus(plans[4], 'active', 'abandoned', 'process_gone', iso(T0)),
    recIntent(plans[5], iso(T0 + 5000)), recProcess(plans[5], 4245, LSTART, iso(T0)), recStatus(plans[5], 'launching', 'unconfirmed', 'confirm_timeout', iso(T0)), recStatus(plans[5], 'unconfirmed', 'discarded', 'discarded_operator', iso(T0)),
  ]);
  const pub = w.api.publish();
  assert.strictEqual(pub.handoffsLive, 3);
  assert.strictEqual(pub.handoffs.length, 3, 'counts.handoffsLive equals handoffs.length');
  assert.deepStrictEqual(pub.handoffs.map((h) => h.id), [plans[2].handoffId, plans[1].handoffId, plans[0].handoffId], 'dispatchedAt desc');
  for (const h of pub.handoffs) {
    assert.deepStrictEqual(Object.keys(h).sort(), ['factKeys', 'id', 'selectors', 'session', 'status']);
    assert.deepStrictEqual(Object.keys(h.session).sort(), ['machine', 'sessionId'], 'the epic/activity join input is {machine, sessionId}, never cwd');
  }
  const terminalIds = [plans[3].handoffId, plans[4].handoffId, plans[5].handoffId];
  for (const id of terminalIds) {
    assert.ok(!pub.handoffs.some((h) => h.id === id), 'terminal handoffs are absent from state.handoffs[] entirely');
    assert.strictEqual((await w.api.get(id)).status, 200, 'but still answer on GET, from the ledger-derived index');
  }
  // The Handoff projection: no plan, no lastObservationAt, no pidGoneSince (§7.1).
  const proj = (await w.api.get(plans[0].handoffId)).body;
  assert.deepStrictEqual(Object.keys(proj).sort(), ['bridgeSessionId', 'confirmedAt', 'dispatchedAt', 'factKeys', 'id',
    'logPath', 'machine', 'pid', 'psStartedAt', 'selectors', 'sessionId', 'status', 'terminalAt', 'transcriptPath', 'unconfirmedAt']);
  assert.strictEqual((await w.api.get('h-nope')).status, 404);
});

test('one shared ps capture per sweep serves every handoff', async () => {
  const w = world();
  await activeHandoff(w, { handoffId: 'h-20260801-0700-aaa001' });
  const p2 = mkPlan(w, { handoffId: 'h-20260801-0700-aaa002', factKeys: ['branch:repoA:feature/y:unpushed'], selectors: ['branch:repoA:feature/y'] });
  writeLedger(w, [...ledger(w.dir), recIntent(p2), recProcess(p2, 4243, LSTART), recStatus(p2, 'launching', 'active', 'confirmed')]);
  // (rebuild on a fresh instance so both are indexed)
  const w2 = world();
  fs.cpSync(path.join(w.dir, 'handoffs'), path.join(w2.dir, 'handoffs'), { recursive: true });
  await w2.api.recoverAtStartup();
  w2.psBox.calls = 0;
  await w2.api.sweep();
  assert.strictEqual(w2.psBox.calls, 1, 'one /bin/ps -axww capture per sweep, shared by M2 and M3');
});

test('handoff source never consults a session cwd for the join', () => {
  const src = fs.readFileSync(require.resolve('../radar/handoff.js'), 'utf8');
  // The ONLY cwd in the module is the spawn adapter's cwd: plan.workdir (§M2). No session cwd is
  // ever read — the polyrepo root maps to no repo, so a cwd join would fail for most handoffs.
  assert.ok(!src.includes('.cwd'), 'no session.cwd / event.cwd is ever consulted');
  for (const line of src.split('\n')) {
    if (!/\bcwd\b/.test(line)) continue;
    assert.ok(line.includes('cwd: plan.workdir') || line.trim().startsWith('//'), `unexpected cwd use: ${line.trim()}`);
  }
});
