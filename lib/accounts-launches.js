'use strict';
// D154 (HMX-56) — which Claude Code session ran on which account. bin/hypermux-claude appends one
// line per launch BEFORE it execs claude (exec keeps the pid): {account, pid, cwd, at, sessionId?}.
// sessionId is set when the launcher picked it (`--session-id`, a launch with no extra args); else the
// bridge resolves pid -> session through ~/.claude/sessions/<pid>.json while the session is live.
// No token, no env, no argv is written. File 0600, capped (oldest lines dropped).
// File ~/.config/cmux-remote/account-launches.jsonl (HYPERMUX_HOME aware); seam HYPERMUX_LAUNCHES_FILE.
const fs = require('fs');
const os = require('os');
const path = require('path');
const NAME_RE = /^[a-z][a-z0-9]{0,5}$/;
const SID_RE = /^[0-9a-f-]{36}$/;
const MAX_LINES = 1000;                 // accountLaunchesMax
const MAX_BYTES = 512 * 1024;           // accountLaunchesMaxBytes (trim trigger)

const filePath = () => process.env.HYPERMUX_LAUNCHES_FILE
  || require('./hm-home').statePath('account-launches.jsonl', path.join(os.homedir(), '.config', 'cmux-remote', 'account-launches.jsonl'));

function valid(r) {
  return r && NAME_RE.test(r.account) && Number.isInteger(r.pid) && r.pid > 0 && typeof r.cwd === 'string'
    && r.cwd.length < 4096 && Number.isFinite(r.at) && (r.sessionId == null || SID_RE.test(r.sessionId));
}

function read(file = filePath()) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (valid(r)) out.push(r); } catch (_) { /* skip */ }
  }
  return out;
}

function add(rec, file = filePath()) {
  const r = { account: rec.account, pid: Number(rec.pid), cwd: rec.cwd, at: rec.at || Date.now() };
  if (rec.sessionId) r.sessionId = rec.sessionId;
  if (!valid(r)) throw new Error('bad_launch');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(r) + '\n', { mode: 0o600 });
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      // keep the newest lines up to MAX_LINES and half the byte cap (so a trim is not re-run every add)
      const rows = read(file).map((x) => JSON.stringify(x));
      const kept = []; let bytes = 0;
      for (let i = rows.length - 1; i >= 0 && kept.length < MAX_LINES; i--) {
        if (bytes + rows[i].length + 1 > MAX_BYTES / 2) break;
        bytes += rows[i].length + 1; kept.unshift(rows[i]);
      }
      const keep = kept.join('\n') + (kept.length ? '\n' : '');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, keep, { mode: 0o600 }); fs.renameSync(tmp, file);
    }
  } catch (_) { /* trim is best effort */ }
}

module.exports = { read, add, filePath, MAX_LINES, MAX_BYTES };

// CLI (bin/hypermux-claude): node accounts-launches.js add <name> <pid> <cwd> [sessionId]
if (require.main === module) {
  const [op, account, pid, cwd, sessionId] = process.argv.slice(2);
  if (op !== 'add') process.exit(2);
  try { add({ account, pid, cwd, sessionId: sessionId || undefined }); } catch (_) { process.exit(1); }
}
