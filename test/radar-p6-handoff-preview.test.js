'use strict';
// p6 S-006 (protocol) — module contract + preview: selector pipeline order, non-enumerating 422s,
// the §M2 plan table, the seed cap measured on DELIVERED bytes, LINE_MAX proven at preview, and
// preview-plan lifecycle (persist / re-preview / expiry).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../radar/store.js');
const hk = require('../radar/handoff-keys.js');
const handoff = require('../radar/handoff.js');
const { createHandoff, SAFETY_NOTICE, ERROR_MESSAGES } = handoff;

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-handoff-'));
// Plans put transcriptPath under ~; ~ is $HOME by definition, so the whole file runs against a
// scratch HOME and never touches the real ~/.claude.
process.env.HOME = tmpdir();

const LSTART = 'Sat Aug  1 07:00:00 2026';
const T0 = Date.parse('2026-08-01T07:00:00.000Z');

function standin(dir, body) {
  const p = path.join(dir, 'claude-standin.sh');
  fs.writeFileSync(p, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "9.9.9 (stand-in)"; exit 0; fi\n' + (body || 'exit 0\n'));
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
      repoB: {
        branches: [{ name: 'feature/z', epic: 'PROJ-2', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null }],
        worktrees: [],
      },
    },
    epics: [{ key: 'PROJ-1', signals: ['merged-not-deployed'], repos: ['repoA'] }, { key: 'PROJ-2', signals: [], repos: ['repoA', 'repoB'] }],
    attention: [{ type: 'orphan', repo: 'repoA', branch: 'stray' }],
  };
}

function world(o = {}) {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'wt1'), { recursive: true });
  const bin = o.bin || standin(dir, o.binBody);
  const state = o.state === undefined ? fixtureState(dir) : o.state;
  let t = T0;
  const logs = [];
  const cfg = Object.assign({
    collectorId: 'mac-test',
    repos: [{ id: 'repoA', path: dir }, { id: 'repoB', path: dir }],
    polyrepoRoot: path.join(dir, 'poly'),
    claudeBin: bin,
    confirmMs: 1000, goneGraceMs: 600000, sessionQuietMs: 1800000,
    discardKillMs: 100, previewTtlMs: 120000, seedMaxBytes: 12288,
  }, o.config);
  if (cfg.polyrepoRoot.startsWith(dir)) fs.mkdirSync(cfg.polyrepoRoot, { recursive: true });
  const api = createHandoff({
    dir, config: cfg,
    getState: o.getState || (() => state),
    now: () => t,
    spawn: o.spawn || (() => { throw new Error('no spawn expected in this test'); }),
    ps: o.ps || (async () => `    1     0 ${LSTART} /sbin/launchd`),
    kill: o.kill || (() => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }),
    log: (...a) => logs.push(a.join(' ')),
    buildBrief: o.buildBrief || ((s, sels) => ({ text: `BRIEF ${sels.join(' ')}` })),
  });
  return { dir, bin, state, cfg, api, logs, advance: (ms) => { t += ms; }, nowMs: () => t };
}

const FIRST_TURN = 'FIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until Sean replies.';
const previewFiles = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'handoffs', 'previews')).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
};

// ---- module contract ----------------------------------------------------------------------------

test('exports are exactly SAFETY_NOTICE, ERROR_MESSAGES, createHandoff', () => {
  assert.deepStrictEqual(Object.keys(handoff).sort(), ['ERROR_MESSAGES', 'SAFETY_NOTICE', 'createHandoff']);
});

test('SAFETY_NOTICE is byte-equal to the specs §7.2 sentence (plain text, 334 bytes)', () => {
  // Compared against the literal, not a substring — U4 findings never edit this string. The
  // spec's `**`/backticks are the spec document's own markdown, not bytes of the constant.
  const literal = 'The session is instructed to inspect and plan only on its first turn, and to ask before modifying, committing, pushing, merging or deleting anything. It runs without --dangerously-skip-permissions, so Claude\'s own permission prompts still apply — but your existing allowlists may already permit some commands. This is not a sandbox.';
  assert.strictEqual(SAFETY_NOTICE, literal);
  assert.strictEqual(Buffer.byteLength(SAFETY_NOTICE, 'utf8'), 334);
});

test('ERROR_MESSAGES covers every p6 code with one human sentence and no arrays', () => {
  const codes = [
    'bad_json', 'invalid_request', 'body_too_large', 'seed_too_large', 'plan_too_large',
    'selector_unresolved', 'workdir_unresolved', 'claude_bin_missing', 'claude_bin_unusable',
    'no_snapshot', 'viewer_readonly', 'preview_not_found', 'preview_expired', 'hash_mismatch',
    'idempotency_key_reused', 'in_flight', 'request_incomplete', 'facts_locked',
    'ledger_write_failed', 'seed_write_failed', 'spawn_failed', 'spawn_unrecorded',
    'not_recoverable', 'handoff_not_found',
  ];
  assert.deepStrictEqual(Object.keys(ERROR_MESSAGES).sort(), codes.slice().sort());
  for (const c of codes) {
    assert.strictEqual(typeof ERROR_MESSAGES[c], 'string');
    assert.ok(ERROR_MESSAGES[c].length > 0 && !Array.isArray(ERROR_MESSAGES[c]), c);
  }
  // There is NO discard_failed — it was the synchronous design's error code and is deleted (§M4).
  assert.strictEqual(ERROR_MESSAGES.discard_failed, undefined);
});

test('createHandoff returns the contract surface', () => {
  const w = world();
  for (const k of ['preview', 'commit', 'adopt', 'discard', 'get', 'sweep', 'recoverAtStartup', 'publish', 'suppressedKeys']) {
    assert.strictEqual(typeof w.api[k], 'function', k);
  }
  assert.deepStrictEqual(w.api.publish(), { handoffs: [], handoffRecovery: null, handoffsLive: 0 });
  assert.deepStrictEqual([...w.api.suppressedKeys()], []);
});

// ---- §6.4 vectors (the same canon this module hashes with) --------------------------------------

test('canonical encoding conformance vectors reproduce', () => {
  assert.strictEqual(hk.canon({ b: [2, 1, null], a: 'x\ny', '': true, z: { n: 1.5, s: 'é' } }),
    '{"":true,"a":"x\\ny","b":[2,1,null],"z":{"n":1.5,"s":"é"}}');
  assert.strictEqual(hk.sha256(hk.canon({ b: [2, 1, null], a: 'x\ny', '': true, z: { n: 1.5, s: 'é' } })),
    'd6d9fdd8bdd051399514d1fa6febe8961e26e213db0c3ec689ec2cbd6d445b4a');
  assert.strictEqual(hk.sha256(hk.canon({ previewId: '3f2a1b8c-0e4d-4a7b-9c1d-2e5f6a7b8c9d', hash: '0f'.repeat(32) })),
    '441c4364cbe65404ebf63753f1d52436874d453e160cc0efc1bd20e77e92c5eb');
});

// ---- request shape (§7.1 steps 3-5) --------------------------------------------------------------

test('preview: not-an-object and unknown fields are refused, never ignored', async () => {
  const w = world();
  assert.deepStrictEqual((await w.api.preview('nope')).body, { error: 'invalid_request', message: ERROR_MESSAGES.invalid_request, field: '', reason: 'not_an_object' });
  const r = await w.api.preview({ selectors: ['PROJ-1'], extra: 1 });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual({ field: r.body.field, reason: r.body.reason }, { field: 'extra', reason: 'unknown_field' });
});

test('preview: the selectors field table', async () => {
  const w = world();
  const cases = [
    [{}, 'required'],
    [{ selectors: 'x' }, 'not_an_array'],
    [{ selectors: [] }, 'empty'],
    [{ selectors: Array.from({ length: 65 }, (_, i) => `epic:E${i}`) }, 'too_many'],
    [{ selectors: [42] }, 'not_a_string'],
    [{ selectors: ['   '] }, 'empty'],
    [{ selectors: ['epic:' + 'a'.repeat(510)] }, 'too_long'],
  ];
  for (const [args, reason] of cases) {
    const r = await w.api.preview(args);
    assert.strictEqual(r.status, 400, reason);
    assert.strictEqual(r.body.reason, reason);
    assert.strictEqual(r.body.field, 'selectors');
  }
  const r2 = await w.api.preview({ selectors: ['PROJ-1'], seedOverride: 42 });
  assert.deepStrictEqual({ f: r2.body.field, r: r2.body.reason }, { f: 'seedOverride', r: 'not_a_string' });
});

test('preview: pipeline order — bare token expands BEFORE validation, dedupe+sort after', async () => {
  const w = world();
  // `PROJ-1` is not a literal kind: validating before expansion would reject the shipped
  // `radar brief PROJ-108` vocabulary. The expansion is the ONLY thing that makes it valid.
  const r = await w.api.preview({ selectors: ['PROJ-1', 'epic:PROJ-1', '  PROJ-1  '] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.plan.selectors, ['epic:PROJ-1']);
});

test('preview: malformed selectors are 400 malformed_selector; wt:nope vs wt:/nope split', async () => {
  const w = world();
  for (const sel of ['wt:nope', 'branch:repoA', 'branch:repoA:x:y', 'epic:', 'branch::x', 'wt:', 'bogus:z', 'wt:/a/b%3ac', 'wt:/a/b%2Fc', 'epic:x%2', 'epic:x%']) {
    const r = await w.api.preview({ selectors: [sel] });
    assert.strictEqual(r.status, 400, sel);
    assert.deepStrictEqual({ f: r.body.field, re: r.body.reason }, { f: 'selectors', re: 'malformed_selector' }, sel);
  }
  // Well-formed but naming nothing on the board: a WORLD verdict, 422, never 400. Nothing is both.
  const r2 = await w.api.preview({ selectors: ['wt:/nope'] });
  assert.strictEqual(r2.status, 422);
  assert.strictEqual(r2.body.error, 'selector_unresolved');
});

test('preview: unresolved is all-or-nothing and NON-ENUMERATING; detail goes to the log', async () => {
  const w = world();
  const r = await w.api.preview({ selectors: ['epic:PROJ-1', 'epic:NOPE'] });   // mixed valid+invalid
  assert.strictEqual(r.status, 422);
  // §7.3: the body names one incident and nothing else — no array, no selector names.
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['error', 'incidentId', 'message']);
  assert.ok(!JSON.stringify(r.body).includes('NOPE'));
  assert.strictEqual(previewFiles(w.dir).length, 0, 'nothing partial is ever previewed');
  const line = w.logs.find((l) => l.includes(r.body.incidentId));
  assert.ok(line && line.includes('epic:NOPE'), 'offending selectors live in the server log, keyed by incidentId');
});

test('preview: `worktrees` with nothing stale and `orphans` with none are unresolved', async () => {
  const w = world();
  w.state.repos.repoA.worktrees[0].stale = false;
  w.state.repos.repoA.worktrees[0].dirty = null;
  w.state.attention = [];
  for (const sel of ['worktrees', 'orphans']) {
    const r = await w.api.preview({ selectors: [sel] });
    assert.strictEqual(r.status, 422, sel);
  }
});

test('preview: 503 no_snapshot before any semantic work', async () => {
  const w = world({ getState: () => null });
  const r = await w.api.preview({ selectors: ['PROJ-1'] });
  assert.strictEqual(r.status, 503);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['error', 'message']);
});

// ---- the plan (§M2) ------------------------------------------------------------------------------

test('preview mints every plan field; hash is beside the plan, computed over the plan alone', async () => {
  const w = world();
  const r = await w.api.preview({ selectors: ['epic:PROJ-1'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['hash', 'plan', 'v']);
  assert.strictEqual(r.body.v, 1);
  const plan = r.body.plan;
  const FIELDS = ['previewId', 'handoffId', 'sessionUuid', 'windowName', 'machine', 'selectors',
    'factKeys', 'workdir', 'claudeBin', 'claudeVersion', 'seedPath', 'logPath', 'transcriptPath',
    'argv', 'seedText', 'createdAt', 'expiresAt'];
  assert.deepStrictEqual(Object.keys(plan).sort(), FIELDS.slice().sort());
  assert.strictEqual(plan.hash, undefined, 'nothing contains hash');
  assert.strictEqual(plan.pid, undefined, 'pid is NOT a plan field');
  assert.strictEqual(r.body.hash, hk.hashOf(plan));
  // Every plan value is a string, an array of strings, or null — no numbers, no nested objects.
  for (const [k, v] of Object.entries(plan)) {
    assert.ok(v === null || typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')), k);
  }
  assert.strictEqual(plan.machine, 'mac-test');
  assert.strictEqual(plan.claudeVersion, '9.9.9 (stand-in)');
  assert.match(plan.handoffId, /^h-20260801-\d{4}-[0-9a-f]{6}$/);
  assert.strictEqual(plan.handoffId.slice(-6), plan.previewId.slice(0, 6));
  assert.strictEqual(plan.windowName, `${plan.handoffId}-epic-proj-1`);
  // §6.3 slugifyPath is Claude Code's own projects rule.
  assert.strictEqual(plan.transcriptPath,
    path.join(process.env.HOME, '.claude', 'projects', plan.workdir.replace(/[^A-Za-z0-9]/g, '-'), `${plan.sessionUuid}.jsonl`));
  assert.deepStrictEqual(plan.argv, ['--remote-control', '-n', plan.windowName, '--session-id', plan.sessionUuid, plan.seedText]);
  assert.deepStrictEqual(plan.factKeys, hk.factKeys(w.state, ['epic:PROJ-1']).factKeys);
  // Persisted object and response are the same object.
  const onDisk = JSON.parse(fs.readFileSync(path.join(w.dir, 'handoffs', 'previews', `${plan.previewId}.json`), 'utf8'));
  assert.deepStrictEqual(onDisk, r.body);
});

test('workdir: ALWAYS polyrepoRoot — one repo, many repos, no exceptions; missing dir -> 422', async () => {
  // Owner decision 2026-08-02: every session runs from the polyrepo root so all transcripts land
  // in ONE project folder. A per-repo workdir would scatter them; the seed names the repo instead.
  const w = world();
  // NOTE: §6.1 escapes ONLY `%` and `:`; a branch slash stays literal, so the selector is
  // branch:repoA:feature/x (the `%2F` in §4.2's example key is illegal under §6.1's own decoder).
  const one = await w.api.preview({ selectors: ['branch:repoA:feature/x'] });
  assert.strictEqual(one.body.plan.workdir, w.cfg.polyrepoRoot, 'single repo STILL dispatches from polyrepoRoot');
  const two = await w.api.preview({ selectors: ['epic:PROJ-2'] }); // spans repoA + repoB
  assert.strictEqual(two.body.plan.workdir, w.cfg.polyrepoRoot);
  const twoSingles = await w.api.preview({ selectors: ['branch:repoA:feature/x', 'branch:repoB:feature/z'] });
  assert.strictEqual(twoSingles.body.plan.workdir, w.cfg.polyrepoRoot, 'two selectors, two repos -> polyrepoRoot, not either repo');
  const w2 = world({ config: { polyrepoRoot: '/nope/never/exists' } });
  const bad = await w2.api.preview({ selectors: ['epic:PROJ-2'] });
  assert.strictEqual(bad.status, 422);
  assert.deepStrictEqual({ e: bad.body.error, w: bad.body.workdir }, { e: 'workdir_unresolved', w: '/nope/never/exists' });
});

test('claudeBin: missing is 422 claude_bin_missing; a broken --version is 422 claude_bin_unusable', async () => {
  const w = world({ config: { claudeBin: '/nope/claude' } });
  const r = await w.api.preview({ selectors: ['PROJ-1'] });
  assert.deepStrictEqual({ s: r.status, e: r.body.error, p: r.body.path }, { s: 422, e: 'claude_bin_missing', p: '/nope/claude' });

  const d2 = tmpdir();
  const badBin = path.join(d2, 'bad.sh');
  fs.writeFileSync(badBin, '#!/bin/bash\nexit 1\n'); fs.chmodSync(badBin, 0o755);
  const w2 = world({ config: { claudeBin: badBin } });
  const r2 = await w2.api.preview({ selectors: ['PROJ-1'] });
  assert.strictEqual(r2.status, 422);
  assert.strictEqual(r2.body.error, 'claude_bin_unusable');
  assert.strictEqual(r2.body.path, badBin);
  assert.ok(typeof r2.body.detail === 'string' && r2.body.detail.length > 0);
});

// ---- the seed (§6.8) -----------------------------------------------------------------------------

test('seedText = brief (or override) + newline + the 108-byte FIRST TURN line', async () => {
  assert.strictEqual(Buffer.byteLength(FIRST_TURN, 'utf8'), 108);
  const w = world();
  const r = await w.api.preview({ selectors: ['epic:PROJ-1'] });
  assert.strictEqual(r.body.plan.seedText, 'BRIEF epic:PROJ-1\n' + FIRST_TURN);
  const o = await w.api.preview({ selectors: ['epic:PROJ-1'], seedOverride: 'MY SEED' });
  assert.strictEqual(o.body.plan.seedText, 'MY SEED\n' + FIRST_TURN);
});

test('the cap applies to the FINAL seedText: 12179-byte override fits exactly, 12180 is 413', async () => {
  const w = world();
  const fit = await w.api.preview({ selectors: ['epic:PROJ-1'], seedOverride: 'a'.repeat(12179) });
  assert.strictEqual(fit.status, 200);
  assert.strictEqual(Buffer.byteLength(fit.body.plan.seedText, 'utf8'), 12288);
  const over = await w.api.preview({ selectors: ['epic:PROJ-1'], seedOverride: 'a'.repeat(12180) });
  assert.deepStrictEqual({ s: over.status, e: over.body.error, l: over.body.limit }, { s: 413, e: 'seed_too_large', l: 12288 });
  // A 12288-byte override is REJECTED — accepting it would deliver 12397 bytes.
  const full = await w.api.preview({ selectors: ['epic:PROJ-1'], seedOverride: 'a'.repeat(12288) });
  assert.strictEqual(full.status, 413);
});

test('LINE_MAX is proven at preview: an intent line that cannot fit is 413 plan_too_large, nothing persisted', async () => {
  // seedMaxBytes is raised so the SEED passes and the LEDGER LINE is what fails — the §4.8 check
  // preview must make while the plan is still reversible.
  const w = world({ config: { seedMaxBytes: 300000 } });
  const r = await w.api.preview({ selectors: ['epic:PROJ-1'], seedOverride: 'a'.repeat(140000) });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.body.error, 'plan_too_large');
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['error', 'incidentId', 'message']);
  assert.strictEqual(previewFiles(w.dir).length, 0);
});

test('an edit re-previews: new previewId, handoffId AND sessionUuid every time', async () => {
  const w = world();
  const a = (await w.api.preview({ selectors: ['PROJ-1'], seedOverride: 'one' })).body.plan;
  const b = (await w.api.preview({ selectors: ['PROJ-1'], seedOverride: 'two' })).body.plan;
  assert.notStrictEqual(a.previewId, b.previewId);
  assert.notStrictEqual(a.handoffId, b.handoffId);
  assert.notStrictEqual(a.sessionUuid, b.sessionUuid);
});

test('config is re-read at the request boundary — an operator edit needs no restart', async () => {
  const w = world();
  const cfgFile = path.join(w.dir, 'config.json');
  const diskCfg = (seedMaxBytes) => JSON.stringify({
    configVersion: 1, collectorId: 'mac-test',
    repos: [{ id: 'repoA', path: w.dir }], polyrepoRoot: w.dir, claudeBin: w.bin,
    seedMaxBytes,
  });
  const big = 'a'.repeat(5000);            // 5109 delivered bytes: over 2048/4096, under 12288
  // No config.json on disk: the INJECTED config governs — the test seam and bare-install fallback.
  assert.strictEqual((await w.api.preview({ selectors: ['PROJ-1'], seedOverride: big })).status, 200);
  // An operator writes config.json: the very NEXT request sees it. Boot-once was the footgun.
  fs.writeFileSync(cfgFile, diskCfg(2048));
  const r1 = await w.api.preview({ selectors: ['PROJ-1'], seedOverride: big });
  assert.deepStrictEqual({ s: r1.status, l: r1.body.limit }, { s: 413, l: 2048 });
  // Edited again: per-request, not per-boot.
  fs.writeFileSync(cfgFile, diskCfg(4096));
  const r2 = await w.api.preview({ selectors: ['PROJ-1'], seedOverride: big });
  assert.deepStrictEqual({ s: r2.status, l: r2.body.limit }, { s: 413, l: 4096 });
  // A config.json that stops PARSING keeps the last good config — a broken edit must not silently
  // flip every threshold to its default mid-flight.
  fs.writeFileSync(cfgFile, '{ broken');
  const r3 = await w.api.preview({ selectors: ['PROJ-1'], seedOverride: big });
  assert.deepStrictEqual({ s: r3.status, l: r3.body.limit }, { s: 413, l: 4096 });
  // Deleted: back to the injected fallback.
  fs.unlinkSync(cfgFile);
  assert.strictEqual((await w.api.preview({ selectors: ['PROJ-1'], seedOverride: big })).status, 200);
});

test('preview hands observations.jsonl to buildBrief — or every seed says `origin unknown`', async () => {
  // buildBrief reads the §6.5 lastObservedBy relation from opts.observations; the CLI brief path
  // loads the file itself, and preview must do the same for the seed. Absent file = no relation;
  // a truncated final line costs exactly that line.
  const seen = [];
  const w = world({ buildBrief: (s, sels, opts) => { seen.push(opts && opts.observations); return { text: 'B' }; } });
  const obs = [
    { machine: 'mac-test', sessionId: 's1', stopTs: 1, at: '2026-08-01T00:00:01Z', repo: 'repoA', branch: 'feature/x', headSha: 'a', dirtyCount: 0, unpushed: 1, transcriptPath: null, customTitle: 'probe-1' },
    { machine: 'mac-test', sessionId: 's2', stopTs: 2, at: '2026-08-01T00:00:02Z', repo: 'repoA', branch: 'feature/x', headSha: 'b', dirtyCount: 1, unpushed: 2, transcriptPath: null, customTitle: 'probe-2' },
  ];
  fs.writeFileSync(path.join(w.dir, 'observations.jsonl'),
    obs.map((x) => JSON.stringify(x)).join('\n') + '\n' + '{"machine":"mac-test","sessionId":"s3"');   // crashed tail
  assert.strictEqual((await w.api.preview({ selectors: ['PROJ-1'] })).status, 200);
  assert.deepStrictEqual(seen[0], obs, 'both intact lines, the truncated tail skipped');
  // Absent file: no relation, not an error.
  const w2 = world({ buildBrief: (s, sels, opts) => { seen.push(opts && opts.observations); return { text: 'B' }; } });
  assert.strictEqual((await w2.api.preview({ selectors: ['PROJ-1'] })).status, 200);
  assert.deepStrictEqual(seen[1], []);
  // A seedOverride bypasses the brief entirely — no observations read is needed or made.
  seen.length = 0;
  assert.strictEqual((await w2.api.preview({ selectors: ['PROJ-1'], seedOverride: 'X' })).status, 200);
  assert.strictEqual(seen.length, 0, 'the override path never calls buildBrief');
});

test('an expired plan is deleted on the next scan; an unaccepted plan is not an outward action', async () => {
  const w = world();
  const r = await w.api.preview({ selectors: ['PROJ-1'] });
  assert.strictEqual(previewFiles(w.dir).length, 1);
  w.advance(w.cfg.previewTtlMs + 1);
  await w.api.sweep();
  assert.strictEqual(previewFiles(w.dir).length, 0, r.body.plan.previewId);
  // Nothing else was created: no ledger, no seed, no log.
  assert.ok(!fs.existsSync(path.join(w.dir, 'handoffs', 'ledger.jsonl')));
});
