'use strict';
// S-005 — mod-deploy. Every acceptance bullet in story_list.json has at least one test here, and
// the two that have actually cost real time (empty-reads-as-in-sync, force-push-reads-as-violation)
// have several, from both the module side and the derive side.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const {
  collectDeploy, normalizeEnvConfig, probeVercel, probeSshDocker,
  computeAncestry, shaReachable, describeMeta, _resetMetaLog, REVISION_LABEL,
} = require('../radar/mod-deploy');
const { derive } = require('../radar/derive');
const { buildDeployFixture, gitFragment, fetchStub, vercelBody, readyDeployment, vercelBranchAwareStub } = require('./helpers/deploy-fixture');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const OBSERVED = new Date(NOW).toISOString();

let fx = null;
before(async () => { fx = await buildDeployFixture(); });
after(async () => { if (fx) await fx.cleanup(); });

const vercelEnv = (o) => Object.assign({
  kind: 'vercel', vercelTeamId: 'team_x', projectId: 'prj_x', target: 'production', tokenRef: 'VT',
}, o);

// Runs the whole module against the fixture repo with a stubbed Vercel.
function run(opts) {
  const o = opts || {};
  return collectDeploy({
    now: NOW,
    config: {
      timeouts: { deployMs: 5000 },
      repos: [{ id: 'app', path: fx.repo, defaultBranches: ['develop', 'main'], deploy: o.deploy || { dev: vercelEnv() } }],
    },
    fragments: { git: gitFragment(fx) },
    env: o.env || { VT: 'tok' },
    fetchImpl: o.fetchImpl || fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha } })]) } }),
    sshExec: o.sshExec,
  });
}

// ---- config: canonical key names (§M1) --------------------------------------------------------------

test('config uses the §M1 canonical keys exactly — no aliases are accepted', () => {
  const ok = normalizeEnvConfig(vercelEnv(), 'app', 'dev');
  assert.strictEqual(ok.error, undefined);
  assert.deepStrictEqual(
    { t: ok.cfg.vercelTeamId, p: ok.cfg.projectId, g: ok.cfg.target, r: ok.cfg.tokenRef },
    { t: 'team_x', p: 'prj_x', g: 'production', r: 'VT' },
  );

  // The near-miss names people reach for. Each must be rejected, not silently coerced: probing the
  // wrong project and reporting parity against it is the worst possible failure mode.
  const teamOnly = normalizeEnvConfig({ kind: 'vercel', teamId: 'team_x', project: 'prj_x', tokenRef: 'VT' }, 'app', 'dev');
  assert.match(teamOnly.error, /missing projectId/);
  const noToken = normalizeEnvConfig({ kind: 'vercel', vercelTeamId: 't', projectId: 'p', token: 'secret-value' }, 'app', 'dev');
  assert.match(noToken.error, /missing tokenRef/);
  assert.match(normalizeEnvConfig({ kind: 'netlify' }, 'app', 'dev').error, /unknown deploy kind/);

  // `gitBranch` extends the canonical set — optional, and absent means null (unfiltered), never a
  // defaulted branch name. Its own near-misses are ignored like every other unknown key.
  assert.strictEqual(ok.cfg.gitBranch, null, 'omitted is null, not "develop"');
  assert.strictEqual(normalizeEnvConfig(vercelEnv({ gitBranch: '  develop  ' }), 'app', 'dev').cfg.gitBranch, 'develop');
  assert.strictEqual(normalizeEnvConfig(vercelEnv({ gitBranch: '' }), 'app', 'dev').cfg.gitBranch, null, 'blank is absent');
  assert.strictEqual(normalizeEnvConfig(vercelEnv({ branch: 'develop', ref: 'develop' }), 'app', 'dev').cfg.gitBranch, null, 'no aliases');
});

test('a secret VALUE in the config is never a credential — only tokenRef, the env var NAME, is', async () => {
  // tokenRef names an env var. With the var unset the probe is `unauthorized` and the error names
  // the VARIABLE, never a value.
  const r = await probeVercel(normalizeEnvConfig(vercelEnv({ tokenRef: 'VERCEL_TOKEN_MAIN' }), 'app', 'dev').cfg, { env: {}, timeoutMs: 100 });
  assert.strictEqual(r.status, 'unauthorized');
  assert.strictEqual(r.error, 'env VERCEL_TOKEN_MAIN is unset');
  assert.strictEqual(r.sha, null);
});

test('ssh-docker identifiers are validated, not escaped — an injection attempt is a config error', () => {
  assert.strictEqual(normalizeEnvConfig({ kind: 'ssh-docker', host: 'h', container: 'c' }, 'a', 'dev').cfg.container, 'c');
  assert.match(normalizeEnvConfig({ kind: 'ssh-docker', host: 'h; rm -rf /', container: 'c' }, 'a', 'dev').error, /host is not a plain hostname/);
  assert.match(normalizeEnvConfig({ kind: 'ssh-docker', host: 'h', container: 'c && curl evil' }, 'a', 'dev').error, /container is not a plain identifier/);
});

// ---- the four outcomes ---------------------------------------------------------------------------

test('four outcomes are distinct in state: ok | empty | unauthorized | stale', async () => {
  const cases = {
    ok: { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha } })]) } }) },
    empty: { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([]) } }) },
    unauthorized: { fetchImpl: fetchStub({ '/v6/deployments': { status: 403, body: { error: { message: 'Not authorized' } } } }) },
    stale: { fetchImpl: fetchStub({ '/v6/deployments': new Error('socket hang up') }) },
  };
  const seen = {};
  for (const name of Object.keys(cases)) {
    const r = await run(cases[name]);
    seen[name] = r.fragment.repos.app.dev.status;
  }
  assert.deepStrictEqual(seen, { ok: 'ok', empty: 'empty', unauthorized: 'unauthorized', stale: 'stale' });
});

test('empty NEVER renders as in-sync — no sha, no ancestry, and no path to a done ladder cell', async () => {
  const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([]) } }) });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'empty');
  assert.strictEqual(dev.sha, null);
  assert.strictEqual(dev.behindDevelop, null, 'no sha => no behind count to compare against');
  assert.deepStrictEqual(dev.epicBranchAncestry, {});
  assert.strictEqual(dev.ruleViolation, false, 'an absence is never a violation');

  // And the same fact from the consumer side: derive must not produce `done` from `empty`.
  const state = deriveWith(r.fragment, 'ok');
  const proj1 = state.epics.find((e) => e.key === 'PROJ-1');
  assert.notStrictEqual(proj1.ladder.deployedDev, 'done');
  assert.strictEqual(proj1.ladder.deployedDev, 'unknown');
});

test('a wrong teamId is the empty case — 200 with no deployments, which is unknown, not parity', async () => {
  const stub = fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([]) } });
  const r = await run({ deploy: { dev: vercelEnv({ vercelTeamId: 'team_WRONG' }) }, fetchImpl: stub });
  assert.strictEqual(r.fragment.repos.app.dev.status, 'empty');
  assert.match(r.fragment.repos.app.dev.note, /no READY production deployment/);
  assert.ok(stub.calls[0].includes('teamId=team_WRONG'), 'the team scope is actually sent');
});

test('vercel 429 and 5xx are stale, not unauthorized — a retry is the fix, not a credential', async () => {
  for (const status of [429, 500, 503]) {
    const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status, body: { error: { message: 'boom' } } } }) });
    assert.strictEqual(r.fragment.repos.app.dev.status, 'stale', `HTTP ${status}`);
  }
  const auth = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status: 401, body: {} } }) });
  assert.strictEqual(auth.fragment.repos.app.dev.status, 'unauthorized');
});

// ---- the sha ------------------------------------------------------------------------------------

test('SHA comes from meta.githubCommitSha', async () => {
  const r = await run();
  assert.strictEqual(r.fragment.repos.app.dev.sha, fx.deployedSha);
});

test('an undefined githubCommitSha logs the raw meta ONCE and never guesses another field', async () => {
  _resetMetaLog();
  const meta = { gitCommitSha: fx.deployedSha, githubCommitRef: 'develop', githubCommitAuthorLogin: 'example-org' };
  const impl = { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta })]) } }) };

  const first = await run(impl);
  const dev = first.fragment.repos.app.dev;
  assert.strictEqual(dev.sha, null, 'never guessed from the lookalike field');
  assert.strictEqual(dev.shaMissing, true);
  assert.strictEqual(dev.ruleViolation, false);
  assert.strictEqual(dev.ruleCheck, 'unknown');

  const logs = first.warnings.filter((w) => w.includes('raw meta'));
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /keys\[gitCommitSha,githubCommitRef,githubCommitAuthorLogin\]/, 'names every field so the fix is one line');
  assert.match(logs[0], /gitCommitSha=/, 'and shows the candidate values');

  const second = await run(impl);
  assert.strictEqual(second.warnings.filter((w) => w.includes('raw meta')).length, 0, 'logged once, not every scan');
});

test('describeMeta names every key but does not reproduce commit messages or author emails', () => {
  const d = describeMeta({ githubCommitSha: 'abc123', githubCommitMessage: 'fix the thing\n\nlong body', githubCommitAuthorEmail: 'someone@example.com' });
  assert.match(d, /keys\[githubCommitSha,githubCommitMessage,githubCommitAuthorEmail\]/);
  assert.match(d, /githubCommitSha=abc123/);
  assert.ok(!d.includes('long body'));
  assert.ok(!d.includes('someone@example.com'));
});

// ---- ancestry ------------------------------------------------------------------------------------

test('rule check: a deployed sha that is an ancestor of origin/develop is not a violation', async () => {
  const r = await run();
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.shaKnownLocally, true);
  assert.strictEqual(dev.ruleCheck, 'ok');
  assert.strictEqual(dev.ruleViolation, false);
  assert.strictEqual(dev.compareRef, 'origin/develop');
  assert.strictEqual(dev.behindDevelop, 3, 'three commits landed on develop after the deploy');
});

test('rule check: a deployed sha that is NOT an ancestor of the target branch IS a violation', async () => {
  const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.offDevelopSha } })]) } }) });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.shaKnownLocally, true, 'main reaches it, so the question is answerable');
  assert.strictEqual(dev.ruleCheck, 'violation');
  assert.strictEqual(dev.ruleViolation, true);
});

test('FORCE-PUSH: a deployed sha no ref can reach is unknown, NEVER a violation', async () => {
  const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.forcePushedSha } })]) } }) });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'ok', 'the probe itself succeeded');
  assert.strictEqual(dev.sha, fx.forcePushedSha);
  assert.strictEqual(dev.shaKnownLocally, false);
  assert.strictEqual(dev.ruleCheck, 'unknown');
  assert.strictEqual(dev.ruleViolation, false);
  assert.strictEqual(dev.behindDevelop, null);
  assert.deepStrictEqual(dev.epicBranchAncestry, {}, 'no ancestry answers at all, rather than false ones');
});

test('the force-pushed commit still EXISTS locally — which is why reachability, not existence, is the test', async () => {
  const { gitIn } = require('../lib/gitcmd');
  const exists = await gitIn(fx.repo, ['cat-file', '-e', `${fx.forcePushedSha}^{commit}`], { timeoutMs: 10000 });
  assert.strictEqual(exists.ok, true, 'a dangling object: cat-file -e would have said yes');
  assert.strictEqual(await shaReachable(fx.repo, fx.forcePushedSha, 10000), false, 'but no ref reaches it');
});

test('SQUASH-MERGE: a squash commit our clone never received is unknown, NEVER a violation', async () => {
  const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.squashedSha } })]) } }) });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.shaKnownLocally, false);
  assert.strictEqual(dev.ruleViolation, false);
  assert.strictEqual(dev.ruleCheck, 'unknown');
});

test('a sha that never existed anywhere is unknown, not a violation', async () => {
  assert.strictEqual(await shaReachable(fx.repo, fx.absentSha, 10000), false);
  const a = await computeAncestry({ repoPath: fx.repo, deployedSha: fx.absentSha, compareRef: 'origin/develop', epicBranches: [], timeoutMs: 10000 });
  assert.strictEqual(a.ruleViolation, false);
  assert.strictEqual(a.ruleCheck, 'unknown');
  assert.match(a.note, /not reachable from any local ref/);
});

test('epic-deployed is BRANCH-TIP ancestry — merge-base --is-ancestor <branchTip> <deployedSha>', async () => {
  const r = await run();
  const anc = r.fragment.repos.app.dev.epicBranchAncestry;
  assert.strictEqual(anc['feature/PROJ-1-web'], true, 'merged before the deploy => its tip is an ancestor');
  assert.strictEqual(anc['feature/PROJ-2-open'], false, 'never merged => not deployed');
  assert.strictEqual(anc['feature/PROJ-3-later'], false, 'branched after the deploy => not deployed');
  assert.ok(!('develop' in anc) && !('main' in anc), 'default branches are not epic branches');
});

test('there is no epicMergeCommit concept in the CODE — only in the comment saying it was deleted', () => {
  const src = require('fs').readFileSync(require.resolve('../radar/mod-deploy'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/epicMergeCommit/.test(code), 'deleted in spec review as underivable');
  assert.ok(/epicMergeCommit/.test(src), 'and the comment saying so is still there, so nobody re-adds it');
});

// ---- probe failures are badges, never attention -------------------------------------------------------

test('probe failure degrades to a stale source badge and produces ZERO attention items', async () => {
  const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': new Error('ETIMEDOUT') }) });
  assert.strictEqual(r.source.status, 'error', 'the only configured probe failed');
  assert.match(r.source.error, /deploy probes degraded/);
  assert.strictEqual(r.fragment.repos.app.dev.ruleViolation, false);

  const state = deriveWith(r.fragment, 'stale');
  assert.deepStrictEqual(state.attention.filter((a) => a.type === 'rule-violation'), [], 'a failed probe raises nothing');
});

test('unauthorized degrades the source and raises no attention item either', async () => {
  const r = await run({ env: {} });
  assert.strictEqual(r.fragment.repos.app.dev.status, 'unauthorized');
  const state = deriveWith(r.fragment, 'error');
  assert.deepStrictEqual(state.attention.filter((a) => a.type === 'rule-violation'), []);
});

test('one degraded probe out of several is `stale`, all of them is `error`, none is `ok`', async () => {
  const both = { dev: vercelEnv(), prod: vercelEnv({ target: 'production', projectId: 'prj_prod' }) };
  const good = { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha } })]) };

  const allOk = await run({ deploy: both, fetchImpl: fetchStub({ '/v6/deployments': good }) });
  assert.strictEqual(allOk.source.status, 'ok');

  const half = await run({
    deploy: both,
    fetchImpl: fetchStub({ 'projectId=prj_prod': { status: 403, body: {} }, '/v6/deployments': good }),
  });
  assert.strictEqual(half.source.status, 'stale');
  assert.strictEqual(half.fragment.repos.app.dev.status, 'ok');
  assert.strictEqual(half.fragment.repos.app.prod.status, 'unauthorized');
});

test('`empty` does NOT degrade the source — it is a successful probe reporting an absence', async () => {
  const r = await run({ fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([]) } }) });
  assert.strictEqual(r.source.status, 'ok');
  assert.strictEqual(r.fragment.repos.app.dev.status, 'empty');
});

// ---- the author gate ---------------------------------------------------------------------------------

test('author gate: a large behind-count next to a recent READY deploy is the DETECTOR, not a violation', async () => {
  // The app-web shape: deploys only happen for `example-org`-authored commits, so operator-authored work
  // piles up on develop while Vercel keeps reporting a healthy READY deployment.
  const r = await run({
    fetchImpl: fetchStub({
      '/v6/deployments': {
        status: 200,
        body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha, githubCommitAuthorLogin: 'example-org' } })]),
      },
    }),
  });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.behindDevelop, 3);
  assert.strictEqual(dev.ruleViolation, false, 'behind-count NEVER implies a violation');
  assert.strictEqual(dev.author, 'example-org');
  assert.strictEqual(dev.note, 'behind ×3 · last deploy by example-org');
});

// ---- the branch dimension (one project, two envs, split by branch) -----------------------------------
//
// The shape this covers: a repo ships dev and prod from the SAME Vercel project, split by branch:
//   main    -> target=production -> app.example.com
//   develop -> target=preview    -> app-dev.example.com
// and every feature branch ALSO builds into that same `preview` target. In practice a large minority
// of the recent READY previews are feature branches, and the newest one is regularly not `develop`.

// The app-web preview target: a feature branch built more recently than develop did.
const appWebPreviews = () => [
  readyDeployment({
    uid: 'dpl_feature', created: Date.parse('2026-07-30T11:00:00.000Z'),
    meta: { githubCommitSha: fx.proj2Tip, githubCommitRef: 'feature/PROJ-2-open', githubCommitAuthorLogin: 'example-org' },
  }),
  readyDeployment({
    uid: 'dpl_develop', created: Date.parse('2026-07-30T09:00:00.000Z'),
    meta: { githubCommitSha: fx.deployedSha, githubCommitRef: 'develop', githubCommitAuthorLogin: 'example-org' },
  }),
];

test('gitBranch appends meta-githubCommitRef; omitting it sends no branch filter at all', async () => {
  const withFilter = vercelBranchAwareStub(appWebPreviews());
  await run({ deploy: { dev: vercelEnv({ target: 'preview', gitBranch: 'develop' }) }, fetchImpl: withFilter });
  assert.ok(withFilter.calls[0].includes('meta-githubCommitRef=develop'), 'the branch is actually sent');

  const without = vercelBranchAwareStub(appWebPreviews());
  await run({ deploy: { dev: vercelEnv({ target: 'preview' }) }, fetchImpl: without });
  assert.ok(!without.calls[0].includes('meta-githubCommitRef'), 'absent means UNFILTERED, never a defaulted develop');

  // And a slash-bearing branch name survives the wire.
  const slash = vercelBranchAwareStub(appWebPreviews());
  await run({ deploy: { dev: vercelEnv({ target: 'preview', gitBranch: 'feature/PROJ-2-open' }) }, fetchImpl: slash });
  assert.ok(slash.calls[0].includes('meta-githubCommitRef=feature%2FPROJ-2-open'), 'url-encoded, not mangled');
});

test('gitBranch reproduces the app-web develop↔dev gap: right sha, right behind-count, no violation', async () => {
  const r = await run({
    deploy: { dev: vercelEnv({ target: 'preview', gitBranch: 'develop' }) },
    fetchImpl: vercelBranchAwareStub(appWebPreviews()),
  });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.sha, fx.deployedSha, 'the develop deployment, not the newer feature-branch one');
  assert.strictEqual(dev.ref, 'develop');
  assert.strictEqual(dev.branchFilter, 'develop');
  assert.strictEqual(dev.branchMismatch, false);
  assert.strictEqual(dev.ruleCheck, 'ok');
  assert.strictEqual(dev.ruleViolation, false);
  assert.strictEqual(dev.behindDevelop, 3, 'THE GAP: develop has moved 3 commits past what dev is running');
  assert.strictEqual(dev.note, 'behind ×3 · last deploy by example-org');
});

test('WITHOUT the filter the unfiltered preview answer would be a FABRICATED violation — the guard stops it', async () => {
  // First, prove the trap is real: the feature-branch tip an unfiltered query returns genuinely is
  // NOT an ancestor of origin/develop, so ancestry on it produces a rule violation.
  const naive = await computeAncestry({
    repoPath: fx.repo, deployedSha: fx.proj2Tip, compareRef: 'origin/develop', epicBranches: [], timeoutMs: 10000,
  });
  assert.strictEqual(naive.ruleViolation, true, 'a feature-branch tip IS a violation if you believe it is what dev runs');

  // Now the module, on the same data, with no gitBranch: it reports the deployment AND its branch,
  // and refuses every derived judgement rather than raising that violation.
  const r = await run({
    deploy: { dev: vercelEnv({ target: 'preview' }) },
    fetchImpl: vercelBranchAwareStub(appWebPreviews()),
  });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.sha, fx.proj2Tip, 'the deployment is reported…');
  assert.strictEqual(dev.ref, 'feature/PROJ-2-open', '…carrying the branch that makes the mismatch visible');
  assert.strictEqual(dev.branchMismatch, true);
  assert.strictEqual(dev.branchFilter, null);
  assert.strictEqual(dev.ruleViolation, false, 'ZERO false violations');
  assert.strictEqual(dev.ruleCheck, 'unknown');
  assert.strictEqual(dev.shaKnownLocally, null, 'the question was never asked, not answered false');
  assert.strictEqual(dev.behindDevelop, null);
  assert.deepStrictEqual(dev.epicBranchAncestry, {}, 'no ancestry answers at all, rather than wrong ones');
  assert.match(dev.error, /not develop — set gitBranch on app\.deploy\.dev to pin it/);

  // `stale`, not `ok`, and the reason is measured rather than stylistic: derive only treats a
  // non-`ok` dev env as unknown. An `ok` env with an emptied ancestry map renders `todo` — a
  // confident "this epic is NOT on dev" — which is the same false-green sin facing the other way.
  assert.strictEqual(dev.status, 'stale');
  assert.strictEqual(r.source.status, 'error', 'and it degrades the source badge, which is a badge');

  const state = deriveWith(r.fragment, 'stale');
  assert.deepStrictEqual(state.attention.filter((a) => a.type === 'rule-violation'), [], 'never an attention item');
  assert.strictEqual(state.epics.find((e) => e.key === 'PROJ-1').ladder.deployedDev, 'unknown', 'unknown — not done, and not todo either');
});

test('the mismatch renders unknown, NOT todo — the false-green that faces the other way', async () => {
  // Regression lock on the reason `stale` was chosen, now backed by a SECOND, independent guard.
  //
  // Originally this test recorded that forging the status back to `ok` made derive claim "PROJ-1 is
  // not on dev" — a confident wrong answer — which is why mod-deploy reports a branch mismatch as
  // `stale`. S-007 closed that hole at the other end: derive's ancestry helpers now keep 'unknown'
  // distinct from false instead of collapsing `tally(tips) === 'done'` into a boolean, so an empty
  // ancestry map reads unknown WHATEVER the status says.
  //
  // Both guards are kept deliberately. `stale` is still the right report — it degrades the source
  // badge, which is how an untrustworthy probe becomes visible at all — and derive no longer
  // depends on that choice being made correctly to avoid asserting a falsehood.
  const r = await run({
    deploy: { dev: vercelEnv({ target: 'preview' }) },
    fetchImpl: vercelBranchAwareStub(appWebPreviews()),
  });
  const forged = JSON.parse(JSON.stringify(r.fragment));
  forged.repos.app.dev.status = 'ok';
  assert.strictEqual(
    deriveWith(forged, 'ok').epics.find((e) => e.key === 'PROJ-1').ladder.deployedDev,
    'unknown',
    'even forced to `ok`, an empty ancestry map may not read as "not deployed"',
  );
  assert.strictEqual(deriveWith(r.fragment, 'stale').epics.find((e) => e.key === 'PROJ-1').ladder.deployedDev, 'unknown');
});

test('an unfiltered preview that DOES land on the tracked branch keeps every ancestry answer', async () => {
  // The safety valve that keeps separate-project repos unaffected: the guard fires on a mismatch,
  // not on the absence of the key. It also says out loud, once, that today was luck.
  _resetMetaLog();
  const developOnly = [appWebPreviews()[1]];
  const r = await run({ deploy: { dev: vercelEnv({ target: 'preview' }) }, fetchImpl: vercelBranchAwareStub(developOnly) });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.branchMismatch, false);
  assert.strictEqual(dev.ruleCheck, 'ok');
  assert.strictEqual(dev.behindDevelop, 3);
  assert.strictEqual(dev.epicBranchAncestry['feature/PROJ-1-web'], true);

  const luck = r.warnings.filter((w) => /matched develop by luck/.test(w));
  assert.strictEqual(luck.length, 1, 'named once…');
  const again = await run({ deploy: { dev: vercelEnv({ target: 'preview' }) }, fetchImpl: vercelBranchAwareStub(developOnly) });
  assert.strictEqual(again.warnings.filter((w) => /by luck/.test(w)).length, 0, '…not every scan');
});

test('a deployment with no githubCommitRef on an unfiltered preview is a mismatch — unprovable is not fine', async () => {
  const r = await run({
    deploy: { dev: vercelEnv({ target: 'preview' }) },
    fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha } })]) } }),
  });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.branchMismatch, true);
  assert.strictEqual(dev.status, 'stale');
  assert.strictEqual(dev.ruleViolation, false);
  assert.match(dev.error, /from an unnamed branch/);
});

test('SEPARATE-PROJECT repos (site/admin/docs) are provably unaffected — no filter, no guard, no change', async () => {
  // site/admin/docs each have their own Vercel project per environment, so `target: production` on
  // both and no branch to disambiguate. The guard must not fire, the query must not gain a param,
  // and every field must read exactly as it did before gitBranch existed.
  const stub = vercelBranchAwareStub([appWebPreviews()[1]]);
  const r = await run({
    deploy: { dev: vercelEnv({ projectId: 'prj_site_dev' }), prod: vercelEnv({ projectId: 'prj_site_prod' }) },
    fetchImpl: stub,
  });
  for (const url of stub.calls) assert.ok(!url.includes('meta-githubCommitRef'), `no branch filter on ${url}`);

  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.branchFilter, null);
  assert.strictEqual(dev.branchMismatch, false, 'production is single-branch — the guard does not apply');
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.sha, fx.deployedSha);
  assert.strictEqual(dev.ruleCheck, 'ok');
  assert.strictEqual(dev.behindDevelop, 3);
  assert.strictEqual(dev.epicBranchAncestry['feature/PROJ-1-web'], true, 'ancestry still fully computed');
  assert.strictEqual(r.source.status, 'ok');

  // Even a production target whose ref is some other branch is untouched: production is not the
  // multi-branch case, and inventing a mismatch there would be a NEW false signal.
  const odd = await run({ deploy: { dev: vercelEnv() }, fetchImpl: vercelBranchAwareStub([appWebPreviews()[0]]) });
  assert.strictEqual(odd.fragment.repos.app.dev.branchMismatch, false);
  assert.strictEqual(odd.fragment.repos.app.dev.ruleCheck, 'violation', 'and its real violation still surfaces');
});

test('a misspelled gitBranch is `empty` and the note names the branch, not a mystery', async () => {
  const r = await run({
    deploy: { dev: vercelEnv({ target: 'preview', gitBranch: 'develp' }) },
    fetchImpl: vercelBranchAwareStub(appWebPreviews()),
  });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'empty', 'never a fallback to some other branch');
  assert.strictEqual(dev.sha, null);
  assert.match(dev.note, /no READY preview deployment on develp/);
  assert.strictEqual(dev.ruleViolation, false);
});

// ---- deployment age: the stale-decoy badge -------------------------------------------------------------

test('a year-stale deployment is BADGED, never an attention item and never a source degradation', async () => {
  // A retired project (prj_example111111) still configured under a name that no longer matches what
  // it serves: its last READY production deployment is 2025-08-29 and it answers a probe with a sha
  // that looks perfectly valid. Age cannot make it a violation — it can only make it visible.
  const r = await run({
    fetchImpl: fetchStub({
      '/v6/deployments': {
        status: 200,
        body: vercelBody([readyDeployment({ created: Date.parse('2025-08-29T00:00:00.000Z'), meta: { githubCommitSha: fx.deployedSha, githubCommitRef: 'main' } })]),
      },
    }),
  });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.deployAgeStale, true);
  assert.strictEqual(dev.ageDays, 335);
  assert.match(dev.note, /deployed 335d ago/);
  assert.strictEqual(dev.ruleViolation, false, 'age is never a violation');
  assert.strictEqual(r.source.status, 'ok', 'and never degrades the source badge');
  assert.deepStrictEqual(deriveWith(r.fragment, 'ok').attention.filter((a) => a.type === 'rule-violation'), []);
});

test('a current deployment is not badged and its note is untouched', async () => {
  const r = await run();
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.deployAgeStale, false);
  assert.strictEqual(dev.ageDays, 0);
  assert.ok(!/ago/.test(dev.note), 'no age fragment appended to a current deployment');
  assert.match(dev.note, /^behind ×3 · last deploy by /);
});

// ---- ssh-docker ---------------------------------------------------------------------------------------

const sshOk = (stdout) => async () => ({ ok: true, stdout, stderr: '' });

test('ssh-docker reads org.opencontainers.image.revision when the label is there', async () => {
  const r = await run({ deploy: { dev: { kind: 'ssh-docker', host: 'h.example', user: 'deploy', container: 'app-dev', sudo: true } }, sshExec: sshOk(`${fx.deployedSha}\n`) });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.sha, fx.deployedSha);
  assert.strictEqual(dev.ruleCheck, 'ok');
});

test('ssh-docker builds the documented command with sudo and the user@host target', async () => {
  const seen = [];
  await run({
    deploy: { dev: { kind: 'ssh-docker', host: 'h.example', user: 'deploy', container: 'app-dev', sudo: true } },
    sshExec: async (o) => { seen.push(o); return { ok: true, stdout: `${fx.deployedSha}\n`, stderr: '' }; },
  });
  assert.strictEqual(seen[0].target, 'deploy@h.example');
  assert.strictEqual(seen[0].command, `sudo -n docker inspect --format '{{index .Config.Labels "${REVISION_LABEL}"}}' app-dev`);
});

test('ssh-docker: no revision label and a :latest tag is sha-null + unknown, never a guess', async () => {
  // This is the real app-api dev container (probed 2026-07-31): compose labels only, image
  // ghcr.io/legacy-preview-api:latest. There is nothing to derive a revision from, and saying so is the
  // correct answer.
  let call = 0;
  const ssh = async () => {
    call++;
    return call === 1
      ? { ok: true, stdout: '<no value>\n', stderr: '' }
      : { ok: true, stdout: 'ghcr.io/legacy-preview-api:latest\n', stderr: '' };
  };
  _resetMetaLog();
  const r = await run({ deploy: { dev: { kind: 'ssh-docker', host: 'h.example', container: 'app-dev' } }, sshExec: ssh });
  const dev = r.fragment.repos.app.dev;
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.sha, null);
  assert.strictEqual(dev.shaMissing, true);
  assert.strictEqual(dev.ruleViolation, false);
  assert.strictEqual(dev.ruleCheck, 'unknown');
  assert.match(dev.note, /carries no org\.opencontainers\.image\.revision/);
});

test('ssh-docker: a sha-shaped image tag is used as the fallback revision', async () => {
  let call = 0;
  const ssh = async () => (++call === 1 ? { ok: true, stdout: '\n', stderr: '' } : { ok: true, stdout: `ghcr.io/app:${fx.deployedSha}\n`, stderr: '' });
  const r = await run({ deploy: { dev: { kind: 'ssh-docker', host: 'h.example', container: 'app-dev' } }, sshExec: ssh });
  assert.strictEqual(r.fragment.repos.app.dev.sha, fx.deployedSha);
});

test('ssh-docker: permission denied is unauthorized, a missing container is empty, a hang is stale', async () => {
  const cases = [
    [{ ok: false, stdout: '', stderr: 'deploy@h.example: Permission denied (publickey).' }, 'unauthorized'],
    [{ ok: false, stdout: '', stderr: 'Error: No such object: app-dev' }, 'empty'],
    [{ ok: false, stdout: '', stderr: 'ssh: connect to host h.example port 22: Operation timed out' }, 'stale'],
  ];
  for (const [res, want] of cases) {
    const r = await run({ deploy: { dev: { kind: 'ssh-docker', host: 'h.example', container: 'app-dev' } }, sshExec: async () => res });
    assert.strictEqual(r.fragment.repos.app.dev.status, want, res.stderr);
    assert.strictEqual(r.fragment.repos.app.dev.ruleViolation, false);
  }
});

// ---- module-level contracts ---------------------------------------------------------------------------

test('no deploy config at all is `disabled`, not an error and not a false ok', async () => {
  const r = await collectDeploy({
    now: NOW,
    config: { repos: [{ id: 'app', path: fx.repo, defaultBranches: ['develop'], deploy: null }] },
    fragments: { git: gitFragment(fx) },
    env: {},
  });
  assert.deepStrictEqual(r.source, { status: 'disabled' });
  assert.deepStrictEqual(r.fragment.repos, {});
});

test('a repo missing from the git fragment still gets probed; only ancestry goes unknown', async () => {
  const r = await collectDeploy({
    now: NOW,
    config: { timeouts: { deployMs: 5000 }, repos: [{ id: 'ghost', path: '/nope', defaultBranches: ['develop'], deploy: { dev: vercelEnv() } }] },
    fragments: { git: { repos: {} } },
    env: { VT: 'tok' },
    fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha } })]) } }),
  });
  const dev = r.fragment.repos.ghost.dev;
  assert.strictEqual(dev.status, 'ok');
  assert.strictEqual(dev.sha, fx.deployedSha);
  assert.strictEqual(dev.shaKnownLocally, null, 'no repo on disk => the question could not be asked');
  assert.strictEqual(dev.ruleViolation, false);
});

test('an adapter that throws becomes a stale badge, never a lost scan', async () => {
  const r = await run({ sshExec: () => { throw new Error('kaboom'); }, deploy: { dev: { kind: 'ssh-docker', host: 'h.example', container: 'c' } } });
  assert.strictEqual(r.fragment.repos.app.dev.status, 'stale');
  assert.match(r.fragment.repos.app.dev.error, /kaboom/);
  assert.strictEqual(r.fragment.repos.app.dev.ruleViolation, false);
});

test('a repo with no develop branch compares dev against main', async () => {
  const frag = gitFragment(fx);
  delete frag.repos.app.defaultBranches.develop;
  const r = await collectDeploy({
    now: NOW,
    config: { timeouts: { deployMs: 5000 }, repos: [{ id: 'app', path: fx.repo, defaultBranches: ['main'], deploy: { dev: vercelEnv() } }] },
    fragments: { git: frag },
    env: { VT: 'tok' },
    fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.offDevelopSha } })]) } }),
  });
  assert.strictEqual(r.fragment.repos.app.dev.compareRef, 'origin/main');
  assert.strictEqual(r.fragment.repos.app.dev.ruleViolation, false, 'main-only sha IS on main');
});

// ---- derive integration -----------------------------------------------------------------------------

// Builds a full state from a deploy fragment plus the fixture's git facts.
function deriveWith(deployFragment, deployStatus) {
  return derive({
    now: NOW,
    collectorId: 'test',
    config: { repos: [] },
    sources: {
      git: { status: 'ok', observedAt: OBSERVED },
      sessions: { status: 'disabled' },
      deploy: deployStatus === 'ok' ? { status: 'ok', observedAt: OBSERVED } : { status: deployStatus, observedAt: OBSERVED, error: 'x' },
      jira: { status: 'disabled' },
      specs: { status: 'disabled' },
      config: { status: 'ok' },
    },
    aliases: {},
    decisions: [],
    fragments: {
      git: {
        repos: {
          app: Object.assign({}, gitFragment(fx).repos.app, {
            branches: gitFragment(fx).repos.app.branches.map((b) => Object.assign({}, b, {
              unpushed: 0, noRemote: false, mergedIntoDevelop: b.name === 'feature/PROJ-1-web',
              mergedIntoMain: false, lastCommitAt: new Date(NOW - 86400000).toISOString(), worktree: null,
            })),
          }),
        },
      },
      deploy: deployFragment,
    },
  });
}

test('derive: a deployed epic branch reaches ladder.deployedDev = done', async () => {
  const r = await run();
  const state = deriveWith(r.fragment, 'ok');
  assert.strictEqual(state.epics.find((e) => e.key === 'PROJ-1').ladder.deployedDev, 'done');
  assert.strictEqual(state.epics.find((e) => e.key === 'PROJ-2').ladder.deployedDev, 'todo', 'not deployed');
});

test('derive: a real violation DOES surface as a rule-violation attention item', async () => {
  const r = await run({
    deploy: { prod: vercelEnv() },
    fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.deployedSha } })]) } }),
  });
  // develop's merge commit is NOT an ancestor of origin/main -> deploying it to prod is a violation.
  assert.strictEqual(r.fragment.repos.app.prod.ruleViolation, true);
  const state = deriveWith(r.fragment, 'ok');
  const items = state.attention.filter((a) => a.type === 'rule-violation');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].env, 'prod');
});

test('ZERO false violations across every degraded shape', async () => {
  const shapes = {
    empty: { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([]) } }) },
    unauthorized: { env: {} },
    stale: { fetchImpl: fetchStub({ '/v6/deployments': new Error('ECONNRESET') }) },
    'no-sha': { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { gitSha: 'x' } })]) } }) },
    'force-pushed': { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.forcePushedSha } })]) } }) },
    squashed: { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.squashedSha } })]) } }) },
    absent: { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ meta: { githubCommitSha: fx.absentSha } })]) } }) },
    // The unfiltered-preview shape, whose sha is a real feature-branch tip and therefore a real
    // non-ancestor of origin/develop. This is the one that fabricates a violation if unguarded.
    'wrong-branch': { deploy: { dev: vercelEnv({ target: 'preview' }) }, fetchImpl: vercelBranchAwareStub(appWebPreviews()) },
    'stale-decoy': { fetchImpl: fetchStub({ '/v6/deployments': { status: 200, body: vercelBody([readyDeployment({ created: Date.parse('2025-08-29T00:00:00.000Z'), meta: { githubCommitSha: fx.deployedSha } })]) } }) },
  };
  for (const name of Object.keys(shapes)) {
    const r = await run(shapes[name]);
    assert.strictEqual(r.fragment.repos.app.dev.ruleViolation, false, `${name} must not raise a violation`);
    const state = deriveWith(r.fragment, r.source.status === 'ok' ? 'ok' : 'stale');
    assert.strictEqual(state.attention.filter((a) => a.type === 'rule-violation').length, 0, `${name} must raise no attention item`);
  }
});
