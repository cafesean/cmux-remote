#!/usr/bin/env node
'use strict';
// The thing a Claude Code hook actually invokes. Reads the hook payload on stdin, appends one
// normalized NDJSON line to ~/.radar/events/<UTC-day>.ndjson, exits.
//
// This process runs INSIDE the operator's every Claude session, on Notification / UserPromptSubmit / Stop.
// That makes two rules absolute:
//
//   1. IT NEVER FAILS LOUDLY. Every path exits 0 with empty stdout. A hook that writes to stdout can
//      inject text into the session; a hook that exits non-zero can surface an error banner (and on
//      a decision hook like PermissionRequest, interfere with the permission flow itself). Radar is
//      an observer. An observer that can break the thing it observes is a defect, not a feature.
//   2. IT IS FAST AND BOUNDED. stdin is capped, the write is a single append, and pruning only runs
//      when the day rolls over (a readdir on every keystroke-adjacent hook would be silly).
//
// Install is human-gated — see radar/HOOK-INSTALL.md for the verbatim settings.json entries.
//
// Env:
//   RADAR_DIR   override ~/.radar (used by the tests)
//   RADAR_HOOK_DEBUG=1   write failures to ~/.radar/hook-receiver.log instead of swallowing them
const fs = require('fs');
const path = require('path');
const { appendEventSync, defaultRadarDir, eventsDir, pruneEvents, utcDay } = require('./eventlog');

const STDIN_CAP = 256 * 1024;   // hook payloads are small; tool_input on a big file is not

function debug(msg) {
  if (process.env.RADAR_HOOK_DEBUG !== '1') return;
  try {
    const dir = defaultRadarDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-receiver.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch (_) { /* even the debug path stays silent */ }
}

// Prune at most once per UTC day, tracked by a stamp file. The receiver is the only process
// guaranteed to run on every machine that produces events, so it is the right place to do it —
// but it must cost nothing on the 99.9% of invocations where there is nothing to delete.
function maybePrune(radarDir, now) {
  const stamp = path.join(radarDir, '.events-pruned');
  const today = utcDay(now);
  try {
    if (fs.readFileSync(stamp, 'utf8').trim() === today) return;
  } catch (_) { /* missing stamp = first run today */ }
  try { fs.mkdirSync(radarDir, { recursive: true }); fs.writeFileSync(stamp, today, 'utf8'); } catch (_) { return; }
  pruneEvents({ eventsDir: eventsDir(radarDir), now }).catch((e) => debug(`prune: ${e && e.message}`));
}

// cmux exports the hosting tab's identity into every process it launches, so a hook fired by a
// session running in a cmux tab inherits it. Reading it here is the difference between Jump knowing
// the tab and Jump guessing from a cwd that three workspaces share. Empty for a session started
// outside cmux — recorded as absent, never faked.
function cmuxIdentity(env) {
  const e = env || {};
  const pick = (...names) => {
    for (const n of names) { const v = e[n]; if (typeof v === 'string' && v.trim()) return v.trim(); }
    return '';
  };
  return {
    surfaceId: pick('CMUX_SURFACE_ID', 'SUPACODE_SURFACE_ID', 'CMUX_PANEL_ID'),
    tabId: pick('CMUX_TAB_ID', 'SUPACODE_TAB_ID'),
    workspaceId: pick('CMUX_WORKSPACE_ID', 'SUPACODE_WORKTREE_ID'),
  };
}

function handle(text) {
  let payload;
  try { payload = JSON.parse(text || '{}'); } catch (e) { return debug(`bad stdin json: ${e.message}`); }
  // Hook payload first, environment second: a payload that already names a surface wins, so a
  // replayed or forwarded event is never relabelled with THIS process's tab.
  const ident = cmuxIdentity(process.env);
  for (const k of ['surfaceId', 'tabId', 'workspaceId']) {
    if (ident[k] && !payload[k] && !payload[k === 'surfaceId' ? 'surface_id' : k === 'tabId' ? 'tab_id' : 'workspace_id']) payload[k] = ident[k];
  }
  const now = Date.now();
  const radarDir = defaultRadarDir();
  try {
    const ev = appendEventSync(radarDir, payload, now);
    if (!ev) return debug(`payload lacked session_id/hook_event_name: ${text.slice(0, 200)}`);
  } catch (e) {
    return debug(`append: ${e && e.message}`);
  }
  maybePrune(radarDir, now);
}

function main() {
  let buf = '';
  let over = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    if (over) return;
    buf += c;
    if (buf.length > STDIN_CAP) { over = true; buf = ''; debug('stdin over cap; dropped'); }
  });
  process.stdin.on('error', (e) => debug(`stdin: ${e && e.message}`));
  process.stdin.on('end', () => { if (!over) { try { handle(buf); } catch (e) { debug(`handle: ${e && e.message}`); } } });
}

if (require.main === module) {
  // Belt and braces: whatever happens above, this process exits 0 and prints nothing.
  process.on('uncaughtException', (e) => { debug(`uncaught: ${e && e.message}`); process.exit(0); });
  process.on('unhandledRejection', (e) => { debug(`unhandled: ${e && e.message}`); });
  process.exitCode = 0;
  main();
}

module.exports = { handle, maybePrune, cmuxIdentity, STDIN_CAP };
