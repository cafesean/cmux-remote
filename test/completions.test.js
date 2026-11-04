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


// ---- built-ins and plugins (p42) -----------------------------------------------------------
// A fake fs so no real disk is read: `files` maps path -> content, a directory is any path prefix.

function fakeFs(files) {
  const calls = { readFile: 0 };
  const names = Object.keys(files);
  return {
    calls,
    readFile: async (p) => {
      calls.readFile++;
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    readdir: async (p) => {
      const pre = p.endsWith('/') ? p : p + '/';
      const kids = new Map();
      for (const n of names) {
        if (!n.startsWith(pre)) continue;
        const rest = n.slice(pre.length).split('/');
        kids.set(rest[0], rest.length > 1);
      }
      if (!kids.size) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...kids].map(([name, dir]) => ({ name, isDirectory: () => dir }));
    },
  };
}

const HOME = '/h';
const pluginFs = (settings, extra = {}, home = HOME) => fakeFs(Object.assign({
  [home + '/.claude/plugins/installed_plugins.json']: JSON.stringify({
    version: 2,
    plugins: {
      'tools@mkt': [{ scope: 'user', installPath: '/p/tools', version: '1' }],
      'off@mkt': [{ scope: 'user', installPath: '/p/off', version: '1' }],
    },
  }),
  [home + '/.claude/settings.json']: JSON.stringify(settings),
  '/p/tools/skills/caveman/SKILL.md': '---\nname: caveman\ndescription: "Ultra-compressed talk"\n---\nbody',
  '/p/tools/skills/folded/SKILL.md': '---\nname: folded\ndescription: >\n  Folded text here\n---\n',
  '/p/tools/skills/long/SKILL.md': '---\ndescription: ' + 'x'.repeat(300) + '\n---\n',
  '/p/tools/commands/ship.md': '---\ndescription: Ship it\n---\n',
  '/p/tools/agents/scout.md': '# no frontmatter',
  '/p/off/skills/hidden/SKILL.md': '---\ndescription: nope\n---\n',
}, extra));

// Each test uses its own homedir: the plugin scan cache is module-level and keyed by it.
const mkPlug = (f, extra = {}) => createCompletions(Object.assign(
  { cwdForSurface: async () => '/cwd', homedir: HOME, readdir: f.readdir, readFile: f.readFile }, extra));
const ask = (c, text) => c.complete({ surface: 's', text, caret: text.length });

test('/ offers Claude Code built-ins tagged builtin, with a desc', async () => {
  const f = pluginFs({ enabledPlugins: {} }, {}, '/builtin-home');
  const r = await ask(mkPlug(f, { homedir: '/builtin-home' }), '/comp');
  const c = r.candidates.find((x) => x.text === 'compact');
  assert.strictEqual(c.kind, 'builtin');
  assert.ok(c.desc);
  const all = (await ask(mkPlug(f, { homedir: '/builtin-home' }), '/')).candidates.map((x) => x.text);
  for (const n of ['clear', 'resume', 'model', 'rename', 'rewind', 'todos', 'terminal-setup', 'add-dir', 'output-style']) {
    assert.ok(all.includes(n), n + ' is a built-in');
  }
});

test('plugin skills, commands and agents are listed as plugin:name, enabled plugins only', async () => {
  const f = pluginFs({ enabledPlugins: { 'tools@mkt': true, 'off@mkt': false } });
  const c = mkPlug(f, { homedir: HOME });
  const r = await ask(c, '/tools:');
  const byText = Object.fromEntries(r.candidates.map((x) => [x.text, x]));
  assert.strictEqual(byText['tools:caveman'].kind, 'skill');
  assert.strictEqual(byText['tools:ship'].kind, 'command');
  assert.strictEqual(byText['tools:scout'].kind, 'agent');
  assert.strictEqual(byText['tools:caveman'].desc, 'Ultra-compressed talk');
  assert.strictEqual(byText['tools:folded'].desc, 'Folded text here');
  assert.strictEqual(byText['tools:long'].desc.length, 100, 'desc is capped at 100 chars');
  assert.ok(!('desc' in byText['tools:scout']), 'no frontmatter, no desc');
  assert.ok(!(await ask(c, '/off:')).candidates.length, 'a disabled plugin is absent');
});

test('a missing enabledPlugins key means every installed plugin is enabled', async () => {
  const f = pluginFs({}, {}, '/all-on');
  const r = await ask(mkPlug(f, { homedir: '/all-on' }), '/hidden');
  assert.deepStrictEqual(r.candidates.map((x) => x.text), ['off:hidden']);
});

test('a prefix on the part after the colon is a prefix match, ranked before substrings', async () => {
  const f = pluginFs({ enabledPlugins: { 'tools@mkt': true } }, {
    '/p/tools/skills/xcave/SKILL.md': '---\ndescription: substring only\n---\n',
  }, '/prefix-home');
  const r = await ask(mkPlug(f, { homedir: '/prefix-home' }), '/cav');
  assert.deepStrictEqual(r.candidates.map((x) => x.text), ['tools:caveman', 'tools:xcave']);
});

test('built-ins sort before plugin entries when equally matched', async () => {
  const f = pluginFs({ enabledPlugins: { 'tools@mkt': true } }, {
    '/p/tools/commands/review-pr.md': '---\ndescription: plugin review\n---\n',
  }, '/order-home');
  const r = await ask(mkPlug(f, { homedir: '/order-home' }), '/rev');
  const names = r.candidates.map((x) => x.text);
  assert.ok(names.indexOf('review') >= 0 && names.indexOf('review') < names.indexOf('tools:review-pr'));
  assert.strictEqual(r.candidates[names.indexOf('review')].kind, 'builtin');
});

test('the plugin scan is cached for 60s, then re-read', async () => {
  const f = pluginFs({ enabledPlugins: { 'tools@mkt': true } }, {}, '/cache-home');
  let t = 1000;
  const c = mkPlug(f, { homedir: '/cache-home', now: () => t });
  await ask(c, '/a');
  const first = f.calls.readFile;
  assert.ok(first > 0);
  t += 59000;
  await ask(c, '/ab');
  assert.strictEqual(f.calls.readFile, first, 'typing cadence must not re-read the plugin files');
  t += 2000;
  await ask(c, '/abc');
  assert.ok(f.calls.readFile > first, 'after the TTL the scan runs again');
});

test('teardown', async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });
