'use strict';
// p41 D136 — runs native/ax-dialogs.swift (Accessibility read/press/focus for Mac dialogs). Source only in the
// repo; compiled lazily ONCE per source hash into ~/Library/Caches/cmux-remote/ax-dialogs-<sha12> and reused.
// Spawned by the bridge, so TCC responsibility stays with the bridge's node (the helper re-checks
// AXIsProcessTrusted). One JSON request on stdin, one JSON answer on stdout; never carries typed text.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const AX_HELPER_BUILD_TIMEOUT_MS = 60000;   // one `xcrun swiftc -O` (nice 15); killed after
const AX_HELPER_RUN_TIMEOUT_MS = 5000;      // one helper run; killed after
const AX_HELPER_OUT_MAX = 64 * 1024;        // helper stdout kept
const LIMITS = { AX_HELPER_BUILD_TIMEOUT_MS, AX_HELPER_RUN_TIMEOUT_MS, AX_HELPER_OUT_MAX };
const SRC = path.join(__dirname, '..', 'native', 'ax-dialogs.swift');

function createAxHelper({ env = process.env, childEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }), log = (m) => console.error(m) } = {}) {
  let built = null;   // Promise<{ bin } | { err }> — one build per process; a failed build is not retried
  let readyBin = null; // set once a usable binary is known (cached on disk or just built)
  function ensure() {
    if (env.AX_HELPER_BIN) return Promise.resolve({ bin: env.AX_HELPER_BIN });   // tests / prebuilt
    if (built) return built;
    built = new Promise((resolve) => {
      let src; try { src = fs.readFileSync(SRC); } catch (_) { return resolve({ err: 'helper_build_failed' }); }
      const sha = crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
      const dir = path.join(os.homedir(), 'Library', 'Caches', 'cmux-remote');
      const bin = path.join(dir, 'ax-dialogs-' + sha);
      try { fs.accessSync(bin, fs.constants.X_OK); readyBin = bin; return resolve({ bin }); } catch (_) {}
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
      const tmp = bin + '.tmp' + process.pid, t0 = Date.now();
      execFile('/usr/bin/nice', ['-n', '15', '/usr/bin/xcrun', 'swiftc', '-O', '-o', tmp, SRC],
        { timeout: AX_HELPER_BUILD_TIMEOUT_MS, env: childEnv() }, (e) => {
          if (e) { log(`ax-helper: build failed ${e.code || e.signal || 'error'} after ${Date.now() - t0} ms`); try { fs.unlinkSync(tmp); } catch (_) {} return resolve({ err: 'helper_build_failed' }); }
          try { fs.renameSync(tmp, bin); } catch (_) { return resolve({ err: 'helper_build_failed' }); }
          log(`ax-helper: built ${path.basename(bin)} in ${Date.now() - t0} ms`);
          readyBin = bin;
          resolve({ bin });
        });
    });
    return built;
  }
  // p41 D206: true when run() would spawn at once (no swiftc build to wait for). Starts the build in the
  // background on first call (the cache-hit check is synchronous, so a prebuilt binary reads ready at once).
  // Callers that must answer fast (focusSecure on every screen frame) skip the helper while this is false.
  function ready() {
    if (env.AX_HELPER_BIN) return true;
    ensure();
    return readyBin !== null;
  }
  // req -> Promise<object> (helper answer, or { error })
  async function run(req) {
    const b = await ensure();
    if (b.err) return { error: b.err };
    return new Promise((resolve) => {
      let out = '', done = false, c, t;
      const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
      try { c = spawn(b.bin, [], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { return fin({ error: 'helper_failed' }); }
      t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) {} fin({ error: 'helper_timeout' }); }, AX_HELPER_RUN_TIMEOUT_MS);
      c.stdout.on('data', (d) => { if (out.length < AX_HELPER_OUT_MAX) out += d; });
      c.on('error', () => fin({ error: 'helper_failed' }));
      c.on('close', () => { let j = null; try { j = JSON.parse(out); } catch (_) {} fin(j && typeof j === 'object' ? j : { error: 'helper_failed' }); });
      c.stdin.on('error', () => {});
      c.stdin.end(JSON.stringify(req));
    });
  }
  return { run, ensure, ready };
}

module.exports = { createAxHelper, LIMITS, SRC };
