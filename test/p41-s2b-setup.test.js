'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SETUP = path.join(ROOT, 'bin', 'hypermux-account-setup');
const REMOVE = path.join(ROOT, 'bin', 'hypermux-account-remove');
const BODY = 'AbCdEfGh1234_-xyzQRSTUVWX'.repeat(4); // 100 synthetic chars
const TOKEN = 'sk-ant-oat01-' + BODY;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SVC = (n) => 'cos-claude-account-' + n;

const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('fs');
const kc = process.env.FAKE_KEYCHAIN;
const load = () => { try { return JSON.parse(fs.readFileSync(kc, 'utf8')); } catch { return {}; } };
const save = (o) => fs.writeFileSync(kc, JSON.stringify(o));
const split = (s) => (s.match(/"[^"]*"|\\S+/g) || []).map((x) => x.replace(/^"|"$/g, ''));
const opts = (a) => { const o = {}; for (let i = 0; i < a.length; i++) { if (a[i] === '-U') o.U = true; else if (a[i].startsWith('-')) o[a[i][1]] = a[++i]; } return o; };
function run(args) {
  const cmd = args[0]; const o = opts(args.slice(1)); const k = o.a + '|' + o.s; const db = load();
  if (cmd === 'show-keychain-info') return process.env.FAKE_LOCKED ? 36 : 0;
  if (cmd === 'find-generic-password') return k in db ? 0 : 44;
  if (cmd === 'delete-generic-password') { if (!(k in db)) return 44; delete db[k]; save(db); return 0; }
  if (cmd === 'add-generic-password') {
    if (process.env.FAKE_WRITE_FAIL) return 1;
    if (k in db && !o.U) return 45;
    db[k] = o.w; save(db); return 0;
  }
  return 1;
}
if (process.argv[2] === '-i') {
  let buf = ''; process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => { for (const l of buf.split('\\n')) if (l.trim()) run(split(l)); process.exit(0); });
} else process.exit(run(process.argv.slice(2)));
`;

// fake setup-command: modes via FAKE_MODE
const FAKE_SETUP = `#!/usr/bin/env node
const fs = require('fs');
const w = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = process.env.FAKE_TOKEN;
(async () => {
  fs.writeFileSync(process.env.FAKE_SIDE, JSON.stringify({
    browser: 'BROWSER' in process.env,
    claude: Object.keys(process.env).some((k) => /^(CLAUDE|ANTHROPIC)/i.test(k)),
  }));
  const mode = process.env.FAKE_MODE || 'normal';
  w('Opening browser to sign in...\\r\\n');
  w('Visit: https://claude.example.test/oauth/authorize?code=true&client_id=fake\\r\\n');
  await sleep(80);
  w('\\x1b[2K\\x1b[1GPaste code here if prompted > \\x1b[?25h');
  await sleep(80);
  if (mode === 'none') { w('\\r\\nsomething went wrong\\r\\n'); return; }
  if (mode === 'hang') { await sleep(30000); return; }
  if (mode === 'split') {
    w('\\r\\nDone. x sk-a'); await sleep(150); w('nt-oat01-' + T.slice(13, 60)); await sleep(80);
    w(T.slice(60, 80) + '\\r\\n' + T.slice(80) + '\\r\\nstore it safely\\r\\n'); return;
  }
  w('\\r\\n\\x1b[1mYour OAuth token (valid for 1 year):\\x1b[0m\\r\\n\\r\\n');
  w(T.slice(0, 70) + '\\r\\n' + T.slice(70) + '\\r\\n\\r\\nStore this token securely.\\r\\n');
})();
`;
const FAKE_SCRIPT = `#!/bin/bash
shift 2
exec "$@"
`;

function rig(opts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's2b-'));
  const w = (n, c) => { const p = path.join(d, n); fs.writeFileSync(p, c, { mode: 0o755 }); return p; };
  const sec = w('security', FAKE_SECURITY);
  const setup = w('setupcmd', FAKE_SETUP);
  const script = w('script', FAKE_SCRIPT);
  const kc = path.join(d, 'kc.json');
  const accounts = path.join(d, 'cfg', 'accounts.json');
  const side = path.join(d, 'side.json');
  const env = {
    PATH: process.env.PATH, HOME: path.join(d, 'home'), USER: 'tester',
    HYPERMUX_SECURITY_BIN: sec, HYPERMUX_SCRIPT_BIN: script, HYPERMUX_SETUP_CMD: setup,
    HYPERMUX_ACCOUNTS_FILE: accounts, HYPERMUX_CLOSE_DELAY_S: '0',
    FAKE_KEYCHAIN: kc, FAKE_SIDE: side, FAKE_TOKEN: TOKEN,
    BROWSER: '/bin/true', CLAUDE_FOO: 'x', ANTHROPIC_API_KEY: 'sk-ant-api03-fakeXXXXYYYY',
    ...opts,
  };
  const keychain = () => { try { return JSON.parse(fs.readFileSync(kc, 'utf8')); } catch { return {}; } };
  return { d, env, kc, accounts, side, keychain };
}
const run = (bin, r, args, input = '', extra = {}) =>
  spawnSync('bash', [bin, ...args], { env: { ...r.env, ...extra }, input, encoding: 'utf8', timeout: 20000 });
const noLeak = (res) => {
  const out = res.stdout + res.stderr;
  for (let i = 0; i + 8 <= BODY.length; i += 4) assert.ok(!out.includes(BODY.slice(i, i + 8)), 'token fragment leaked at ' + i);
  assert.ok(!out.includes('sk-ant-oat'), 'token prefix leaked');
};
const KEY = (n) => 'tester|' + SVC(n);

test('setup happy path: stored, fp in meta, screen has URL + Token captured + Saved, no token fragment', () => {
  const r = rig();
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 0, res.stderr + res.stdout);
  noLeak(res);
  assert.strictEqual(r.keychain()[KEY('acme')], TOKEN);
  const meta = JSON.parse(fs.readFileSync(r.accounts, 'utf8'));
  assert.strictEqual(meta.acme.fp, sha(TOKEN).slice(0, 12));
  assert.ok(!Number.isNaN(Date.parse(meta.acme.addedAt)));
  assert.match(res.stdout, /https:\/\/claude\.example\.test\/oauth\/authorize/);
  assert.match(res.stdout, /Token captured/);
  assert.match(res.stdout, new RegExp('Saved acme \\(sha256:' + sha(TOKEN).slice(0, 12)));
  assert.match(res.stdout, /Add Claude account acme on this Mac\? \[y\/N\]/);
});

test('child env: BROWSER unset, CLAUDE*/ANTHROPIC* stripped', () => {
  const r = rig();
  assert.strictEqual(run(SETUP, r, ['acme'], 'y\n').status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.side, 'utf8')), { browser: false, claude: false });
});

test('cancel stores nothing and does not run the setup command', () => {
  const r = rig();
  const res = run(SETUP, r, ['acme'], 'n\n');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout + res.stderr, /cancelled/);
  assert.deepStrictEqual(r.keychain(), {});
  assert.ok(!fs.existsSync(r.side));
  assert.ok(!fs.existsSync(r.accounts));
});

test('exists without --replace -> exit 1, prompt never asked', () => {
  const r = rig();
  fs.writeFileSync(r.kc, JSON.stringify({ [KEY('acme')]: 'old' }));
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout + res.stderr, /acme already exists on this Mac/);
  assert.strictEqual(r.keychain()[KEY('acme')], 'old');
  assert.ok(!fs.existsSync(r.side));
});

test('--replace overwrites, prompt says Replace', () => {
  const r = rig();
  fs.writeFileSync(r.kc, JSON.stringify({ [KEY('acme')]: 'old' }));
  const res = run(SETUP, r, ['acme', '--replace'], 'y\n');
  assert.strictEqual(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /Replace Claude account acme on this Mac\? \[y\/N\]/);
  assert.strictEqual(r.keychain()[KEY('acme')], TOKEN);
  noLeak(res);
});

test('no token in output -> exit 1, nothing stored', () => {
  const r = rig({ FAKE_MODE: 'none' });
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout + res.stderr, /No valid token found — nothing stored/);
  assert.deepStrictEqual(r.keychain(), {});
  assert.ok(!fs.existsSync(r.accounts));
});

test('short token rejected (len < 90)', () => {
  const r = rig({ FAKE_TOKEN: 'sk-ant-oat01-' + 'A'.repeat(40) });
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 1);
  assert.deepStrictEqual(r.keychain(), {});
});

test('keychain write fails -> exit 1, nothing stored, no meta', () => {
  const r = rig({ FAKE_WRITE_FAIL: '1' });
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout + res.stderr, /Keychain write failed — nothing stored/);
  assert.deepStrictEqual(r.keychain(), {});
  assert.ok(!fs.existsSync(r.accounts));
  noLeak(res);
});

test('token prefix split across chunks (sk-a|nt-) never printed', () => {
  const r = rig({ FAKE_MODE: 'split' });
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 0, res.stderr + res.stdout);
  noLeak(res);
  assert.ok(!res.stdout.includes('sk-a'), 'held prefix leaked');
  assert.strictEqual(r.keychain()[KEY('acme')], TOKEN);
});

test('child timeout -> exit 1, nothing stored', () => {
  const r = rig({ FAKE_MODE: 'hang', HYPERMUX_SETUP_TIMEOUT_MS: '600' });
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout + res.stderr, /timed out — nothing stored/);
  assert.deepStrictEqual(r.keychain(), {});
});

test('setup: bad name / name a -> exit 2; locked keychain -> exit 2', () => {
  const r = rig();
  assert.strictEqual(run(SETUP, r, ['Bad'], 'y\n').status, 2);
  assert.strictEqual(run(SETUP, r, ['a'], 'y\n').status, 2);
  assert.strictEqual(run(SETUP, r, [], 'y\n').status, 2);
  const res = run(SETUP, r, ['acme'], 'y\n', { FAKE_LOCKED: '1' });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /this Mac's Keychain is locked/);
  assert.ok(!fs.existsSync(r.side));
});

test('setup: missing node fails closed (exit 2)', () => {
  const r = rig({ HYPERMUX_NODE: '/nonexistent/node' });
  const res = run(SETUP, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /node not found/);
});

test('remove happy: deletes keychain item + meta', () => {
  const r = rig();
  fs.writeFileSync(r.kc, JSON.stringify({ [KEY('acme')]: TOKEN }));
  fs.mkdirSync(path.dirname(r.accounts), { recursive: true });
  fs.writeFileSync(r.accounts, JSON.stringify({ acme: { addedAt: new Date().toISOString(), fp: '0123456789ab' }, beta: { addedAt: new Date().toISOString() } }));
  const res = run(REMOVE, r, ['acme'], 'y\n');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Remove acme from this Mac\? Chief-of-staff workers on this Mac use it too\./);
  assert.match(res.stdout, /does not revoke the token/);
  assert.match(res.stdout, /Removed acme/);
  assert.deepStrictEqual(r.keychain(), {});
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(r.accounts, 'utf8'))), ['beta']);
});

test('remove cancel: nothing deleted', () => {
  const r = rig();
  fs.writeFileSync(r.kc, JSON.stringify({ [KEY('acme')]: TOKEN }));
  const res = run(REMOVE, r, ['acme'], 'n\n');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout + res.stderr, /cancelled/);
  assert.strictEqual(r.keychain()[KEY('acme')], TOKEN);
});

test('remove missing -> exit 1; bad name/a -> exit 2; locked -> exit 2', () => {
  const r = rig();
  const m = run(REMOVE, r, ['acme'], 'y\n');
  assert.strictEqual(m.status, 1);
  assert.match(m.stdout + m.stderr, /no account acme on this Mac/);
  assert.strictEqual(run(REMOVE, r, ['a'], 'y\n').status, 2);
  assert.strictEqual(run(REMOVE, r, ['Bad!'], 'y\n').status, 2);
  const l = run(REMOVE, r, ['acme'], 'y\n', { FAKE_LOCKED: '1' });
  assert.strictEqual(l.status, 2);
  assert.match(l.stderr, /Keychain is locked/);
});

test('scripts carry no set -x and are executable', () => {
  for (const f of [SETUP, REMOVE, path.join(ROOT, 'lib', 'account-setup.js')]) {
    assert.ok(!/set -[a-z]*x/.test(fs.readFileSync(f, 'utf8')), f);
  }
  for (const f of [SETUP, REMOVE]) assert.ok(fs.statSync(f).mode & 0o100, f + ' not executable');
});

test('--also-on label: warning shown before the prompt; works with --replace', () => {
  const r = rig();
  const res = run(SETUP, r, ['acme', '--also-on', 'cmux-max'], 'y\n');
  assert.strictEqual(res.status, 0, res.stderr + res.stdout);
  const w = 'acme is already on cmux-max. If it is the same Claude login, adding it here signs it out on cmux-max (one live token per login).';
  const i = res.stdout.indexOf(w), j = res.stdout.indexOf('Add Claude account acme');
  assert.ok(i >= 0 && j > i, 'warning must precede prompt');
  fs.writeFileSync(r.kc, JSON.stringify({ [KEY('acme')]: 'old' }));
  assert.strictEqual(run(SETUP, r, ['acme', '--replace', '--also-on', 'My Mac_2.x'], 'y\n').status, 0);
  fs.writeFileSync(r.kc, '{}');
  assert.strictEqual(run(SETUP, r, ['acme', '--also-on', 'cmux-max'], 'n\n').stdout.includes(w), true);
});

test('--also-on bad/missing label -> exit 2, nothing runs', () => {
  const r = rig();
  for (const a of [['acme', '--also-on', 'bad;label'], ['acme', '--also-on', ''], ['acme', '--also-on'], ['acme', '--also-on', 'x'.repeat(41)]]) {
    const res = run(SETUP, r, a, 'y\n');
    assert.strictEqual(res.status, 2, JSON.stringify(a));
  }
  assert.ok(!fs.existsSync(r.side));
});
