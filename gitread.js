'use strict';
// gitread — the p8 read/generate surface: repos NESTED inside the repos you have open become
// readable from the file explorer's bar, without touching a line of the p7 write path.
//
// STRUCTURE IS THE SAFETY ARGUMENT (specs.md §2.2): every line of p8 server logic lives HERE, in a
// module gitpanel.js never requires. The p7 files — gitpanel.js, lib/gitcmd.js, lib/gitporcelain.js
// — stay byte-identical to main, so "the write path is untouched" collapses to one `git diff`
// command instead of a closure argument. gitread only imports gitpanel's PURE module-level exports
// (an error class, quoting, validation, containment) — requiring an untouched module executes no
// side effect.
//
// FIVE RULES THIS MODULE ENFORCES:
//
//  1. ONE DOOR. authorizeRead() is the single entry for the whole read/generate class. Nothing
//     touches the disk or spawns git for a candidate before it answers, and every refusal — jail,
//     scope, parse — is the same 403, so there is no existence oracle.
//  2. PINNED SPAWNS (specs.md §3.3). Every spawn after a read-gate acceptance carries
//     GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE, so git performs NO DISCOVERY after the gate — a `.git`
//     swapped between gate and body is never even opened. Measured: unpinned, that swap discloses
//     an external repo's state; pinned, it cannot.
//  3. A TOTAL CHILD BOUND (specs.md §5.2). Every child this module creates — every git spawn
//     including the read-route fan-outs, and the /sbin/mount read — passes through one width-2
//     FIFO limiter. gitread's concurrent children never exceed 2, of any kind, at any instant.
//  4. NO REPO-SUPPLIED PROGRAM RUNS (specs.md §3.3 rule 3). The browsed repo is attacker-controlled
//     input, and a git "read" will happily execute what that repo configures. Every spawn goes
//     through ONE wrapper (spawnGit) that prepends the neutralisers ABOVE the injected seam — and
//     where no flag can bound an attribute layer, the repo is REFUSED rather than read.
//  5. THE METADATA BOUNDARY INCLUDES THE OBJECT DATABASE (specs.md §3.3 rule 4). A tuple can sit
//     wholly inside the authorized union while `objects/info/alternates` points the object store
//     outside it. metadataPaths() is the one path set the gate tests; an escape refuses the repo.

const path = require('path');
const fs = require('fs');            // constants only — O_NONBLOCK, for the bounded gate reads below
const fsp = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
// ONE require of the untouched p7 module, not two: every pure export gitread borrows arrives here.
const { GitPanelError, validatePathspec, isInside, shellQuote, DIFF_MAX_BYTES } = require('./gitpanel');
const { GIT_BIN } = require('./lib/gitcmd');
const { parseStatusZ, parseBranchHeader, parseWorktreePorcelain } = require('./lib/gitporcelain');

const ANCHOR_TTL_MS = 5000;
const MOUNT_BIN = '/sbin/mount';
const MOUNT_TIMEOUT_MS = 2000;
const TUPLE_TIMEOUT_MS = 6000;     // matches gitpanel.js:94, NOT gitcmd's 20000 default
const LIMITER_WIDTH = 2;

// Deep system subtrees are equality-only regardless of what the mount table says: a code constant,
// not a knob (D6/D9). /Users/Shared joined in round 4 — admitted by every earlier rule.
const PLATFORM_DENY = Object.freeze([
  '/System', '/Library', '/usr', '/bin', '/sbin', '/private', '/opt', '/dev', '/Applications',
  '/cores', '/Users/Shared',
]);

// ---- BOUNDED GATE READS: the fs half of the total bound (specs.md §3.3, §5.2) -----------------
// Rules 3, 4 and 5 each cost a plain fs read of a file the BROWSED REPO owns — `info/attributes`
// (the fourth attribute door), `objects/info/alternates` (the object store), the sibling `gitdir`,
// and the `config` that names the object format. Every spawn in this module carries a timeout; a
// naked `fsp.readFile` carries none, and MEASURED, that asymmetry is a live denial of the whole p8
// surface:
//
//   * `open(2)` on a FIFO BLOCKS until a writer appears, and `.git/info/attributes` is the exact
//     file rule 3 declares attacker-controlled. Measured against the pre-fix module: two probes of
//     a repo carrying a FIFO there never settle, and because `probe` holds its admission slot across
//     its whole body, `finally { admitRelease() }` never runs — a benign probe of a HEALTHY anchor
//     then dies `probe_busy/503` at the 4000 ms acquisition deadline, for the process lifetime.
//   * a blocked `readFile` also parks a libuv THREADPOOL thread. Four of them exhaust the default
//     pool, after which `fs.stat` never returns anywhere in the process — so fsbrowse, which shares
//     nothing with gitread but the pool, goes down with it.
//   * the reads were UNCAPPED, so a 400 MB `info/attributes` is a full-file allocation per request
//     on routes that (unlike probe) have no admission limit at all.
//
// So a gate read opens with O_NONBLOCK — measured: returns in 0 ms on a FIFO where `fsp.readFile`
// blocks indefinitely — fstats the DESCRIPTOR rather than the path (no lstat/open race, and a
// SYMLINK to a FIFO is caught by its target's type), refuses anything that is not a regular file,
// refuses anything over the cap, and races the whole thing against a deadline.
//
// The cap REFUSES rather than truncates, and that is not fastidiousness: truncating would let an
// attacker push a `filter=` line past the cap and have the prefix read as "assigns no driver" —
// the precise bypass rule 3 exists to close. For the same reason none of this is memoized the way
// `objectFormat` is: a repo's object format is immutable, its `info/attributes` is not, so a cache
// would answer the gate from a file the attacker has since replaced.
const GATE_READ_MAX_BYTES = 1024 * 1024;   // info/attributes, alternates, config
const GATE_READ_PATH_BYTES = 65536;        // a `gitdir` file holds ONE path
const GATE_READ_TIMEOUT_MS = 2000;         // matches the mount read's bound

// Settles with the fallback rather than rejecting: every caller here has a fail-closed value, and a
// deadline that throws would need a second try/catch at each site.
function withDeadline(p, ms, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(onTimeout); } }, ms);
    Promise.resolve(p).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(onTimeout); } },
    );
  });
}

// { ok: true, text } | { ok: false, absent, reason }. `absent` is the ONE distinction the callers
// need: ENOENT/ENOTDIR mean there is no such file to read, which no rule treats as an escape;
// everything else means the file is there and p8 cannot see it, which every rule treats as one.
async function readGateFileUnbounded(file, cap) {
  let fh = null;
  try {
    fh = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, absent: false, reason: 'not_regular' };
    if (st.size > cap) return { ok: false, absent: false, reason: 'too_big' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (!bytesRead) break;                       // shrank under us: what was read is what there is
      off += bytesRead;
    }
    return { ok: true, text: buf.subarray(0, off).toString('utf8') };
  } catch (e) {
    const code = (e && e.code) || 'read_failed';
    return { ok: false, absent: code === 'ENOENT' || code === 'ENOTDIR', reason: code };
  } finally {
    if (fh) { try { await fh.close(); } catch (_) { /* the read already answered */ } }
  }
}

function readGateFile(file, cap) {
  return withDeadline(
    readGateFileUnbounded(file, cap == null ? GATE_READ_MAX_BYTES : cap),
    GATE_READ_TIMEOUT_MS,
    { ok: false, absent: false, reason: 'timeout' },   // slow is illegible, and illegible refuses
  );
}

const realOrNull = async (p) => { try { return await fsp.realpath(p); } catch (_) { return null; } };

// ---- rule 3: the neutralisers (specs.md §3.3, v3.4) -------------------------------------------
// MEASURED on git 2.50.1 against a repo that configures core.fsmonitor, diff.external, a
// .gitattributes-selected diff.<driver>.textconv, filter.<driver>.clean, filter.<driver>.process
// and a NESTED .gitattributes, all pointing at marker scripts:
//
//   argv                                                     markers created
//   status (bare)                                            CLEAN FSMONITOR PROCESS
//   status -c core.fsmonitor= -c core.hooksPath=/dev/null    CLEAN PROCESS      <- v3.4's -c list ALONE
//   diff --no-ext-diff (alone)                               CLEAN FSMONITOR TEXTCONV
//   status/diff + the list BELOW                             (none)
//
// The `-c` list alone loses because the driver NAME is chosen by the attacker's own .gitattributes
// and `-c filter.<name>.clean=` has no wildcard form. So the boundary is the ATTRIBUTE STACK, not
// the drivers it selects: --attr-source pins attributes to a tree instead of the working tree, and
// core.attributesFile=/dev/null drops the operator-level file.
const NEUTRALISERS = Object.freeze([
  '-c', 'core.fsmonitor=',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null',
]);

// --attr-source takes a tree-ish, and MEASURED: git validates it by HASH LENGTH before use — a
// 40-hex oid in a sha256 repo is `fatal: bad --attr-source`, which would make every sha256 repo
// unreadable. The oid need not resolve (a bogus 40-hex neutralises identically), only match the
// repo's object format, which is a plain fs read of <commonDir>/config away — never a spawn.
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

// ---- rule 3, the FOURTH DOOR: an attribute layer no flag can bound (specs.md §3.3, v3.4) ------
// MEASURED on git 2.50.1, and reproduced independently before this was written: under the FULL
// neutraliser set above, a repo carrying `filter.ev.clean` in its config and `f.txt filter=ev` in
// `<commonDir>/info/attributes` RAN the filter — through the exact p8 `diff` argv AND the exact p8
// `status` argv. That file is not in the tree, has the HIGHEST precedence of any attribute source,
// has no config or env override, and `--attr-source` does not bound it. In a browsed repo it is
// fully attacker-controlled, so this door needs only that the operator open a directory.
//
// It closes in the ISOLATE form, not the enumerate form. The driver NAME is chosen by the attacker,
// so there is nothing to enumerate; what is detectable is the LAYER. If the attribute stack carries
// a layer p8 cannot neutralise, p8 refuses the repo whole, through the same shape as every other
// refusal. NOT a blanket ban: an `info/attributes` that assigns no driver — or comments one out —
// is admitted and reads normally.
//
// Three measurements make the token test sufficient rather than hopeful:
//   * a macro DEFINED in the tree's top-level `.gitattributes` and merely APPLIED from
//     `info/attributes` does NOT fire under `--attr-source` (control: without it, the same fixture
//     does). So any macro that can still fire carries its own literal `filter=`/`diff=` token in
//     this file, and the token test sees it.
//   * `info/attributes` is a COMMON-dir path: a per-worktree `<gitDir>/info/attributes` is never
//     read, even from inside that worktree. commonDir is the whole surface.
//   * git skips leading blanks BEFORE testing for `#`, so an INDENTED rule applies and an indented
//     `#` is a comment. The comment test below is on the left-trimmed line, matching git.
function assignsAttributeDriver(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).replace(/^[ \t]+/, '');
    if (!line || line.startsWith('#')) continue;
    // git's separator set is exactly space+tab. `filter=x` / `diff=x` SELECT a driver; bare `diff`,
    // `-diff` and `text` do not. A quoted pattern containing a space still splits off its
    // attributes, and a `[attr]macro filter=x` DEFINITION line carries the token like any other.
    for (const tok of line.split(/[ \t]+/)) if (/^(?:filter|diff)=/.test(tok)) return true;
  }
  return false;
}

// The one plain fs read this rule costs — NEVER a spawn (rule 4 constraint 1: `rev-parse
// --git-path info/attributes` breaks five of U5's exact cost rows at once).
// ABSENCE is not an escape — almost no repo has this file, and ENOENT-as-refusal would refuse
// nearly every repo. But a file that EXISTS and cannot be read is an unbounded attribute layer by
// another name: p8 cannot see what it says, so it cannot claim to have bounded it. Every error
// that is not "there is no such file" therefore refuses.
// The read is BOUNDED (see readGateFile): a FIFO, a directory, an oversize file or a read that
// outruns the deadline are all "exists and cannot be read", which is the refusing branch — the same
// one an EACCES already took. Only true absence admits.
async function unboundedAttributeSource(commonDir) {
  const r = await readGateFile(path.join(commonDir, 'info', 'attributes'));
  if (!r.ok) return !r.absent;
  return assignsAttributeDriver(r.text);
}

// DECLARED RESIDUE, now narrow: a FUTURE git may add ANOTHER attribute source that no flag bounds.
// This one is named and closed; the class is not closable by a list. The retirement pin in
// test/gitread.test.js measures the current behaviour directly, so the day `--attr-source` does
// bound `info/attributes` the suite fails loudly and this refusal is retired rather than carried
// forever as folklore. Named here because §3.3's standing obligation says silence means banned.

// ---- rule 4: the object database (specs.md §3.3, v3.4) ---------------------------------------
const ALTERNATES_MAX_DEPTH = 4;

// An `info/alternates` that EXISTS but cannot be read (a FIFO, a directory, oversize, or slower
// than the deadline) is an object store pointing somewhere p8 cannot see. Absence is admitted —
// constraint 2 — but illegibility is the same argument the attribute door already makes, so it
// refuses. It travels as a member of the path set rather than a second return value because
// metadataPaths' contract is "the one path set the gate tests", and this is a path the gate cannot
// clear: it is not absolute, so `isInside` can never place it under any root.
const METADATA_UNREADABLE = '\0unreadable-object-store';

// `objects/info/alternates` has a GRAMMAR: blank lines, `#` comments and quoted C-escaped paths
// are all legal. A naive split('\n') turns a comment into an ENOENT, which — read as an escape —
// refuses a legitimate repo. Comments and blanks are skipped; a quoted entry is unquoted.
function unquoteC(line) {
  const OCT = '01234567';
  const SIMPLE = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
  let out = '';
  for (let i = 1; i < line.length; i++) {         // line[0] is the opening quote
    const ch = line[i];
    if (ch === '"') return out;                   // closing quote ends the entry
    if (ch !== '\\') { out += ch; continue; }
    const esc = line[++i];
    if (esc === undefined) return out;
    if (OCT.includes(esc)) {
      let digits = esc;
      while (digits.length < 3 && OCT.includes(line[i + 1])) digits += line[++i];
      out += String.fromCharCode(parseInt(digits, 8));
    } else out += (esc in SIMPLE ? SIMPLE[esc] : esc);
  }
  return out;
}

function parseAlternates(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || line.startsWith('#')) continue;
    out.push(line.startsWith('"') ? unquoteC(line) : line);
  }
  return out;
}

// The one path set the gate tests: {top, gitDir, commonDir} ∪ every reachable object store.
// Rule 4 is additive by construction — a future metadata indirection costs one member here, not a
// new branch in the gate. THREE normative constraints (specs.md §3.3):
//   1. Plain fs reads ONLY, never a spawn — U5's cost rows are exact, and `rev-parse --git-path
//      objects` would break five assertions at once.
//   2. A path that does not exist is NOT an escape. <gitDir>/objects is ABSENT on every linked
//      worktree (measured), so ENOENT-as-escape would refuse every linked-worktree anchor.
//   3. The alternates grammar above.
// A cycle terminates on the visited set; relative entries resolve against the objects directory
// that named them, not the cwd.
async function metadataPaths(t) {
  const out = new Set([t.top, t.gitDir, t.commonDir]);
  const seen = new Set();
  const walk = async (objDir, depth) => {
    let real;
    try { real = await fsp.realpath(objDir); } catch (_) { return; }   // absent: nothing to disclose
    if (seen.has(real)) return;
    seen.add(real);
    out.add(real);
    if (depth >= ALTERNATES_MAX_DEPTH) return;
    const r = await readGateFile(path.join(real, 'info', 'alternates'));
    if (!r.ok) {
      if (!r.absent) out.add(METADATA_UNREADABLE);   // present and illegible: refuse the repo whole
      return;
    }
    for (const entry of parseAlternates(r.text)) {
      await walk(path.isAbsolute(entry) ? entry : path.resolve(real, entry), depth + 1);
    }
  };
  await walk(path.join(t.commonDir, 'objects'), 0);
  if (t.gitDir !== t.commonDir) await walk(path.join(t.gitDir, 'objects'), 0);
  return out;
}

// ---- rule 5: the sibling boundary (specs.md §3.3, v3.4) --------------------------------------
// PURE — no injected jail, no await, no I/O. The fs jail used to be the fallback here, and under
// the operator's live FS_ROOTS=workspace-cwds:/ that admitted every path on disk, making §3.3's
// "no widening even by a count" vacuous on the real machine. The narrow anchor union is p8's
// boundary; the jail is a browsing-reachability filter and belongs only on the gate's widened branch.
function siblingAuthorized(t, wPath, narrowSet) {
  if (wPath === t.top) return true;
  return narrowSet.some((a) => isInside(a.top, wPath));
}

// ---- the in-progress state table (specs.md §6.2) ----------------------------------------------
// ONE table drives all THREE evaluations of the §6.2 predicate: the `rev-parse` argv that reads the
// state, the response keys the bar and the guard test, and the shell variables the generated text
// uses. Three hand-written spellings that agree today are not one predicate — that is the whole
// point of §6.2, and it is what let `merge --squash` through.
//
// MEASURED on git 2.50.1, each row against the SHIPPED guard text run verbatim:
//
//   operation                        writes                          shipped guard
//   merge (conflict or --no-commit)  MERGE_HEAD                      blocked
//   merge --squash                   SQUASH_MSG, NOT MERGE_HEAD      *** COMMITTED ***
//   revert -n                        REVERT_HEAD                     *** COMMITTED ***
//   cherry-pick, conflicts RESOLVED  CHERRY_PICK_HEAD + sequencer/   *** COMMITTED ***
//   cherry-pick, still conflicted    CHERRY_PICK_HEAD + sequencer/   blocked, by `unmerged` alone
//   rebase (merge backend)           rebase-merge/                   blocked
//   rebase --apply, git am           rebase-apply/                   blocked
//
// `merge --squash` deliberately does not write MERGE_HEAD — it writes SQUASH_MSG and leaves the
// result staged, which is precisely the shape `add -A && commit` turns into a silent squash commit
// under a one-line message the operator wrote for something else. `git status` calls every row here
// in-progress in the operator's own words ("You are currently cherry-picking commit …"), which is
// the bar §6.2's opening sentence sets.
//
// DECLARED RESIDUE, measured and not closable here: a CONFLICT-FREE `cherry-pick -n` leaves NO
// state file at all — all seven paths absent, `ls-files -u` empty, the picked content merely staged.
// No state-file predicate can see it, so this one is recorded rather than covered. Closing it would
// need a different instrument (comparing the index against HEAD), which is a different story.
const IN_PROGRESS_STATES = Object.freeze([
  { key: 'merge', gitPath: 'MERGE_HEAD' },
  { key: 'squash', gitPath: 'SQUASH_MSG' },
  { key: 'revert', gitPath: 'REVERT_HEAD' },
  { key: 'cherryPick', gitPath: 'CHERRY_PICK_HEAD' },
  { key: 'sequencer', gitPath: 'sequencer' },
  { key: 'rebaseMerge', gitPath: 'rebase-merge' },
  { key: 'rebaseApply', gitPath: 'rebase-apply' },
]);

// The keys of the RESPONSE shape, which is what the bar holds and what syncBlockedReasons reads.
// It is not the table's key list: `rebase-merge` and `rebase-apply` are two directories for one
// idea, and `rebase-apply` is shared with `git am` (see inProgressFor).
const IN_PROGRESS_KEYS = Object.freeze([
  'merge', 'squash', 'revert', 'cherryPick', 'sequencer', 'rebase', 'am',
]);

// ---- generated command TEXT (specs.md §6.1) ---------------------------------------------------
// Text for the operator to read and run by hand. NOTHING here is ever executed by gitread, and the
// text is deliberately UN-neutralised: it must be what the operator would have typed, so the §3.3
// rule-3 flags that ride gitread's own spawns are absent by design (a declared residue, not an
// oversight). One fixed template per verb — no free-form construction — and the repo is scoped with
// `git -C` rather than `cd`, so the reviewed text names the repository it acts on (§2.4).
const at = (repo, cmd) => `git -C ${shellQuote(repo)} ${cmd}`;

// `shellQuote` is necessary and NOT SUFFICIENT, twice over, and both gaps are closed per slot below
// rather than by a flag here:
//   * it stops the SHELL interpreting a value, not GIT parsing it as an OPTION. Measured:
//     `push origin '--all'` — perfectly quoted — pushed every branch to the remote.
//   * `--` stops option parsing but NOT pathspec magic. Measured: `restore -- ':(top,glob)**'`
//     restored the ENTIRE repo. Only `--literal-pathspecs` disarms the pathspec grammar, and it
//     composes with `-C` in either order (measured).
const COMMAND_TEMPLATES = Object.freeze({
  commit: (r, { message }) => at(r, `commit -m ${shellQuote(message || '')}`),
  // `push origin -- <branch>`: measured, the `--` turns `--all` from an option that pushes every
  // branch into a refspec that matches nothing. The branch is DERIVED, never client-supplied.
  push: (r, { branch }) => at(r, `push origin -- ${shellQuote(branch)}`),
  pull: (r) => at(r, 'pull --ff-only'),
  'pull-rebase': (r) => at(r, 'pull --rebase'),
  fetch: (r) => at(r, 'fetch --all --prune'),
  // NO `--` for the ref-taking verbs: after `--` git reads the operand as a PATHSPEC, silently
  // changing what the verb means. Validation is the guard (validateOperand below).
  checkout: (r, { branch }) => at(r, `checkout ${shellQuote(branch)}`),
  merge: (r, { branch }) => at(r, `merge --no-ff ${shellQuote(branch)}`),
  rebase: (r, { branch }) => at(r, `rebase ${shellQuote(branch)}`),
  stash: (r) => at(r, 'stash push -u'),
  discard: (r, { paths }) => `git -C ${shellQuote(r)} --literal-pathspecs restore -- ${(paths || []).map(shellQuote).join(' ')}`,
  clean: (r) => at(r, 'clean -nd'),                  // dry run by design; the operator removes the -n
  'worktree-add': (r, { dir, branch }) => at(r, `worktree add ${shellQuote(dir)} ${shellQuote(branch)}`),
  // The thirteenth is not a `git -C` one-liner but the §6.2 GUARDED SUBSHELL, because this text
  // executes LATER than the server-side check and the repo can change in between. `add -A` with
  // unmerged paths marks conflicts RESOLVED — markers included — so the FULL predicate ships inside
  // the command.
  //
  // Every git read joins the `&&` chain through an ASSIGNMENT, not through `test -z "$(...)"`, and
  // that is the whole design. Measured: `test -z "$(false)" && echo REACHED` PRINTS — a git that
  // dies with empty stdout satisfies `test -z` and the chain proceeds to stage and commit, so the
  // naive form fails OPEN exactly when git is broken. An assignment's exit status IS the
  // substitution's (measured: `u=$(false) && echo` never echoes), so a vanished repo blocks instead
  // (measured: exit 128, nothing staged, no commit).
  //
  // `--path-format=absolute` is required because the text runs in a pane whose cwd is arbitrary,
  // and it is worktree-safe (measured: from a linked worktree these resolve into
  // <main>/.git/worktrees/<id>/…, so one worktree's rebase is never read as another's). `--git-path`
  // PRINTS its path whether or not the file exists (measured), which is why existence is a separate
  // `test -e`. The subshell keeps `R` out of the operator's interactive shell (measured: unset
  // afterwards) — the §2.4 hygiene bar that disqualified `cd` — and the repo path appears ONCE, at
  // the front, which is also the most reviewable shape on a phone.
  // The reads and the tests are GENERATED FROM IN_PROGRESS_STATES, not written out beside it: a
  // state added to the table is in the text the same instant it is in the spawn, which is the only
  // way "one predicate at three times" survives a future git that invents an eighth state file.
  //
  // Seven `--git-path` substitutions would be 835 characters of near-identical boilerplate, and
  // text nobody reads is not a reviewed command (§2.4). ONE `--git-dir` read plus seven `test ! -e
  // "$G/<name>"` is half the length and every clause is legible at a glance. That rests on an
  // ASSUMPTION — that `$(--git-dir)/<name>` is the same path `--git-path <name>` prints — which is
  // MEASURED for all seven states in all three layouts (plain repo, LINKED WORKTREE, and
  // `--separate-git-dir`), and pinned by a test that re-measures it on every run. `--git-path`
  // exists because some files live in the COMMON dir instead; the day one of these moves there, the
  // pin fails loudly and this text is rewritten. The SERVER side keeps `--git-path` regardless, so
  // the exact primitive is never the one that can go blind.
  //
  // Every git read still joins the chain through an ASSIGNMENT, not `test -z "$(…)"` — the whole
  // reason the naive form fails OPEN when git dies (measured below the templates).
  //
  // A blocked run is no longer SILENT (measured before: exit 1, ZERO bytes of operator-visible
  // output — which reads as "the button did nothing" and invites exactly the retry the guard exists
  // to stop). The `|| { … }` group runs only when the chain failed, prints to stderr, and `false`
  // keeps the whole text's exit status non-zero.
  sync: (r, { message }) => {
    const inR = (cmd) => `git -C "$R" ${cmd}`;
    return `( R=${shellQuote(r)}`
      + ` && u=$(${inR('ls-files -u')})`
      + ` && G=$(${inR('rev-parse --path-format=absolute --git-dir')})`
      + ' && test -z "$u"'
      + IN_PROGRESS_STATES.map((s) => ` && test ! -e "$G/${s.gitPath}"`).join('')
      + ` && ${inR('add -A')}`
      + ` && ${inR(`commit -m ${shellQuote(message)}`)} )`
      + " || { echo 'sync blocked: repo state changed' >&2; false; }";
  },
});

// The per-slot rule for every operand that is not behind `--`: refuse anything git would read as an
// option, and anything that could not be one line of reviewable text. Refused BEFORE templating —
// a rejected call produces no string at all.
function validateOperand(v) {
  const s = String(v == null ? '' : v);
  // EMPTY IS NOT AN OPERAND. Measured on the shipped module: `String(undefined)` coerced to `''`,
  // which passed all three tests below and generated `checkout ''`, `merge --no-ff ''` and
  // `worktree add '' 'x'` — text for a request that named nothing. A missing operand is a bad
  // request, and the caller should hear 400 rather than receive a command that cannot work.
  if (!s) throw new GitPanelError('bad_ref', 400);
  if (s.startsWith('-')) throw new GitPanelError('bad_ref', 400);
  if (s.includes('\0') || s.includes('\n')) throw new GitPanelError('bad_ref', 400);
  return s;
}

// The `paths` slot is the only ARRAY operand, and its shape was never checked: measured,
// `{paths: 'a.txt'}` reached the template and threw a bare TypeError out of `.map`, which the
// bridge's error mapper turns into 500 `git_failed`. Every other refusal on this surface is a 400
// with a code; an argument shape must not be the one way to produce a different response class.
const MAX_DISCARD_PATHS = 200;      // the bound the p7 relay already applies to a paths array
function validatePaths(v) {
  if (!Array.isArray(v) || !v.length) throw new GitPanelError('bad_paths', 400);
  if (v.length > MAX_DISCARD_PATHS) throw new GitPanelError('too_many_paths', 400);
  for (const x of v) if (typeof x !== 'string') throw new GitPanelError('bad_paths', 400);
  return v.map((x) => validatePathspec(x));      // the same validator the `diff` route uses
}

// The `message` slot is the one operand that is FREE TEXT, so it gets its own rule rather than
// validateOperand's: a leading `-` is fine after `-m` (git's parse-options takes the next argv as
// the value), and refusing it would refuse a legitimate message. What is NOT fine is a message that
// ends the line. `\n` makes the generated text multi-line, and a composer that submits at the first
// newline hands the operator's shell an unterminated quote — with `sync` (§6.2) that is a half-typed
// `&&` chain over their repo, waiting at PS2 to swallow whatever they type next. `\r` is the same
// hazard and not a smaller one: a terminal line discipline maps CR to NL (ICRNL), so a pasted CR
// submits the line exactly as Enter does.
//
// This is a NEW rule, not a p7 one: p7's `commit` slot is unguarded and §6.1 is silent, so nothing
// regressed — but STORY-005 embeds this same slot inside the §6.2 subshell, which is what makes
// "one line of reviewable text" (§2.4) worth enforcing rather than declaring.
function validateMessage(v) {
  const s = String(v == null ? '' : v);
  if (s.includes('\0') || s.includes('\n') || s.includes('\r')) throw new GitPanelError('bad_message', 400);
  return s;
}

// ---- the sync predicate (specs.md §6.2) -------------------------------------------------------
// ONE predicate — `unmerged > 0 ∨ MERGE_HEAD ∨ rebase-merge ∨ rebase-apply` — evaluated at THREE
// times: the bar's tap (STORY-007, over a status response it already holds), generation (`command`
// below, over the same shape from a fresh read), and execution (the shell transliteration in
// COMMAND_TEMPLATES.sync). It is written once, as a pure function over the p8 STATUS SHAPE, because
// that is the shape the bar holds — three re-spellings that agree today are not one predicate, and
// the point of the guard is that a repo whose state changes between tap and run cannot produce a
// command that lies.
//
// An unreadable status is a BLOCKED status: `add -A && commit` is not a thing to do on a guess.
// Returns the reasons rather than a boolean so a server-side log can say WHICH clause fired without
// putting any of it on the wire (§7: one reason, server-side only).
function syncBlockedReasons(s) {
  if (!s || s.error || !s.counts || !s.inProgress) return ['unreadable'];
  const out = [];
  if (Number(s.counts.unmerged) > 0) out.push('unmerged');
  for (const k of IN_PROGRESS_KEYS) if (s.inProgress[k]) out.push(k);
  return out;
}

// ---- PROVENANCE, and the residue it exists to mark (STORY-010, war-game M7b) -----------------
//
// The generated text above is deliberately UN-neutralised (§6.1, §2.4): it is what the operator
// would have typed. That is a decision with a cost, and the cost is that RUNNING IT RUNS THE
// REPO'S OWN CONFIGURED PROGRAMS. Red-team measured every p8 verb against a repo whose
// `.git/config` is attacker-controlled — which rule 3's own rationale says a browsed repo's is:
//
//     remote.<n>.uploadpack   + `fetch --all --prune`   -> ran
//     remote.<n>.uploadpack   + `pull --rebase`         -> ran
//     remote.origin.receivepack + `push origin -- <b>`  -> ran
//     core.sshCommand (ssh-form URL) + `fetch <remote>` -> ran
//     .git/hooks/pre-commit   + `commit -m …`           -> ran
//
// A VISIBLE `-c core.hooksPath=/dev/null` in the templates was measured to close the LAST ROW AND
// NOTHING ELSE — 1 of 5 — while making the text no longer what the operator would have typed. It
// is REJECTED here, deliberately and on the measurement: a neutraliser the reader can see reads as
// "this path is handled", and a false safety signal is worse than none. NOTHING IN THE TEXT IS
// EVER NEUTRALISED. The marking below is PRESENTATION; the payload is untouched, and a test
// asserts the text is byte-identical across both classes for every verb.
//
// What IS surfaced is the boundary that actually predicts the risk, and p8's gate already decided
// it one line at a time. `authorizeRead` admits a candidate through exactly two doors:
//
//   * ANCHOR-TOP EQUALITY — the directory IS a toplevel of a workspace the operator has open.
//     That is one of their own projects: `workspace`.
//   * CONTAINMENT under a narrow anchor — the directory was merely REACHED by browsing inside a
//     workspace, and nothing says the operator has ever seen it: `browsed`.
//
// So provenance costs ZERO extra work and ZERO extra spawns: it is the branch the gate took,
// recorded instead of discarded. It is NOT `canWrite` renamed — canWrite is `writesEnabled &&
// assertRepo(top)`, so it is false for EVERY repo when GIT_WRITES_ENABLED is off, and a workspace
// repo must still read as `workspace` with writes disabled. Those are different facts and the
// tests hold them apart. It also degrades correctly: a git release that adds a SIXTH executor does
// not make the marking wrong, because the marking never claimed to enumerate executors.
//
// A repo the gate REFUSES carries no provenance at all — authorizeRead throws before either
// constant is reached, and the refusal shape stays the shared `{repo:null}` / 403. That
// indistinguishability is the §3.1 no-oracle property; provenance is a fact about a repo ALREADY
// AUTHORIZED FOR READING, never a probe for whether one exists.
const PROVENANCE_WORKSPACE = 'workspace';
const PROVENANCE_BROWSED = 'browsed';

// The marking the operator reads, at the moment the text is handed to them. Held HERE, next to the
// residue it abbreviates, and asserted to appear verbatim in both client files that generate p8
// text — so the two doors cannot drift into two different warnings, and neither can quietly lose
// it. It names the consequence and claims no safety, because there is none to claim.
const BROWSED_TEXT_MARK =
  'browsed repo — running this text runs that repo\'s configured programs; the text shows the verb, not the hooks';

// The handover declaration (war-game M7b option (b)), in the operator's words rather than §9's.
// The whole point is that an operator who never reads §9 still meets this, so it lives in the
// module as a quotable constant and the handover output carries it verbatim.
const GENERATED_TEXT_RESIDUE = [
  'Running the text p8 generates inside a repo you did not author runs that repo\'s configured',
  'programs: hooks on `commit`, `uploadpack` on `fetch` and `pull`, `receivepack` on `push`,',
  '`core.sshCommand` on an ssh remote, and `core.fsmonitor` on `pull --rebase`. Reviewing the text',
  'shows you the verb; it cannot show you the hooks.',
  '',
  'p8 does not neutralise that text — it stays what you would have typed — so instead the text',
  'generated for a repo you only browsed into is marked as such where you read it. Text for a',
  'workspace you have open is unmarked. The command itself is byte-identical either way.',
].join('\n');

// ---- the runner -----------------------------------------------------------------------------
// gitread's own execFile wrapper, NOT lib/gitcmd's: gitIn builds its execFile options internally
// with a fixed env and passes only timeoutMs through, and rule 2 requires a per-spawn env. The
// single git-binary literal stays single — GIT_BIN is imported, and this module mirrors gitcmd's
// hardening and its never-throw result shape.
//
// THE BASE IS SANITIZED (specs.md §3.3, round 6): every GIT_* variable is stripped from
// process.env before the hardening constants and any pin are added. Measured: inherited GIT_DIR
// redirects a `-C` discovery, and inherited GIT_INDEX_FILE redirects a fully-pinned status —
// neither needs a path race. Git's repository-local override set (`git rev-parse
// --local-env-vars`, plus GIT_CEILING_DIRECTORIES / GIT_DISCOVERY_ACROSS_FILESYSTEM) is entirely
// GIT_*-prefixed and grows over time; these spawns are read-only plumbing that consults no author
// identity, SSH, credential helper or editor, so the strip-all superset costs nothing and cannot
// rot. System and global config REMAIN enabled — the same visibility p7's runner has today.
const BASE_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ASKPASS: '',
  LC_ALL: 'C',
});

function sanitizedBase() {
  const out = {};
  for (const k of Object.keys(process.env)) {
    if (!k.startsWith('GIT_')) out[k] = process.env[k];
  }
  return Object.assign(out, BASE_ENV);
}

function defaultRun(dir, args, opts) {
  const o = opts || {};
  const timeout = o.timeoutMs == null ? 20000 : o.timeoutMs;
  return new Promise((resolve) => {
    execFile(
      GIT_BIN,
      ['-C', dir].concat(args),
      {
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        env: Object.assign(sanitizedBase(), o.env || {}),
        windowsHide: true,
      },
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

// ---- the limiter ----------------------------------------------------------------------------
// Width-2 FIFO. Acquisition is per-spawn and never held across another acquisition — no holder
// awaits the limiter again — so there is no deadlock, only queueing.
function makeLimiter(width) {
  let active = 0;
  const queue = [];
  function release() {
    const next = queue.shift();
    if (next) next();          // the slot transfers to the next waiter; active is unchanged
    else active--;
  }
  return async function withSlot(fn) {
    if (active < width) active++;
    else await new Promise((r) => queue.push(r));
    try { return await fn(); } finally { release(); }
  };
}

// ---- breadth (specs.md §3.4) ----------------------------------------------------------------
// Pure. `mounts` is a Set of realpath'd mount points, or null when the mount read failed —
// and a failed read makes EVERY anchor broad (fail closed).
function classifyBreadth(top, ctx) {
  const c = ctx || {};
  const deny = c.deny || PLATFORM_DENY;
  if (c.mounts == null) return 'broad';
  if (top === '/') return 'broad';
  if (top.split(path.sep).filter(Boolean).length === 1) return 'broad';
  if (c.mounts.has(top)) return 'broad';
  if (c.home && isInside(top, c.home)) return 'broad';           // home lives INSIDE this toplevel
  if (deny.some((d) => top === d || isInside(d, top))) return 'broad';
  return 'narrow';
}

// mount table text -> mount point strings. Lines look like `<dev> on <point> (opts)`; the point
// itself may contain ` on ` in theory but never ` (` at the end position — first ' on ', last
// ' ('. ANY line that does not fit fails the whole parse: unparseable == failed read == all broad.
function parseMounts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const on = line.indexOf(' on ');
    const paren = line.lastIndexOf(' (');
    if (on < 0 || paren <= on + 4) throw new Error('unparseable mount line');
    out.push(line.slice(on + 4, paren));
  }
  if (!out.length) throw new Error('empty mount table');
  return out;
}

function createGitRead(opts) {
  const o = opts || {};
  const workspaceCwds = o.workspaceCwds || (async () => []);
  const run = o.run || defaultRun;      // ONE runner contract (v3.2): run(dir, args, {timeoutMs, env})
  const jail = o.jail || (async () => { throw new Error('no jail injected'); });
  const assertRepo = o.assertRepo || (async () => { throw new Error('no oracle'); });
  const writesEnabled = !!o.writesEnabled;
  const mounts = o.mounts || (() => new Promise((resolve, reject) => {
    execFile(MOUNT_BIN, [], { timeout: MOUNT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }));
  const homedirFn = o.homedir || (() => os.homedir());
  const nowMs = o.nowMs || Date.now;
  const platformDeny = o.platformDeny || PLATFORM_DENY;   // TEST-ONLY seam; bridge passes nothing
  const log = o.log || (() => {});

  const withSlot = makeLimiter(LIMITER_WIDTH);

  // ---- rule 3: ONE wrapper, and it sits ABOVE the injected seam ------------------------------
  // Not per call site — that is the enumeration the rule bans, and it turns U23 from one check
  // over the whole call log into five checks a sixth route escapes. Not inside defaultRun either —
  // `run` IS the seam, so a test injecting a recording runner would bypass defaultRun entirely and
  // every injected-runner test in the suite would spawn UNNEUTRALISED argv. No call site below
  // calls `run` directly; new routes inherit rule 3 by construction.
  const objectFormat = new Map();          // commonDir -> empty-tree oid; a repo's format is immutable
  async function attrSourceOid(env) {
    const common = env && env.GIT_COMMON_DIR;
    if (!common) return EMPTY_TREE_SHA1;   // pre-gate tuple reads: measured attribute-inert either way
    if (!objectFormat.has(common)) {
      // Bounded like every other repo-owned read: `config` is as attacker-controlled as the rest,
      // and a FIFO here would hang the POST-GATE spawns instead of the gate. An unreadable config
      // keeps git's own default — and a sha256 repo whose format cannot be read then fails its
      // spawn with `bad --attr-source`, which is the fail-closed direction.
      const r = await readGateFile(path.join(common, 'config'));
      let oid = EMPTY_TREE_SHA1;
      if (r.ok && /^[ \t]*objectformat[ \t]*=[ \t]*sha256/im.test(r.text)) oid = EMPTY_TREE_SHA256;
      objectFormat.set(common, oid);
    }
    return objectFormat.get(common);
  }
  async function spawnGit(dir, args, opts) {
    const o = opts || {};
    return run(dir, NEUTRALISERS.concat([`--attr-source=${await attrSourceOid(o.env)}`], args), o);
  }

  const refuse = () => new GitPanelError('unknown_repo', 403);

  async function realStrict(p) {
    if (typeof p !== 'string' || !p) throw refuse();
    try { return await fsp.realpath(p); } catch (_) { throw refuse(); }   // NEVER a lexical fallback
  }

  // Strict tuple parse: strip exactly ONE trailing newline — never .trim(), which corrupts a
  // toplevel ending in a space (measured). An interior newline mis-splits to ≠3 lines and the
  // candidate is REJECTED — the fail-closed direction.
  function parseTuple(stdout) {
    let s = String(stdout || '');
    if (s.endsWith('\n')) s = s.slice(0, -1);
    const rows = s.split('\n');
    if (rows.length !== 3 || rows.some((r) => !r.startsWith('/'))) return null;
    return { top: rows[0], gitDir: rows[1], commonDir: rows[2] };
  }

  async function readTuple(dir, env) {
    const r = await withSlot(() => spawnGit(dir,
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { timeoutMs: TUPLE_TIMEOUT_MS, env }));
    if (!r.ok) return null;
    return parseTuple(r.stdout);
  }

  // ---- discovery (specs.md §3.5) ------------------------------------------------------------
  // One tuple spawn per workspace cwd plus ONE mount read, all through the limiter; a 5 s TTL
  // cache on the injected clock; single-flight; a rejected discovery is NOT cached and fails its
  // awaiting callers closed. There is NO miss-refresh — deleted with the subset property.
  let anchorCache = null;      // { anchors, at }
  let inflight = null;

  const raceTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });

  // Null = the table could not be read (spawn failure, timeout, unparseable line, unresolvable
  // point) and every anchor is broad. The 2000 ms race wraps the INJECTED seam too, so a hanging
  // mounts read settles discovery within its bound and releases its limiter slot.
  async function readMountSet() {
    try {
      const raw = await withSlot(() => raceTimeout(mounts(), MOUNT_TIMEOUT_MS));
      const points = parseMounts(raw);
      const set = new Set();
      for (const p of points) set.add(await fsp.realpath(p));
      return set;
    } catch (_) { return null; }
  }

  async function discover() {
    const cwds = await workspaceCwds();
    const mountSet = await readMountSet();
    let home = homedirFn();
    try { home = await fsp.realpath(home); } catch (_) { /* keep the lexical value */ }
    const byTop = new Map();
    await Promise.all((cwds || []).map(async (w) => {
      if (!w || !w.path) return;
      const t = await readTuple(w.path);
      if (!t) return;                                    // non-repo cwd anchors nothing
      let top;
      try { top = await fsp.realpath(t.top); } catch (_) { return; }   // unresolvable anchor: dropped
      if (top !== t.top) return;                          // git answered a path realpath disowns — drop
      if (!byTop.has(top)) {
        byTop.set(top, {
          top,
          gitDir: t.gitDir,
          commonDir: t.commonDir,
          breadth: classifyBreadth(top, { mounts: mountSet, home, deny: platformDeny }),
          labels: [],
        });
      }
      if (w.label && !byTop.get(top).labels.includes(w.label)) byTop.get(top).labels.push(w.label);
    }));
    return [...byTop.values()];
  }

  async function anchors() {
    if (anchorCache && nowMs() - anchorCache.at < ANCHOR_TTL_MS) return anchorCache.anchors;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const a = await discover();
        anchorCache = { anchors: a, at: nowMs() };        // TTL starts at SUCCESSFUL completion
        return a;
      } finally { inflight = null; }                      // a rejection is not cached
    })();
    return inflight;
  }

  // Rule 4's gate: ONE predicate over a path set, not a fourth check. The roots are the authorized
  // tuple itself plus the narrow anchor union — a linked-worktree anchor's metadata legitimately
  // lives under its main repo's commonDir, which is why gitDir/commonDir are roots and not merely
  // members. Realpath'd, so a symlinked `objects` cannot pass a lexical check and resolve outside.
  // Any escape refuses the WHOLE repo through the shared shape — no existence oracle.
  async function withinMetadataBound(t, narrow) {
    // Rule 3's fourth door, checked FIRST because it is one fs read and the path fan-out below is
    // several: an attribute layer p8 cannot bound refuses the repo whole, through the SAME shape as
    // every other refusal — so it is not an existence oracle either.
    if (await unboundedAttributeSource(t.commonDir)) {
      log({ event: 'refuse', reason: 'unbounded_attribute_source' });   // server-side only
      return false;
    }
    const roots = [];
    for (const r of [t.top, t.gitDir, t.commonDir].concat(narrow.map((a) => a.top))) {
      try { roots.push(await fsp.realpath(r)); } catch (_) { roots.push(r); }
    }
    const reachable = await metadataPaths(t);
    if (reachable.has(METADATA_UNREADABLE)) {
      log({ event: 'refuse', reason: 'unreadable_object_store' });   // server-side only
      return false;
    }
    for (const p of reachable) {
      if (!roots.some((r) => isInside(r, p))) {
        log({ event: 'refuse', reason: 'objects_escape' });   // server-side only: the wire shape is unchanged
        return false;
      }
    }
    return true;
  }

  // ---- the gate (specs.md §3.1) -------------------------------------------------------------
  async function authorizeRead(rawDir) {
    const canonical = await realStrict(rawDir);
    let set;
    try { set = await anchors(); } catch (_) { throw refuse(); }   // failed discovery fails closed
    const narrow = set.filter((a) => a.breadth === 'narrow');

    // Anchor-top branch: exactly the surface the p7 panel already exposes — no jail (a repo whose
    // only pane sits at …/repo/src has fs root …/repo/src, and jailing …/repo would break it).
    const eq = set.find((a) => a.top === canonical);
    if (eq) {
      const t = await readTuple(canonical);               // spawn ON THE CANONICAL STRING
      if (!t || t.top !== eq.top || t.gitDir !== eq.gitDir || t.commonDir !== eq.commonDir) {
        throw refuse();                                   // the directory's git identity changed
      }
      if (!(await withinMetadataBound(t, narrow))) throw refuse();
      // STORY-010: the door taken IS the provenance. Recorded, not re-derived — re-deriving it
      // would mean a second enumeration, and `assertRepo` (the only other source of this fact)
      // costs one spawn per open workspace and is gated behind `writesEnabled`.
      t.provenance = PROVENANCE_WORKSPACE;
      return t;
    }

    // Widened surface: jail FIRST, and every candidate spawn runs on the path the jail RETURNED —
    // the pre-jail resolution dies here (round 4: resolving first and jailing second leaves a
    // retargetable-symlink window; the jail's return is definitionally what it admitted).
    let jreal;
    try { jreal = await jail(rawDir); } catch (_) { throw refuse(); }   // same refusal — no oracle
    const t = await readTuple(jreal);
    if (!t) throw refuse();
    const inUnion = (p) => narrow.some((a) => isInside(a.top, p));
    if (!narrow.some((a) => isInside(a.top, t.top))) throw refuse();
    if (!inUnion(t.gitDir) || !inUnion(t.commonDir)) throw refuse();
    if (!(await withinMetadataBound(t, narrow))) throw refuse();
    t.provenance = PROVENANCE_BROWSED;      // reached by browsing: nothing says the operator authored it
    return t;
  }

  // Rule 2: the pin. Env on every spawn addressing the authorized repo.
  const pinEnv = (t) => ({ GIT_DIR: t.gitDir, GIT_COMMON_DIR: t.commonDir, GIT_WORK_TREE: t.top });

  // ---- the admission semaphore (specs.md §5.2) ----------------------------------------------
  // Width 2, FIFO queue capped at 8, immediate 503 on overflow, 4000 ms acquisition deadline —
  // shorter than the 6000 ms spawn timeout. Cancellation-aware: a queued entry dies with its
  // CALLER'S DISCONNECT, which the bridge observes on `res` (`close` + !writableEnded) — never
  // `req`, whose 'close' a completed bodyless GET fires while its response is still pending.
  // A dead entry is unlinked O(1): marked dead, skipped at dequeue. Admitted bodies always run
  // to completion; the spawn limiter bounds their children regardless.
  const ADMIT_WIDTH = 2;
  const ADMIT_QUEUE_MAX = 8;
  const ADMIT_DEADLINE_MS = 4000;
  let admitActive = 0;
  const admitQueue = [];

  function admitRelease() {
    for (;;) {
      const next = admitQueue.shift();
      if (!next) { admitActive--; return; }
      if (next.dead) continue;                    // skipped at dequeue — its body never starts
      clearTimeout(next.timer);
      if (next.cleanup) { try { next.cleanup(); } catch (_) {} }
      next.resolve();                             // the slot transfers; admitActive unchanged
      return;
    }
  }

  // onCancel — when provided — is called with the entry's cancel function and must return a
  // cleanup that detaches whatever it wired (removed on admission or settlement).
  async function admit(onCancel) {
    if (admitActive < ADMIT_WIDTH) { admitActive++; return; }
    const waiting = admitQueue.filter((e) => !e.dead).length;
    if (waiting >= ADMIT_QUEUE_MAX) throw new GitPanelError('probe_busy', 503);
    await new Promise((resolve, reject) => {
      const entry = { dead: false, resolve, cleanup: null };
      entry.timer = setTimeout(() => {            // a waiter cannot outlive the operator's interest
        entry.dead = true;
        if (entry.cleanup) { try { entry.cleanup(); } catch (_) {} }
        reject(new GitPanelError('probe_busy', 503));
      }, ADMIT_DEADLINE_MS);
      if (onCancel) {
        entry.cleanup = onCancel(() => {          // the caller left: unlink, never start the body
          entry.dead = true;
          clearTimeout(entry.timer);
          reject(new GitPanelError('probe_busy', 503));
        });
      }
      admitQueue.push(entry);
    });
  }

  async function withAdmission(onCancel, fn) {
    await admit(onCancel);
    try { return await fn(); } finally { admitRelease(); }
  }

  // ---- probe (specs.md §5, §5.1) ------------------------------------------------------------
  // The bar's one question: "is this directory a repo I may read, and what state is it in?"
  // ANY refusal — jail, scope, parse, git failure — is the same { repo: null }: no existence
  // oracle, and failure can never impersonate `unborn` (the signature is POSITIVE: symbolic-ref
  // exits 0 printing refs/heads/<name> on unborn; 1 on detached; 128 on corruption). Both branch
  // reads are POST-GATE and carry the pin (v3.2 — probe is not exempt).
  async function probe(dir, opts) {
    const onCancel = (opts && opts.onCancel) || null;
    return withAdmission(onCancel, async () => {
      let t;
      try { t = await authorizeRead(dir); } catch (_) { return { repo: null }; }
      const pin = pinEnv(t);
      const name = path.basename(t.top);
      const br = await withSlot(() => spawnGit(t.top, ['rev-parse', '--abbrev-ref', 'HEAD'],
        { timeoutMs: TUPLE_TIMEOUT_MS, env: pin }));
      if (br.ok) {
        let ref = br.stdout || '';
        if (ref.endsWith('\n')) ref = ref.slice(0, -1);
        if (ref === 'HEAD') return { repo: t.top, name, branch: null, state: 'detached' };
        if (!ref) return { repo: null };
        return { repo: t.top, name, branch: ref, state: 'branch' };
      }
      if (br.code === 128) {
        const sr = await withSlot(() => spawnGit(t.top, ['symbolic-ref', '--quiet', 'HEAD'],
          { timeoutMs: TUPLE_TIMEOUT_MS, env: pin }));
        if (sr.ok) {
          let ref = sr.stdout || '';
          if (ref.endsWith('\n')) ref = ref.slice(0, -1);
          if (ref.startsWith('refs/heads/')) {
            return { repo: t.top, name, branch: ref.slice('refs/heads/'.length), state: 'unborn' };
          }
        }
      }
      return { repo: null };
    });
  }

  // ---- in-progress detection (specs.md §6.2, §3.2) ------------------------------------------
  // ONE spawn — three `--git-path`s in a single rev-parse — plus fs existence checks.
  //
  // p7's `status()` (gitpanel.js:137) equates "rebasing" with REBASE_HEAD existing. Measured on git
  // 2.50.1: a NON-CONFLICTING `rebase -i --exec false <base>` pauses with `.git/rebase-merge`
  // present and NO REBASE_HEAD, no unmerged paths and no MERGE_HEAD — invisible to that detector,
  // and the exact state where `add -A && commit` silently commits a half-applied rebase. (A
  // rebase that pauses on a CONFLICT does set REBASE_HEAD, which is why the naive detector looks
  // right in casual testing: the blind spot is only the markerless phase.) The apply backend puts
  // its state in `rebase-apply` instead, so both are read.
  //
  // `--git-path` PRINTS a path whether or not it exists (measured), so existence is a separate
  // `stat` — the same split the generated text makes with `test -e`. `--path-format=absolute`
  // makes the answer independent of cwd and is worktree-safe (measured: from a linked worktree the
  // three resolve into <main>/.git/worktrees/<id>/…, so a rebase in one worktree is never read as
  // a rebase in another). p7's `status()` is NOT edited — the ⎇ door keeps the shipped detector
  // (§3.2, §9); this fix is gitread's, so the bar-opened panel, the tap, generation and the text
  // share one definition of "in progress".
  // Still ONE spawn — seven `--git-path`s in a single rev-parse, generated from the table, so the
  // §3.2 cost row is unchanged (one spawn, never one per state file).
  const IN_PROGRESS_ARGS = Object.freeze(['rev-parse', '--path-format=absolute']
    .concat(...IN_PROGRESS_STATES.map((s) => ['--git-path', s.gitPath])));

  const pathExists = async (p) => {
    try { await fsp.stat(p); return true; } catch (_) { return false; }   // `test -e` semantics
  };

  // null means UNREADABLE, never "nothing in progress" — every caller fails closed on it.
  async function inProgressFor(t) {
    const r = await withSlot(() => spawnGit(t.top, IN_PROGRESS_ARGS.slice(),
      { timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) }));
    if (!r.ok) return null;
    let s = String(r.stdout || '');
    if (s.endsWith('\n')) s = s.slice(0, -1);
    const rows = s.split('\n');                    // strict, like parseTuple: a short answer refuses
    if (rows.length !== IN_PROGRESS_STATES.length || rows.some((x) => !x.startsWith('/'))) return null;
    const present = await Promise.all(rows.map(pathExists));
    const at = (key) => present[IN_PROGRESS_STATES.findIndex((x) => x.key === key)];
    // `git am` and `rebase --apply` SHARE `rebase-apply/` — so the shipped label called an
    // interrupted `am` a rebase. MEASURED: am writes `rebase-apply/applying`, rebase --apply writes
    // `rebase-apply/rebasing`. The directory's absolute path is already in hand, so telling them
    // apart costs one more stat and NO extra spawn. Both still block: the guard asks whether
    // something is in progress, and both are — this only fixes what the state is CALLED.
    const applyDir = rows[IN_PROGRESS_STATES.findIndex((x) => x.key === 'rebaseApply')];
    const am = at('rebaseApply') && await pathExists(path.join(applyDir, 'applying'));
    return {
      merge: at('merge'),
      squash: at('squash'),
      revert: at('revert'),
      cherryPick: at('cherryPick'),
      sequencer: at('sequencer'),
      rebase: at('rebaseMerge') || (at('rebaseApply') && !am),   // unlabelled rebase-apply: a rebase
      am,
    };
  }

  // canWrite is a point-in-time HINT (§6.5), derived through the UNTOUCHED oracle — the bridge
  // injects gitPanel.assertRepo, which re-enumerates freshly on every call. The write route stays
  // the sole authority; a race-time 403 is the client's cue to re-fetch status.
  async function canWriteFor(top) {
    if (!writesEnabled) return false;
    try { await assertRepo(top); return true; } catch (_) { return false; }
  }

  // ---- reads (dir-keyed, pinned) ------------------------------------------------------------

  // The status BODY, over an already-authorized tuple: the porcelain read and the in-progress read,
  // issued together (width-2 limiter, so both proceed) since neither depends on the other. The
  // sync guard consults THIS, not the public `status`, so generation pays no second authorization
  // and no `canWrite` oracle call — and, more importantly, so the tap and the guard cannot end up
  // reading two different states through two different code paths.
  async function statusCore(t) {
    const [r, ip] = await Promise.all([
      withSlot(() => spawnGit(t.top,
        ['status', '--branch', '--porcelain=v1', '-z', '--untracked-files=all'],
        { timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) })),
      inProgressFor(t),
    ]);
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    // An unreadable in-progress state is a FAILED status, not a quiet "nothing in progress" — the
    // p7 detector's `null` collapsed to `false` here, which is the fail-open direction on the one
    // field the sync guard rests on.
    if (!ip) return { error: 'git_failed', detail: 'in-progress state unreadable' };
    const out = r.stdout || '';
    const firstNul = out.indexOf('\0');
    const header = firstNul < 0 ? out : out.slice(0, firstNul);
    const rest = firstNul < 0 ? '' : out.slice(firstNul + 1);
    const files = parseStatusZ(rest);
    return {
      branch: parseBranchHeader(header),
      files,
      counts: {
        staged: files.filter((f) => f.staged).length,
        unstaged: files.filter((f) => f.unstaged).length,
        untracked: files.filter((f) => f.untracked).length,
        unmerged: files.filter((f) => f.unmerged).length,
      },
      inProgress: ip,
    };
  }

  async function status(dir) {
    const t = await authorizeRead(dir);
    const core = await statusCore(t);
    if (core.error) return core;
    return {
      repo: t.top,
      branch: core.branch,
      files: core.files,
      counts: core.counts,
      inProgress: core.inProgress,
      canWrite: await canWriteFor(t.top),
      // Side by side with canWrite ON PURPOSE, because they are the two facts most easily confused
      // and this is where the confusion would show: with GIT_WRITES_ENABLED off, canWrite is false
      // for a workspace repo whose provenance is still `workspace`.
      provenance: t.provenance,
    };
  }

  const SEP = '\x1f';   // git refuses control characters in ref names, so splitting on it is total

  async function branches(dir) {
    const t = await authorizeRead(dir);
    const r = await withSlot(() => spawnGit(t.top, ['for-each-ref', '--sort=-committerdate',
      `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(committerdate:iso8601)${SEP}%(HEAD)`,
      'refs/heads'], { timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) }));
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const rows = (r.stdout || '').split('\n').filter(Boolean);
    const out = await Promise.all(rows.map(async (row) => {
      const [name, upstream, date, head] = row.split(SEP);
      const c = await withSlot(() => spawnGit(t.top,
        ['rev-list', '--count', name, '--not', '--remotes'], { timeoutMs: 8000, env: pinEnv(t) }));
      return {
        name,
        upstream: upstream || null,
        date: date || null,
        current: head === '*',
        unpushed: c.ok ? Number((c.stdout || '0').trim()) : null,
      };
    }));
    return { repo: t.top, branches: out };
  }

  // The one spawn class that addresses a DIFFERENT worktree. The authorized triple would report
  // the wrong worktree (env outranks -C — measured, round 6), so each sibling needs BOTH halves
  // of §3.3's rule: it must be AUTHORIZED itself (the top or the narrow anchor union — rule 5, no
  // jail fallback; else dirty:null and no spawn, no widening even by a count), and its pin is
  // DERIVED from the authorized metadata: its gitdir under <commonDir>/worktrees/, resolved by
  // plain fs reads — never a git discovery in the sibling's path.
  async function siblingGitDirs(t) {
    const map = new Map();
    const base = path.join(t.commonDir, 'worktrees');
    let ids = [];
    try { ids = await fsp.readdir(base); } catch (_) { return map; }   // no linked worktrees
    await Promise.all(ids.map(async (id) => {
      const r = await readGateFile(path.join(base, id, 'gitdir'), GATE_READ_PATH_BYTES);
      if (!r.ok) return;                                   // that sibling stays unresolvable
      let content = r.text;
      if (content.endsWith('\n')) content = content.slice(0, -1);
      // content is "<worktreePath>/.git", and it is a string the BROWSED REPO wrote. It is keyed by
      // its REALPATH, never its lexical spelling: `worktree list --porcelain` reports the same
      // recorded path, so realpathing both sides is what makes the map lookup and the rule-5
      // decision below speak about the directory git will actually read (§3.1 step 3).
      const real = await realOrNull(path.dirname(content));
      if (real) map.set(real, path.join(base, id));
    }));
    return map;
  }

  async function worktrees(dir) {
    const t = await authorizeRead(dir);
    const r = await withSlot(() => spawnGit(t.top, ['worktree', 'list', '--porcelain'],
      { timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) }));
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const { worktrees: list, errors } = parseWorktreePorcelain(r.stdout);
    const sibs = await siblingGitDirs(t);
    const mainPath = await realOrNull(path.dirname(t.commonDir));
    let narrowSet = [];
    try { narrowSet = (await anchors()).filter((a) => a.breadth === 'narrow'); } catch (_) { narrowSet = []; }
    const withState = await Promise.all(list.map(async (w) => {
      if (w.bare) return { ...w, dirty: null };
      // RESOLVED ONCE, HERE — the value rule 5 judges and the value the spawn binds to are the same
      // string (§3.1 step 3). `path.resolve` alone is LEXICAL, and `w.path` is repo-controlled:
      // git's worktree.c takes the recorded `gitdir` file, strips `/.git`, and does NOT realpath it.
      // MEASURED against the pre-fix module: a `gitdir` pointing at <anchor>/lure, where `lure` is a
      // symlink out of the anchor, passed the lexical check and reported `dirty: 9` — 9 files in a
      // directory `authorizeRead` refuses by name, which is §3.3 rule 1's "not even by a count"
      // falsified. siblingAuthorized itself is unchanged and stays pure: its INPUT was the defect.
      const wPath = await realOrNull(path.resolve(w.path));
      if (!wPath) return { ...w, dirty: null };           // unresolvable path: nothing to read
      const gd = (mainPath && wPath === mainPath) ? t.commonDir : sibs.get(wPath);
      if (!gd) return { ...w, dirty: null };              // unresolvable identity: no discovery in its path
      if (!siblingAuthorized(t, wPath, narrowSet)) {     // rule 5: pure, and the union is the boundary
        log({ event: 'refuse', reason: 'sibling_outside_union' });
        return { ...w, dirty: null };
      }
      const s = await withSlot(() => spawnGit(wPath, ['status', '--porcelain'], {
        timeoutMs: 8000,
        env: { GIT_DIR: gd, GIT_COMMON_DIR: t.commonDir, GIT_WORK_TREE: wPath },
      }));
      return { ...w, dirty: s.ok ? (s.stdout || '').split('\n').filter(Boolean).length : null };
    }));
    return { repo: t.top, worktrees: withState, errors };
  }

  async function diff(dir, rel, staged) {
    const t = await authorizeRead(dir);
    const p = validatePathspec(rel);
    // The only rule-3 flags that stay at a call site, because they are SUBCOMMAND flags and not
    // `-c` overrides. BOTH are required: measured, `--no-ext-diff` alone still runs a
    // .gitattributes-selected textconv, and neither alone touches the filter drivers.
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
    if (staged) args.push('--cached');
    args.push('--', p);
    const r = await withSlot(() => spawnGit(t.top, args, { timeoutMs: 15000, env: pinEnv(t) }));
    if (!r.ok) return { error: 'git_failed', detail: r.stderr.slice(0, 300) };
    const full = r.stdout || '';
    const truncated = full.length > DIFF_MAX_BYTES;
    return { repo: t.top, path: p, staged: !!staged, diff: truncated ? full.slice(0, DIFF_MAX_BYTES) : full, truncated, bytes: full.length };
  }

  // ---- generated command text (specs.md §5.4, §6.1) ------------------------------------------
  // The bar's branch label is DISPLAY. `push`/`pull-rebase` re-read HEAD here, pinned to the tuple
  // the gate just authorized, so a repo replaced under the same path is named honestly (§5.4's
  // same-path half — no path comparison can detect it, so nothing rests on detecting it).
  async function derivedBranch(t) {
    const r = await withSlot(() => spawnGit(t.top, ['rev-parse', '--abbrev-ref', 'HEAD'],
      { timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) }));
    // The exit code is read FIRST and the stdout second: measured, an UNBORN repo exits 128 while
    // still printing `HEAD` on stdout, so a stdout-only test would dress it up as detached and
    // generate `push origin -- HEAD`.
    if (!r.ok) throw new GitPanelError('not_on_branch', 409);
    let ref = r.stdout || '';
    if (ref.endsWith('\n')) ref = ref.slice(0, -1);
    if (!ref || ref === 'HEAD') throw new GitPanelError('not_on_branch', 409);
    return validateOperand(ref);        // server-DERIVED is not the same as trusted
  }

  // §6.1's stated defence is that the text a human reviews cannot mean a different verb than its
  // name. For the three ref-taking verbs that is not a property of the STRING — it is a property of
  // the repo, so no validator over the operand alone can establish it. MEASURED on git 2.50.1, with
  // an uncommitted edit in the tree:
  //
  //     git checkout f.txt   ->  `Updated 1 path from the index`, exit 0, THE EDIT IS GONE.
  //
  // So `checkout <path>` is a silent restore-from-index wearing a branch switch's name, and
  // validateOperand admits every path there is — `src/index.js`, `:/fix` and `@{-1}` all survive it.
  // `--` is NOT the fix: after `--` git reads the operand as a PATHSPEC, which is the same outcome.
  // The root cause is ref/path AMBIGUITY, not option parsing, so the operand is RESOLVED
  // server-side, after authorization and pinned to the tuple — the discipline `push` already has.
  //
  // TWO measurements shape the argv, and both contradict the obvious form:
  //   * `rev-parse --verify --quiet -- refs/heads/<b>` exits 1 for a REAL branch: after `--`,
  //     rev-parse reads a PATH. `--end-of-options` is the separator that works (measured: exit 0,
  //     prints the oid). Nothing here can look like an option anyway — validateOperand refuses a
  //     leading `-` and the value is prefixed — so this is belt, not the argument.
  //   * resolving to an oid is NOT enough. `refs/heads/main^{commit}`, `~1`, `^`, `@{0}`, `:f.txt`
  //     and `^{}` ALL resolve, and `git checkout 'main^{commit}'` exits 0 with a DETACHED HEAD —
  //     a different verb than its name, one layer down. `--symbolic-full-name` prints the ref's own
  //     name for a branch and NOTHING for every one of those forms, so requiring the answer to be
  //     exactly `refs/heads/<b>` closes them at no extra spawn.
  //
  // DECLARED NARROWING: this admits LOCAL branches only. `merge origin/main` is refused 400, which
  // is deliberate — `branches()` enumerates `refs/heads` and the bar's buttons are built from that
  // list, so the surface's own vocabulary is local branches. A remote-tracking operand becomes a
  // question for a later story, not a silent detached checkout today.
  async function verifiedBranch(t, raw) {
    const b = validateOperand(raw);
    const full = `refs/heads/${b}`;
    const r = await withSlot(() => spawnGit(t.top,
      ['rev-parse', '--symbolic-full-name', '--verify', '--quiet', '--end-of-options', full],
      { timeoutMs: TUPLE_TIMEOUT_MS, env: pinEnv(t) }));
    let out = String(r.stdout || '');
    if (out.endsWith('\n')) out = out.slice(0, -1);
    if (!r.ok || out !== full) throw new GitPanelError('bad_ref', 400);
    return b;                                   // the operand the CALLER sent, now proven a branch
  }

  // async, and the gate runs BEFORE the template: the printed path is always a freshly-validated
  // in-scope toplevel, and a refusal returns no text at all. gitPanel.command() stays synchronous
  // and untouched, so the §4.1 Promise-serialisation hazard never exists on that surface.
  async function command(verb, dir, params) {
    const t = await authorizeRead(dir);              // FIRST — no verb is answered off-scope
    const tpl = COMMAND_TEMPLATES[verb];
    if (!tpl) throw new GitPanelError('unknown_command', 400);
    const p = params || {};
    let operands;
    switch (verb) {
      case 'push':
      case 'pull-rebase':
        operands = { branch: await derivedBranch(t) };    // client params IGNORED, not merged
        break;
      case 'checkout':
      case 'merge':
      case 'rebase':
        operands = { branch: await verifiedBranch(t, p.branch) };   // PROVEN a branch, not a path
        break;
      case 'worktree-add':
        // The `dir` is a NEW path that must not exist yet, so it cannot be resolved the way a
        // branch is; the `branch` is likewise the name of a branch being CREATED. Both stay on the
        // string rule — stated here so the asymmetry is a decision rather than an omission.
        operands = { dir: validateOperand(p.dir), branch: validateOperand(p.branch) };
        break;
      // Argument SHAPE is a validation surface of its own: measured, `{paths: 'a.txt'}` (a JSON
      // string where an array belongs) threw a bare TypeError out of the template's `.map`, which
      // the bridge maps to 500 `git_failed` — a distinguishable response class produced by nothing
      // but a malformed request. The cap matches the one the p7 relay already applies to a paths
      // array, so an enormous body cannot become an unreadable wall of text either.
      case 'discard':
        operands = { paths: validatePaths(p.paths) };
        break;
      // The free-text slot, guarded by its own rule (validateMessage). It stops falling through to
      // `default` so that the ONE unguarded operand on this surface is no longer unguarded.
      case 'commit':
        operands = { message: validateMessage(p.message) };
        break;
      // The second of the predicate's three times (§6.2). Every check the bar makes at tap time is
      // re-performed here, because the bar is not the only way to reach this route: a direct POST
      // past the UI gets no text. The message check runs FIRST — it is free, and an empty-message
      // POST should not buy a status read.
      case 'sync': {
        if (String(p.message == null ? '' : p.message).trim() === '') {
          throw new GitPanelError('empty_message', 400);
        }
        // Both message rules run BEFORE the status read: neither costs a spawn, and a message that
        // cannot be shipped should not buy one.
        const message = validateMessage(p.message);
        const reasons = syncBlockedReasons(await statusCore(t));
        if (reasons.length) {
          log({ event: 'refuse', reason: 'sync_blocked', clauses: reasons.join('+') });
          throw new GitPanelError('sync_blocked', 409);
        }
        operands = { message };
        break;
      }
      default:
        operands = p;
    }
    // The resolved identity rides WITH the text, so a client can detect an identity change before
    // it interprets anything else (§5.4's one path-identity gate). `provenance` rides the SAME
    // response for the same reason: the marking must describe the text in the operator's hand, and
    // a marking carried on a separate (cacheable, TTL'd) response could describe a different repo
    // than the one this text names. `text` is built from the template alone — provenance is never
    // an argument to it, which is what makes the byte-identity assertion structural (STORY-010).
    return {
      text: tpl(t.top, operands), repo: t.top, name: path.basename(t.top), provenance: t.provenance,
    };
  }

  return {
    authorizeRead, probe, status, branches, worktrees, diff, command,
    _anchors: anchors, _classifyBreadth: classifyBreadth, _log: log,
  };
}

module.exports = {
  createGitRead, classifyBreadth, parseMounts, metadataPaths, parseAlternates, siblingAuthorized,
  assignsAttributeDriver, unboundedAttributeSource, validateOperand, validateMessage, validatePaths,
  syncBlockedReasons, readGateFile,
  PLATFORM_DENY, ANCHOR_TTL_MS, NEUTRALISERS, EMPTY_TREE_SHA1, EMPTY_TREE_SHA256,
  ALTERNATES_MAX_DEPTH, COMMAND_TEMPLATES, MAX_DISCARD_PATHS,
  GATE_READ_MAX_BYTES, GATE_READ_PATH_BYTES, GATE_READ_TIMEOUT_MS, METADATA_UNREADABLE,
  IN_PROGRESS_STATES, IN_PROGRESS_KEYS,
  PROVENANCE_WORKSPACE, PROVENANCE_BROWSED, BROWSED_TEXT_MARK, GENERATED_TEXT_RESIDUE,
};
