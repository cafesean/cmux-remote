'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { normalizeConfig, loadConfig, CONFIG_VERSION } = require('../radar/config');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'radar-config-'));

test('defaults fill in every absent key (additive migrations take defaults)', () => {
  const { config, issues } = normalizeConfig({ configVersion: 1, repos: [{ id: 'a', path: '/abs/a' }] });
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(config.role, 'leader');
  assert.strictEqual(config.scanIntervalMin, 10);
  assert.strictEqual(config.sessionSweepSec, 60);
  assert.deepStrictEqual(config.timeouts, { gitFetchSec: 20, bridgeMs: 8000, deployMs: 10000 });
  assert.deepStrictEqual(config.repos[0].defaultBranches, ['develop', 'main']);
});

test('an absent configVersion is treated as v1; an UNKNOWN one is a config error with zero repos', () => {
  assert.deepStrictEqual(normalizeConfig({ repos: [{ id: 'a', path: '/abs/a' }] }).issues, []);
  const { config, issues } = normalizeConfig({ configVersion: 99, repos: [{ id: 'a', path: '/abs/a' }] });
  assert.strictEqual(config.repos.length, 0, 'facts derived from a schema we cannot read are false green');
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0], /unknown configVersion 99/);
  assert.match(issues[0], new RegExp(`understands ${CONFIG_VERSION}`));
});

test('malformed repo entries are skipped BY NAME and the good ones still scan', () => {
  const { config, issues } = normalizeConfig({
    configVersion: 1,
    repos: [
      { id: 'good', path: '/abs/good' },
      { id: '', path: '/abs/x' },
      { id: 'norel', path: 'relative/path' },
      { id: 'nopath' },
      'not-an-object',
      { id: 'good', path: '/abs/dupe' },
      { id: 'emptybranches', path: '/abs/e', defaultBranches: [] },
      { id: 'badbranches', path: '/abs/b', defaultBranches: 'develop' },
    ],
  });
  assert.deepStrictEqual(config.repos.map((r) => r.id), ['good']);
  assert.strictEqual(issues.length, 7);
  assert.ok(issues.some((i) => /repos\[2\] \(norel\): path is not absolute/.test(i)));
  assert.ok(issues.some((i) => /repos\[5\] \(good\): duplicate id/.test(i)));
  assert.ok(issues.some((i) => /repos\[4\]: not an object/.test(i)));
});

test('cadences and timeouts are clamped rather than trusted', () => {
  const { config } = normalizeConfig({ configVersion: 1, scanIntervalMin: 0, sessionSweepSec: 1, timeouts: { gitFetchSec: 99999 }, repos: [] });
  assert.strictEqual(config.scanIntervalMin, 1);
  assert.strictEqual(config.sessionSweepSec, 5);
  assert.strictEqual(config.timeouts.gitFetchSec, 300);
});

test('role must be leader|viewer; a viewer without a leaderBaseUrl is called out', () => {
  assert.strictEqual(normalizeConfig({ configVersion: 1, role: 'boss', repos: [] }).config.role, 'leader');
  assert.ok(normalizeConfig({ configVersion: 1, role: 'boss', repos: [] }).issues.some((i) => /not leader\|viewer/.test(i)));
  assert.ok(normalizeConfig({ configVersion: 1, role: 'viewer', repos: [] }).issues.some((i) => /leaderBaseUrl is unset/.test(i)));
});

test('a garbage config root degrades to defaults instead of throwing', () => {
  for (const bad of [null, 42, 'text', []]) {
    const { config, issues } = normalizeConfig(bad);
    assert.deepStrictEqual(config.repos, []);
    assert.ok(issues.length >= 1);
  }
});

test('loadConfig: a missing file is an error SOURCE, not a crash', async () => {
  const dir = await tmp();
  const { config, source } = await loadConfig(path.join(dir, 'config.json'), Date.parse('2026-07-30T00:00:00Z'));
  assert.deepStrictEqual(config.repos, []);
  assert.strictEqual(source.status, 'error');
  assert.match(source.error, /config missing/);
  assert.strictEqual(source.observedAt, '2026-07-30T00:00:00.000Z');
});

test('loadConfig: unparseable JSON is an error source with fresh metadata', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'config.json');
  await fsp.writeFile(f, '{"configVersion": 1,');
  const { source } = await loadConfig(f, Date.now());
  assert.strictEqual(source.status, 'error');
  assert.match(source.error, /parse config\.json/);
  assert.ok(source.observedAt);
});

test('loadConfig: a clean config reports ok with no error key', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'config.json');
  await fsp.writeFile(f, JSON.stringify({ configVersion: 1, repos: [{ id: 'a', path: '/abs/a' }] }));
  const { source, config } = await loadConfig(f, Date.now());
  assert.strictEqual(source.status, 'ok');
  assert.strictEqual(source.error, undefined);
  assert.strictEqual(config.repos.length, 1);
});

test('the committed example config carries tokenRef NAMES and no secret values', async () => {
  const example = JSON.parse(await fsp.readFile(path.join(__dirname, '..', 'radar', 'config.example.json'), 'utf8'));
  const text = JSON.stringify(example);
  assert.strictEqual(example.leaderTokenRef, null);
  assert.strictEqual(example.repos[0].deploy.dev.tokenRef, 'VERCEL_TOKEN_EXAMPLE');
  // A tokenRef names an env var. Anything that looks like an actual credential must never appear.
  assert.ok(!/[A-Za-z0-9_-]{32,}/.test(text), 'no credential-shaped strings in the committed example');
  assert.ok(!/(token|secret|password|apiKey)"\s*:\s*"[^"]+"/i.test(text));
  // and it must normalize cleanly
  const { issues } = normalizeConfig(example);
  assert.deepStrictEqual(issues, []);
});
