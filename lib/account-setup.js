'use strict';
// Capture + store a Claude account token. Run only from bin/hypermux-account-setup in the user's pane.
// The token is never written to the screen, argv, files or logs; it goes to `security -i` on stdin.
const { spawn } = require('child_process');
const crypto = require('crypto');
const meta = require('./accounts-meta');

const HOLD = 32;
const CAP = 1024 * 1024;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TRIGGER_RE = /oauth token|your token|valid for 1 year/i;
const TOKEN_RE = /sk-ant-oat\d+-[A-Za-z0-9_-]+(?:\n[A-Za-z0-9_-]+(?=\n))*/;
const strip = (s) => s.replace(ANSI_RE, '');
const closeDelayMs = () => Number(process.env.HYPERMUX_CLOSE_DELAY_S ?? 5) * 1000;

function extractToken(raw) {
  const t = strip(raw).replace(/\r/g, '');
  const m = TOKEN_RE.exec(t);
  const tok = m ? m[0].replace(/\n/g, '') : '';
  if (!tok.startsWith('sk-ant-') || !/^[A-Za-z0-9_-]+$/.test(tok) || tok.length < 90) return '';
  return tok;
}

// print the reason, wait so it stays readable, exit 1 (never resolves)
function die(msg) {
  process.stderr.write(msg + '\n');
  return new Promise(() => setTimeout(() => process.exit(1), closeDelayMs()));
}

function runSecurity(bin, args, input) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], env: require('./secrets-stdin').childEnv() });
    p.on('error', () => resolve(1));
    p.on('close', (c) => resolve(c === null ? 1 : c));
    if (input !== undefined) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}

function setupCmd() {
  const raw = process.env.HYPERMUX_SETUP_CMD;
  if (!raw) return [`${process.env.HOME}/.local/bin/claude`, 'setup-token'];
  if (raw.trim().startsWith('[')) {
    try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string')) return a; } catch { /* below */ }
    return null;
  }
  return raw.split(/\s+/).filter(Boolean);
}

// Bytes safe to show from `s`: whole lines before the first line whose ANSI-stripped text carries a marker
// (`sk-` or a header phrase). No offending line found -> nothing.
function safePrefix(s) {
  const lines = s.match(/[^\n]*\n|[^\n]+$/g) || [];
  let out = 0;
  for (const l of lines) {
    const t = strip(l);
    if (/sk-/.test(t) || TRIGGER_RE.test(t) || /[A-Za-z0-9_-]{40,}/.test(t)) return out;
    out += l.length;
  }
  return 0;
}

async function main() {
  const [name, flag] = process.argv.slice(2);
  const replace = flag === '--replace';
  if (typeof name !== 'string' || !meta.NAME_RE.test(name) || name === 'a') { process.stderr.write('bad account name\n'); process.exit(2); }
  const user = process.env.USER || require('os').userInfo().username;
  const svc = 'cos-claude-account-' + name;
  const secBin = process.env.HYPERMUX_SECURITY_BIN || '/usr/bin/security';
  const scriptBin = process.env.HYPERMUX_SCRIPT_BIN || '/usr/bin/script';
  const cmd = setupCmd();
  if (!cmd) await die('HYPERMUX_SETUP_CMD is not a valid JSON array — nothing stored');
  const timeoutMs = Number(process.env.HYPERMUX_SETUP_TIMEOUT_MS) || 600000;

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'BROWSER' || /^(CLAUDE|ANTHROPIC)/i.test(k) || require('./secrets-stdin').isSecretName(k)) continue;
    env[k] = v;
  }

  // wide pty so setup-token never wraps the token
  const child = spawn(scriptBin, ['-q', '/dev/null', 'bash', '-c', 'stty cols 500 2>/dev/null; exec "$@"', '_', ...cmd],
    { stdio: ['inherit', 'pipe', 'inherit'], env });
  let chunks = [];
  let size = 0;
  let acc = '';          // raw accumulated text (latin1: byte-preserving)
  let held = Buffer.alloc(0);
  let cut = false, over = false, timedOut = false;

  child.stdout.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > CAP) { over = true; cut = true; chunks.forEach((b) => b.fill(0)); chunks = []; acc = ''; held = Buffer.alloc(0); child.kill('SIGKILL'); return; }
    chunks.push(c);
    acc += c.toString('latin1');
    if (cut) return;
    const all = Buffer.concat([held, c]);
    const text = strip(acc);
    if (text.includes('sk-ant-') || TRIGGER_RE.test(text)) {
      cut = true; held = Buffer.alloc(0);
      const ls = safePrefix(all.toString('latin1'));
      if (ls > 0) process.stdout.write(all.subarray(0, ls)); // whole lines before the first marker line only
      all.fill(0);
      return;
    }
    if (all.length > HOLD) { process.stdout.write(all.subarray(0, all.length - HOLD)); held = Buffer.from(all.subarray(all.length - HOLD)); }
    else held = all;
  });
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true; child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  }, timeoutMs);

  await new Promise((resolve) => { child.on('error', resolve); child.on('close', resolve); });
  clearTimeout(timer); clearTimeout(killTimer);
  if (!cut && held.length) process.stdout.write(held);
  held = Buffer.alloc(0);

  if (timedOut) await die('\ntimed out — nothing stored');
  if (over) await die('\noutput too large — nothing stored');

  let tok = extractToken(Buffer.concat(chunks).toString('latin1'));
  chunks.forEach((b) => b.fill(0)); chunks = []; acc = '';
  if (!tok) await die('\nNo valid token found — nothing stored');
  process.stdout.write('\nToken captured\n');

  const fp = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12);
  if (replace) {
    // one live token per login: the old one is dead anyway. delete, then add WITHOUT -U (security -i exits 0 on failure)
    await runSecurity(secBin, ['delete-generic-password', '-a', user, '-s', svc]);
    if (await runSecurity(secBin, ['find-generic-password', '-a', user, '-s', svc]) === 0) {
      tok = ''; await die('Keychain write failed — nothing stored (old item could not be removed)');
    }
  } else if (await runSecurity(secBin, ['find-generic-password', '-a', user, '-s', svc]) === 0) {
    tok = ''; await die(`${name} already exists on this Mac — nothing stored`);
  }
  const line = Buffer.from(`add-generic-password -a "${user}" -s "${svc}" -l "Claude account ${name} (HyprMux)" -w ${tok}\n`);
  tok = '';
  await runSecurity(secBin, ['-i'], line);
  line.fill(0);
  const rc = await runSecurity(secBin, ['find-generic-password', '-a', user, '-s', svc]);
  if (rc !== 0) await die('Keychain write failed — nothing stored');

  try { meta.set(name, { fp, addedAt: new Date().toISOString() }); } catch (e) { await die('Saved to Keychain but metadata write failed: ' + e.message); }
  process.stdout.write(`Saved ${name} (sha256:${fp}…)\n`);
  setTimeout(() => process.exit(0), closeDelayMs());
}

main().catch(() => die('setup failed — nothing stored'));
