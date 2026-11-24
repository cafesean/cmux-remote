'use strict';
// CAD-991 (Sean 2026-11-24 m46): lib/account-setup.js is a library too — Cadra Desktop reuses
// storeAccount + the token capture helpers instead of a second copy. Loading it must not run the
// pane script; storeAccount writes through `security -i` on stdin and never returns the token.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = 'sk-ant-oat01-' + 'Q'.repeat(95);

// Fake `security`: items in kc.json; `-i` reads the add-generic-password line from stdin.
const FAKE_SECURITY = `#!/usr/bin/env node
const fs = require('fs');
const kc = process.env.FAKE_KC;
const read = () => { try { return JSON.parse(fs.readFileSync(kc, 'utf8')); } catch { return {}; } };
const a = process.argv.slice(2);
const svcOf = (args) => args[args.indexOf('-s') + 1];
if (a[0] === '-i') {
  let input = ''; process.stdin.on('data', (c) => { input += c; }); process.stdin.on('end', () => {
    const m = /add-generic-password .*-s "([^"]+)" .*-w (\\S+)/.exec(input);
    if (m) { const k = read(); k[m[1]] = m[2]; fs.writeFileSync(kc, JSON.stringify(k)); }
    fs.appendFileSync(kc + '.argv', JSON.stringify(a) + '\\n');
  });
  return;
}
fs.appendFileSync(kc + '.argv', JSON.stringify(a) + '\\n');
const k = read(); const s = svcOf(a);
if (a[0] === 'find-generic-password') process.exit(k[s] ? 0 : 44);
if (a[0] === 'delete-generic-password') { delete k[s]; fs.writeFileSync(kc, JSON.stringify(k)); process.exit(0); }
process.exit(1);
`;

function rig() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cad991-'));
  const sec = path.join(d, 'security');
  fs.writeFileSync(sec, FAKE_SECURITY, { mode: 0o755 });
  process.env.FAKE_KC = path.join(d, 'kc.json');
  process.env.HYPERMUX_ACCOUNTS_FILE = path.join(d, 'accounts.json');
  return { d, sec, kc: () => JSON.parse(fs.readFileSync(process.env.FAKE_KC, 'utf8')), argv: () => fs.readFileSync(process.env.FAKE_KC + '.argv', 'utf8') };
}

test('loading the module does not run the pane script', () => {
  const m = require('../lib/account-setup.js');
  for (const k of ['extractToken', 'safePrefix', 'storeAccount', 'TRIGGER_RE', 'TOKEN_RE', 'CAP']) assert.ok(m[k] !== undefined, k);
});

test('storeAccount stores the token via security -i on stdin (never argv) and records the fingerprint', async () => {
  const { storeAccount } = require('../lib/account-setup.js');
  const r = rig();
  const out = await storeAccount({ name: 'cadra', token: T, user: 'tester', secBin: r.sec, label: 'Cadra' });
  assert.deepStrictEqual(Object.keys(out).sort(), ['fp', 'ok']);
  assert.strictEqual(out.ok, true);
  assert.match(out.fp, /^[0-9a-f]{12}$/);
  assert.strictEqual(r.kc()['cos-claude-account-cadra'], T);
  assert.ok(!r.argv().includes(T), 'token never in any security argv');
  const meta = JSON.parse(fs.readFileSync(process.env.HYPERMUX_ACCOUNTS_FILE, 'utf8'));
  assert.strictEqual(meta.cadra.fp, out.fp);
});

test('storeAccount refuses an existing name, a bad name and a bad token, without echoing the token', async () => {
  const { storeAccount } = require('../lib/account-setup.js');
  const r = rig();
  assert.strictEqual((await storeAccount({ name: 'jet', token: T, user: 'tester', secBin: r.sec })).ok, true);
  const again = await storeAccount({ name: 'jet', token: T, user: 'tester', secBin: r.sec });
  assert.strictEqual(again.reason, 'exists');
  assert.strictEqual((await storeAccount({ name: 'Bad!', token: T, user: 'tester', secBin: r.sec })).reason, 'bad_name');
  assert.strictEqual((await storeAccount({ name: 'a', token: T, user: 'tester', secBin: r.sec })).reason, 'bad_name');
  const bad = await storeAccount({ name: 'xx', token: 'sk-ant-oat01-short', user: 'tester', secBin: r.sec });
  assert.strictEqual(bad.reason, 'bad_token');
  assert.ok(!JSON.stringify([again, bad]).includes(T));
});

test('storeAccount replace deletes the old item first, then adds', async () => {
  const { storeAccount } = require('../lib/account-setup.js');
  const r = rig();
  await storeAccount({ name: 'mux1', token: T, user: 'tester', secBin: r.sec });
  const T2 = 'sk-ant-oat01-' + 'R'.repeat(95);
  const out = await storeAccount({ name: 'mux1', token: T2, user: 'tester', secBin: r.sec, replace: true });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(r.kc()['cos-claude-account-mux1'], T2);
});
