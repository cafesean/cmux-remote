'use strict';
// p41 S2d — "+" on a named Claude account, and Session.accountError = "revoked".
// new-surface `account`: absent/"terminal" -> today's terminal; "default" -> the launcher on `a`;
// <name> -> validated + must exist in the Keychain -> the launcher on <name>. The command is built only
// from validated values. accountError comes from the transcript tail the bridge already reads.
//
// Offline: fake cmux, fake `security` (HYPERMUX_SECURITY_BIN), synthetic names and transcripts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootBridge } = require('./helpers/bridge-child');
const { bootServer } = require('./helpers/server-boot');
const { writeFakeCmux, IDS } = require('./helpers/fake-cmux');
const eventlog = require('../radar/eventlog');
const { startTmux, tmuxBinary } = require('./helpers/tmux-server');

const SECRET = 's2d-secret';
const BIN = path.join(path.dirname(require.resolve('../bridge.js')), 'bin');

// fake security: FAKE_SEC_DIR/locked -> show-keychain-info fails; find-generic-password succeeds for
// the services listed (one per line) in FAKE_SEC_DIR/items.
const FAKE_SECURITY = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs'); const path = require('path');
const D = process.env.FAKE_SEC_DIR; const args = process.argv.slice(2);
if (args[0] === 'show-keychain-info') process.exit(fs.existsSync(path.join(D, 'locked')) ? 36 : 0);
if (args[0] === 'find-generic-password') {
  const items = fs.readFileSync(path.join(D, 'items'), 'utf8').split('\n');
  process.exit(items.includes(args[args.indexOf('-s') + 1]) ? 0 : 44);
}
process.exit(1);
`;
// fake cmux: answers tree; records every call; refuses --command when FAKE_DIR/no-command exists
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
} else if (args[0] === 'new-surface' && args.includes('--command') && fs.existsSync(path.join(D, 'no-command'))) {
  process.stderr.write("Error: unknown flag '--command'\n", () => process.exit(1));
} else if (args[0] === 'list-status') process.exit(0);
else process.stdout.write('OK surface:9 pane:1 workspace:1\n', () => process.exit(0));
`;

let dir, sec, br;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2d-')));
  sec = path.join(dir, 'sec'); fs.mkdirSync(sec);
  fs.writeFileSync(path.join(sec, 'security'), FAKE_SECURITY, { mode: 0o755 });
  fs.writeFileSync(path.join(sec, 'items'), 'cos-claude-account-acme\n');
  fs.writeFileSync(path.join(dir, 'fake-cmux'), FAKE_CMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  br = await bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_DIR: dir,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'private.json'), P41_PROCS_FIXTURE: path.join(dir, 'procs.json'),
    NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (br) await br.stop(); });

const WS = 'aaaaaaa1-1111-4111-8111-111111111111';
const replies = [];
async function ns(body) {
  fs.writeFileSync(path.join(dir, 'cmux.log'), '');
  const r = await fetch(br.base + '/cmux/new-surface', { method: 'POST', headers: { 'x-bridge-secret': SECRET, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text(); replies.push(text);
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  const calls = fs.readFileSync(path.join(dir, 'cmux.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { status: r.status, json, calls, ns: calls.filter((a) => a[0] === 'new-surface') };
}
const TERMINAL_ARGV = ['new-surface', '--type', 'terminal', '--workspace', WS, '--focus', 'false'];

test('terminal (absent or "terminal"): argv exactly as before, account null', async () => {
  for (const body of [{ workspace: WS }, { workspace: WS, account: 'terminal' }]) {
    const r = await ns(body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.ns, [TERMINAL_ARGV]);
    assert.equal(r.json.account, null);
  }
});

test('"default" -> the launcher on the Mac\'s own login (a)', async () => {
  const r = await ns({ workspace: WS, account: 'default' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.ns, [TERMINAL_ARGV.concat(['--command', `'${BIN}/hypermux-claude' a`])]);
  assert.equal(r.json.account, 'default');
});

test('<name> that exists -> the launcher on <name>', async () => {
  const r = await ns({ workspace: WS, account: 'acme' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.ns, [TERMINAL_ARGV.concat(['--command', `'${BIN}/hypermux-claude' acme`])]);
  assert.equal(r.json.account, 'acme');
});

test('bad / missing account -> 400 bad_account; locked -> 409; nothing spawned', async () => {
  for (const account of ['a', 'Acme', 'x;rm', 'toolong1', '', 5, ['acme'], 'nope']) {
    const r = await ns({ workspace: WS, account });
    assert.equal(r.status, 400, JSON.stringify(account));
    assert.deepEqual(r.json, { error: 'bad_account' });
    assert.deepEqual(r.ns, []);
  }
  fs.writeFileSync(path.join(sec, 'locked'), '');
  try {
    const r = await ns({ workspace: WS, account: 'acme' });
    assert.equal(r.status, 409); assert.deepEqual(r.json, { error: 'keychain_locked' });
    assert.deepEqual(r.ns, []);
  } finally { fs.unlinkSync(path.join(sec, 'locked')); }
});

test('cmux rejects --command -> 502, never a plain terminal instead', async () => {
  fs.writeFileSync(path.join(dir, 'no-command'), '');
  try {
    const r = await ns({ workspace: WS, account: 'acme' });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: 'cmux_failed' });
    assert.equal(r.ns.length, 1, 'one attempt, no retry without --command');
    assert.ok(r.ns[0].includes('--command'));
  } finally { fs.unlinkSync(path.join(dir, 'no-command')); }
  for (const t of replies) assert.equal(t.includes('sk-ant'), false);
});

test('tmux backend: an account session is 501 unsupported_backend, never a bare shell', async (t) => {
  if (!tmuxBinary()) return t.skip('no tmux binary');
  const srv = await startTmux({ cols: 80, rows: 24 });
  const b = await bootBridge({ env: { BACKEND: 'tmux', TMUX_BIN: srv.tmuxBin, TMUX_SOCKET: srv.socket,
    BRIDGE_SECRET: SECRET, HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec } });
  try {
    const tr = await (await fetch(b.base + '/cmux/tree', { headers: { 'x-bridge-secret': SECRET } })).json();
    const tws = tr.workspaces[0].id;   // a real tmux workspace id, so the private gate can resolve it
    for (const account of ['default', 'acme']) {
      const r = await fetch(b.base + '/cmux/new-surface', { method: 'POST', headers: { 'x-bridge-secret': SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: tws, account }) });
      assert.equal(r.status, 501, account);
      assert.deepEqual(await r.json(), { error: 'unsupported_backend', backend: 'tmux' });
    }
  } finally { await b.stop(); await srv.stop(); }
});

// releases live under "~/Library/Application Support/…": the launcher path is shell-quoted (shq)
async function bridgeWithBin(binDir) {
  return bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_DIR: dir,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'private-b.json'), P41_PROCS_FIXTURE: path.join(dir, 'procs.json'),
    NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', HYPERMUX_BIN_DIR: binDir,
  } });
}
async function nsOn(base, body) {
  fs.writeFileSync(path.join(dir, 'cmux.log'), '');
  const r = await fetch(base + '/cmux/new-surface', { method: 'POST', headers: { 'x-bridge-secret': SECRET, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  const calls = fs.readFileSync(path.join(dir, 'cmux.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { status: r.status, json, ns: calls.filter((a) => a[0] === 'new-surface') };
}

test('bin dir with a space: the launcher path is quoted as one word', async () => {
  const bin = path.join(dir, 'Application Support', 'cmux-remote', 'releases', 'abc', 'bin');
  const b = await bridgeWithBin(bin);
  try {
    const d = await nsOn(b.base, { workspace: WS, account: 'default' });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.deepEqual(d.ns, [TERMINAL_ARGV.concat(['--command', `'${bin}/hypermux-claude' a`])]);
    const n = await nsOn(b.base, { workspace: WS, account: 'acme' });
    assert.equal(n.status, 200, JSON.stringify(n.json));
    assert.deepEqual(n.ns, [TERMINAL_ARGV.concat(['--command', `'${bin}/hypermux-claude' acme`])]);
  } finally { await b.stop(); }
});

test('bin dir with a quote: account sessions 503 accounts_disabled, plain terminal unaffected', async () => {
  const b = await bridgeWithBin(path.join(dir, "it's", 'bin'));
  try {
    const a = await nsOn(b.base, { workspace: WS, account: 'acme' });
    assert.equal(a.status, 503); assert.deepEqual(a.json, { error: 'accounts_disabled' });
    assert.deepEqual(a.ns, []);
    const t = await nsOn(b.base, { workspace: WS });
    assert.equal(t.status, 200);
    assert.deepEqual(t.ns, [TERMINAL_ARGV]);
  } finally { await b.stop(); }
});

// ---------------------------------------------------------------- server relay
test('server relays `account` (string <= 16 chars), omits anything else', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    seen.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: `http://127.0.0.1:${srv.address().port}`, secret: 'sb' }]) } });
  const post = (body) => fetch(s.base + '/api/cmux/new-surface', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ machine: 'm1', workspace: WS, ...body }) });
  try {
    await post({ account: 'acme' });
    assert.deepEqual(seen.pop(), { workspace: WS, account: 'acme' });
    await post({});
    assert.deepEqual(seen.pop(), { workspace: WS });
    await post({ account: 'x'.repeat(17) });
    assert.deepEqual(seen.pop(), { workspace: WS });
    await post({ account: { a: 1 } });
    assert.deepEqual(seen.pop(), { workspace: WS });
  } finally { await s.stop(); await new Promise((r) => srv.close(r)); }
});

// ---------------------------------------------------------------- Session.accountError
const T0 = Date.now() - 60 * 1000;
const iso = (n) => new Date(T0 + n * 1000).toISOString();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n, text) => ({ type: 'user', uuid: uid(n), timestamp: iso(n), message: { role: 'user', content: text } });
const asst = (n, text, extra) => ({ type: 'assistant', uuid: uid(n), timestamp: iso(n), ...(extra || {}), message: { id: `msg_${n}`, role: 'assistant',
  model: 'claude-opus-4-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
// the shape Claude Code writes when the account's token is revoked (an API-error assistant entry)
const REVOKED = (n) => asst(n, 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.', { isApiErrorMessage: true, error: 'authentication_failed' });
const AUTH_OTHER = (n) => asst(n, 'Failed to authenticate. API Error: 401 invalid x-api-key', { isApiErrorMessage: true, error: 'authentication_failed' });
// an API error entry without the `error` code: the anchored text is the fallback
const REVOKED_TEXT_ONLY = (n) => asst(n, 'API Error: Failed to authenticate: OAuth token revoked.', { isApiErrorMessage: true });
const RATE = (n) => asst(n, 'API Error: Rate limited', { isApiErrorMessage: true, error: 'rate_limit' });

async function sessionsWith(rows) {
  const h = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2d-h-')));
  const pd = path.join(h, '.claude', 'projects', '-work-alpha'); fs.mkdirSync(pd, { recursive: true });
  const a = path.join(pd, 'sess-a.jsonl');
  fs.writeFileSync(a, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'sess-a', event: 'UserPromptSubmit', transcriptPath: a, surfaceId: IDS.sfA1, cwd: '/work/alpha' }, T0 + 500);
  eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'sess-a', event: 'Stop', transcriptPath: a, surfaceId: IDS.sfA1, cwd: '/work/alpha' }, T0 + 30000);
  const fake = writeFakeCmux(h);
  fs.writeFileSync(path.join(h, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  const b = await bootBridge({ cwd: h, env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, RADAR_MACHINE_ID: 'mini', P41_PROCS_FIXTURE: path.join(h, 'procs.json') } });
  try {
    const r = await fetch(b.base + '/cmux/sessions', { headers: { 'x-bridge-secret': SECRET } });
    const text = await r.text();
    assert.equal(text.includes('sk-ant'), false);
    const j = JSON.parse(text);
    const th = await fetch(b.base + `/cmux/sessions/${encodeURIComponent('mini:' + IDS.sfA1)}/thread`, { headers: { 'x-bridge-secret': SECRET } });
    await th.text();
    return j.sessions.find((x) => x.surface === IDS.sfA1);
  } finally { await b.stop(); fs.rmSync(h, { recursive: true, force: true }); }
}

test('accountError "revoked" when the newest assistant entry is Claude Code\'s auth failure', async () => {
  const s = await sessionsWith([user(1, 'hi'), asst(2, 'hello'), user(3, 'go on'), REVOKED(4)]);
  assert.ok(s, 'session listed');
  assert.equal(s.kind, 'claude');
  assert.equal(s.accountError, 'revoked');
});

test('accountError "auth_failed" for any other structured auth failure; text-only error entry falls back to the anchored text', async () => {
  const s = await sessionsWith([user(1, 'hi'), AUTH_OTHER(2)]);
  assert.equal(s.accountError, 'auth_failed');
  const t = await sessionsWith([user(1, 'hi'), REVOKED_TEXT_ONLY(2)]);
  assert.equal(t.accountError, 'revoked');
});

test('assistant PROSE mentioning the phrases, or a non-auth API error, sets nothing', async () => {
  const s = await sessionsWith([user(1, 'what broke?'), asst(2, 'The log says "Failed to authenticate: OAuth token revoked" — the setup-token was replaced.')]);
  assert.equal('accountError' in s, false);
  const r = await sessionsWith([user(1, 'hi'), RATE(2)]);
  assert.equal('accountError' in r, false);
});

test('accountError absent normally, and once a later answer replaces the failure', async () => {
  const ok = await sessionsWith([user(1, 'hi'), asst(2, 'hello')]);
  assert.equal(ok.kind, 'claude');
  assert.equal('accountError' in ok, false);
  const later = await sessionsWith([user(1, 'hi'), REVOKED(2), user(3, 'again'), asst(4, 'fine now')]);
  assert.equal('accountError' in later, false);
});

// ---- S2 final I2: account sessions are secured-only (spec §4.2 / §6.1) --------------------------
test('bridge without BRIDGE_SECRET: account session 503 not_secured, terminal unchanged', async () => {
  const b = await bootBridge({ cwd: dir, env: { CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_DIR: dir,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'private-c.json'), P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0' } });
  try {
    for (const account of ['default', 'acme']) {
      const r = await nsOn(b.base, { workspace: WS, account });
      assert.equal(r.status, 503, account); assert.deepEqual(r.json, { error: 'not_secured' });
      assert.deepEqual(r.ns, []);
    }
    const t = await nsOn(b.base, { workspace: WS });
    assert.equal(t.status, 200); assert.deepEqual(t.ns, [TERMINAL_ARGV]);
  } finally { await b.stop(); }
});

test('server without SERVER_TOKEN: new-surface with account 503 not_secured (not relayed); without account relayed', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    seen.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const s = await bootServer({ env: { SERVER_TOKEN: '', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: `http://127.0.0.1:${srv.address().port}`, secret: 'sb' }]) } });
  const post = (body) => fetch(s.base + '/api/cmux/new-surface', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine: 'm1', workspace: WS, ...body }) });
  try {
    const a = await post({ account: 'acme' });
    assert.equal(a.status, 503); assert.deepEqual(await a.json(), { error: 'not_secured' });
    assert.equal(seen.length, 0);
    const t = await post({});
    assert.equal(t.status, 200);
    assert.deepEqual(seen.pop(), { workspace: WS });
  } finally { await s.stop(); await new Promise((r) => srv.close(r)); }
});

// D178: HYPERMUX_SKIP_PERMISSIONS=1 on the bridge -> fixed literal env prefix on the launcher command
test('D178: bridge switch prefixes the launcher command; default (above) does not', async () => {
  const b2 = await bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_DIR: dir,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_PRIVATE_FILE: path.join(dir, 'private.json'), P41_PROCS_FIXTURE: path.join(dir, 'procs.json'),
    NODE_ENV: 'test', COMPLETIONS_ENABLED: '0', HYPERMUX_SKIP_PERMISSIONS: '1',
  } });
  try {
    fs.writeFileSync(path.join(dir, 'cmux.log'), '');
    const r = await fetch(b2.base + '/cmux/new-surface', { method: 'POST', headers: { 'x-bridge-secret': SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: WS, account: 'default' }) });
    assert.equal(r.status, 200);
    const calls = fs.readFileSync(path.join(dir, 'cmux.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'new-surface');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf('--command') + 1], `HYPERMUX_SKIP_PERMISSIONS=1 '${BIN}/hypermux-claude' a`);
  } finally { await b2.stop(); }
});
