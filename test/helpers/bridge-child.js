'use strict';
// Boots a REAL bridge.js child on an EPHEMERAL port (BRIDGE_PORT=0) so S-004a is tested against
// the shipped file rather than a re-implementation of it.
//
// A cmux-remote bridge is live on :8799 on this machine and is what the operator's team actually uses. No
// test may bind that port, restart it, or send it a signal — hence port 0 and a private cwd/HOME.
// The bridge announces the port it BOUND, which is the only reason port 0 is usable here.
//
// The routes under test (/cmux/session-events) never shell out to cmux, so a child bridge is
// perfectly happy on a machine where cmux is absent.
//
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const BRIDGE_JS = path.join(REPO, 'bridge.js');
const BOOT_TIMEOUT_MS = 20000;

async function bootBridge(opts) {
  const o = opts || {};
  const cwd = o.cwd || (await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cmux-bridge-'))));
  const env = Object.assign(
    {
      PATH: process.env.PATH,
      HOME: cwd,                                   // any os.homedir() fallback lands in the scratch tree
      TMPDIR: process.env.TMPDIR || '/tmp',
      BRIDGE_PORT: '0',
      BRIDGE_HOST: '127.0.0.1',
      CMUX_BIN: path.join(cwd, 'no-such-cmux'),    // proves the new route is cmux-free
    },
    o.env || {},
  );
  const child = spawn(process.execPath, [BRIDGE_JS], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const port = await new Promise((resolve, reject) => {
    const fail = (m) => reject(new Error(`${m}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    const timer = setTimeout(() => fail(`bridge did not announce a port in ${BOOT_TIMEOUT_MS}ms`), BOOT_TIMEOUT_MS);
    const check = () => {
      const m = /cmux-remote bridge on [^:\s]+:(\d+)/.exec(out);
      if (m && Number(m[1]) > 0) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', check);
    child.on('exit', (code, signal) => { clearTimeout(timer); fail(`bridge exited early (code=${code} signal=${signal})`); });
    child.on('error', (e) => { clearTimeout(timer); fail(`spawn failed: ${e.message}`); });
    check();
  });

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  return {
    port, cwd, child,
    base: `http://127.0.0.1:${port}`,
    stdout: () => out,
    stderr: () => err,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
      await exited;
      clearTimeout(hard);
    },
  };
}

async function callBridge(base, pathAndQuery, opts) {
  const o = opts || {};
  const headers = {};
  if (o.secret) headers['x-bridge-secret'] = o.secret;
  const r = await fetch(`${base}${pathAndQuery}`, { method: o.method || 'GET', headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep the text */ }
  return { status: r.status, json, text };
}

module.exports = { bootBridge, callBridge, REPO, BRIDGE_JS };
