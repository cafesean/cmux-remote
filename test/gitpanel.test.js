'use strict';
// Source-control panel. The tests that matter here are the refusals, because the UI's own guards
// are courtesies: every route is reachable directly with the same bearer token.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

const { createGitPanel, GitPanelError, shellQuote, validatePathspec, isInside, COMMAND_TEMPLATES } = require('../gitpanel.js');
const { parseStatusZ, parseBranchHeader } = require('../lib/gitporcelain.js');

// ---- §12.2 quoting: the security one ----------------------------------------------------------

test('shellQuote survives every value git will happily accept in a ref or path', async () => {
  // `git check-ref-format` says a name is WELL-FORMED. It says nothing about what a shell does with
  // it. Each of these is a legal git path; each would be catastrophic interpolated raw.
  const nasty = [
    "$(touch /tmp/pwned)", '`id`', 'a;rm -rf /', "it's", 'two words', 'line\nbreak',
    '--upload-pack=evil', '-rf', '$HOME', 'back\\slash', '*glob*', 'a|b', 'a&b',
  ];
  for (const v of nasty) {
    const quoted = shellQuote(v);
    // Ask a real shell what it parses back out. If quoting is right, it is byte-identical.
    const { stdout } = await exec('/bin/sh', ['-c', `printf %s ${quoted}`]);
    assert.strictEqual(stdout, v, `shell round-trip must be exact for ${JSON.stringify(v)}`);
  }
});

test('generated commands quote every interpolated value', () => {
  const c = COMMAND_TEMPLATES.checkout({ branch: 'a;rm -rf /' });
  assert.ok(!/;\s*rm/.test(c.replace(/'[^']*'/g, '')), 'the payload must be inside quotes, not bare');
  assert.strictEqual(COMMAND_TEMPLATES.commit({ message: "it's fine" }), `git commit -m 'it'\\''s fine'`);
  assert.ok(COMMAND_TEMPLATES.discard({ paths: ['-rf', 'x y'] }).startsWith('git restore -- '),
    'pathspecs are preceded by -- so a file called -rf is a file');
});

// ---- §12.3 path validation ---------------------------------------------------------------------

test('pathspecs are validated, and a DELETED file is still stageable', () => {
  assert.strictEqual(validatePathspec('src/app.js'), 'src/app.js');
  assert.strictEqual(validatePathspec('./src/../src/app.js'), 'src/app.js');
  // The case a realpath jail cannot express: staging a deletion means naming a path that is gone.
  assert.strictEqual(validatePathspec('deleted/file.txt'), 'deleted/file.txt');
  assert.throws(() => validatePathspec('/etc/passwd'), (e) => e.code === 'absolute_path');
  assert.throws(() => validatePathspec('../outside'), (e) => e.code === 'outside_repo');
  assert.throws(() => validatePathspec(''), (e) => e.code === 'empty_path');
});

test('containment compares SEGMENTS, so /a/repo-2 is not inside /a/repo', () => {
  assert.strictEqual(isInside('/a/repo', '/a/repo/src'), true);
  assert.strictEqual(isInside('/a/repo', '/a/repo'), true);
  assert.strictEqual(isInside('/a/repo', '/a/repo-2/src'), false);
});

// ---- porcelain ----------------------------------------------------------------------------------

test('status -z keeps filenames with spaces and quotes intact, and flags unmerged', () => {
  const z = ['A  added file.txt', ' M modified"quote".txt', '?? new one.txt', 'UU conflicted.txt', ''].join('\0');
  const f = parseStatusZ(z);
  assert.strictEqual(f.length, 4);
  assert.strictEqual(f[0].path, 'added file.txt');
  assert.strictEqual(f[1].path, 'modified"quote".txt');
  assert.strictEqual(f[2].untracked, true);
  assert.strictEqual(f[3].unmerged, true, 'UU is unmerged');
  assert.strictEqual(f[3].staged, false, 'an unmerged file is never reported as staged');
});

test('a rename carries both paths', () => {
  const z = ['R  new/name.txt', 'old/name.txt', ''].join('\0');
  const f = parseStatusZ(z);
  assert.strictEqual(f[0].path, 'new/name.txt');
  assert.strictEqual(f[0].from, 'old/name.txt');
});

test('no upstream means ahead/behind are UNKNOWN, not zero', () => {
  const none = parseBranchHeader('## solo-branch');
  assert.strictEqual(none.ahead, null, 'a question that cannot be asked is never answered 0');
  assert.strictEqual(none.behind, null);
  const tracked = parseBranchHeader('## main...origin/main');
  assert.strictEqual(tracked.ahead, 0, 'with an upstream, 0 is a real answer');
  const both = parseBranchHeader('## main...origin/main [ahead 3, behind 2]');
  assert.deepStrictEqual([both.ahead, both.behind], [3, 2]);
  assert.strictEqual(parseBranchHeader('## HEAD (no branch)').detached, true);
});

// ---- refusals against a real repo ----------------------------------------------------------------

let repo, panel;
test('setup: a real scratch repo', async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'p7-git-'));
  const g = (...a) => exec('/usr/bin/git', ['-C', repo, ...a]);
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'user.name', 'T');
  await fsp.writeFile(path.join(repo, 'a.txt'), 'one\n');
  await g('add', '.');
  await g('commit', '-qm', 'first');
  await fsp.writeFile(path.join(repo, 'b.txt'), 'two\n');
  panel = createGitPanel({ workspaceCwds: async () => [{ label: 'scratch', path: repo }], writesEnabled: true });
});

test('a repo we never discovered is refused, however real it is', async () => {
  await assert.rejects(() => panel.status(os.tmpdir()), (e) => e.code === 'unknown_repo' && e.status === 403);
});

test('status reports the real working tree', async () => {
  const s = await panel.status(repo);
  assert.strictEqual(s.branch.branch, 'main');
  assert.strictEqual(s.counts.untracked, 1, 'b.txt is untracked');
  assert.strictEqual(s.inProgress.merge, false);
});

test('stage then unstage round-trips through the real index', async () => {
  await panel.write('stage', repo, ['b.txt']);
  assert.strictEqual((await panel.status(repo)).counts.staged, 1);
  await panel.write('unstage', repo, ['b.txt']);
  assert.strictEqual((await panel.status(repo)).counts.staged, 0);
});

test('writes are refused wholesale when the flag is off', async () => {
  const ro = createGitPanel({ workspaceCwds: async () => [{ label: 's', path: repo }], writesEnabled: false });
  await assert.rejects(() => ro.write('stage', repo, ['b.txt']), (e) => e.code === 'writes_disabled' && e.status === 403);
});

test('the verb set is exactly two, and everything else is refused', async () => {
  for (const v of ['commit', 'push', 'checkout', 'rm', '', 'add']) {
    await assert.rejects(() => panel.write(v, repo, ['b.txt']), (e) => e instanceof GitPanelError,
      `${v} must not be directly invocable`);
  }
});

test('a path escaping the repo is refused at the route, not only in the UI', async () => {
  await assert.rejects(() => panel.write('stage', repo, ['../../etc/passwd']), (e) => e.code === 'outside_repo');
  await assert.rejects(() => panel.write('stage', repo, ['/etc/passwd']), (e) => e.code === 'absolute_path');
});

test('an oversized path list is refused before any work', async () => {
  const many = new Array(500).fill('b.txt');
  await assert.rejects(() => panel.write('stage', repo, many), (e) => e.code === 'too_many_paths');
});

test('branches report unpushed by the ONE definition radar also uses', async () => {
  const b = await panel.branches(repo);
  const main = b.branches.find((x) => x.name === 'main');
  assert.ok(main.current, 'main is checked out');
  assert.strictEqual(main.unpushed, 1, 'one commit exists on no remote');
  assert.strictEqual(main.upstream, null);
});

test('diff is capped and says so', async () => {
  await panel.write('stage', repo, ['b.txt']);
  const d = await panel.diff(repo, 'b.txt', true);
  assert.match(d.diff, /\+two/);
  assert.strictEqual(d.truncated, false);
  await panel.write('unstage', repo, ['b.txt']);
});

test('writes are logged with an outcome and no file contents', async () => {
  const seen = [];
  const p = createGitPanel({ workspaceCwds: async () => [{ label: 's', path: repo }], writesEnabled: true, log: (r) => seen.push(r) });
  await p.write('stage', repo, ['b.txt']);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].verb, 'stage');
  assert.strictEqual(seen[0].paths, 1, 'the COUNT is logged, never the contents');
  assert.strictEqual(seen[0].ok, true);
  await p.write('unstage', repo, ['b.txt']);
});

test('teardown', async () => { if (repo) await fsp.rm(repo, { recursive: true, force: true }); });
