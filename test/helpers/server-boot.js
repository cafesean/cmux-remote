'use strict';
// Boots a REAL server.js child on an ephemeral port. The radar wiring tests are about what the
// shipped server does, and the only way to know that is to run it.
//
// Two deliberate isolations, both of which have bitten this kind of test before:
//   * cwd is a scratch dir, never the repo — loadenv.js reads ./.env from the CWD, so a test run
//     inside the repo would silently inherit the developer's real SERVER_TOKEN, PORT and machine
//     registry, and "the test passed" would mean nothing.
//   * HOME points at the scratch dir, so anything that falls back to os.homedir() (radar's default
//     ~/.radar) lands in the temp tree. No test can touch the real radar state.
//
// (This file lives under test/ but declares no tests; `node --test` treats it as a file with zero
// subtests, which passes.)
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER_JS = path.join(REPO, 'server.js');
const BOOT_TIMEOUT_MS = 20000;

async function bootServer(opts) {
  const o = opts || {};
  const cwd = o.cwd || (await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cmux-boot-'))));
  const env = Object.assign(
    { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR || '/tmp', PORT: '0', HOST: '127.0.0.1' },
    o.env || {},
  );
  const child = spawn(process.execPath, [...(o.nodeArgs || []), SERVER_JS], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const port = await new Promise((resolve, reject) => {
    const fail = (m) => reject(new Error(`${m}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    const timer = setTimeout(() => fail(`server did not announce a port in ${BOOT_TIMEOUT_MS}ms`), BOOT_TIMEOUT_MS);
    const check = () => {
      const m = /cmux-remote server on http:\/\/[^:\s]+:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', check);
    child.on('exit', (code, signal) => { clearTimeout(timer); fail(`server exited early (code=${code} signal=${signal})`); });
    child.on('error', (e) => { clearTimeout(timer); fail(`spawn failed: ${e.message}`); });
    check();
  });

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  return {
    port,
    cwd,
    child,
    base: `http://127.0.0.1:${port}`,
    stdout: () => out,
    stderr: () => err,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
      await exited;
      clearTimeout(hard);
    },
  };
}

// Small fetch wrapper: returns status + parsed body without throwing on a non-JSON payload, because
// what a route ANSWERS on a bad day is exactly what these tests are checking.
async function call(base, method, pathAndQuery, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers);
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}${pathAndQuery}`, {
    method,
    headers,
    body: o.body === undefined ? undefined : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON — keep the text */ }
  return { status: r.status, json, text };
}

module.exports = { bootServer, call, REPO, SERVER_JS };
