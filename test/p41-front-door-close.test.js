'use strict';
// p41 D303: behind the Bun front door, node:http emitted neither req nor res 'close' when a client left,
// so every thread-stream slot leaked until the 32-stream cap answered 429 and every pane read
// "slow to answer". The fixture runs under Bun; skipped when no bun binary is found.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BUN = [process.env.BUN_BIN, path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun'].find((p) => p && fs.existsSync(p));
const FIXTURE = path.join(__dirname, 'fixtures', 'front-door-close.js');

test('D303: a client that leaves an SSE stream frees its slot under the Bun front door', { skip: !BUN && 'no bun' }, () => {
  const out = execFileSync(BUN, [FIXTURE], { timeout: 20000 }).toString().trim().split('\n').pop();
  assert.deepStrictEqual(JSON.parse(out), { leaked: 0 });
});

test('k104: a POST that read its body and waits past the gone poll keeps its client (no false close) under Bun', { skip: !BUN && 'no bun' }, () => {
  const out = execFileSync(BUN, [path.join(__dirname, 'fixtures', 'front-door-post-wait.js')], { timeout: 20000 }).toString().trim().split('\n').pop();
  assert.deepStrictEqual(JSON.parse(out), { status: 200, falseClose: false });
});

test('k104: watchGone ignores req.destroyed once the body was read to the end', async () => {
  const { EventEmitter } = require('events');
  const { watchGone } = require('../lib/front-door');
  const req = new EventEmitter(); const res = new EventEmitter();
  req.destroyed = true; req.complete = true; res.socket = { destroyed: false };
  let n = 0;
  res.on('close', () => n++);
  watchGone(req, res, 10);
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(n, 0);
  req.complete = false;                       // cut off mid-body: that client is gone
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(n, 1);
});

test('D303: watchGone emits res then req close once, on finish', async () => {
  const { EventEmitter } = require('events');
  const { watchGone } = require('../lib/front-door');
  const req = new EventEmitter(); const res = new EventEmitter();
  const seen = [];
  req.on('close', () => seen.push('req')); res.on('close', () => seen.push('res'));
  watchGone(req, res, 10);
  res.emit('finish');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(seen, ['res', 'req']);
});

test('D303: watchGone emits close when the socket is gone, and never twice', async () => {
  const { EventEmitter } = require('events');
  const { watchGone } = require('../lib/front-door');
  const req = new EventEmitter(); const res = new EventEmitter();
  res.socket = { destroyed: false };
  let n = 0;
  res.on('close', () => n++);
  watchGone(req, res, 10);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(n, 0);
  res.socket.destroyed = true;
  await new Promise((r) => setTimeout(r, 40));
  res.emit('finish');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(n, 1);
});
