'use strict';
// S2-0: credential paths are never listed, read, downloaded or completed, even inside a workspace
// root at ~ and even through a symlink; secrets compare in constant time.
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { isDeniedPath } = require('../lib/secret-paths');
const { safeEqual } = require('../lib/safe-equal');
const { createFsBrowse } = require('../fsbrowse');
const { createCompletions } = require('../completions');

// A fake home that is also the workspace root (the case that exposed the files before S2-0).
async function home() {
  const h = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2-0-home-')));
  const put = async (rel, body = 'secret') => {
    await fsp.mkdir(path.dirname(path.join(h, rel)), { recursive: true });
    await fsp.writeFile(path.join(h, rel), body);
  };
  await put('.claude-swap-backup/sessions/3-a-example-com/.credentials.json');
  await put('.claude-swap-backup/sequence.json');
  await put('.claude/.credentials.json');
  await put('.claude/settings.json', '{}');
  await put('.claude.json');
  await put('.claude.json.backup');
  await put('.ssh/id_ed25519');
  await put('.appstoreconnect/key.p8');
  await put('Library/Keychains/login.keychain-db');
  await put('.config/gh/hosts.yml', 'ok');
  await put('.config/foo/token.json');
  await put('.config/tokens/a.txt');
  await put('project/app.credentials.json');
  await put('project/readme.md', 'hi');
  // symlink escapes: an innocent name that points at a secret
  await fsp.symlink(path.join(h, '.ssh'), path.join(h, 'project', 'keys'));
  await fsp.symlink(path.join(h, '.claude', '.credentials.json'), path.join(h, 'project', 'creds.txt'));
  return h;
}

const DENIED = [
  '.claude-swap-backup', '.claude-swap-backup/sequence.json', '.claude-swap-backup/sessions/3-a-example-com/.credentials.json',
  '.claude/.credentials.json', '.claude.json', '.claude.json.backup', '.ssh', '.ssh/id_ed25519',
  '.appstoreconnect/key.p8', 'Library/Keychains/login.keychain-db', '.config/foo/token.json', '.config/tokens/a.txt',
  'project/app.credentials.json', '.config/gh/hosts.yml',
];
const ALLOWED = ['.claude', '.claude/settings.json', '.config', '.config/gh', 'project', 'project/readme.md', 'Library'];

test('isDeniedPath: every credential path denied, neighbours allowed', async () => {
  const h = await home();
  for (const rel of DENIED) assert.strictEqual(isDeniedPath(path.join(h, rel), h), true, rel);
  for (const rel of ALLOWED) assert.strictEqual(isDeniedPath(path.join(h, rel), h), false, rel);
  assert.strictEqual(isDeniedPath('', h), true);
});

test('isDeniedPath: macOS firmlink long form (/System/Volumes/Data/...) is denied too', () => {
  const h = '/Users/someone';
  for (const rel of ['.ssh/id_ed25519', '.claude.json', '.claude-swap-backup/sequence.json']) {
    assert.strictEqual(isDeniedPath(`/System/Volumes/Data${h}/${rel}`, h), true, rel);
    assert.strictEqual(isDeniedPath(`/System/Volumes/Data${h}/${rel}`, `/System/Volumes/Data${h}`), true, `long home ${rel}`);
  }
  assert.strictEqual(isDeniedPath(`/System/Volumes/Data${h}/project/readme.md`, h), false);
});

test('completions @: a symlink entry pointing at a credential path is not offered', async () => {
  const h = await home();
  await fsp.symlink(path.join(h, '.ssh', 'id_ed25519'), path.join(h, 'project', 'plink'));
  const c = createCompletions({ cwdForSurface: async () => h, homedir: h });
  const r = await c.complete({ surface: 's', text: '@project/p', caret: 10 });
  assert.ok(!r.candidates.some((i) => i.text === 'project/plink'));
});

test('fsbrowse: read/download/list refuse credential paths with 403 denied, incl. symlink escapes', async () => {
  const h = await home();
  const fb = createFsBrowse({ rootsSpec: h, workspaceCwds: async () => [], homedir: h });
  for (const rel of ['.claude/.credentials.json', '.claude.json', '.ssh/id_ed25519', '.claude-swap-backup/sessions/3-a-example-com/.credentials.json',
    'project/creds.txt', 'project/keys/id_ed25519', 'project/app.credentials.json']) {
    await assert.rejects(fb.read(path.join(h, rel)), (e) => e.code === 'denied' && e.status === 403, `read ${rel}`);
    await assert.rejects(fb.download(path.join(h, rel)), (e) => e.code === 'denied', `download ${rel}`);
  }
  await assert.rejects(fb.list(path.join(h, '.ssh'), 0, 50), (e) => e.code === 'denied');
  await assert.rejects(fb.list(path.join(h, 'project', 'keys'), 0, 50), (e) => e.code === 'denied');
  const names = (await fb.list(h, 0, 500)).entries.map((e) => e.name);
  for (const n of ['.ssh', '.claude-swap-backup', '.claude.json', '.claude.json.backup', '.appstoreconnect']) assert.ok(!names.includes(n), n);
  for (const n of ['.claude', '.config', 'project', 'Library']) assert.ok(names.includes(n), n);
  const proj = (await fb.list(path.join(h, 'project'), 0, 50)).entries.map((e) => e.name);
  assert.ok(!proj.includes('app.credentials.json'));
  assert.ok(proj.includes('readme.md'));
  await fb.read(path.join(h, 'project', 'readme.md'));   // a normal file still reads
});

test('completions @: no credential names, nothing inside denied dirs (also via symlink)', async () => {
  const h = await home();
  const c = createCompletions({ cwdForSurface: async () => h, homedir: h });
  const texts = async (text) => (await c.complete({ surface: 's', text, caret: text.length })).candidates.map((i) => i.text);
  const top = await texts('@');
  for (const n of ['.ssh/', '.claude-swap-backup/', '.claude.json', '.appstoreconnect/']) assert.ok(!top.includes(n), n);
  assert.ok(top.includes('project/'));
  assert.deepStrictEqual(await texts('@.ssh/'), []);
  assert.deepStrictEqual(await texts('@project/keys/'), []);
  const proj = await texts('@project/');
  assert.ok(!proj.includes('project/app.credentials.json'));
  assert.ok(proj.includes('project/readme.md'));
  const claude = await texts('@.claude/');
  assert.ok(!claude.includes('.claude/.credentials.json'));
  assert.ok(claude.includes('.claude/settings.json'));
});

test('safeEqual: constant-time compare semantics', () => {
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual('abc', 'abcd'), false);
  assert.strictEqual(safeEqual('', ''), false);
  assert.strictEqual(safeEqual(undefined, 'abc'), false);
  assert.strictEqual(safeEqual(['abc'], 'abc'), false);
});
