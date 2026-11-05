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
  assert.ok(r.text.includes('sk-ant-****'));
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
  assert.ok(text.includes('sk-ant-****'));
});

// ---- review r1: wrapped rows, grids, other senders ------------------------------------------------
const { redactRows, redactText, redactGrid } = require('../lib/redact-tokens');
const { isDeniedPath } = require('../lib/secret-paths');
const BODY = 'Z'.repeat(60);
const TOK = 'sk-ant-oat01-' + BODY;
// a terminal of width w: hard-wrap a logical line into rows
const wrap = (line, w) => line.match(new RegExp(`.{1,${w}}`, 'g'));

test('redactText: token wrapped inside the prefix is masked across rows', () => {
  const t = [...wrap('CLAUDE_CODE_OAUTH_TOKEN=' + TOK, 32), '$ '].join('\n');   // row 1 ends in `sk-ant-o`
  assert.ok(t.split('\n')[0].endsWith('sk-ant-o'));
  const r = redactText(t);
  assert.ok(!r.includes(BODY.slice(0, 20)), r);
  assert.equal(r.split('\n').length, t.split('\n').length, 'row count kept');
  assert.equal(r.length, t.length, 'length kept (layout)');
});

test('redactText: token wrapped inside the body is masked on both rows', () => {
  const t = [...wrap('x ' + TOK, 32), 'done'].join('\n');
  const r = redactText(t);
  assert.ok(!/Z{6}/.test(r), r);
  assert.ok(r.endsWith('\ndone'), 'a short row after the token is not masked');
});

test('redactRows: per-row array in, same shape out', () => {
  const rows = [...wrap('a ' + TOK, 30), 'plain'];
  const r = redactRows(rows);
  assert.equal(r.length, rows.length);
  assert.ok(!r.join('').includes(BODY.slice(0, 10)));
  assert.equal(r[r.length - 1], 'plain');
});

test('redactGrid: token split over two grid rows and two spans is masked', () => {
  const grid = { columns: 20, rows: 3, styles: [], cursor: null, spans: [
    { row: 0, column: 0, style_id: 0, text: 'TOKEN=' }, { row: 0, column: 6, style_id: 1, text: TOK.slice(0, 14) },
    { row: 1, column: 0, style_id: 1, text: TOK.slice(14, 34) }, { row: 2, column: 0, style_id: 1, text: TOK.slice(34) } ] };
  const g = redactGrid(grid);
  assert.ok(!JSON.stringify(g).includes(BODY.slice(0, 8)), JSON.stringify(g));
  assert.equal(g.spans[0].text, 'TOKEN=');
  g.spans.forEach((s, i) => assert.equal(s.text.length, grid.spans[i].text.length, 'cell widths kept'));
});

test('redactGrid: a row that is not full does not join the next row', () => {
  const grid = { columns: 80, rows: 2, styles: [], cursor: null, spans: [
    { row: 0, column: 0, style_id: 0, text: 'echo sk-ant-' }, { row: 1, column: 0, style_id: 0, text: 'docs-are-here-and-long' } ] };
  assert.deepEqual(redactGrid(grid).spans, grid.spans);
});

test('server.js, radar-server.js sendJson + server relay + alerts payload redact', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const fnBody = (s, name) => { const i = s.indexOf(`function ${name}(`); return s.slice(i, s.indexOf('\n}\n', i)); };
  for (const [f, fn] of [['server.js', 'sendJson'], ['server.js', 'relay'], ['radar-server.js', 'sendJson']]) {
    assert.match(fnBody(src(f), fn), /redactTokens\(/, `${f} ${fn}`);
  }
  const { createAlerts } = require('../lib/alerts');
  const a = createAlerts({ machines: [{ id: 'm', label: 'M' }], send: async () => {}, log: () => {} });
  const p = a._payloadFor({ id: 'm', label: 'M' }, { id: 'n', title: 'NEEDS YOU', body: 'key ' + TOK, surface_id: 's' });
  assert.ok(!JSON.stringify(p).includes(BODY.slice(0, 10)), JSON.stringify(p));
});

test('secret-paths: env files, shell history and common credential files denied; examples allowed', () => {
  const h = '/Users/someone';
  for (const rel of ['proj/.env', 'proj/.env.local', 'proj/.env.production', '.zsh_history', '.bash_history', 'proj/.python_history',
    '.netrc', '.npmrc', '.git-credentials', '.pgpass', '.aws/credentials', '.aws/config', '.docker/config.json']) {
    assert.equal(isDeniedPath(path.join(h, rel), h), true, rel);
  }
  for (const rel of ['proj/.env.example', 'proj/.env.sample', 'proj/.env.template', 'proj/env.ts', 'proj/.envrc.md']) {
    assert.equal(isDeniedPath(path.join(h, rel), h), false, rel);
  }
});

// ---- review r2 P2: widths are display cells, not UTF-16 units ---------------------------------------
test('redactRows: a ZWJ emoji row does not stop full rows from joining', () => {
  const W = 30;
  const emoji = '🧑🏻‍💻';                                   // 2 cells, 7 UTF-16 units
  const rows = [(emoji + ' ').repeat(5), ...wrap('key ' + TOK, W), '$'];   // emoji row: 15 cells, 40 UTF-16 units > W
  const r = redactRows(rows);
  assert.ok(!r.join('').includes(BODY.slice(0, 12)), r.join('\n'));
  assert.equal(r[r.length - 1], '$');
});

test('redactGrid: CJK before a token still lets a full row join the next', () => {
  const cols = 20;
  const cjk = '日本語テスト';                                   // 6 chars, 12 cells
  const head = TOK.slice(0, 8);                                // fills the row to 20 cells
  const grid = { columns: cols, rows: 3, styles: [], cursor: null, spans: [
    { row: 0, column: 0, style_id: 0, text: cjk, cell_width: 12 },
    { row: 0, column: 12, style_id: 1, text: head, cell_width: 8 },
    { row: 1, column: 0, style_id: 1, text: TOK.slice(8, 28), cell_width: 20 },
    { row: 2, column: 0, style_id: 1, text: TOK.slice(28), cell_width: TOK.length - 28 } ] };
  const g = redactGrid(grid);
  assert.ok(!JSON.stringify(g.spans).includes(BODY.slice(0, 8)), JSON.stringify(g.spans));
  assert.equal(g.spans[0].text, cjk);
});

test('redactGrid: CJK width known only from the text (no cell_width) also joins', () => {
  const grid = { columns: 20, rows: 2, styles: [], cursor: null, spans: [
    { row: 0, column: 0, style_id: 0, text: '日本語テスト' + TOK.slice(0, 8) },
    { row: 1, column: 0, style_id: 0, text: TOK.slice(8) } ] };
  assert.ok(!JSON.stringify(redactGrid(grid).spans).includes(BODY.slice(0, 8)));
});

test('redactText: emoji before a token on the same row masks the token, not a shifted slice', () => {
  const t = '🧑🏻‍💻 key ' + TOK;
  const r = redactText(t);
  assert.ok(!r.includes(BODY.slice(0, 12)), r);
  assert.ok(r.startsWith('🧑🏻‍💻 key sk-ant-*'), r);
});
