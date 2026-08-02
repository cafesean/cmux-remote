'use strict';
// p8 STORY-010 — provenance marking on generated command text, and the handover declaration.
//
// THE DECISION THIS FILE HOLDS IN PLACE (war-game M7b, human gate, operator-decided):
//
// p8 renders a git command as TEXT the operator runs by hand. Running git inside a repo executes
// that repo's configured programs — `pre-commit` on `commit`, `remote.<n>.uploadpack` on `fetch`
// AND `pull`, `remote.<n>.receivepack` on `push`, `core.sshCommand` on an ssh remote,
// `core.fsmonitor` on `pull --rebase`. All five measured. If the repo was reached only by
// browsing, that config is attacker-controlled input. Reviewing the text shows the VERB; it cannot
// show the HOOKS.
//
// A visible `-c core.hooksPath=/dev/null` in the templates was measured to close ONE of the five,
// so it is REJECTED: it makes the text no longer what the operator would have typed AND signals a
// safety it does not provide. Instead the text is MARKED BY PROVENANCE and the residue is DECLARED.
//
// So three properties are on trial here, and each has a failure mode a naive test passes:
//
//   1. THE MARKING IS PRESENTATION, NEVER PAYLOAD. "The text is right" passes against a text that
//      quietly gained a neutraliser, because a single-class test has nothing to compare against.
//      So byte-identity is asserted for THE SAME REPO reached through BOTH doors — one path, one
//      branch, one set of operands, thirteen verbs — plus a separate assertion that no neutraliser
//      is in the text at all, which is the arm a same-in-both-classes injection would escape.
//   2. PROVENANCE IS NOT `canWrite` RENAMED. `canWrite === (writesEnabled && assertRepo(top))`, so
//      with GIT_WRITES_ENABLED off it is false for EVERY repo — and a test that only ever runs with
//      writes ON cannot tell the two apart. So the control arm runs with writes OFF and with the
//      oracle THROWING, and requires a workspace repo to still read as `workspace`.
//   3. IT IS NOT AN ORACLE. The bit exists only on a repo already authorized for reading; an
//      unauthorized one returns the shared refusal shape with no provenance field at all. Asserted
//      over the SERIALISED body, because a field carrying `null` is still a field to read.
//
// And one cost property: NO NEW SPAWN. `assertRepo` is the other place this fact could have come
// from, and it costs one git spawn per open workspace and is gated behind `writesEnabled`. The
// gate already decided provenance one line at a time, so it is RECORDED rather than re-derived —
// asserted by counting both the injected runner's calls and the injected oracle's.
//
// Every assertion below has a negative control at the bottom: the fix is reverted by a textual
// mutation of the REAL source, the module is recompiled in its own module record, and the oracle
// is required to throw. A mutation that does not change the file is itself a failure.
const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');

const GITREAD_PATH = path.join(__dirname, '..', 'gitread.js');
const GITBAR_PATH = path.join(__dirname, '..', 'public', 'gitbar.js');
const GITJS_PATH = path.join(__dirname, '..', 'public', 'git.js');
const GITREAD_SRC = fs.readFileSync(GITREAD_PATH, 'utf8');
const GITBAR_SRC = fs.readFileSync(GITBAR_PATH, 'utf8');
const GITJS_SRC = fs.readFileSync(GITJS_PATH, 'utf8');

const gitread = require('../gitread');
const gitbar = require('../public/gitbar');
const { createGitPanel } = require('../gitpanel');
const { GIT_BIN } = require('../lib/gitcmd');
const { g } = require('./helpers/git-fixture');

const {
  createGitRead, COMMAND_TEMPLATES, NEUTRALISERS,
  PROVENANCE_WORKSPACE, PROVENANCE_BROWSED, BROWSED_TEXT_MARK, GENERATED_TEXT_RESIDUE, PLATFORM_DENY,
} = gitread;

// ---- loading the REAL modules, optionally with the fix reverted -------------------------------
// A fresh module record per load, so a mutant never poisons the shared require cache and two
// controls in the same run cannot see each other's source.

function mutate(src, mutations, what) {
  let code = src;
  for (const [from, to] of mutations || []) {
    assert.ok(code.indexOf(from) !== -1, `mutation anchor missing from ${what}: ${from}`);
    const next = code.replace(from, to);
    assert.notStrictEqual(next, code, `mutation must actually change ${what}: ${from}`);
    code = next;
  }
  return code;
}

function loadGitread(mutations) {
  const m = new Module(GITREAD_PATH, null);
  m.filename = GITREAD_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(GITREAD_PATH));
  m._compile(mutate(GITREAD_SRC, mutations, 'gitread.js'), GITREAD_PATH);
  assert.strictEqual(typeof m.exports.createGitRead, 'function', 'gitread.js must export createGitRead');
  return m.exports;
}

function loadGitbar(mutations) {
  const m = new Module(GITBAR_PATH, null);
  m.filename = GITBAR_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(GITBAR_PATH));
  m._compile(mutate(GITBAR_SRC, mutations, 'public/gitbar.js'), GITBAR_PATH);
  assert.strictEqual(typeof m.exports.createGitBarModel, 'function', 'gitbar.js must export createGitBarModel');
  return m.exports;
}

// ---- the fixture ------------------------------------------------------------------------------
// Real git, real nesting. The whole story turns on the difference between a toplevel that IS a
// workspace cwd and one merely reached by browsing inside it, and a flat fixture cannot express it.
//
//   base/ws            repo — the workspace anchor
//   base/ws/nested     repo — inside the anchor, never itself a workspace cwd
//   base/outside       repo — outside every anchor, refused by the gate

let F = null;

async function buildFixture() {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-prov-')));
  const mk = async (rel) => { const p = path.join(base, rel); await fsp.mkdir(p, { recursive: true }); return p; };

  const ws = await mk('ws');
  await g(base, ['init', '-q', '-b', 'main', ws]);
  await fsp.writeFile(path.join(ws, '.gitignore'), '*\n');
  await fsp.writeFile(path.join(ws, 'w.txt'), 'w\n');
  await g(ws, ['add', '-f', '.gitignore', 'w.txt']);
  await g(ws, ['commit', '-q', '-m', 'ws root']);

  const nested = await mk('ws/nested');
  await g(base, ['init', '-q', '-b', 'main', nested]);
  await fsp.writeFile(path.join(nested, 'n.txt'), 'n\n');
  await g(nested, ['add', '-A']);
  await g(nested, ['commit', '-q', '-m', 'nested root']);

  const outside = await mk('outside');
  await g(base, ['init', '-q', '-b', 'main', outside]);
  await fsp.writeFile(path.join(outside, 'o.txt'), 'o\n');
  await g(outside, ['add', '-A']);
  await g(outside, ['commit', '-q', '-m', 'outside root']);

  return { base, ws, nested, outside, cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

test.before(async () => { F = await buildFixture(); });
test.after(async () => { if (F) await F.cleanup(); });

// A real runner with gitread's sanitized-base semantics plus a per-call record: the spawn COUNT and
// the per-spawn timeout are half of what "no new spawn" means, and neither is visible from outside.
function makeRecordingRun() {
  const log = [];
  async function run(dir, args, opts) {
    const o = opts || {};
    log.push({ dir, args: args.slice(), env: o.env || null, timeoutMs: o.timeoutMs == null ? null : o.timeoutMs });
    const env = {};
    for (const k of Object.keys(process.env)) if (!k.startsWith('GIT_')) env[k] = process.env[k];
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ASKPASS: '', LC_ALL: 'C' }, o.env || {});
    return new Promise((resolve) => {
      execFile(GIT_BIN, ['-C', dir].concat(args),
        { timeout: o.timeoutMs == null ? 20000 : o.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '', timedOut: false });
          resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, stdout: stdout || '',
            stderr: (stderr || '').trim() || String(err.message), timedOut: err.killed === true });
        });
    });
  }
  return { run, log };
}

const MOUNT_TEXT = '/dev/disk3s1 on / (apfs, sealed, local, read-only, journaled)\n';
const DENY_NO_PRIVATE = PLATFORM_DENY.filter((d) => d !== '/private');   // fixtures live under /private

const jailFactory = (roots) => async (p) => {
  const real = await fsp.realpath(p);
  for (const r of roots) if (real === r || real.startsWith(r + path.sep)) return real;
  throw new Error('outside_root');
};

// `anchoredAt` is the ONE knob that changes provenance: which directory the operator has open.
// Everything else — jail, mounts, deny set, clock — is held equal across the two instances, so a
// difference in the answer can only have come from the door the gate took.
function readAt(anchoredAt, overrides) {
  const rec = makeRecordingRun();
  const oracle = { calls: 0 };
  const o = Object.assign({
    workspaceCwds: async () => [{ label: 't', path: anchoredAt }],
    run: rec.run,
    jail: jailFactory([F.base]),
    assertRepo: async () => { oracle.calls++; throw new Error('no'); },
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  }, overrides || {});
  const lib = (overrides && overrides._lib) || gitread;
  delete o._lib;
  return { gr: lib.createGitRead(o), rec, oracle };
}

// Every verb p8 can generate, with operands the fixture can actually satisfy. `sync` is included:
// it is the one template that is not a `git -C` one-liner, and the one whose generation costs a
// status read — so if a provenance lookup were going to buy a spawn anywhere, it is here.
const VERBS = [
  ['commit', { message: 'a real message' }],
  ['push', {}],
  ['pull', {}],
  ['pull-rebase', {}],
  ['fetch', {}],
  ['checkout', { branch: 'main' }],
  ['merge', { branch: 'main' }],
  ['rebase', { branch: 'main' }],
  ['stash', {}],
  ['discard', { paths: ['n.txt'] }],
  ['clean', {}],
  ['worktree-add', { dir: 'wt', branch: 'newbranch' }],
  ['sync', { message: 'a real message' }],
];

test('PRECONDITION: VERBS covers every template p8 can generate — a verb added later is not silently unmarked', () => {
  assert.deepStrictEqual(VERBS.map((v) => v[0]).sort(), Object.keys(COMMAND_TEMPLATES).sort());
});

// ---- A. the two doors --------------------------------------------------------------------------

test('S1: the anchor-top door reads `workspace`, the containment door reads `browsed` — same repo, same gate', async () => {
  const asBrowsed = readAt(F.ws);          // the operator has ws open; nested is reached by browsing
  const asWorkspace = readAt(F.nested);    // the operator has nested open

  const b = await asBrowsed.gr.status(F.nested);
  const w = await asWorkspace.gr.status(F.nested);
  assert.strictEqual(b.provenance, PROVENANCE_BROWSED, 'containment-only: browsed');
  assert.strictEqual(w.provenance, PROVENANCE_WORKSPACE, 'equality-listed: workspace');
  assert.strictEqual(b.repo, w.repo, 'PRECONDITION: it is the SAME repository through both doors');

  // The anchor itself, through its own door, is workspace — and the sibling outside every anchor
  // is refused rather than classified, which is the shape assertion group C makes precise.
  const anchor = await asBrowsed.gr.status(F.ws);
  assert.strictEqual(anchor.provenance, PROVENANCE_WORKSPACE);
  await assert.rejects(asBrowsed.gr.status(F.outside), (e) => e.status === 403 && e.message === 'unknown_repo');
});

test('S2: the generated text carries the same distinction, on the response that carries the text', async () => {
  const asBrowsed = readAt(F.ws);
  const asWorkspace = readAt(F.nested);
  for (const [v, params] of VERBS) {
    const b = await asBrowsed.gr.command(v, F.nested, params);
    const w = await asWorkspace.gr.command(v, F.nested, params);
    assert.strictEqual(b.provenance, PROVENANCE_BROWSED, `${v}: browsed`);
    assert.strictEqual(w.provenance, PROVENANCE_WORKSPACE, `${v}: workspace`);
  }
});

// ---- B. presentation, never payload ------------------------------------------------------------

test('S3: the command text is BYTE-IDENTICAL across both provenance classes, for every verb', async () => {
  const asBrowsed = readAt(F.ws);
  const asWorkspace = readAt(F.nested);
  for (const [v, params] of VERBS) {
    const b = await asBrowsed.gr.command(v, F.nested, params);
    const w = await asWorkspace.gr.command(v, F.nested, params);
    assert.strictEqual(b.text, w.text, `${v}: the marking must not reach the payload`);
    assert.strictEqual(Buffer.compare(Buffer.from(b.text, 'utf8'), Buffer.from(w.text, 'utf8')), 0,
      `${v}: byte-identical, not merely ===`);
    assert.strictEqual(b.repo, w.repo);
    assert.strictEqual(b.name, w.name);
    assert.ok(b.text.length > 0, `${v}: PRECONDITION — there is text to compare`);
  }
});

test('S4: option (a) stays rejected — no neutraliser is ever injected into the text, in either class', async () => {
  // Byte-identity alone cannot see this: a neutraliser added to BOTH classes is still identical.
  // The measurement that produced the rejection is restated in the assertion — `hooksPath` closes
  // `pre-commit` and none of uploadpack / receivepack / sshCommand / fsmonitor, so a text carrying
  // it would be a false safety signal rather than a fix.
  const banned = [/-c\s+core\.hooksPath/, /--attr-source/, /-c\s+core\.fsmonitor/, /-c\s+core\.attributesFile/];
  for (const anchor of [F.ws, F.nested]) {
    const { gr } = readAt(anchor);
    for (const [v, params] of VERBS) {
      const { text } = await gr.command(v, F.nested, params);
      for (const re of banned) assert.ok(!re.test(text), `${v} @${path.basename(anchor)}: no neutraliser in the text (${text})`);
      for (const n of NEUTRALISERS) {
        assert.ok(text.indexOf(n) === -1, `${v}: gitread's own spawn neutraliser ${n} is not in the operator's text`);
      }
    }
  }
});

// ---- C. not `canWrite` renamed -----------------------------------------------------------------

test('S5: with GIT_WRITES_ENABLED off, a workspace repo still reads as workspace — canWrite false, provenance workspace', async () => {
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.nested }], writesEnabled: true });

  const on = readAt(F.nested, { writesEnabled: true, assertRepo: (p) => panel.assertRepo(p) });
  const stOn = await on.gr.status(F.nested);
  assert.strictEqual(stOn.canWrite, true, 'PRECONDITION: with writes on this repo IS writable');
  assert.strictEqual(stOn.provenance, PROVENANCE_WORKSPACE);

  // The control. Same repo, same anchor, same oracle — only the writes flag moves. canWrite must
  // collapse to false and provenance must NOT: if provenance were canWrite renamed, this reads
  // `browsed`, and the marking would then be wrong on exactly the deployment where writes are off.
  const off = readAt(F.nested, { writesEnabled: false, assertRepo: (p) => panel.assertRepo(p) });
  const stOff = await off.gr.status(F.nested);
  assert.strictEqual(stOff.canWrite, false, 'writes disabled');
  assert.strictEqual(stOff.provenance, PROVENANCE_WORKSPACE, 'and it is STILL a workspace repo');
  assert.notStrictEqual(stOff.canWrite === true, stOff.provenance === PROVENANCE_WORKSPACE,
    'the two fields disagree here — which is the whole point of keeping them separate');

  // Second axis: writes ON but the oracle REFUSING (the workspace closed between enumerations).
  // canWrite is a point-in-time hint and goes false; provenance is a statement about the door the
  // gate took and does not.
  const broken = readAt(F.nested, { writesEnabled: true, assertRepo: async () => { throw new Error('gone'); } });
  const stBroken = await broken.gr.status(F.nested);
  assert.strictEqual(stBroken.canWrite, false, 'a refusing oracle takes the hint away');
  assert.strictEqual(stBroken.provenance, PROVENANCE_WORKSPACE, 'but not the provenance');

  // And the mirror: a browsed repo is `browsed` whether writes are on or off. MEASURED while
  // writing this: the oracle must be given the SAME enumeration gitread is anchored on, because
  // canWrite and provenance are computed from two DIFFERENT enumerations — gitpanel's own fresh
  // `repos()` and gitread's TTL-cached `anchors()`. Point the oracle at a different workspace set
  // and `canWrite` goes true for a repo gitread reached by browsing, with no defect anywhere. In
  // the bridge both are fed `cmuxWorkspaceCwds`, which is what makes them agree in production.
  const wsPanel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.ws }], writesEnabled: true });
  for (const writesEnabled of [true, false]) {
    const b = readAt(F.ws, { writesEnabled, assertRepo: (p) => wsPanel.assertRepo(p) });
    const st = await b.gr.status(F.nested);
    assert.strictEqual(st.canWrite, false, `browsed repo is never writable (writes ${writesEnabled})`);
    assert.strictEqual(st.provenance, PROVENANCE_BROWSED, `browsed repo is browsed (writes ${writesEnabled})`);
  }
});

test('S6: MEASURED — `assertRepo` really does draw the same line, and it is not free', async () => {
  // The decision assumed p7's write oracle already distinguishes what p8 needs. That is checked
  // here rather than believed: for every fixture repo, `assertRepo`'s verdict and gitread's
  // provenance must agree, under the SAME enumeration.
  for (const anchor of [F.ws, F.nested]) {
    const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: anchor }], writesEnabled: true });
    for (const dir of [F.ws, F.nested]) {
      let provenance = null;
      try { provenance = (await readAt(anchor).gr.status(dir)).provenance; } catch (_) { provenance = 'refused'; }
      let oracle = 'no';
      try { await panel.assertRepo(dir); oracle = 'yes'; } catch (_) { oracle = 'no'; }
      if (provenance === 'refused') continue;             // the gate refused: no bit exists to compare
      assert.strictEqual(provenance === PROVENANCE_WORKSPACE, oracle === 'yes',
        `anchor ${path.basename(anchor)} / dir ${path.basename(dir)}: assertRepo and provenance must agree`);
    }
  }

  // AND THE REASON IT IS NOT THE IMPLEMENTATION: `assertRepo` re-enumerates, which is one git spawn
  // PER OPEN WORKSPACE. Measured on the p7 panel itself, through its own injected runner.
  let panelSpawns = 0;
  const counting = createGitPanel({
    workspaceCwds: async () => [{ label: 'a', path: F.ws }, { label: 'b', path: F.nested }],
    writesEnabled: true,
    gitIn: async (dir, args) => {
      panelSpawns++;
      return { ok: true, code: 0, stdout: (dir === F.ws ? F.ws : F.nested) + '\n', stderr: '', timedOut: false };
    },
  });
  await counting.assertRepo(F.ws);
  assert.strictEqual(panelSpawns, 2, 'one `rev-parse --show-toplevel` per open workspace, every call');
});

// ---- D. no new spawn ---------------------------------------------------------------------------

test('S7: provenance costs NO spawn and NO oracle call — the same counts through both doors', async () => {
  const runs = async (anchor, dir, verb, params) => {
    const { gr, rec, oracle } = readAt(anchor);
    await gr.authorizeRead(dir);              // pay discovery first: U15 accounts for anchor spawns
    rec.log.length = 0;
    oracle.calls = 0;
    const out = await gr.command(verb, dir, params);
    return { out, log: rec.log.slice(), oracleCalls: oracle.calls };
  };

  for (const [v, params] of VERBS) {
    const b = await runs(F.ws, F.nested, v, params);
    const w = await runs(F.nested, F.nested, v, params);
    assert.strictEqual(b.log.length, w.log.length,
      `${v}: the two provenance classes cost the same number of spawns (${b.log.length} vs ${w.log.length})`);
    assert.strictEqual(b.oracleCalls, 0, `${v}: browsed generation never consults the write oracle`);
    assert.strictEqual(w.oracleCalls, 0, `${v}: workspace generation never consults the write oracle either`);
    for (const c of b.log.concat(w.log)) {
      assert.strictEqual(c.timeoutMs, 6000, `${v}: every generation spawn still carries timeoutMs 6000`);
    }
    assert.strictEqual(b.out.provenance, PROVENANCE_BROWSED);
    assert.strictEqual(w.out.provenance, PROVENANCE_WORKSPACE);
  }
});

test('S8: the oracle counter is not a dead probe — the status path still calls it, exactly as before', async () => {
  // Without this arm, S7's `oracleCalls === 0` is satisfiable by a seam nothing could ever reach —
  // the U11a trap. Here the SAME injected oracle, on the SAME instance, is shown to fire.
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.nested }], writesEnabled: true });
  let calls = 0;
  const { gr } = readAt(F.nested, { writesEnabled: true, assertRepo: (p) => { calls++; return panel.assertRepo(p); } });
  const st = await gr.status(F.nested);
  assert.strictEqual(calls, 1, 'status derives canWrite through the oracle — the counter is live');
  assert.strictEqual(st.canWrite, true);

  // And the command path, on that very same instance, still spends nothing on it.
  calls = 0;
  await gr.command('fetch', F.nested, {});
  assert.strictEqual(calls, 0, 'generation reads the door the gate took, not a second enumeration');
});

test('S9: the U5 cost rows are unchanged — non-repo 1, on-branch 2, unborn 3, every spawn at 6000', async () => {
  const cost = async (dir) => {
    const { gr, rec } = readAt(F.ws);
    await gr.authorizeRead(F.ws);                       // discovery paid
    rec.log.length = 0;
    await gr.probe(dir);
    const on = rec.log.filter((c) => c.dir === dir);
    for (const c of on) assert.strictEqual(c.timeoutMs, 6000, `${dir}: every spawn at 6000`);
    return on.length;
  };
  const nonRepo = path.join(F.ws, 'plain');
  await fsp.mkdir(nonRepo, { recursive: true });
  const unborn = path.join(F.ws, 'unborn-in');
  await fsp.mkdir(unborn, { recursive: true });
  await g(F.base, ['init', '-q', '-b', 'main', unborn]);

  assert.strictEqual(await cost(nonRepo), 1, 'non-repo: the tuple read and nothing else');
  assert.strictEqual(await cost(F.nested), 2, 'on a branch: tuple + one branch read');
  assert.strictEqual(await cost(unborn), 3, 'unborn: tuple + branch + the positive confirmation');
});

// ---- E. no oracle ------------------------------------------------------------------------------

test('S10: an unauthorized repo carries no provenance — on probe and on every read route', async () => {
  const { gr } = readAt(F.ws);
  const refusals = [];

  // probe: the shared 200 { repo: null }. Asserted on the SERIALISED body — a `provenance: null`
  // is still a field, and `deepStrictEqual` against the literal is what says so.
  for (const dir of [F.outside, F.base, path.join(F.base, 'no-such-dir')]) {
    const body = await gr.probe(dir);
    assert.deepStrictEqual(body, { repo: null }, `probe(${path.basename(dir)}) is the shared shape`);
    refusals.push(body);
  }

  // every other route: the shared 403, and an error carries no body at all.
  for (const call of [
    () => gr.status(F.outside),
    () => gr.branches(F.outside),
    () => gr.worktrees(F.outside),
    () => gr.diff(F.outside, 'o.txt', false),
    () => gr.command('fetch', F.outside, {}),
    () => gr.command('commit', F.outside, { message: 'x' }),
  ]) {
    await assert.rejects(call(), (e) => {
      assert.strictEqual(e.name, 'GitPanelError');
      assert.strictEqual(e.status, 403);
      assert.strictEqual(e.message, 'unknown_repo');
      assert.strictEqual(JSON.stringify({ error: e.code }).indexOf('provenance'), -1);
      return true;
    });
  }

  for (const body of refusals) {
    assert.strictEqual(JSON.stringify(body).indexOf('provenance'), -1, 'not even as a key with a null value');
  }

  // Indistinguishability the other way round: the SUCCESSFUL probe shape gained nothing either, so
  // the bar's display response cannot be read as a provenance channel.
  assert.deepStrictEqual(await gr.probe(F.nested),
    { repo: F.nested, name: 'nested', branch: 'main', state: 'branch' });
});

// ---- F. the marking wording, and the handover declaration --------------------------------------

test('S11: one wording, three copies — server, bar and panel carry BROWSED_TEXT_MARK byte for byte', () => {
  assert.strictEqual(typeof BROWSED_TEXT_MARK, 'string');
  assert.ok(BROWSED_TEXT_MARK.length > 40, 'PRECONDITION: there is a sentence to compare');
  assert.strictEqual(gitbar.BROWSED_TEXT_MARK, BROWSED_TEXT_MARK, 'public/gitbar.js agrees with gitread.js');
  assert.ok(GITJS_SRC.indexOf(BROWSED_TEXT_MARK.replace(/'/g, "\\'")) !== -1
    || GITJS_SRC.indexOf(BROWSED_TEXT_MARK) !== -1, 'public/git.js carries the same sentence');
  // It must say what happens, and claim nothing about safety — the failure mode option (a) was
  // rejected for. `hooksPath` appearing here would mean the marking had become a safety claim.
  assert.ok(/verb/.test(BROWSED_TEXT_MARK) && /hooks/.test(BROWSED_TEXT_MARK), BROWSED_TEXT_MARK);
  assert.ok(!/safe|protected|blocked|disabled/i.test(BROWSED_TEXT_MARK), 'it claims no safety it does not provide');
});

test('S12: the handover declaration names every executor that was measured to run', () => {
  const d = GENERATED_TEXT_RESIDUE;
  assert.strictEqual(typeof d, 'string');
  for (const [what, re] of [
    ['hooks on commit', /hooks on `commit`/],
    ['uploadpack on fetch and pull', /`uploadpack` on `fetch` and `pull`/],
    ['receivepack on push', /`receivepack` on `push`/],
    ['core.sshCommand', /`core\.sshCommand`/],
    ['core.fsmonitor on pull --rebase', /`core\.fsmonitor` on `pull --rebase`/],
    ['the verb/hooks sentence', /shows you the verb; it cannot show you the hooks/],
    ['the text is not neutralised', /does not neutralise/],
    ['what is done instead', /marked as such/],
  ]) assert.ok(re.test(d), `the declaration must state: ${what}\n---\n${d}\n---`);
  // The residue is a statement about a thing p8 does NOT close. A declaration that reads as a fix
  // is the same false signal option (a) was rejected for.
  assert.ok(!/hooksPath/.test(d), 'the declaration does not offer the rejected neutraliser as a remedy');
});

// ---- G. the bar: the marking at the point the operator reads the text ---------------------------

// A model harness small enough to state its own seams: the network is a table keyed by route, and
// every observable — the filled text, the note, the leave — is a list this test owns.
function bar(commandBody, lib) {
  const L = lib || gitbar;
  const fills = [], notes = [], leaves = [];
  const probeBody = { repo: '/w/alpha', name: 'alpha', branch: 'main', state: 'branch' };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const model = L.createGitBarModel({
    jget: async () => res(200, probeBody),
    jpost: async () => res(200, commandBody),
    machine: 'm1',
    nowMs: () => 1000,
    fillComposer: (t) => { fills.push(t); return { ok: true, kind: 'shell' }; },
    leaveFiles: () => { leaves.push(1); },
    openPanel: () => {},
    note: (t) => { notes.push(t); },
  });
  return { model, fills, notes, leaves };
}

const TEXT = "git -C '/w/alpha' fetch --all --prune";
const cmdBody = (provenance) => {
  const b = { text: TEXT, repo: '/w/alpha', name: 'alpha' };
  if (provenance !== undefined) b.provenance = provenance;
  return b;
};

test('S13: the bar marks a browsed fill and leaves a workspace fill unmarked — and never touches the text', async () => {
  const browsed = bar(cmdBody('browsed'));
  await browsed.model.at('/w/alpha/sub');
  await browsed.model.tapPull();
  assert.deepStrictEqual(browsed.fills, [TEXT], 'the payload reaches the composer untouched');
  assert.ok(browsed.notes.indexOf(BROWSED_TEXT_MARK) !== -1, `the marking is emitted: ${JSON.stringify(browsed.notes)}`);
  assert.strictEqual(browsed.model.current().note, BROWSED_TEXT_MARK, 'and it rides the published state too');
  assert.strictEqual(browsed.leaves.length, 1, 'the fill still completes — a warning is not a refusal');

  const workspace = bar(cmdBody('workspace'));
  await workspace.model.at('/w/alpha/sub');
  await workspace.model.tapPull();
  assert.deepStrictEqual(workspace.fills, [TEXT], 'byte-identical to the browsed fill');
  assert.deepStrictEqual(workspace.notes, [], 'a workspace repo is unmarked');
  assert.strictEqual(workspace.model.current().note, null);

  assert.strictEqual(browsed.fills[0], workspace.fills[0], 'ONE text, two markings');
});

test('S14: the marking is fail-closed — anything that is not exactly `workspace` marks', async () => {
  for (const p of [undefined, null, 'browsed', 'Workspace', 'WORKSPACE', '', 'workspaces', 0, false, {}]) {
    const h = bar(cmdBody(p));
    await h.model.at('/w/alpha/sub');
    await h.model.tapPull();
    assert.ok(h.notes.indexOf(BROWSED_TEXT_MARK) !== -1,
      `provenance ${JSON.stringify(p)} must mark: ${JSON.stringify(h.notes)}`);
    assert.deepStrictEqual(h.fills, [TEXT], `provenance ${JSON.stringify(p)}: the text is still untouched`);
  }
  // Non-vacuous: the exact string, and only it, withholds the mark.
  const clean = bar(cmdBody('workspace'));
  await clean.model.at('/w/alpha/sub');
  await clean.model.tapPull();
  assert.deepStrictEqual(clean.notes, []);
});

test('S15: the source carries no markup sink and no second wording — the marking is textContent only', () => {
  // gitbar's standing rendering rule (§ "RENDERING SAFETY"): every dynamic string reaches the DOM
  // through textContent. The marking is a new string on that path, so the rule is re-asserted here
  // over the source rather than assumed to still hold.
  assert.strictEqual(GITBAR_SRC.indexOf('innerHTML'), -1, 'public/gitbar.js has no markup-parsing sink');
  assert.strictEqual((GITBAR_SRC.match(/browsed repo — running this text/g) || []).length, 1,
    'exactly one copy of the wording in gitbar.js');
  assert.strictEqual((GITJS_SRC.match(/browsed repo — running this text/g) || []).length, 1,
    'exactly one copy of the wording in git.js');
  assert.ok(/provenance !== 'workspace'/.test(GITJS_SRC),
    'git.js gates on the exact string, fail-closed — truthiness would swallow ABSENT the wrong way');
});

// ---- H. negative controls ----------------------------------------------------------------------
// Each is its own test, so a control that stops biting names itself instead of hiding behind
// whichever one aborted the run first.

const CONTROLS = [];
const control = (label, run) => CONTROLS.push([label, run]);

// --- the server's two doors ---

control('the equality door mismarked as browsed', async () => {
  const lib = loadGitread([["t.provenance = PROVENANCE_WORKSPACE;", "t.provenance = PROVENANCE_BROWSED;"]]);
  const st = await readAt(F.nested, { _lib: lib }).gr.status(F.nested);
  assert.strictEqual(st.provenance, PROVENANCE_WORKSPACE);
});

control('the containment door mismarked as workspace', async () => {
  const lib = loadGitread([["t.provenance = PROVENANCE_BROWSED;", "t.provenance = PROVENANCE_WORKSPACE;"]]);
  const st = await readAt(F.ws, { _lib: lib }).gr.status(F.nested);
  assert.strictEqual(st.provenance, PROVENANCE_BROWSED);
});

control('both doors collapsed to one constant', async () => {
  const lib = loadGitread([["const PROVENANCE_BROWSED = 'browsed';", "const PROVENANCE_BROWSED = 'workspace';"]]);
  const b = await readAt(F.ws, { _lib: lib }).gr.status(F.nested);
  const w = await readAt(F.nested, { _lib: lib }).gr.status(F.nested);
  assert.notStrictEqual(b.provenance, w.provenance, 'the two doors must still be distinguishable');
});

control('status drops the field entirely', async () => {
  const lib = loadGitread([['      provenance: t.provenance,\n', '']]);
  const st = await readAt(F.ws, { _lib: lib }).gr.status(F.nested);
  assert.strictEqual(st.provenance, PROVENANCE_BROWSED);
});

control('command drops the field entirely', async () => {
  const lib = loadGitread([['text: tpl(t.top, operands), repo: t.top, name: path.basename(t.top), provenance: t.provenance,',
    'text: tpl(t.top, operands), repo: t.top, name: path.basename(t.top),']]);
  const out = await readAt(F.ws, { _lib: lib }).gr.command('fetch', F.nested, {});
  assert.strictEqual(out.provenance, PROVENANCE_BROWSED);
});

// --- provenance IS canWrite renamed (constraint 2) ---

control('provenance derived from canWrite instead of from the door', async () => {
  const lib = loadGitread([['      provenance: t.provenance,',
    "      provenance: (await canWriteFor(t.top)) ? PROVENANCE_WORKSPACE : PROVENANCE_BROWSED,"]]);
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.nested }], writesEnabled: true });
  const off = readAt(F.nested, { _lib: lib, writesEnabled: false, assertRepo: (p) => panel.assertRepo(p) });
  const st = await off.gr.status(F.nested);
  assert.strictEqual(st.canWrite, false, 'PRECONDITION: writes are off');
  assert.strictEqual(st.provenance, PROVENANCE_WORKSPACE, 'a workspace repo reads as workspace with writes off');
});

control('provenance derived from the writes flag alone', async () => {
  const lib = loadGitread([['      provenance: t.provenance,',
    '      provenance: writesEnabled ? PROVENANCE_WORKSPACE : PROVENANCE_BROWSED,']]);
  const off = readAt(F.nested, { _lib: lib, writesEnabled: false });
  assert.strictEqual((await off.gr.status(F.nested)).provenance, PROVENANCE_WORKSPACE);
});

// --- the cost rows (no new spawn) ---

control('provenance re-derived through assertRepo on the command path', async () => {
  const lib = loadGitread([['text: tpl(t.top, operands), repo: t.top, name: path.basename(t.top), provenance: t.provenance,',
    'text: tpl(t.top, operands), repo: t.top, name: path.basename(t.top),'
    + " provenance: await assertRepo(t.top).then(() => PROVENANCE_WORKSPACE, () => PROVENANCE_BROWSED),"]]);
  const h = readAt(F.nested, { _lib: lib, assertRepo: async () => { h.oracle.calls++; } });
  await h.gr.authorizeRead(F.nested);
  h.oracle.calls = 0;
  await h.gr.command('fetch', F.nested, {});
  assert.strictEqual(h.oracle.calls, 0, 'generation must not consult the write oracle');
});

control('a provenance lookup that buys a spawn', async () => {
  const lib = loadGitread([['    const t = await authorizeRead(dir);              // FIRST — no verb is answered off-scope',
    '    const t = await authorizeRead(dir);\n'
    + '    await withSlot(() => spawnGit(t.top, [\'rev-parse\', \'--show-toplevel\'], '
    + '{ timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) }));']]);
  const h = readAt(F.ws, { _lib: lib });
  await h.gr.authorizeRead(F.nested);
  h.rec.log.length = 0;
  await h.gr.command('fetch', F.nested, {});
  const w = readAt(F.nested);
  await w.gr.authorizeRead(F.nested);
  w.rec.log.length = 0;
  await w.gr.command('fetch', F.nested, {});
  assert.strictEqual(h.rec.log.length, w.rec.log.length, 'generation must cost what it cost before');
});

// --- presentation, never payload ---

control('the marking injected into the text for browsed repos', async () => {
  const lib = loadGitread([['      text: tpl(t.top, operands), repo: t.top,',
    "      text: (t.provenance === PROVENANCE_BROWSED ? '# browsed repo\\n' : '') + tpl(t.top, operands), repo: t.top,"]]);
  const b = await readAt(F.ws, { _lib: lib }).gr.command('fetch', F.nested, {});
  const w = await readAt(F.nested, { _lib: lib }).gr.command('fetch', F.nested, {});
  assert.strictEqual(b.text, w.text, 'the marking must not reach the payload');
});

control('option (a) shipped after all — a visible hooksPath in every template', async () => {
  const lib = loadGitread([['const at = (repo, cmd) => `git -C ${shellQuote(repo)} ${cmd}`;',
    'const at = (repo, cmd) => `git -c core.hooksPath=/dev/null -C ${shellQuote(repo)} ${cmd}`;']]);
  const { text } = await readAt(F.ws, { _lib: lib }).gr.command('fetch', F.nested, {});
  assert.ok(!/-c\s+core\.hooksPath/.test(text), `no neutraliser in the operator's text: ${text}`);
});

// --- no oracle ---

control('the probe refusal grown a provenance field', async () => {
  const lib = loadGitread([['      try { t = await authorizeRead(dir); } catch (_) { return { repo: null }; }',
    "      try { t = await authorizeRead(dir); } catch (_) { return { repo: null, provenance: null }; }"]]);
  const body = await readAt(F.ws, { _lib: lib }).gr.probe(F.outside);
  assert.deepStrictEqual(body, { repo: null }, 'the shared refusal shape is unchanged');
});

control('the successful probe grown a provenance field', async () => {
  const lib = loadGitread([["        return { repo: t.top, name, branch: ref, state: 'branch' };",
    "        return { repo: t.top, name, branch: ref, state: 'branch', provenance: t.provenance };"]]);
  assert.deepStrictEqual(await readAt(F.ws, { _lib: lib }).gr.probe(F.nested),
    { repo: F.nested, name: 'nested', branch: 'main', state: 'branch' });
});

control('command answering a refusal with a body instead of rejecting', async () => {
  const lib = loadGitread([['    const t = await authorizeRead(dir);              // FIRST — no verb is answered off-scope',
    "    let t; try { t = await authorizeRead(dir); } catch (e) { return { repo: null, provenance: PROVENANCE_BROWSED }; }"]]);
  await assert.rejects(readAt(F.ws, { _lib: lib }).gr.command('fetch', F.outside, {}),
    (e) => e.status === 403 && e.message === 'unknown_repo');
});

// --- the declaration ---

control('the declaration missing an executor it was measured to need', async () => {
  const lib = loadGitread([["'`core.sshCommand` on an ssh remote, and `core.fsmonitor` on `pull --rebase`. Reviewing the text',",
    "'`core.sshCommand` on an ssh remote. Reviewing the text',"]]);
  assert.ok(/`core\.fsmonitor` on `pull --rebase`/.test(lib.GENERATED_TEXT_RESIDUE),
    'the declaration must state every executor');
});

control('the wordings drifted apart between server and bar', async () => {
  const lib = loadGitbar([["const BROWSED_TEXT_MARK =\n    'browsed repo — running this text runs",
    "const BROWSED_TEXT_MARK =\n    'BROWSED repo — running this text runs"]]);
  assert.strictEqual(lib.BROWSED_TEXT_MARK, BROWSED_TEXT_MARK, 'one wording, not two');
});

// --- the bar ---

control('the bar never marks', async () => {
  const lib = loadGitbar([['setNote(marksAsBrowsed(body) ? BROWSED_TEXT_MARK : null);', 'setNote(null);']]);
  const h = bar(cmdBody('browsed'), lib);
  await h.model.at('/w/alpha/sub');
  await h.model.tapPull();
  assert.ok(h.notes.indexOf(BROWSED_TEXT_MARK) !== -1, 'a browsed fill must be marked');
});

control('the bar marks everything, workspace included', async () => {
  const lib = loadGitbar([["return !body || body.provenance !== 'workspace';", 'return true;']]);
  const h = bar(cmdBody('workspace'), lib);
  await h.model.at('/w/alpha/sub');
  await h.model.tapPull();
  assert.deepStrictEqual(h.notes, [], 'a workspace fill must be unmarked');
});

control('the marking made fail-OPEN — an absent field goes unmarked', async () => {
  const lib = loadGitbar([["return !body || body.provenance !== 'workspace';", "return !!body && body.provenance === 'browsed';"]]);
  const h = bar(cmdBody(undefined), lib);
  await h.model.at('/w/alpha/sub');
  await h.model.tapPull();
  assert.ok(h.notes.indexOf(BROWSED_TEXT_MARK) !== -1, 'an unknown provenance must still mark');
});

control('the bar appending the marking to the filled text', async () => {
  const lib = loadGitbar([['const res = fillComposer ? fillComposer(body.text) : { ok: false, reason: \'no composer\' };',
    "const res = fillComposer ? fillComposer(body.text + ' # browsed repo') : { ok: false, reason: 'no composer' };"]]);
  const h = bar(cmdBody('browsed'), lib);
  await h.model.at('/w/alpha/sub');
  await h.model.tapPull();
  assert.deepStrictEqual(h.fills, [TEXT], 'the composer gets the payload untouched');
});

control('the marking emitted BEFORE the fill, where the fill\'s own status line overwrites it', async () => {
  // Ordering is load-bearing and invisible to a "was it emitted" oracle: `fillComposer` writes to
  // the same status line, so a mark emitted first is a mark the operator never sees.
  const lib = loadGitbar([['      syncOpen = false;\n', '      setNote(marksAsBrowsed(body) ? BROWSED_TEXT_MARK : null);\n      syncOpen = false;\n']]);
  const order = [];
  const L = lib;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const model = L.createGitBarModel({
    jget: async () => res(200, { repo: '/w/alpha', name: 'alpha', branch: 'main', state: 'branch' }),
    jpost: async () => res(200, cmdBody('browsed')),
    machine: 'm1',
    nowMs: () => 1000,
    fillComposer: () => { order.push('fill'); return { ok: true, kind: 'shell' }; },
    leaveFiles: () => {},
    openPanel: () => {},
    note: (t) => { if (t === BROWSED_TEXT_MARK) order.push('mark'); },
  });
  await model.at('/w/alpha/sub');
  await model.tapPull();
  assert.deepStrictEqual(order, ['fill', 'mark'], 'the marking is written AFTER the fill writes its own line');
});

for (const [label, run] of CONTROLS) {
  test('negative control: ' + label, async () => {
    let threw = null;
    try { await run(); } catch (e) { threw = e; }
    assert.ok(threw, 'NEGATIVE CONTROL DID NOT BITE: ' + label);
  });
}
