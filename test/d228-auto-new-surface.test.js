'use strict';
// D228 slice A — new-surface account "auto": a fresh pick -> the launcher on the picked name; the reply
// names it; every account at its limit -> 409 all_limited {soonest}, nothing spawned, no fallback to `a`.
// /cmux/accounts/usage carries per-row `room` + top-level `auto`. Setup refuses the name `auto`.
// Offline: fake cmux, fake `security` (names via dump-keychain), synthetic chief usage + pool files.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const SECRET = 'd228-secret';
const BIN = path.join(path.dirname(require.resolve('../bridge.js')), 'bin');
const FAKE_SECURITY = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs'); const path = require('path');
const D = process.env.FAKE_SEC_DIR; const args = process.argv.slice(2);
const items = fs.readFileSync(path.join(D, 'items'), 'utf8').split('\n').filter(Boolean);
if (args[0] === 'show-keychain-info') process.exit(0);
if (args[0] === 'dump-keychain') { process.stdout.write(items.map((s) => '    "svce"<blob>="' + s + '"\n').join(''), () => process.exit(0)); }
else if (args[0] === 'find-generic-password') process.exit(items.includes(args[args.indexOf('-s') + 1]) ? 0 : 44);
else process.exit(1);
`;
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs'); const path = require('path');
const D = process.env.FAKE_DIR; const args = process.argv.slice(2);
fs.appendFileSync(path.join(D, 'cmux.log'), JSON.stringify(args) + '\n');
const sf = (id, ref) => ({ id, ref, title: ref, type: 'terminal', selected: true, selected_in_pane: true });
if (args[0] === 'tree') {
  process.stdout.write(JSON.stringify({ windows: [{ id: 'f0f0f0f0-1111-4111-8111-000000000001', ref: 'window:1', workspaces: [
    { id: 'aaaaaaa1-1111-4111-8111-111111111111', ref: 'workspace:1', title: 'alpha', selected: true, panes: [
      { id: 'aaaaaaa1-2222-4222-8222-222222222221', ref: 'pane:1', index: 0, focused: true, selected_surface_id: 'aaaaaaa1-3333-4333-8333-333333333331',
        surfaces: [sf('aaaaaaa1-3333-4333-8333-333333333331', 'surface:1')] }] }] }] }), () => process.exit(0));
} else if (args[0] === 'list-status') process.exit(0);
else process.stdout.write('OK surface:9 pane:1 workspace:1\n', () => process.exit(0));
`;

let dir, sec, br, usageFile, poolFile;
const S = (iso) => Math.floor(Date.parse(iso) / 1000);
const FUTURE = '2099-01-01T15:10:00Z';
const writeUsage = (accounts) => fs.writeFileSync(usageFile, JSON.stringify({ updatedAt: new Date().toISOString(), accounts }));

before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd228-')));
  sec = path.join(dir, 'sec'); fs.mkdirSync(sec);
  fs.writeFileSync(path.join(sec, 'security'), FAKE_SECURITY, { mode: 0o755 });
  fs.writeFileSync(path.join(sec, 'items'), ['a', 'auto', 'work', 'home'].map((n) => 'cos-claude-account-' + n).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'fake-cmux'), FAKE_CMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  usageFile = path.join(dir, 'account-usage.json');
  poolFile = path.join(dir, 'ACCOUNT_POOL.m');
  writeUsage([]);
  br = await bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_DIR: dir,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_ACCOUNT_USAGE_FILE: usageFile, HYPERMUX_LAUNCHES_FILE: path.join(dir, 'launches.jsonl'),
    HYPERMUX_ACCOUNTS_FILE: path.join(dir, 'accounts.json'), HYPERMUX_ACCOUNT_POOL_FILE: poolFile,
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'private.json'), HYPERMUX_START_DIRS_FILE: path.join(dir, 'start-dirs.json'), RADAR_DIR: path.join(dir, 'radar'), P41_PROCS_FIXTURE: path.join(dir, 'procs.json'),
    NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (br) await br.stop(); });

const WS = 'aaaaaaa1-1111-4111-8111-111111111111';
const H = { 'x-bridge-secret': SECRET, 'content-type': 'application/json' };
async function ns(body) {
  fs.writeFileSync(path.join(dir, 'cmux.log'), '');
  const r = await fetch(br.base + '/cmux/new-surface', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  const calls = fs.readFileSync(path.join(dir, 'cmux.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { status: r.status, json, ns: calls.filter((a) => a[0] === 'new-surface') };
}
const ARGV = ['new-surface', '--type', 'terminal', '--workspace', WS, '--focus', 'false'];

test('usage reply: per-row room + top-level auto; `a` / `auto` items are not offered', async () => {
  writeUsage([{ name: 'work', status: 'allowed', util5h: 0.2, util7d: 0.3 }, { name: 'home', status: 'allowed', util5h: 0.95, util7d: 0.1, reset5h: S(FUTURE) }]);
  const r = await fetch(br.base + '/cmux/accounts/usage', { headers: H });
  const j = await r.json();
  assert.equal(r.status, 200);
  const by = Object.fromEntries(j.accounts.map((a) => [a.name, a]));
  assert.equal(by.auto, undefined);
  assert.equal(by.work.room, true); assert.equal(by.home.room, false);
  assert.ok(by.a, 'a stays listed (explicit pick), never the auto pick');
  assert.equal(j.auto.pick, 'work');
});

test('auto -> fresh pick -> the launcher on the picked name; reply names it', async () => {
  writeUsage([{ name: 'work', status: 'allowed', util5h: 0.2, util7d: 0.6 }, { name: 'home', status: 'allowed', util5h: 0.1, util7d: 0.2 }, { name: 'a', status: 'allowed', util5h: 0, util7d: 0 }]);
  const r = await ns({ workspace: WS, account: 'auto' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.ns, [ARGV.concat(['--command', `'${BIN}/hypermux-claude' home`])]);
  assert.equal(r.json.account, 'home'); assert.equal(r.json.auto, true);
});

test('auto obeys the chief ACCOUNT_POOL file', async () => {
  fs.writeFileSync(poolFile, 'work\n');
  try {
    const r = await ns({ workspace: WS, account: 'auto' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.account, 'work');
  } finally { fs.unlinkSync(poolFile); }
});

test('all at limit -> 409 all_limited {soonest}; nothing spawned, no fallback to default', async () => {
  writeUsage([
    { name: 'work', status: 'rejected', util5h: 1, util7d: 0.5, reset5h: S('2099-01-01T16:00:00Z'), reset7d: S('2099-01-05T00:00:00Z') },
    { name: 'home', status: 'allowed', util5h: 0.2, util7d: 0.92, reset7d: S(FUTURE) },
    { name: 'a', status: 'allowed', util5h: 0, util7d: 0 },
  ]);
  const r = await ns({ workspace: WS, account: 'auto' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual(r.json, { error: 'all_limited', soonest: new Date(FUTURE).toISOString() });
  assert.deepEqual(r.ns, []);
});

test('setup refuses the reserved name `auto`', async () => {
  const r = await fetch(br.base + '/cmux/accounts/setup', { method: 'POST', headers: H, body: JSON.stringify({ name: 'auto' }) });
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'bad_name' });
});
