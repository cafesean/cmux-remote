'use strict';
// Every git invocation in radar goes through here, and it spawns the ABSOLUTE binary.
//
// WHY THIS FILE EXISTS: `rtk` proxies `git` on this machine and FABRICATES output — it has
// invented a clean `git status` more than once. spawn() already bypasses shell aliases, and
// `command git` only defeats aliases inside a shell, but neither defeats a PATH shim. The
// absolute path kills the whole class. There is exactly one git binary literal in radar and
// it lives on the next line. Nothing else may spawn 'git'.
const { execFile } = require('child_process');

const GIT_BIN = '/usr/bin/git';

// Env hardening for an unattended collector: never block on a credential prompt, never take the
// index.lock for read-only plumbing (GIT_OPTIONAL_LOCKS=0 keeps us out of an interactive session's way).
const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ASKPASS: '',
  LC_ALL: 'C',
});

// Never throws. A git failure is a FACT to report (exit code + stderr), not an exception to unwind:
// the collector must publish "unknown" rather than lose a whole scan to one bad repo.
function git(args, opts) {
  const o = opts || {};
  const timeout = o.timeoutMs == null ? 20000 : o.timeoutMs;
  return new Promise((resolve) => {
    execFile(
      GIT_BIN,
      args,
      { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: GIT_ENV, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '', timedOut: false });
        const timedOut = err.killed === true || err.signal === 'SIGTERM';
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : null,
          stdout: stdout || '',
          stderr: (stderr || '').trim() || String(err.message || 'git failed'),
          timedOut,
        });
      },
    );
  });
}

// `git -C <repo> ...` rather than execFile's cwd: a worktree's .git is a FILE pointing at the
// parent repo, and -C is the form git itself documents for that case.
const gitIn = (repoPath, args, opts) => git(['-C', repoPath].concat(args), opts);

// Exit-code-as-boolean plumbing (`merge-base --is-ancestor`). `null` = the question could not be
// asked at all (missing ref, timeout) and must render `unknown`, never `false`.
async function gitTest(repoPath, args, opts) {
  const r = await gitIn(repoPath, args, opts);
  if (r.ok) return true;
  if (r.timedOut || r.code == null) return null;
  return r.code === 1 ? false : null;
}

const lines = (s) => String(s || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);

// Bounded-concurrency map. The collector fans out over ~200 git spawns per big repo; unbounded
// would fork-bomb the laptop and unfair-schedule the interactive shell.
async function mapLimit(items, limit, fn) {
  const arr = Array.from(items);
  const out = new Array(arr.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, arr.length));
  const workers = new Array(width).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { GIT_BIN, git, gitIn, gitTest, lines, mapLimit };
