'use strict';
// p41 D121 — "Not sent: fetch failed: The network connection was lost" during a deploy restart.
// The app now retries a send by itself with the same sendId; the server must type it only once,
// also when the retry lands on a NEW server process (the reply to the first attempt was lost).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootServer } = require('./helpers/server-boot');
const { createSendIdem, validId, idemId } = require('../lib/send-idem');

const SECRET = 'd121-secret-value';
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd121-')), 'send-ids.json');

function stubBridge() {
  const sends = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/cmux/send')) sends.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    sends, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(() => c())),
  })));
}
const post = async (base, body) => {
  const r = await fetch(`${base}/api/cmux/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('D121 store: a 2xx is remembered, a repeat does not run fn again', async () => {
  const s = createSendIdem({ file: tmpFile() });
  let n = 0;
  const fn = async () => { n++; return { status: 200, body: { ok: true } }; };
  const a = await s.run('k1', fn);
  const b = await s.run('k1', fn);
  assert.equal(n, 1);
  assert.equal(a.duplicate, undefined);
  assert.equal(b.duplicate, true);
  assert.deepEqual(b.body, { ok: true });
});

test('D121 store: concurrent repeats share the one in-flight send', async () => {
  const s = createSendIdem({ file: tmpFile() });
  let n = 0;
  let release;
  const fn = () => { n++; return new Promise((r) => { release = () => r({ status: 200, body: { ok: true } }); }); };
  const a = s.run('k', fn);
  const b = s.run('k', fn);
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(n, 1);
  assert.equal(ra.status, 200);
  assert.equal(rb.duplicate, true);
});

test('D121 store: a failed send is forgotten so the retry really sends', async () => {
  const s = createSendIdem({ file: tmpFile() });
  let n = 0;
  await s.run('k', async () => { n++; return { status: 503, body: { error: 'bridge_restarting' } }; });
  await assert.rejects(s.run('k', async () => { n++; throw new Error('ECONNREFUSED'); }));
  const r = await s.run('k', async () => { n++; return { status: 200, body: { ok: true } }; });
  assert.equal(n, 3);
  assert.equal(r.duplicate, undefined);
});

test('D121 store: persists across a re-created store; cap + TTL prune', async () => {
  const file = tmpFile();
  let t = 1000;
  const s1 = createSendIdem({ file, max: 3, ttlMs: 60000, now: () => t });
  for (const k of ['a', 'b', 'c', 'd']) await s1.run(k, async () => ({ status: 200, body: { ok: true } }));
  assert.equal(s1.size(), 3);   // 'a' dropped (cap)
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /text/);
  let n = 0;
  const s2 = createSendIdem({ file, max: 3, ttlMs: 60000, now: () => t });
  assert.equal((await s2.run('d', async () => { n++; return { status: 200, body: {} }; })).duplicate, true);
  await s2.run('a', async () => { n++; return { status: 200, body: {} }; });
  assert.equal(n, 1);   // 'a' was capped out, so it sent
  t += 60001;
  const s3 = createSendIdem({ file, max: 3, ttlMs: 60000, now: () => t });
  assert.equal(s3.size(), 0);   // all expired
});

test('D121 ids: format check and per machine + surface scope', () => {
  assert.ok(validId('3f2b8c1e-9d4a-4e7b-8c2f-1a2b3c4d5e6f'));
  assert.ok(!validId('short'));
  assert.ok(!validId('has space in it'));
  assert.ok(!validId(42));
  assert.notEqual(idemId('m1', 's1', 'x'), idemId('m1', 's2', 'x'));
  assert.notEqual(idemId('m1', 's1', 'x'), idemId('m2', 's1', 'x'));
});

test('D121 route: the same sendId is typed once, also after a server restart', async (t) => {
  const up = await stubBridge();
  const file = tmpFile();
  const env = { CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: SECRET, PUSH_ENABLED: '0', SEND_IDS_FILE: file };
  let srv = await bootServer({ env });
  t.after(async () => { await srv.stop(); await up.close(); });
  const msg = { surface: 's1', text: 'hello', submit: true, sendId: 'aaaaaaaa-1111-4222-8333-444444444444' };

  const a = await post(srv.base, msg);
  assert.equal(a.status, 200);
  assert.equal(a.body.duplicate, undefined);
  const b = await post(srv.base, msg);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(up.sends.length, 1);

  await srv.stop();
  srv = await bootServer({ env });   // deploy restart: a new process, same state file
  const c = await post(srv.base, msg);
  assert.equal(c.status, 200);
  assert.equal(c.body.duplicate, true);
  assert.equal(up.sends.length, 1, 'a retry after the restart must not type the text again');

  // another message (new sendId) and the old no-id path still send
  assert.equal((await post(srv.base, { ...msg, sendId: 'bbbbbbbb-1111-4222-8333-444444444444' })).status, 200);
  assert.equal((await post(srv.base, { surface: 's1', text: 'legacy', submit: true })).status, 200);
  assert.equal(up.sends.length, 3);
  assert.ok(up.sends.every((s) => !('sendId' in s)), 'sendId is not forwarded to the bridge');

  assert.equal((await post(srv.base, { ...msg, sendId: 'bad id' })).status, 400);
  assert.equal(up.sends.length, 3);
});
