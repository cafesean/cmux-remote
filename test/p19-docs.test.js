'use strict';
// p19 STORY-005 — the self-hoster docs for UNIX-socket mode, the test:sockets script, and the
// identifier scan of every file p19 added or changed (specs.md §2.2 principle 4, §15.2).
//
// This is a public repo: nothing p19 touched may carry the owner's domain, private IPs or the shared
// Mac's user names. The forbidden words are assembled at runtime so this file does not trip its own
// scan. Pure file reads, plus git (skipped outside a git checkout that has the p19 base commit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const BASE = '555e260';
const git = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
const haveBase = () => git(['rev-parse', '--verify', `${BASE}^{commit}`]).status === 0;

// Every file p19 added or changed in this repo.
const P19_FILES = [
  'bridge.js', 'server.js', 'lib/unix-listen.js', 'lib/unix-fetch.js',
  'README.md', '.env.example', 'package.json',
  'test/helpers/bridge-child.js', 'test/helpers/server-boot.js', 'test/helpers/unix-call.js',
  'test/unix-listen.test.js', 'test/unix-fetch.test.js', 'test/p19-bridge-socket.test.js',
  'test/p19-server-socket.test.js', 'test/p19-transport-contract.test.js', 'test/p19-docs.test.js',
  'test/p19-socket-smoke.mjs',
];

// The README section: from its heading to the next heading of the same or a higher level.
function section(md, heading) {
  const at = md.indexOf(heading);
  if (at < 0) return null;
  const level = heading.match(/^#+/)[0].length;
  const rest = md.slice(at + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

test('README: a "Listening on UNIX sockets (shared Macs)" section right after "Headless backend (tmux)"', () => {
  const md = read('README.md');
  const h = '### Listening on UNIX sockets (shared Macs)';
  const tmuxAt = md.indexOf('### Headless backend (tmux)');
  const at = md.indexOf(h);
  assert.ok(tmuxAt > 0 && at > tmuxAt, 'the section follows the tmux section');
  assert.ok(!/\n#{2,3} /.test(md.slice(md.indexOf('\n', tmuxAt), at)), 'nothing else sits between them');
  const s = section(md, h);
  for (const needle of ['BRIDGE_SOCKET', 'SERVER_SOCKET', 'unix:', 'CMUX_MACHINE_URL=unix:', '103 bytes', 'service: unix:',
    'chmod 700', 'removed stale', 'socket_in_use', 'refusing to start', 'ingress validate']) {
    assert.ok(s.includes(needle), `the section names ${needle}`);
  }
  assert.match(s, /Radar stays TCP-only/);
  assert.match(s, /radar: NOT started/);
  assert.match(s, /opt-in/i, 'says TCP stays the default');
});

test('README: BRIDGE_SOCKET and SERVER_SOCKET rows in "Other environment variables"; a shared-Mac security note', () => {
  const md = read('README.md');
  const env = section(md, '### Other environment variables');
  assert.ok(env, 'the env table section exists');
  assert.match(env, /^\| `BRIDGE_SOCKET` \| unset \| .*BRIDGE_PORT/m);
  assert.match(env, /^\| `SERVER_SOCKET` \| unset \| .*PORT/m);
  const sec = section(md, '## Security notes');
  assert.match(sec, /^- \*\*On a Mac shared by several users, use UNIX sockets\.\*\*/m);
  assert.ok(sec.includes('SERVER_SOCKET') && sec.includes('BRIDGE_SOCKET'));
});

test('.env.example: BRIDGE_SOCKET, SERVER_SOCKET and a unix: CMUX_MACHINE_URL example, all commented out', () => {
  const lines = read('.env.example').split('\n');
  for (const re of [/^# BRIDGE_SOCKET=\/\S+\.sock$/, /^# SERVER_SOCKET=\/\S+\.sock$/, /^# CMUX_MACHINE_URL=unix:\/\S+\.sock$/]) {
    assert.ok(lines.some((l) => re.test(l)), `a commented line matching ${re}`);
  }
  for (const l of lines) {
    assert.ok(!/^\s*(BRIDGE_SOCKET|SERVER_SOCKET)=/.test(l), `not set by default: ${l}`);
    assert.ok(!/^\s*CMUX_MACHINE_URL=unix:/.test(l), `not set by default: ${l}`);
  }
});

test('package.json: test:sockets exactly as specified, and nothing else changed', (t) => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:sockets'], 'node --test test/unix-*.test.js test/p19-*.test.js');
  if (!haveBase()) return t.skip('not a git checkout with the p19 base commit');
  const base = JSON.parse(git(['show', `${BASE}:package.json`]).stdout);
  const now = JSON.parse(JSON.stringify(pkg));
  delete now.scripts['test:sockets'];
  assert.deepEqual(now, base, 'package.json differs from the base only by test:sockets');
});

test('identifier scan: no owner domain, private IPs or shared-Mac user names in any p19 file', () => {
  const forbidden = [
    new RegExp('jet' + 'devs', 'i'),
    new RegExp('\\b172\\.16\\.'),
    new RegExp('\\bcmux-(' + ['r' + 'ay', 'stan' + 'ley', 'clau' + 'de'].join('|') + ')\\b', 'i'),
    new RegExp('\\b(' + ['r' + 'ay', 'stan' + 'ley'].join('|') + ')\\b', 'i'),
  ];
  const hits = [];
  for (const f of P19_FILES) {
    const src = read(f);
    for (const re of forbidden) {
      const m = src.match(re);
      if (m) hits.push(`${f}: ${re} -> ${JSON.stringify(m[0])}`);
    }
    // IPv4 literals: loopback, any-address and the documentation range (192.0.2.x) only
    for (const m of src.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
      const ip = m[0];
      if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip.startsWith('192.0.2.')) continue;
      hits.push(`${f}: IPv4 literal ${ip}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('identifier scan covers every file the p19 commits touched', (t) => {
  if (!haveBase()) return t.skip('not a git checkout with the p19 base commit');
  const r = git(['log', '--format=', '--name-only', '--grep=^p19 ', `${BASE}..HEAD`]);
  assert.equal(r.status, 0, r.stderr);
  const touched = [...new Set(r.stdout.split('\n').filter(Boolean))];
  const unscanned = touched.filter((f) => !P19_FILES.includes(f));
  assert.deepEqual(unscanned, [], 'a file changed by p19 is missing from P19_FILES');
  for (const f of P19_FILES) assert.ok(fs.existsSync(path.join(REPO, f)), `${f} exists`);
});
