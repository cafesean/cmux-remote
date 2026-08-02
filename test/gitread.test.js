'use strict';
// p8 STORY-002 — gitread.js against REAL git fixtures in a NESTED layout. Nothing here mocks
// git's output; a flat fixture would let the scope tests pass without testing scope.
//
// Layout (built once):
//   base/parent            repo, .gitignore '*'  — the anchor
//   base/parent/child      nested dirty repo     — the containment case
//   base/parent/crafted    dir with a .git FILE  -> base/outside  — the measured escape
//   base/parent/wt-in      linked worktree of parent (in scope)
//   base/parent/wt-out     linked worktree of base/outside (metadata escapes)
//   base/parent/private-child  repo the fs jail refuses (U19)
//   base/parent-2          sibling-prefix repo   — /a/repo-2 vs /a/repo
//   base/outside           repo with a secret    — never disclosed
//   base/space␣            toplevel ending in a space (U14)
//   base/bad\nname         interior-newline toplevel (U14)
//   base/unborn            fresh init
const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createGitRead, classifyBreadth, parseMounts, metadataPaths, parseAlternates,
  siblingAuthorized, assignsAttributeDriver, unboundedAttributeSource, validateOperand,
  validateMessage, validatePaths, syncBlockedReasons, readGateFile, PLATFORM_DENY, ANCHOR_TTL_MS, NEUTRALISERS,
  COMMAND_TEMPLATES, EMPTY_TREE_SHA1, ALTERNATES_MAX_DEPTH,
  GATE_READ_MAX_BYTES, METADATA_UNREADABLE, IN_PROGRESS_STATES, IN_PROGRESS_KEYS } = require('../gitread');
const { createGitPanel, isInside, shellQuote } = require('../gitpanel');
const { GIT_BIN } = require('../lib/gitcmd');
const { g } = require('./helpers/git-fixture');

// A real runner with gitread's sanitized-base semantics, plus a per-call record for the env
// assertions. (The DEFAULT runner's own sanitization is proven separately, without injection.)
function makeRecordingRun() {
  const log = [];
  async function run(dir, args, opts) {
    const o = opts || {};
    log.push({ dir, args: args.slice(), env: o.env || null, timeoutMs: o.timeoutMs == null ? null : o.timeoutMs });
    const base = {};
    for (const k of Object.keys(process.env)) if (!k.startsWith('GIT_')) base[k] = process.env[k];
    Object.assign(base, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ASKPASS: '', LC_ALL: 'C' }, o.env || {});
    return new Promise((resolve) => {
      execFile(GIT_BIN, ['-C', dir].concat(args),
        { timeout: o.timeoutMs == null ? 20000 : o.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: base },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '', timedOut: false });
          resolve({ ok: false, code: typeof err.code === 'number' ? err.code : null, stdout: stdout || '',
            stderr: (stderr || '').trim() || String(err.message), timedOut: err.killed === true });
        });
    });
  }
  return { run, log };
}

// RULE 3 (v3.4): every gitread spawn carries the neutralisers, prepended in ONE wrapper ABOVE the
// injected seam — so the recording runner sees them too. `bare()` ASSERTS that prefix and returns
// the caller's own argv, which is what keeps every argv assertion below a positive shape check
// instead of a matcher that silently stops matching (specs.md §3.3: "neither is a test failure").
const ATTR_BOUND = /^--attr-source=(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TUPLE_TIMEOUT_MS_EXPECTED = 6000;   // gitpanel.js:94, NOT gitcmd's 20000 default
function bare(args, label) {
  assert.deepEqual(args.slice(0, NEUTRALISERS.length), [...NEUTRALISERS],
    `${label || ''} neutraliser prefix on \`${args.join(' ')}\``);
  assert.ok(ATTR_BOUND.test(args[NEUTRALISERS.length]),
    `${label || ''} attribute-stack bound on \`${args.join(' ')}\``);
  return args.slice(NEUTRALISERS.length + 1);
}
// The subcommand a recorded call actually ran, neutralisers stripped.
const verb = (c) => bare(c.args)[0];

const jailFactory = (roots) => async (p) => {
  const real = await fsp.realpath(p);
  for (const r of roots) if (real === r || real.startsWith(r + path.sep)) return real;
  throw new Error('outside_root');
};

const MOUNT_TEXT = '/dev/disk3s1 on / (apfs, sealed, local, read-only, journaled)\n';
const DENY_NO_PRIVATE = PLATFORM_DENY.filter((d) => d !== '/private');   // fixtures live under /private

let F = null;   // the fixture tree, built once

async function buildFixture() {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gitread-')));
  const mk = async (rel) => { const p = path.join(base, rel); await fsp.mkdir(p, { recursive: true }); return p; };

  const parent = await mk('parent');
  await g(base, ['init', '-q', '-b', 'main', parent]);
  await fsp.writeFile(path.join(parent, '.gitignore'), '*\n');
  await fsp.writeFile(path.join(parent, 'p.txt'), 'p\n');
  await g(parent, ['add', '-f', '.gitignore', 'p.txt']);
  await g(parent, ['commit', '-q', '-m', 'parent root']);
  // A REAL second branch whose name contains a dash. STORY-004's operand rule is "leading dash",
  // not "dash", and NEW-C4 makes the ref-taking verbs prove their operand against the repo — so
  // that arm needs a branch that actually exists rather than a plausible string.
  await g(parent, ['branch', 'feature/a-b']);
  await fsp.mkdir(path.join(parent, 'src', 'server'), { recursive: true });

  const outside = await mk('outside');
  await g(base, ['init', '-q', '-b', 'main', outside]);
  await fsp.writeFile(path.join(outside, 'external-secret.txt'), 'SECRET\n');
  await g(outside, ['add', '-A']);
  await g(outside, ['commit', '-q', '-m', 'outside root']);
  await fsp.appendFile(path.join(outside, 'external-secret.txt'), 'DIRTY\n');

  const child = await mk('parent/child');
  await g(base, ['init', '-q', '-b', 'main', child]);
  await fsp.writeFile(path.join(child, 'c.txt'), 'c\n');
  await g(child, ['add', '-A']);
  await g(child, ['commit', '-q', '-m', 'child root']);
  await fsp.writeFile(path.join(child, 'dirty.txt'), 'x\n');   // untracked -> dirty

  const crafted = await mk('parent/crafted');
  await fsp.writeFile(path.join(crafted, '.git'), `gitdir: ${outside}/.git\n`);

  const privChild = await mk('parent/private-child');
  await g(base, ['init', '-q', '-b', 'main', privChild]);
  await fsp.writeFile(path.join(privChild, 'x.txt'), 'x\n');
  await g(privChild, ['add', '-A']);
  await g(privChild, ['commit', '-q', '-m', 'priv root']);

  const sib = await mk('parent-2');
  await g(base, ['init', '-q', '-b', 'main', sib]);
  await fsp.writeFile(path.join(sib, 's.txt'), 's\n');
  await g(sib, ['add', '-A']);
  await g(sib, ['commit', '-q', '-m', 'sib root']);

  await g(parent, ['worktree', 'add', '-q', path.join(parent, 'wt-in'), '-b', 'wt-in-branch']);
  await g(outside, ['worktree', 'add', '-q', path.join(parent, 'wt-out'), '-b', 'wt-out-branch']);

  const spaceTop = path.join(base, 'space ');
  await fsp.mkdir(spaceTop);
  await g(base, ['init', '-q', '-b', 'main', spaceTop]);
  await fsp.writeFile(path.join(spaceTop, 'a.txt'), 'a\n');
  await g(spaceTop, ['add', '-A']);
  await g(spaceTop, ['commit', '-q', '-m', 'space root']);

  const nlTop = path.join(base, 'bad\nname');
  await fsp.mkdir(nlTop);
  await g(base, ['init', '-q', '-b', 'main', nlTop]);
  await fsp.writeFile(path.join(nlTop, 'n.txt'), 'n\n');
  await g(nlTop, ['add', '-A']);
  await g(nlTop, ['commit', '-q', '-m', 'nl root']);

  const unborn = await mk('unborn');
  await g(base, ['init', '-q', '-b', 'main', unborn]);

  // ---- STORY-004 U6: toplevels whose PATH is hostile to a command line. `git -C <repo>` prints
  // the repo into the text, so the repo path is an interpolated value like any other — a space
  // splits a word, a single quote ends the quoting, and a leading dash reads as an option.
  const quoteTop = path.join(base, "it's");
  await fsp.mkdir(quoteTop);
  await g(base, ['init', '-q', '-b', 'main', quoteTop]);
  await fsp.writeFile(path.join(quoteTop, 'q.txt'), 'q\n');
  await g(quoteTop, ['add', '-A']);
  await g(quoteTop, ['commit', '-q', '-m', 'quote root']);

  const dashTop = path.join(base, '-dash');
  await fsp.mkdir(dashTop);
  await g(base, ['init', '-q', '-b', 'main', dashTop]);
  await fsp.writeFile(path.join(dashTop, 'd.txt'), 'd\n');
  await g(dashTop, ['add', '-A']);
  await g(dashTop, ['commit', '-q', '-m', 'dash root']);
  // A branch name a shell would EXECUTE. `check-ref-format` calls it well-formed; that is exactly
  // the gap shellQuote exists to cover, and it is the branch `push` will derive from HEAD.
  await g(dashTop, ['checkout', '-q', '-b', '$(id)']);

  // ---- STORY-003 probe shapes -----------------------------------------------------------------
  // All INSIDE the parent anchor, so each one reaches probe through the widened containment branch
  // rather than the anchor-top exception.
  const unbornIn = await mk('parent/unborn-in');
  await g(base, ['init', '-q', '-b', 'main', unbornIn]);

  const detached = await mk('parent/detached');
  await g(base, ['init', '-q', '-b', 'main', detached]);
  await fsp.writeFile(path.join(detached, 'd.txt'), 'd\n');
  await g(detached, ['add', '-A']);
  await g(detached, ['commit', '-q', '-m', 'detached root']);
  await g(detached, ['checkout', '-q', '--detach', 'HEAD']);

  const bare = path.join(parent, 'bare.git');
  await g(base, ['init', '--bare', '-q', '-b', 'main', bare]);

  // A REAL submodule, not a hand-built lookalike: the inner checkout's `.git` is a FILE pointing at
  // <host>/.git/modules/inner, so the whole tuple lands inside the anchor and probe must report the
  // INNER repo. (`protocol.file.allow` — git ≥ 2.38 refuses file-protocol submodules by default.)
  const innerSrc = await mk('innersrc');
  await g(base, ['init', '-q', '-b', 'main', innerSrc]);
  await fsp.writeFile(path.join(innerSrc, 'i.txt'), 'i\n');
  await g(innerSrc, ['add', '-A']);
  await g(innerSrc, ['commit', '-q', '-m', 'inner root']);
  const subHost = await mk('parent/host');
  await g(base, ['init', '-q', '-b', 'main', subHost]);
  await fsp.writeFile(path.join(subHost, 'h.txt'), 'h\n');
  await g(subHost, ['add', '-A']);
  await g(subHost, ['commit', '-q', '-m', 'host root']);
  await g(subHost, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', innerSrc, 'inner']);
  const subInner = path.join(subHost, 'inner');

  // Corruption that keeps the repo DISCOVERABLE — measured on git 2.50: the tuple read still exits
  // 0 while BOTH branch reads exit 128. This is the shape that would be dressed as `unborn` if 128
  // were treated as a signature instead of confirmed positively.
  const corrupt = await mk('parent/corrupt');
  await g(base, ['init', '-q', '-b', 'main', corrupt]);
  await fsp.writeFile(path.join(corrupt, 'c.txt'), 'c\n');
  await g(corrupt, ['add', '-A']);
  await g(corrupt, ['commit', '-q', '-m', 'corrupt root']);
  await fsp.writeFile(path.join(corrupt, '.git', 'HEAD'), 'ref: refs/heads/..bad\n');

  // Many branches: the read-route fan-out that must stay inside the SAME width-2 bound (U17).
  const manyBranch = await mk('parent/manybranch');
  await g(base, ['init', '-q', '-b', 'main', manyBranch]);
  await fsp.writeFile(path.join(manyBranch, 'm.txt'), 'm\n');
  await g(manyBranch, ['add', '-A']);
  await g(manyBranch, ['commit', '-q', '-m', 'many root']);
  for (let i = 0; i < 8; i++) await g(manyBranch, ['branch', `b${i}`]);

  // ============ STORY-002 v3.4 — rules 3, 4 and 5 =============================================

  // ---- RULE 3 (U23): a repo that configures programs, every vector round 8 and the red-team found.
  // Marker scripts and their drop box live OUTSIDE the repo, so a marker can never be mistaken for
  // repo dirt. `pass.sh` copies stdin to stdout so the command CONTINUES and later drivers are
  // reached (a clean filter that swallows content aborts git before textconv ever runs — measured).
  const evilBin = await mk('evil-bin');
  const evilMarkers = await mk('evil-markers');
  const passSh = path.join(evilBin, 'pass.sh');
  const quietSh = path.join(evilBin, 'quiet.sh');
  // $1 names the marker. A CLEAN filter gets content on stdin; a TEXTCONV driver gets the file as
  // an argument and an stdin it must never read — `cat` with no operand would block on the parent's
  // inherited stdin forever, which is a hung test, not a failing one.
  await fsp.writeFile(passSh,
    `#!/bin/sh\n: > "${evilMarkers}/$1"\nif [ -n "$2" ]; then cat "$2"; else cat; fi\n`, { mode: 0o755 });
  await fsp.writeFile(quietSh, `#!/bin/sh\n: > "${evilMarkers}/$1"\nexit 0\n`, { mode: 0o755 });

  const evil = await mk('parent/evil');
  await g(base, ['init', '-q', '-b', 'main', evil]);
  await fsp.writeFile(path.join(evil, '.gitattributes'), 'a.txt filter=fclean diff=dtc\nb.txt filter=fproc\n');
  await fsp.mkdir(path.join(evil, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(evil, 'sub', '.gitattributes'), 'n.txt filter=fnest\n');
  await fsp.writeFile(path.join(evil, 'a.txt'), 'aaaa\n');
  await fsp.writeFile(path.join(evil, 'b.txt'), 'bbbb\n');
  await fsp.writeFile(path.join(evil, 'sub', 'n.txt'), 'nnnn\n');
  await g(evil, ['add', '-A']);
  await g(evil, ['commit', '-q', '-m', 'evil root']);
  const evilIndex = path.join(base, 'evil.index.pristine');
  await fsp.copyFile(path.join(evil, '.git', 'index'), evilIndex);
  // Armed only AFTER the commit: the fixture is a repo REACHED BY BROWSING, not one we built armed.
  for (const [k, v] of [
    ['core.fsmonitor', `${quietSh} FSMONITOR`],
    ['diff.external', `${quietSh} DIFF_EXTERNAL`],
    ['diff.dtc.textconv', `${passSh} TEXTCONV`],
    ['filter.fclean.clean', `${passSh} CLEAN`],
    ['filter.fproc.process', `${quietSh} PROCESS`],
    ['filter.fnest.clean', `${passSh} NESTED`],
  ]) await g(evil, ['config', k, v]);

  // ---- RULE 3, the FOURTH DOOR (U26): `<commonDir>/info/attributes` — the attribute layer that
  // `--attr-source` does not bound. Its own marker drop box and its own driver script, so these
  // arms can never be confused with armEvil's, and one arm cannot leave state in another.
  const attrBin = await mk('attr-bin');
  const attrMarkers = await mk('attr-markers');
  const attrPass = path.join(attrBin, 'pass.sh');
  await fsp.writeFile(attrPass,
    `#!/bin/sh\n: > "${attrMarkers}/$1"\nif [ -n "$2" ]; then cat "$2"; else cat; fi\n`, { mode: 0o755 });

  // Every arm is the SAME repo shape and differs only in what `info/attributes` says — so the
  // admitted arms are controls for the refused ones rather than differently-built repos. Config and
  // info/attributes are written AFTER the commit: a repo REACHED BY BROWSING, not one built armed.
  const attrRepo = async (rel, info, config, treeAttr) => {
    const p = await mk(rel);
    await g(base, ['init', '-q', '-b', 'main', p]);
    if (treeAttr != null) await fsp.writeFile(path.join(p, '.gitattributes'), treeAttr);
    await fsp.writeFile(path.join(p, 'f.txt'), 'aaaa\n');
    await g(p, ['add', '-A']);
    await g(p, ['commit', '-q', '-m', 'attr root']);
    for (const [k, v] of config) await g(p, ['config', k, v]);
    if (info != null) {
      await fsp.mkdir(path.join(p, '.git', 'info'), { recursive: true });
      await fsp.writeFile(path.join(p, '.git', 'info', 'attributes'), info);
    }
    return p;
  };
  const CLEAN_DRIVER = [['filter.ev.clean', `${attrPass} ATTR_CLEAN`]];
  const attrEvil = await attrRepo('parent/attr-evil', 'f.txt filter=ev\n', CLEAN_DRIVER);
  // The `diff=` half. MEASURED: today's `diff` call site suppresses it with --no-ext-diff and
  // --no-textconv — but those are SUBCOMMAND flags, so a route that omits them (STORY-004/005) is
  // exposed. Refusing the layer is what makes "new routes inherit rule 3" true by construction.
  const attrDiffDriver = await attrRepo('parent/attr-diffdriver', 'f.txt diff=dtc\n',
    [['diff.dtc.textconv', `${attrPass} ATTR_TEXTCONV`], ['diff.dtc.command', `${attrPass} ATTR_EXTCMD`]]);
  const attrNoDriver = await attrRepo('parent/attr-nodriver', '* -text\nf.txt diff\n', CLEAN_DRIVER);
  const attrCommented = await attrRepo('parent/attr-commented', '# f.txt filter=ev\n', CLEAN_DRIVER);
  // The MACRO arm: the driver token lives only in the TREE's top-level `.gitattributes`, which
  // `--attr-source` DOES bound; info/attributes merely applies the macro and carries no token.
  const attrMacro = await attrRepo('parent/attr-macro', 'f.txt evil\n', CLEAN_DRIVER, '[attr]evil filter=ev\n');

  // ---- RULE 4 (U24): object stores that escape, and ones that legitimately do not.
  const outsideObjects = path.join(outside, '.git', 'objects');
  const outsideOid = (await g(outside, ['rev-parse', 'HEAD'])).trim();
  const writeAlternates = async (repo, body) => {
    await fsp.mkdir(path.join(repo, '.git', 'objects', 'info'), { recursive: true });
    await fsp.writeFile(path.join(repo, '.git', 'objects', 'info', 'alternates'), body);
  };
  const initAt = async (rel) => {
    const p = await mk(rel);
    await g(base, ['init', '-q', '-b', 'main', p]);
    await fsp.writeFile(path.join(p, 'f.txt'), 'f\n');
    await g(p, ['add', '-A']);
    await g(p, ['commit', '-q', '-m', 'root']);
    return p;
  };

  // The escape itself: tuple wholly inside the union, object store outside it. HEAD is pointed at
  // the OUTSIDE commit so the disclosure is real — status names its oid and its tracked filename.
  const altOut = await initAt('parent/alt-out');
  await writeAlternates(altOut, `${outsideObjects}\n`);
  await fsp.writeFile(path.join(altOut, '.git', 'refs', 'heads', 'main'), `${outsideOid}\n`);

  const altHop = await initAt('parent/alt-hop');           // inside, but itself escaping
  await writeAlternates(altHop, `${outsideObjects}\n`);
  const altChain = await initAt('parent/alt-chain');        // inside -> inside -> outside
  await writeAlternates(altChain, `${path.join(altHop, '.git', 'objects')}\n`);

  const altCycA = await initAt('parent/alt-cyc-a');         // a -> b -> a: must terminate, not hang
  const altCycB = await initAt('parent/alt-cyc-b');
  await writeAlternates(altCycA, `${path.join(altCycB, '.git', 'objects')}\n`);
  await writeAlternates(altCycB, `${path.join(altCycA, '.git', 'objects')}\n`);

  const altRel = await initAt('parent/alt-rel');            // RELATIVE, resolved against the objects dir
  const relEscape = path.relative(path.join(altRel, '.git', 'objects'), outsideObjects);
  await writeAlternates(altRel, `${relEscape}\n`);

  const altPlain = await initAt('parent/alt-plain');        // an ordinary in-union store
  const altIn = await initAt('parent/alt-in');              // COMMENT-BEARING arm, stays inside
  await writeAlternates(altIn, `# a comment line, which is legal grammar\n\n${path.join(altPlain, '.git', 'objects')}\n`);
  const altInWt = path.join(parent, 'alt-in-wt');           // LINKED-WORKTREE arm: <gitDir>/objects is ABSENT
  await g(altIn, ['worktree', 'add', '-q', altInWt, '-b', 'alt-in-wt-branch']);

  // ---- RULE 5 (U25): a linked worktree parked OUTSIDE every narrow anchor.
  const wtFar = path.join(base, 'wt-far');
  await g(parent, ['worktree', 'add', '-q', wtFar, '-b', 'wt-far-branch']);
  await fsp.appendFile(path.join(wtFar, 'p.txt'), 'far-dirt\n');   // TRACKED: `.gitignore *` hides untracked

  // ---- U11a (a): a repo whose `worktree list --porcelain` really emits a `bare` stanza.
  const bareMain = path.join(parent, 'bare-main.git');
  await g(base, ['clone', '--bare', '-q', sib, bareMain]);
  const bareWt = path.join(parent, 'bare-wt');
  await g(bareMain, ['worktree', 'add', '-q', bareWt, '-b', 'bare-wt-branch']);

  // ---- U11a (b)/(c): a main repo with a linked worktree beside it, isolated from `parent`.
  const mainB = await initAt('parent/mainb');
  const mainBWt = path.join(parent, 'mainb-wt');
  await g(mainB, ['worktree', 'add', '-q', mainBWt, '-b', 'mainb-wt-branch']);
  await fsp.appendFile(path.join(mainB, 'f.txt'), 'main-dirt\n');   // the MAIN stanza is the dirty one

  // ---- RULE 3: a SHA256 repo. --attr-source is validated by hash LENGTH, so a hardcoded sha1
  // empty tree makes every read here `fatal: bad --attr-source` — fail-closed, and unbrowsable.
  const sha256Repo = path.join(parent, 'sha256');
  const s256Init = await g(base, ['init', '-q', '-b', 'main', '--object-format=sha256', sha256Repo])
    .then(() => true, () => false);
  if (s256Init) {
    // A .gitattributes is required for the arm to bite: MEASURED, git validates --attr-source
    // LAZILY — only when the attribute stack is actually consulted. A repo with no attributes file
    // never resolves it, so a wrong-length oid would slip through unnoticed there.
    await fsp.writeFile(path.join(sha256Repo, '.gitattributes'), '* -text\n');
    await fsp.writeFile(path.join(sha256Repo, 's.txt'), 'sss\n');
    await g(sha256Repo, ['add', '-A']);
    await g(sha256Repo, ['commit', '-q', '-m', 'sha256 root']);
    await fsp.appendFile(path.join(sha256Repo, 's.txt'), 'dirt\n');
  }

  // ---- U11a (d): an UNBORN linked sibling — HEAD on a branch that does not exist yet.
  const wtUnborn = path.join(parent, 'wt-unborn');
  await g(parent, ['worktree', 'add', '-q', wtUnborn, '-b', 'wt-unborn-branch']);
  await g(wtUnborn, ['checkout', '-q', '--orphan', 'fresh']);

  return { base, parent, child, crafted, privChild, sib, outside, spaceTop, nlTop, unborn,
    quoteTop, dashTop,
    unbornIn, detached, bare, subHost, subInner, corrupt, manyBranch,
    evil, evilMarkers, evilIndex, outsideOid,
    attrMarkers, attrEvil, attrDiffDriver, attrNoDriver, attrCommented, attrMacro,
    altOut, altHop, altChain, altCycA, altCycB, altRel, altPlain, altIn, altInWt,
    wtFar, bareMain, bareWt, mainB, mainBWt, wtUnborn, sha256Repo: s256Init ? sha256Repo : null,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

test.before(async () => { F = await buildFixture(); });
test.after(async () => { if (F) await F.cleanup(); });

// One factory shape for most tests: parent anchored, jail rooted at base, deny excludes /private.
function makeRead(overrides) {
  const rec = makeRecordingRun();
  const o = Object.assign({
    workspaceCwds: async () => [{ label: 't', path: F.parent }],
    run: rec.run,
    jail: jailFactory([F.base]),
    assertRepo: async () => { throw new Error('no'); },
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  }, overrides || {});
  return { gr: createGitRead(o), rec };
}

const rejects403 = (p) => p.then(
  () => { throw new Error('expected refusal'); },
  (e) => { assert.equal(e.name, 'GitPanelError'); assert.equal(e.status, 403); assert.equal(e.message, 'unknown_repo'); },
);

test('U1: /a/repo-2 is not inside /a/repo — segment-wise, via the imported helper', () => {
  assert.equal(isInside('/a/repo', '/a/repo-2'), false);
  assert.equal(isInside('/a/repo', '/a/repo/x'), true);
});

test('U2: a symlinked spelling resolves to the same repo; the tuple is the realpath tuple', async () => {
  const alias = path.join(F.base, 'alias');
  await fsp.symlink(F.parent, alias);
  const { gr } = makeRead();
  const t = await gr.authorizeRead(alias);
  assert.equal(t.top, F.parent);
  assert.equal(t.gitDir, path.join(F.parent, '.git'));
  await fsp.rm(alias);
});

test('U3: a repo outside every discovered toplevel is refused by the read gate AND the untouched write gate', async () => {
  const { gr } = makeRead();
  await rejects403(gr.authorizeRead(F.outside));
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.parent }], writesEnabled: true });
  await assert.rejects(panel.write('stage', F.outside, ['external-secret.txt']),
    (e) => e.code === 'unknown_repo' && e.status === 403);
});

test('U4: anchor semantics + the full breadth matrix', async () => {
  // A cwd at <repo>/src/server anchors <repo>; a non-repo cwd anchors nothing.
  const { gr } = makeRead({ workspaceCwds: async () => [
    { label: 'a', path: path.join(F.parent, 'src', 'server') },
    { label: 'b', path: path.join(F.base) },              // base is not a repo
  ] });
  const t = await gr.authorizeRead(F.parent);
  assert.equal(t.top, F.parent);
  await rejects403(gr.authorizeRead(F.sib));              // nothing anchored base itself

  // The pure classifier, every broad row of §3.4. The home and mount literals are PLACEHOLDERS —
  // the classifier is pure and reads only the shape of a path, so nothing here needs to name a real
  // machine's layout (and this repo is public).
  const home = '/vol0/user1';
  const ctx = { mounts: new Set(['/', '/System/Volumes/Data']), home, deny: PLATFORM_DENY };
  assert.equal(classifyBreadth('/', ctx), 'broad', 'root');
  assert.equal(classifyBreadth('/opt2', ctx), 'broad', 'one segment');
  assert.equal(classifyBreadth('/System/Volumes/Data', ctx), 'broad', 'mount-table member');
  assert.equal(classifyBreadth('/vol0', ctx), 'broad', 'home-containing toplevel');
  assert.equal(classifyBreadth(home, ctx), 'broad', 'home itself');
  for (const real of ['/private/var', '/usr/local', '/private/tmp', '/System/Volumes/Data', '/Users/Shared']) {
    assert.equal(classifyBreadth(real, ctx), 'broad', `real target ${real}`);
  }
  for (const d of PLATFORM_DENY) assert.equal(classifyBreadth(d, ctx), 'broad', `deny row ${d}`);
  assert.equal(classifyBreadth('/Users/Shared/deep/repo', ctx), 'broad', 'inside a deny row');
  assert.equal(classifyBreadth('/vol1/disk/code/x', { ...ctx, mounts: new Set(['/', '/vol1/disk/code/x']) }), 'broad', 'synthetic same-device mount row');
  assert.equal(classifyBreadth('/vol0/user1/code/repo', ctx), 'narrow', 'deep narrow control');
  assert.equal(classifyBreadth('/vol0/user1/code/repo', { ...ctx, mounts: null }), 'broad', 'failed mounts read = all broad');

  // Seam honesty: the default deny-set is exactly the constant, and bridge.js injects none.
  assert.deepEqual([...PLATFORM_DENY],
    ['/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/opt', '/dev', '/Applications', '/cores', '/Users/Shared']);
  const bridgeSrc = await fsp.readFile(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  assert.ok(!/platformDeny/.test(bridgeSrc), 'bridge.js passes no platformDeny');
});

test('U10: the two-gate split — nested child readable, never writable; sibling-prefix and outside refused by both', async () => {
  const { gr } = makeRead();
  const t = await gr.authorizeRead(F.child);
  assert.equal(t.top, F.child);
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.parent }], writesEnabled: true });
  const list = await panel.repos();
  assert.ok(!list.some((r) => r.path === F.child), 'repos() does not list the nested child');
  await assert.rejects(panel.write('stage', F.child, ['dirty.txt']), (e) => e.status === 403);
  await rejects403(gr.authorizeRead(F.sib));
  await rejects403(gr.authorizeRead(F.outside));
});

test('U11: the tuple rule — crafted gitfile rejected with the outside index untouched; worktree rows', async () => {
  const { gr } = makeRead();
  const idxBefore = await fsp.readFile(path.join(F.outside, '.git', 'index'));
  await rejects403(gr.authorizeRead(F.crafted));
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.parent }], writesEnabled: true });
  await assert.rejects(panel.write('stage', F.crafted, ['x']), (e) => e.status === 403);
  const idxAfter = await fsp.readFile(path.join(F.outside, '.git', 'index'));
  assert.ok(idxBefore.equals(idxAfter), 'the outside index is byte-identical after both attempts');

  // A linked-worktree ANCHOR is accepted via tuple equality (its metadata is external — permitted).
  const wtIn = path.join(F.parent, 'wt-in');
  const grWt = makeRead({ workspaceCwds: async () => [{ label: 'w', path: wtIn }] }).gr;
  const tw = await grWt.authorizeRead(wtIn);
  assert.equal(tw.top, wtIn);
  assert.ok(tw.gitDir.startsWith(path.join(F.parent, '.git', 'worktrees')));

  // A worktree nested under the anchor whose main is in scope: accepted for read.
  const tIn = await gr.authorizeRead(wtIn);
  assert.equal(tIn.top, wtIn);
  // One whose main repo is OUTSIDE scope: its state belongs to the outside repo — rejected.
  await rejects403(gr.authorizeRead(path.join(F.parent, 'wt-out')));
});

test('U14: strip-one-newline parsing — space-ending survives byte-for-byte; interior-newline rejected on p8, alive on p7', async () => {
  const grSpace = makeRead({ workspaceCwds: async () => [{ label: 's', path: F.spaceTop }] }).gr;
  const t = await grSpace.authorizeRead(F.spaceTop);
  assert.equal(t.top, F.spaceTop, 'trailing space preserved — never .trim()');

  const grNl = makeRead({ workspaceCwds: async () => [{ label: 'n', path: F.nlTop }] }).gr;
  await rejects403(grNl.authorizeRead(F.nlTop));          // strict parse: ≠3 lines

  // The same fixture keeps its FULL p7 journey — listed, status-loadable, stageable.
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 'n', path: F.nlTop }], writesEnabled: true });
  const list = await panel.repos();
  assert.ok(list.some((r) => r.path === F.nlTop), 'repos() still lists the newline repo');
  const st = await panel.status(F.nlTop);
  assert.ok(!st.error && Array.isArray(st.files), 'p7 status answers');
  await fsp.writeFile(path.join(F.nlTop, 'new.txt'), 'z\n');
  const w = await panel.write('stage', F.nlTop, ['new.txt']);
  assert.equal(w.ok, true, 'p7 stage still works end to end');
});

test('U15: the anchor cache — single-flight, TTL, failure closed, hanging mount bounded', async () => {
  const clock = { t: 1000 };
  let cwdsCalls = 0;
  let mountsCalls = 0;
  let failCwds = false;
  const cwdInside = path.join(F.parent, 'src', 'server');   // distinct from the anchor top, so the
  const rec = makeRecordingRun();                           // discovery spawn is countable apart
  const gr = createGitRead({                                // from equality-branch re-reads
    workspaceCwds: async () => { cwdsCalls++; if (failCwds) throw new Error('boom'); return [{ label: 't', path: cwdInside }]; },
    run: rec.run,
    jail: jailFactory([F.base]),
    mounts: async () => { mountsCalls++; return MOUNT_TEXT; },
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: () => clock.t,
    platformDeny: DENY_NO_PRIVATE,
  });

  // Single-flight: two concurrent authorizations, one discovery.
  await Promise.all([gr.authorizeRead(F.child), gr.authorizeRead(F.parent)]);
  assert.equal(cwdsCalls, 1, 'one discovery for concurrent callers');
  assert.equal(mountsCalls, 1, 'exactly one mount read');
  const coldTupleSpawns = rec.log.filter((c) => c.args.includes('--show-toplevel') && c.dir === cwdInside && !c.env).length;
  assert.equal(coldTupleSpawns, 1, 'cold cost: one tuple spawn per workspace cwd');

  // Within TTL: no re-enumeration.
  clock.t += ANCHOR_TTL_MS - 1;
  await gr.authorizeRead(F.parent);
  assert.equal(cwdsCalls, 1, 'inside the TTL the read gate does not re-enumerate');

  // After TTL: re-enumeration. (No miss-refresh exists — expiry is the only path.)
  clock.t += 2;
  await gr.authorizeRead(F.parent);
  assert.equal(cwdsCalls, 2, 'TTL expiry re-discovers');

  // A rejected discovery is not cached, fails closed, and the next call re-discovers.
  clock.t += ANCHOR_TTL_MS + 1;
  failCwds = true;
  await rejects403(gr.authorizeRead(F.parent));
  failCwds = false;
  await gr.authorizeRead(F.parent);
  assert.equal(cwdsCalls, 4, 'failure was not cached; the next call re-discovered');

  // A HANGING mounts read: discovery still settles (2000 ms kill), every anchor broad —
  // equality still answers, containment refuses — and a later discovery succeeds again.
  const rec2 = makeRecordingRun();
  const clock2 = { t: 0 };
  const gr2 = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: F.parent }],
    run: rec2.run,
    jail: jailFactory([F.base]),
    mounts: () => new Promise(() => {}),                  // never settles
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: () => clock2.t,
    platformDeny: DENY_NO_PRIVATE,
  });
  const t0 = Date.now();
  const t = await gr2.authorizeRead(F.parent);            // equality: works even all-broad
  assert.ok(Date.now() - t0 < 4000, 'discovery settled within the mount bound');
  assert.equal(t.top, F.parent);
  await rejects403(gr2.authorizeRead(F.child));           // containment refused: all broad
  // The single-flight handle cleared and the limiter slot came back: a fresh discovery works.
  clock2.t += ANCHOR_TTL_MS + 1;
  const t2 = await gr2.authorizeRead(F.parent);
  assert.equal(t2.top, F.parent, 'a later discovery succeeds after the hang');
});

test("U19: the jail gates every widened route, and spawns bind to the jail's return", async () => {
  // Anchor …/parent via a pane at …/parent/src/server; fs root …/parent/src; candidate refused.
  const rec = makeRecordingRun();
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: path.join(F.parent, 'src', 'server') }],
    run: rec.run,
    jail: jailFactory([path.join(F.parent, 'src')]),
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  for (const fn of ['status', 'branches', 'worktrees']) {
    await assert.rejects(gr[fn](F.privChild), (e) => e.status === 403, `${fn} refused`);
  }
  await assert.rejects(gr.diff(F.privChild, 'x.txt', false), (e) => e.status === 403, 'diff refused');
  assert.ok(!rec.log.some((c) => c.dir === F.privChild), 'no spawn ever touched the candidate');
  // The anchor top itself — OUTSIDE the fs root — still answers: the pane-in-subdir case.
  const t = await gr.authorizeRead(F.parent);
  assert.equal(t.top, F.parent);

  // Jail binding: an injected jail resolving to a DIFFERENT canonical path than the pre-jail
  // resolution — every candidate spawn names the jail's return; the unjailed target never appears.
  const rec2 = makeRecordingRun();
  const gr2 = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: F.parent }],
    run: rec2.run,
    jail: async () => F.child,                            // deferred-retarget stand-in
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  const t2 = await gr2.authorizeRead(F.privChild);
  assert.equal(t2.top, F.child, 'the tuple came from the jail-returned path');
  const candidateSpawns = rec2.log.filter((c) => c.dir === F.privChild);
  assert.equal(candidateSpawns.length, 0, 'the unjailed target never appears in the runner log');
});

test('U20: canWrite — equality true, containment false, disabled false; derived through the injected oracle', async () => {
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.parent }], writesEnabled: true });
  let oracleCalls = 0;
  const { gr } = makeRead({
    writesEnabled: true,
    assertRepo: (p) => { oracleCalls++; return panel.assertRepo(p); },
  });
  const stAnchor = await gr.status(F.parent);
  assert.equal(stAnchor.canWrite, true, 'equality anchor with writes on');
  const stChild = await gr.status(F.child);
  assert.equal(stChild.canWrite, false, 'containment-only repo');
  assert.ok(oracleCalls >= 2, 'derived through the oracle, fresh each time');

  const { gr: grOff } = makeRead({ writesEnabled: false, assertRepo: (p) => panel.assertRepo(p) });
  const stOff = await grOff.status(F.parent);
  assert.equal(stOff.canWrite, false, 'writes disabled');

  // Hint honesty: the anchor's workspace disappears between status and write — the write 403s.
  let cwds = [{ label: 't', path: F.parent }];
  const panel2 = createGitPanel({ workspaceCwds: async () => cwds, writesEnabled: true });
  cwds = [];
  await assert.rejects(panel2.write('stage', F.parent, ['p.txt']), (e) => e.status === 403);
});

test('U11a: pinning — the gate-to-body swap leaks nothing through any route; the unpinned control leaks', async () => {
  // The swap is performed by the runner seam itself, immediately before the FIRST pinned spawn of
  // EACH route runs — the tightest gate-to-body interleaving. Each route gets a fresh window: a
  // later call's own authorization re-reads the (now swapped) tuple and refuses, which is the
  // gate's ordinary crafted-gitfile behaviour, not this race.
  const swapTarget = path.join(F.child, '.git');
  const outsideOid = (await g(F.outside, ['rev-parse', 'HEAD'])).trim();
  const restore = async () => {
    try { const st = await fsp.lstat(swapTarget); if (st.isFile()) await fsp.rm(swapTarget); } catch (_) {}
    try { await fsp.rename(swapTarget + '-real', swapTarget); } catch (_) {}
  };

  const routes = [
    // probe is NOT exempt from the pin (v3.2): it is the sixth response shape this swap must not
    // move, and its two branch reads are post-gate spawns like any other route's body.
    ['probe', (gr) => gr.probe(F.child)],
    ['status', (gr) => gr.status(F.child)],
    ['branches', (gr) => gr.branches(F.child)],
    ['worktrees', (gr) => gr.worktrees(F.child)],
    ['diff', (gr) => gr.diff(F.child, 'dirty.txt', false)],
  ];
  try {
    for (const [name, call] of routes) {
      let swapped = false;
      const rec = makeRecordingRun();
      const innerRun = rec.run;
      const swapRun = async (dir, args, opts) => {
        if (opts && opts.env && !swapped) {
          swapped = true;
          await fsp.rename(swapTarget, swapTarget + '-real');
          await fsp.writeFile(swapTarget, `gitdir: ${F.outside}/.git\n`);
        }
        return innerRun(dir, args, opts);
      };
      const gr = createGitRead({
        workspaceCwds: async () => [{ label: 't', path: F.parent }],
        run: swapRun,
        jail: jailFactory([F.base]),
        mounts: async () => MOUNT_TEXT,
        homedir: () => path.join(F.base, 'nohome'),
        nowMs: Date.now,
        platformDeny: DENY_NO_PRIVATE,
      });
      let response;
      try { response = await call(gr); } catch (e) { response = { refused: e.message, status: e.status }; }
      const s = JSON.stringify(response);
      assert.ok(!s.includes('external-secret'), `${name}: no external tracked filename`);
      assert.ok(!s.includes(outsideOid), `${name}: no external oid`);
      assert.ok(!s.includes('SECRET'), `${name}: no external blob content`);

      // Every post-gate spawn carried a pin; those addressing the authorized repo carried ITS tuple.
      const post = rec.log.filter((c) => c.env);
      assert.ok(post.length >= 1, `${name}: pinned spawns recorded`);
      for (const c of post) {
        assert.ok(c.env.GIT_DIR && c.env.GIT_COMMON_DIR && c.env.GIT_WORK_TREE, `${name}: non-empty pin`);
        if (c.dir === F.child) {
          assert.equal(c.env.GIT_DIR, path.join(F.child, '.git'));
          assert.equal(c.env.GIT_COMMON_DIR, path.join(F.child, '.git'));
          assert.equal(c.env.GIT_WORK_TREE, F.child);
        }
      }
      assert.ok(rec.log.some((c) => !c.env && c.args.includes('--show-toplevel')), `${name}: unpinned pre-gate resolution exists`);
      await restore();
    }

    // The unpinned control: same swap, plain discovery — the outside repo is disclosed,
    // proving the fixture attacks.
    await fsp.rename(swapTarget, swapTarget + '-real');
    await fsp.writeFile(swapTarget, `gitdir: ${F.outside}/.git\n`);
    const leak = await new Promise((resolve) => {
      execFile(GIT_BIN, ['-C', F.child, 'status', '--porcelain=v2', '--branch'],
        { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
        (err, stdout) => resolve(stdout || ''));
    });
    assert.ok(leak.includes(outsideOid) || leak.includes('external-secret'), 'the unpinned control leaks');
  } finally { await restore(); }
});

test('U11a ambient-env controls: poisoned parent env never influences the DEFAULT runner', async () => {
  const poison = {
    GIT_DIR: path.join(F.outside, '.git'),
    GIT_INDEX_FILE: path.join(F.outside, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: path.join(F.outside, '.git', 'objects'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
  };
  const saved = {};
  for (const k of Object.keys(poison)) { saved[k] = process.env[k]; process.env[k] = poison[k]; }
  try {
    // No `run` injection: the module's own sanitized default runner is on trial.
    const gr = createGitRead({
      workspaceCwds: async () => [{ label: 't', path: F.parent }],
      jail: jailFactory([F.base]),
      mounts: async () => MOUNT_TEXT,
      homedir: () => path.join(F.base, 'nohome'),
      nowMs: Date.now,
      platformDeny: DENY_NO_PRIVATE,
    });
    const t = await gr.authorizeRead(F.child);            // discovery resolves from its own cwd
    assert.equal(t.top, F.child, 'poisoned GIT_DIR did not redirect discovery');
    const st = await gr.status(F.child);
    const outsideOid = (await g(F.outside, ['rev-parse', 'HEAD'])).trim();
    assert.ok(!JSON.stringify(st).includes('external-secret'), 'poisoned GIT_INDEX_FILE never reached a response');
    assert.ok(!JSON.stringify(st).includes(outsideOid), 'no poisoned oid');
    assert.ok(st.files.some((f) => f.path === 'dirty.txt'), 'the child\'s own state is reported');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('U11a sibling worktrees: authorized siblings report their OWN state; outside-union siblings read nothing', async () => {
  const { gr, rec } = makeRead();
  // parent lists wt-in (linked, inside the union) — its dirty state must be the SIBLING's.
  // A TRACKED modification: the parent's `.gitignore *` would swallow an untracked file.
  await fsp.appendFile(path.join(F.parent, 'wt-in', 'p.txt'), 'changed\n');
  const d = await gr.worktrees(F.parent);
  assert.ok(!d.error, 'worktrees answered');
  const rows = Object.fromEntries(d.worktrees.map((w) => [path.resolve(w.path), w]));
  const wtIn = rows[path.join(F.parent, 'wt-in')];
  assert.ok(wtIn, 'linked worktree listed');
  assert.ok(wtIn.dirty >= 1, 'clean-parent/dirty-linked: the sibling pin reports the sibling');
  const wtSpawn = rec.log.find((c) => c.dir === path.join(F.parent, 'wt-in') && c.args.includes('status'));
  assert.ok(wtSpawn, 'sibling status spawn exists');
  assert.equal(verb(wtSpawn), 'status', 'and it really is a status read, neutralisers aside');
  assert.equal(wtSpawn.env.GIT_COMMON_DIR, path.join(F.parent, '.git'));
  assert.ok(wtSpawn.env.GIT_DIR.startsWith(path.join(F.parent, '.git', 'worktrees')), 'derived GIT_DIR under commonDir/worktrees');

  // An outside-union sibling: authorize wt-in itself; its sibling list includes the parent (main),
  // which IS in-union here — so build the refusal case with a jail that admits only the worktree.
  const rec2 = makeRecordingRun();
  const gr2 = createGitRead({
    workspaceCwds: async () => [{ label: 'w', path: path.join(F.parent, 'wt-in') }],
    run: rec2.run,
    jail: async () => { throw new Error('outside_root'); },   // nothing extra admitted
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  const d2 = await gr2.worktrees(path.join(F.parent, 'wt-in'));
  assert.ok(!d2.error);
  const mainRow = d2.worktrees.find((w) => path.resolve(w.path) === F.parent);
  assert.ok(mainRow, 'main worktree listed');
  assert.equal(mainRow.dirty, null, 'unauthorized sibling: dirty null');
  // POSITIVE first, so the matcher below is proven to match when it should: the anchor's OWN
  // stanza did spawn a status. Matching with `includes` — `args[0]` is a neutraliser now, and the
  // exact-shape form this replaced became true of the empty set without failing (specs.md §3.3).
  const wtInPath = path.join(F.parent, 'wt-in');
  assert.ok(rec2.log.some((c) => c.dir === wtInPath && c.args.includes('status')),
    'control: the authorized stanza DID spawn a status, so the matcher is not vacuous');
  assert.ok(!rec2.log.some((c) => c.dir === F.parent && c.args.includes('status')), 'and NO spawn in its path');
});

// ---- U21: p7 surface parity through a REAL bridge child --------------------------------------
// The bridge child gets a cmux SHIM that answers the exact two calls bridge.js:104-118 makes, so
// workspaceCwds resolves to the fixture parent (and the newline repo) without any real cmux.
test('U21: p7 parity through a real bridge child — and the p8 routes are live beside it', async (t) => {
  const { bootBridge } = require('./helpers/bridge-child');
  const shimDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cmux-shim-'));
  const shim = path.join(shimDir, 'cmux');
  await fsp.writeFile(shim, '#!/bin/sh\ncase "$*" in\n'
    + '  *list-windows*) echo \'[{"id":"w1"}]\' ;;\n'
    + '  *"workspace list"*) printf %s "$WS_JSON" ;;\n'
    + '  *) echo \'{}\' ;;\nesac\n', { mode: 0o755 });
  const wsJson = JSON.stringify({ workspaces: [
    { current_directory: F.parent, ref: 'r1' },
    { current_directory: F.nlTop, ref: 'r2' },
  ] });
  const br = await bootBridge({ env: {
    CMUX_BIN: shim, WS_JSON: wsJson,
    GIT_PANEL_ENABLED: '1', GIT_WRITES_ENABLED: '1', BRIDGE_SECRET: 'u21s',
  } });
  t.after(async () => { await br.stop(); await fsp.rm(shimDir, { recursive: true, force: true }); });

  const H = { 'x-bridge-secret': 'u21s' };
  const get = async (pq) => {
    const r = await fetch(`${br.base}${pq}`, { headers: H });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const post = async (pq, body) => {
    const r = await fetch(`${br.base}${pq}`, { method: 'POST',
      headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const enc = encodeURIComponent;

  // repos: p7 lists BOTH — including the interior-newline toplevel (its `.trim()` keeps interior bytes).
  const repos = await get('/cmux/git/repos');
  assert.equal(repos.status, 200);
  const paths = repos.json.repos.map((r) => r.path);
  assert.ok(paths.includes(F.parent), 'parent listed');
  assert.ok(paths.includes(F.nlTop), 'newline repo listed — the round-4 regression stays void');

  // status: p7 exact shape — repo, branch, files, counts, inProgress; NO canWrite on this surface.
  const st = await get(`/cmux/git/status?repo=${enc(F.parent)}`);
  assert.equal(st.status, 200);
  for (const k of ['repo', 'branch', 'files', 'counts', 'inProgress']) assert.ok(k in st.json, `p7 status has ${k}`);
  assert.ok(!('canWrite' in st.json), 'p7 status has NO canWrite — shapes unchanged');

  // branches / worktrees / diff answer with p7 shapes.
  const bs = await get(`/cmux/git/branches?repo=${enc(F.parent)}`);
  assert.equal(bs.status, 200);
  assert.ok(Array.isArray(bs.json.branches));
  const wt = await get(`/cmux/git/worktrees?repo=${enc(F.parent)}`);
  assert.equal(wt.status, 200);
  assert.ok(Array.isArray(wt.json.worktrees));
  const df = await get(`/cmux/git/diff?repo=${enc(F.parent)}&path=p.txt`);
  assert.equal(df.status, 200);
  assert.ok('diff' in df.json);

  // command {verb, params} -> {text}: the synchronous p7 semantics preserved.
  const cm = await post('/cmux/git/command', { verb: 'commit', params: { message: 'hi' } });
  assert.equal(cm.status, 200);
  assert.equal(cm.json.text, "git commit -m 'hi'");

  // stage/unstage end to end on a TRACKED modification (`.gitignore *` guards untracked adds).
  await fsp.appendFile(path.join(F.parent, 'p.txt'), 'stage-me\n');
  const sg = await post('/cmux/git/stage', { repo: F.parent, paths: ['p.txt'] });
  assert.equal(sg.status, 200);
  assert.equal(sg.json.ok, true, 'stage mutated the anchor fixture');
  const un = await post('/cmux/git/unstage', { repo: F.parent, paths: ['p.txt'] });
  assert.equal(un.status, 200, 'unstage works');

  // The newline repo keeps its FULL p7 journey through the wire too.
  const stNl = await get(`/cmux/git/status?repo=${enc(F.nlTop)}`);
  assert.equal(stNl.status, 200);
  assert.ok(Array.isArray(stNl.json.files), 'newline repo status-loadable over the bridge');
  await fsp.appendFile(path.join(F.nlTop, 'n.txt'), 'x\n');
  const sgNl = await post('/cmux/git/stage', { repo: F.nlTop, paths: ['n.txt'] });
  assert.equal(sgNl.status, 200);
  assert.equal(sgNl.json.ok, true, 'newline repo stageable over the bridge');

  // p7 error codes surface: unknown_repo 403.
  const bad = await get(`/cmux/git/status?repo=${enc(F.outside)}`);
  assert.equal(bad.status, 403);
  assert.deepEqual(bad.json, { error: 'unknown_repo' });

  // And the p8 routes are LIVE beside the p7 block, jail-wired through fsbrowse.
  // The equality anchor answers dir-keyed with the p8 shape (canWrite present):
  const p8 = await get(`/cmux/gitread/status?dir=${enc(F.parent)}`);
  assert.equal(p8.status, 200);
  assert.equal(p8.json.repo, F.parent);
  assert.equal(p8.json.canWrite, true, 'p8 status carries the canWrite hint');
  // The nested child is refused THROUGH the bridge: no platformDeny is injected there, and the
  // PRODUCTION constant correctly calls a /private-rooted anchor broad — the seam-honesty claim,
  // asserted end to end. (Narrow-anchor containment is exercised above with the injected seam,
  // and in the browser suite whose fixtures live under the home directory.)
  const p8child = await get(`/cmux/gitread/status?dir=${enc(F.child)}`);
  assert.equal(p8child.status, 403, 'production deny-set: /private anchors are broad, no nesting');
  const p8bad = await get(`/cmux/gitread/status?dir=${enc(F.outside)}`);
  assert.equal(p8bad.status, 403, 'outside stays outside on the p8 surface too');
});

// ============ STORY-003 — probe ==================================================================
// The bar's first question, and the two bounds that keep asking it cheap. Everything below runs
// against the REAL git in the fixture tree; the injected seams exist to make the CONCURRENCY and
// the CANCELLATION observable, never to invent git's answers.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A raw git call outside gitread entirely — used only to re-measure the signatures the spec rests on.
const rawGit = (dir, args) => new Promise((resolve) => {
  execFile(GIT_BIN, ['-C', dir].concat(args), { encoding: 'utf8' }, (err, stdout) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
    stdout: stdout || '',
  }));
});

test('U5 signature: `unborn` is confirmed POSITIVELY — no failure can impersonate it', async () => {
  // specs.md §5.1's two tables, re-measured here so a git upgrade that moved a row fails loudly
  // instead of silently turning every corrupt repo into a fresh one.
  const abbrev = ['rev-parse', '--abbrev-ref', 'HEAD'];
  const symref = ['symbolic-ref', '--quiet', 'HEAD'];

  assert.equal((await rawGit(F.unbornIn, abbrev)).code, 128, 'unborn: abbrev-ref exits 128');
  assert.equal((await rawGit(F.corrupt, abbrev)).code, 128, 'corrupt HEAD: abbrev-ref exits 128 TOO — 128 signs nothing');

  const u = await rawGit(F.unbornIn, symref);
  assert.equal(u.code, 0, 'unborn: symbolic-ref exits 0');
  assert.equal(u.stdout, 'refs/heads/main\n', 'unborn: and PRINTS refs/heads/<name>');
  assert.equal((await rawGit(F.detached, symref)).code, 1, 'detached: symbolic-ref exits 1');
  assert.equal((await rawGit(F.corrupt, symref)).code, 128, 'corrupt HEAD: symbolic-ref exits 128, never 0');

  // And the tuple read still succeeds on the corrupt repo — so probe genuinely REACHES the
  // symbolic-ref decision there rather than bailing out at the gate.
  assert.equal((await rawGit(F.corrupt, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).code, 0);
});

test('U5: probe answers every shape — repo, non-repo, out-of-scope, unborn, detached, .git, bare, submodule, crafted, corrupt, vanished', async () => {
  const { gr } = makeRead();

  assert.deepEqual(await gr.probe(F.parent), { repo: F.parent, name: 'parent', branch: 'main', state: 'branch' },
    'the anchor top itself');
  assert.deepEqual(await gr.probe(F.child), { repo: F.child, name: 'child', branch: 'main', state: 'branch' },
    'a nested repo reached by containment');
  assert.deepEqual(await gr.probe(F.base), { repo: null }, 'a non-repo directory');
  assert.deepEqual(await gr.probe(F.outside), { repo: null }, 'a repo outside every narrow anchor');
  assert.deepEqual(await gr.probe(F.unbornIn), { repo: F.unbornIn, name: 'unborn-in', branch: 'main', state: 'unborn' },
    'unborn carries the REAL branch name from the symbolic ref');
  assert.deepEqual(await gr.probe(F.detached), { repo: F.detached, name: 'detached', branch: null, state: 'detached' });
  assert.deepEqual(await gr.probe(path.join(F.child, '.git')), { repo: null }, 'a path inside .git/');
  assert.deepEqual(await gr.probe(F.bare), { repo: null }, 'a bare repo has no worktree to browse');
  assert.deepEqual(await gr.probe(F.subInner), { repo: F.subInner, name: 'inner', branch: 'main', state: 'branch' },
    'a submodule reports the INNER repo, not its host');
  assert.deepEqual(await gr.probe(F.crafted), { repo: null }, 'a crafted .git file');
  assert.deepEqual(await gr.probe(F.corrupt), { repo: null }, 'corrupt HEAD is { repo: null } — NOT unborn');

  // A directory that vanishes BETWEEN the tuple read and the branch read: both branch reads exit
  // 128, exactly as an unborn repo's first one does. The positive signature refuses to dress it up.
  const ephemeral = path.join(F.parent, 'ephemeral');
  await fsp.mkdir(ephemeral, { recursive: true });
  await g(F.base, ['init', '-q', '-b', 'main', ephemeral]);
  const rec = makeRecordingRun();
  let killed = false;
  const killRun = async (dir, args, opts) => {
    if (opts && opts.env && !killed) {          // the first PINNED (post-gate) spawn is the window
      killed = true;
      await fsp.rm(ephemeral, { recursive: true, force: true });
    }
    return rec.run(dir, args, opts);
  };
  const { gr: grKill } = makeRead({ run: killRun });
  assert.deepEqual(await grKill.probe(ephemeral), { repo: null }, 'vanished between spawns');
  const onEphemeral = rec.log.filter((c) => c.dir === ephemeral);   // anchor discovery spawns elsewhere
  assert.equal(onEphemeral.length, 3, 'the vanished case paid the rare third spawn and still refused');
  assert.deepEqual(bare(onEphemeral[2].args), ['symbolic-ref', '--quiet', 'HEAD'], 'it really reached the confirmation');
});

test('U5 cost + pin + jail order + no path echo', async () => {
  const clock = { t: 1000 };                    // frozen: the anchor TTL can never expire mid-test
  const factory = (overrides) => {
    const rec = makeRecordingRun();
    const gr = createGitRead(Object.assign({
      workspaceCwds: async () => [{ label: 't', path: F.parent }],
      run: rec.run,
      jail: jailFactory([F.base]),
      mounts: async () => MOUNT_TEXT,
      homedir: () => path.join(F.base, 'nohome'),
      nowMs: () => clock.t,
      platformDeny: DENY_NO_PRIVATE,
    }, overrides || {}));
    return { gr, rec };
  };

  // Cost is measured with discovery already paid — U15 accounts for the anchor spawns separately.
  const cost = async (dir) => {
    const { gr, rec } = factory();
    await gr.authorizeRead(F.parent);
    rec.log.length = 0;
    const out = await gr.probe(dir);
    return { out, log: rec.log };
  };

  const nonRepo = await cost(F.base);
  assert.deepEqual(nonRepo.out, { repo: null });
  assert.equal(nonRepo.log.length, 1, 'a non-repo directory costs exactly 1 spawn');

  const onBranch = await cost(F.child);
  assert.equal(onBranch.out.state, 'branch');
  assert.equal(onBranch.log.length, 2, 'an in-scope on-branch repo costs exactly 2');

  const unborn = await cost(F.unbornIn);
  assert.equal(unborn.out.state, 'unborn');
  assert.equal(unborn.log.length, 3, 'an unborn repo costs exactly 3 — the rare path, paid once');

  for (const c of [...nonRepo.log, ...onBranch.log, ...unborn.log]) {
    assert.equal(c.timeoutMs, 6000, `timeoutMs 6000 on \`${c.args.join(' ')}\` — gitpanel.js:94, not gitcmd's 20000`);
  }

  // v3.2: probe is NOT exempt from the pin. Its tuple resolution is the ONE pre-gate spawn; BOTH
  // branch reads carry the tuple that authorization returned.
  const [tuple, abbrev, symref] = unborn.log;
  assert.deepEqual(bare(tuple.args),
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  assert.equal(tuple.env, null, 'the tuple resolution is pre-gate and unpinned');
  const pin = {
    GIT_DIR: path.join(F.unbornIn, '.git'),
    GIT_COMMON_DIR: path.join(F.unbornIn, '.git'),
    GIT_WORK_TREE: F.unbornIn,
  };
  assert.deepEqual(bare(abbrev.args), ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.deepEqual(abbrev.env, pin, 'the branch read is pinned');
  assert.deepEqual(bare(symref.args), ['symbolic-ref', '--quiet', 'HEAD']);
  assert.deepEqual(symref.env, pin, 'the unborn confirmation is pinned too');
  assert.equal(abbrev.dir, F.unbornIn, 'both post-gate spawns address the authorized toplevel');
  assert.equal(symref.dir, F.unbornIn);

  // The jail runs before anything spawns on the browsed-dir surface.
  const { gr: grJ, rec: recJ } = factory({ jail: async () => { throw new Error('outside_root'); } });
  assert.deepEqual(await grJ.probe(F.privChild), { repo: null }, 'a jail refusal is the same { repo: null }');
  assert.ok(!recJ.log.some((c) => c.dir === F.privChild), 'the injected runner was never called for the candidate');

  // A refusal echoes no part of the resolved path — there is no existence oracle to read off it.
  const { gr: grE } = factory();
  const refused = JSON.stringify(await grE.probe(F.outside));
  assert.equal(refused, '{"repo":null}');
  for (const seg of F.outside.split(path.sep).filter((s) => s.length >= 4)) {
    assert.ok(!refused.includes(seg), `no path segment leaks (${seg})`);
  }
});

test('U17: the COMBINED child bound across both seams, with the admission queue and p7 running beside it', async () => {
  const clock = { t: 5000000 };
  let live = 0;
  let high = 0;
  const enter = () => { live++; if (live > high) high = live; };
  const exit = () => { live--; };

  const rec = makeRecordingRun();
  // Both seams are delayed and both are counted: round 4 showed a runner-only measurement cannot
  // see the mount child overlapping a git spawn.
  const slowRun = async (dir, args, opts) => {
    enter();
    try { await sleep(15); return await rec.run(dir, args, opts); } finally { exit(); }
  };
  const slowMounts = async () => {
    enter();
    try { await sleep(45); return MOUNT_TEXT; } finally { exit(); }
  };

  const gr = createGitRead({
    workspaceCwds: async () => [                 // MULTIPLE cwds: a cold discovery that really fans out
      { label: 'a', path: F.parent },
      { label: 'b', path: path.join(F.parent, 'src', 'server') },
      { label: 'c', path: F.child },
    ],
    run: slowRun,
    jail: jailFactory([F.base]),
    mounts: slowMounts,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: () => clock.t,
    platformDeny: DENY_NO_PRIVATE,
  });

  const dirs = [];
  for (let i = 0; i < 12; i++) {
    const d = path.join(F.parent, `q${i}`);
    await fsp.mkdir(d, { recursive: true });
    dirs.push(d);
  }

  // p7's own concurrency, running at ITS width beside the burst — invisible to this bound by
  // construction (§2.2 rule 1: the limiter wraps gitread's runner reference and mount seam only).
  const panel = createGitPanel({ workspaceCwds: async () => [{ label: 't', path: F.parent }] });
  const reposP = Promise.all([panel.repos(), panel.repos(), panel.repos()]);

  const started = Date.now();
  const settle = (p) => p.then(
    (value) => ({ status: 'fulfilled', value, at: Date.now() - started }),
    (reason) => ({ status: 'rejected', reason, at: Date.now() - started }),
  );
  const probes = dirs.map((d) => settle(gr.probe(d)));      // submitted synchronously, in order
  const branchesP = settle(gr.branches(F.manyBranch));      // a many-branch fan-out, same bound
  const results = await Promise.all(probes);
  const branches = await branchesP;
  const repos = await reposP;

  assert.equal(high, 2, `combined high-water across run+mounts is exactly 2 (saw ${high}) — bounded AND non-vacuous`);

  assert.deepEqual(results.map((r) => r.status),
    [...Array(10).fill('fulfilled'), 'rejected', 'rejected'],
    'width 2 + queue 8 served; exactly 2 overflowed');
  for (const r of results.filter((x) => x.status === 'rejected')) {
    assert.equal(r.reason.name, 'GitPanelError');
    assert.equal(r.reason.code, 'probe_busy');
    assert.equal(r.reason.status, 503);
    assert.ok(r.at < 150, `overflow is refused IMMEDIATELY, not after a wait (${r.at}ms)`);
  }
  for (const r of results.filter((x) => x.status === 'fulfilled')) {
    assert.equal(r.value.repo, F.parent, 'each served probe answered the containing repo');
  }

  // FIFO — a property of the QUEUE. The first two are admitted straight through and run
  // CONCURRENTLY (that is what width 2 means), so their spawn order between themselves is a coin
  // flip and asserting it would be asserting noise. The eight that actually waited are the claim.
  const firstTouch = [];
  for (const c of rec.log) {
    if (dirs.includes(c.dir) && !firstTouch.includes(c.dir)) firstTouch.push(c.dir);
  }
  assert.equal(firstTouch.length, 10, 'ten bodies ran; the overflow two never spawned at all');
  assert.deepEqual([...firstTouch.slice(0, 2)].sort(), dirs.slice(0, 2).sort(),
    'the two admitted immediately are the two submitted first');
  assert.deepEqual(firstTouch.slice(2), dirs.slice(2, 10), 'the eight QUEUED waiters drained in FIFO order');

  assert.equal(branches.status, 'fulfilled', 'the many-branch read answered inside the same bound');
  assert.equal(branches.value.repo, F.manyBranch);
  assert.equal(branches.value.branches.length, 9, 'main + 8 — a real per-branch fan-out ran');

  assert.ok(repos[0].some((r) => r.path === F.parent), 'p7 repos() really ran beside the burst');
  // p7's spawns never reached gitread's limiter seam. The exact-shape form this replaces
  // (`args.length === 2 && args[0] === 'rev-parse'`) stopped matching the moment rule 3 prefixed
  // every argv, and went vacuously true WITHOUT failing (specs.md §3.3). Two positive statements
  // replace it: every recorded call is gitread's OWN (it carries the neutralisers p7's runner
  // never adds), and the seam count is measured directly rather than inferred from argv.
  assert.ok(rec.log.length > 0, 'the seam log is non-empty, so the checks below are not vacuous');
  for (const c of rec.log) bare(c.args, 'U17 seam call');
  const p7Discovery = rec.log.filter((c) => {
    const a = bare(c.args);
    return a.length === 2 && a[0] === 'rev-parse' && a[1] === '--show-toplevel';
  });
  assert.equal(p7Discovery.length, 0, "p7's discovery argv never appears in gitread's seam log");
  const seamCalls = rec.log.length;
  await Promise.all([panel.repos(), panel.repos()]);      // more p7 work, after the burst settled
  assert.equal(rec.log.length, seamCalls,
    "p7's spawns never reached gitread's limiter seam — the bound measures p8's children only");
});

// A gitread whose JAIL can be stalled on demand: the stall holds the ADMISSION slot without
// occupying a spawn slot, which is what makes the queue observable from outside.
function makeStallable(overrides) {
  const rec = makeRecordingRun();
  const stall = new Set();
  const gates = [];
  const realJail = jailFactory([F.base]);
  const gr = createGitRead(Object.assign({
    workspaceCwds: async () => [{ label: 't', path: F.parent }],
    run: rec.run,
    jail: async (p) => {
      if (stall.has(p)) await new Promise((r) => gates.push(r));
      return realJail(p);
    },
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  }, overrides || {}));
  return { gr, rec, stall, gates, release: () => { const r = gates.shift(); if (r) r(); } };
}

async function holdBothSlots(h, tag) {
  const a = path.join(F.parent, `${tag}-hold-a`);
  const b = path.join(F.parent, `${tag}-hold-b`);
  await fsp.mkdir(a, { recursive: true });
  await fsp.mkdir(b, { recursive: true });
  h.stall.add(a);
  h.stall.add(b);
  const held = [h.gr.probe(a), h.gr.probe(b)];
  for (let i = 0; i < 400 && h.gates.length < 2; i++) await sleep(5);
  assert.equal(h.gates.length, 2, 'both admission slots are held by stalled admitted probes');
  return held;
}

test('U22: a disconnect unlinks a queued waiter, the next probe is admitted ahead of the dead ones', async () => {
  const h = makeStallable();
  const held = await holdBothSlots(h, 'u22a');

  // Eight queued probes, each bound to its caller's disconnect exactly as bridge.js binds them.
  const cancels = [];
  const detached = [];
  const queuedDirs = [];
  const queued = [];
  for (let i = 0; i < 8; i++) {
    const d = path.join(F.parent, `u22a-q${i}`);
    await fsp.mkdir(d, { recursive: true });
    queuedDirs.push(d);
    queued.push(h.gr.probe(d, {
      onCancel: (cancel) => { cancels.push(cancel); return () => detached.push(i); },
    }).then(() => 'served', (e) => e));
  }
  assert.equal(cancels.length, 8, 'every queued waiter wired a cancel; the two admitted ones did not');

  // The queue is full: a ninth request overflows rather than displacing anyone.
  await assert.rejects(h.gr.probe(path.join(F.parent, 'u22a-q0')), (e) => e.code === 'probe_busy' && e.status === 503);

  for (const c of cancels) c();
  const settled = await Promise.all(queued);
  for (const s of settled) {
    assert.notEqual(s, 'served');
    assert.equal(s.code, 'probe_busy');
    assert.equal(s.status, 503);
  }
  assert.ok(!h.rec.log.some((c) => queuedDirs.includes(c.dir)),
    'no body ever started for a cancelled waiter — the runner never saw their paths');

  // A fresh probe queued AFTER the eight dead entries is admitted NEXT: dead entries are skipped
  // at dequeue, so they cost the live caller nothing but the array slot.
  const fresh = path.join(F.parent, 'u22a-fresh');
  await fsp.mkdir(fresh, { recursive: true });
  const freshP = h.gr.probe(fresh);
  h.release();
  assert.deepEqual(await freshP, { repo: F.parent, name: 'parent', branch: 'main', state: 'branch' },
    'the live waiter was admitted ahead of eight unlinked ones');

  h.release();
  for (const p of held) await p;
});

test('U22: an admitted body runs to completion despite its caller leaving, and its listener is detached on admission', async () => {
  // The fast path never wires a cancel at all — there is no waiter to unlink.
  const direct = makeStallable();
  let wired = 0;
  const straight = await direct.gr.probe(F.child, { onCancel: () => { wired++; return () => {}; } });
  assert.deepEqual(straight, { repo: F.child, name: 'child', branch: 'main', state: 'branch' });
  assert.equal(wired, 0, 'an immediately admitted probe binds no disconnect listener');

  // A queued one does wire it — and the binding is detached the moment it is admitted, so a late
  // disconnect cannot reach into a running body.
  const h = makeStallable();
  const held = await holdBothSlots(h, 'u22b');
  const d = path.join(F.parent, 'u22b-late');
  await fsp.mkdir(d, { recursive: true });
  let cancel = null;
  let detachCount = 0;
  const p = h.gr.probe(d, { onCancel: (c) => { cancel = c; return () => { detachCount++; }; } });
  await sleep(20);
  assert.ok(cancel, 'the queued waiter wired its cancel');
  assert.equal(detachCount, 0, 'and has not detached while it waits');

  h.release();                                   // admitted once the released body settles
  for (let i = 0; i < 400 && detachCount === 0; i++) await sleep(5);
  assert.equal(detachCount, 1, 'the binding is removed on admission');
  cancel();                                      // the caller leaves mid-body — too late by design
  assert.deepEqual(await p, { repo: F.parent, name: 'parent', branch: 'main', state: 'branch' },
    'the admitted body ran to completion anyway');

  h.release();
  for (const q of held) await q;
});

test('U22: a waiter cannot outlive the 4000 ms acquisition deadline', async () => {
  const h = makeStallable();
  const held = await holdBothSlots(h, 'u22c');
  const d = path.join(F.parent, 'u22c-slow');
  await fsp.mkdir(d, { recursive: true });

  const t0 = Date.now();
  const err = await h.gr.probe(d).then(() => null, (e) => e);
  const waited = Date.now() - t0;
  assert.ok(err, 'the waiter was answered, not left hanging');
  assert.equal(err.code, 'probe_busy');
  assert.equal(err.status, 503);
  assert.ok(waited >= 3800 && waited < 6000,
    `answered on the 4000 ms deadline, shorter than the 6000 ms spawn timeout (waited ${waited}ms)`);
  assert.ok(!h.rec.log.some((c) => c.dir === d), 'and its body never started');

  h.release();
  h.release();
  for (const p of held) await p;
});

// ---- U22 real-bridge controls ------------------------------------------------------------------
// The v3.1/v3.2 controls, proven through a REAL bridge child rather than the injected semaphore.
// The cmux shim SLEEPS, so the cold anchor discovery genuinely holds both admitted probes long
// enough for the other callers to be sitting in the queue while the assertions are made.
async function bootProbeBridge(cwd, secret) {
  const { bootBridge } = require('./helpers/bridge-child');
  const shim = path.join(cwd, 'cmux');
  await fsp.writeFile(shim, '#!/bin/sh\nsleep 0.4\ncase "$*" in\n'
    + '  *list-windows*) echo \'[{"id":"w1"}]\' ;;\n'
    + '  *"workspace list"*) printf %s "$WS_JSON" ;;\n'
    + '  *) echo \'{}\' ;;\nesac\n', { mode: 0o755 });
  return bootBridge({ env: {
    CMUX_BIN: shim,
    WS_JSON: JSON.stringify({ workspaces: [{ current_directory: F.parent, ref: 'r1' }] }),
    GIT_PANEL_ENABLED: '1',
    BRIDGE_SECRET: secret,
  } });
}

test('U22 real bridge: a NORMAL queued GET is admitted and answers 200 — cancellation keys on res close, never req close', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-u22-'));
  const br = await bootProbeBridge(dir, 'u22r');
  t.after(async () => { await br.stop(); await fsp.rm(dir, { recursive: true, force: true }); });

  const url = `${br.base}/cmux/gitread/probe?dir=${encodeURIComponent(F.parent)}`;
  const fire = () => fetch(url, { headers: { 'x-bridge-secret': 'u22r' } })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  // Twelve at once. Every one of these is a completed bodyless GET, so `req` has already fired
  // 'close' on all of them while their responses are still pending — the exact Node ≥16 semantics
  // that a req-close binding would read as "everybody left".
  const all = await Promise.all(Array.from({ length: 12 }, fire));
  const ok = all.filter((r) => r.status === 200);
  const busy = all.filter((r) => r.status === 503);

  assert.equal(busy.length, 2, 'exactly 2 overflowed — which proves 8 were genuinely QUEUED, not raced through');
  for (const b of busy) assert.deepEqual(b.json, { error: 'probe_busy' });
  assert.equal(ok.length, 10, 'the 2 admitted AND all 8 queued callers were served');
  for (const r of ok) {
    assert.deepEqual(r.json, { repo: F.parent, name: 'parent', branch: 'main', state: 'branch' });
  }
});

test('U22 real bridge: one genuinely disconnected queued caller is removed ALONE', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-u22d-'));
  const br = await bootProbeBridge(dir, 'u22d');   // a FRESH child: its anchor cache is cold again
  t.after(async () => { await br.stop(); await fsp.rm(dir, { recursive: true, force: true }); });

  const url = `${br.base}/cmux/gitread/probe?dir=${encodeURIComponent(F.parent)}`;
  const fire = (signal) => fetch(url, { headers: { 'x-bridge-secret': 'u22d' }, signal })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }), (e) => ({ aborted: true, e }));

  const ctrl = new AbortController();
  const inflight = [];
  for (let i = 0; i < 10; i++) inflight.push(fire(i === 6 ? ctrl.signal : undefined));  // 2 admitted + 8 queued

  await sleep(120);                 // still inside the shim's ~800 ms cold discovery
  ctrl.abort();                     // ONE queued caller leaves for real
  await sleep(60);

  // The freed queue slot is immediately usable: without the unlink this eleventh caller would be
  // the overflow 503 that the control above measured.
  const eleventh = await fire(undefined);
  const rest = await Promise.all(inflight);

  assert.equal(eleventh.status, 200, 'the unlinked slot was reusable — the disconnect really removed one entry');
  assert.deepEqual(eleventh.json, { repo: F.parent, name: 'parent', branch: 'main', state: 'branch' });
  assert.ok(rest[6].aborted, 'the caller that left did leave');
  const neighbours = rest.filter((_, i) => i !== 6);
  assert.equal(neighbours.length, 9);
  for (const n of neighbours) {
    assert.equal(n.status, 200, 'every neighbour was unaffected');
    assert.equal(n.json.repo, F.parent);
  }
});

test('U22 source-structure: the bridge binds cancellation to res + !writableEnded, and detaches it', async () => {
  // MEASURED on this Node (v22): for a bodyless GET whose handler never READS the request stream —
  // which is exactly the probe route's shape — `req` 'close' fires only when the response ends, so
  // a `req` binding and a `res` binding are indistinguishable from outside. Consume the stream
  // (`req.resume()`, any 'data' listener, a body guard, a logging middleware) and `req` 'close'
  // fires at 0 ms with the response still pending — at which point a `req` binding marks EVERY
  // queued probe dead. The controls above therefore cannot pin this down behaviourally; only the
  // source can, which is the same reason STORY-001 pins the server relay's handler structurally.
  const src = await fsp.readFile(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  const fn = src.slice(src.indexOf('function cmuxGitRead('));
  const branch = fn.slice(fn.indexOf("sub === 'probe'"), fn.indexOf("sub === 'status'"));

  assert.ok(/onCancel:/.test(branch), 'the probe branch passes an onCancel binding');
  assert.ok(/const onResClose = \(\) => \{ if \(!res\.writableEnded\) cancel\(\); \};/.test(branch),
    'a NAMED handler guarded by !res.writableEnded — a closed-but-finished response is not a disconnect');
  assert.ok(/res\.on\('close', onResClose\)/.test(branch), 'wired to res');
  assert.ok(/return \(\) => res\.removeListener\('close', onResClose\)/.test(branch),
    'and it returns the detach gitread runs on admission or settlement');
  assert.ok(!/req\.on\(/.test(branch), 'NEVER req — the Node ≥16 trap this whole binding exists to avoid');
});

// ============ STORY-002 v3.4 — rules 3, 4 and 5 ==================================================
// Round 8 found two security defects and the war-game a third. Every fixture below is proven to
// ATTACK before it is trusted to defend: each has a control that runs the same repo with the fix
// stripped and shows the disclosure or the marker appearing.

// The evil repo's stat cache is restored and its files re-edited SAME-SIZE before every read, so
// git genuinely re-reads content and the clean filters are genuinely reachable.
async function armEvil() {
  await fsp.copyFile(F.evilIndex, path.join(F.evil, '.git', 'index'));
  await fsp.writeFile(path.join(F.evil, 'a.txt'), 'aaab\n');
  await fsp.writeFile(path.join(F.evil, 'b.txt'), 'bbbc\n');
  await fsp.writeFile(path.join(F.evil, 'sub', 'n.txt'), 'nnno\n');
  const now = new Date();
  for (const f of ['a.txt', 'b.txt', path.join('sub', 'n.txt')]) {
    await fsp.utimes(path.join(F.evil, f), now, now);
  }
  for (const m of await fsp.readdir(F.evilMarkers)) await fsp.rm(path.join(F.evilMarkers, m), { force: true });
}
const markers = async () => (await fsp.readdir(F.evilMarkers)).sort();

// Raw git, outside gitread entirely — how the "with the fix stripped" controls are run.
const rawArgs = (dir, args) => new Promise((resolve) => {
  execFile(GIT_BIN, ['-C', dir].concat(args),
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (err, stdout) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
      stdout: stdout || '',
      timedOut: !!(err && err.killed),          // a wedged control must FAIL, never hang the suite
    }));
});

test('U23: no repo-supplied program runs through ANY p8 read route', async () => {
  await armEvil();
  const { gr, rec } = makeRead();
  const p = await gr.probe(F.evil);
  const st = await gr.status(F.evil);
  const br = await gr.branches(F.evil);
  const wt = await gr.worktrees(F.evil);
  const df = await gr.diff(F.evil, 'a.txt', false);

  assert.deepEqual(await markers(), [], 'NO marker file after probe + status + branches + worktrees + diff');

  // Non-vacuous: the neutralised reads still read. A route that errored out would create no marker
  // either, so each answer is asserted to carry the repo's REAL state.
  assert.equal(p.repo, F.evil, 'probe answered');
  assert.ok(st.files.some((f) => f.path === 'a.txt'), 'status still reports real dirt');
  assert.ok(br.branches.some((b) => b.name === 'main'), 'branches still answered');
  assert.ok(wt.worktrees.length >= 1, 'worktrees still answered');
  assert.ok(df.diff.includes('+aaab'), 'diff still returns a real hunk');

  // Argv-level, over the WHOLE recorded call log — the single check that catches the route written
  // after this test, which five per-call-site checks could not.
  assert.ok(rec.log.length >= 5, 'the call log is populated');
  for (const c of rec.log) bare(c.args, 'U23');
  const diffSpawns = rec.log.filter((c) => verb(c) === 'diff');
  assert.ok(diffSpawns.length >= 1, 'a diff spawn was recorded');
  for (const c of diffSpawns) {
    assert.ok(c.args.includes('--no-ext-diff'), 'every diff spawn carries --no-ext-diff');
    assert.ok(c.args.includes('--no-textconv'), 'and --no-textconv');
  }
});

test('U23 control: the fixture ATTACKS — stripped, the fsmonitor and textconv markers appear', async () => {
  await armEvil();
  await rawArgs(F.evil, ['status', '--branch', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.ok((await markers()).includes('FSMONITOR'), 'bare status runs the repo\'s core.fsmonitor hook');

  await armEvil();
  await rawArgs(F.evil, ['diff', '--no-color', '--', 'a.txt']);
  const bareDiff = await markers();
  assert.ok(bareDiff.includes('DIFF_EXTERNAL'), 'bare diff runs the repo\'s diff.external');
});

test('U23 control: --no-ext-diff ALONE is insufficient — the textconv marker is still created', async () => {
  await armEvil();
  await rawArgs(F.evil, ['diff', '--no-color', '--no-ext-diff', '--', 'a.txt']);
  const m = await markers();
  assert.ok(m.includes('TEXTCONV'),
    '--no-ext-diff alone still runs the .gitattributes-selected textconv — so it cannot be the fix');
  assert.ok(m.includes('FSMONITOR'), 'and it does nothing about core.fsmonitor either');
});

test('U23 control: the v3.4 `-c` LIST ALONE loses — the attacker-named filter drivers still run', async () => {
  // The measurement that made a longer -c list unimplementable: `-c filter.<name>.clean=` has no
  // wildcard form and the driver NAME comes from the browsed repo's own .gitattributes.
  const cList = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null'];
  await armEvil();
  await rawArgs(F.evil, cList.concat(['status', '--branch', '--porcelain=v1', '-z', '--untracked-files=all']));
  const st = await markers();
  assert.ok(st.includes('CLEAN'), 'filter.<driver>.clean still ran under status');
  assert.ok(st.includes('PROCESS'), 'filter.<driver>.process still ran');

  await armEvil();
  await rawArgs(F.evil, cList.concat(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'sub/n.txt']));
  assert.ok((await markers()).includes('NESTED'), 'a NESTED .gitattributes still selected a filter under diff');
});

test('U23: the attribute-stack bound is what closes them, and it does not break the read', async () => {
  // Isolated to the mechanism itself: the same raw git, with the neutralisers this module actually
  // sends. If a future git changes --attr-source semantics, this fails here rather than silently.
  const N = [...NEUTRALISERS, `--attr-source=${EMPTY_TREE_SHA1}`];
  await armEvil();
  const st = await rawArgs(F.evil, N.concat(['status', '--porcelain=v1']));
  assert.deepEqual(await markers(), [], 'neutralised status: no marker');
  assert.ok(st.stdout.includes('a.txt'), 'and it still reports the modification');

  await armEvil();
  const df = await rawArgs(F.evil, N.concat(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'sub/n.txt']));
  assert.deepEqual(await markers(), [], 'neutralised diff on the NESTED path: no marker');
  assert.ok(df.stdout.includes('+nnno'), 'and it still returns the hunk');
});

test('U23: a SHA256 repo stays readable — the attribute-stack bound matches the object format', async () => {
  assert.ok(F.sha256Repo, 'this git can create a sha256 repo, so the arm is real');
  // MEASURED: `--attr-source=<40-hex>` in a sha256 repo is `fatal: bad --attr-source`, so a
  // hardcoded sha1 empty tree would take EVERY read on this repo down while every other test
  // stayed green. The oid is derived from <commonDir>/config with a plain fs read, never a spawn.
  //
  // The control runs the p8 DIFF argv, not the status one, and that choice is a measurement rather
  // than a preference: git validates `--attr-source` LAZILY, only when the attribute stack is
  // actually consulted, and `status` can settle a size-changed file from stat alone and never
  // consult it — 2 of 30 sampled runs exited 0 with the bad oid unnoticed, which is a flaky
  // control, not a passing one. `diff` must read both sides, so it consults the stack every time:
  // 30 of 30 fatal.
  const raw = await rawArgs(F.sha256Repo,
    [`--attr-source=${EMPTY_TREE_SHA1}`, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 's.txt']);
  assert.equal(raw.code, 128, 'the sha1 empty tree really is fatal here — the arm attacks');

  const { gr, rec } = makeRead();
  const p = await gr.probe(F.sha256Repo);
  assert.equal(p.repo, F.sha256Repo, 'probe answers');
  const st = await gr.status(F.sha256Repo);
  assert.ok(!st.error, `status answers (got ${JSON.stringify(st).slice(0, 200)})`);
  assert.ok(st.files.some((f) => f.path === 's.txt'), 'and reports the repo\'s real dirt');
  // The route the control just proved would be fatal under a sha1 bound: it answers here.
  const df = await gr.diff(F.sha256Repo, 's.txt', false);
  assert.ok(!df.error && df.diff.includes('+dirt'), `diff answers on the sha256 repo (got ${JSON.stringify(df).slice(0, 200)})`);
  const spawn = rec.log.find((c) => c.dir === F.sha256Repo && c.env && bare(c.args)[0] === 'status');
  assert.ok(/^--attr-source=[0-9a-f]{64}$/.test(spawn.args[NEUTRALISERS.length]),
    'the bound carries a SHA256-length oid, derived from the repo\'s own config');
});

// ---- U26: the fourth attribute door — closed by REFUSAL, not by a flag ------------------------
//
// Every arm below drives the SAME repo shape and varies only what `<commonDir>/info/attributes`
// says, so the admitted arms are genuine controls for the refused ones. The p8 routes are driven
// through the real gate; the "with the fix stripped" controls are raw git, outside gitread.

// Same contract as armEvil, on the attribute fixtures' own drop box: restore a same-size edit so
// git genuinely re-reads content (a clean filter is unreachable on a stat-clean file), then clear.
async function armAttr(repo) {
  await fsp.writeFile(path.join(repo, 'f.txt'), 'aaab\n');
  const now = new Date();
  await fsp.utimes(path.join(repo, 'f.txt'), now, now);
  for (const m of await fsp.readdir(F.attrMarkers)) await fsp.rm(path.join(F.attrMarkers, m), { force: true });
}
const attrMarks = async () => (await fsp.readdir(F.attrMarkers)).sort();
// The neutraliser set gitread actually sends, assembled from the module's own export.
const FULL_NEUTRALISERS = () => [...NEUTRALISERS, `--attr-source=${EMPTY_TREE_SHA1}`];
const P8_DIFF_ARGV = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'f.txt'];
const P8_STATUS_ARGV = ['status', '--branch', '--porcelain=v1', '-z', '--untracked-files=all'];

test('U26: an unbounded attribute source refuses the WHOLE repo — no route, no spawn, no marker', async () => {
  await armAttr(F.attrEvil);
  const events = [];
  const { gr, rec } = makeRead({ log: (r) => events.push(r) });

  assert.deepEqual(await gr.probe(F.attrEvil), { repo: null }, 'probe: the shared refusal shape');
  await rejects403(gr.authorizeRead(F.attrEvil));
  for (const fn of ['status', 'branches', 'worktrees']) {
    await assert.rejects(gr[fn](F.attrEvil), (e) => e.status === 403, `${fn} refused 403`);
  }
  await assert.rejects(gr.diff(F.attrEvil, 'f.txt', false), (e) => e.status === 403, 'diff refused 403');

  assert.deepEqual(await attrMarks(), [], 'NO marker file from probe + status + branches + worktrees + diff');
  assert.equal(postGateSpawns(rec, F.attrEvil).length, 0, 'and no post-gate spawn ever ran against it');
  assert.ok(events.some((e) => e.event === 'refuse' && e.reason === 'unbounded_attribute_source'),
    'the reason is diagnosable server-side');
  const wire = JSON.stringify(await gr.probe(F.attrEvil));
  assert.ok(!wire.includes('unbounded_attribute_source') && !wire.includes('attributes'),
    'and it never reaches the wire — the refusal shape is unchanged, so there is no existence oracle');
});

test('U26 control: the fixture ATTACKS — the p8 diff argv under the FULL neutraliser set runs it', async () => {
  // The refusal disabled is exactly this: raw git, the same argv gitread assembles, the same
  // neutralisers, no gate. If this stops creating the marker, the refusal has become unnecessary.
  await armAttr(F.attrEvil);
  await rawArgs(F.attrEvil, FULL_NEUTRALISERS().concat(P8_DIFF_ARGV));
  assert.deepEqual(await attrMarks(), ['ATTR_CLEAN'],
    'the exact p8 diff argv, fully neutralised, still ran the repo-configured filter');

  await armAttr(F.attrEvil);
  await rawArgs(F.attrEvil, FULL_NEUTRALISERS().concat(P8_STATUS_ARGV));
  assert.deepEqual(await attrMarks(), ['ATTR_CLEAN'], 'and so did the exact p8 status argv');
});

test('U26 retirement pin: `--attr-source=<empty tree>` STILL fails to bound info/attributes', async () => {
  // Not folklore: the refusal exists only because of this measurement, so the measurement is a
  // test. The day a git release bounds `info/attributes`, THIS fails — loudly, naming the reason —
  // and the refusal above can be deleted rather than carried forever.
  await armAttr(F.attrEvil);
  const withBound = await rawArgs(F.attrEvil, FULL_NEUTRALISERS().concat(P8_DIFF_ARGV));
  assert.deepEqual(await attrMarks(), ['ATTR_CLEAN'],
    'RETIREMENT PIN: --attr-source does not bound <commonDir>/info/attributes on this git — ' +
    'if this fails, git closed the door: retire the refusal, do not weaken this test');
  assert.equal(withBound.code, 0, 'and the read itself succeeded, so the marker is not an error artefact');

  // The discriminator, so the pin cannot pass for the wrong reason: the SAME driver named from the
  // WORKING TREE instead is bounded — proof that --attr-source works and only this file escapes it.
  await armAttr(F.attrMacro);
  const treeSide = await rawArgs(F.attrMacro,
    FULL_NEUTRALISERS().concat(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', 'f.txt']));
  assert.deepEqual(await attrMarks(), [], 'a tree-side .gitattributes IS bounded by --attr-source');
  assert.equal(treeSide.code, 0);
});

test('U26: NOT a blanket ban — an info/attributes that assigns no driver reads normally', async () => {
  await armAttr(F.attrNoDriver);
  const { gr } = makeRead();
  const p = await gr.probe(F.attrNoDriver);
  assert.equal(p.repo, F.attrNoDriver, 'the file exists, assigns no driver, and the repo is admitted');
  const st = await gr.status(F.attrNoDriver);
  assert.ok(st.files.some((f) => f.path === 'f.txt'), 'status reports its real dirt');
  const df = await gr.diff(F.attrNoDriver, 'f.txt', false);
  assert.ok(df.diff.includes('+aaab'), 'and diff returns a real hunk');
  assert.deepEqual(await attrMarks(), [], 'with no marker — the driver in its config was never selected');
  // Non-vacuous: the fixture really does carry the file, and it really does carry `diff` — the
  // token that a naive substring match would refuse on.
  const body = await fsp.readFile(path.join(F.attrNoDriver, '.git', 'info', 'attributes'), 'utf8');
  assert.ok(body.includes('diff'), 'the admitted file really does mention `diff` — bare, with no =driver');
});

test('U26: NOT a blanket ban — a `#`-commented driver line is admitted, uncommented it refuses', async () => {
  const info = path.join(F.attrCommented, '.git', 'info', 'attributes');
  const commented = await fsp.readFile(info, 'utf8');
  assert.ok(commented.startsWith('#') && commented.includes('filter=ev'),
    'the fixture really is a commented-out driver assignment');

  await armAttr(F.attrCommented);
  const { gr } = makeRead();
  assert.equal((await gr.probe(F.attrCommented)).repo, F.attrCommented, 'commented: admitted');
  assert.ok((await gr.status(F.attrCommented)).files.length >= 1, 'and it reads');
  assert.deepEqual(await attrMarks(), [], 'no marker — git ignored the comment too');

  try {
    // The control, on the SAME repo: strip the `#` and nothing else. If this still admitted, the
    // arm above would prove nothing about the comment.
    await fsp.writeFile(info, commented.replace(/^#\s*/, ''));
    await armAttr(F.attrCommented);
    const { gr: gr2 } = makeRead();
    assert.deepEqual(await gr2.probe(F.attrCommented), { repo: null },
      'one `#` removed and the same repo is refused — the comment is what admitted it');
    assert.deepEqual(await attrMarks(), [], 'and refusing it ran nothing');
  } finally {
    await fsp.writeFile(info, commented);
  }
});

test('U26: the `diff=` half is refused too — defence for the routes that do not carry the flags', async () => {
  await armAttr(F.attrDiffDriver);
  const { gr, rec } = makeRead();
  assert.deepEqual(await gr.probe(F.attrDiffDriver), { repo: null }, 'a `diff=` assignment refuses the repo');
  await assert.rejects(gr.diff(F.attrDiffDriver, 'f.txt', false), (e) => e.status === 403);
  assert.equal(postGateSpawns(rec, F.attrDiffDriver).length, 0, 'no post-gate spawn');

  // MEASURED, and the reason this arm is not superstition: today's `diff` call site suppresses both
  // driver kinds with its two SUBCOMMAND flags...
  await armAttr(F.attrDiffDriver);
  await rawArgs(F.attrDiffDriver, FULL_NEUTRALISERS().concat(P8_DIFF_ARGV));
  assert.deepEqual(await attrMarks(), [],
    '--no-ext-diff + --no-textconv do suppress the info/attributes-selected diff driver TODAY');

  // ...and drop those two flags — the only thing a new route has to forget — and it executes.
  await armAttr(F.attrDiffDriver);
  await rawArgs(F.attrDiffDriver, FULL_NEUTRALISERS().concat(['diff', '--no-color', '--', 'f.txt']));
  const m = await attrMarks();
  assert.ok(m.length >= 1, `a diff route without the two flags DOES run it (got ${JSON.stringify(m)})`);
});

test('U26: a macro whose driver is named only in the TREE is admitted — and is genuinely inert', async () => {
  // The completeness question for a TOKEN test: can info/attributes select a driver while carrying
  // no `filter=`/`diff=` token of its own? Only via a macro defined elsewhere — and the only
  // "elsewhere" a browsed repo controls is the tree, which --attr-source bounds.
  const info = await fsp.readFile(path.join(F.attrMacro, '.git', 'info', 'attributes'), 'utf8');
  assert.ok(!/filter=|diff=/.test(info), 'the applying line carries no driver token at all');
  const tree = await fsp.readFile(path.join(F.attrMacro, '.gitattributes'), 'utf8');
  assert.ok(tree.includes('[attr]evil filter=ev'), 'and the definition really is a macro in the tree');

  await armAttr(F.attrMacro);
  const { gr } = makeRead();
  assert.equal((await gr.probe(F.attrMacro)).repo, F.attrMacro, 'admitted — no unbounded token to see');
  await gr.status(F.attrMacro);
  await gr.diff(F.attrMacro, 'f.txt', false);
  assert.deepEqual(await attrMarks(), [], 'and NOTHING ran: --attr-source bounded the definition');

  // Control: the same fixture, same neutralisers, --attr-source removed. If this does not fire, the
  // arm above proves nothing — the macro would simply never have worked.
  await armAttr(F.attrMacro);
  await rawArgs(F.attrMacro, [...NEUTRALISERS].concat(P8_DIFF_ARGV));
  assert.deepEqual(await attrMarks(), ['ATTR_CLEAN'],
    'without --attr-source the tree-defined macro DOES run the filter — the fixture attacks');
});

test('U26: the refusal is a plain fs read of the COMMON dir — no spawn, and pure', async () => {
  assert.equal(typeof assignsAttributeDriver, 'function', 'exported by name, like parseAlternates');
  assert.equal(assignsAttributeDriver('f.txt filter=ev\n'), true, 'a boolean, never a promise');

  const { gr, rec } = makeRead();
  rec.log.length = 0;
  assert.deepEqual(await gr.probe(F.attrEvil), { repo: null });
  assert.ok(!rec.log.some((c) => c.args.some((a) => /info\/attributes|--git-path/.test(a))),
    'rule 4 constraint 1: never `rev-parse --git-path info/attributes`');
  assert.equal(await unboundedAttributeSource(path.join(F.attrEvil, '.git')), true, 'commonDir, read directly');
  assert.equal(await unboundedAttributeSource(path.join(F.child, '.git')), false, 'absent is NOT an escape');
  assert.equal(await unboundedAttributeSource(path.join(F.child, '.git', 'HEAD')), false,
    'ENOTDIR is absence too — there is no such file to read');

  // The other direction of fail-closed: a layer that EXISTS but cannot be READ is unbounded by
  // another name — p8 cannot claim to have neutralised what it never saw. (A directory at that
  // path is the deterministic way to make the read fail without touching permissions.)
  const blocked = path.join(F.child, '.git', 'info', 'attributes');
  try {
    await fsp.mkdir(blocked, { recursive: true });
    assert.equal(await unboundedAttributeSource(path.join(F.child, '.git')), true,
      'an unreadable info/attributes refuses — absence is admitted, illegibility is not');
    assert.deepEqual(await gr.probe(F.child), { repo: null }, 'and the whole repo is refused for it');
  } finally {
    await fsp.rm(path.join(F.child, '.git', 'info'), { recursive: true, force: true });
  }
  assert.equal((await gr.probe(F.child)).repo, F.child, 'restored: the same repo reads again');

  // MEASURED: `info/attributes` is a COMMON-dir path — a per-worktree copy is never read by git, so
  // commonDir is the whole surface and a linked worktree inherits its main repo's verdict.
  const linkedGitDir = path.join(F.altIn, '.git', 'worktrees', path.basename(F.altInWt));
  await fsp.mkdir(path.join(linkedGitDir, 'info'), { recursive: true });
  try {
    await fsp.writeFile(path.join(linkedGitDir, 'info', 'attributes'), 'f.txt filter=ev\n');
    assert.equal((await gr.probe(F.altInWt)).repo, F.altInWt,
      'a per-worktree info/attributes is not an attribute source, so it is not a refusal either');
  } finally {
    await fsp.rm(path.join(linkedGitDir, 'info'), { recursive: true, force: true });
  }
});

test('U26 grammar: what counts as assigning a driver, measured against git\'s own parse', async () => {
  const y = (t, why) => assert.equal(assignsAttributeDriver(t), true, why);
  const n = (t, why) => assert.equal(assignsAttributeDriver(t), false, why);
  n('', 'empty');
  n('\n\n', 'blank lines');
  n('# f.txt filter=ev\n', 'a leading `#` is a comment');
  n('  # f.txt filter=ev\n', 'git skips blanks BEFORE the `#` test, so an indented `#` is one too');
  n('* -text\n', 'unsetting text is not a driver');
  n('f.txt diff\n', 'bare `diff` marks a file textual — it selects no driver');
  n('f.txt -diff\n', 'and `-diff` marks it binary');
  n('f.txt merge=ours\n', 'merge drivers never run on a read path');
  y('f.txt filter=ev\n', 'the door itself');
  y('  * filter=ev\n', 'MEASURED: an INDENTED rule still applies, so it still refuses');
  y('f.txt\tfilter=ev\n', 'MEASURED: tab-separated fires');
  y('f.txt filter=ev\r\n', 'MEASURED: CRLF fires');
  y('"a b.txt" filter=ev\n', 'MEASURED: a quoted pattern with a space fires');
  y('[attr]evil filter=ev\n', 'a macro DEFINITION carries the token like any other line');
  y('* -text\n\n# a comment\nf.txt diff=dtc\n', 'one offending line among inert ones is enough');
  y('f.txt filter=\n', 'an empty driver name is still an assignment — fail closed');
  n('/keeps#hash filter\n', 'a `#` that is not leading is a path byte, and `filter` alone is no driver');
});

// ---- C1: the gate's fs reads are BOUNDED ------------------------------------------------------
// Every rule above costs a plain fs read of a file the BROWSED REPO owns. Unbounded, each one is a
// denial of the whole p8 surface, and `.git/info/attributes` — the file rule 3 declares
// attacker-controlled — is the cheapest place to plant one. Every assertion below is wrapped in a
// DEADLINE (`within`): the defect's signature is "never answers", and a test that hangs is not a
// failing test, so the fix must be provably falsifiable by reverting it.

const mkfifo = (p) => new Promise((resolve, reject) =>
  execFile('/usr/bin/mkfifo', [p], (e) => (e ? reject(e) : resolve())));

const tmpDir = async (label) =>
  fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `p8-${label}-`)));

// Resolves to the value, or FAILS the test — never pends. Returns the value so it composes.
async function within(ms, p, why) {
  const t0 = Date.now();
  const out = await Promise.race([
    Promise.resolve(p).then((v) => ({ v })),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
  assert.ok(out, `${why} — STILL PENDING after ${ms}ms (waited ${Date.now() - t0}ms)`);
  return out.v;
}

// An anchor with one nested repo inside it, built fresh so an armed `.git` can never leak between
// arms. `arm` runs against the nested repo's `.git` AFTER the commit — a repo reached by browsing.
async function nestedFixture(label, arm) {
  const base = await tmpDir(label);
  const parent = path.join(base, 'parent');
  await fsp.mkdir(parent);
  await g(base, ['init', '-q', '-b', 'main', parent]);
  await fsp.writeFile(path.join(parent, '.gitignore'), '*\n');
  await fsp.writeFile(path.join(parent, 'p.txt'), 'p\n');
  await g(parent, ['add', '-f', '.gitignore', 'p.txt']);
  await g(parent, ['commit', '-q', '-m', 'root']);
  const inner = path.join(parent, 'inner');
  await fsp.mkdir(inner);
  await g(base, ['init', '-q', '-b', 'main', inner]);
  await fsp.writeFile(path.join(inner, 'f.txt'), 'f\n');
  await g(inner, ['add', '-A']);
  await g(inner, ['commit', '-q', '-m', 'inner root']);
  if (arm) await arm(inner, path.join(inner, '.git'));
  const events = [];
  const rec = makeRecordingRun();
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: parent }],
    run: rec.run,
    jail: acceptEverything,
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
    log: (r) => events.push(r),
  });
  return { base, parent, inner, gr, rec, events,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

test('C1 primitive: readGateFile answers on a non-regular file where fsp.readFile blocks forever', async () => {
  const d = await tmpDir('c1-prim');
  try {
    const fifo = path.join(d, 'fifo');
    await mkfifo(fifo);
    assert.ok((await fsp.lstat(fifo)).isFIFO(), 'the fixture really is a FIFO');
    const reg = path.join(d, 'reg');
    await fsp.writeFile(reg, 'hello\n');
    const dir = path.join(d, 'dir');
    await fsp.mkdir(dir);
    const link = path.join(d, 'link');
    await fsp.symlink(fifo, link);
    const big = path.join(d, 'big');
    await fsp.writeFile(big, Buffer.alloc(GATE_READ_MAX_BYTES + 1, 0x61));

    const t0 = Date.now();
    assert.deepEqual(await within(2000, readGateFile(fifo), 'the FIFO read'),
      { ok: false, absent: false, reason: 'not_regular' });
    assert.ok(Date.now() - t0 < 1000, `and it answered promptly (${Date.now() - t0}ms), never blocked`);
    assert.deepEqual(await within(2000, readGateFile(link), 'the symlinked FIFO'),
      { ok: false, absent: false, reason: 'not_regular' },
      'a SYMLINK to a FIFO is caught by its TARGET type — the fstat is on the descriptor, so there '
      + 'is no lstat-then-open window to swap through');
    assert.deepEqual(await within(2000, readGateFile(dir), 'the directory'),
      { ok: false, absent: false, reason: 'not_regular' });
    assert.deepEqual(await within(2000, readGateFile(big), 'the oversize file'),
      { ok: false, absent: false, reason: 'too_big' });
    // Only true absence is `absent` — the one distinction every caller keys on.
    assert.deepEqual(await readGateFile(path.join(d, 'nope')), { ok: false, absent: true, reason: 'ENOENT' });
    assert.deepEqual(await readGateFile(path.join(reg, 'x')), { ok: false, absent: true, reason: 'ENOTDIR' });
    assert.deepEqual(await readGateFile(reg), { ok: true, text: 'hello\n' }, 'a regular file reads exactly');

    // The cap REFUSES; it never truncates. An at-cap file is delivered to its LAST BYTE, which is
    // what makes "over the cap is a refusal" the only reachable way to hide a token behind size.
    const atCap = path.join(d, 'atcap');
    await fsp.writeFile(atCap, 'a'.repeat(GATE_READ_MAX_BYTES - 1) + 'Z');
    const r = await within(2000, readGateFile(atCap), 'the at-cap read');
    assert.equal(r.ok, true);
    assert.equal(r.text.length, GATE_READ_MAX_BYTES, 'the whole file');
    assert.ok(r.text.endsWith('Z'), 'to the last byte — never a prefix');

    // The cap is per-caller: a `gitdir` file holds ONE path, so it gets the tighter one.
    const sized = path.join(d, 'sized');
    await fsp.writeFile(sized, 'a'.repeat(70000));
    assert.equal((await readGateFile(sized, 65536)).reason, 'too_big', 'the tight cap bites');
    assert.equal((await readGateFile(sized)).ok, true, 'and the default cap admits the same file');

    // CONTROL, and it is the defect itself: the primitive this replaced never returns on the SAME
    // file. Released at the end by opening a writer, so no threadpool thread is left parked.
    const blocked = fsp.readFile(fifo, 'utf8');
    const raced = await Promise.race([
      blocked.then(() => 'RETURNED'),
      new Promise((res) => setTimeout(() => res('BLOCKED'), 750)),
    ]);
    assert.equal(raced, 'BLOCKED', 'MEASURED: fsp.readFile on a FIFO blocks — this is what was in the gate');
    const w = await fsp.open(fifo, 'w');
    await w.close();
    assert.equal(await blocked, '', 'it only returns once a WRITER appears — never on its own');
  } finally { await fsp.rm(d, { recursive: true, force: true }); }
});

test('C1: a FIFO info/attributes refuses the repo — and does not retire the admission slots', async () => {
  const f = await nestedFixture('c1-fifo', async (inner, gitDir) => {
    await fsp.mkdir(path.join(gitDir, 'info'), { recursive: true });
    await mkfifo(path.join(gitDir, 'info', 'attributes'));
  });
  try {
    assert.ok((await fsp.lstat(path.join(f.inner, '.git', 'info', 'attributes'))).isFIFO(),
      'the attacker-controlled attribute source really is a FIFO');

    // TWO probes, because the admission semaphore is width 2: pre-fix both bodies park forever and
    // `finally { admitRelease() }` never runs, so the two slots are gone for the process lifetime.
    const both = await within(8000, Promise.all([f.gr.probe(f.inner), f.gr.probe(f.inner)]),
      'two probes of the FIFO-armed repo');
    assert.deepEqual(both, [{ repo: null }, { repo: null }],
      'the shared refusal shape — illegible is refused, exactly like the unreadable arm above');

    // The proof that the slots came back: an ordinary probe of the HEALTHY anchor, which pre-fix
    // died probe_busy/503 at the 4000 ms acquisition deadline.
    const t0 = Date.now();
    const benign = await within(4000, f.gr.probe(f.parent), 'a benign probe of a healthy repo');
    assert.equal(benign.repo, f.parent, 'the healthy anchor still answers');
    assert.ok(Date.now() - t0 < 3000, `and it was not queued behind a dead body (${Date.now() - t0}ms)`);

    // The read routes have no admission semaphore but the same gate, so they took the same hang.
    await within(4000, rejects403(f.gr.status(f.inner)), 'status on the FIFO-armed repo');
    await within(4000, rejects403(f.gr.diff(f.inner, 'f.txt', false)), 'diff on the FIFO-armed repo');

    // The SECOND failure mode, which is not about slots at all: a blocked readFile parks a libuv
    // THREADPOOL thread, and the pool is shared with everything else in the process — fsbrowse's
    // stat included. Enough concurrent reads to exhaust the default pool, then the stat.
    const pool = Number(process.env.UV_THREADPOOL_SIZE) || 4;
    const many = Array.from({ length: pool + 2 },
      () => unboundedAttributeSource(path.join(f.inner, '.git')));
    const verdicts = await within(8000, Promise.all(many), `${pool + 2} concurrent gate reads`);
    assert.deepEqual(verdicts, many.map(() => true), 'each one refused, none of them hung');
    const t1 = Date.now();
    await within(2000, fsp.stat(f.parent), 'fs.stat after the pool was hammered');
    assert.ok(Date.now() - t1 < 1000, `the threadpool is still live (${Date.now() - t1}ms)`);

    // Non-vacuous: with the FIFO gone the SAME repo reads normally, so the refusal is the file's
    // doing and not the fixture's.
    await fsp.rm(path.join(f.inner, '.git', 'info', 'attributes'));
    assert.equal((await f.gr.probe(f.inner)).repo, f.inner, 'restored: the same repo probes again');
  } finally { await f.cleanup(); }
});

test('C1: an OVERSIZE info/attributes refuses on SIZE — the cap never truncates a driver out of view', async () => {
  // Four arms, one variable each. The pair that matters is (a) vs (c): over the cap refuses whatever
  // it says, under the cap is judged on what it says — so an attacker cannot buy admission with
  // bulk, and an ordinary repo is not refused for having a large attributes file's worth of rules.
  const arms = [
    ['oversize, driver token PAST the cap', GATE_READ_MAX_BYTES + 4096, 'f.txt filter=ev\n', true],
    ['oversize, no driver token anywhere', GATE_READ_MAX_BYTES + 4096, '* -text\n', true],
    ['under the cap, no driver token', GATE_READ_MAX_BYTES - 4096, '* -text\n', false],
    ['under the cap, driver token at the very END', GATE_READ_MAX_BYTES - 4096, 'f.txt filter=ev\n', true],
  ];
  for (const [label, size, tail, refused] of arms) {
    const f = await nestedFixture('c1-big', async (inner, gitDir) => {
      await fsp.mkdir(path.join(gitDir, 'info'), { recursive: true });
      // Filler lines are exactly 80 bytes each, so the body always ends on a line boundary and the
      // tail is never swallowed into a trailing comment.
      const filler = `# ${'x'.repeat(77)}\n`.repeat(Math.ceil((size - tail.length) / 80));
      await fsp.writeFile(path.join(gitDir, 'info', 'attributes'), filler + tail);
    });
    try {
      const st = await fsp.stat(path.join(f.inner, '.git', 'info', 'attributes'));
      assert.equal(st.size > GATE_READ_MAX_BYTES, size > GATE_READ_MAX_BYTES,
        `${label}: the fixture really is on the intended side of the cap (${st.size} bytes)`);
      const p = await within(8000, f.gr.probe(f.inner), `${label}: probe`);
      if (refused) assert.deepEqual(p, { repo: null }, `${label}: refused, through the shared shape`);
      else assert.equal(p.repo, f.inner, `${label}: admitted — the cap is not a blanket ban`);
    } finally { await f.cleanup(); }
  }
});

test('C1: an illegible objects/info/alternates refuses the WHOLE repo — an unbounded object store', async () => {
  const f = await nestedFixture('c1-alt', async (inner, gitDir) => {
    await fsp.mkdir(path.join(gitDir, 'objects', 'info'), { recursive: true });
    await mkfifo(path.join(gitDir, 'objects', 'info', 'alternates'));
  });
  try {
    const t = { top: f.inner, gitDir: path.join(f.inner, '.git'), commonDir: path.join(f.inner, '.git') };
    const paths = await within(4000, metadataPaths(t), 'metadataPaths over a FIFO alternates');
    assert.ok(paths.has(METADATA_UNREADABLE),
      'the path set carries the marker — an alternates p8 cannot read may point anywhere');
    assert.ok(!path.isAbsolute(METADATA_UNREADABLE),
      'and the marker can never be isInside() any root, so it cannot be accidentally cleared');

    assert.deepEqual(await within(4000, f.gr.probe(f.inner), 'probe'), { repo: null },
      'so the repo is refused whole, through the shared shape');
    assert.ok(f.events.some((e) => e.event === 'refuse' && e.reason === 'unreadable_object_store'),
      'and the reason is diagnosable server-side, like every other refusal');

    // Non-vacuous: absence is still admitted (constraint 2) and a legible in-union alternates is
    // still admitted — the refusal is illegibility, not the presence of the file.
    await fsp.rm(path.join(f.inner, '.git', 'objects', 'info', 'alternates'));
    assert.equal((await f.gr.probe(f.inner)).repo, f.inner, 'absent: admitted');
    await fsp.writeFile(path.join(f.inner, '.git', 'objects', 'info', 'alternates'),
      `${path.join(f.parent, '.git', 'objects')}\n`);
    assert.equal((await f.gr.probe(f.inner)).repo, f.inner, 'legible and in-union: admitted');
  } finally { await f.cleanup(); }
});

test('C1: a hostile sibling gitdir settles — and git\'s OWN read reaches the FIFO first', async () => {
  const f = await nestedFixture('c1-sib');
  try {
    const wt = path.join(f.parent, 'wt');
    await g(f.parent, ['worktree', 'add', '-q', wt, '-b', 'wt-branch']);
    const gitdirFile = path.join(f.parent, '.git', 'worktrees', 'wt', 'gitdir');

    // Control FIRST, on the untouched fixture: this sibling really does read.
    const before = await within(15000, f.gr.worktrees(f.parent), 'worktrees, before');
    const rowBefore = before.worktrees.find((w) => path.resolve(w.path) === wt);
    assert.ok(rowBefore && rowBefore.dirty !== null, 'control: the sibling reports a real count');

    // OVERSIZE, which is the mode that reaches gitread at all: MEASURED on git 2.50.1, `worktree
    // list --porcelain` reads a multi-megabyte `gitdir` happily and reports the entry, so the module
    // does read this file — unbounded, that was a per-request full-file allocation. Bounded, the
    // sibling is simply unresolvable.
    await fsp.writeFile(gitdirFile, `${wt}/.git\n${'x'.repeat(2 * 1024 * 1024)}`);
    f.rec.log.length = 0;
    const big = await within(15000, f.gr.worktrees(f.parent), 'worktrees, oversize gitdir');
    assert.ok(!big.error, 'the route still answers');
    for (const row of big.worktrees) {
      if (path.resolve(row.path) === f.parent) continue;                 // the anchor stanza itself
      assert.equal(row.dirty, null, 'the sibling reads nothing off an unresolvable identity');
    }
    assert.ok(!f.rec.log.some((c) => c.dir === wt), 'and no child was spawned in its path');

    // FIFO. THE REVIEW PUTS THIS FILE IN C1's HANG SET, AND IT IS BOUNDED FOR UNIFORMITY — but
    // MEASURED, it is not the live hazard the other two are: `git worktree list --porcelain` opens
    // every registered `gitdir` ITSELF and blocks on the FIFO, so gitread's spawn timeout fires
    // first and `worktrees()` returns before `siblingGitDirs` is ever called. The route fails
    // CLOSED either way, which is what this arm holds.
    await fsp.rm(gitdirFile);
    await mkfifo(gitdirFile);
    const fifo = await within(20000, f.gr.worktrees(f.parent), 'worktrees, FIFO gitdir');
    assert.deepEqual(Object.keys(fifo).sort(), ['detail', 'error'],
      'a git that cannot read its own metadata is a failed read, not a partial answer');
    assert.equal(fifo.error, 'git_failed');
  } finally { await f.cleanup(); }
});

test('C1 source-structure: no repo-owned fs read bypasses the bounded primitive', async () => {
  const src = await fsp.readFile(path.join(__dirname, '..', 'gitread.js'), 'utf8');
  assert.ok(!/fsp\.readFile\(/.test(src),
    'not one naked fsp.readFile survives in gitread — every file read goes through readGateFile');
  assert.ok(/O_NONBLOCK/.test(src), 'and the primitive opens non-blocking');
  // The deadline, asserted where it is APPLIED rather than where the constant is declared: a
  // constant that nothing references would satisfy a bare /GATE_READ_TIMEOUT_MS/ match.
  const w = src.indexOf('function readGateFile(');
  assert.ok(w > 0, 'the wrapper exists by name');
  const wrap = src.slice(w, src.indexOf('\n}', w));
  assert.ok(/withDeadline\(/.test(wrap), 'every gate read is raced against a deadline');
  assert.ok(/GATE_READ_TIMEOUT_MS/.test(wrap), 'the same bound every spawn already carries');
  assert.ok(/reason: 'timeout'/.test(wrap), 'and a read that outruns it is a refusal, not a pass');
  const i = src.indexOf('async function readGateFileUnbounded(');
  assert.ok(i > 0, 'the primitive exists by name');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/st\.isFile\(\)/.test(body), 'it fstats the DESCRIPTOR and demands a regular file');
  assert.ok(/st\.size > cap/.test(body), 'and refuses over the cap rather than truncating');
});

// ---- U24: object-store containment -------------------------------------------------------------

const postGateSpawns = (rec, dir) => rec.log.filter((c) => c.dir === dir && c.env);

test('U24: an alternates escape refuses the WHOLE repo — {repo:null}, 403, and no post-gate spawn', async () => {
  const { gr, rec } = makeRead();
  assert.deepEqual(await gr.probe(F.altOut), { repo: null }, 'probe: the shared refusal shape');
  await rejects403(gr.authorizeRead(F.altOut));
  for (const fn of ['status', 'branches', 'worktrees']) {
    await assert.rejects(gr[fn](F.altOut), (e) => e.status === 403, `${fn} refused 403`);
  }
  await assert.rejects(gr.diff(F.altOut, 'f.txt', false), (e) => e.status === 403, 'diff refused 403');
  assert.equal(postGateSpawns(rec, F.altOut).length, 0,
    'the runner log shows no status/branches/diff spawn ever ran against it');
});

test('U24 control: the fixture ATTACKS — unchecked, the outside oid, filename and blob are reachable', async () => {
  const st = await rawArgs(F.altOut, ['status', '--porcelain=v2', '--branch']);
  assert.ok(st.stdout.includes(F.outsideOid), 'the OUTSIDE commit oid is reported under an in-union tuple');
  assert.ok(st.stdout.includes('external-secret.txt'), 'and the outside tracked filename');
  const blob = await rawArgs(F.altOut, ['cat-file', '-p', `${F.outsideOid}:external-secret.txt`]);
  assert.ok(blob.stdout.includes('SECRET'), 'and the outside blob content is readable through the alternate');
});

test('U24: a RECURSIVE alternate (inside -> inside -> outside) is refused at depth 2', async () => {
  const { gr } = makeRead();
  assert.deepEqual(await gr.probe(F.altHop), { repo: null }, 'the hop itself escapes at depth 1');
  assert.deepEqual(await gr.probe(F.altChain), { repo: null }, 'and the repo that only reaches it at depth 2');
  const paths = [...await metadataPaths({
    top: F.altChain,
    gitDir: path.join(F.altChain, '.git'),
    commonDir: path.join(F.altChain, '.git'),
  })];
  assert.ok(paths.includes(path.join(F.outside, '.git', 'objects')),
    'metadataPaths really followed the chain to the outside store rather than stopping at hop 1');
});

test('U24: a CYCLIC alternates chain terminates rather than hanging, and stays admitted', async () => {
  const { gr } = makeRead();
  const t0 = Date.now();
  const a = await gr.probe(F.altCycA);
  const b = await gr.probe(F.altCycB);
  assert.ok(Date.now() - t0 < 5000, 'the cycle terminated on the visited set');
  assert.equal(a.repo, F.altCycA, 'a -> b -> a is entirely in-union, so it is admitted');
  assert.equal(b.repo, F.altCycB);
});

test('U24: a RELATIVE alternate resolves against the objects dir that named it, not the cwd', async () => {
  const { gr } = makeRead();
  assert.deepEqual(await gr.probe(F.altRel), { repo: null },
    'the relative entry reached the outside store and refused');
  // The discriminator: resolved against the CWD the route runs in (<top>), the same string would
  // land somewhere else entirely and the escape would be missed.
  const objects = path.join(F.altRel, '.git', 'objects');
  const entry = parseAlternates(await fsp.readFile(path.join(objects, 'info', 'alternates'), 'utf8'))[0];
  assert.ok(!path.isAbsolute(entry), 'the fixture entry really is relative');
  assert.equal(path.resolve(objects, entry), path.join(F.outside, '.git', 'objects'), 'resolved against the objects dir');
  assert.notEqual(path.resolve(F.altRel, entry), path.join(F.outside, '.git', 'objects'), 'and NOT against the top');
});

test('U24: an alternate that stays INSIDE the union is admitted — comment-bearing arm', async () => {
  const { gr } = makeRead();
  const p = await gr.probe(F.altIn);
  assert.equal(p.repo, F.altIn, 'the check is not a blanket ban');
  const st = await gr.status(F.altIn);
  assert.equal(st.repo, F.altIn, 'and the read routes answer normally');
  // Constraint 3: the comment and blank line must not become an ENOENT that reads as an escape.
  const body = await fsp.readFile(path.join(F.altIn, '.git', 'objects', 'info', 'alternates'), 'utf8');
  assert.ok(body.includes('#'), 'the fixture really carries a comment line');
  assert.deepEqual(parseAlternates(body), [path.join(F.altPlain, '.git', 'objects')],
    'blank and #-leading lines are skipped, so neither becomes a refusal');
});

test('U24: an alternate that stays INSIDE the union is admitted — LINKED-WORKTREE arm', async () => {
  // Constraint 2: <gitDir>/objects is ABSENT on every linked worktree. ENOENT-as-escape would
  // refuse every linked-worktree anchor — including the one this branch is developed in.
  const gitDir = path.join(F.altIn, '.git', 'worktrees', path.basename(F.altInWt));
  await assert.rejects(fsp.stat(path.join(gitDir, 'objects')), (e) => e.code === 'ENOENT',
    'the linked worktree really has no objects dir of its own');
  const { gr } = makeRead();
  const p = await gr.probe(F.altInWt);
  assert.equal(p.repo, F.altInWt, 'and it is still browsable');
  const st = await gr.status(F.altInWt);
  assert.equal(st.repo, F.altInWt);
});

test('U24: metadataPaths is exported by name and costs NO spawn', async () => {
  assert.equal(typeof metadataPaths, 'function', 'exported by name — rule 4 stays additive');
  const { gr, rec } = makeRead();
  await gr.authorizeRead(F.child);
  rec.log.length = 0;
  const paths = await metadataPaths({
    top: F.child, gitDir: path.join(F.child, '.git'), commonDir: path.join(F.child, '.git'),
  });
  assert.equal(rec.log.length, 0, 'plain fs reads only — never `rev-parse --git-path objects`');
  assert.ok(paths.has(path.join(F.child, '.git', 'objects')), 'the object store is a member');
  assert.ok(paths.has(F.child) && paths.has(path.join(F.child, '.git')), 'and so is the tuple itself');
});

test('U24: alternates grammar — blanks, comments, and quoted C-escaped paths', async () => {
  assert.deepEqual(parseAlternates(''), []);
  assert.deepEqual(parseAlternates('\n\n# only comments\n\n'), []);
  assert.deepEqual(parseAlternates('/a/b\n# c\n\n/d/e\n'), ['/a/b', '/d/e']);
  assert.deepEqual(parseAlternates('"/a/with space"\n'), ['/a/with space']);
  assert.deepEqual(parseAlternates('"/a/tab\\there"\n'), ['/a/tab\there']);
  assert.deepEqual(parseAlternates('"/a/quote\\"x"\n'), ['/a/quote"x']);
  assert.deepEqual(parseAlternates('"/a/oct\\101z"\n'), ['/a/octAz'], 'octal escape');
  assert.deepEqual(parseAlternates('/keeps#hash\n'), ['/keeps#hash'], 'a # that is not leading is a path byte');
});

// ---- U25: the sibling boundary is the narrow union, not the fs jail ----------------------------

// The FS_ROOTS=workspace-cwds:/ shape the operator actually runs: a jail that admits everything.
const acceptEverything = async (p) => fsp.realpath(p);

test('U25: an accept-everything jail changes nothing — an out-of-union sibling reads nothing', async () => {
  const rec = makeRecordingRun();
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: F.parent }],
    run: rec.run,
    jail: acceptEverything,
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  const d = await gr.worktrees(F.parent);
  assert.ok(!d.error, 'worktrees answered');
  const far = d.worktrees.find((w) => path.resolve(w.path) === F.wtFar);
  assert.ok(far, 'the out-of-union linked worktree is listed');
  assert.equal(far.dirty, null, 'dirty:null even though the jail would admit it');
  assert.ok(!rec.log.some((c) => c.dir === F.wtFar), 'and NO status child was ever spawned for it');
  // Non-vacuous: the in-union sibling in the SAME response did spawn and did report.
  const near = d.worktrees.find((w) => path.resolve(w.path) === path.join(F.parent, 'wt-in'));
  assert.ok(rec.log.some((c) => c.dir === path.join(F.parent, 'wt-in') && c.args.includes('status')),
    'control: the in-union sibling in the same call DID spawn');
  assert.ok(near && near.dirty !== null, 'and reported a real count');
});

test('U25 control: the SAME sibling inside the narrow union reports its real dirty count', async () => {
  const rec = makeRecordingRun();
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 'a', path: F.parent }, { label: 'b', path: F.wtFar }],
    run: rec.run,
    jail: acceptEverything,
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  const d = await gr.worktrees(F.parent);
  const far = d.worktrees.find((w) => path.resolve(w.path) === F.wtFar);
  assert.ok(far.dirty >= 1, 'anchored, it is in the union and reports its own dirt — not a blanket refusal');
  assert.ok(rec.log.some((c) => c.dir === F.wtFar && c.args.includes('status')), 'and it did spawn');
});

// ---- U25, the LURE arm (C2): the union test must judge the path git will actually read ---------
// U25's out-of-union fixture is a REAL directory, so a lexical containment test passes it and a
// realpath'd one passes it too — the arm cannot tell the two apart. The discriminator is a path
// that is INSIDE the anchor lexically and OUTSIDE it in reality. `w.path` comes from
// `<commonDir>/worktrees/<id>/gitdir`, which the browsed repo writes and which git's worktree.c
// consumes by stripping `/.git` WITHOUT resolving it — the same file U24/U26 already treat as
// attacker-controlled. Point it at `<anchor>/lure` where `lure` is a symlink out of the anchor and
// the lexical check says "inside".
async function lureFixture(label) {
  const base = await tmpDir(label);
  const parent = path.join(base, 'parent');
  await fsp.mkdir(parent);
  await g(base, ['init', '-q', '-b', 'main', parent]);
  await fsp.writeFile(path.join(parent, '.gitignore'), '*\n');
  await fsp.writeFile(path.join(parent, 'p.txt'), 'p\n');
  await g(parent, ['add', '-f', '.gitignore', 'p.txt']);
  await g(parent, ['commit', '-q', '-m', 'root']);

  // A directory OUTSIDE every anchor holding files the operator never authorized.
  const secret = path.join(base, 'outside-secret');
  await fsp.mkdir(secret);
  for (let i = 0; i < 7; i++) await fsp.writeFile(path.join(secret, `s${i}.txt`), 'x\n');

  const wt = path.join(parent, 'wt');
  await g(parent, ['worktree', 'add', '-q', wt, '-b', 'wt-branch']);
  const rec = makeRecordingRun();
  const events = [];
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: parent }],
    run: rec.run,
    jail: acceptEverything,          // the operator's real FS_ROOTS shape: it saves nothing
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
    log: (r) => events.push(r),
  });
  const repoint = (target) => fsp.writeFile(
    path.join(parent, '.git', 'worktrees', 'wt', 'gitdir'), `${target}/.git\n`);
  return { base, parent, secret, wt, gr, rec, events, repoint,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

test('U25 lure arm: a sibling recorded at a SYMLINK out of the anchor reads nothing (C2)', async () => {
  // The label carries no `lure`/`link` substring on purpose: the fixture base is part of every path
  // in the response, so a substring match would find the ANCHOR row and quietly assert nothing.
  const f = await lureFixture('c2-sib');
  try {
    // Control first, and it is the whole point of the arm: the read gate itself REFUSES this path
    // by name. Anything p8 discloses about it is a widening the gate would not have granted.
    const lure = path.join(f.parent, 'lure');
    await fsp.symlink(f.secret, lure);
    await rejects403(f.gr.authorizeRead(lure));
    assert.equal(await fsp.realpath(lure), f.secret, 'and the lure really does leave the anchor');
    assert.ok(isInside(f.parent, path.resolve(lure)),
      'while LEXICALLY it is inside — this is the exact gap a path.resolve check cannot see');

    await f.repoint(lure);
    // The control above ran the gate on the lure, which legitimately spawns a tuple read on the
    // jail's return — clear the log so the spawn assertions below speak only about the ROUTE.
    f.rec.log.length = 0;
    const d = await within(15000, f.gr.worktrees(f.parent), 'worktrees over the lure');
    const row = (d.worktrees || []).find((w) => path.resolve(w.path) === lure);
    assert.ok(row, 'the row is listed — the shape does not disclose the refusal');
    assert.equal(row.dirty, null,
      'and it carries NO count: §3.3 rule 1 holds — p8 discloses nothing the gate would refuse, '
      + 'not even by a count');
    assert.ok(!f.rec.log.some((c) => c.dir === lure || c.dir === f.secret),
      'no child was spawned against the lure or its target');
    assert.ok(!f.rec.log.some((c) => c.env
      && (c.env.GIT_WORK_TREE === lure || c.env.GIT_WORK_TREE === f.secret)),
      'and no GIT_WORK_TREE ever named either of them');
    assert.ok(f.events.some((e) => e.event === 'refuse' && e.reason === 'sibling_outside_union'),
      'the refusal is diagnosable server-side, through rule 5 like any other');
    assert.equal((await fsp.readdir(f.secret)).length, 7,
      'and the 7 unauthorized files really are there — a leak would have been visible as a count');

    // NON-VACUOUS, and the regression this fix could plausibly cause: a symlinked spelling that
    // resolves back INSIDE the anchor must still read. Realpathing the recorded path is a
    // correction, not a new refusal.
    const inLink = path.join(f.parent, 'in-link');
    await fsp.symlink(f.wt, inLink);
    await fsp.appendFile(path.join(f.wt, 'p.txt'), 'sibling-dirt\n');   // TRACKED: `.gitignore *`
    await f.repoint(inLink);
    f.rec.log.length = 0;
    const d2 = await within(15000, f.gr.worktrees(f.parent), 'worktrees over the in-union symlink');
    const row2 = (d2.worktrees || []).find((w) => path.resolve(w.path) === inLink);
    assert.ok(row2, 'the symlinked sibling is listed');
    assert.ok(row2.dirty >= 1, 'and it reports its REAL dirty count — resolved back into the union');
    assert.ok(f.rec.log.some((c) => c.dir === f.wt && c.args.includes('status')),
      'the spawn ran on the RESOLVED path, not the symlinked spelling');
    assert.ok(f.rec.log.some((c) => c.env && c.env.GIT_WORK_TREE === f.wt),
      'and GIT_WORK_TREE is the resolved path too — authorized and spawned are one string');
  } finally { await f.cleanup(); }
});

test('U25 source-structure: siblingAuthorized takes no jail seam and performs no await', async () => {
  const src = await fsp.readFile(path.join(__dirname, '..', 'gitread.js'), 'utf8');
  const i = src.indexOf('function siblingAuthorized(');
  assert.ok(i > 0, 'the function exists by name');
  assert.ok(!/async function siblingAuthorized\(/.test(src), 'it is NOT async');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(!/await/.test(body), 'no await — the function is pure');
  assert.ok(!/jail/.test(body), 'no jail seam — the fs-jail fallback is gone');
  // Behavioural, so the regex above cannot be the whole proof: it returns a value, not a promise.
  const t = { top: '/vol1/disk/code/x' };
  assert.equal(siblingAuthorized(t, '/vol1/disk/code/x', []), true, 'the authorized top');
  assert.equal(siblingAuthorized(t, '/vol1/disk/code/y', []), false, 'anything else, with no anchors');
  assert.equal(siblingAuthorized(t, '/vol1/disk/code/y/wt', [{ top: '/vol1/disk/code/y' }]), true, 'inside the union');
  assert.equal(typeof siblingAuthorized(t, '/vol1/disk/code/y', []), 'boolean', 'a boolean, never a promise');
});

// ---- the diagnosis seam ------------------------------------------------------------------------

test('the log seam names each refusal reason server-side, and the WIRE shape does not change', async () => {
  const events = [];
  const { gr } = makeRead({ log: (r) => events.push(r), jail: acceptEverything });
  const refused = await gr.probe(F.altOut);
  assert.deepEqual(refused, { repo: null }, 'the wire shape is the shared refusal — no existence oracle');
  assert.ok(events.some((e) => e.event === 'refuse' && e.reason === 'objects_escape'),
    'rule 4 refusals are diagnosable server-side');

  events.length = 0;
  const d = await gr.worktrees(F.parent);
  const far = d.worktrees.find((w) => path.resolve(w.path) === F.wtFar);
  assert.equal(far.dirty, null, 'the wire shape is the ordinary dirty:null');
  assert.ok(events.some((e) => e.event === 'refuse' && e.reason === 'sibling_outside_union'),
    'rule 5 refusals are diagnosable server-side');
  assert.ok(!JSON.stringify(d).includes('sibling_outside_union'), 'and the reason never reaches the response');
});

// ---- U11a (a)–(g): the seven assertions promoted from prose to acceptance (v3.4, R8-MEDIUM) ----
// Separately named on purpose. Accumulating them into one compound assertion is what let the
// pre-v3.3 acceptance text survive a round without a single one of them being written.

test('U11a (a): a BARE stanza never spawns — dirty:null, and the p7 row shape is preserved', async () => {
  const { gr, rec } = makeRead({ workspaceCwds: async () => [{ label: 'b', path: F.bareWt }] });
  const d = await gr.worktrees(F.bareWt);
  assert.ok(!d.error, 'worktrees answered');
  const bareRow = d.worktrees.find((w) => w.bare);
  assert.ok(bareRow, 'the fixture really emits a `bare` stanza');
  assert.equal(path.resolve(bareRow.path), F.bareMain, 'and it is the bare common repository');
  assert.equal(bareRow.dirty, null, 'dirty:null — the derived env would report HEAD/objects/worktrees as dirt');
  assert.ok(!rec.log.some((c) => c.dir === F.bareMain), 'the runner log shows NO status child for it');
  assert.deepEqual(Object.keys(bareRow).sort(),
    ['bare', 'branch', 'detached', 'dirty', 'head', 'locked', 'path', 'prunable'],
    'p7 row shape preserved, plus p8\'s dirty');
  // Non-vacuous: the linked worktree beside it DID read.
  const live = d.worktrees.find((w) => path.resolve(w.path) === F.bareWt);
  assert.equal(live.dirty, 0, 'the linked worktree beside it reported a real (clean) count');
});

test('U11a (b): linked anchor -> MAIN stanza AUTHORIZED pins GIT_DIR=<commonDir>, not worktrees/<id>', async () => {
  const { gr, rec } = makeRead({
    workspaceCwds: async () => [{ label: 'w', path: F.mainBWt }, { label: 'm', path: F.mainB }],
  });
  const d = await gr.worktrees(F.mainBWt);
  const mainRow = d.worktrees.find((w) => path.resolve(w.path) === F.mainB);
  assert.ok(mainRow, 'the main worktree is listed beside the linked anchor');
  assert.equal(mainRow.dirty, 1, "the dirty count is the MAIN worktree's own");
  const spawn = rec.log.find((c) => c.dir === F.mainB && c.args.includes('status'));
  assert.ok(spawn, 'and it really spawned');
  const commonDir = path.join(F.mainB, '.git');
  assert.equal(spawn.env.GIT_DIR, commonDir, 'GIT_DIR is <commonDir> itself — the main-stanza rule');
  assert.ok(!spawn.env.GIT_DIR.includes(`${path.sep}worktrees${path.sep}`), 'NOT <commonDir>/worktrees/<id>');
  assert.equal(spawn.env.GIT_COMMON_DIR, commonDir);
  assert.equal(spawn.env.GIT_WORK_TREE, F.mainB);
});

test('U11a (c): linked anchor -> main REFUSED when main is outside the union — dirty:null, no spawn', async () => {
  const { gr, rec } = makeRead({
    workspaceCwds: async () => [{ label: 'w', path: F.mainBWt }],   // the main is NOT anchored
    jail: acceptEverything,                                         // and the jail cannot save it
  });
  const d = await gr.worktrees(F.mainBWt);
  const mainRow = d.worktrees.find((w) => path.resolve(w.path) === F.mainB);
  assert.ok(mainRow, 'still listed — the row shape does not disclose the refusal');
  assert.equal(mainRow.dirty, null, 'dirty:null');
  assert.ok(!rec.log.some((c) => c.dir === F.mainB), 'and NO spawn in its path');
  const selfRow = d.worktrees.find((w) => path.resolve(w.path) === F.mainBWt);
  assert.equal(selfRow.dirty, 0, 'control: the anchor stanza itself still read');
});

test('U11a (d): an UNBORN linked sibling carries its derived pin and reports a real dirty count', async () => {
  const sr = await rawArgs(F.wtUnborn, ['symbolic-ref', '--quiet', 'HEAD']);
  assert.equal(sr.code, 0, 'the fixture sibling really is unborn');
  assert.equal(sr.stdout, 'refs/heads/fresh\n', 'HEAD names a branch that does not exist yet');

  const { gr, rec } = makeRead();
  const d = await gr.worktrees(F.parent);
  const row = d.worktrees.find((w) => path.resolve(w.path) === F.wtUnborn);
  assert.ok(row, 'the unborn linked worktree is listed');
  assert.ok(row.dirty >= 1, 'and its dirty result is real — an unborn HEAD is not a failed read');
  const spawn = rec.log.find((c) => c.dir === F.wtUnborn && c.args.includes('status'));
  assert.ok(spawn, 'it spawned');
  assert.equal(spawn.env.GIT_DIR, path.join(F.parent, '.git', 'worktrees', path.basename(F.wtUnborn)),
    'pinned to its own DERIVED private dir, resolved by plain fs reads');
  assert.equal(spawn.env.GIT_COMMON_DIR, path.join(F.parent, '.git'));
  assert.equal(spawn.env.GIT_WORK_TREE, F.wtUnborn);
});

test("U11a (e): the unborn probe's exit-128 `symbolic-ref` fallback spawn carries the tuple pin", async () => {
  const { gr, rec } = makeRead();
  const out = await gr.probe(F.unbornIn);
  assert.equal(out.state, 'unborn', 'the fallback was really taken');
  const abbrev = rec.log.find((c) => c.dir === F.unbornIn && c.args.includes('--abbrev-ref'));
  const symref = rec.log.find((c) => c.dir === F.unbornIn && c.args.includes('symbolic-ref'));
  assert.ok(abbrev && symref, 'both branch reads are in the log — the 128 fallback fired');
  const pin = {
    GIT_DIR: path.join(F.unbornIn, '.git'),
    GIT_COMMON_DIR: path.join(F.unbornIn, '.git'),
    GIT_WORK_TREE: F.unbornIn,
  };
  assert.deepEqual(symref.env, pin, 'the RARE spawn is pinned too — not just the common one');
  assert.deepEqual(abbrev.env, pin);
});

test('U11a (f): probe is the SIXTH response shape — the live gitfile swap moves none of them', async () => {
  const { gr } = makeRead();
  // STORY-004 claims the seventh row: `command` is a response shape like the rest, and the swap
  // below must move it no more than it moves the others.
  const shapes = ['probe', 'status', 'branches', 'worktrees', 'diff', 'command'];
  for (const name of shapes) assert.equal(typeof gr[name], 'function', `${name} is a response shape`);

  // The swap fires from inside the runner seam, immediately before probe's FIRST pinned spawn —
  // the tightest gate-to-body interleaving there is.
  const swapTarget = path.join(F.child, '.git');
  const restore = async () => {
    try { const st = await fsp.lstat(swapTarget); if (st.isFile()) await fsp.rm(swapTarget); } catch (_) {}
    try { await fsp.rename(swapTarget + '-real', swapTarget); } catch (_) {}
  };
  try {
    const rec = makeRecordingRun();
    let swapped = false;
    const swapRun = async (dir, args, opts) => {
      if (opts && opts.env && !swapped) {
        swapped = true;
        await fsp.rename(swapTarget, swapTarget + '-real');
        await fsp.writeFile(swapTarget, `gitdir: ${F.outside}/.git\n`);
      }
      return rec.run(dir, args, opts);
    };
    const { gr: grSwap } = makeRead({ run: swapRun });
    const out = JSON.stringify(await grSwap.probe(F.child));
    assert.ok(swapped, 'the swap really happened inside the body');
    assert.ok(!out.includes(F.outsideOid), 'probe: no external oid');
    assert.ok(!out.includes('external-secret'), 'probe: no external tracked filename');
    assert.ok(!out.includes('SECRET'), 'probe: no external blob content');
  } finally { await restore(); }

  // I1: THE THREE ASSERTIONS ABOVE CANNOT FAIL. probe's response shape is {repo, name, branch,
  // state} — it structurally cannot contain an oid, a filename or blob content, so they are true of
  // every possible output, and stripping the pin fails only the `command` arm below. The ONE field
  // that can move is `branch`, and it only moves visibly when the victim and the redirect target are
  // on DIFFERENT branches — F.child and F.outside are both on `main`, so a leak was invisible here.
  // This arm is the probe half of what the command arm already does properly.
  const pVictim = path.join(F.parent, 'probe-victim');
  try {
    await fsp.mkdir(pVictim, { recursive: true });
    await g(F.base, ['init', '-q', '-b', 'probe-victim-branch', pVictim]);
    await fsp.writeFile(path.join(pVictim, 'v.txt'), 'v\n');
    await g(pVictim, ['add', '-A']);
    await g(pVictim, ['commit', '-q', '-m', 'probe victim root']);
    assert.equal((await rawGit(F.outside, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main',
      'precondition: the redirect target is on a DIFFERENT branch, so a leak is visible as a name');
    assert.notEqual('probe-victim-branch', 'main', 'and the two names really do differ');

    const pGit = path.join(pVictim, '.git');
    const rec = makeRecordingRun();
    let swapped = false;
    const swapRun = async (dir, args, opts) => {
      if (opts && opts.env && !swapped) {          // the FIRST pinned spawn: probe's branch read
        swapped = true;
        await fsp.rename(pGit, pGit + '-real');
        await fsp.writeFile(pGit, `gitdir: ${F.outside}/.git\n`);
      }
      return rec.run(dir, args, opts);
    };
    const { gr: grSwap } = makeRead({ run: swapRun });
    const p = await grSwap.probe(pVictim);
    assert.ok(swapped, 'the swap really happened inside probe\'s body');
    assert.notEqual(p.branch, 'main',
      'probe never reports the REDIRECT TARGET\'s branch — the assertion that can actually fail');
    // MEASURED, and it is the same finding the command arm records: GIT_COMMON_DIR stays pinned to
    // the authorized metadata, the redirected git-dir is incoherent with it, git exits 128, and both
    // branch reads fail — so probe settles on the shared refusal rather than on a wrong name.
    assert.deepEqual(p, { repo: null }, 'it fails CLOSED, like every other refusal on this surface');
    const pinned = rec.log.filter((c) => c.dir === pVictim && c.env);
    assert.ok(pinned.length >= 1, 'the pinned branch read really ran');
    for (const c of pinned) {
      assert.equal(c.env.GIT_COMMON_DIR, pGit, 'and every one carried the authorized common dir');
    }
    // CONTROL: unpinned, the same swapped tree DOES hand back the external branch — so the arm is
    // measuring the pin and not the impossibility of the leak.
    const leaked = await new Promise((resolve) => {
      const base = {};
      for (const k of Object.keys(process.env)) if (!k.startsWith('GIT_')) base[k] = process.env[k];
      execFile(GIT_BIN, ['-C', pVictim, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding: 'utf8', env: Object.assign(base, { LC_ALL: 'C' }) },
        (err, stdout) => resolve(err ? null : (stdout || '').trim()));
    });
    assert.equal(leaked, 'main', 'CONTROL: unpinned, the swap really does leak the external branch');
  } finally { await fsp.rm(pVictim, { recursive: true, force: true }); }

  // STORY-004: the same interleaving against command(). Its generation-time HEAD read is the first
  // env-bearing spawn, so the swap lands in the same gate-to-body window. The victim is on a
  // DISTINCT branch from the repo the gitfile redirects to, which is what makes the arm bite: a
  // leak is visible as the WRONG BRANCH NAME in the operator's text.
  //
  // MEASURED HERE, and it is not what §3.3's prose says. The pinned invocation does NOT leave the
  // swapped gitfile unopened — git follows it straight out of GIT_DIR. `GIT_DIR` alone, and
  // `GIT_DIR` + `GIT_WORK_TREE`, both answer with the EXTERNAL repo's branch. What refuses is
  // `GIT_COMMON_DIR` staying pinned to the authorized metadata: the redirected git-dir and the
  // authorized common-dir are incoherent, git exits 128, and generation fails CLOSED with 409.
  // Both controls run below, so the day someone drops GIT_COMMON_DIR from the pin as redundant,
  // this test says so.
  const victim = path.join(F.parent, 'swap-victim');
  const victimGit = path.join(victim, '.git');
  try {
    await fsp.mkdir(victim, { recursive: true });
    await g(F.base, ['init', '-q', '-b', 'victim-branch', victim]);
    await fsp.writeFile(path.join(victim, 'v.txt'), 'v\n');
    await g(victim, ['add', '-A']);
    await g(victim, ['commit', '-q', '-m', 'victim root']);
    assert.equal((await rawGit(F.outside, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main',
      'precondition: the redirect target is on a DIFFERENT branch, so a leak would be visible');

    const rec = makeRecordingRun();
    let swapped = false;
    const swapRun = async (dir, args, opts) => {
      if (opts && opts.env && !swapped) {
        swapped = true;
        await fsp.rename(victimGit, victimGit + '-real');
        await fsp.writeFile(victimGit, `gitdir: ${F.outside}/.git\n`);
      }
      return rec.run(dir, args, opts);
    };
    const { gr: grSwap } = makeRead({ run: swapRun });
    await assert.rejects(grSwap.command('push', victim, {}),
      (e) => e.name === 'GitPanelError' && e.code === 'not_on_branch' && e.status === 409,
      'command: generation fails CLOSED — no text, rather than text naming a branch that is not there');
    assert.ok(swapped, 'the swap really happened inside the generation body');

    // The two controls, run against the SAME swapped tree the call just refused on.
    const env = (extra) => {
      const base = {};
      for (const k of Object.keys(process.env)) if (!k.startsWith('GIT_')) base[k] = process.env[k];
      return Object.assign(base, { LC_ALL: 'C' }, extra);
    };
    const readHead = (e) => new Promise((resolve) => {
      execFile(GIT_BIN, ['-C', victim, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding: 'utf8', env: env(e) }, (err, stdout) => resolve(err ? null : (stdout || '').trim()));
    });
    assert.equal(await readHead({}), 'main', 'CONTROL: unpinned, the swap leaks the external branch');
    assert.equal(await readHead({ GIT_DIR: victimGit, GIT_WORK_TREE: victim }), 'main',
      'CONTROL: GIT_DIR + GIT_WORK_TREE STILL leak — git follows the gitfile out of GIT_DIR');
    assert.equal(await readHead({ GIT_DIR: victimGit, GIT_COMMON_DIR: victimGit, GIT_WORK_TREE: victim }), null,
      'the full pin refuses: GIT_COMMON_DIR is the half that closes this door');
  } finally { await fsp.rm(victim, { recursive: true, force: true }); }
});

test('U11a (g): factory contract — injecting only `run` observes EVERY spawn; no `gitIn` option exists', async () => {
  const { gr, rec } = makeRead();
  await gr.probe(F.child);
  await gr.status(F.child);
  await gr.branches(F.child);
  await gr.worktrees(F.child);
  await gr.diff(F.child, 'dirty.txt', false);
  assert.ok(rec.log.length >= 6, 'the injected runner saw the whole call log');

  // Totality, proven rather than counted: a runner that REFUSES everything must take every route
  // down with it. Any spawn that bypassed the seam would reach real git and answer anyway.
  const dead = async () => ({ ok: false, code: 1, stdout: '', stderr: 'seam', timedOut: false });
  const grDead = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: F.parent }],
    run: dead,
    jail: jailFactory([F.base]),
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  assert.deepEqual(await grDead.probe(F.child), { repo: null }, 'probe fell closed');
  for (const fn of ['status', 'branches', 'worktrees']) {
    await assert.rejects(grDead[fn](F.child), (e) => e.status === 403, `${fn} fell closed`);
  }
  await assert.rejects(grDead.diff(F.child, 'dirty.txt', false), (e) => e.status === 403, 'diff fell closed');

  const src = await fsp.readFile(path.join(__dirname, '..', 'gitread.js'), 'utf8');
  assert.ok(!/\bo\.gitIn\b|\bopts\.gitIn\b/.test(src), 'no gitIn option is read from the factory options');
  assert.ok(/const run = o\.run \|\| defaultRun;/.test(src), '`run` is the one runner seam');
});

test('U5 cost sweep, extended: the READ-ROUTE spawns carry an explicit 6000 ms timeout', async () => {
  // Without this they inherit the runner's 20 000 ms default, and one wedged read holds a spawn
  // slot for 20 s and 503s every probe. U5's existing sweep covers only the probe log.
  const { gr, rec } = makeRead();
  await gr.status(F.child);
  await gr.branches(F.child);
  await gr.worktrees(F.child);
  const pick = (fn) => rec.log.filter((c) => c.dir === F.child && c.env && fn(bare(c.args)));
  const rows = [
    ['status', (a) => a[0] === 'status' && a.includes('--porcelain=v1')],
    ['for-each-ref', (a) => a[0] === 'for-each-ref'],
    ['worktree list', (a) => a[0] === 'worktree' && a[1] === 'list'],
  ];
  for (const [label, fn] of rows) {
    const calls = pick(fn);
    assert.ok(calls.length >= 1, `${label} spawn recorded`);
    for (const c of calls) assert.equal(c.timeoutMs, TUPLE_TIMEOUT_MS_EXPECTED, `${label} at 6000 ms, not gitcmd's 20000`);
  }
});

// ============ STORY-004 — generated command TEXT =================================================
// The route's product is a STRING a human reads and runs by hand. So every assertion below is
// about what a SHELL does with that string, not about what the string looks like: the round-trip
// is run through a real /bin/sh, and the argv it parses out is compared byte-for-byte. Two things
// are proven that no eyeball can: shellQuote stops the SHELL, and the per-slot rules stop GIT
// reading an operand as an option or a pathspec.

// A `git` stand-in that prints the argv it was handed, NUL-separated — so `sh -c <text>` reports
// exactly what git would have received. PATH is pinned to it plus /usr/bin:/bin, which also means
// no PATH shim anywhere on the machine can fabricate an answer here.
let ARGV_DIR = null;
async function argvDir() {
  if (ARGV_DIR) return ARGV_DIR;
  ARGV_DIR = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'argv-echo-')));
  await fsp.writeFile(path.join(ARGV_DIR, 'git'),
    '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n', { mode: 0o755 });
  return ARGV_DIR;
}
test.after(async () => { if (ARGV_DIR) await fsp.rm(ARGV_DIR, { recursive: true, force: true }); });

const SH_ENV = {
  LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid',
  GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid',
};
const sh = (text, pathValue) => new Promise((resolve) => {
  execFile('/bin/sh', ['-c', text],
    { encoding: 'utf8', env: { ...SH_ENV, PATH: pathValue || '/usr/bin:/bin' } },
    (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
      stdout: stdout || '', stderr: stderr || '',
    }));
});
// What a shell hands git, for a text whose first word is `git`.
async function argvOf(text) {
  const dir = await argvDir();
  const r = await sh(text, `${dir}:/usr/bin:/bin`);
  assert.equal(r.code, 0, `argv-echo ran: ${r.stderr}`);
  const parts = r.stdout.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
// A gitread anchored at ONE repo — the anchor-top branch, so a hostile toplevel needs no jail.
const readAt = (top) => makeRead({ workspaceCwds: async () => [{ label: 'x', path: top }] });

test('U6 quoting: /bin/sh parses the generated text back to the intended argv, byte for byte', async () => {
  // The repo path is an interpolated value like any other — `git -C` puts it in the text. A space
  // splits a word, a single quote ends the quoting, a leading dash reads as an option.
  const hostile = [['space', F.spaceTop], ['single quote', F.quoteTop], ['leading dash', F.dashTop]];
  for (const [label, top] of hostile) {
    const { gr } = readAt(top);
    const c = await gr.command('commit', top, { message: "it's fine" });
    assert.equal(c.repo, top);
    assert.equal(c.name, path.basename(top));
    assert.deepEqual(await argvOf(c.text), ['-C', top, 'commit', '-m', "it's fine"],
      `${label}: the shell hands git exactly the intended argv`);
  }

  // A branch a shell would EXECUTE. `git check-ref-format` calls it well-formed; that is the gap.
  // It is DERIVED from the dash repo's real HEAD, so this is the push path end to end.
  const { gr } = readAt(F.dashTop);
  const p = await gr.command('push', F.dashTop, {});
  assert.deepEqual(await argvOf(p.text), ['-C', F.dashTop, 'push', 'origin', '--', '$(id)'],
    'the command-substitution branch survives as one literal operand');
  // Belt and braces: the payload never reaches a shell as code. `id` prints to stdout when run.
  const probe = await sh(`echo ${shellQuote('$(id)')}`);
  assert.equal(probe.stdout, '$(id)\n', 'the shell printed it, it did not run it');

  // Message values that are hostile in their own right, through the same round trip.
  //
  // `line\nbreak` USED TO BE IN THIS LIST and round-tripped as one operand. I2 changes that: the
  // message slot is now guarded (validateMessage), so the line-breaking values move to the refusal
  // arm below rather than being quietly deleted — the behaviour this list proved is still measured,
  // it just has the opposite verdict now, and this comment is the record of the change.
  //
  // `-m` is in the list on purpose: validateMessage deliberately does NOT inherit validateOperand's
  // leading-dash rule, because MEASURED on git 2.50.1, `git commit -m -x` exits 0 and records `-x`
  // as the subject — a dash-leading message is a legitimate value, and refusing it would refuse it.
  const { gr: gr2 } = readAt(F.parent);
  for (const m of ['`id`', 'a;rm -rf /', '--upload-pack=evil', '$HOME', 'a|b', '-m', "it's a -x"]) {
    const c = await gr2.command('commit', F.parent, { message: m });
    assert.deepEqual(await argvOf(c.text), ['-C', F.parent, 'commit', '-m', m], `message ${JSON.stringify(m)}`);
  }
});

// ---- I2: the message operand is no longer the one unguarded slot ------------------------------

test('I2: a message that ENDS THE LINE is refused 400 before any text exists — commit and sync', async () => {
  // §6.1's text is read and run by a human. A `\n` in the message makes it multi-line, and a
  // composer that submits at the first newline hands the operator's shell an unterminated quote —
  // under `sync` that is a half-typed `&&` chain over their repo, waiting at PS2. `\r` is the same
  // hazard, not a lesser one: a terminal maps CR to NL, so a pasted CR submits the line.
  const f = await syncRepo('i2');
  try {
    const { gr, rec } = readAt(f.repo);
    await fsp.writeFile(path.join(f.repo, 'work.txt'), 'work\n');
    const before = rec.log.length;
    const bad = ['line\nbreak', 'a\r b', 'a\0b', 'ok then\nrm -rf /', 'trailing\n'];
    for (const m of bad) {
      for (const verb of ['commit', 'sync']) {
        await gr.command(verb, f.repo, { message: m }).then(
          (v) => { throw new Error(`expected 400 for ${verb} ${JSON.stringify(m)}, got ${JSON.stringify(v)}`); },
          (e) => {
            assert.equal(e.name, 'GitPanelError', `${verb} ${JSON.stringify(m)}`);
            assert.equal(e.code, 'bad_message', `${verb} ${JSON.stringify(m)}`);
            assert.equal(e.status, 400, `${verb} ${JSON.stringify(m)}`);
            assert.equal(e.text, undefined, 'a refused message produces no text at all');
          },
        );
      }
    }
    // Like the empty-message rule, it is paid for BEFORE the guard's status read: only tuple
    // resolution appears in the log, never a `status` or the in-progress `--git-path` read.
    for (const c of rec.log.slice(before)) {
      assert.equal(bare(c.args)[0], 'rev-parse', `only tuple resolution ran — saw \`${bare(c.args).join(' ')}\``);
      assert.ok(!bare(c.args).includes('--git-path'), 'and not the in-progress read either');
    }
    // Non-vacuous, twice: the SAME repo generates text for a one-line message through both verbs,
    // so the rule is about the newline and not about the fixture.
    const okCommit = await gr.command('commit', f.repo, { message: 'one line is fine' });
    assert.ok(okCommit.text.includes("commit -m 'one line is fine'"), 'commit still generates');
    const okSync = await gr.command('sync', f.repo, { message: 'one line is fine' });
    assert.ok(okSync.text.includes("commit -m 'one line is fine'"), 'and so does sync');
    assert.ok(!okSync.text.includes('\n'), 'and the sync subshell really is ONE line of text');

    // The exported validator's own contract, and the seam it does NOT share with validateOperand.
    assert.equal(validateMessage('fix: the thing'), 'fix: the thing');
    assert.equal(validateMessage('-x'), '-x', 'a leading dash is a legal message — measured against git');
    assert.throws(() => validateOperand('-x'), (e) => e.code === 'bad_ref',
      'while the same value is refused as a REF — the two slots have different rules on purpose');
    assert.equal(validateMessage(undefined), '', 'p7 coercion preserved: nullish is the empty string');
    assert.equal(validateMessage({ a: 1 }), '[object Object]', 'and a non-string still coerces');
    assert.throws(() => validateMessage('a\nb'), (e) => e.code === 'bad_message' && e.status === 400);
  } finally { await f.cleanup(); }
});

test('U6 operand rules: option-shaped operands are refused 400 before any text exists', async () => {
  const { gr, rec } = makeRead();
  const before = rec.log.length;
  const bad = ['--detach', '--all', '-f', '--upload-pack=evil'];
  for (const b of bad) {
    for (const verb of ['checkout', 'merge', 'rebase']) {
      await assert.rejects(gr.command(verb, F.parent, { branch: b }),
        (e) => e.name === 'GitPanelError' && e.code === 'bad_ref' && e.status === 400, `${verb} ${b}`);
    }
    await assert.rejects(gr.command('worktree-add', F.parent, { dir: b, branch: 'ok' }),
      (e) => e.code === 'bad_ref' && e.status === 400, `worktree-add dir ${b}`);
    await assert.rejects(gr.command('worktree-add', F.parent, { dir: 'ok', branch: b }),
      (e) => e.code === 'bad_ref' && e.status === 400, `worktree-add branch ${b}`);
  }
  // NUL and newline: a text that is not one reviewable line is not reviewable.
  for (const b of ['a\0b', 'a\nb', 'good\nrm -rf /']) {
    await assert.rejects(gr.command('checkout', F.parent, { branch: b }),
      (e) => e.code === 'bad_ref' && e.status === 400, `checkout ${JSON.stringify(b)}`);
  }
  // A legal ref that merely CONTAINS a dash is not refused — the rule is leading-dash, not dash.
  // (The fixture carries `feature/a-b` as a REAL branch: since NEW-C4 the operand must resolve.)
  const ok = await gr.command('checkout', F.parent, { branch: 'feature/a-b' });
  assert.deepEqual(await argvOf(ok.text), ['-C', F.parent, 'checkout', 'feature/a-b']);
  // And no refusal ever spawned a template: only rev-parse reads appear in the whole log.
  for (const c of rec.log.slice(before)) {
    assert.equal(bare(c.args)[0], 'rev-parse', `no verb spawn — saw \`${bare(c.args).join(' ')}\``);
  }
  // The validator's contract, directly (the exported pure helper).
  assert.equal(validateOperand('main'), 'main');
  assert.throws(() => validateOperand('-x'), (e) => e.code === 'bad_ref' && e.status === 400);
});

// ---- NEW-C4: a ref-taking verb must be given a REF, proven against the repo --------------------

test('C4: `checkout` with a PATH operand is a silent restore — so the operand is resolved server-side', async () => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-c4-')));
  try {
    const repo = path.join(base, 'repo');
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await g(base, ['init', '-q', '-b', 'main', repo]);
    await fsp.writeFile(path.join(repo, 'f.txt'), 'COMMITTED\n');
    await fsp.writeFile(path.join(repo, 'src', 'index.js'), 'committed\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'root']);
    await g(repo, ['branch', 'fix']);
    await g(repo, ['tag', 'v1']);

    // THE HARM, measured on real git before anything is asserted about the fix. This is what the
    // generated text WOULD have done, and it is why a string-shaped validator cannot be the guard.
    await fsp.writeFile(path.join(repo, 'f.txt'), 'UNCOMMITTED WORK\n');
    const before = await fsp.readFile(path.join(repo, 'f.txt'), 'utf8');
    const destroyed = await sh(`git -C ${shellQuote(repo)} checkout ${shellQuote('f.txt')}`);
    assert.equal(destroyed.code, 0, 'git accepts it happily — exit 0, no warning');
    assert.equal(await fsp.readFile(path.join(repo, 'f.txt'), 'utf8'), 'COMMITTED\n',
      'and the uncommitted work is GONE — a branch switch\'s name over a restore-from-index');
    assert.notEqual(before, 'COMMITTED\n', 'the control really had work to lose');

    const { gr, rec } = makeRead({ workspaceCwds: async () => [{ label: 'c4', path: repo }] });
    // Every one of these passes validateOperand — none of them is a branch.
    const notBranches = [
      ['a tracked path', 'f.txt'],
      ['a nested path', 'src/index.js'],
      ['a commit-message search', ':/root'],
      ['a reflog traversal', '@{-1}'],
      ['HEAD itself', 'HEAD'],
      ['a TAG, not a branch', 'v1'],
      ['a peel suffix', 'main^{commit}'],
      ['a parent traversal', 'main^'],
      ['a distance traversal', 'main~1'],
      ['a blob path', 'main:f.txt'],
      ['a fully-qualified ref', 'refs/heads/fix'],
      ['a branch that does not exist', 'no-such-branch'],
    ];
    for (const [why, operand] of notBranches) {
      for (const verb of ['checkout', 'merge', 'rebase']) {
        await gr.command(verb, repo, { branch: operand }).then(
          (v) => { throw new Error(`${verb} ${JSON.stringify(operand)} (${why}): expected 400, got ${JSON.stringify(v.text)}`); },
          (e) => {
            assert.equal(e.code, 'bad_ref', `${verb} ${JSON.stringify(operand)} (${why})`);
            assert.equal(e.status, 400, `${verb} ${JSON.stringify(operand)} (${why})`);
            assert.equal(e.text, undefined, 'and no text at all is produced');
          },
        );
      }
    }
    // NON-VACUOUS: real branches still generate, through all three verbs, with the operand verbatim.
    for (const branch of ['main', 'fix']) {
      assert.deepEqual(await argvOf((await gr.command('checkout', repo, { branch })).text),
        ['-C', repo, 'checkout', branch]);
      assert.deepEqual(await argvOf((await gr.command('merge', repo, { branch })).text),
        ['-C', repo, 'merge', '--no-ff', branch]);
      assert.deepEqual(await argvOf((await gr.command('rebase', repo, { branch })).text),
        ['-C', repo, 'rebase', branch]);
    }

    // WHY the oid form alone is not the check, measured: every peel/traversal above RESOLVES.
    const oid = await sh(`git -C ${shellQuote(repo)} rev-parse --verify --quiet 'refs/heads/main^{commit}'`);
    assert.equal(oid.code, 0, 'CONTROL: `refs/heads/main^{commit}` resolves to an oid perfectly well');
    assert.equal(await sh(`git -C ${shellQuote(repo)} rev-parse --symbolic-full-name --verify --quiet 'refs/heads/main^{commit}'`)
      .then((r) => r.stdout.trim()), '',
    '...and --symbolic-full-name prints NOTHING for it — which is the discriminator used');
    // And the `--` form the obvious reading would have used is measured wrong: it refuses a REAL
    // branch, because after `--` rev-parse reads a PATH.
    const dashdash = await sh(`git -C ${shellQuote(repo)} rev-parse --verify --quiet -- 'refs/heads/main'`);
    assert.notEqual(dashdash.code, 0, 'CONTROL: `rev-parse --verify -- refs/heads/main` FAILS on a real branch');
    const eoo = await sh(`git -C ${shellQuote(repo)} rev-parse --verify --quiet --end-of-options 'refs/heads/main'`);
    assert.equal(eoo.code, 0, '--end-of-options is the separator that works');

    // The resolution is ONE pinned spawn per call — the same discipline and the same cost as
    // `push`'s derived branch, and it never runs before the gate.
    rec.log.length = 0;
    await gr.command('checkout', repo, { branch: 'fix' });
    const verify = rec.log.filter((c) => bare(c.args).includes('--symbolic-full-name'));
    assert.equal(verify.length, 1, 'exactly one verification spawn');
    assert.deepEqual(bare(verify[0].args), ['rev-parse', '--symbolic-full-name', '--verify', '--quiet',
      '--end-of-options', 'refs/heads/fix'], 'the argv, exactly');
    assert.deepEqual(verify[0].env, {
      GIT_DIR: path.join(repo, '.git'), GIT_COMMON_DIR: path.join(repo, '.git'), GIT_WORK_TREE: repo,
    }, 'pinned to the authorized tuple — no discovery after the gate');
    assert.equal(verify[0].timeoutMs, TUPLE_TIMEOUT_MS_EXPECTED, 'and bounded like every other spawn');
  } finally { await fsp.rm(base, { recursive: true, force: true }); }
});

test('C4: the gate still runs FIRST — an off-scope dir is 403, never 400 bad_ref', async () => {
  // Order matters as much as the check: a 400 for an out-of-scope repo would be an existence oracle
  // ("that path is readable, your branch is not"), which §3.1 rule 1 exists to prevent.
  const { gr, rec } = makeRead();
  const before = rec.log.length;
  for (const verb of ['checkout', 'merge', 'rebase']) {
    await rejects403(gr.command(verb, F.outside, { branch: 'main' }));
    await rejects403(gr.command(verb, F.outside, { branch: 'src/index.js' }));
  }
  // The gate's OWN tuple read on the jail's return is expected and correct; what must never appear
  // is the ref VERIFICATION, which would mean the operand was resolved before scope was decided.
  assert.ok(!rec.log.slice(before).some((c) => bare(c.args).includes('--symbolic-full-name')),
    'no verification spawn ever ran for a repo the gate refused');
});

test('I3: argument SHAPE is validated — an empty operand 400s, and a malformed paths body is not a 500', async () => {
  const { gr } = makeRead();
  // (a) the empty operand. Measured on the shipped module: `String(undefined)` coerced to `''`,
  // which passed every check and generated `checkout ''`, `merge --no-ff ''`, `worktree add '' 'x'`.
  for (const [verb, params] of [
    ['checkout', {}], ['checkout', { branch: '' }], ['checkout', { branch: null }],
    ['merge', {}], ['rebase', {}],
    ['worktree-add', { branch: 'x' }], ['worktree-add', { dir: 'd' }],
    ['worktree-add', { dir: '', branch: 'x' }],
  ]) {
    await gr.command(verb, F.parent, params).then(
      (v) => { throw new Error(`${verb} ${JSON.stringify(params)}: expected 400, got ${JSON.stringify(v.text)}`); },
      (e) => {
        assert.equal(e.code, 'bad_ref', `${verb} ${JSON.stringify(params)}`);
        assert.equal(e.status, 400, `${verb} ${JSON.stringify(params)}`);
      },
    );
  }
  assert.throws(() => validateOperand(''), (e) => e.code === 'bad_ref' && e.status === 400, 'directly');
  assert.throws(() => validateOperand(undefined), (e) => e.code === 'bad_ref' && e.status === 400);
  assert.equal(validateOperand('main'), 'main', 'and a real operand still passes through');

  // (b) the paths body. `{paths:'a.txt'}` threw a bare TypeError out of the template's `.map`,
  // which the bridge maps to 500 `git_failed` — a distinguishable response CLASS reachable from
  // argument shape alone. Every refusal on this surface is a 400 with a code.
  for (const bad of ['a.txt', null, undefined, [], {}, 42, [1, 2], [null], [{}], ['ok', 7]]) {
    await gr.command('discard', F.parent, { paths: bad }).then(
      (v) => { throw new Error(`paths ${JSON.stringify(bad)}: expected 400, got ${JSON.stringify(v.text)}`); },
      (e) => {
        assert.equal(e.name, 'GitPanelError', `paths ${JSON.stringify(bad)} is not a bare TypeError`);
        assert.equal(e.status, 400, `paths ${JSON.stringify(bad)}`);
        assert.equal(e.code, 'bad_paths', `paths ${JSON.stringify(bad)}`);
      },
    );
  }
  await assert.rejects(gr.command('discard', F.parent, { paths: new Array(201).fill('a.txt') }),
    (e) => e.code === 'too_many_paths' && e.status === 400, 'and the array is bounded');
  await assert.rejects(gr.command('discard', F.parent, { paths: ['/etc/passwd'] }),
    (e) => e.status === 400, 'an absolute path is refused by the same validator `diff` uses');
  await assert.rejects(gr.command('discard', F.parent, { paths: ['../outside'] }),
    (e) => e.status === 400, 'and so is one that climbs out of the repo');
  // NON-VACUOUS: the ordinary body still generates, hostile-but-legal pathspecs included.
  const okPaths = await gr.command('discard', F.parent, { paths: ['a.txt', '-rf', "it's", 'b c.txt'] });
  assert.deepEqual(await argvOf(okPaths.text),
    ['-C', F.parent, '--literal-pathspecs', 'restore', '--', 'a.txt', '-rf', "it's", 'b c.txt']);
  assert.deepEqual(validatePaths(['./a.txt']), ['a.txt'], 'and the validator normalises, like `diff`');
  assert.equal((await gr.command('discard', F.parent, { paths: new Array(200).fill('a.txt') })).text.length > 0,
    true, 'exactly at the cap is still allowed');
});

test('U6 derived refs: client params are IGNORED, and detached/unborn refuse 409 not_on_branch', async () => {
  const { gr } = makeRead();
  // The fixture's real HEAD is `main`; the client forges something else and is not consulted.
  const forged = await gr.command('push', F.parent, { branch: 'attacker-branch' });
  assert.deepEqual(await argvOf(forged.text), ['-C', F.parent, 'push', 'origin', '--', 'main'],
    'the branch came from HEAD, not from params');
  assert.ok(!forged.text.includes('attacker-branch'), 'the forged value appears nowhere in the text');
  const pr = await gr.command('pull-rebase', F.parent, { branch: 'attacker-branch' });
  assert.deepEqual(await argvOf(pr.text), ['-C', F.parent, 'pull', '--rebase'], 'pull-rebase takes no operand at all');

  // Detached and unborn have no branch to name, so generation refuses rather than shipping `HEAD`.
  for (const [label, dir] of [['detached', F.detached], ['unborn', F.unbornIn]]) {
    for (const verb of ['push', 'pull-rebase']) {
      await assert.rejects(gr.command(verb, dir, {}),
        (e) => e.name === 'GitPanelError' && e.code === 'not_on_branch' && e.status === 409, `${verb} on ${label}`);
    }
  }
  // A repo corrupt enough to fail the read is refused too, never dressed as a branch.
  await assert.rejects(gr.command('push', F.corrupt, {}),
    (e) => e.code === 'not_on_branch' && e.status === 409, 'push on a corrupt HEAD');

  // WHY THE EXIT CODE IS READ FIRST. Measured: unborn AND corrupt both exit 128 while still
  // printing `HEAD` on stdout — so today the `ref === 'HEAD'` clause happens to catch them both
  // and the ok-check looks redundant. It is not: it is the only thing standing between a FAILED
  // read's stdout and the operator's command line, and nothing makes git's failure stdout stay
  // `HEAD` forever. The seam is where that is provable, because real git will not produce it.
  for (const [label, dir] of [['unborn', F.unbornIn], ['corrupt', F.corrupt]]) {
    const raw = await rawGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.equal(raw.code, 128, `${label} exits 128`);
    assert.equal(raw.stdout.trim(), 'HEAD', `${label} still prints HEAD on stdout`);
  }
  const { gr: grLiar } = makeRead({
    run: async (dir, args, opts) => {
      const a = bare(args, 'liar');
      if (a[0] === 'rev-parse' && a.includes('--abbrev-ref')) {
        return { ok: false, code: 128, stdout: 'attacker-branch\n', stderr: 'fatal: whatever', timedOut: false };
      }
      return makeRecordingRun().run(dir, args, opts);
    },
  });
  await assert.rejects(grLiar.command('push', F.parent, {}),
    (e) => e.code === 'not_on_branch' && e.status === 409,
    'a FAILED read never contributes its stdout to the text, whatever it printed');
});

test('U6 pathspec magic: --literal-pathspecs is what disarms it — proven by EXECUTING the text', async () => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-discard-')));
  const repo = path.join(base, 'repo');
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await fsp.mkdir(path.join(repo, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await fsp.writeFile(path.join(repo, 'sub', 'n.txt'), 'n\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'root']);
  const dirty = async () => (await g(repo, ['status', '--porcelain'])).split('\n').filter(Boolean).sort();
  const arm = async (files) => { for (const f of files) await fsp.appendFile(path.join(repo, f), 'DIRTY\n'); };

  const { gr } = readAt(repo);
  const MAGIC = ':(top,glob)**';

  // (a) the magic pathspec matches NOTHING and restores NOTHING.
  await arm(['a.txt', 'sub/n.txt']);
  const before = await dirty();
  assert.equal(before.length, 2, 'two dirty files to lose');
  const c = await gr.command('discard', repo, { paths: [MAGIC] });
  assert.ok(c.text.includes('--literal-pathspecs'), 'the flag is in the text the operator runs');
  const r = await sh(c.text);
  assert.notEqual(r.code, 0, 'git refuses the pathspec instead of expanding it');
  assert.deepEqual(await dirty(), before, 'dirty state byte-identical — nothing was restored');

  // (b) CONTROL: the same text without the flag destroys the whole working tree. This is the
  // measurement the flag exists for, and it runs here so a "simplification" cannot pass silently.
  const naive = c.text.replace(' --literal-pathspecs', '');
  const rn = await sh(naive);
  assert.equal(rn.code, 0, 'without the flag git accepts it');
  assert.deepEqual(await dirty(), [], 'without the flag the ENTIRE repo was restored');

  // (c) a file LITERALLY named with magic syntax is still addressable.
  await fsp.writeFile(path.join(repo, MAGIC), 'lit\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'literal']);
  await arm([MAGIC, 'a.txt']);
  assert.equal((await dirty()).length, 2);
  const c2 = await gr.command('discard', repo, { paths: [MAGIC] });
  const r2 = await sh(c2.text);
  assert.equal(r2.code, 0, `the literal file restores cleanly: ${r2.stderr}`);
  const left = await dirty();
  assert.equal(left.length, 1, 'exactly one file left dirty');
  assert.ok(left[0].endsWith('a.txt'), 'and it is the one that was not named');

  // (d) multiple paths, each quoted independently, argv-exact.
  const c3 = await gr.command('discard', repo, { paths: ['-rf', 'x y', "it's"] });
  assert.deepEqual(await argvOf(c3.text),
    ['-C', repo, '--literal-pathspecs', 'restore', '--', '-rf', 'x y', "it's"]);

  await fsp.rm(base, { recursive: true, force: true });
});

test('U7: command() refuses an unresolvable or out-of-scope dir BEFORE producing any text', async () => {
  const { gr, rec } = makeRead();
  const before = rec.log.length;
  const verbs = Object.keys(COMMAND_TEMPLATES);
  for (const dir of [F.outside, path.join(F.base, 'no-such-dir'), '', null, undefined]) {
    for (const verb of verbs) {
      const p = gr.command(verb, dir, { message: 'm', branch: 'b', dir: 'd', paths: ['p'] });
      await p.then(
        (v) => { throw new Error(`expected refusal, got ${JSON.stringify(v)}`); },
        (e) => {
          assert.equal(e.name, 'GitPanelError', `${verb} on ${JSON.stringify(dir)}`);
          assert.equal(e.status, 403);
          assert.equal(e.code, 'unknown_repo');
          assert.equal(e.text, undefined, 'a rejection carries no string at all');
        },
      );
    }
  }
  // An unknown verb is refused too — and the GATE runs first, so it 403s off-scope rather than
  // answering "no such verb" for a directory the caller may not read.
  await rejects403(gr.command('rm-rf', F.outside, {}));
  await assert.rejects(gr.command('rm-rf', F.parent, {}),
    (e) => e.code === 'unknown_command' && e.status === 400, 'in scope, an unknown verb is 400');

  // The injected runner never saw a template: nothing but tuple/HEAD reads reached git.
  for (const c of rec.log.slice(before)) {
    assert.equal(bare(c.args)[0], 'rev-parse', `template never spawned — saw \`${bare(c.args).join(' ')}\``);
  }
});

test('U19 (command half): the out-of-jail candidate is refused 403 for EVERY verb, with no spawn', async () => {
  const rec = makeRecordingRun();
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 't', path: path.join(F.parent, 'src', 'server') }],
    run: rec.run,
    jail: jailFactory([path.join(F.parent, 'src')]),
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(F.base, 'nohome'),
    nowMs: Date.now,
    platformDeny: DENY_NO_PRIVATE,
  });
  for (const verb of Object.keys(COMMAND_TEMPLATES)) {
    await assert.rejects(gr.command(verb, F.privChild, { message: 'm', branch: 'b', dir: 'd', paths: ['p'] }),
      (e) => e.status === 403 && e.code === 'unknown_repo', `${verb} refused`);
  }
  assert.ok(!rec.log.some((c) => c.dir === F.privChild), 'no spawn ever touched the candidate');
  // The anchor top itself still generates — the refusal is the jail's, not a dead route.
  const ok = await gr.command('fetch', F.parent, {});
  assert.deepEqual(await argvOf(ok.text), ['-C', F.parent, 'fetch', '--all', '--prune']);
});

test('U18 (server half): identity is re-resolved at generation — retarget AND same-path replacement', async () => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-u18-')));
  const A = path.join(base, 'A');
  const B = path.join(base, 'B');
  const mkRepo = async (p, branch) => {
    await fsp.mkdir(p, { recursive: true });
    await g(base, ['init', '-q', '-b', branch, p]);
    await fsp.writeFile(path.join(p, 'f.txt'), 'f\n');
    await g(p, ['add', '-A']);
    await g(p, ['commit', '-q', '-m', 'root']);
  };
  await mkRepo(A, 'alpha');
  await mkRepo(B, 'beta');
  const link = path.join(base, 'link');
  await fsp.symlink(A, link);

  // The clock is injected so the anchor TTL is stepped DELIBERATELY rather than raced: every phase
  // below runs against a freshly discovered anchor set, which is what makes the assertions about
  // freshness assertions and not coincidences.
  let clock = 1_000_000;
  const rec = makeRecordingRun();
  const gr = createGitRead({
    workspaceCwds: async () => [{ label: 'a', path: A }, { label: 'b', path: B }],
    run: rec.run,
    jail: jailFactory([base]),
    mounts: async () => MOUNT_TEXT,
    homedir: () => path.join(base, 'nohome'),
    nowMs: () => clock,
    platformDeny: DENY_NO_PRIVATE,
  });
  const push = () => gr.command('push', link, {});     // ONE call, made three times

  const a = await push();
  assert.equal(a.repo, A, 'the symlink resolves to A');
  assert.equal(a.name, 'A');
  assert.deepEqual(await argvOf(a.text), ['-C', A, 'push', 'origin', '--', 'alpha']);

  // Retarget: the same call must name B, in the text AND in the identity that rides with it.
  await fsp.rm(link);
  await fsp.symlink(B, link);
  clock += ANCHOR_TTL_MS + 1;
  const b = await push();
  assert.equal(b.repo, B, 'the retargeted symlink resolves to B');
  assert.equal(b.name, 'B');
  assert.deepEqual(await argvOf(b.text), ['-C', B, 'push', 'origin', '--', 'beta']);
  assert.ok(!b.text.includes(`'${A}'`), "A's path is nowhere in the text");
  assert.ok(!b.text.includes('alpha'), "A's branch is nowhere in the text");

  // SAME-PATH HONESTY: no path comparison can see this, so nothing rests on seeing it — every
  // acted-on value is derived at generation. A is deleted and a DIFFERENT repo is created at the
  // same canonical path, on a different branch.
  await fsp.rm(link);
  await fsp.symlink(A, link);
  await fsp.rm(A, { recursive: true, force: true });
  await mkRepo(A, 'gamma');
  clock += ANCHOR_TTL_MS + 1;
  const c = await push();
  assert.equal(c.repo, A, 'the path is unchanged, as the spec says it must be');
  assert.deepEqual(await argvOf(c.text), ['-C', A, 'push', 'origin', '--', 'gamma'],
    'the NEW repo\'s HEAD branch — nothing stale survived into the text');
  assert.ok(!c.text.includes('alpha'), 'the replaced repo\'s branch is gone');

  await fsp.rm(base, { recursive: true, force: true });
});

test('U6 templates: every one is `git -C <resolved top>`, and the three that changed shape are exact', async () => {
  // Thirteen, since STORY-005 landed `sync`. STORY-004 asserted exactly twelve with `sync` ABSENT
  // rather than stubbed — a stub would have been a lie — so this line failed the moment the
  // thirteenth arrived. That failure was the handoff, by design.
  assert.deepEqual(Object.keys(COMMAND_TEMPLATES).sort(),
    ['checkout', 'clean', 'commit', 'discard', 'fetch', 'merge', 'pull', 'pull-rebase', 'push',
      'rebase', 'stash', 'sync', 'worktree-add'].sort());
  assert.equal(typeof COMMAND_TEMPLATES.sync, 'function', 'sync is the thirteenth (specs.md §6.2)');

  const { gr } = makeRead();
  const q = shellQuote(F.parent);
  for (const verb of Object.keys(COMMAND_TEMPLATES)) {
    // `branch: 'main'` and not a plausible string: since NEW-C4 the ref-taking verbs resolve their
    // operand against the repo, so only a branch that EXISTS generates.
    const c = await gr.command(verb, F.parent, { message: 'm', branch: 'main', dir: 'd', paths: ['p'] });
    // `sync` is the one template that is not a single `git -C` line but the §6.2 guarded subshell.
    // It is still scoped the same way and still never `cd`s: every command inside it is `git -C`.
    const scoped = verb === 'sync' ? `( R=${q} && ` : `git -C ${q} `;
    assert.ok(c.text.startsWith(scoped), `${verb}: scoped with git -C, never cd — \`${c.text}\``);
    if (verb === 'sync') assert.ok(!/(^|[^-\w])cd /.test(c.text), 'sync: no cd anywhere in the subshell');
    assert.equal(typeof c.text, 'string');
    assert.equal(c.repo, F.parent);
    assert.equal(c.name, path.basename(F.parent));
    // The generated text is deliberately UN-neutralised (specs.md §3.3, declared residue): it must
    // be what the operator would have typed. The spawn-side hardening never leaks into it.
    for (const leak of ['--attr-source', 'core.hooksPath', 'core.attributesFile', 'core.fsmonitor']) {
      assert.ok(!c.text.includes(leak), `${verb}: no spawn neutraliser in the operator's text`);
    }
  }

  // The three that changed shape versus p7, verbatim.
  const pr = await gr.command('pull-rebase', F.parent, {});
  assert.equal(pr.text, `git -C ${q} pull --rebase`);
  const pl = await gr.command('pull', F.parent, {});
  assert.equal(pl.text, `git -C ${q} pull --ff-only`, 'pull stays --ff-only beside the new pull-rebase');
  const ps = await gr.command('push', F.parent, {});
  assert.equal(ps.text, `git -C ${q} push origin -- 'main'`);
  const ds = await gr.command('discard', F.parent, { paths: ['a.txt', 'b c.txt'] });
  assert.equal(ds.text, `git -C ${q} --literal-pathspecs restore -- 'a.txt' 'b c.txt'`);
});

test('U6 generation-time reads inherit rule 3 and the pin — the TEXT does not', async () => {
  const { gr, rec } = makeRead();
  const before = rec.log.length;
  await gr.command('push', F.child, {});
  const mine = rec.log.slice(before);
  const head = mine.filter((c) => { const a = bare(c.args, 'generation'); return a[0] === 'rev-parse' && a.includes('--abbrev-ref'); });
  assert.equal(head.length, 1, 'exactly one HEAD read per generation');
  // bare() has already asserted the neutraliser prefix and the attribute-stack bound on every call.
  assert.deepEqual(head[0].env,
    { GIT_DIR: path.join(F.child, '.git'), GIT_COMMON_DIR: path.join(F.child, '.git'), GIT_WORK_TREE: F.child },
    'the HEAD read is pinned to the authorized tuple — git performs no discovery after the gate');
  assert.equal(head[0].timeoutMs, TUPLE_TIMEOUT_MS_EXPECTED, 'bounded like every other read spawn');
  assert.equal(head[0].dir, F.child, 'cwd is the authorized top');
});

// ============ STORY-005 — the sync guard: ONE predicate, THREE times =============================
// `git add -A` with unmerged paths marks conflicts RESOLVED, markers included, and the next commit
// ships `<<<<<<<`. A merge or rebase in progress changes what staging MEANS even with no marker
// anywhere. So the same predicate — unmerged > 0 ∨ MERGE_HEAD ∨ rebase-merge ∨ rebase-apply — runs
// at the tap, at generation, and inside the generated text, and the text is checked here by
// EXECUTING it in each state rather than by reading it.
//
// Four states, every one built by real git and every one asserting its own precondition, because a
// state the fixture failed to create would turn all of this into a green pass over nothing. Two of
// them are the states naive detectors miss:
//   * `merge --no-commit` of DISJOINT files — clean tree, zero unmerged, no markers, MERGE_HEAD set
//   * `rebase -i --exec false` — rebase-merge set, REBASE_HEAD ABSENT, zero unmerged (the phase the
//     shipped p7 detector cannot see; a rebase that pauses on a CONFLICT does set REBASE_HEAD,
//     which is exactly why that detector looks correct until it isn't)
const tryG = (repo, args, env) => g(repo, args, env).then(() => true, () => false);
const exists = (p) => fsp.stat(p).then(() => true, () => false);

async function syncRepo(label) {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `p8-sync-${label}-`)));
  const repo = path.join(base, 'workshop');
  await fsp.mkdir(repo, { recursive: true });
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await fsp.writeFile(path.join(repo, 'root.txt'), 'root\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'root']);
  return { base, repo, cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

// Each arm ends by asserting the state it claims to have built, against real git.
const ARMS = [
  ['a real conflict', async (repo) => {
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'ROOT\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'shared']);
    await g(repo, ['checkout', '-q', '-b', 'side']);
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'SIDE\n');
    await g(repo, ['commit', '-q', '-am', 'side']);
    await g(repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'MAIN\n');
    await g(repo, ['commit', '-q', '-am', 'main']);
    assert.equal(await tryG(repo, ['merge', '--no-ff', 'side']), false, 'the merge really conflicted');
    assert.ok((await g(repo, ['ls-files', '-u'])).length > 0, 'unmerged paths exist');
    assert.equal(await exists(path.join(repo, '.git', 'MERGE_HEAD')), true, 'MERGE_HEAD is set');
  }],
  ['a MARKERLESS merge --no-commit', async (repo) => {
    await g(repo, ['checkout', '-q', '-b', 'side']);
    await fsp.writeFile(path.join(repo, 'side.txt'), 's\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'side']);
    await g(repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(repo, 'main.txt'), 'm\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'main']);
    await g(repo, ['merge', '--no-commit', '--no-ff', 'side']);       // disjoint files: exits 0
    assert.equal(await exists(path.join(repo, '.git', 'MERGE_HEAD')), true, 'MERGE_HEAD is set');
    assert.equal((await g(repo, ['ls-files', '-u'])), '', 'and NOTHING is unmerged — the markerless case');
    assert.equal((await g(repo, ['diff', '--check'])), '', 'no conflict marker anywhere in the tree');
  }],
  ['a rebase -i --exec false pause (no REBASE_HEAD)', async (repo) => {
    await g(repo, ['checkout', '-q', '-b', 'topic']);
    await fsp.writeFile(path.join(repo, 'topic.txt'), 't\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'topic work']);
    await g(repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(repo, 'main.txt'), 'm\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'main work']);
    await g(repo, ['checkout', '-q', 'topic']);
    // GIT_SEQUENCE_EDITOR=true accepts the generated todo unedited; `--exec false` then fails after
    // the first pick and the rebase stops. Disjoint files, so no conflict is involved anywhere.
    assert.equal(await tryG(repo, ['rebase', '-i', '--exec', 'false', 'main'],
      { GIT_SEQUENCE_EDITOR: 'true' }), false, 'the rebase really paused');
    assert.equal(await exists(path.join(repo, '.git', 'rebase-merge')), true, 'rebase-merge is present');
    assert.equal(await tryG(repo, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']), false,
      'PRECONDITION: no REBASE_HEAD — this is the state the p7 detector cannot see');
    assert.equal((await g(repo, ['ls-files', '-u'])), '', 'and nothing is unmerged either');
    assert.equal(await exists(path.join(repo, '.git', 'MERGE_HEAD')), false, 'nor is MERGE_HEAD set');
  }],
  ['a rebase --apply pause', async (repo) => {
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'ROOT\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'shared']);
    await g(repo, ['checkout', '-q', '-b', 'other']);
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'OTHER\n');
    await g(repo, ['commit', '-q', '-am', 'other']);
    await g(repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'MINE\n');
    await g(repo, ['commit', '-q', '-am', 'mine']);
    // The apply backend has no --exec, so its pause is reached through a conflict. Its state lives
    // in rebase-apply, which a rebase-merge-only detector would miss.
    assert.equal(await tryG(repo, ['rebase', '--apply', 'other']), false, 'the rebase really paused');
    assert.equal(await exists(path.join(repo, '.git', 'rebase-apply')), true, 'rebase-apply is present');
    assert.equal(await exists(path.join(repo, '.git', 'rebase-merge')), false, 'and rebase-merge is NOT');
  }],
  // The state where the UNMERGED clause stands alone. `stash apply` can conflict without starting
  // anything: measured — unmerged paths and conflict markers in the tree, with MERGE_HEAD,
  // rebase-merge and rebase-apply all ABSENT. Every state-dir check in the guard is blind here, so
  // this arm is what makes `unmerged > 0` load-bearing rather than merely present.
  // ---- NEW-C3: three states the SHIPPED guard let through, each measured committing ------------
  // Every one of these is a state `git status` calls in progress in the operator's own words, and
  // every one of them ran `add -A && commit` under the shipped text. They are added HERE, to the
  // shared arm table, so they flow into generation (409), execution (the text refuses), and
  // detection (status names the state) without three parallel tests that could drift apart.
  ['a merge --squash (SQUASH_MSG, and NO MERGE_HEAD)', async (repo) => {
    await g(repo, ['checkout', '-q', '-b', 'squash-side']);
    await fsp.writeFile(path.join(repo, 'sq.txt'), 's\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'side']);
    await g(repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(repo, 'sqmain.txt'), 'm\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'main']);
    assert.equal(await tryG(repo, ['merge', '--squash', 'squash-side']), true, 'the squash merge staged cleanly');
    assert.equal(await exists(path.join(repo, '.git', 'SQUASH_MSG')), true, 'SQUASH_MSG is set');
    assert.equal(await exists(path.join(repo, '.git', 'MERGE_HEAD')), false,
      'PRECONDITION: merge --squash writes NO MERGE_HEAD — the exact reason the shipped guard passed it');
    assert.equal((await g(repo, ['ls-files', '-u'])), '', 'and nothing is unmerged either');
  }],
  ['a revert -n (REVERT_HEAD alone)', async (repo) => {
    await fsp.writeFile(path.join(repo, 'rv.txt'), 'rv\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'to be reverted']);
    assert.equal(await tryG(repo, ['revert', '-n', 'HEAD']), true, 'the revert staged cleanly');
    assert.equal(await exists(path.join(repo, '.git', 'REVERT_HEAD')), true, 'REVERT_HEAD is set');
    for (const d of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
      assert.equal(await exists(path.join(repo, '.git', d)), false, `PRECONDITION: no ${d}`);
    }
    assert.equal((await g(repo, ['ls-files', '-u'])), '', 'and nothing is unmerged');
  }],
  // The sharpest of the three: the conflict is RESOLVED, so `ls-files -u` is empty and every clause
  // the shipped guard had is silent — while git still says "You are currently cherry-picking".
  ['a cherry-pick with conflicts RESOLVED but not continued', async (repo) => {
    await fsp.writeFile(path.join(repo, 'cp.txt'), 'ROOT\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'cp root']);
    await g(repo, ['checkout', '-q', '-b', 'cp-side']);
    await fsp.writeFile(path.join(repo, 'cpother.txt'), 'o\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'first pick']);
    await fsp.writeFile(path.join(repo, 'cp.txt'), 'SIDE\n');
    await g(repo, ['commit', '-q', '-am', 'second pick']);
    await g(repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(repo, 'cp.txt'), 'MAIN\n');
    await g(repo, ['commit', '-q', '-am', 'main moves']);
    assert.equal(await tryG(repo, ['cherry-pick', 'cp-side~1', 'cp-side']), false, 'the sequence really stopped');
    await fsp.writeFile(path.join(repo, 'cp.txt'), 'RESOLVED\n');
    await g(repo, ['add', 'cp.txt']);
    assert.equal((await g(repo, ['ls-files', '-u'])), '',
      'PRECONDITION: the conflict is RESOLVED, so the unmerged clause is silent');
    assert.equal(await exists(path.join(repo, '.git', 'CHERRY_PICK_HEAD')), true, 'CHERRY_PICK_HEAD is still set');
    assert.equal(await exists(path.join(repo, '.git', 'sequencer')), true, 'and the sequencer is still open');
    for (const d of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
      assert.equal(await exists(path.join(repo, '.git', d)), false,
        `PRECONDITION: ${d} absent — not one clause the shipped guard had can see this`);
    }
  }],
  ['a stash-apply conflict (nothing in progress at all)', async (repo) => {
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'ROOT\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'shared']);
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'STASHED\n');
    await g(repo, ['stash', '-q']);
    await fsp.writeFile(path.join(repo, 'shared.txt'), 'COMMITTED\n');
    await g(repo, ['commit', '-q', '-am', 'other']);
    assert.equal(await tryG(repo, ['stash', 'apply']), false, 'the stash really conflicted');
    assert.ok((await g(repo, ['ls-files', '-u'])).length > 0, 'unmerged paths exist');
    for (const d of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
      assert.equal(await exists(path.join(repo, '.git', d)), false,
        `PRECONDITION: ${d} is absent — no state dir betrays this one`);
    }
  }],
];

const MSG = 'a message the operator wrote for something else';

test('U8 generation: sync 409s sync_blocked in every state where staging would misfire', async () => {
  for (const [label, arm] of ARMS) {
    const f = await syncRepo('gen');
    try {
      const { gr } = readAt(f.repo);
      // The clean control FIRST, at the same anchor: the refusal below is about the state, not
      // about this repo being unreachable.
      await fsp.writeFile(path.join(f.repo, 'work.txt'), 'work\n');
      const clean = await gr.command('sync', f.repo, { message: MSG });
      assert.ok(clean.text.includes('add -A'), `${label}: clean generates`);
      assert.equal(clean.repo, f.repo);
      assert.equal(clean.name, 'workshop');

      await arm(f.repo);
      await gr.command('sync', f.repo, { message: MSG }).then(
        (v) => { throw new Error(`${label}: expected 409, got ${JSON.stringify(v)}`); },
        (e) => {
          assert.equal(e.name, 'GitPanelError', label);
          assert.equal(e.code, 'sync_blocked', label);
          assert.equal(e.status, 409, label);
          assert.equal(e.text, undefined, `${label}: a refusal carries no text at all`);
        },
      );
      // Server-side and independent of the bar: no client field can turn the refusal off.
      await assert.rejects(gr.command('sync', f.repo, { message: MSG, force: true, unmerged: 0 }),
        (e) => e.code === 'sync_blocked' && e.status === 409, `${label}: no client override`);
      // And ONLY sync is blocked — the read verbs still generate in the same state.
      const fetched = await gr.command('fetch', f.repo, {});
      assert.ok(fetched.text.endsWith('fetch --all --prune'), `${label}: other verbs unaffected`);
    } finally { await f.cleanup(); }
  }
});

test('U8 message: an empty or whitespace-only message is refused 400 empty_message, before any read', async () => {
  const f = await syncRepo('msg');
  try {
    const { gr, rec } = readAt(f.repo);
    await fsp.writeFile(path.join(f.repo, 'work.txt'), 'work\n');
    const before = rec.log.length;
    for (const m of ['', '   ', '\t', '\n', ' \t\n ', undefined, null, []]) {
      await gr.command('sync', f.repo, { message: m }).then(
        (v) => { throw new Error(`expected 400 for ${JSON.stringify(m)}, got ${JSON.stringify(v)}`); },
        (e) => {
          assert.equal(e.code, 'empty_message', `message ${JSON.stringify(m)}`);
          assert.equal(e.status, 400, `message ${JSON.stringify(m)}`);
          assert.equal(e.text, undefined, 'a direct POST past the UI gets no text');
        },
      );
    }
    // The message check runs BEFORE the guard's read: an empty-message POST buys no status spawn.
    for (const c of rec.log.slice(before)) {
      assert.equal(bare(c.args)[0], 'rev-parse', `only tuple resolution ran — saw \`${bare(c.args).join(' ')}\``);
      assert.ok(!bare(c.args).includes('--git-path'), 'and not the in-progress read either');
    }
    // A message that merely CONTAINS whitespace is fine, and survives into the text verbatim.
    const ok = await gr.command('sync', f.repo, { message: '  fix the thing  ' });
    assert.ok(ok.text.includes("commit -m '  fix the thing  '"), 'the message is not trimmed, only tested');
    // The rule is "trims to empty", not "is a string" — measured: a JSON body carrying a non-string
    // coerces exactly as p7's `commit` template has always coerced it, and lands as one quoted
    // literal the reviewer sees before running anything. Recorded, not accidental.
    const coerced = await gr.command('sync', f.repo, { message: { a: 1 } });
    assert.ok(coerced.text.includes("commit -m '[object Object]'"), 'a non-string coerces and stays one operand');
    const probe = await sh(`echo ${shellQuote('[object Object]')}`);
    assert.equal(probe.stdout, '[object Object]\n', 'the shell prints it; it never reaches one as code');
  } finally { await f.cleanup(); }
});

test('U8 execution: the FULL predicate ships INSIDE the text — generated clean, refused once the repo moves', async () => {
  const snapshot = async (repo) => ({
    head: (await g(repo, ['rev-parse', 'HEAD'])).trim(),
    commits: (await g(repo, ['rev-list', '--count', 'HEAD'])).trim(),
    staged: (await g(repo, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean).sort(),
    unmerged: (await g(repo, ['ls-files', '-u'])).split('\n').filter(Boolean).sort(),
    status: (await g(repo, ['status', '--porcelain'])).split('\n').filter(Boolean).sort(),
  });

  for (const [label, arm] of ARMS) {
    const f = await syncRepo('exec');
    try {
      const { gr } = readAt(f.repo);
      // The operator's real situation: work in the tree, and a clean repo at the moment of review.
      await fsp.writeFile(path.join(f.repo, 'work.txt'), 'work\n');
      const c = await gr.command('sync', f.repo, { message: MSG });

      await arm(f.repo);                     // the repo moves AFTER the text was reviewed
      // The arms build their states with `add -A` commits of their own, which sweep up whatever was
      // already dirty. The operator kept working: this is the change the reviewed text would stage,
      // and without it the control below has nothing to commit and proves nothing.
      await fsp.writeFile(path.join(f.repo, 'later.txt'), 'later\n');
      const before = await snapshot(f.repo);
      const r = await sh(c.text);
      assert.notEqual(r.code, 0, `${label}: the generated text refuses (stderr: ${r.stderr.slice(0, 200)})`);
      assert.deepEqual(await snapshot(f.repo), before,
        `${label}: nothing staged, nothing committed, index and worktree byte-identical`);

      // THE CONTROL. Without it the assertion above could be passing because git refused rather
      // than because the guard did. Measured: git is perfectly willing in every one of these states.
      const q = shellQuote(f.repo);
      const naive = `git -C ${q} add -A && git -C ${q} commit -q -m ${shellQuote(MSG)}`;
      const rn = await sh(naive);
      assert.equal(rn.code, 0, `${label}: UNGUARDED, git itself commits happily (stderr: ${rn.stderr.slice(0, 200)})`);
      const after = await snapshot(f.repo);
      assert.notEqual(after.head, before.head, `${label}: ...and it moved HEAD — this is the harm`);
      // Keyed on the STATE, not on the label: the arms that leave unmerged paths are the ones whose
      // tree carries conflict markers, and a label match would fire on an arm whose conflicts were
      // already RESOLVED (which has no markers left, and no shared.txt at all).
      if (before.unmerged.length) {
        assert.ok((await g(f.repo, ['show', 'HEAD:shared.txt'])).includes('<<<<<<<'),
          `${label}: unguarded, the conflict markers are now COMMITTED — the defect §6.2 exists to stop`);
      }
    } finally { await f.cleanup(); }
  }
});

test('U8 execution: a VANISHED repo fails CLOSED — the git-failure path the naive `test -z` opens', async () => {
  const f = await syncRepo('gone');
  const { gr } = readAt(f.repo);
  await fsp.writeFile(path.join(f.repo, 'work.txt'), 'work\n');
  const c = await gr.command('sync', f.repo, { message: MSG });
  await fsp.rm(f.repo, { recursive: true, force: true });
  const r = await sh(c.text);
  assert.notEqual(r.code, 0, 'a git that dies blocks the chain instead of unlocking it');

  // WHY the assignments are there, measured rather than argued: the naive form fails OPEN.
  const open = await sh('test -z "$(false)" && echo REACHED-THE-DANGEROUS-PART');
  assert.equal(open.code, 0, '`test -z "$(cmd)"` SUCCEEDS when cmd dies with empty stdout');
  assert.equal(open.stdout, 'REACHED-THE-DANGEROUS-PART\n', '...and the chain proceeds to stage and commit');
  const closed = await sh('u=$(false) && echo REACHED');
  assert.notEqual(closed.code, 0, "an assignment's exit status IS the substitution's");
  assert.equal(closed.stdout, '', '...so the chain stops');
  // And the shape the template actually uses is the closed one, for every read in the chain. There
  // are TWO reads now, not four: NEW-C3 grew the predicate from three state files to seven, and
  // seven `--git-path` substitutions would be 835 characters of boilerplate, so the text takes
  // `--git-dir` ONCE and joins the names to it (the equivalence is pinned below). Fewer reads, the
  // same rule — every one of them is an assignment.
  for (const v of ['u=$(', 'G=$(']) {
    assert.ok(c.text.includes(v), `every git read goes through an assignment: ${v}`);
  }
  assert.ok(!/test -z "\$\(/.test(c.text), 'and never through the fail-open `test -z "$(...)"` form');
  // NEW-I4: the operator is TOLD. Measured on the shipped text: a blocked run produced exit 1 and
  // ZERO bytes of output, which reads as "the button did nothing" and invites the retry the guard
  // exists to stop.
  assert.ok(r.stderr.includes('sync blocked'), `a failed run SAYS so — stderr was ${JSON.stringify(r.stderr)}`);
  await f.cleanup();
});

test('U8 execution: the clean negative control COMMITS — and the guard is not simply refusing everything', async () => {
  // A repo path that is hostile to a shell in three ways at once, so the round trip proves the
  // quoting as well as the guard: the path is interpolated ONCE, at the front of the subshell.
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-sync-clean-')));
  const repo = path.join(base, "od'd dir with space");
  await fsp.mkdir(repo, { recursive: true });
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await fsp.writeFile(path.join(repo, 'root.txt'), 'root\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'root']);
  await fsp.writeFile(path.join(repo, 'new.txt'), 'new\n');
  await fsp.writeFile(path.join(repo, 'root.txt'), 'changed\n');

  const { gr } = readAt(repo);
  const message = "it's a fix — 100%";
  const c = await gr.command('sync', repo, { message });
  const r = await sh(c.text);
  assert.equal(r.code, 0, `the clean repo commits (stderr: ${r.stderr.slice(0, 300)})`);
  assert.equal((await g(repo, ['log', '-1', '--format=%s'])).trim(), message,
    'the operator’s exact message, through a path with a quote and a space');
  assert.deepEqual((await g(repo, ['ls-tree', '--name-only', 'HEAD'])).split('\n').filter(Boolean).sort(),
    ['new.txt', 'root.txt'], 'add -A staged the whole repo, as the text says it will');
  assert.equal((await g(repo, ['status', '--porcelain'])), '', 'and the tree is clean afterwards');
  // The path appears ONCE, at the front — the most reviewable shape, and the reason `R` exists.
  // It is the QUOTED spelling that appears: this path contains a single quote, so the raw string is
  // nowhere in the text, which is the whole point of routing it through shellQuote.
  assert.equal(c.text.split(shellQuote(repo)).length - 1, 1, 'the repo path is interpolated exactly once');
  assert.ok(!c.text.includes(`${repo} `), 'and never unquoted');
  assert.ok(c.text.startsWith(`( R=${shellQuote(repo)} && `), 'and it is the first thing the reader sees');
  // The subshell keeps R out of the operator's interactive shell (§2.4's hygiene bar, why not `cd`).
  const leak = await sh(`${c.text} >/dev/null 2>&1; echo "after=[\${R-UNSET}]"; pwd`);
  assert.ok(leak.stdout.includes('after=[UNSET]'), 'R does not survive into the calling shell');
  assert.ok(!leak.stdout.includes(repo), 'and the cwd was never changed — `git -C`, never `cd`');
  await fsp.rm(base, { recursive: true, force: true });
});

test('U8 detection: gitread.status() sees BOTH rebase backends and the markerless merge — p7 does not', async () => {
  // counts.unmerged counts FILES, not `ls-files -u` rows: one conflicted path prints three stage
  // rows (1/2/3) and is one unmerged file. Both arms conflict on a single `shared.txt`.
  // Every key of the response shape, per arm — so a state added to the table without a considered
  // expectation here fails rather than defaulting to false. `am` is its own row because
  // `rebase --apply` and `git am` share the rebase-apply directory (see the label test below).
  const NONE = { merge: false, squash: false, revert: false, cherryPick: false, sequencer: false, rebase: false, am: false };
  const expected = {
    'a real conflict': { ...NONE, merge: true, unmerged: 1 },
    'a MARKERLESS merge --no-commit': { ...NONE, merge: true, unmerged: 0 },
    'a rebase -i --exec false pause (no REBASE_HEAD)': { ...NONE, rebase: true, unmerged: 0 },
    'a rebase --apply pause': { ...NONE, rebase: true, unmerged: 1 },
    'a merge --squash (SQUASH_MSG, and NO MERGE_HEAD)': { ...NONE, squash: true, unmerged: 0 },
    'a revert -n (REVERT_HEAD alone)': { ...NONE, revert: true, unmerged: 0 },
    'a cherry-pick with conflicts RESOLVED but not continued':
      { ...NONE, cherryPick: true, sequencer: true, unmerged: 0 },
    'a stash-apply conflict (nothing in progress at all)': { ...NONE, unmerged: 1 },
  };
  assert.deepEqual(Object.keys(expected).sort(), ARMS.map(([l]) => l).sort(),
    'every arm has an expectation — a new state cannot slip in unexamined');
  for (const [label, arm] of ARMS) {
    const f = await syncRepo('det');
    try {
      const { gr, rec } = readAt(f.repo);
      const clean = await gr.status(f.repo);
      assert.deepEqual(clean.inProgress, NONE, `${label}: clean first`);
      assert.deepEqual(Object.keys(clean.inProgress).sort(), [...IN_PROGRESS_KEYS].sort(),
        'the response shape is exactly the predicate\'s key list — no key without a clause');

      await arm(f.repo);
      const before = rec.log.length;
      const st = await gr.status(f.repo);
      const want = expected[label];
      const { unmerged, ...bits } = want;
      assert.deepEqual(st.inProgress, bits, `${label}: every in-progress bit`);
      assert.equal(st.counts.unmerged, unmerged, `${label}: counts.unmerged`);
      // ONE spawn for the detection, not one per state file, and it carries the pin and the bound.
      // Seven paths now, still one rev-parse — the cost row §3.2 states did not move.
      const detect = rec.log.slice(before).filter((c) => bare(c.args, 'detect').includes('--git-path'));
      assert.equal(detect.length, 1, `${label}: exactly one in-progress spawn`);
      assert.deepEqual(bare(detect[0].args), ['rev-parse', '--path-format=absolute',
        '--git-path', 'MERGE_HEAD', '--git-path', 'SQUASH_MSG', '--git-path', 'REVERT_HEAD',
        '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'sequencer',
        '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'],
      `${label}: seven paths, one rev-parse`);
      assert.deepEqual(detect[0].env, {
        GIT_DIR: path.join(f.repo, '.git'), GIT_COMMON_DIR: path.join(f.repo, '.git'), GIT_WORK_TREE: f.repo,
      }, `${label}: pinned to the authorized tuple`);
      assert.equal(detect[0].timeoutMs, TUPLE_TIMEOUT_MS_EXPECTED, `${label}: bounded like every read spawn`);

      // The predicate agrees with the guard, over the SAME response the bar holds at tap time.
      const reasons = syncBlockedReasons(st);
      assert.ok(reasons.length > 0, `${label}: the tap refuses on this very response`);
      await assert.rejects(gr.command('sync', f.repo, { message: MSG }),
        (e) => e.code === 'sync_blocked', `${label}: and so does generation`);

      // THE CONTRAST, and the reason this story exists: p7's shipped detector, on the same repo.
      const panel = createGitPanel({ workspaceCwds: async () => [{ label: 'p7', path: f.repo }], writesEnabled: false });
      const p7 = await panel.status(f.repo);
      if (label.includes('--exec false')) {
        assert.equal(p7.inProgress.rebase, false,
          'p7 reports NO rebase in the exec-false pause — the blind spot, left untouched by design (§3.2, §9)');
        assert.equal(st.inProgress.rebase, true, 'gitread sees it');
      } else if (label.includes('MARKERLESS')) {
        assert.equal(p7.inProgress.merge, true, 'p7 does see MERGE_HEAD — the merge clause was never the gap');
      }
    } finally { await f.cleanup(); }
  }
});

test('U8 detection: an UNREADABLE in-progress state is a FAILED status, never a quiet "nothing in progress"', async () => {
  const f = await syncRepo('unreadable');
  try {
    // A runner that answers everything except the in-progress read. The old detector collapsed a
    // failed probe to `false` — fail-open on the one field the whole guard rests on.
    const rec = makeRecordingRun();
    const run = async (dir, args, opts) => {
      if (args.includes('--git-path')) return { ok: false, code: 128, stdout: '', stderr: 'boom', timedOut: false };
      return rec.run(dir, args, opts);
    };
    const gr = createGitRead({
      workspaceCwds: async () => [{ label: 'x', path: f.repo }],
      run,
      jail: jailFactory([f.base]),
      mounts: async () => MOUNT_TEXT,
      homedir: () => path.join(f.base, 'nohome'),
      nowMs: Date.now,
      platformDeny: DENY_NO_PRIVATE,
    });
    const st = await gr.status(f.repo);
    assert.equal(st.error, 'git_failed', 'the status fails rather than reporting a state it could not read');
    assert.equal(st.inProgress, undefined, 'and it reports no in-progress bits at all');
    assert.deepEqual(syncBlockedReasons(st), ['unreadable'], 'the predicate reads that as BLOCKED');
    await assert.rejects(gr.command('sync', f.repo, { message: MSG }),
      (e) => e.code === 'sync_blocked' && e.status === 409, 'so generation fails CLOSED');
    // A malformed answer is treated the same way — strict parse, like the tuple rule.
    for (const stdout of ['', '/only/one/line\n', '/a\n/b\n/c\n/d\n', 'relative\npaths\nonly\n']) {
      const grBad = createGitRead({
        workspaceCwds: async () => [{ label: 'x', path: f.repo }],
        run: async (dir, args, opts) => (args.includes('--git-path')
          ? { ok: true, code: 0, stdout, stderr: '', timedOut: false }
          : rec.run(dir, args, opts)),
        jail: jailFactory([f.base]),
        mounts: async () => MOUNT_TEXT,
        homedir: () => path.join(f.base, 'nohome'),
        nowMs: Date.now,
        platformDeny: DENY_NO_PRIVATE,
      });
      assert.equal((await grBad.status(f.repo)).error, 'git_failed', `malformed: ${JSON.stringify(stdout)}`);
    }
  } finally { await f.cleanup(); }
});

test('U8 cost: only sync pays a status read; push/pull-rebase pay one branch spawn, the rest pay nothing', async () => {
  const f = await syncRepo('cost');
  try {
    const { gr, rec } = readAt(f.repo);
    await fsp.writeFile(path.join(f.repo, 'work.txt'), 'work\n');
    const spawnsFor = async (fn) => {
      const before = rec.log.length;
      await fn();
      return rec.log.slice(before).map((c) => bare(c.args, 'cost'));
    };

    for (const verb of ['push', 'pull-rebase']) {
      const calls = await spawnsFor(() => gr.command(verb, f.repo, {}));
      assert.ok(!calls.some((a) => a[0] === 'status'), `${verb}: NO status spawn`);
      assert.ok(!calls.some((a) => a.includes('--git-path')), `${verb}: NO in-progress spawn`);
      assert.equal(calls.filter((a) => a.includes('--abbrev-ref')).length, 1, `${verb}: one branch spawn`);
    }
    for (const verb of ['fetch', 'stash', 'clean', 'pull', 'commit']) {
      const calls = await spawnsFor(() => gr.command(verb, f.repo, { message: MSG }));
      assert.ok(!calls.some((a) => a[0] === 'status' || a.includes('--git-path') || a.includes('--abbrev-ref')),
        `${verb}: nothing beyond tuple resolution — saw ${JSON.stringify(calls)}`);
    }
    const syncCalls = await spawnsFor(() => gr.command('sync', f.repo, { message: MSG }));
    assert.equal(syncCalls.filter((a) => a[0] === 'status').length, 1, 'sync: exactly one status read');
    assert.equal(syncCalls.filter((a) => a.includes('--git-path')).length, 1, 'sync: exactly one in-progress read');
    assert.ok(!syncCalls.some((a) => a.includes('--abbrev-ref')), 'sync: and no branch read it does not need');
  } finally { await f.cleanup(); }
});

test('C3 residue: a CONFLICT-FREE `cherry-pick -n` leaves NO state file — recorded, not covered', async () => {
  // The honest boundary of a state-file predicate, measured rather than assumed. If a future git
  // starts writing a marker here, this test fails and the residue is closed instead of surviving as
  // folklore — the same retirement-pin discipline U26 uses.
  const f = await syncRepo('residue');
  try {
    await g(f.repo, ['checkout', '-q', '-b', 'pick-side']);
    await fsp.writeFile(path.join(f.repo, 'picked.txt'), 'picked\n');
    await g(f.repo, ['add', '-A']); await g(f.repo, ['commit', '-q', '-m', 'a commit to pick']);
    await g(f.repo, ['checkout', '-q', 'main']);
    assert.equal(await tryG(f.repo, ['cherry-pick', '-n', 'pick-side']), true, 'it applied cleanly');
    assert.equal((await g(f.repo, ['diff', '--cached', '--name-only'])).trim(), 'picked.txt',
      'the picked content really is staged and uncommitted');

    for (const s of IN_PROGRESS_STATES) {
      assert.equal(await exists(path.join(f.repo, '.git', s.gitPath)), false,
        `${s.gitPath} is ABSENT — there is nothing for the predicate to see`);
    }
    assert.equal((await g(f.repo, ['ls-files', '-u'])), '', 'and nothing is unmerged');

    const { gr } = readAt(f.repo);
    const st = await gr.status(f.repo);
    assert.deepEqual(syncBlockedReasons(st), [], 'so the predicate reports NO reason to block');
    const c = await gr.command('sync', f.repo, { message: MSG });
    const r = await sh(c.text);
    assert.equal(r.code, 0, 'and the generated text runs — this is the residue, stated plainly');
    // The residue is bounded, which is why it is acceptable to declare: the operator's own content
    // is committed under their own message. Nothing hidden is committed and nothing is destroyed.
    assert.ok((await g(f.repo, ['log', '-1', '--format=%s'])).startsWith(MSG),
      'the commit carries the operator\'s message, not the picked commit\'s');
    // And the module SAYS so, where the next reader will look.
    const src = await fsp.readFile(path.join(__dirname, '..', 'gitread.js'), 'utf8');
    assert.ok(/DECLARED RESIDUE[\s\S]{0,400}cherry-pick -n/.test(src),
      'the residue is declared in the source beside the table, not only here');
  } finally { await f.cleanup(); }
});

test('C3 label: `git am` is not called a rebase — they share rebase-apply/, `applying` tells them apart', async () => {
  const f = await syncRepo('am');
  try {
    await g(f.repo, ['checkout', '-q', '-b', 'am-side']);
    await fsp.writeFile(path.join(f.repo, 'root.txt'), 'SIDE\n');
    await g(f.repo, ['commit', '-q', '-am', 'the patch']);
    const patch = await g(f.repo, ['format-patch', '-1', '--stdout']);
    await g(f.repo, ['checkout', '-q', 'main']);
    await fsp.writeFile(path.join(f.repo, 'root.txt'), 'MAIN\n');
    await g(f.repo, ['commit', '-q', '-am', 'main moves']);
    await fsp.writeFile(path.join(f.base, 'p.patch'), patch);
    assert.equal(await tryG(f.repo, ['am', path.join(f.base, 'p.patch')]), false, 'the am really stopped');

    const applyDir = path.join(f.repo, '.git', 'rebase-apply');
    assert.equal(await exists(applyDir), true, 'am uses the rebase-apply directory');
    assert.equal(await exists(path.join(applyDir, 'applying')), true, 'and marks it `applying`');
    assert.equal(await exists(path.join(applyDir, 'rebasing')), false, 'never `rebasing`');

    const { gr } = readAt(f.repo);
    const st = await gr.status(f.repo);
    assert.equal(st.inProgress.am, true, 'so status calls it an am');
    assert.equal(st.inProgress.rebase, false, 'and NOT a rebase — the shipped label was wrong');
    assert.deepEqual(syncBlockedReasons(st), ['am'], 'it still blocks: the label changed, not the verdict');
    await assert.rejects(gr.command('sync', f.repo, { message: MSG }),
      (e) => e.code === 'sync_blocked' && e.status === 409, 'generation refuses');
    // The CONTROL, and the reason one bit was not enough: a `rebase --apply` pause writes the SAME
    // directory with the OTHER marker, and must come back labelled the other way.
    const f2 = await syncRepo('rbap');
    try {
      await fsp.writeFile(path.join(f2.repo, 'root.txt'), 'ROOT\n');
      await g(f2.repo, ['commit', '-q', '-am', 'shared']);
      await g(f2.repo, ['checkout', '-q', '-b', 'other']);
      await fsp.writeFile(path.join(f2.repo, 'root.txt'), 'OTHER\n');
      await g(f2.repo, ['commit', '-q', '-am', 'other']);
      await g(f2.repo, ['checkout', '-q', 'main']);
      await fsp.writeFile(path.join(f2.repo, 'root.txt'), 'MINE\n');
      await g(f2.repo, ['commit', '-q', '-am', 'mine']);
      assert.equal(await tryG(f2.repo, ['rebase', '--apply', 'other']), false, 'the rebase really paused');
      assert.equal(await exists(path.join(f2.repo, '.git', 'rebase-apply', 'rebasing')), true, 'marked `rebasing`');
      const st2 = await (readAt(f2.repo).gr).status(f2.repo);
      assert.equal(st2.inProgress.rebase, true, 'the SAME directory, labelled a rebase');
      assert.equal(st2.inProgress.am, false, 'and not an am');
    } finally { await f2.cleanup(); }
  } finally { await f.cleanup(); }
});

test('C3 pin: the TEXT\'s `$G/<name>` is the same path the SPAWN\'s `--git-path <name>` gives', async () => {
  // The text takes `--git-dir` ONCE and joins the names to it — half the characters of seven
  // `--git-path` substitutions, and text nobody reads is not a reviewed command (§2.4). That rests
  // on an equivalence, so the equivalence is MEASURED here, on every run, in the three layouts where
  // it could differ. `--git-path` exists because some files live in the COMMON dir instead; the day
  // one of these moves there this fails and the text is rewritten to the long form.
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-gitdir-')));
  try {
    const repo = path.join(base, 'repo');
    await fsp.mkdir(repo);
    await g(base, ['init', '-q', '-b', 'main', repo]);
    await fsp.writeFile(path.join(repo, 'f.txt'), 'f\n');
    await g(repo, ['add', '-A']); await g(repo, ['commit', '-q', '-m', 'root']);
    const wt = path.join(base, 'wt');
    await g(repo, ['worktree', 'add', '-q', wt, '-b', 'wt-branch']);
    const sep = path.join(base, 'sep');
    await fsp.mkdir(sep);
    await g(base, ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(base, 'sep.git'), sep]);
    await fsp.writeFile(path.join(sep, 'f.txt'), 'f\n');
    await g(sep, ['add', '-A']); await g(sep, ['commit', '-q', '-m', 'root']);

    for (const [label, dir] of [['plain repo', repo], ['LINKED worktree', wt], ['separate git dir', sep]]) {
      const gitDir = (await g(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
      assert.ok(path.isAbsolute(gitDir), `${label}: --git-dir is absolute`);
      for (const s of IN_PROGRESS_STATES) {
        const viaPath = (await g(dir, ['rev-parse', '--path-format=absolute', '--git-path', s.gitPath])).trim();
        assert.equal(path.join(gitDir, s.gitPath), viaPath,
          `${label}: $G/${s.gitPath} is exactly what --git-path ${s.gitPath} prints`);
      }
    }
    // Non-vacuous: a path that IS common-dir-resolved proves the two forms can differ at all, so the
    // equalities above are a measurement and not a tautology about string joining.
    const common = (await g(wt, ['rev-parse', '--path-format=absolute', '--git-path', 'config'])).trim();
    const wtGitDir = (await g(wt, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
    assert.notEqual(common, path.join(wtGitDir, 'config'),
      'CONTROL: from a linked worktree, `--git-path config` resolves into the COMMON dir — the two '
      + 'forms genuinely diverge for such a file, which is why every state is checked individually');
  } finally { await fsp.rm(base, { recursive: true, force: true }); }
});

test('U8 structure: ONE predicate — the tap, generation and the TEXT cannot drift into three', async () => {
  // The pure function, directly: it takes the status RESPONSE shape, which is what the bar holds.
  assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 0 }, inProgress: { merge: false, rebase: false } }), []);
  assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 1 }, inProgress: { merge: false, rebase: false } }), ['unmerged']);
  assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 0 }, inProgress: { merge: true, rebase: false } }), ['merge']);
  assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 0 }, inProgress: { merge: false, rebase: true } }), ['rebase']);
  assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 2 }, inProgress: { merge: true, rebase: true } }),
    ['unmerged', 'merge', 'rebase']);
  // NEW-C3: the four clauses that were missing, each alone, and all of them together. Without these
  // rows the predicate's new half would be exercised only through the fixtures.
  for (const key of ['squash', 'revert', 'cherryPick', 'sequencer', 'am']) {
    assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 0 }, inProgress: { [key]: true } }), [key],
      `${key} alone blocks`);
  }
  const all = {};
  for (const k of IN_PROGRESS_KEYS) all[k] = true;
  assert.deepEqual(syncBlockedReasons({ counts: { unmerged: 1 }, inProgress: all }),
    ['unmerged', ...IN_PROGRESS_KEYS], 'and every reason is named, in the table\'s order');
  // Fail CLOSED on anything it cannot read, including a shape missing the fields it needs.
  for (const bad of [null, undefined, {}, { error: 'git_failed' }, { counts: { unmerged: 0 } },
    { inProgress: { merge: false, rebase: false } }]) {
    assert.deepEqual(syncBlockedReasons(bad), ['unreadable'], `unreadable: ${JSON.stringify(bad)}`);
  }

  const src = await fsp.readFile(path.join(__dirname, '..', 'gitread.js'), 'utf8');
  assert.equal((src.match(/function syncBlockedReasons/g) || []).length, 1, 'one implementation');
  assert.ok(/syncBlockedReasons\(await statusCore\(t\)\)/.test(src),
    'generation evaluates THAT function over the same body the tap reads');
  // The p7 detector is GONE from gitread — a revert to it would fail here, loudly.
  assert.ok(!/'REBASE_HEAD'/.test(src), 'gitread names no REBASE_HEAD ref');
  const p7src = await fsp.readFile(path.join(__dirname, '..', 'gitpanel.js'), 'utf8');
  assert.ok(/REBASE_HEAD/.test(p7src), 'and p7 still has its own, untouched (§3.2)');

  // The TEXT is the same predicate transliterated, and since NEW-C3 it is GENERATED from the same
  // table the spawn args are — so the order below is not a hand-kept parallel list, it is the table.
  const { gr } = readAt(F.parent);
  const t = (await gr.command('sync', F.parent, { message: 'm' })).text;
  const order = ['ls-files -u', '--git-dir', 'test -z "$u"']
    .concat(IN_PROGRESS_STATES.map((s) => `test ! -e "$G/${s.gitPath}"`))
    .concat(['add -A', 'commit -m']);
  let at = -1;
  for (const piece of order) {
    const i = t.indexOf(piece);
    assert.ok(i > at, `${piece} appears, in order, in \`${t}\``);
    at = i;
  }
  // The chain and the FAILURE REPORT are separate halves, and only the chain is under the `;` rule.
  // NEW-I4 appends `|| { echo …; false; }`, whose semicolons are the brace group's own syntax and
  // sit entirely on the branch that runs when the chain has ALREADY failed.
  const split = t.indexOf(' ) || ');
  assert.ok(split > 0, `the text ends with a failure report — \`${t}\``);
  const chain = t.slice(0, split + 2);
  const report = t.slice(split + 3);
  assert.equal((chain.match(/&&/g) || []).length, order.length, 'every step joined by && — one chain');
  assert.ok(!/;/.test(chain), 'nothing in the chain is sequenced unconditionally');
  assert.equal(report, "|| { echo 'sync blocked: repo state changed' >&2; false; }",
    'the report is a fixed literal — nothing interpolated, and it names no repo, path or state');
  assert.ok(/>&2/.test(report), 'it goes to stderr, so it cannot be mistaken for git output');
  // The text stays UN-neutralised: it must be what the operator would have typed (§3.3 residue).
  for (const leak of ['--attr-source', 'core.hooksPath', 'core.attributesFile', 'core.fsmonitor']) {
    assert.ok(!t.includes(leak), `no spawn neutraliser in the operator's text: ${leak}`);
  }
});
