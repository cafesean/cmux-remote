'use strict';
// Capture + store a Claude account token. Run only from bin/hypermux-account-setup in the user's pane.
// The token is never written to the screen, argv, files or logs; it goes to `security -i` on stdin.
const { spawn } = require('child_process');
const crypto = require('crypto');
const meta = require('./accounts-meta');

const HOLD = 32;
const CAP = 1024 * 1024;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const TRIGGER_RE = /oauth token|your token|valid for 1 year/i;
const TOKEN_RE = /sk-ant-oat\d+-[A-Za-z0-9_-]+(?:\n[A-Za-z0-9_-]+(?=\n))*/;
const strip = (s) => s.replace(ANSI_RE, '');

function extractToken(raw) {
  const t = strip(raw).replace(/\r/g, '');
  const m = TOKEN_RE.exec(t);
  const tok = m ? m[0].replace(/\n/g, '') : '';
  if (!tok.startsWith('sk-ant-') || !/^[A-Za-z0-9_-]+$/.test(tok) || tok.length < 90) return '';
  return tok;
}

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

function runSecurity(bin, args, input) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(1));
    p.on('close', (c) => resolve(c === null ? 1 : c));
    if (input !== undefined) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}

async function main() {
  const [name, flag] = process.argv.slice(2);
  const replace = flag === '--replace';
  if (typeof name !== 'string' || !meta.NAME_RE.test(name) || name === 'a') { process.stderr.write('bad account name\n'); process.exit(2); }
  const user = process.env.USER || require('os').userInfo().username;
  const svc = 'cos-claude-account-' + name;
  const secBin = process.env.HYPERMUX_SECURITY_BIN || '/usr/bin/security';
  const scriptBin = process.env.HYPERMUX_SCRIPT_BIN || '/usr/bin/script';
  const cmd = (process.env.HYPERMUX_SETUP_CMD || `${process.env.HOME}/.local/bin/claude setup-token`).split(/\s+/).filter(Boolean);
  const timeoutMs = Number(process.env.HYPERMUX_SETUP_TIMEOUT_MS) || 600000;

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'BROWSER' || /^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }

  const child = spawn(scriptBin, ['-q', '/dev/null', ...cmd], { stdio: ['inherit', 'pipe', 'inherit'], env });
  let chunks = [];
  let size = 0;
  let acc = '';          // raw accumulated text (latin1: byte-preserving)
  let held = Buffer.alloc(0);
  let cut = false, over = false, timedOut = false;

  child.stdout.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > CAP) { over = true; cut = true; chunks = []; acc = ''; held = Buffer.alloc(0); child.kill('SIGKILL'); return; }
    chunks.push(c);
    acc += c.toString('latin1');
    if (cut) return;
    const all = Buffer.concat([held, c]);
    const text = strip(acc);
    if (text.includes('sk-ant-') || TRIGGER_RE.test(text)) { cut = true; held = Buffer.alloc(0); return; }
    if (all.length > HOLD) { process.stdout.write(all.subarray(0, all.length - HOLD)); held = Buffer.from(all.subarray(all.length - HOLD)); }
    else held = all;
  });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(timer);
  if (!cut && held.length) process.stdout.write(held);
  held = Buffer.alloc(0);

  if (timedOut) fail('\ntimed out — nothing stored');
  if (over) fail('\noutput too large — nothing stored');

  let tok = extractToken(Buffer.concat(chunks).toString('latin1'));
  chunks = []; acc = '';
  if (!tok) fail('\nNo valid token found — nothing stored');
  process.stdout.write('\nToken captured\n');

  const fp = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12);
  const line = `add-generic-password${replace ? ' -U' : ''} -a "${user}" -s "${svc}" -l "Claude account ${name} (HyperMux)" -w ${tok}\n`;
  await runSecurity(secBin, ['-i'], line);
  tok = ''; // eslint-disable-line no-unused-vars
  const rc = await runSecurity(secBin, ['find-generic-password', '-a', user, '-s', svc]);
  if (rc !== 0) fail('Keychain write failed — nothing stored');

  try { meta.set(name, { fp, addedAt: new Date().toISOString() }); } catch (e) { fail('Saved to Keychain but metadata write failed: ' + e.message); }
  process.stdout.write(`Saved ${name} (sha256:${fp}…)\n`);
  const delay = Number(process.env.HYPERMUX_CLOSE_DELAY_S ?? 5) * 1000;
  setTimeout(() => process.exit(0), delay);
}

main().catch(() => fail('setup failed — nothing stored'));
