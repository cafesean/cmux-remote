'use strict';
// Compose-box completions. Two things are being protected here:
//   1. The walk is bounded — exactly ONE readdir per request. A recursive design would walk
//      node_modules on the machine the operator is using, at typing cadence.
//   2. The jail is real — absolute paths and `..` are REFUSED, not resolved.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

const { createCompletions, tokenAt, splitSegment, CompletionError } = require('../completions.js');

// ---- tokenizer -------------------------------------------------------------------------------

test('the caret word is only a token when it starts with @ or /', () => {
  assert.strictEqual(tokenAt('hello world', 11), null);
  assert.strictEqual(tokenAt('', 0), null);
  assert.deepStrictEqual(tokenAt('see @src/ap', 11).body, 'src/ap');
  assert.strictEqual(tokenAt('see @src/ap', 11).sigil, '@');
});

test('a slash only opens commands at the start of a line, not mid-sentence', () => {
  assert.strictEqual(tokenAt('/rev', 4).sigil, '/', 'at line start it is a command token');
  assert.strictEqual(tokenAt('open /usr/bin', 13), null, 'a path typed mid-sentence is not a command');
  assert.strictEqual(tokenAt('  /rev', 6).sigil, '/', 'leading whitespace still counts as line start');
});

test('the caret position decides the token, not the whole text', () => {
  const t = tokenAt('@alpha @beta', 6);
  assert.strictEqual(t.body, 'alpha', 'completing the first word while the second exists');
  assert.strictEqual(t.end, 6);
});

test('segments split on the last slash', () => {
  assert.deepStrictEqual(splitSegment('src/app/pa'), { dir: 'src/app/', prefix: 'pa' });
  assert.deepStrictEqual(splitSegment('pa'), { dir: '', prefix: 'pa' });
  assert.deepStrictEqual(splitSegment('src/'), { dir: 'src/', prefix: '' });
});

// ---- file completion against a real temp tree --------------------------------------------------

let root;
test('setup: a temp workspace', async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'p7-comp-'));
  await fsp.mkdir(path.join(root, 'src', 'app'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'apple.txt'), 'x');
  await fsp.writeFile(path.join(root, 'src', 'apricot.txt'), 'x');
  await fsp.writeFile(path.join(root, 'src', 'banana.txt'), 'x');
});

const mk = (extra = {}) => createCompletions(Object.assign({ cwdForSurface: async () => root }, extra));

test('@ completes one directory deep, prefix-filtered', async () => {
  const r = await mk().complete({ surface: 's', text: '@src/ap', caret: 7 });
  const names = r.candidates.map((c) => c.text);
  assert.deepStrictEqual(names, ['src/app/', 'src/apple.txt', 'src/apricot.txt']);
  assert.strictEqual(r.candidates[0].kind, 'dir');
  assert.strictEqual(r.candidates[1].kind, 'file');
});

test('exactly ONE readdir per request — the bound that makes this usable', async () => {
  let calls = 0;
  const spy = mk({ readdir: async (p, o) => { calls++; return fsp.readdir(p, o); } });
  await spy.complete({ surface: 's', text: '@src/ap', caret: 7 });
  assert.strictEqual(calls, 1, 'a recursive walk would show up here as many calls');
});

test('node_modules never appears as a candidate', async () => {
  const r = await mk().complete({ surface: 's', text: '@', caret: 1 });
  assert.ok(!r.candidates.some((c) => c.text.startsWith('node_modules')));
});

test('absolute paths and .. escapes are REFUSED, not resolved', async () => {
  await assert.rejects(() => mk().complete({ surface: 's', text: '@/etc/pas', caret: 9 }),
    (e) => e instanceof CompletionError && e.code === 'absolute_path');
  await assert.rejects(() => mk().complete({ surface: 's', text: '@../../etc/', caret: 11 }),
    (e) => e instanceof CompletionError && e.code === 'outside_root');
});

test('a caret outside any token yields null rather than a guess', async () => {
  assert.strictEqual(await mk().complete({ surface: 's', text: 'just prose', caret: 10 }), null);
});

test('a surface with no resolvable cwd is an error, not an empty list', async () => {
  const c = createCompletions({ cwdForSurface: async () => null });
  await assert.rejects(() => c.complete({ surface: 'x', text: '@a', caret: 2 }),
    (e) => e.code === 'no_cwd');
});

test('results are capped and the truncation is reported, never implied complete', async () => {
  const many = path.join(root, 'many');
  await fsp.mkdir(many, { recursive: true });
  for (let i = 0; i < 80; i++) await fsp.writeFile(path.join(many, `f${String(i).padStart(3, '0')}.txt`), 'x');
  const r = await mk().complete({ surface: 's', text: '@many/f', caret: 7 });
  assert.strictEqual(r.candidates.length, 60);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.total, 80);
});

// ---- command completion --------------------------------------------------------------------

test('/ completes skills, commands and agents, tagged by kind', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'p7-home-'));
  await fsp.mkdir(path.join(home, '.claude', 'commands'), { recursive: true });
  await fsp.mkdir(path.join(home, '.claude', 'skills', 'brainstorming'), { recursive: true });
  await fsp.mkdir(path.join(home, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(home, '.claude', 'commands', 'review.md'), '#');
  await fsp.writeFile(path.join(home, '.claude', 'agents', 'code-reviewer.md'), '#');

  const c = createCompletions({ cwdForSurface: async () => root, homedir: home });
  const r = await c.complete({ surface: 's', text: '/re', caret: 3 });
  const byKind = Object.fromEntries(r.candidates.map((x) => [x.text, x.kind]));
  assert.strictEqual(byKind['review'], 'command');
  assert.strictEqual(byKind['code-reviewer'], 'agent', 'substring matches rank after prefix matches but still appear');
  assert.ok(!('brainstorming' in byKind), 'a skill that matches neither prefix nor substring is absent');
});

test('teardown', async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });
