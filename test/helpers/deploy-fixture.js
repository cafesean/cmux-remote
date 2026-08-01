'use strict';
// A real git repo shaped for the S-005 ancestry questions. Nothing here mocks git: the force-push
// and squash cases are produced by ACTUALLY orphaning commits, because the whole point of those
// fixtures is that a dangling object still EXISTS on disk — which is exactly why an existence test
// (`cat-file -e`) would fabricate a rule violation and a reachability test (`for-each-ref
// --contains`) does not.
//
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { g, commit } = require('./git-fixture');

// Builds, on `develop`:
//
//   root ── developBase ── M(merge feature/PROJ-1-web) ── d1 ── d2 ── d3   <- origin/develop
//                              |
//                              +-- feature/PROJ-1-web  (merged, tip is an ancestor of M)
//   feature/PROJ-2-open   never merged, tip NOT an ancestor of anything deployed
//   feature/PROJ-3-later  branched off d3, tip NOT an ancestor of M
//   offDevelopSha        a commit on main only  -> NOT an ancestor of origin/develop => VIOLATION
//   forcePushedSha       committed then the branch deleted -> dangling, no ref reaches it => UNKNOWN
//   squashedSha          a squash commit then reset away   -> dangling, no ref reaches it => UNKNOWN
async function buildDeployFixture() {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-deploy-')));
  const origin = path.join(base, 'origin.git');
  const repo = path.join(base, 'repo');

  await g(base, ['init', '--bare', '-q', '-b', 'main', origin]);
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await g(repo, ['remote', 'add', 'origin', origin]);

  await commit(repo, 'README.md', 'root\n', 'root');
  await g(repo, ['push', '-q', '-u', 'origin', 'main']);

  await g(repo, ['checkout', '-q', '-b', 'develop']);
  await commit(repo, 'develop.txt', 'd\n', 'develop base');
  await g(repo, ['push', '-q', '-u', 'origin', 'develop']);

  // The epic branch that IS deployed: merged --no-ff, and the merge commit is what shipped.
  await g(repo, ['checkout', '-q', '-b', 'feature/PROJ-1-web', 'develop']);
  await commit(repo, 'web.txt', 'w\n', 'web work');
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/PROJ-1-web']);
  const proj1Tip = (await g(repo, ['rev-parse', 'feature/PROJ-1-web'])).trim();
  await g(repo, ['checkout', '-q', 'develop']);
  await g(repo, ['merge', '-q', '--no-ff', '-m', 'merge feature/PROJ-1-web', 'feature/PROJ-1-web']);
  const deployedSha = (await g(repo, ['rev-parse', 'develop'])).trim();

  // Three commits land on develop AFTER the deploy: this is the behind-count, and on app-web it
  // is what the author gate produces when an operator-authored commit silently does not deploy.
  for (const n of [1, 2, 3]) await commit(repo, 'develop.txt', `d${n}\n`, `post-deploy ${n}`);
  await g(repo, ['push', '-q', 'origin', 'develop']);

  // Never merged, never deployed.
  await g(repo, ['checkout', '-q', '-b', 'feature/PROJ-2-open', 'develop']);
  await commit(repo, 'open.txt', 'o\n', 'open work');
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/PROJ-2-open']);
  const proj2Tip = (await g(repo, ['rev-parse', 'feature/PROJ-2-open'])).trim();

  // Branched after the deploy: its tip cannot be an ancestor of the deployed sha.
  await g(repo, ['checkout', '-q', '-b', 'feature/PROJ-3-later', 'develop']);
  await commit(repo, 'later.txt', 'l\n', 'later work');
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/PROJ-3-later']);
  const proj3Tip = (await g(repo, ['rev-parse', 'feature/PROJ-3-later'])).trim();

  // A commit that lives only on main: reachable from a ref, but NOT an ancestor of origin/develop.
  // Deploying this to dev is a genuine rule violation and must be reported as one.
  await g(repo, ['checkout', '-q', 'main']);
  await commit(repo, 'main-only.txt', 'm\n', 'main only');
  const offDevelopSha = (await g(repo, ['rev-parse', 'main'])).trim();
  await g(repo, ['push', '-q', 'origin', 'main']);

  // FORCE-PUSH: commit, capture, then delete the branch. The object survives as a dangling commit,
  // so `cat-file -e` still says yes while no ref can reach it.
  await g(repo, ['checkout', '-q', '-b', 'tmp/force-pushed', 'develop']);
  await commit(repo, 'force.txt', 'f\n', 'about to be force-pushed away');
  const forcePushedSha = (await g(repo, ['rev-parse', 'HEAD'])).trim();
  await g(repo, ['checkout', '-q', 'develop']);
  await g(repo, ['branch', '-q', '-D', 'tmp/force-pushed']);

  // SQUASH-MERGE: CI squashed the branch and deployed the squash commit; our clone never got it.
  await g(repo, ['checkout', '-q', '-b', 'tmp/squash', 'develop']);
  await g(repo, ['merge', '-q', '--squash', 'feature/PROJ-2-open']);
  await commit(repo, 'squash-marker.txt', 's\n', 'squash feature/PROJ-2-open');
  const squashedSha = (await g(repo, ['rev-parse', 'HEAD'])).trim();
  await g(repo, ['checkout', '-q', 'develop']);
  await g(repo, ['branch', '-q', '-D', 'tmp/squash']);

  await g(repo, ['fetch', '-q', 'origin']);

  return {
    base, origin, repo,
    deployedSha, offDevelopSha, forcePushedSha, squashedSha,
    proj1Tip, proj2Tip, proj3Tip,
    // A sha that never existed in any repo, anywhere.
    absentSha: '1234567890abcdef1234567890abcdef12345678',
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

// The git fragment shape mod-deploy consumes, built by hand so the deploy tests do not depend on
// mod-git's own scan (that module has its own suite).
function gitFragment(fx) {
  return {
    repos: {
      app: {
        path: fx.repo,
        defaultBranches: { develop: 'x', main: 'y' },
        branches: [
          { name: 'develop', sha: 'x', epic: null, isDefault: true },
          { name: 'main', sha: 'y', epic: null, isDefault: true },
          { name: 'feature/PROJ-1-web', sha: fx.proj1Tip, epic: 'PROJ-1', isDefault: false },
          { name: 'feature/PROJ-2-open', sha: fx.proj2Tip, epic: 'PROJ-2', isDefault: false },
          { name: 'feature/PROJ-3-later', sha: fx.proj3Tip, epic: 'PROJ-3', isDefault: false },
        ],
        worktrees: [],
        deploy: null,
        fetch: { status: 'ok', error: null },
      },
    },
  };
}

// A fetch stub. `plan` maps a substring of the URL to {status, body} (or a thrown Error).
function fetchStub(plan) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const key of Object.keys(plan)) {
      if (String(url).indexOf(key) !== -1) {
        const r = plan[key];
        if (r instanceof Error) throw r;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'no stub matched' } }) };
  };
  impl.calls = calls;
  return impl;
}

const vercelBody = (deployments) => ({ deployments });

const readyDeployment = (o) => Object.assign({
  uid: 'dpl_test1',
  readyState: 'READY',
  state: 'READY',
  created: Date.parse('2026-07-30T09:00:00.000Z'),
  url: 'app-test.vercel.app',
  target: 'production',
  creator: { username: 'someone', githubLogin: 'someone' },
  meta: {
    githubCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    githubCommitRef: 'develop',
    githubCommitAuthorLogin: 'example-org',
    githubCommitAuthorName: 'example-org',
  },
}, o);

// A fetch stub that behaves like the real /v6/deployments branch filter: `meta-githubCommitRef=<b>`
// narrows the list, and its ABSENCE returns everything newest-first across all branches. This is
// the shape verified against the live app-web project on 2026-07-31, where 9 of the last 100 READY
// preview deployments came from feature branches rather than develop.
function vercelBranchAwareStub(deployments) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const m = /[?&]meta-githubCommitRef=([^&]+)/.exec(String(url));
    const want = m ? decodeURIComponent(m[1]) : null;
    const list = deployments
      .filter((d) => (want === null ? true : (d.meta || {}).githubCommitRef === want))
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
    return { ok: true, status: 200, json: async () => ({ deployments: list }) };
  };
  impl.calls = calls;
  return impl;
}

module.exports = { buildDeployFixture, gitFragment, fetchStub, vercelBody, readyDeployment, vercelBranchAwareStub };
