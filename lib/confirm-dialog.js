'use strict';
// confirm-dialog.js — the Allow click for local pairing (p41 D40 W1). The desktop app on this Mac asks
// the server for a device key with no credential; the server only hands one over after the person at
// the screen clicks Allow on a macOS dialog showing the same 4-digit number the app shows.
//
// createConfirm({ execFile, platform }) -> { available(), ask({ number, deviceName, timeoutMs, signal }) }
//   available()  cheap and cached: true on macOS, false elsewhere. Never spawns a process (hello reads it
//                on every probe).
//   ask(...)     Promise<'allow' | 'deny' | 'timeout' | 'unavailable'>. Never rejects. Anything that is
//                not a clear Allow click is not 'allow' (fails closed).
//
// The dialog runs as `osascript` in the server's own process context. The server runs as a per-user
// LaunchAgent (gui/<uid> domain), which can show a `display dialog` with no Automation (TCC) prompt,
// because osascript draws the dialog itself rather than telling another app to.
//
// The script text is FIXED. The number and the device name (user-supplied) are passed as arguments and
// read through `on run argv`: never interpolated into AppleScript source. Control characters in the name
// are flattened so it cannot draw a second "Number ..." line.
const childProcess = require('child_process');

const OSASCRIPT = '/usr/bin/osascript';
const NAME_SHOWN_MAX = 64;
const KILL_GRACE_MS = 5000;     // osascript gives up on its own; this only kills one that hangs

const SCRIPT = [
  'on run argv',
  'set n to item 1 of argv',
  'set d to item 2 of argv',
  'set msg to "HyperMux on this Mac wants to connect." & return & return & "Number " & n & return & return & "Device: " & d & return & return & "Allow only if the app shows this number."',
  'set r to display dialog msg with title "HyperMux" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after (item 3 of argv as integer)',
  'if gave up of r then return "gave up"',
  'return "button " & (button returned of r)',
  'end run',
];

// \p{Cf} too (W1 review 1): bidi overrides and zero-width characters could reorder the dialog text.
const shownName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ').trim().slice(0, NAME_SHOWN_MAX) || 'device';

function createConfirm({ execFile = childProcess.execFile, platform = process.platform } = {}) {
  const isMac = platform === 'darwin';

  // `signal` (optional AbortSignal): the server's deadline; aborting kills osascript and closes the dialog.
  function ask({ number, deviceName, timeoutMs, signal }) {
    if (!isMac) return Promise.resolve('unavailable');
    const secs = Math.max(1, Math.round((Number(timeoutMs) || 60000) / 1000));
    const args = [];
    for (const line of SCRIPT) args.push('-e', line);
    args.push(String(number), shownName(deviceName), String(secs));
    return new Promise((resolve) => {
      try {
        const opts = { timeout: secs * 1000 + KILL_GRACE_MS, killSignal: 'SIGKILL', windowsHide: true, env: require('./secrets-stdin').childEnv() };
        if (signal) opts.signal = signal;
        execFile(OSASCRIPT, args, opts, (err, stdout) => {
          if (err) {
            if (err.killed || err.signal || err.name === 'AbortError' || err.code === 'ABORT_ERR') return resolve('timeout');
            // -128 = "User canceled": Deny is the cancel button (also Esc).
            if (/\(-128\)/.test(String(err.message || '')) || /\(-128\)/.test(String(err.stderr || ''))) return resolve('deny');
            return resolve('unavailable');      // -1713 no UI, ENOENT, anything else
          }
          const out = String(stdout || '');
          if (/gave up:true|^gave up\s*$/m.test(out)) return resolve('timeout');
          if (/^button Allow\s*$/m.test(out) || /button returned:Allow, gave up:false/.test(out)) return resolve('allow');
          if (/^button Deny\s*$/m.test(out) || /button returned:Deny/.test(out)) return resolve('deny');
          return resolve('unavailable');
        });
      } catch (_) { resolve('unavailable'); }
    });
  }

  return { available: () => isMac, ask };
}

// A confirm that is always off: PAIR_LOCAL=off, and any context with no way to ask the person.
const disabledConfirm = Object.freeze({ available: () => false, ask: () => Promise.resolve('unavailable') });

module.exports = { createConfirm, disabledConfirm, SCRIPT };
