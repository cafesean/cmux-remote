'use strict';
// mod-deploy (S-005) — what is actually deployed, and whether it is ALLOWED to be.
//
// FOUR OUTCOMES, and they are not interchangeable (spec §M3, binding):
//
//   ok            a probe answered and named a deployment
//   empty         a probe answered and there is NO deployment (wrong teamId, never-deployed project)
//   unauthorized  the credential is missing, revoked, or scoped away from this team
//   stale         the probe did not produce the fact we asked for — it failed (network, timeout,
//                 5xx, rate limit) OR it answered about something else (see the branch guard below)
//
// `empty` is the one that burns people: an empty Vercel deployment list looks like "nothing to
// report" and reads as parity. It is NOT parity. This module makes the confusion structurally
// impossible rather than merely discouraged — `empty` carries `sha: null`, a null sha makes every
// ancestry answer null, and a null ancestry answer makes the ladder cell `unknown`. There is no
// code path from `empty` to `done`, and a test asserts exactly that.
//
// ANCESTRY IS BRANCH-TIP ONLY. There is no `epicMergeCommit` concept — spec review deleted it as
// underivable. Two questions, two commands:
//
//   rule check      merge-base --is-ancestor <deployedSha> origin/develop   (dev) / origin/main (prod)
//   epic-deployed   merge-base --is-ancestor <branchTip>   <deployedSha>
//
// and one precondition that outranks both: if the deployed SHA is not reachable from ANY local ref
// — force-push, squash-merge, or simply a fetch we never ran — the answer is `unknown`, NEVER a
// violation. Reachability is `for-each-ref --contains`, not `cat-file -e`: a force-pushed commit
// usually still EXISTS locally as a dangling object, and testing existence would turn every
// force-push into a fabricated rule violation.
//
// A PROBE FAILURE IS A BADGE, NEVER AN ATTENTION ITEM. `ruleViolation: true` is written in exactly
// one place in this file, from a merge-base test that actually ran and actually returned false.
//
// A `preview` TARGET IS MULTI-BRANCH, AND THAT IS THE SILENT-WRONG-ANSWER SEAM. A repo can ship dev
// and prod from ONE Vercel project (say prj_example000000, team_example000000), split by branch:
// `main`→production→app.example.com, `develop`→preview→app-dev.example.com. Every feature branch
// ALSO produces preview deployments in that same project — a large minority of READY previews are
// feature branches — so "the newest READY preview" is not "what is on the dev URL", it is "whatever
// built last".
//
// The optional `gitBranch` key closes it by adding `&meta-githubCommitRef=<branch>` to the query.
// It is optional because repos whose dev and prod are genuinely separate Vercel projects (site, admin,
// docs) have nothing to disambiguate, and must keep behaving exactly as before.
//
// When it is ABSENT on a non-production target we do not trust the answer on faith and we do not
// refuse to answer either — we CHECK it: the deployment carries `meta.githubCommitRef`, so compare
// it against the branch this env is supposed to track. Match, and the unfiltered query happened to
// return the right branch and every ancestry answer stands (this is why site/admin/docs are
// untouched). Mismatch — or no ref at all — and the probe answered about a DIFFERENT branch than the
// one asked about, which is `stale`: the deployment and its branch are still carried for a human to
// read, every derived judgement is refused, and the error names the one-line fix.
//
// `stale` rather than `ok`, deliberately and by measurement. `ok` with an emptied ancestry map does
// not read as unknown downstream — derive's `deployedDevByRepo` only returns null for a non-`ok`
// status, so an `ok` env with no ancestry answers renders the ladder cell `todo`, i.e. a confident
// "this epic is NOT on dev". That is a false green pointing the other way, and §2 forbids it just as
// hard. A fifth outcome was not invented for this; the fourth already means "the probe did not
// produce the fact", and a config change rather than a retry being the fix does not change that.
//
// The fabrication this prevents is not merely a wrong sha: a feature-branch tip is not an ancestor
// of origin/develop, so an unfiltered preview probe would have manufactured a RULE VIOLATION out of
// a perfectly healthy deploy.
//
// THE AUTHOR GATE IS A FEATURE, NOT A BUG (spec §9 trap 2). A project can be configured to deploy
// only for commits authored by one account; a commit by anyone else silently produces no deploy. A
// large behind-count next to recent READY deployments is that detector WORKING. So behind-count feeds a rendered note
// (`behind ×N · last deploy by <author>`) and never, under any circumstance, a violation.
//
// SECRETS: `tokenRef` names an environment variable. This module reads process.env[tokenRef] and
// never writes the value anywhere — not into state.json, not into a warning, not into an error
// string. The only thing that ever escapes is the NAME of the variable.
const { gitIn, gitTest, mapLimit } = require('../lib/gitcmd');
const { getJson } = require('./http');

const VERCEL_API = 'https://api.vercel.com';
const ENVS = ['dev', 'prod'];
// dev is compared against develop, prod against main. A repo without develop compares dev to main.
const TARGET_BRANCH = { dev: 'develop', prod: 'main' };
const BEHIND_FIELD = { dev: 'behindDevelop', prod: 'behindMain' };
const ANCESTRY_CONCURRENCY = 8;
const PROBE_CONCURRENCY = 4;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
// Docker's --format prints this literal when the requested label is absent.
const DOCKER_NO_VALUE = '<no value>';
// ssh/docker identifiers are interpolated into a remote shell command, so they are validated
// rather than escaped. Anything outside this alphabet is a config error, not a quoting problem.
const SAFE_IDENT = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
// Vercel's `production` target only ever builds the project's production branch, so it needs no
// branch filter. Every other target (`preview`, custom envs) is multi-branch by construction.
const SINGLE_BRANCH_TARGET = 'production';
// A deployment older than this is reported with a `deployAgeStale` badge. It exists because a
// retired project can stay configured under a name that no longer matches what it serves: it still
// answers a probe, with a year-old sha that looks perfectly valid. Age is a BADGE and nothing else:
// it never sets ruleViolation, never degrades the source, and never becomes an attention item.
const STALE_DEPLOY_DAYS = 90;
const DAY_MS = 86400000;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// "log the raw meta ONCE" (spec §M3). Once per repo:env per process — a field-name change is a
// one-time discovery, and repeating it every 10 minutes would bury the scan in noise.
const metaLogged = new Set();
const _resetMetaLog = () => metaLogged.clear();

// The adaptive part of "log raw meta once, adapt, never guess": every key NAME plus the values of
// the keys that could plausibly be the sha. Author emails and commit messages are not reproduced.
function describeMeta(meta) {
  if (!meta || typeof meta !== 'object') return String(meta);
  const keys = Object.keys(meta);
  const interesting = keys
    .filter((k) => /sha|commit(id)?$|ref$|branch/i.test(k))
    .map((k) => `${k}=${String(meta[k]).slice(0, 60)}`);
  return `keys[${keys.join(',')}]${interesting.length ? ` ${interesting.join(' ')}` : ''}`;
}

// ---- config -------------------------------------------------------------------------------------

// §M1 key names are CANONICAL: {vercelTeamId, projectId, target, tokenRef} plus the optional
// `gitBranch`. No aliases are accepted — a config written against a guessed key name must fail
// loudly here rather than probe the wrong project and report parity against it. `gitBranch` extends
// that canonical set deliberately (documented in radar/config.example.json) and is the ONLY way to
// express the branch dimension; it is optional, and absent it means "unfiltered", never "develop".
function normalizeEnvConfig(raw, repoId, env) {
  const where = `${repoId}.deploy.${env}`;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where}: not an object` };

  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (kind === 'vercel') {
    const cfg = {
      kind, env, repoId,
      vercelTeamId: typeof raw.vercelTeamId === 'string' ? raw.vercelTeamId.trim() : '',
      projectId: typeof raw.projectId === 'string' ? raw.projectId.trim() : '',
      target: typeof raw.target === 'string' && raw.target.trim() ? raw.target.trim() : 'production',
      tokenRef: typeof raw.tokenRef === 'string' ? raw.tokenRef.trim() : '',
      // OPTIONAL. Absent (or blank) is null, which means "no branch filter" — never a defaulted
      // branch name. Guessing `develop` here would reintroduce the exact silent-wrong-answer the
      // key exists to remove, just one layer down.
      gitBranch: typeof raw.gitBranch === 'string' && raw.gitBranch.trim() ? raw.gitBranch.trim() : null,
    };
    if (!cfg.projectId) return { error: `${where}: missing projectId (take it from the repo's .vercel/project.json)` };
    if (!cfg.tokenRef) return { error: `${where}: missing tokenRef (the NAME of the env var holding the token)` };
    return { cfg };
  }

  if (kind === 'ssh-docker') {
    const cfg = {
      kind, env, repoId,
      host: typeof raw.host === 'string' ? raw.host.trim() : '',
      user: typeof raw.user === 'string' && raw.user.trim() ? raw.user.trim() : null,
      container: typeof raw.container === 'string' ? raw.container.trim() : '',
      sudo: raw.sudo === true,
    };
    if (!cfg.host) return { error: `${where}: missing host` };
    if (!cfg.container) return { error: `${where}: missing container` };
    if (!SAFE_HOST.test(cfg.host)) return { error: `${where}: host is not a plain hostname` };
    if (cfg.user && !SAFE_IDENT.test(cfg.user)) return { error: `${where}: user is not a plain identifier` };
    if (!SAFE_IDENT.test(cfg.container)) return { error: `${where}: container is not a plain identifier` };
    return { cfg };
  }

  return { error: `${where}: unknown deploy kind ${JSON.stringify(raw.kind)} (expected vercel|ssh-docker)` };
}

// ---- vercel adapter ------------------------------------------------------------------------------

async function probeVercel(cfg, ctx) {
  const token = ctx.env[cfg.tokenRef];
  // A missing credential is `unauthorized`, never `stale` and never `empty`: we know exactly why we
  // cannot answer, and the fix is a credential, not a retry.
  if (!token) {
    return { status: 'unauthorized', error: `env ${cfg.tokenRef} is unset`, sha: null };
  }

  const qs = [
    `projectId=${encodeURIComponent(cfg.projectId)}`,
    cfg.vercelTeamId ? `teamId=${encodeURIComponent(cfg.vercelTeamId)}` : null,
    `target=${encodeURIComponent(cfg.target)}`,
    'state=READY',
    'limit=10',
    // The branch dimension. Vercel filters on deployment metadata with `meta-<key>=<value>`, so the
    // branch this env tracks is `meta-githubCommitRef`. Verified against the live API 2026-07-31:
    // unfiltered, app-web's preview target returns whatever built last across all branches.
    cfg.gitBranch ? `meta-githubCommitRef=${encodeURIComponent(cfg.gitBranch)}` : null,
  ].filter(Boolean).join('&');

  const r = await getJson(`${VERCEL_API}/v6/deployments?${qs}`, { authorization: `Bearer ${token}` }, ctx.timeoutMs, ctx.fetchImpl);

  if (r.kind === 'stale') return { status: 'stale', error: `vercel: ${r.error}`, sha: null };
  if (r.status === 401 || r.status === 403) {
    // The token itself must never reach the state file or a log line — only the variable NAME.
    return { status: 'unauthorized', error: `vercel ${r.status} for project ${cfg.projectId} (token from ${cfg.tokenRef})`, sha: null };
  }
  if (r.status === 429) return { status: 'stale', error: 'vercel 429 rate limited', sha: null };
  if (!r.ok) {
    const detail = r.body && r.body.error && r.body.error.message ? r.body.error.message : '';
    return { status: 'stale', error: `vercel ${r.status}${detail ? `: ${String(detail).slice(0, 120)}` : ''}`, sha: null };
  }

  const all = (r.body && Array.isArray(r.body.deployments)) ? r.body.deployments : [];
  const ready = all
    .filter((d) => d && (d.readyState === 'READY' || d.state === 'READY'))
    .sort((a, b) => (Number(b.created || b.createdAt || 0) - Number(a.created || a.createdAt || 0)));

  // THE SEAM (war-game M5): a wrong teamId returns 200 with an empty list. That is `empty`, which
  // renders unknown. It is never parity, and it never reaches the ancestry code below.
  if (ready.length === 0) {
    // A misspelled `gitBranch` lands here rather than on some other branch's deployment, so name it:
    // "no READY preview deployment on develp" is a one-glance fix, "no deployments" is a mystery.
    const on = cfg.gitBranch ? ` on ${cfg.gitBranch}` : '';
    return { status: 'empty', error: null, sha: null, branchFilter: cfg.gitBranch, note: `no READY ${cfg.target} deployment${on} for project ${cfg.projectId}` };
  }

  const d = ready[0];
  const meta = d.meta || {};
  const sha = typeof meta.githubCommitSha === 'string' && SHA_RE.test(meta.githubCommitSha) ? meta.githubCommitSha : null;

  const out = {
    status: 'ok',
    error: null,
    sha,
    shaMissing: sha === null,
    deploymentId: d.uid || null,
    deployedAt: iso(Number(d.created || d.createdAt)) ,
    author: meta.githubCommitAuthorLogin || meta.githubCommitAuthorName || (d.creator && d.creator.githubLogin) || (d.creator && d.creator.username) || null,
    ref: meta.githubCommitRef || null,
    url: d.url ? `https://${d.url}` : null,
    // What the query actually constrained, so "which branch is this?" is answerable from state
    // alone rather than by re-reading the config.
    branchFilter: cfg.gitBranch,
  };

  if (sha === null) {
    // Adapt, never guess: name every field Vercel actually sent so the fix is a one-line change
    // rather than another round of speculation.
    const key = `${cfg.repoId}:${cfg.env}`;
    if (!metaLogged.has(key)) {
      metaLogged.add(key);
      out.metaLog = `${key}: deployment ${out.deploymentId} has no usable meta.githubCommitSha — raw meta ${describeMeta(meta)}`;
    }
    out.note = 'deployment found but no commit sha — every ancestry answer stays unknown';
  }
  return out;
}

// ---- ssh-docker adapter ---------------------------------------------------------------------------

const REVISION_LABEL = 'org.opencontainers.image.revision';

function sshTarget(cfg) { return cfg.user ? `${cfg.user}@${cfg.host}` : cfg.host; }

function dockerCommand(cfg, format) {
  return `${cfg.sudo ? 'sudo -n ' : ''}docker inspect --format '${format}' ${cfg.container}`;
}

async function probeSshDocker(cfg, ctx) {
  const run = async (format) => ctx.sshExec({
    target: sshTarget(cfg),
    command: dockerCommand(cfg, format),
    timeoutMs: ctx.timeoutMs,
  });

  let r;
  try {
    r = await run(`{{index .Config.Labels "${REVISION_LABEL}"}}`);
  } catch (e) {
    return { status: 'stale', error: `ssh: ${e && e.message ? e.message : String(e)}`, sha: null };
  }

  const stderr = String(r.stderr || '');
  if (!r.ok) {
    if (/permission denied|publickey|authentication fail/i.test(stderr)) {
      return { status: 'unauthorized', error: `ssh ${sshTarget(cfg)}: permission denied`, sha: null };
    }
    // Docker itself answering "that container does not exist" is a successful probe of an absent
    // deployment — `empty`, not a failure to observe.
    if (/no such (object|container)/i.test(stderr)) {
      return { status: 'empty', error: null, sha: null, note: `container ${cfg.container} not running on ${cfg.host}` };
    }
    return { status: 'stale', error: `ssh ${sshTarget(cfg)}: ${(stderr.split('\n')[0] || 'command failed').slice(0, 160)}`, sha: null };
  }

  const label = String(r.stdout || '').trim();
  if (label && label !== DOCKER_NO_VALUE && SHA_RE.test(label)) {
    return { status: 'ok', error: null, sha: label, shaMissing: false, deploymentId: null, deployedAt: null, author: null, ref: null, url: null };
  }

  // Fallback: the image tag. `:latest` carries no revision, which is exactly the situation the
  // "unknown beats false green" rule exists for.
  let tag = null;
  try {
    const img = await run('{{.Config.Image}}');
    if (img.ok) tag = String(img.stdout || '').trim() || null;
  } catch (_) { tag = null; }

  const fromTag = tag ? (tag.split(':').pop() || '') : '';
  if (fromTag && SHA_RE.test(fromTag) && fromTag !== 'latest') {
    return { status: 'ok', error: null, sha: fromTag, shaMissing: false, deploymentId: null, deployedAt: null, author: null, ref: null, url: tag };
  }

  const key = `${cfg.repoId}:${cfg.env}`;
  const out = {
    status: 'ok', error: null, sha: null, shaMissing: true,
    deploymentId: null, deployedAt: null, author: null, ref: null, url: tag,
    note: `container ${cfg.container} carries no ${REVISION_LABEL} label${tag ? ` and image tag ${tag} is not a revision` : ''} — ancestry stays unknown`,
  };
  if (!metaLogged.has(key)) { metaLogged.add(key); out.metaLog = `${key}: ${out.note}`; }
  return out;
}

// ---- the unfiltered-preview guard --------------------------------------------------------------------

// Can this probe's sha be trusted to be the branch this env tracks?
//
// Returns null when the question does not apply (not vercel, single-branch target, filter present,
// or the probe never produced a deployment) — the caller then behaves exactly as it always has,
// which is what keeps site/admin/docs bit-for-bit unaffected.
//
// Returns { expected, got } when an unfiltered multi-branch query answered with a deployment we
// cannot show came from `expected`. The caller reports the deployment and its branch and declines
// every derived judgement. `got: null` (no githubCommitRef at all) is a mismatch too: unprovable is
// not the same as fine.
function branchGuard(cfg, probe, expectedBranch) {
  if (!cfg || cfg.kind !== 'vercel') return null;
  if (cfg.gitBranch) return null;                       // the query was already constrained
  if (cfg.target === SINGLE_BRANCH_TARGET) return null; // production is single-branch by definition
  if (!probe || probe.status !== 'ok' || !probe.sha) return null;
  if (!expectedBranch) return null;                     // nothing to compare against
  return probe.ref === expectedBranch ? null : { expected: expectedBranch, got: probe.ref || null };
}

// ---- ancestry -------------------------------------------------------------------------------------

// Is the deployed SHA reachable from at least one local ref?
//
// This is the guard that keeps force-pushes and squash-merges out of the violation queue. It is
// deliberately NOT `cat-file -e`: after a force-push the old commit usually still exists as a
// dangling object, so an existence test would happily conclude "this commit is not on develop" and
// raise a violation for a commit nobody deployed on purpose. `--contains` asks the question we
// actually mean — can any ref reach it — and an empty answer means unknown.
async function shaReachable(repoPath, sha, timeoutMs) {
  const r = await gitIn(repoPath, ['for-each-ref', '--count=1', `--contains=${sha}`, '--format=%(refname)'], { timeoutMs });
  if (!r.ok) return false;                       // "no such commit" also lands here
  return r.stdout.trim().length > 0;
}

// Every ancestry fact for one repo/env. Returns unknowns (null), never guesses, and never sets
// ruleViolation from anything other than a merge-base test that ran and returned false.
async function computeAncestry(input) {
  const { repoPath, deployedSha, compareRef, epicBranches, timeoutMs } = input;
  const out = {
    shaKnownLocally: null,
    ruleCheck: 'unknown',
    ruleViolation: false,
    behind: null,
    compareRef: compareRef || null,
    epicBranchAncestry: {},
  };
  // Unknown inputs stop here: no repo on disk, no sha (empty/unauthorized/stale/sha-less probe).
  if (!repoPath || !deployedSha) return out;

  out.shaKnownLocally = await shaReachable(repoPath, deployedSha, timeoutMs);
  if (!out.shaKnownLocally) {
    out.note = 'deployed sha is not reachable from any local ref (force-push, squash-merge, or unfetched) — ancestry unknown';
    return out;
  }

  if (compareRef) {
    const isAncestor = await gitTest(repoPath, ['merge-base', '--is-ancestor', deployedSha, compareRef], { timeoutMs });
    if (isAncestor === true) out.ruleCheck = 'ok';
    else if (isAncestor === false) { out.ruleCheck = 'violation'; out.ruleViolation = true; }
    // isAncestor === null keeps ruleCheck 'unknown' and ruleViolation false.

    const behind = await gitIn(repoPath, ['rev-list', '--count', `${deployedSha}..${compareRef}`], { timeoutMs });
    if (behind.ok && /^\d+$/.test(behind.stdout.trim())) out.behind = Number(behind.stdout.trim());
  }

  // Epic-deployed: the branch TIP is an ancestor of what is deployed. No merge-commit archaeology.
  const pairs = await mapLimit(epicBranches, ANCESTRY_CONCURRENCY, async (b) => {
    const v = await gitTest(repoPath, ['merge-base', '--is-ancestor', b.sha, deployedSha], { timeoutMs });
    return [b.name, v];
  });
  for (const [name, v] of pairs) out.epicBranchAncestry[name] = v;

  return out;
}

// ---- module entry -----------------------------------------------------------------------------------

// Default ssh runner. Absolute binary, BatchMode (never prompt an unattended collector for a
// passphrase), and the remote command passed as ONE argv element.
function defaultSshExec(opts) {
  const { execFile } = require('child_process');
  const seconds = Math.max(1, Math.round(opts.timeoutMs / 1000));
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.min(seconds, 30)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    opts.target, opts.command,
  ];
  return new Promise((resolve) => {
    execFile('/usr/bin/ssh', args, { timeout: opts.timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      resolve({ ok: false, stdout: stdout || '', stderr: (stderr || '') || String(err.message || 'ssh failed') });
    });
  });
}

async function probeEnv(job, ctx) {
  const { cfg, repo } = job;
  const probedAt = new Date(ctx.now).toISOString();

  let probe;
  if (cfg.kind === 'vercel') probe = await probeVercel(cfg, ctx);
  else probe = await probeSshDocker(cfg, ctx);

  const epicBranches = (repo && Array.isArray(repo.branches) ? repo.branches : [])
    .filter((b) => b && !b.isDefault && b.epic && b.sha);

  // The branch this env is supposed to track: whatever the rule check compares against, falling
  // back to the §M1 default when the repo is not on disk to derive one.
  const expectedBranch = (repo && repo.compareRef)
    ? String(repo.compareRef).replace(/^origin\//, '')
    : TARGET_BRANCH[cfg.env];
  const wrongBranch = branchGuard(cfg, probe, expectedBranch);

  // A mismatch means the sha in hand belongs to some other branch, so every question ancestry would
  // answer is the wrong question. Skipping computeAncestry entirely — rather than running it and
  // discarding the result — is what makes a fabricated violation unreachable instead of merely
  // suppressed: `ruleViolation: true` is still written in exactly one place, and that place no
  // longer runs.
  const anc = wrongBranch
    ? { shaKnownLocally: null, ruleCheck: 'unknown', ruleViolation: false, behind: null, compareRef: repo ? repo.compareRef : null, epicBranchAncestry: {} }
    : await computeAncestry({
      repoPath: repo ? repo.path : null,
      deployedSha: probe.sha || null,
      compareRef: repo ? repo.compareRef : null,
      epicBranches,
      timeoutMs: ctx.gitTimeoutMs,
    });

  const env = {
    kind: cfg.kind,
    status: probe.status,
    sha: probe.sha || null,
    shaMissing: probe.shaMissing === true,
    shaKnownLocally: anc.shaKnownLocally,
    ruleCheck: anc.ruleCheck,
    ruleViolation: anc.ruleViolation,
    compareRef: anc.compareRef,
    epicBranchAncestry: anc.epicBranchAncestry,
    deploymentId: probe.deploymentId || null,
    deployedAt: probe.deployedAt || null,
    author: probe.author || null,
    ref: probe.ref || null,
    url: probe.url || null,
    branchFilter: probe.branchFilter === undefined ? null : probe.branchFilter,
    branchMismatch: wrongBranch ? true : false,
    probedAt,
    error: probe.error || null,
    note: probe.note || anc.note || null,
  };
  env[BEHIND_FIELD[cfg.env]] = anc.behind;

  // The author-gate rendering (spec §M3). A behind-count is a NOTE, never a violation: for
  // app-web a double-digit gap next to recent READY deployments is the silent-no-deploy detector
  // doing its job, and "fixing" it by assuming would delete the only signal that it happened.
  if (env.status === 'ok' && Number(anc.behind) > 0) {
    env.note = `behind ×${anc.behind}${env.author ? ` · last deploy by ${env.author}` : ''}`;
  }

  // A wrong-branch answer outranks the behind-count note, because the behind-count was not computed
  // and the operator needs the one-line fix rather than a number that is not there. `sha`, `ref` and
  // `url` stay populated: the point is to make the mismatch VISIBLE, not to hide the evidence.
  if (wrongBranch) {
    env.status = 'stale';
    env.error = `${cfg.target} deployment is from ${wrongBranch.got || 'an unnamed branch'}, not ${wrongBranch.expected} — set gitBranch on ${cfg.repoId}.deploy.${cfg.env} to pin it`;
    env.note = env.error;
  }

  // Age is a badge, never attention: a probe that answers with a year-old deployment has answered,
  // it just has not answered about anything current.
  const deployedMs = env.deployedAt ? Date.parse(env.deployedAt) : NaN;
  env.ageDays = Number.isFinite(deployedMs) ? Math.floor((ctx.now - deployedMs) / DAY_MS) : null;
  env.deployAgeStale = env.ageDays !== null && env.ageDays > STALE_DEPLOY_DAYS;
  if (env.deployAgeStale) env.note = `${env.note ? `${env.note} · ` : ''}deployed ${env.ageDays}d ago`;

  const warnings = [];
  if (probe.metaLog) warnings.push(probe.metaLog);
  if (probe.status !== 'ok' && probe.status !== 'empty') warnings.push(`${cfg.repoId}.${cfg.env}: ${probe.error}`);
  if (wrongBranch) warnings.push(`${cfg.repoId}.${cfg.env}: ${env.error}`);
  // The latent case: unfiltered, but the answer happened to land on the right branch today. That is
  // luck, not correctness, so say so — once per repo:env per process, like the meta log, because it
  // is a config fix and not a per-scan event.
  if (!wrongBranch && cfg.kind === 'vercel' && !cfg.gitBranch && cfg.target !== SINGLE_BRANCH_TARGET && probe.status === 'ok') {
    const key = `branch:${cfg.repoId}:${cfg.env}`;
    if (!metaLogged.has(key)) {
      metaLogged.add(key);
      warnings.push(`${cfg.repoId}.${cfg.env}: target ${cfg.target} has no gitBranch filter — this scan matched ${expectedBranch} by luck, not by query`);
    }
  }

  return { repoId: cfg.repoId, env: cfg.env, value: env, warnings };
}

async function collectDeploy(opts) {
  const config = opts.config || {};
  const now = opts.now == null ? Date.now() : opts.now;
  const observedAt = new Date(now).toISOString();
  const gitRepos = (opts.fragments && opts.fragments.git && opts.fragments.git.repos) || {};

  const ctx = {
    now,
    env: opts.env || process.env,
    fetchImpl: opts.fetchImpl || null,
    sshExec: opts.sshExec || defaultSshExec,
    timeoutMs: (config.timeouts && config.timeouts.deployMs) || 10000,
    gitTimeoutMs: 30000,
  };

  const warnings = [];
  const jobs = [];

  for (const repo of (Array.isArray(config.repos) ? config.repos : [])) {
    const raw = repo && repo.deploy;
    if (!raw || typeof raw !== 'object') continue;
    const gitRepo = gitRepos[repo.id] || null;
    for (const env of ENVS) {
      const n = normalizeEnvConfig(raw[env], repo.id, env);
      if (!n) continue;
      if (n.error) { warnings.push(n.error); continue; }
      // A repo with no develop branch compares dev against main (spec §M1). `defaultBranches` in
      // the git fragment is keyed by branch name with a sha (or null) as the value.
      const defaults = (gitRepo && gitRepo.defaultBranches) || {};
      const want = TARGET_BRANCH[env];
      const compareBranch = Object.prototype.hasOwnProperty.call(defaults, want)
        ? want
        : (env === 'dev' && Object.prototype.hasOwnProperty.call(defaults, 'main') ? 'main' : null);
      jobs.push({
        cfg: n.cfg,
        repo: gitRepo ? { path: gitRepo.path, branches: gitRepo.branches, compareRef: compareBranch ? `origin/${compareBranch}` : null } : null,
      });
    }
  }

  if (jobs.length === 0) {
    const err = warnings.length ? warnings.join('; ') : null;
    return {
      fragment: { repos: {} },
      source: err ? { status: 'error', observedAt, error: err } : { status: 'disabled' },
      warnings,
    };
  }

  const results = await mapLimit(jobs, PROBE_CONCURRENCY, async (job) => {
    try {
      return await probeEnv(job, ctx);
    } catch (e) {
      // A thrown adapter is still a probe failure, which is still a badge — never a lost scan and
      // never an attention item.
      const probedAt = new Date(now).toISOString();
      const env = {
        kind: job.cfg.kind, status: 'stale', sha: null, shaMissing: false, shaKnownLocally: null,
        ruleCheck: 'unknown', ruleViolation: false, compareRef: null, epicBranchAncestry: {},
        deploymentId: null, deployedAt: null, author: null, ref: null, url: null,
        branchFilter: job.cfg.gitBranch || null, branchMismatch: false, ageDays: null, deployAgeStale: false,
        probedAt, error: `probe threw: ${e && e.message ? e.message : String(e)}`, note: null,
      };
      env[BEHIND_FIELD[job.cfg.env]] = null;
      return { repoId: job.cfg.repoId, env: job.cfg.env, value: env, warnings: [`${job.cfg.repoId}.${job.cfg.env}: ${env.error}`] };
    }
  });

  const repos = {};
  let degraded = 0;
  for (const r of results) {
    if (!repos[r.repoId]) repos[r.repoId] = {};
    repos[r.repoId][r.env] = r.value;
    for (const w of r.warnings) warnings.push(w);
    if (r.value.status === 'unauthorized' || r.value.status === 'stale') degraded++;
  }

  // Aggregate badge. `empty` is NOT degraded — it is a successful probe reporting an absence, and
  // the ladder already renders it unknown.
  let source;
  if (degraded === 0) source = { status: 'ok', observedAt };
  else if (degraded === results.length) source = { status: 'error', observedAt, error: `all ${degraded} deploy probes degraded: ${warnings[0] || 'unknown'}` };
  else source = { status: 'stale', observedAt, error: `${degraded}/${results.length} deploy probes degraded: ${warnings[0] || 'unknown'}` };

  return { fragment: { repos }, source, warnings };
}

module.exports = {
  collectDeploy,
  normalizeEnvConfig,
  probeVercel,
  probeSshDocker,
  computeAncestry,
  shaReachable,
  branchGuard,
  describeMeta,
  defaultSshExec,
  _resetMetaLog,
  VERCEL_API, ENVS, TARGET_BRANCH, BEHIND_FIELD, REVISION_LABEL, SHA_RE,
  SINGLE_BRANCH_TARGET, STALE_DEPLOY_DAYS,
};
