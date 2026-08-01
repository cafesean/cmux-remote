'use strict';
// S-006 — attention assembly + the push WAL.
//
// The WAL is the only part of radar with a durability contract, so the tests here are mostly about
// what survives a kill: crash injection on BOTH sides of the append, rotation, and rebuilding the
// cursor from the log after it is deleted or corrupted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const push = require('../radar/push');
const { derive } = require('../radar/derive');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'radar-push-'));
const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const min = (n) => n * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const session = (over) => Object.assign({
  key: { machine: 'machine-b', sessionId: 'sess-1' },
  surface: { workspace: 'workspace:2', tabRef: 'surface:1', tabUuid: 'UUID-A' },
  repo: 'app-web', epic: 'PROJ-108',
  status: 'blocked',
  blockedSince: iso(NOW - min(15)),
  notificationType: 'permission_prompt',
  lastSubmitAt: iso(NOW - min(50)),
  cacheExpiresAt: iso(NOW + min(10)),      // inside the 20-minute warning window
  cacheApprox: true,
}, over);

const state = (over) => Object.assign({ v: 1, generatedAt: iso(NOW), sessions: [], attention: [], repos: {} }, over);

const pusher = (dir, over) => push.createPusher(Object.assign({ dir: path.join(dir, 'events'), role: 'leader', now: () => NOW }, over));

const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch (_) { return []; } };

// ---- the id --------------------------------------------------------------------------------------

test('eventId is sha1(type|ref|transitionAt) — pure, so any re-emission is byte-identical', () => {
  const id = push.eventId('blocked', 'machine-b/sess-1', '2026-07-30T11:45:00.000Z');
  assert.strictEqual(id, crypto.createHash('sha1').update('blocked|machine-b/sess-1|2026-07-30T11:45:00.000Z').digest('hex'));
  assert.strictEqual(id, push.eventId('blocked', 'machine-b/sess-1', '2026-07-30T11:45:00.000Z'), 'no clock, no counter, no randomness');
  assert.notStrictEqual(id, push.eventId('blocked', 'machine-b/sess-2', '2026-07-30T11:45:00.000Z'));
});

// ---- what gets emitted ------------------------------------------------------------------------------

test('blocked is emitted past 10 minutes and NOT before', async () => {
  const dir = await tmp();
  const early = pusher(dir).emit(state({ sessions: [session({ blockedSince: iso(NOW - min(9)) })] }));
  assert.deepStrictEqual(early.emitted.filter((r) => r.type === 'blocked'), [], 'a 9-minute block is not yet an interrupt');
  const late = pusher(dir).emit(state({ sessions: [session({ blockedSince: iso(NOW - min(11)) })] }));
  const blocked = late.emitted.filter((r) => r.type === 'blocked');
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].payload.surface.tabUuid, 'UUID-A', 'the Jump target rides along');
  assert.strictEqual(blocked[0].payload.cacheApprox, true);
});

test('cache-expiring fires inside 20 minutes for a non-running session, and never for a running one', async () => {
  const dir = await tmp();
  const near = { status: 'idle', blockedSince: null, notificationType: null, cacheExpiresAt: iso(NOW + min(15)) };
  const idle = pusher(dir).emit(state({ sessions: [session(near)] }));
  assert.deepStrictEqual(idle.emitted.map((r) => r.type), ['cache-expiring']);

  const dir2 = await tmp();
  const running = pusher(dir2).emit(state({ sessions: [session(Object.assign({}, near, { status: 'running' }))] }));
  assert.deepStrictEqual(running.emitted, [], 'a running session is refreshing its own cache');

  const dir3 = await tmp();
  const far = pusher(dir3).emit(state({ sessions: [session(Object.assign({}, near, { cacheExpiresAt: iso(NOW + min(45)) }))] }));
  assert.deepStrictEqual(far.emitted, []);
});

test('the same transition is emitted ONCE across repeated scans', async () => {
  const dir = await tmp();
  const s = state({ sessions: [session()] });
  const p = pusher(dir);
  assert.strictEqual(p.emit(s).emitted.length, 2, 'blocked + cache-expiring');
  assert.strictEqual(p.emit(s).emitted.length, 0);
  assert.strictEqual(p.emit(s).emitted.length, 0);
  assert.strictEqual(p.readQueue().length, 2);
});

test('blocked CLEARS on a later submit and is recomputed before emit — nothing is re-announced', async () => {
  const dir = await tmp();
  const p = pusher(dir);
  const blocked = p.emit(state({ sessions: [session()] }));
  assert.strictEqual(blocked.emitted.filter((r) => r.type === 'blocked').length, 1);

  // The operator answered: mod-sessions now reports running, with a fresh submit. A diff-based producer
  // would still be sitting on the old blocked edge; this one re-derives from the snapshot.
  const answered = p.emit(state({
    sessions: [session({ status: 'running', blockedSince: null, notificationType: null, lastSubmitAt: iso(NOW), cacheExpiresAt: iso(NOW + min(60)) })],
  }));
  assert.deepStrictEqual(answered.emitted, []);
  assert.deepStrictEqual(p.readQueue().map((r) => r.type), ['blocked', 'cache-expiring']);
});

test('a rule-violation keeps ONE stable id while it persists, and a new bad SHA is a new event', async () => {
  const dir = await tmp();
  const p = pusher(dir);
  const violating = (sha) => state({
    repos: { 'app-web': { deploy: { prod: { status: 'ok', sha, ruleViolation: true } } } },
    attention: [{ type: 'rule-violation', repo: 'app-web', env: 'prod', note: 'deployed SHA not on main', actions: [{ kind: 'context' }] }],
  });
  const first = p.emit(violating('deadbeef'));
  assert.deepStrictEqual(first.emitted.map((r) => r.type), ['rule-violation']);
  assert.strictEqual(p.emit(violating('deadbeef')).emitted.length, 0, 'the same violation is not re-announced every scan');
  const second = p.emit(violating('cafebabe'));
  assert.strictEqual(second.emitted.length, 1, 'a NEW violating deploy is a new event');
  assert.notStrictEqual(second.emitted[0].eventId, first.emitted[0].eventId);
});

// ---- leader only --------------------------------------------------------------------------------------

test('a VIEWER emits nothing — no rows, no queue file, no cursor', async () => {
  const dir = await tmp();
  const p = pusher(dir, { role: 'viewer' });
  const r = p.emit(state({ sessions: [session()] }));
  assert.deepStrictEqual(r.emitted, []);
  assert.strictEqual(r.skipped, 'viewer');
  assert.strictEqual(fs.existsSync(p.queuePath), false, 'the viewer did not even create the WAL');
  assert.strictEqual(fs.existsSync(p.cursorPath), false);
});

test('leader and viewer disagree on the SAME state — the role is the only difference', async () => {
  const s = state({ sessions: [session()] });
  const leaderDir = await tmp();
  const viewerDir = await tmp();
  assert.strictEqual(pusher(leaderDir).emit(s).emitted.length, 2);
  assert.strictEqual(pusher(viewerDir, { role: 'viewer' }).emit(s).emitted.length, 0);
});

// ---- crash injection ------------------------------------------------------------------------------------

test('crash BEFORE the append loses nothing — the next emit still writes the transition', async () => {
  const dir = await tmp();
  const boom = pusher(dir, { hooks: { beforeAppend: () => { throw new Error('power cut'); } } });
  assert.throws(() => boom.emit(state({ sessions: [session()] })), /power cut/);
  assert.deepStrictEqual(boom.readQueue(), [], 'nothing was written');
  assert.strictEqual(fs.existsSync(boom.cursorPath), false, 'and the cursor did not move');

  // A fresh process, same state: the transition is still derivable, so it lands.
  const after = pusher(dir);
  const r = after.emit(state({ sessions: [session()] }));
  assert.strictEqual(r.emitted.filter((x) => x.type === 'blocked').length, 1, 'no lost transition');
});

test('crash AFTER the append, before the cursor lands: the WAL rebuild prevents a double', async () => {
  const dir = await tmp();
  const boom = pusher(dir, { hooks: { afterAppend: () => { throw new Error('power cut'); } } });
  assert.throws(() => boom.emit(state({ sessions: [session()] })), /power cut/);
  const rows = boom.readQueue();
  assert.strictEqual(rows.length, 1, 'the row IS in the WAL');
  assert.strictEqual(fs.existsSync(boom.cursorPath), false, 'but the cursor never landed');

  const restarted = pusher(dir);
  const r = restarted.emit(state({ sessions: [session()] }));
  assert.strictEqual(r.emitted.some((x) => x.eventId === rows[0].eventId), false, 'not re-emitted');
  const all = restarted.readQueue();
  assert.strictEqual(all.filter((x) => x.eventId === rows[0].eventId).length, 1);
});

test('when a duplicate DOES happen (the row aged out of the WAL) its eventId is identical', async () => {
  const dir = await tmp();
  const p = pusher(dir);
  const first = p.emit(state({ sessions: [session()] }));
  const firstId = first.emitted.find((r) => r.type === 'blocked').eventId;

  // At-least-once made concrete: the WAL and cursor are both gone (retention, a wiped disk, a
  // consumer that archived them), the transition is still true, so it is delivered again.
  fs.rmSync(p.queuePath); fs.rmSync(p.cursorPath);
  const again = pusher(dir).emit(state({ sessions: [session()] }));
  const againId = again.emitted.find((r) => r.type === 'blocked').eventId;
  assert.strictEqual(againId, firstId, 'the duplicate carries the SAME eventId — the consumer dedups');
});

// ---- the cursor is derived --------------------------------------------------------------------------

test('a DELETED cursor rebuilds from the WAL and does not re-emit', async () => {
  const dir = await tmp();
  const p = pusher(dir);
  p.emit(state({ sessions: [session()] }));
  const before = p.readQueue().map((r) => r.eventId).sort();

  fs.rmSync(p.cursorPath);
  const rebuilt = pusher(dir);
  assert.deepStrictEqual(Array.from(rebuilt._rebuildFromWal().byId.keys()).sort(), before);
  assert.deepStrictEqual(rebuilt.emit(state({ sessions: [session()] })).emitted, []);
  assert.deepStrictEqual(rebuilt.readQueue().map((r) => r.eventId).sort(), before, 'the WAL is unchanged');
});

test('a CORRUPT cursor is discarded and rebuilt, never trusted', async () => {
  const dir = await tmp();
  const p = pusher(dir);
  p.emit(state({ sessions: [session()] }));
  const before = p.readQueue().length;

  for (const junk of ['{ not json', '{"v":99,"emitted":[]}', '{"v":1,"emitted":"nope"}', '']) {
    fs.writeFileSync(p.cursorPath, junk);
    const fresh = pusher(dir);
    assert.deepStrictEqual(fresh.emit(state({ sessions: [session()] })).emitted, [], `cursor=${JSON.stringify(junk)}`);
    assert.strictEqual(fresh.readQueue().length, before, 'no duplicate row from a bad cursor');
  }
});

test('the rebuild reads the ROTATED file too, so rotation does not resurrect old events', async () => {
  const probeDir = await tmp();
  const probe = pusher(probeDir);
  probe.emit(state({ sessions: [session({ cacheExpiresAt: null })] }));
  const rowBytes = fs.statSync(probe.queuePath).size;

  const dir = await tmp();
  // Cap at 5 rows: the original (2 rows) plus 5 fillers crosses it exactly once, so both the
  // original rows end up in the ROTATED file while the current file holds the tail.
  const p = pusher(dir, { maxBytes: rowBytes * 5 });
  p.emit(state({ sessions: [session()] }));
  for (let i = 0; i < 5; i++) p.emit(state({ sessions: [session({ key: { machine: 'm', sessionId: `filler-${i}` }, cacheExpiresAt: null })] }));
  assert.strictEqual(fs.existsSync(p.rotatedPath), true, 'the fixture must actually rotate');
  assert.strictEqual(readLines(p.rotatedPath).some((l) => JSON.parse(l).ref === 'machine-b/sess-1'), true,
    'the original rows are in the retired file, not the current one');

  fs.rmSync(p.cursorPath);
  const rebuilt = pusher(dir, { maxBytes: rowBytes * 5 });
  assert.deepStrictEqual(rebuilt.emit(state({ sessions: [session()] })).emitted, [], 'the original event is still known');
});

// ---- rotation ---------------------------------------------------------------------------------------

test('rotation happens on a LINE BOUNDARY at the byte cap — no partial line, nothing lost', async () => {
  const row = (i) => state({ sessions: [session({ key: { machine: 'machine-b', sessionId: `s-${i}` }, cacheExpiresAt: null })] });

  // Measure a real row first so the cap can be set to an exact number of rows. A hard-coded byte
  // count would silently stop exercising rotation the moment the row shape changes.
  const probeDir = await tmp();
  const probe = pusher(probeDir);
  probe.emit(row(0));
  const rowBytes = fs.statSync(probe.queuePath).size;

  const dir = await tmp();
  const p = pusher(dir, { maxBytes: rowBytes * 10 });
  const wanted = 15;                                   // 10 fill the cap, row 11 rotates, 5 follow
  for (let i = 0; i < wanted; i++) p.emit(row(i));

  assert.strictEqual(fs.existsSync(p.rotatedPath), true, 'the cap was crossed');
  const rotatedText = fs.readFileSync(p.rotatedPath, 'utf8');
  assert.strictEqual(rotatedText.endsWith('\n'), true, 'the retired file ends on a line boundary');
  assert.strictEqual(rotatedText.includes('\n\n'), false, 'no empty line where a write was cut');
  assert.strictEqual(fs.statSync(p.rotatedPath).size <= rowBytes * 10, true, 'rotation fired before the cap was exceeded');

  for (const [name, file] of [['rotated', p.rotatedPath], ['current', p.queuePath]]) {
    for (const line of readLines(file)) assert.doesNotThrow(() => JSON.parse(line), `${name}: every line is whole JSON`);
  }
  const ids = p.readQueue().map((r) => r.eventId);
  assert.strictEqual(new Set(ids).size, wanted, 'every transition survived the single rotation exactly once');
  assert.strictEqual(readLines(p.rotatedPath).length + readLines(p.queuePath).length, wanted, 'and no line was split between the files');
});

test('a torn trailing line in the WAL is skipped by the reader, not fatal', async () => {
  const dir = await tmp();
  const p = pusher(dir);
  p.emit(state({ sessions: [session()] }));
  fs.appendFileSync(p.queuePath, '{"eventId":"torn","type":"bloc');
  assert.strictEqual(p.readQueue().length, 2, 'the two good rows are still readable');
  const rebuilt = pusher(dir);
  assert.deepStrictEqual(rebuilt.emit(state({ sessions: [session()] })).emitted, []);
});

// ---- attention assembly (§4) --------------------------------------------------------------------------

test('attention is sorted per §4 and every item carries actions[]', () => {
  const s = derive({
    now: NOW,
    collectorId: 'machine-a',
    sources: { sessions: { status: 'ok' }, git: { status: 'ok' } },
    aliases: {},
    decisions: [{ id: 'site-org2', title: 'provider row', since: '2026-07-14T00:00:00.000Z', epic: 'PROJ-113' }],
    fragments: {
      sessions: { sessions: [
        session({ key: { machine: 'machine-b', sessionId: 'late' }, cacheExpiresAt: iso(NOW + min(50)) }),
        session({ key: { machine: 'machine-a', sessionId: 'soon' }, cacheExpiresAt: iso(NOW + min(5)) }),
      ], machines: [{ id: 'machine-a', bridge: 'ok', lastSeenAt: iso(NOW) }] },
      git: { repos: { 'app-web': {
        path: '/r', defaultBranches: {},
        branches: [{ name: 'orphan-branch', epic: null, isDefault: false, unpushed: 0, mergedIntoDevelop: false, lastCommitAt: iso(NOW) }],
        worktrees: [],
        deploy: { prod: { status: 'ok', sha: 'dead', ruleViolation: true, note: 'deployed SHA not on main' } },
      } } },
    },
  });

  assert.deepStrictEqual(s.attention.map((a) => a.type),
    ['blocked', 'blocked', 'rule-violation', 'decision', 'orphan'],
    'blocked -> rule-violation -> decision -> mergeable -> orphan');
  assert.deepStrictEqual(s.attention.slice(0, 2).map((a) => a.sessionKey.sessionId), ['soon', 'late'],
    'blocked sorts by cacheExpiresAt ascending — the closing window goes first');
  for (const a of s.attention) assert.strictEqual(Array.isArray(a.actions), true, `${a.type} carries actions[]`);
  assert.deepStrictEqual(s.attention[0].actions, [{ kind: 'jump', machine: 'machine-a', tabRef: 'surface:1', tabUuid: 'UUID-A' }]);
  assert.deepStrictEqual(s.attention[3].actions, [{ kind: 'context' }, { kind: 'close' }]);
  assert.strictEqual(s.counts.blocked, 2);
});
