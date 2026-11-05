'use strict';
// p62 G1 M1: no child process inherits a secret. Behavioural checks for the radar children
// (classifier CLI, ssh) plus a source scan: every spawn/execFile/fork call site passes env.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const REPO = path.join(__dirname, '..');
const SECRET_KEYS = ['SERVER_TOKEN', 'BRIDGE_SECRET', 'BRIDGE_SECRET_MINI', 'CMUX_MACHINE_SECRET',
  'CMUX_MACHINE_ACCESS_SECRET', 'TUNNEL_TOKEN'];

function withSecretEnv(fn) {
  const saved = {};
  for (const k of SECRET_KEYS) { saved[k] = process.env[k]; process.env[k] = `p62-fixture-${k}`; }
  const restore = () => { for (const k of SECRET_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}
function assertNoSecrets(env, who) {
  assert.ok(env && typeof env === 'object', `${who}: env passed explicitly`);
  for (const k of SECRET_KEYS) assert.ok(!(k in env), `${who}: child env carries ${k}`);
  assert.equal(env.PATH, process.env.PATH, `${who}: ordinary env kept`);
}

test('radar classifier CLI child gets no secret', () => withSecretEnv(async () => {
  const { defaultRun } = require('../radar/classify');
  let seen = null;
  const fake = (bin, args, opts) => {
    seen = opts.env;
    const { EventEmitter } = require('events');
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    setImmediate(() => c.emit('close', 0, null));
    return c;
  };
  await defaultRun({ bin: '/bin/true', args: [], spawn: fake, timeoutMs: 1000 });
  assertNoSecrets(seen, 'classify');
}));

test('radar ssh deploy probe child gets no secret', () => withSecretEnv(async () => {
  const orig = childProcess.execFile;
  let seen = null;
  childProcess.execFile = (bin, args, opts, cb) => { seen = opts.env; setImmediate(() => cb(null, '', '')); };
  try {
    const { defaultSshExec } = require('../radar/mod-deploy');
    await defaultSshExec({ target: 'h', command: 'true', timeoutMs: 1000 });
  } finally { childProcess.execFile = orig; }
  assertNoSecrets(seen, 'mod-deploy ssh');
}));

// Every child_process call site in shipped code passes an explicit env (built from childEnv).
test('source scan: every spawn/execFile/fork call site passes env', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'test', '.git', 'vendor', '.superpowers', '.claude'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
    }
  };
  walk(REPO);
  const CALL = /(?:(?<![\w.$])|childProcess\.|cp\.)(spawn|execFile|fork|spawnSync|execFileSync|execSync)\(/g;
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      CALL.lastIndex = 0;
      let m;
      while ((m = CALL.exec(line))) {
        const before = line.slice(0, m.index);
        if (/function\s*$/.test(before) || /\bfunction\s+\w*$/.test(before)) continue;
        if (/['"`][^'"`]*$/.test(before)) continue;   // inside a string
        const win = lines.slice(Math.max(0, i - 2), i + 9).join('\n');
        if (!/\benv\b/.test(win)) bad.push(`${path.relative(REPO, f)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(bad, [], `call sites without env: ${bad.join(', ')}`);
});
