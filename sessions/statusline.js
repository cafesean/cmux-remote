'use strict';
// p41 A12 — terminal status-line data per session. Claude Code's statusLine command
// (~/.claude/get-session-name.sh) writes ~/.claude/statusline/<sessionId>.json; the bridge reads it
// (also under each cswap config dir) and falls back to what it already knows plus git branch/repo.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { SWAP } = require('./join');

// Every limit this module adds (LIMITS.md rows).
const LIMITS = {
  sidecarMaxBytes: 16 * 1024,      // a sidecar bigger than this is ignored
  sessionIdMax: 128,               // sessionId used as a file name: ^[A-Za-z0-9_-]{1,128}$
  gitCacheTtlMs: 10000,            // git branch/repo per cwd cached this long
  gitCacheMax: 128,                // cached cwds; oldest dropped
  gitTimeoutMs: 2000,
  swapAccountsMax: SWAP.maxAccounts,
  strMax: 300,                     // any string field is clipped to this
};
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const str = (v) => (typeof v === 'string' && v ? v.slice(0, LIMITS.strMax) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function configDirs(home) {
  const dirs = [path.join(home, '.claude')];
  let names = [];
  try { names = await fsp.readdir(path.join(home, ...SWAP.dir)); } catch (_) { names = []; }
  for (const n of names.slice(0, LIMITS.swapAccountsMax)) dirs.push(path.join(home, ...SWAP.dir, n));
  return dirs;
}

// Safe open: lstat (no symlink, regular file, size cap), then O_NOFOLLOW read, JSON parse in try.
async function readOne(file) {
  let fh;
  try {
    const l = await fsp.lstat(file);
    if (!l.isFile() || l.isSymbolicLink() || l.size > LIMITS.sidecarMaxBytes) return null;
    fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > LIMITS.sidecarMaxBytes) return null;
    const j = JSON.parse(await fh.readFile('utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch (_) { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

// The sidecar for a session, reduced to the Session.statusLine shape, or null. Newest writtenAt wins.
async function readSidecar(sessionId, { home } = {}) {
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return null;
  let best = null;
  for (const dir of await configDirs(home || os.homedir())) {
    const j = await readOne(path.join(dir, 'statusline', `${sessionId}.json`));
    if (!j || j.v !== 1 || j.sessionId !== sessionId) continue;
    const w = str(j.writtenAt);
    if (!best || (w || '') > (best.writtenAt || '')) {
      best = { account: str(j.account), lastReplyAt: str(j.lastReplyAt), ctxUsed: num(j.ctxUsed), ctxLimit: num(j.ctxLimit),
        ctxPct: num(j.ctxPct), model: str(j.model), title: str(j.title), branch: str(j.branch), repo: str(j.repo), writtenAt: w };
    }
  }
  return best;
}

function defaultGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, '--no-optional-locks', ...args], { timeout: LIMITS.gitTimeoutMs, windowsHide: true }, (e, out) => resolve(e ? null : String(out).trim()));
  });
}

// git branch + repo basename for a cwd, cached per cwd. `git` is injectable for tests.
function createGitInfo({ git, now } = {}) {
  const run = git || defaultGit;
  const clock = now || Date.now;
  const cache = new Map();
  return async function gitInfo(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { branch: null, repo: null };
    const hit = cache.get(cwd);
    if (hit && clock() - hit.at < LIMITS.gitCacheTtlMs) return hit.v;
    let branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    let repo = null;
    if (branch) {
      if (branch === 'HEAD') branch = await run(['rev-parse', '--short', 'HEAD'], cwd);
      const top = await run(['rev-parse', '--show-toplevel'], cwd);
      repo = top ? path.basename(top) : null;
    }
    const v = { branch: branch || null, repo };
    cache.delete(cwd); cache.set(cwd, { at: clock(), v });
    while (cache.size > LIMITS.gitCacheMax) cache.delete(cache.keys().next().value);
    return v;
  };
}

// Session.statusLine: the sidecar when present, else what the bridge knows. The fallback has no account.
async function statusLineFor({ sessionId, home, session, cwd, gitInfo }) {
  const sc = await readSidecar(sessionId, { home });
  if (sc) return sc;
  let g = { branch: null, repo: null };
  try { g = await gitInfo(cwd); } catch (_) { /* no git info */ }
  return { account: null, lastReplyAt: null, ctxUsed: null, ctxLimit: null,
    ctxPct: typeof session.contextPct === 'number' ? session.contextPct : null,
    model: session.model || null, title: session.title || null, branch: g.branch, repo: g.repo,
    writtenAt: session.lastActivity ? new Date(session.lastActivity).toISOString() : null };
}

module.exports = { LIMITS, readSidecar, createGitInfo, statusLineFor };
