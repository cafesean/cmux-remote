#!/usr/bin/env node
'use strict';
// cmux-remote-pair — show a pairing QR for the native app. Asks the LOCAL server (PORT, default 8080)
// for a one-time code, authenticating with the server's SERVER_TOKEN (never printed), and prints the QR
// for a phone camera, then the raw link on its own line so it can be pasted, or opened in the simulator:
//   xcrun simctl openurl booted "$(cmux-remote-pair --link)"
//
//   cmux-remote-pair          QR, then the link, then when it expires
//   cmux-remote-pair --link   just the link (for scripts)
//
// The token comes from the environment (SERVER_TOKEN), else from the server's own dotenv file next to
// server.js. A server with no SERVER_TOKEN needs none: it only answers a local request.
const fs = require('fs');
const path = require('path');
require('../loadenv');                              // loads the CWD dotenv file, so PORT matches the server's
const { encode, toTerminal } = require('../lib/qr');

// SERVER_TOKEN=... out of a dotenv file, and nothing else in it.
function tokenFromEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  for (const raw of text.split('\n')) {
    const m = /^\s*SERVER_TOKEN\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const v = m[1];
    return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
  }
  return '';
}

async function main(argv, env, out, err, serverDir = path.join(__dirname, '..')) {
  const linkOnly = argv.includes('--link');
  const port = Number(env.PORT || 8080);
  const token = env.SERVER_TOKEN || tokenFromEnvFile(path.join(serverDir, '.env'));
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${port}/api/pair/start`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch (_) {
    err(`cmux-remote-pair: no server on 127.0.0.1:${port}. Start it with \`cmux-remote-server\` (or set PORT).`);
    return 1;
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.qr) {
    err(`cmux-remote-pair: the server refused (${r.status} ${body.error || 'unexpected reply'}).`
      + (r.status === 401 ? ' Set SERVER_TOKEN to the server\'s token.' : ''));
    return 1;
  }
  if (linkOnly) { out(body.qr); return 0; }
  const qr = encode(body.qr, { ecc: 'M' });
  out(toTerminal(qr));
  out('');
  out(body.qr);
  out('');
  out(`One-time code ${body.code}, good until ${new Date(body.expiresAt).toLocaleTimeString()} (10 minutes).`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, (s) => console.log(s), (s) => console.error(s))
    .then((code) => { process.exitCode = code; });
}
module.exports = { main, tokenFromEnvFile };
