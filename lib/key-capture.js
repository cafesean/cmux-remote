'use strict';
// HMX k110 step 2: system key combos (⌘Tab, ⌘⇧Tab, ⌘Space, ⌘`) for Remote Desktop, on the VIEWING Mac.
// macOS acts on these combos before any app sees them, so the HyprMux app cannot forward them itself. While a local
// viewer keeps asking (POST /api/keys/capture {on:true} every HEARTBEAT_MS), this module runs the hm-key-tap helper,
// which swallows exactly those combos; each one goes to the viewer over GET /api/keys/stream (SSE) and the viewer
// sends it to the remote Mac through its normal input path. Both routes are loopback-only (server.js).
//
// Safety: the helper runs only while heartbeats arrive. AUTO_OFF_MS after the last one (an app crash, a closed
// window, a lost focus) the helper is stopped, so the keyboard is never left captured. Without Accessibility the
// helper refuses ({kind:'error', need:'accessibility'}) and capture answers {on:false, need:'accessibility'}.
const path = require('path');
const fs = require('fs');
const { spawn: realSpawn } = require('child_process');

// LIMITS (_context/LIMITS.md): the app heartbeats every 1 s; 3 s without one = capture off.
const AUTO_OFF_MS = 3000;

function keyTapLookup(o = {}) {
  const env = o.env || process.env;
  const exists = o.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (env.KEY_TAP_BIN) return exists(env.KEY_TAP_BIN) ? env.KEY_TAP_BIN : null;
  const p = path.join(path.dirname(o.execPath || process.execPath), 'hm-key-tap');
  return exists(p) ? p : null;
}

function createKeyCapture(o = {}) {
  const spawn = o.spawn || realSpawn;
  const lookup = o.lookup || (() => keyTapLookup());
  const setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout;
  const log = o.log || (() => {});
  let child = null, ready = false, need = null, offTimer = null;
  const subs = new Set();   // SSE writers: (obj) => void

  const send = (obj) => { for (const w of subs) { try { w(obj); } catch (_) {} } };

  function stop(why) {
    if (offTimer) { clearT(offTimer); offTimer = null; }
    const c = child; child = null; ready = false;
    if (c) { try { c.stdin.end(); } catch (_) {} try { c.kill('SIGTERM'); } catch (_) {} log(`key-capture: off (${why})`); send({ kind: 'off', why }); }
  }

  function start() {
    const bin = lookup();
    if (!bin) { need = 'helper_missing'; return; }
    need = null;
    const c = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    child = c;
    let buf = '';
    c.stdout.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.kind === 'ready') { ready = true; log('key-capture: on'); send({ kind: 'on' }); }
        else if (m.kind === 'error') { need = m.need || 'error'; }
        else if (m.kind === 'combo' && typeof m.combo === 'string') send({ kind: 'combo', combo: m.combo });
      }
    });
    c.on('exit', () => { if (child === c) { child = null; ready = false; send({ kind: 'off', why: need || 'exit' }); } });
    c.on('error', () => { if (child === c) { child = null; ready = false; need = 'helper_missing'; } });
  }

  // POST /api/keys/capture {on}: on = heartbeat (start if needed, push the auto-off back); off = stop now.
  function capture(on) {
    if (!on) { stop('client'); return { on: false }; }
    if (need === 'accessibility' && !child) return { on: false, need };   // refused once: the viewer shows the AX line
    if (!child) start();
    if (offTimer) clearT(offTimer);
    offTimer = setT(() => { offTimer = null; stop('no_heartbeat'); }, AUTO_OFF_MS);
    if (offTimer && offTimer.unref) offTimer.unref();
    if (need && need !== 'accessibility' && !child) return { on: false, need };
    return need ? { on: false, need } : { on: true, ready };
  }

  // A grant made later (the user allowed Accessibility): the next capture after an explicit retry tries again.
  function retry() { if (!child) need = null; }

  function subscribe(write) { subs.add(write); return () => subs.delete(write); }

  return { capture, retry, subscribe, stop, state: () => ({ on: !!child, ready, need }), AUTO_OFF_MS };
}

module.exports = { createKeyCapture, keyTapLookup, AUTO_OFF_MS };
