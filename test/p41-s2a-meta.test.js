'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib', 'accounts-meta.js');
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's2a-meta-'));
  return { d, file: path.join(d, 'sub', 'accounts.json') };
}
function load(file) {
  process.env.HYPERMUX_ACCOUNTS_FILE = file;
  delete require.cache[require.resolve(LIB)];
  return require(LIB);
}
function cli(file, ...args) {
  return spawnSync('node', [LIB, ...args], { env: { ...process.env, HYPERMUX_ACCOUNTS_FILE: file }, encoding: 'utf8' });
}

test('missing and corrupt file read as {}', () => {
  const { file } = tmp();
  const m = load(file);
  assert.deepStrictEqual(m.read(), {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(m.read(), {});
  assert.deepStrictEqual(m.names(), []);
});

test('set merges, file 0600, dir 0700, no temp or lock left', () => {
  const { file } = tmp();
  const m = load(file);
  m.set('acme', { fp: 'abcdef012345', addedAt: '2026-01-01T00:00:00.000Z' });
  m.set('acme', { fp: '0123456789ab' });
  assert.deepStrictEqual(m.read().acme, { addedAt: '2026-01-01T00:00:00.000Z', fp: '0123456789ab' });
  assert.strictEqual(m.getFp('acme'), '0123456789ab');
  assert.strictEqual(m.getFp('nope'), undefined);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['accounts.json']);
});

test('set defaults addedAt; remove deletes', () => {
  const { file } = tmp();
  const m = load(file);
  m.set('acme', { fp: 'abcdef012345' });
  assert.match(m.read().acme.addedAt, /^\d{4}-\d\d-\d\dT/);
  m.remove('acme');
  assert.deepStrictEqual(m.names(), []);
});

test('stale lock (>10s) is broken; fresh lock yields exit 75', () => {
  const { file } = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  fs.mkdirSync(lock);
  let r = cli(file, 'set', 'acme', '--fp', 'abcdef012345');
  assert.strictEqual(r.status, 75);
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lock, old, old);
  r = cli(file, 'set', 'acme', '--fp', 'abcdef012345');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.existsSync(lock), false);
});

test('CLI get-fp / set / remove and validation', () => {
  const { file } = tmp();
  let r = cli(file, 'get-fp', 'acme');
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '');
  r = cli(file, 'set', 'acme', '--fp', 'abcdef012345', '--added', '2026-02-02T00:00:00.000Z');
  assert.strictEqual(r.status, 0, r.stderr);
  r = cli(file, 'get-fp', 'acme');
  assert.strictEqual(r.stdout.trim(), 'abcdef012345');
  assert.strictEqual(cli(file, 'set', 'Bad!', '--fp', 'abcdef012345').status, 2);
  assert.strictEqual(cli(file, 'set', 'a', '--fp', 'abcdef012345').status, 2); // 'a' reserved
  assert.strictEqual(cli(file, 'set', 'acme', '--fp', 'XYZ').status, 2);
  assert.strictEqual(cli(file, 'set', 'acme', '--added', 'notadate').status, 2);
  assert.strictEqual(cli(file, 'get-fp', 'toolongname').status, 2);
  assert.strictEqual(cli(file, 'bogus').status, 2);
  assert.ok(cli(file, 'set', 'Bad!').stderr.length > 0);
  r = cli(file, 'remove', 'acme');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(cli(file, 'get-fp', 'acme').stdout, '');
});
