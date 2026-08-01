'use strict';
// Real throwaway git repos for the radar tests. Nothing here mocks git's output: a fixture that
// invents porcelain text can only ever prove the parser agrees with the person who wrote the
// fixture. These build actual repos with actual worktrees, an actual detached HEAD, an actual
// no-upstream branch, and let /usr/bin/git produce the bytes.
//
// (This file lives under test/ but declares no tests; `node --test` treats it as a file with zero
// subtests, which passes.)
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const GIT = '/usr/bin/git';

// A hermetic git: no user config, no global hooks, no gpg signing, no maintenance.
const baseEnv = (extra) => Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Radar Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Radar Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
}, extra || {});

function g(cwd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, env: baseEnv(env), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args.join(' ')} in ${cwd}: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

async function commit(repo, file, text, message, whenIso) {
  await fsp.writeFile(path.join(repo, file), text);
  await g(repo, ['add', '-A']);
  const env = whenIso ? { GIT_AUTHOR_DATE: whenIso, GIT_COMMITTER_DATE: whenIso } : null;
  await g(repo, ['commit', '-q', '-m', message], env);
  return (await g(repo, ['rev-parse', 'HEAD'])).trim();
}

// Builds:
//   origin.git                bare remote
//   repo                      main worktree, on develop
//   wt-merged                 worktree on feature/merged-clean   -> clean + merged  => stale
//   wt-dirty                  worktree on feature/dirty-work     -> dirty           => NEVER stale
//   wt-idle                   worktree on feature/old-idle       -> clean, 60d old  => stale (idle)
//   wt-detached               detached HEAD                      -> branch: null
// Branches: develop, main, feature/PROJ-108-thing (2 unpushed, has upstream),
//           feature/p59-local-only (never pushed -> noRemote), feature/merged-clean,
//           feature/dirty-work, feature/old-idle, orphan-branch.
async function buildFixtureRepo() {
  // realpath: on macOS os.tmpdir() is /var/... which is a symlink to /private/var. git reports
  // resolved paths, so a fixture that keeps the unresolved one compares two different strings.
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-git-')));
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

  // 2 unpushed commits on a branch that DOES have an upstream.
  await g(repo, ['checkout', '-q', '-b', 'feature/PROJ-108-thing']);
  await commit(repo, 'a.txt', '1\n', 'pushed work');
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/PROJ-108-thing']);
  await commit(repo, 'a.txt', '2\n', 'unpushed one');
  await commit(repo, 'a.txt', '3\n', 'unpushed two');

  // Never pushed at all -> no upstream -> noRemote true, and every commit counts as unpushed.
  await g(repo, ['checkout', '-q', '-b', 'feature/p59-local-only', 'develop']);
  await commit(repo, 'b.txt', 'b\n', 'local only');

  // Merged into develop with --no-ff (the standing runbook flow the spec assumes).
  await g(repo, ['checkout', '-q', '-b', 'feature/merged-clean', 'develop']);
  await commit(repo, 'c.txt', 'c\n', 'mergeable work');
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/merged-clean']);
  await g(repo, ['checkout', '-q', 'develop']);
  await g(repo, ['merge', '-q', '--no-ff', '-m', 'merge feature/merged-clean', 'feature/merged-clean']);
  await g(repo, ['push', '-q', 'origin', 'develop']);

  await g(repo, ['checkout', '-q', '-b', 'feature/dirty-work', 'develop']);
  await commit(repo, 'd.txt', 'd\n', 'dirty base');
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/dirty-work']);

  await g(repo, ['checkout', '-q', '-b', 'feature/old-idle', 'develop']);
  await commit(repo, 'e.txt', 'e\n', 'old work', daysAgo(60));
  await g(repo, ['push', '-q', '-u', 'origin', 'feature/old-idle']);

  await g(repo, ['checkout', '-q', '-b', 'orphan-branch', 'develop']);
  await commit(repo, 'f.txt', 'f\n', 'orphan work');
  await g(repo, ['push', '-q', '-u', 'origin', 'orphan-branch']);

  await g(repo, ['checkout', '-q', 'develop']);

  const wt = {
    merged: path.join(base, 'wt-merged'),
    dirty: path.join(base, 'wt-dirty'),
    idle: path.join(base, 'wt-idle'),
    detached: path.join(base, 'wt-detached'),
  };
  await g(repo, ['worktree', 'add', '-q', wt.merged, 'feature/merged-clean']);
  await g(repo, ['worktree', 'add', '-q', wt.dirty, 'feature/dirty-work']);
  await g(repo, ['worktree', 'add', '-q', wt.idle, 'feature/old-idle']);
  const developSha = (await g(repo, ['rev-parse', 'develop'])).trim();
  await g(repo, ['worktree', 'add', '-q', '--detach', wt.detached, developSha]);

  // Make wt-dirty genuinely dirty: one tracked modification + one untracked file.
  await fsp.writeFile(path.join(wt.dirty, 'd.txt'), 'MODIFIED\n');
  await fsp.writeFile(path.join(wt.dirty, 'scratch.tmp'), 'x\n');

  await g(repo, ['fetch', '-q', 'origin']);
  return { base, origin, repo, wt, developSha, cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

module.exports = { GIT, g, commit, buildFixtureRepo, daysAgo };
