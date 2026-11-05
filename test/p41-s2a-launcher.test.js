'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LAUNCH = path.join(ROOT, 'bin', 'hypermux-claude');
const OVR = path.join(ROOT, 'lib', 'settings-override.js');
const TOKEN = 'sk-ant-oat01-testXXXXXXXXXXXXYYYYYYYYYYYYXXXXXXXXXXXXYYYY';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function rig({ token = TOKEN, locked = false, hang = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's2a-l-'));
  const home = path.join(d, 'home'); const cwd = path.join(d, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  const sec = path.join(d, 'security');
  fs.writeFileSync(sec, `#!/bin/bash
case "$1" in
  show-keychain-info) ${hang ? 'sleep 5; exit 0' : locked ? 'exit 36' : 'exit 0'} ;;
  find-generic-password) [ "$*" = "find-generic-password -a tester -s cos-claude-account-acme -w" ] || exit 44
    ${token === null ? 'exit 44' : `printf '%s\\n' '${token}'`} ;;
esac
`, { mode: 0o755 });
  const claude = path.join(d, 'claude');
  fs.writeFileSync(claude, `#!/usr/bin/env node
const c=require('crypto');const t=process.env.CLAUDE_CODE_OAUTH_TOKEN;
console.log(JSON.stringify({hasToken:!!t,tokenSha:t?c.createHash('sha256').update(t).digest('hex'):null,
scrub:process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,acct:process.env.COS_CLAUDE_ACCOUNT_ID,
leaked:Object.keys(process.env).filter(k=>/^(CLAUDE_FOO|ANTHROPIC_|AI_AGENT|GHOSTTY)/i.test(k)),
cmuxPid:process.env.CMUX_CLAUDE_PID||null,argv:process.argv.slice(2)}));
`, { mode: 0o755 });
  const accounts = path.join(d, 'cfg', 'accounts.json');
  const env = {
    PATH: process.env.PATH, HOME: home, USER: 'tester', TMPDIR: d,
    HYPERMUX_SECURITY_BIN: sec, HYPERMUX_CLAUDE_BIN: claude, HYPERMUX_ACCOUNTS_FILE: accounts,
    HYPERMUX_MANAGED_SETTINGS: path.join(d, 'managed.json'),
    CLAUDE_FOO: 'x', ANTHROPIC_API_KEY: 'sk-ant-api03-fakeXXXXYYYY', AI_AGENT: '1', GHOSTTY_X: '1',
  };
  return { d, home, cwd, accounts, env, managed: env.HYPERMUX_MANAGED_SETTINGS };
}
function run(r, args, extraEnv = {}) {
  return spawnSync('bash', [LAUNCH, ...args], { cwd: r.cwd, env: { ...r.env, ...extraEnv }, encoding: 'utf8' });
}
const noToken = (res) => {
  assert.ok(!(res.stdout + res.stderr).includes(TOKEN), 'token leaked to output');
};

test('happy path: token exported, scrub, acct id, inherited stripped, args passed', () => {
  const r = rig();
  const res = run(r, ['acme', '--', '-p', 'hi']);
  assert.strictEqual(res.status, 0, res.stderr);
  noToken(res);
  const o = JSON.parse(res.stdout);
  assert.strictEqual(o.hasToken, true);
  assert.strictEqual(o.tokenSha, sha(TOKEN));
  assert.strictEqual(o.scrub, '1');
  assert.strictEqual(o.acct, 'acme');
  assert.deepStrictEqual(o.leaked, []);
  assert.deepStrictEqual(o.argv, ['-p', 'hi']);
});

test('first launch records fp; same fp relaunch ok', () => {
  const r = rig();
  assert.strictEqual(run(r, ['acme']).status, 0);
  const meta = JSON.parse(fs.readFileSync(r.accounts, 'utf8'));
  assert.strictEqual(meta.acme.fp, sha(TOKEN).slice(0, 12));
  assert.strictEqual(run(r, ['acme']).status, 0);
});

test('fp mismatch -> exit 3, claude not run', () => {
  const r = rig();
  fs.mkdirSync(path.dirname(r.accounts), { recursive: true });
  fs.writeFileSync(r.accounts, JSON.stringify({ acme: { addedAt: '2026-01-01T00:00:00.000Z', fp: '000000000000' } }));
  const res = run(r, ['acme']);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr + res.stdout, /acme changed on this Mac/);
  assert.strictEqual(res.stdout.includes('hasToken'), false);
  noToken(res);
});

test('missing item -> exit 2', () => {
  const r = rig({ token: null });
  const res = run(r, ['acme']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr + res.stdout, /no account acme on this Mac/);
});

test('locked keychain -> exit 2', () => {
  const r = rig({ locked: true });
  const res = run(r, ['acme']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr + res.stdout, /Keychain is locked/);
});

test('bad name -> exit 2', () => {
  const r = rig();
  for (const n of ['Acme', '1ab', 'toolongname', 'a-b', '']) {
    const res = run(r, [n]);
    assert.strictEqual(res.status, 2, n);
    assert.match(res.stderr + res.stdout, /bad account name/);
  }
});

test('account a: no token var, scrub=1, no keychain call', () => {
  const r = rig({ token: null, locked: true });
  const res = run(r, ['a']);
  assert.strictEqual(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout);
  assert.strictEqual(o.hasToken, false);
  assert.strictEqual(o.scrub, '1');
  assert.deepStrictEqual(o.leaked, []);
});

const FILES = [
  ['managed', (r) => r.managed],
  ['home', (r) => path.join(r.home, '.claude', 'settings.json')],
  ['cwd', (r) => path.join(r.cwd, '.claude', 'settings.json')],
  ['local', (r) => path.join(r.cwd, '.claude', 'settings.local.json')],
];
const KEYS = [
  ['apiKeyHelper', { apiKeyHelper: '/bin/helper-secret-VALUE' }, 'apiKeyHelper'],
  ['env.ANTHROPIC_API_KEY', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-VALUEXXXX' } }, 'env.ANTHROPIC_API_KEY'],
  ['env.ANTHROPIC_AUTH_TOKEN', { env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-VALUEXXXX' } }, 'env.ANTHROPIC_AUTH_TOKEN'],
];
for (const [fname, pick] of FILES) {
  for (const [kname, body, key] of KEYS) {
    test(`override ${fname} / ${kname} -> exit 4, names file+key, no value`, () => {
      const r = rig();
      const f = pick(r);
      fs.writeFileSync(f, JSON.stringify(body));
      const res = run(r, ['acme']);
      assert.strictEqual(res.status, 4, res.stderr);
      const out = res.stdout + res.stderr;
      assert.ok(out.includes(f), 'names file');
      assert.ok(out.includes(key), 'names key');
      assert.ok(!/VALUE/.test(out), 'value printed');
      assert.strictEqual(res.stdout.includes('hasToken'), false);
      noToken(res);
      // library + CLI agree
      const cli = spawnSync('node', [OVR, '--cwd', r.cwd], { env: r.env, encoding: 'utf8' });
      assert.strictEqual(cli.status, 4);
      assert.strictEqual(cli.stdout.trim(), `${f}\t${key}`);
    });
  }
}

test('settings-override: none/unparseable/empty -> null, exit 0', () => {
  const r = rig();
  fs.writeFileSync(path.join(r.home, '.claude', 'settings.json'), '{oops');
  fs.writeFileSync(path.join(r.cwd, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: '' }, apiKeyHelper: '' }));
  const { findOverride } = require(OVR);
  assert.strictEqual(findOverride({ cwd: r.cwd, home: r.home, managedPath: r.managed }), null);
  const cli = spawnSync('node', [OVR, '--cwd', r.cwd], { env: r.env, encoding: 'utf8' });
  assert.strictEqual(cli.status, 0);
  assert.strictEqual(cli.stdout, '');
});

test('settings-override: first hit in order wins', () => {
  const r = rig();
  fs.writeFileSync(path.join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'x' }));
  fs.writeFileSync(path.join(r.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'y' } }));
  const { findOverride } = require(OVR);
  assert.deepStrictEqual(findOverride({ cwd: r.cwd, home: r.home, managedPath: r.managed }),
    { file: path.join(r.home, '.claude', 'settings.json'), key: 'env.ANTHROPIC_AUTH_TOKEN' });
});

test('hooks: cmux inject-settings output passed as --settings, 0600; silent outside cmux', () => {
  const r = rig();
  const cmux = path.join(r.d, 'cmux');
  fs.writeFileSync(cmux, '#!/bin/bash\necho \'{"hooks":{"Stop":[]}}\'\n', { mode: 0o755 });
  const noPane = run(r, ['acme']);
  assert.deepStrictEqual(JSON.parse(noPane.stdout).argv, []);
  const res = run(r, ['acme'], { CMUX_SURFACE_ID: 's1', CMUX_BUNDLED_CLI_PATH: cmux });
  assert.strictEqual(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout);
  assert.strictEqual(o.argv[0], '--settings');
  assert.strictEqual(o.argv.length, 2);
  assert.ok(o.cmuxPid);
  assert.strictEqual(fs.statSync(o.argv[1]).mode & 0o777, 0o600);
  noToken(res);
});

test('hooks cmux CLI runs before the token is exported (token absent from its env)', () => {
  const r = rig();
  const cmux = path.join(r.d, 'cmux'); const rec = path.join(r.d, 'rec');
  fs.writeFileSync(cmux, `#!/bin/bash
[ -n "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && echo present >"${rec}" || echo absent >"${rec}"
echo '{"hooks":{"Stop":[]}}'
`, { mode: 0o755 });
  const res = run(r, ['acme'], { CMUX_SURFACE_ID: 's1', CMUX_BUNDLED_CLI_PATH: cmux });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(fs.readFileSync(rec, 'utf8').trim(), 'absent');
  assert.strictEqual(JSON.parse(res.stdout).hasToken, true);
});

test('hung show-keychain-info -> exit 2 within ~4s', () => {
  const r = rig({ hang: true });
  const t0 = Date.now();
  const res = run(r, ['acme']);
  assert.strictEqual(res.status, 2);
  assert.ok(Date.now() - t0 < 4500, 'took too long');
  assert.match(res.stderr, /Keychain is locked/);
});

test('node missing -> exit 2 (fail closed)', () => {
  const r = rig();
  const res = run(r, ['acme'], { HYPERMUX_NODE: path.join(r.d, 'no-such-node') });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.includes('hasToken'), false);
});

test('node crashes on override check -> exit 2', () => {
  const r = rig();
  const bad = path.join(r.d, 'badnode'); fs.writeFileSync(bad, '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  const res = run(r, ['acme'], { HYPERMUX_NODE: bad });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.includes('hasToken'), false);
});

test('meta write failure (unwritable path) -> exit 2, claude not run', () => {
  const r = rig();
  const blocker = path.join(r.d, 'blocker'); fs.writeFileSync(blocker, 'x');
  const res = run(r, ['acme'], { HYPERMUX_ACCOUNTS_FILE: path.join(blocker, 'accounts.json') });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.includes('hasToken'), false);
});
