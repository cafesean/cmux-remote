'use strict';
// S2-0b: git diff routes never carry a credential file's content, whatever the pathspec covers.
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { redactDeniedDiff, sectionPaths } = require('../lib/secret-diff');
const { createGitPanel } = require('../gitpanel');

const SECRET = 'sk-ant-THIS-MUST-NOT-LEAK';

async function repo() {
  const h = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2-0b-')));
  const git = (...a) => execFileSync('git', ['-C', h, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  await fsp.mkdir(path.join(h, '.ssh'));
  await fsp.writeFile(path.join(h, '.ssh', 'id_ed25519'), 'old\n');
  await fsp.writeFile(path.join(h, 'app.credentials.json'), '{}\n');
  await fsp.writeFile(path.join(h, 'notes.md'), 'old\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  await fsp.writeFile(path.join(h, '.ssh', 'id_ed25519'), `${SECRET}\n`);
  await fsp.writeFile(path.join(h, 'app.credentials.json'), `{"token":"${SECRET}"}\n`);
  await fsp.writeFile(path.join(h, 'notes.md'), 'new\n');
  git('config', 'diff.noprefix', 'true');   // must not break the parser (call sites force a/ b/)
  return { h, git };
}

test('redactDeniedDiff: credential sections dropped, others kept, home = repo', async () => {
  const { h, git } = await repo();
  const raw = git('diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', '.');
  assert.ok(raw.includes(SECRET));
  const { diff, redacted } = redactDeniedDiff(raw, h, h);
  assert.ok(!diff.includes(SECRET));
  assert.strictEqual(redacted, 2);
  assert.ok(diff.includes('+new'));
});

test('gitpanel diff of "." with diff.noprefix set: no secret, notes kept', async () => {
  const { h } = await repo();
  const gp = createGitPanel({ workspaceCwds: async () => [{ path: h }], homedir: h });
  const r = await gp.diff(h, '.', false);
  assert.ok(!r.error, JSON.stringify(r));
  assert.ok(!r.diff.includes(SECRET));
  assert.strictEqual(r.redacted, 2);
  assert.ok(r.diff.includes('+new'));
  const one = await gp.diff(h, 'app.credentials.json', false);
  assert.ok(!one.diff.includes(SECRET));
});

test('sectionPaths: quoted, spaced, renamed and binary headers', () => {
  assert.deepStrictEqual(sectionPaths(['diff --git a/my dir/x b/my dir/x', '--- a/my dir/x', '+++ b/my dir/x']), ['my dir/x', 'my dir/x', 'my dir/x']);
  assert.ok(sectionPaths(['diff --git "a/t\\tab" "b/t\\tab"']).includes('t\tab'));
  assert.ok(sectionPaths(['diff --git a/x b/.ssh/k', 'rename from x', 'rename to .ssh/k']).includes('.ssh/k'));
  assert.ok(sectionPaths(['diff --git a/k.bin b/k.bin', 'Binary files a/k.bin and b/.ssh/k differ']).includes('.ssh/k'));
});

test('unparseable section header fails closed', () => {
  const { diff, redacted } = redactDeniedDiff('diff --git weird\n+secret', '/r', '/h');
  assert.strictEqual(redacted, 1);
  assert.ok(!diff.includes('+secret'));
});
