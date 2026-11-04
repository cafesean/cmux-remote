#!/usr/bin/env node
'use strict';
// cmux-remote-pair — show a pairing QR for the native app. Asks the LOCAL server (PORT, default 8080)
// for a one-time code; the request is loopback, so no SERVER_TOKEN is needed. Prints the QR for a
// phone camera, then the raw link on its own line so it can be pasted, or opened in the simulator:
//   xcrun simctl openurl booted "$(cmux-remote-pair --link)"
//
//   cmux-remote-pair          QR, then the link, then when it expires
//   cmux-remote-pair --link   just the link (for scripts)
require('../loadenv');                              // loads the CWD dotenv file, so PORT matches the server's
const { encode, toTerminal } = require('../lib/qr');

async function main(argv, env, out, err) {
  const linkOnly = argv.includes('--link');
  const port = Number(env.PORT || 8080);
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${port}/api/pair/start`, { method: 'POST' });
  } catch (_) {
    err(`cmux-remote-pair: no server on 127.0.0.1:${port}. Start it with \`cmux-remote-server\` (or set PORT).`);
    return 1;
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.qr) {
    err(`cmux-remote-pair: the server refused (${r.status} ${body.error || 'unexpected reply'}).`);
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
module.exports = { main };
