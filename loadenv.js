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
// Secrets: single source of truth is ~/.secrets/.secrets.local.yaml -> cmux_remote.env (SECRET keys only;
// ports/paths/labels stay in .env). Precedence: real environment > yaml > .env (fallback when the yaml key
// is missing). Skipped under tests (NODE_ENV=test) or CMUX_REMOTE_NO_YAML=1 so fixtures stay hermetic.
const YAML_SECRET_KEYS = ['BRIDGE_SECRET', 'CMUX_SOCKET_PASSWORD', 'SERVER_TOKEN', 'CMUX_MACHINE_SECRET'];
if (process.env.NODE_ENV !== 'test' && !process.env.CMUX_REMOTE_NO_YAML) {
  try {
    const yamlPath = process.env.SECRETS_YAML || path.join(require('os').homedir(), '.secrets', '.secrets.local.yaml');
    const py = 'import sys,yaml,json\nd=yaml.safe_load(open(sys.argv[1]))["cmux_remote"]["env"]\nprint(json.dumps(d))';
    const env = JSON.parse(require('child_process').execFileSync('python3', ['-c', py, yamlPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    for (const k of YAML_SECRET_KEYS) {
      if (typeof env[k] === 'string' && env[k] !== '' && !(k in process.env)) process.env[k] = env[k];
    }
  } catch (_) { /* yaml/python/section missing → fall back to .env below */ }
}
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
