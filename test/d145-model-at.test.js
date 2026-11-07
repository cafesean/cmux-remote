'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { contextUsage } = require('../sessions/status.js');

test('D145 contextUsage returns when the last model response came back, not the file mtime', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd145-'));
  const file = path.join(dir, 't.jsonl');
  const row = (o) => JSON.stringify(o);
  fs.writeFileSync(file, [
    row({ type: 'assistant', timestamp: '2026-11-07T01:00:00.000Z', message: { model: 'claude-opus-4-5', usage: { input_tokens: 1 } } }),
    // later non-model writes (title, snapshot) touch the file but are not model calls
    row({ type: 'custom-title', timestamp: '2026-11-07T07:00:00.000Z', customTitle: 'x' }),
    row({ type: 'file-history-snapshot', timestamp: '2026-11-07T07:01:00.000Z' }),
    row({ type: 'assistant', isSidechain: true, timestamp: '2026-11-07T06:00:00.000Z', message: { model: 'claude-opus-4-5', usage: { input_tokens: 5 } } }),
  ].join('\n'));
  try {
    const c = await contextUsage(file);
    assert.strictEqual(c.at, Date.parse('2026-11-07T01:00:00.000Z'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('D145 contextUsage: no timestamp on the record -> at null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd145-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1 } } }));
  try { assert.strictEqual((await contextUsage(file)).at, null); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
