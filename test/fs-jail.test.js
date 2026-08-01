'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsBrowse, parseRootsSpec } = require('../fsbrowse');

// Build a temp fixture: <root>/inside.txt, <root>/sub/deep.txt, <root>/link-out -> /etc,
// <root>/link-in -> <root>/sub, and a sibling <outside>/secret.txt that must never be reachable.
async function fixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'p4-jail-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(root, 'inside.txt'), 'hello');
  await fsp.writeFile(path.join(root, 'sub', 'deep.txt'), 'deep');
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'nope');
  await fsp.symlink(outside, path.join(root, 'link-out'));
  await fsp.symlink(path.join(root, 'sub'), path.join(root, 'link-in'));
  // realpath the root too — on macOS /var is a symlink to /private/var, so the fixture path
  // the test passes in differs from what fs.realpath returns. Jail comparisons use realpaths.
  return { base, root: await fsp.realpath(root), outside: await fsp.realpath(outside) };
}

const mk = (root) => createFsBrowse({ rootsSpec: root, workspaceCwds: async () => [] });

test('parseRootsSpec: literal workspace-cwds is dynamic', () => {
  assert.deepStrictEqual(parseRootsSpec('workspace-cwds'), { dynamic: true, fixed: [] });
});

test('parseRootsSpec: mixed spec keeps both', () => {
  const r = parseRootsSpec('workspace-cwds:/Volumes/media');
  assert.strictEqual(r.dynamic, true);
  assert.deepStrictEqual(r.fixed, ['/Volumes/media']);
});

test('parseRootsSpec: empty or garbage falls back to dynamic, never to /', () => {
  assert.deepStrictEqual(parseRootsSpec(''), { dynamic: true, fixed: [] });
  assert.deepStrictEqual(parseRootsSpec('relative/path'), { dynamic: true, fixed: [] });
});

test('jail: a file inside the root resolves', async () => {
  const { root } = await fixture();
  const p = await mk(root)._jail(path.join(root, 'inside.txt'));
  assert.strictEqual(p, path.join(root, 'inside.txt'));
});

test('jail: traversal out of the root is rejected', async () => {
  const { root, outside } = await fixture();
  await assert.rejects(
    () => mk(root)._jail(path.join(root, '..', path.basename(outside), 'secret.txt')),
    (e) => e.code === 'outside_root' && e.status === 403,
  );
});

test('jail: a symlink pointing outside the root is rejected', async () => {
  const { root } = await fixture();
  await assert.rejects(
    () => mk(root)._jail(path.join(root, 'link-out', 'secret.txt')),
    (e) => e.code === 'outside_root',
  );
});

test('jail: a symlink pointing inside the root is allowed', async () => {
  const { root } = await fixture();
  const p = await mk(root)._jail(path.join(root, 'link-in', 'deep.txt'));
  assert.strictEqual(p, path.join(root, 'sub', 'deep.txt'));
});

test('jail: missing, oversized, and NUL-bearing paths are rejected', async () => {
  const { root } = await fixture();
  const fb = mk(root);
  await assert.rejects(() => fb._jail(''), (e) => e.code === 'bad_path');
  await assert.rejects(() => fb._jail('/x'.repeat(3000)), (e) => e.code === 'bad_path');
  await assert.rejects(() => fb._jail(path.join(root, 'a\0b')), (e) => e.code === 'bad_path');
});

test('jail: a nonexistent path inside the root is not_found', async () => {
  const { root } = await fixture();
  await assert.rejects(() => mk(root)._jail(path.join(root, 'nope.txt')), (e) => e.code === 'not_found');
});

test('roots: workspace cwds are deduped by realpath', async () => {
  const { root } = await fixture();
  const fb = createFsBrowse({
    rootsSpec: 'workspace-cwds',
    workspaceCwds: async () => [
      { label: 'a', path: root },
      { label: 'b', path: root },
      { label: 'c', path: path.join(root, 'link-in') },
    ],
  });
  const { roots } = await fb.roots();
  assert.strictEqual(roots.filter((r) => r.kind === 'workspace').length, 2);
});
