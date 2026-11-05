'use strict';
// S2r: a Claude token (sk-ant-…) never leaves the Mac in a bridge reply — transcripts (session list,
// thread, thread stream) and terminal reads (screen snapshot, screen stream). Fixtures are obviously fake.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { redactTokens } = require('../lib/redact-tokens');
const { createSessionRoutes } = require('../sessions/routes');
const { bootBridge } = require('./helpers/bridge-child');

const FAKE = 'sk-ant-test-' + 'X'.repeat(24);
const FAKE2 = 'sk-ant-oat01-' + 'Y'.repeat(30);

test('redactTokens: masks every sk-ant- token, keeps the rest', () => {
  const s = `a ${FAKE} b "${FAKE2}" c`;
  const r = redactTokens(s);
  assert.ok(!r.includes(FAKE) && !r.includes(FAKE2), r);
  assert.equal(r, 'a sk-ant-…[redacted] b "sk-ant-…[redacted]" c');
  assert.equal(redactTokens(r), r, 'idempotent');
  assert.equal(redactTokens('sk-ant- is the prefix'), 'sk-ant- is the prefix', 'bare prefix kept');
  assert.equal(redactTokens(''), '');
  assert.equal(redactTokens(null), null);
});

// ---- sessions routes (transcripts) -----------------------------------------------------------
const row = (n, t) => JSON.stringify({ type: 'user', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  timestamp: new Date(1e12 + n).toISOString(), message: { role: 'user', content: t } }) + '\n';

function routes() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's2r-home-')));
  const dir = path.join(home, '.claude', 'projects', '-w'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sA.jsonl'); fs.writeFileSync(f, row(1, `my token is ${FAKE}`));
  const ev = [{ ts: Date.now() - 1000, sessionId: 'sA', event: 'Stop', transcriptPath: f, surfaceId: 'surface:1', cwd: '/w' }];
  return createSessionRoutes({ machineId: 'mini', backend: 'cmux', home, git: async () => null,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: [{ id: 'surface:1', ref: 'surface:1', title: 't', type: 'terminal' }] }],
    readEvents: async () => ({ events: ev, more: false }), procSnapshot: async () => ({ table: [], sessions: [] }) });
}
const call = (r, url) => new Promise((resolve) => {
  r.handle({ method: 'GET', headers: {}, on() {} }, { writeHead() {}, end: (b) => resolve(String(b)) }, new URL('http://x' + url));
});

test('sessions list: no token in the reply', async () => {
  const body = await call(routes(), '/cmux/sessions');
  assert.ok(!body.includes(FAKE), 'token leaked in /cmux/sessions');
});

test('session thread: no token in the reply, text otherwise kept', async () => {
  const r = routes();
  const list = JSON.parse(await call(r, '/cmux/sessions'));
  const id = encodeURIComponent(list.sessions[0].id);
  const body = await call(r, `/cmux/sessions/${id}/thread`);
  assert.ok(!body.includes(FAKE), 'token leaked in thread');
  assert.ok(body.includes('my token is sk-ant-…[redacted]'), body.slice(0, 300));
});

// ---- bridge terminal reads ---------------------------------------------------------------------
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
const args = process.argv.slice(2);
if (args.includes('read-screen')) { process.stdout.write('$ env\nCLAUDE_CODE_OAUTH_TOKEN=' + process.env.FAKE_TOKEN + '\n'); process.exit(0); }
process.stdout.write('{}'); process.exit(0);
`;
let bridge;
before(async () => {
  const cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2r-bridge-')));
  const bin = path.join(cwd, 'fake-cmux');
  await fsp.writeFile(bin, FAKE_CMUX, { mode: 0o755 });
  bridge = await bootBridge({ cwd, env: { CMUX_BIN: bin, FAKE_TOKEN: FAKE } });
});
after(async () => { if (bridge) await bridge.stop(); });

const get = (p) => fetch(bridge.base + p).then(async (r) => ({ status: r.status, text: await r.text() }));

test('bridge /cmux/screen: token masked in the snapshot', async () => {
  const r = await get('/cmux/screen?surface=surface:1');
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.text.includes(FAKE), 'token leaked in /cmux/screen');
  assert.ok(r.text.includes('sk-ant-…[redacted]'));
});

test('bridge /cmux/stream: token masked in the first screen event', async () => {
  const text = await new Promise((resolve, reject) => {
    const req = http.get(bridge.base + '/cmux/stream?surface=surface:1', (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = /^data: ([A-Za-z0-9+/=]+)$/m.exec(buf);
        if (m) { req.destroy(); resolve(Buffer.from(m[1], 'base64').toString('utf8')); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('no screen event')); }, 5000);
  });
  assert.ok(!text.includes(FAKE), 'token leaked in /cmux/stream');
  assert.ok(text.includes('sk-ant-…[redacted]'));
});
