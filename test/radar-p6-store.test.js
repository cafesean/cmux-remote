'use strict';
// p6 S-003 — the four store primitives and the eleven config keys.
//
// The bullet that matters most here is the NESTING REGRESSION: `store.enqueue` is not re-entrant,
// so `appendLine` (queued) awaited from inside a slot deadlocks silently, forever, with no error
// and no timeout. That is why the unqueued form exists at all, and a build where BOTH forms
// complete has made appendLine unqueued and broken the single-writer serialisation instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('../radar/store.js');
const { normalizeConfig, DEFAULTS } = require('../radar/config.js');

const LINE_MAX = 131072;            // specs §4.8 fixes this; assert the literal, not the impl
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-store-'));

test('S-003: store exports the nine originals plus exactly the four p6 primitives', () => {
  const nine = ['defaultRadarDir', 'enqueue', 'drain', 'queueDepth',
    'writeJsonAtomic', 'writeJsonAtomicUnqueued', 'readJson', 'readJsonSync', 'updateJson'];
  const four = ['appendLine', 'appendLineUnqueued', 'writeTextAtomic', 'writeTextAtomicUnqueued'];
  assert.deepStrictEqual(Object.keys(store).sort(), [...nine, ...four].sort());
  for (const k of four) assert.strictEqual(typeof store[k], 'function', k);
});

test('S-003: one record is one line — JSON escapes every newline', async () => {
  const d = tmpdir(); const f = path.join(d, 'ledger.jsonl');
  const obj = { a: 'x\ny', b: 'r\rn', c: ' sep', d: 'tab\there' };
  await store.appendLine(f, obj);
  await store.appendLine(f, { second: true });
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(JSON.parse(lines[0]), obj);        // round-trips byte-equal
  assert.deepStrictEqual(JSON.parse(lines[1]), { second: true });
});

test('S-003: LINE_MAX is enforced at 131072 bytes including the newline', async () => {
  const d = tmpdir(); const f = path.join(d, 'ledger.jsonl');
  // {"v":"<pad>"}\n  ->  8 chars of JSON envelope + 1 newline
  const fit = { v: 'a'.repeat(LINE_MAX - 9) };
  const over = { v: 'a'.repeat(LINE_MAX - 8) };
  assert.strictEqual(Buffer.byteLength(JSON.stringify(fit) + '\n'), LINE_MAX);
  await store.appendLine(f, fit);
  const sizeAfterFit = fs.statSync(f).size;
  await assert.rejects(() => store.appendLine(f, over), (e) => e instanceof RangeError);
  assert.strictEqual(fs.statSync(f).size, sizeAfterFit, 'an oversized record writes nothing');
});

test('S-003: a short write throws EIO and fd.sync() runs before resolving', async () => {
  const d = tmpdir(); const f = path.join(d, 'ledger.jsonl');
  const realOpen = fsp.open;
  let synced = 0, closed = 0, writes = 0;

  // success path: exactly one write(), one sync(), one close()
  fsp.open = async (...a) => {
    const fd = await realOpen(...a);
    return {
      write: (...w) => { writes++; return fd.write(...w); },
      sync: () => { synced++; return fd.sync(); },
      close: () => { closed++; return fd.close(); },
    };
  };
  try {
    await store.appendLineUnqueued(f, { ok: 1 });
    assert.strictEqual(writes, 1, 'a single write() of the whole line');
    assert.strictEqual(synced, 1, 'durable before it resolves');
    assert.strictEqual(closed, 1);

    // short write: throws EIO. Note we do NOT assert "nothing was appended" — a short write may
    // have put bytesWritten bytes on disk, and appendLineUnqueued throws rather than rolling back.
    fsp.open = async (...a) => {
      const fd = await realOpen(...a);
      return {
        write: async (s) => { await fd.write(s.slice(0, 3), null, 'utf8'); return { bytesWritten: 3 }; },
        sync: () => fd.sync(),
        close: () => fd.close(),
      };
    };
    await assert.rejects(() => store.appendLineUnqueued(f, { ok: 2 }), (e) => e.code === 'EIO');
  } finally {
    fsp.open = realOpen;
  }
});

test('S-003: writeTextAtomic writes bytes exactly; writeJsonAtomic cannot', async () => {
  const d = tmpdir();
  const seed = '/radar-handoff\n\nMISSION: finish "PROJ-108"\n`backtick` $HOME\n';
  const a = path.join(d, 'seed.md'); const b = path.join(d, 'seed.json');
  await store.writeTextAtomic(a, seed);
  await store.writeJsonAtomic(b, seed);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), seed, 'byte-exact Markdown');
  assert.notStrictEqual(fs.readFileSync(b, 'utf8'), seed, 'JSON quoting mangles it — why the pair exists');
  // temp+rename, not truncate-in-place
  const realRename = fsp.rename; let renamed = 0;
  fsp.rename = (...x) => { renamed++; return realRename(...x); };
  try { await store.writeTextAtomicUnqueued(a, 'x'); } finally { fsp.rename = realRename; }
  assert.strictEqual(renamed, 1);
});

test('S-003: normalizeConfig carries all ELEVEN p6 keys with the measured num() convention', () => {
  const base = { repos: [{ id: 'r', path: '/tmp' }] };
  const keys = ['polyrepoRoot', 'claudeBin', 'serverBaseUrl', 'serverTokenRef', 'captureQuietMs',
    'sessionQuietMs', 'goneGraceMs', 'confirmMs', 'discardKillMs', 'previewTtlMs', 'seedMaxBytes'];
  assert.strictEqual(keys.length, 11);

  // defaults survive normalization (the whitelist actually lists them)
  const d = normalizeConfig(base).config;
  for (const k of keys) assert.ok(k in d, `${k} dropped by the whitelist`);
  assert.strictEqual(d.goneGraceMs, 600000);
  assert.strictEqual(d.seedMaxBytes, 12288);
  assert.strictEqual(d.serverTokenRef, 'SERVER_TOKEN');

  // a valid override survives
  const o = normalizeConfig({ ...base, goneGraceMs: 30000, polyrepoRoot: '/x' }).config;
  assert.strictEqual(o.goneGraceMs, 30000);
  assert.strictEqual(o.polyrepoRoot, '/x');

  // MEASURED convention: silent clamp, default only on non-finite, and NEVER an issue.
  const hi = normalizeConfig({ ...base, confirmMs: 99999999 });
  assert.strictEqual(hi.config.confirmMs, 120000, 'clamped to max');
  assert.deepStrictEqual(hi.issues.filter((i) => /confirmMs/.test(i)), [], 'no issue is pushed');
  const lo = normalizeConfig({ ...base, discardKillMs: -5 });
  assert.strictEqual(lo.config.discardKillMs, 250, 'clamped to min');
  const nan = normalizeConfig({ ...base, previewTtlMs: 'abc' });
  assert.strictEqual(nan.config.previewTtlMs, DEFAULTS.previewTtlMs, 'non-finite falls back');
  const nul = normalizeConfig({ ...base, sessionQuietMs: null });
  assert.strictEqual(nul.config.sessionQuietMs, 1000, 'Number(null) is 0, which is finite -> clamps to min');

  // strings: non-empty trimmed wins, anything else defaults, no issue
  assert.strictEqual(normalizeConfig({ ...base, serverBaseUrl: '  ' }).config.serverBaseUrl, DEFAULTS.serverBaseUrl);
  assert.strictEqual(normalizeConfig({ ...base, serverBaseUrl: 42 }).config.serverBaseUrl, DEFAULTS.serverBaseUrl);
  assert.strictEqual(normalizeConfig({ ...base, claudeBin: ' /bin/x ' }).config.claudeBin, '/bin/x');
});
