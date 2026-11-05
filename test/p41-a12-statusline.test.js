'use strict';
// p41 A12 — Session.statusLine: sidecar read (safe open), git fallback, id never used as a path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSidecar, createGitInfo, LIMITS } = require('../sessions/statusline.js');
const { createSessionRoutes } = require('../sessions/routes.js');

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a12-')));
const side = (id, extra) => JSON.stringify({ v: 1, sessionId: id, account: 'jet', lastReplyAt: '2026-11-05T01:19:28.440Z', ctxUsed: 205000, ctxLimit: 200000,
  ctxPct: 102, model: 'Opus 5.5', modelId: 'x', title: 'x-cmux-native-3', cwd: '/w', branch: 'integration/p41-native', repo: 'cmux-remote', writtenAt: '2026-11-05T01:19:42Z', ...extra });
const put = (home, root, id, body) => { const d = path.join(home, ...root, 'statusline'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${id}.json`), body); return path.join(d, `${id}.json`); };

test('sidecar: valid read, extra fields dropped', async () => {
  const home = mk(); put(home, ['.claude'], 's1', side('s1', { secret: 'nope' }));
  const r = await readSidecar('s1', { home });
  assert.equal(r.account, 'jet'); assert.equal(r.ctxPct, 102); assert.equal(r.branch, 'integration/p41-native');
  assert.ok(!('secret' in r) && !('modelId' in r));
});

test('sidecar: swap config dir is read too', async () => {
  const home = mk(); put(home, ['.claude-swap-backup', 'sessions', '2-a'], 's2', side('s2', { account: 'b' }));
  assert.equal((await readSidecar('s2', { home })).account, 'b');
});

test('sidecar: symlink rejected', async () => {
  const home = mk(); const real = path.join(home, 'real.json'); fs.writeFileSync(real, side('s3'));
  const d = path.join(home, '.claude', 'statusline'); fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(real, path.join(d, 's3.json'));
  assert.equal(await readSidecar('s3', { home }), null);
});

test('sidecar: oversize rejected, bad JSON ignored, wrong sessionId/version ignored', async () => {
  const home = mk();
  put(home, ['.claude'], 'big', side('big', { title: 'x'.repeat(LIMITS.sidecarMaxBytes) }));
  put(home, ['.claude'], 'bad', '{nope');
  put(home, ['.claude'], 'arr', '[1]');
  put(home, ['.claude'], 'mis', side('other'));
  put(home, ['.claude'], 'v2', side('v2', { v: 2 }));
  for (const id of ['big', 'bad', 'arr', 'mis', 'v2', 'missing']) assert.equal(await readSidecar(id, { home }), null, id);
});

test('sidecar: bad session id is never used as a path', async () => {
  const home = mk(); fs.writeFileSync(path.join(home, 'evil.json'), side('../../evil'));
  put(home, ['.claude'], 'ok', side('ok'));
  for (const id of ['../../evil', '../statusline/ok', 'a/b', '', 'a'.repeat(129), null, 5]) assert.equal(await readSidecar(id, { home }), null, String(id));
});

test('gitInfo: fake git, cached per cwd within TTL', async () => {
  let calls = 0; let t = 1000;
  const git = async (args) => { calls++; return args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'main' : '/code/my-repo'; };
  const gi = createGitInfo({ git, now: () => t });
  assert.deepEqual(await gi('/w'), { branch: 'main', repo: 'my-repo' });
  const c = calls; await gi('/w'); assert.equal(calls, c);
  t += LIMITS.gitCacheTtlMs + 1; await gi('/w'); assert.ok(calls > c);
  const none = createGitInfo({ git: async () => null, now: () => t });
  assert.deepEqual(await none('/w'), { branch: null, repo: null });
  assert.deepEqual(await none('relative'), { branch: null, repo: null });
});

const row = (n, t) => JSON.stringify({ type: 'user', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: new Date(1e12 + n).toISOString(), message: { role: 'user', content: t } }) + '\n';
async function list(home, git) {
  const dir = path.join(home, '.claude', 'projects', '-w'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sA.jsonl'); fs.writeFileSync(f, row(1, 'hello'));
  const ev = [{ ts: Date.now() - 1000, sessionId: 'sA', event: 'Stop', transcriptPath: f, surfaceId: 'surface:1', cwd: '/w' }];
  const r = createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, git,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:1', ref: 'surface:1', title: 't', type: 'terminal' }] }],
    readEvents: async () => ({ events: ev, more: false }), procSnapshot: async () => ({ table: [], sessions: [] }) });
  return new Promise((resolve) => {
    r.handle({ method: 'GET', headers: {} }, { writeHead() {}, end: (b) => resolve(JSON.parse(b).sessions[0]) }, new URL('http://x/cmux/sessions'));
  });
}

test('list: statusLine from sidecar; model/contextPct fields kept', async () => {
  const home = mk(); put(home, ['.claude'], 'sA', side('sA'));
  const s = await list(home, async () => null);
  assert.equal(s.statusLine.account, 'jet'); assert.equal(s.statusLine.ctxPct, 102);
});

test('list: fallback uses fake git, no account', async () => {
  const home = mk();
  const s = await list(home, async (args, cwd) => { assert.equal(cwd, '/w'); return args[1] === '--abbrev-ref' ? 'feat/x' : '/c/proj'; });
  assert.equal(s.kind, 'claude');
  assert.equal(s.statusLine.account, null); assert.equal(s.statusLine.branch, 'feat/x'); assert.equal(s.statusLine.repo, 'proj');
  assert.equal(s.statusLine.title, s.title);
});
