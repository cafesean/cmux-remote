'use strict';
// p6 S-011 — recovery: the five-conjunct undecidable condition, ONE element for the whole set, the
// durable recovery-op press (record before signal, 200 at the record), set-at-once adopt/discard,
// partial-kill behaviour, crash replay — plus S-006's startup recovery table and the §4.8 tail
// repair, which startup performs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../radar/store.js');
const hk = require('../radar/handoff-keys.js');
const { createHandoff, ERROR_MESSAGES } = require('../radar/handoff.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-handoff-'));
process.env.HOME = tmpdir();

const LSTART = 'Sat Aug  1 07:00:00 2026';
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
          { name: 'b0', epic: 'PROJ-1', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null },
          { name: 'b1', epic: 'PROJ-1', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null },
          { name: 'b2', epic: 'PROJ-1', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null },
        ],
        worktrees: [],
      },
    },
    epics: [{ key: 'PROJ-1', signals: [], repos: ['repoA'] }],
    attention: [],
  };
}

function world(o = {}) {
  const dir = tmpdir();
  const bin = standin(dir);
  const state = o.state === undefined ? fixtureState(dir) : o.state;
  let t = T0;
  const psBox = { rows: [`    1     0 ${LSTART} /sbin/launchd`], fail: false };
  const killBox = { impl: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }, calls: [] };
  const stateBox = { state };
  const cfg = Object.assign({
    collectorId: 'mac-test',
    repos: [{ id: 'repoA', path: dir }],
    polyrepoRoot: dir, claudeBin: bin,
    confirmMs: 120, goneGraceMs: 10 * MIN, sessionQuietMs: 30 * MIN,
    discardKillMs: 60, previewTtlMs: 120000, seedMaxBytes: 12288,
  }, o.config);
  const api = createHandoff({
    dir, config: cfg,
    getState: () => stateBox.state,
    now: () => t,
    spawn: () => ({ pid: 99991, unref() {}, once() {} }),
    ps: async () => { if (psBox.fail) throw new Error('ps failed'); return psBox.rows.join('\n'); },
    kill: (pid, sig) => { killBox.calls.push([pid, sig]); return killBox.impl(pid, sig); },
    log: () => {},
    buildBrief: (s, sels) => ({ text: `BRIEF ${sels.join(' ')}` }),
  });
  return { dir, cfg, api, psBox, killBox, stateBox, advance: (ms) => { t += ms; }, nowMs: () => t };
}

const ledgerPath = (dir) => path.join(dir, 'handoffs', 'ledger.jsonl');
const ledger = (dir) => {
  try { return fs.readFileSync(ledgerPath(dir), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; }
};
const locksOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'handoffs', 'locks.json'), 'utf8')).locks; } catch (_) { return {}; } };

function mkPlan(w, i, over = {}) {
  const previewId = crypto.randomUUID();
  const handoffId = `h-20260801-070${i}-aaaaa${i}`;
  return Object.assign({
    previewId, handoffId, sessionUuid: crypto.randomUUID(),
    windowName: `${handoffId}-t`, machine: 'mac-test',
    selectors: [`branch:repoA:b${i}`], factKeys: [`branch:repoA:b${i}:unpushed`],
    workdir: w.dir, claudeBin: w.cfg.claudeBin, claudeVersion: '9.9.9 (stand-in)',
    seedPath: path.join(w.dir, 'handoffs', `${handoffId}.md`),
    logPath: path.join(w.dir, 'handoffs', `${handoffId}.log`),
    transcriptPath: path.join(w.dir, 'transcripts', `${handoffId}.jsonl`),
    argv: ['--remote-control', '-n', `${handoffId}-t`, '--session-id', '<uuid>', 'seed'],
    seedText: 'seed', createdAt: iso(T0), expiresAt: iso(T0 + 120000),
  }, over);
}
const recClaim = (plan, idem) => ({ t: 'claim', at: iso(T0), machine: 'mac-test', idempotencyKey: idem, requestFingerprint: hk.sha256(hk.canon({ previewId: plan.previewId, hash: hk.hashOf(plan) })), previewId: plan.previewId, hash: hk.hashOf(plan), state: 'in_progress' });
const recIntent = (plan, idem, at) => ({ t: 'intent', at: at || iso(T0), id: plan.handoffId, idempotencyKey: idem || `fix-${plan.handoffId}`, hash: hk.hashOf(plan), plan });
const recProcess = (plan, pid, at) => ({ t: 'process', at: at || iso(T0), id: plan.handoffId, pid, psStartedAt: LSTART, observedPids: [] });
const recStatus = (plan, from, to, reason, at) => ({ t: 'status', at: at || iso(T0), id: plan.handoffId, from, to, reason, detail: {} });
const writeLedger = (w, recs) => {
  fs.mkdirSync(path.join(w.dir, 'handoffs'), { recursive: true });
  fs.writeFileSync(ledgerPath(w.dir), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

const workerPid = (i) => 7000 + i;
const aliveRow = (plan, pid) => `  ${pid}     1 ${LSTART} bash ${plan.claudeBin} --remote-control --session-id ${plan.sessionUuid} seed`;

// N unconfirmed handoffs whose dispatch is alive and whose age >= goneGraceMs: the undecidable set.
async function undecidableWorld(n, o = {}) {
  const w = world(o);
  const plans = [];
  const recs = [];
  for (let i = 0; i < n; i++) {
    const plan = mkPlan(w, i);
    plans.push(plan);
    recs.push(recIntent(plan, undefined, iso(T0 + i * 1000)), recProcess(plan, 4240 + i), recStatus(plan, 'launching', 'unconfirmed', 'confirm_timeout', iso(T0 + i * 1000)));
    w.psBox.rows.push(aliveRow(plan, workerPid(i)));
  }
  writeLedger(w, recs);
  await w.api.recoverAtStartup();
  w.advance(11 * MIN);
  await w.api.sweep();
  return { w, plans };
}
const tokenOf = (plans) => hk.sha256(hk.canon(plans.map((p) => p.handoffId).sort()));
// The kill stub that actually removes the target from the process table.
const lethalKill = (w) => (pid, sig) => {
  w.killBox.calls.push([pid, sig]);
  if (sig === 0) { if (w.psBox.rows.some((r) => r.trimStart().startsWith(`${pid} `))) return true; const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
  w.psBox.rows = w.psBox.rows.filter((r) => !r.trimStart().startsWith(`${pid} `));
  return true;
};

// ---- automatic resolution: the two decidable rows surface NOTHING --------------------------------

test('an unconfirmed handoff whose transcript appears later is adopted silently (adopted_auto)', async () => {
  const w = world();
  const plan = mkPlan(w, 0);
  writeLedger(w, [recIntent(plan), recProcess(plan, 4240), recStatus(plan, 'launching', 'unconfirmed', 'confirm_timeout')]);
  w.psBox.rows.push(aliveRow(plan, workerPid(0)));
  await w.api.recoverAtStartup();
  assert.strictEqual(w.api.publish().handoffRecovery, null);
  fs.mkdirSync(path.dirname(plan.transcriptPath), { recursive: true });
  fs.writeFileSync(plan.transcriptPath, '{}\n');
  await w.api.sweep();
  const last = ledger(w.dir).filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ from: last.from, to: last.to, reason: last.reason }, { from: 'unconfirmed', to: 'active', reason: 'adopted_auto' });
  assert.deepStrictEqual(Object.keys(locksOf(w.dir)), plan.factKeys, 'adoption keeps every key');
  assert.strictEqual(w.api.publish().handoffRecovery, null, 'nothing, at any point');
});

test('an unconfirmed handoff whose DISPATCH is proven gone terminates silently, no element ever', async () => {
  const w = world();     // no uuid row, kill ESRCH -> absent
  const plan = mkPlan(w, 0);
  writeLedger(w, [recIntent(plan), recProcess(plan, 4240), recStatus(plan, 'launching', 'unconfirmed', 'confirm_timeout')]);
  await w.api.recoverAtStartup();
  await w.api.sweep();                     // absence clock starts
  assert.strictEqual(w.api.publish().handoffRecovery, null, 'absent is DECIDABLE — never the element');
  w.advance(11 * MIN);
  await w.api.sweep();
  const last = ledger(w.dir).filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ to: last.to, reason: last.reason }, { to: 'abandoned', reason: 'process_gone' });
  assert.deepStrictEqual(locksOf(w.dir), {});
  assert.strictEqual(w.api.publish().handoffRecovery, null);
});

// ---- the undecidable condition (§M4): five conjuncts ---------------------------------------------

test('the element appears iff ALL FIVE conjuncts hold; falsifying any one keeps handoffRecovery null', async () => {
  // Base: all five hold.
  const base = await undecidableWorld(1);
  const hr = base.w.api.publish().handoffRecovery;
  assert.ok(hr, 'the base fixture is undecidable');
  assert.deepStrictEqual(Object.keys(hr).sort(), ['since', 'token'], 'no ids, no count, no array');
  assert.strictEqual(hr.token, tokenOf(base.plans));
  assert.strictEqual(hr.since, iso(T0));

  // 1. status not unconfirmed.
  const w1 = world();
  const p1 = mkPlan(w1, 0);
  writeLedger(w1, [recIntent(p1), recProcess(p1, 4240), recStatus(p1, 'launching', 'active', 'confirmed')]);
  w1.psBox.rows.push(aliveRow(p1, workerPid(0)));
  await w1.api.recoverAtStartup(); w1.advance(11 * MIN); await w1.api.sweep();
  assert.strictEqual(w1.api.publish().handoffRecovery, null);

  // 2. the transcript exists.
  const w2 = await undecidableWorld(1);
  fs.mkdirSync(path.dirname(w2.plans[0].transcriptPath), { recursive: true });
  fs.writeFileSync(w2.plans[0].transcriptPath, '{}\n');
  await w2.w.api.sweep();                  // row 4 adopts it instead
  assert.strictEqual(w2.w.api.publish().handoffRecovery, null);

  // 3. dispatch liveness reads absent.
  const w3 = world();
  const p3 = mkPlan(w3, 0);
  writeLedger(w3, [recIntent(p3), recProcess(p3, 4240), recStatus(p3, 'launching', 'unconfirmed', 'confirm_timeout')]);
  await w3.api.recoverAtStartup(); w3.advance(11 * MIN); await w3.api.sweep();
  assert.strictEqual(w3.api.publish().handoffRecovery, null);

  // 4. now - unconfirmedAt < goneGraceMs.
  const w4 = world();
  const p4 = mkPlan(w4, 0);
  writeLedger(w4, [recIntent(p4), recProcess(p4, 4240), recStatus(p4, 'launching', 'unconfirmed', 'confirm_timeout')]);
  w4.psBox.rows.push(aliveRow(p4, workerPid(0)));
  await w4.api.recoverAtStartup(); w4.advance(9 * MIN); await w4.api.sweep();
  assert.strictEqual(w4.api.publish().handoffRecovery, null);

  // 5. membership of an OPEN recovery-op — what makes a press final.
  const w5 = world();
  const p5 = mkPlan(w5, 0);
  writeLedger(w5, [
    recIntent(p5), recProcess(p5, 4240), recStatus(p5, 'launching', 'unconfirmed', 'confirm_timeout'),
    { t: 'recovery-op', at: iso(T0), opId: crypto.randomUUID(), op: 'discard', ids: [p5.handoffId], token: hk.sha256(hk.canon([p5.handoffId])) },
  ]);
  w5.psBox.rows.push(aliveRow(p5, workerPid(0)));
  await w5.api.recoverAtStartup(); w5.advance(11 * MIN); await w5.api.sweep();
  assert.strictEqual(w5.api.publish().handoffRecovery, null, 'members of an open op are excluded from the condition itself');
});

test('ONE object for the whole set: three undecidable handoffs publish the same shape as one', async () => {
  const { w, plans } = await undecidableWorld(3);
  const hr = w.api.publish().handoffRecovery;
  assert.deepStrictEqual(Object.keys(hr).sort(), ['since', 'token']);
  assert.strictEqual(hr.token, tokenOf(plans), 'sha256 over the sorted handoffIds, §6.4 canon');
  assert.strictEqual(hr.since, iso(T0), 'the smallest unconfirmedAt');
  for (const p of plans) assert.ok(!JSON.stringify(hr).includes(p.handoffId), 'nothing a reader could turn into a list');
  // The privacy oracle is SCOPED to handoffRecovery: §4.6 REQUIRES the live handoffs, ids included.
  assert.strictEqual(w.api.publish().handoffs.length, 3);
});

// ---- the press (§M4) -----------------------------------------------------------------------------

test('token validation: required, malformed, unknown field; a stale token is 409 not_recoverable with a message', async () => {
  const { w, plans } = await undecidableWorld(1);
  assert.deepStrictEqual((await w.api.adopt({})).body.reason, 'required');
  assert.deepStrictEqual((await w.api.adopt({ token: 'xyz' })).body.reason, 'malformed');
  assert.deepStrictEqual((await w.api.adopt({ token: tokenOf(plans), extra: 1 })).body.reason, 'unknown_field');
  const stale = await w.api.discard({ token: hk.sha256(hk.canon(['h-not-the-set'])) });
  assert.deepStrictEqual({ s: stale.status, e: stale.body.error, m: typeof stale.body.message }, { s: 409, e: 'not_recoverable', m: 'string' });
  assert.strictEqual(ledger(w.dir).filter((x) => x.t === 'recovery-op').length, 0, 'nothing is written on any of them');
});

test('adopt: one press empties the whole set — record first, then the per-id lines, 200 {}', async () => {
  const { w, plans } = await undecidableWorld(3);
  const r = await w.api.adopt({ token: tokenOf(plans) });
  assert.deepStrictEqual(r, { status: 200, body: {} });
  const recs = ledger(w.dir);
  const opIdx = recs.findIndex((x) => x.t === 'recovery-op');
  assert.ok(opIdx >= 0);
  assert.deepStrictEqual(recs[opIdx].ids, plans.map((p) => p.handoffId).sort());
  const adopted = recs.filter((x, i) => i > opIdx && x.t === 'status' && x.reason === 'adopted_operator');
  assert.strictEqual(adopted.length, 3, 'all three, atomically, AFTER the record');
  assert.strictEqual(w.api.publish().handoffRecovery, null, 'null immediately — not after a sweep');
  await w.api.sweep();
  assert.strictEqual(w.api.publish().handoffRecovery, null, 'and it NEVER returns for these three');
  // Keys kept; they continue as normal live handoffs and resolve like any other.
  assert.strictEqual(Object.keys(locksOf(w.dir)).length, 3, 'adopt keeps every fact key');
  w.stateBox.state = Object.assign({}, w.stateBox.state, { repos: { repoA: { branches: [], worktrees: [] } } });
  await w.api.sweep();
  assert.deepStrictEqual(locksOf(w.dir), {}, 'a later resolved releases normally');

  // Double-press is safe by construction: the set the token names no longer exists.
  const again = await w.api.adopt({ token: tokenOf(plans) });
  assert.deepStrictEqual({ s: again.status, e: again.body.error }, { s: 409, e: 'not_recoverable' });
});

test('discard: the record is durable and 200 returned BEFORE any signal; kills are the server\'s, on the sweep', async () => {
  const { w, plans } = await undecidableWorld(1);
  w.killBox.calls.length = 0;
  const r = await w.api.discard({ token: tokenOf(plans) });
  assert.deepStrictEqual(r, { status: 200, body: {} });
  assert.strictEqual(ledger(w.dir).filter((x) => x.t === 'recovery-op').length, 1, 'the record IS the press');
  assert.strictEqual(w.killBox.calls.filter(([, s]) => s !== 0).length, 0, 'no signal was sent before the record was durable');
  assert.strictEqual(w.api.publish().handoffRecovery, null, 'the element is gone at the press');

  // The server-owned drive: SIGTERM, poll, SIGKILL over the dispatch set, per §M4.
  w.killBox.impl = lethalKill(w);
  await w.api.sweep();
  const sigs = w.killBox.calls.filter(([, s]) => s !== 0).map(([, s]) => s);
  assert.ok(sigs.includes('SIGTERM'), 'TERM first');
  const last = ledger(w.dir).filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ to: last.to, reason: last.reason }, { to: 'discarded', reason: 'discarded_operator' });
  assert.deepStrictEqual(locksOf(w.dir), {}, 'released on proven absence');
});

test('PARTIAL KILL CANNOT RESURRECT THE ELEMENT: two die, one refuses, the element stays gone', async () => {
  const { w, plans } = await undecidableWorld(3);
  // pids 7000/7001 die when signalled; 7002 ignores everything.
  w.killBox.impl = (pid, sig) => {
    w.killBox.calls.push([pid, sig]);
    if (pid === workerPid(2)) return true;                      // refuses to die
    return lethalKill(w)(pid, sig);
  };
  assert.deepStrictEqual(await w.api.discard({ token: tokenOf(plans) }), { status: 200, body: {} });
  await w.api.sweep();
  const st = (id) => ledger(w.dir).filter((x) => x.t === 'status' && x.id === id).pop().to;
  assert.strictEqual(st(plans[0].handoffId), 'discarded', 'settled independently, the moment it is proven absent');
  assert.strictEqual(st(plans[1].handoffId), 'discarded');
  assert.strictEqual(st(plans[2].handoffId), 'unconfirmed', 'the refuser stays under the open op');
  assert.deepStrictEqual(Object.keys(locksOf(w.dir)), plans[2].factKeys, 'its keys stay HELD; only proven halves release');
  assert.strictEqual(w.api.publish().handoffRecovery, null, 'null throughout — never a token for the remainder');
  // Retried on every subsequent sweep, indefinitely, invisibly.
  const kills = w.killBox.calls.filter(([p, s]) => p === workerPid(2) && s !== 0).length;
  await w.api.sweep();
  assert.ok(w.killBox.calls.filter(([p, s]) => p === workerPid(2) && s !== 0).length > kills, 'still being signalled');
  assert.strictEqual(w.api.publish().handoffRecovery, null);
});

test('recovery routes fail only BEFORE the record: a failed append is 500 with ZERO signals sent', async () => {
  const { w, plans } = await undecidableWorld(1);
  const orig = store.appendLineUnqueued;
  store.appendLineUnqueued = (file, obj) => {
    if (obj && obj.t === 'recovery-op') throw new Error('injected recovery-op failure');
    return orig(file, obj);
  };
  w.killBox.calls.length = 0;
  let r;
  try { r = await w.api.discard({ token: tokenOf(plans) }); }
  finally { store.appendLineUnqueued = orig; }
  assert.deepStrictEqual({ s: r.status, e: r.body.error }, { s: 500, e: 'ledger_write_failed' });
  assert.ok(r.body.incidentId);
  assert.strictEqual(w.killBox.calls.length, 0, 'nothing was recorded, so nothing was signalled');
  assert.ok(w.api.publish().handoffRecovery, 'the element is exactly as it was');
});

// ---- open-operation races (§M4's member table beats ordinary lifecycle) --------------------------

test('open discard: facts cleared -> resolved (the work is gone, killing it is moot); the op CLOSES', async () => {
  const { w, plans } = await undecidableWorld(1);
  w.killBox.impl = (pid, sig) => { w.killBox.calls.push([pid, sig]); return true; };   // unkillable
  await w.api.discard({ token: tokenOf(plans) });
  w.stateBox.state = Object.assign({}, w.stateBox.state, { repos: { repoA: { branches: [], worktrees: [] } } });
  await w.api.sweep();
  const last = ledger(w.dir).filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ to: last.to, reason: last.reason }, { to: 'resolved', reason: 'facts_cleared' });
  assert.deepStrictEqual(locksOf(w.dir), {});
  const kills = w.killBox.calls.filter(([, s]) => s !== 0).length;
  await w.api.sweep();
  assert.strictEqual(w.killBox.calls.filter(([, s]) => s !== 0).length, kills, 'a settled member is never signalled again');
});

test('open discard: a late transcript does NOT revoke it — no adopted_auto, the kill continues', async () => {
  const { w, plans } = await undecidableWorld(1);
  await w.api.discard({ token: tokenOf(plans) });
  fs.mkdirSync(path.dirname(plans[0].transcriptPath), { recursive: true });
  fs.writeFileSync(plans[0].transcriptPath, '{}\n');            // the dispatch was real after all
  w.killBox.impl = lethalKill(w);
  await w.api.sweep();
  const recs = ledger(w.dir).filter((x) => x.t === 'status' && x.id === plans[0].handoffId);
  assert.ok(!recs.some((x) => x.reason === 'adopted_auto' || x.reason === 'adopted_operator'), 'Sean pressed discard; a late transcript does not revoke it');
  assert.strictEqual(recs.pop().to, 'discarded');
});

test('open discard: an unhealthy capture decides nothing — no record, no release, no signal', async () => {
  const { w, plans } = await undecidableWorld(1);
  await w.api.discard({ token: tokenOf(plans) });
  w.psBox.fail = true;
  w.killBox.calls.length = 0;
  const lines = ledger(w.dir).length;
  await w.api.sweep();
  assert.strictEqual(ledger(w.dir).length, lines);
  assert.strictEqual(w.killBox.calls.filter(([, s]) => s !== 0).length, 0);
  assert.deepStrictEqual(Object.keys(locksOf(w.dir)), plans[0].factKeys, 'retry next sweep, keys held');
});

test('crash mid-adopt is COMPLETED, not repeated: replay appends only the missing lines', async () => {
  const w = world();
  const plans = [0, 1, 2].map((i) => mkPlan(w, i));
  const opId = crypto.randomUUID();
  const token = tokenOf(plans);
  const recs = [];
  for (const p of plans) recs.push(recIntent(p), recProcess(p, 4240), recStatus(p, 'launching', 'unconfirmed', 'confirm_timeout'));
  recs.push({ t: 'recovery-op', at: iso(T0), opId, op: 'adopt', ids: plans.map((p) => p.handoffId).sort(), token });
  recs.push(recStatus(plans[0], 'unconfirmed', 'active', 'adopted_operator'));      // the crash landed one of three
  for (const p of plans) w.psBox.rows.push(aliveRow(p, workerPid(0)));
  writeLedger(w, recs);
  await w.api.recoverAtStartup();
  const adopted = ledger(w.dir).filter((x) => x.t === 'status' && x.reason === 'adopted_operator');
  assert.strictEqual(adopted.length, 3, 'the two MISSING lines were appended; the landed one was skipped');
  assert.strictEqual(w.api.publish().handoffRecovery, null);
  // A second pass writes nothing.
  const w2 = world();
  fs.cpSync(path.join(w.dir, 'handoffs'), path.join(w2.dir, 'handoffs'), { recursive: true });
  const before = ledger(w2.dir).length;
  await w2.api.recoverAtStartup();
  assert.strictEqual(ledger(w2.dir).length, before, 'settled ops are never retried');
});

test('crash mid-discard resumes signalling from the CURRENT process state, before the first sweep', async () => {
  const w = world();       // dispatches died during the downtime: no uuid rows, kill -> ESRCH
  const plans = [0, 1, 2].map((i) => mkPlan(w, i));
  const recs = [];
  for (const p of plans) recs.push(recIntent(p), recProcess(p, 4240), recStatus(p, 'launching', 'unconfirmed', 'confirm_timeout'));
  recs.push({ t: 'recovery-op', at: iso(T0), opId: crypto.randomUUID(), op: 'discard', ids: plans.map((p) => p.handoffId).sort(), token: tokenOf(plans) });
  recs.push(recStatus(plans[0], 'unconfirmed', 'discarded', 'discarded_operator'));
  writeLedger(w, recs);
  await w.api.recoverAtStartup();
  const st = (id) => ledger(w.dir).filter((x) => x.t === 'status' && x.id === id).pop().to;
  assert.strictEqual(st(plans[1].handoffId), 'discarded', '`ids` and `op` come from the record — nothing that lived only in memory');
  assert.strictEqual(st(plans[2].handoffId), 'discarded');
  assert.deepStrictEqual(locksOf(w.dir), {});
  assert.strictEqual(w.api.publish().handoffRecovery, null);
});

// ---- startup recovery table (S-006) --------------------------------------------------------------

test('startup: a claim with no intent and no result settles 409 request_incomplete and deletes its preview', async () => {
  const w = world();
  const plan = mkPlan(w, 0);
  const previewFile = path.join(w.dir, 'handoffs', 'previews', `${plan.previewId}.json`);
  fs.mkdirSync(path.dirname(previewFile), { recursive: true });
  fs.writeFileSync(previewFile, JSON.stringify({ v: 1, plan, hash: hk.hashOf(plan) }));
  writeLedger(w, [recClaim(plan, 'k-crashed')]);
  await w.api.recoverAtStartup();
  const res = ledger(w.dir).filter((x) => x.t === 'result');
  assert.strictEqual(res.length, 1);
  assert.deepStrictEqual({ s: res[0].status, e: res[0].body.error, k: res[0].idempotencyKey }, { s: 409, e: 'request_incomplete', k: 'k-crashed' });
  assert.ok(res[0].body.incidentId, 'request_incomplete carries an incidentId (specs §M2 rule 1 / route table)');
  assert.ok(!fs.existsSync(previewFile), 'located via claim.previewId — no reverse lookup from the fingerprint');
});

test('startup: pending resolves by the argv scan — deterministic /usr/bin/script leader, the rest observed', async () => {
  const w = world();
  const plan = mkPlan(w, 0);
  writeLedger(w, [recClaim(plan, 'k-pend'), recIntent(plan, 'k-pend')]);
  // The scan returns BOTH the script leader and the worker; pid is the leader everywhere.
  w.psBox.rows.push(`  6100     1 ${LSTART} /usr/bin/script -q /dev/null ${plan.claudeBin} --session-id ${plan.sessionUuid}`);
  w.psBox.rows.push(`  6101  6100 ${LSTART} bash ${plan.claudeBin} --remote-control --session-id ${plan.sessionUuid} seed`);
  await w.api.recoverAtStartup();
  const proc = ledger(w.dir).filter((x) => x.t === 'process').pop();
  assert.strictEqual(proc.pid, 6100, 'the match whose command begins /usr/bin/script is the leader');
  assert.deepStrictEqual(proc.observedPids, [{ pid: 6101, lstart: LSTART }]);
  // Then the launching row applies: no transcript -> unconfirmed, the waiting claim settles 202.
  const st = ledger(w.dir).filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ from: st.from, to: st.to }, { from: 'launching', to: 'unconfirmed' });
  const res = ledger(w.dir).filter((x) => x.t === 'result').pop();
  assert.strictEqual(res.status, 202);
});

test('startup: pending with no process anywhere is abandoned {process_absent}; the claim settles 502', async () => {
  const w = world();
  const plan = mkPlan(w, 0);
  writeLedger(w, [recClaim(plan, 'k-gone'), recIntent(plan, 'k-gone')]);
  await w.api.recoverAtStartup();
  const st = ledger(w.dir).filter((x) => x.t === 'status').pop();
  assert.deepStrictEqual({ to: st.to, reason: st.reason }, { to: 'abandoned', reason: 'process_absent' });
  const res = ledger(w.dir).filter((x) => x.t === 'result').pop();
  assert.deepStrictEqual({ s: res.status, e: res.body.error }, { s: 502, e: 'spawn_failed' });
  assert.deepStrictEqual(locksOf(w.dir), {}, 'released');
});

test('startup: launching resolves by the transcript — present 201, absent 202; a second pass writes nothing', async () => {
  const w = world();
  const p1 = mkPlan(w, 0);
  const p2 = mkPlan(w, 1);
  fs.mkdirSync(path.dirname(p1.transcriptPath), { recursive: true });
  fs.writeFileSync(p1.transcriptPath, '{}\n');
  writeLedger(w, [
    recClaim(p1, 'k-a'), recIntent(p1, 'k-a'), recProcess(p1, 4240),
    recClaim(p2, 'k-b'), recIntent(p2, 'k-b'), recProcess(p2, 4241),
  ]);
  w.psBox.rows.push(aliveRow(p2, workerPid(1)));
  await w.api.recoverAtStartup();
  const byId = (id) => ledger(w.dir).filter((x) => x.t === 'status' && x.id === id).pop();
  assert.deepStrictEqual({ to: byId(p1.handoffId).to, reason: byId(p1.handoffId).reason }, { to: 'active', reason: 'confirmed' });
  assert.strictEqual(byId(p2.handoffId).to, 'unconfirmed');
  const results = ledger(w.dir).filter((x) => x.t === 'result');
  assert.deepStrictEqual(results.map((r) => r.status).sort(), [201, 202]);
  // Exactly once: a fresh instance over the settled ledger appends nothing.
  const w2 = world();
  fs.cpSync(path.join(w.dir, 'handoffs'), path.join(w2.dir, 'handoffs'), { recursive: true });
  const before = ledger(w2.dir).length;
  await w2.api.recoverAtStartup();
  assert.strictEqual(ledger(w2.dir).length, before);
});

// ---- §4.8 tail repair ----------------------------------------------------------------------------

test('tail repair: an unparseable final line is skipped forever and sealed with one newline', async () => {
  const w = world();
  const plan = mkPlan(w, 0);
  fs.mkdirSync(path.join(w.dir, 'handoffs'), { recursive: true });
  const good = JSON.stringify(recIntent(plan, 'k-t')) + '\n' + JSON.stringify(recClaim(plan, 'k-t')) + '\n';
  fs.writeFileSync(ledgerPath(w.dir), good + '{"t":"intent","at":"2026-08-01T');   // crash mid-write
  w.psBox.rows.push(aliveRow(plan, workerPid(0)));   // the dispatch is alive, so the keys stay held
  await w.api.recoverAtStartup();
  const text = fs.readFileSync(ledgerPath(w.dir), 'utf8');
  assert.ok(text.includes('{"t":"intent","at":"2026-08-01T\n'), 'the bad line is still present (append-only) and now sealed');
  // The caches rebuilt from the intact records: the intent is live, holding its keys.
  assert.deepStrictEqual(Object.keys(locksOf(w.dir)), plan.factKeys);
  // The startup appends landed as their OWN parseable lines — nothing fused onto the tail.
  const all = fs.readFileSync(ledgerPath(w.dir), 'utf8').split('\n').filter(Boolean);
  let parseable = 0;
  for (const l of all) { try { JSON.parse(l); parseable++; } catch (_) { /* the one sealed bad line */ } }
  assert.strictEqual(all.length - parseable, 1, 'exactly the one bad line, nothing fused');
});

test('tail repair: a parseable final line without a newline IS a record; only the newline is restored', async () => {
  const w = world();
  const plan = mkPlan(w, 0);
  fs.mkdirSync(path.join(w.dir, 'handoffs'), { recursive: true });
  fs.writeFileSync(ledgerPath(w.dir), JSON.stringify(recIntent(plan, 'k-nl')));    // no trailing \n
  w.psBox.rows.push(aliveRow(plan, workerPid(0)));
  await w.api.recoverAtStartup();
  assert.deepStrictEqual(Object.keys(locksOf(w.dir)), plan.factKeys, 'accepted as a record — indistinguishable from a normal one');
  const text = fs.readFileSync(ledgerPath(w.dir), 'utf8');
  const idx = text.indexOf(JSON.stringify(recIntent(plan, 'k-nl')).slice(0, 40));
  assert.strictEqual(idx, 0);
  assert.ok(text.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch (_) { return false; } }), 'every line parses — the repair was one byte');
});
