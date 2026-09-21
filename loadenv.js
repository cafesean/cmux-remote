// Minimal .env loader — zero-dep. Reads a .env in the CWD (if present) and fills process.env,
// WITHOUT overriding vars already set in the real environment. Keeps secrets out of code/argv.
// Node 20.6+ can do this natively (`node --env-file=.env`); this keeps it working on Node 18 too.
const fs = require('fs');
const path = require('path');
// p19: names whose non-empty .env value was NOT applied because the real environment already had the
// variable set to an EMPTY (blank) string. The rule above is unchanged — the environment still wins;
// bridge.js/server.js only use this to refuse `BRIDGE_SOCKET=` / `SERVER_SOCKET=` left empty in the
// environment, which would otherwise hide the .env socket path and start silently on TCP. Names only.
const emptyShadowed = [];
const setBefore = new Set(Object.keys(process.env));
try {
  const text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
    else if (setBefore.has(m[1]) && String(process.env[m[1]]).trim() === '' && v !== '' && !emptyShadowed.includes(m[1])) emptyShadowed.push(m[1]);
  }
} catch (_) { /* no .env → rely on the real environment */ }
module.exports = { emptyShadowed };
