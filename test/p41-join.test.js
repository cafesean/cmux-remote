'use strict';
// p41 A3 — which transcript a pane is showing. The event log, the clock and the file system are all
// injected, so no test touches the real disk.
const test = require('node:test');
const assert = require('node:assert');

const { transcriptFor, watchJoin } = require('../sessions/join.js');

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const HOME = '/home/u';
const SURFACE = '7C1A0E52-1111-2222-3333-444455556666';

const ev = (o) => ({ ts: NOW - 60_000, sessionId: 's1', transcriptPath: `${HOME}/.claude/projects/-w/s1.jsonl`,
  cwd: '/w', event: 'UserPromptSubmit', surfaceId: SURFACE, ...o });
const events = (list) => async () => ({ events: list, more: false });

// A fake disk: { path: { mtime, first? } }. Directories are implied by the paths.
function fakeFs(files) {
  const names = Object.keys(files);
  return {
    async readdir(dir) {
      const d = dir.replace(/\/$/, '') + '/';
      const out = new Set();
      for (const n of names) if (n.startsWith(d)) out.add(n.slice(d.length).split('/')[0]);
      if (!out.size) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...out];
    },
    async stat(p) {
      if (files[p]) return { mtimeMs: files[p].mtime };
      return { mtimeMs: 0 };
    },
    async firstLine(p) { return (files[p] && files[p].first) || null; },
  };
}
const base = (o) => ({ now: () => NOW, home: HOME, ...o });

test('newest hook event for the surface wins', async () => {
  const deps = base({ readEvents: events([
    ev({ ts: NOW - 300_000, sessionId: 'old', transcriptPath: `${HOME}/.claude/projects/-w/old.jsonl` }),
    ev({ ts: NOW - 10_000, sessionId: 'new', transcriptPath: `${HOME}/.claude/projects/-w/new.jsonl` }),
    ev({ ts: NOW - 5_000, sessionId: 'other', surfaceId: 'OTHER', transcriptPath: '/x/other.jsonl' }),
  ]), fs: fakeFs({}) });
  assert.deepStrictEqual(await transcriptFor(SURFACE, deps),
    { kind: 'claude', path: `${HOME}/.claude/projects/-w/new.jsonl`, sessionId: 'new' });
});

test('after /clear the new sessionId replaces the old path', async () => {
  const log = [ev({ ts: NOW - 120_000, sessionId: 'a', transcriptPath: `${HOME}/.claude/projects/-w/a.jsonl` })];
  const deps = base({ readEvents: async () => ({ events: log, more: false }), fs: fakeFs({}) });
  assert.strictEqual((await transcriptFor(SURFACE, deps)).sessionId, 'a');
  log.push(ev({ ts: NOW - 1_000, event: 'SessionStart', sessionId: 'b', transcriptPath: `${HOME}/.claude/projects/-w/b.jsonl` }));
  const after = await transcriptFor(SURFACE, deps);
  assert.strictEqual(after.sessionId, 'b');
  assert.strictEqual(after.path, `${HOME}/.claude/projects/-w/b.jsonl`);
});

test('no events -> cwd + start-time fallback', async () => {
  const dir = `${HOME}/.claude/projects/-Users-s-code-my-app`;
  const deps = base({
    readEvents: events([]),
    cwdFor: async () => '/Users/s/code/my-app',
    startedAt: async () => NOW - 3_600_000,
    fs: fakeFs({ [`${dir}/live.jsonl`]: { mtime: NOW - 1_000 } }),
  });
  assert.deepStrictEqual(await transcriptFor(SURFACE, deps), { kind: 'claude', path: `${dir}/live.jsonl`, sessionId: 'live' });
});

test('claude slug turns / and . into -', async () => {
  const dir = `${HOME}/.claude/projects/-Users-s-code-my-app-v1`;
  const deps = base({
    readEvents: events([]), cwdFor: async () => '/Users/s/code/my.app.v1', startedAt: async () => NOW - 5_000,
    fs: fakeFs({ [`${dir}/x.jsonl`]: { mtime: NOW } }),
  });
  assert.strictEqual((await transcriptFor(SURFACE, deps)).path, `${dir}/x.jsonl`);
});

test('two candidate files -> newest mtime after process start', async () => {
  const dir = `${HOME}/.claude/projects/-w`;
  const files = {
    [`${dir}/before.jsonl`]: { mtime: NOW - 7_200_000 },     // older than the process: a previous run
    [`${dir}/mid.jsonl`]: { mtime: NOW - 600_000 },
    [`${dir}/newest.jsonl`]: { mtime: NOW - 2_000 },
  };
  const deps = base({ readEvents: events([]), cwdFor: async () => '/w', startedAt: async () => NOW - 3_600_000, fs: fakeFs(files) });
  assert.strictEqual((await transcriptFor(SURFACE, deps)).sessionId, 'newest');
  // every file predates the process: nothing belongs to this pane
  const stale = base({ readEvents: events([]), cwdFor: async () => '/w', startedAt: async () => NOW,
    fs: fakeFs({ [`${dir}/before.jsonl`]: { mtime: NOW - 7_200_000 } }) });
  assert.strictEqual(await transcriptFor(SURFACE, stale), null);
});

test('codex fallback matches cwd from first line', async () => {
  const root = `${HOME}/.codex/sessions/2026/11/04`;
  const meta = (cwd, id) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
  const files = {
    [`${root}/rollout-2026-11-04T11-00-00-aaa.jsonl`]: { mtime: NOW - 500, first: meta('/elsewhere', 'aaa') },
    [`${root}/rollout-2026-11-04T10-00-00-bbb.jsonl`]: { mtime: NOW - 900, first: meta('/w', 'bbb') },
    [`${root}/rollout-2026-11-04T09-00-00-ccc.jsonl`]: { mtime: NOW - 9_000, first: meta('/w', 'ccc') },
  };
  const deps = base({ readEvents: events([]), cwdFor: async () => '/w', startedAt: async () => NOW - 3_600_000, fs: fakeFs(files) });
  assert.deepStrictEqual(await transcriptFor(SURFACE, deps),
    { kind: 'codex', path: `${root}/rollout-2026-11-04T10-00-00-bbb.jsonl`, sessionId: 'bbb' });
});

test('unknown surface and no cwd -> null', async () => {
  assert.strictEqual(await transcriptFor(SURFACE, base({ readEvents: events([]), cwdFor: async () => null, fs: fakeFs({}) })), null);
  assert.strictEqual(await transcriptFor('', base({})), null);
});

test('watchJoin fires onChange when path changes', async () => {
  const log = [ev({ sessionId: 'a', transcriptPath: `${HOME}/.claude/projects/-w/a.jsonl` })];
  let tick = null;
  let cleared = false;
  const deps = base({
    readEvents: async () => ({ events: log, more: false }), fs: fakeFs({}),
    setInterval: (fn, ms) => { tick = fn; assert.strictEqual(ms, 5000); return { unref() {} }; },
    clearInterval: () => { cleared = true; },
  });
  const seen = [];
  const stop = watchJoin(SURFACE, (j) => seen.push(j.sessionId), deps);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(seen, ['a']);                     // first resolution is a change from nothing
  await tick();
  assert.deepStrictEqual(seen, ['a']);                     // same path: silent
  log.push(ev({ ts: NOW - 500, sessionId: 'b', transcriptPath: `${HOME}/.claude/projects/-w/b.jsonl` }));
  await tick();
  assert.deepStrictEqual(seen, ['a', 'b']);                // /clear: new path
  stop();
  assert.ok(cleared);
  log.push(ev({ ts: NOW - 100, sessionId: 'c', transcriptPath: `${HOME}/.claude/projects/-w/c.jsonl` }));
  await tick();
  assert.deepStrictEqual(seen, ['a', 'b']);                // stopped: no more calls
});
