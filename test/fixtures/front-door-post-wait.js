'use strict';
// k104 fixture, run under Bun: a POST handler behind lib/front-door.js reads its JSON body, then waits
// longer than the front door's gone poll (the local pair /api/pair/local/wait waits for the Allow click),
// marking the client gone on res 'close' the way lib/pairing.js localWait does.
// Prints one JSON line: { status, falseClose } (the client's HTTP status, and whether 'close' fired before the answer).
const http = require('node:http');
const path = require('node:path');
const fd = require(path.join(__dirname, '..', '..', 'lib', 'front-door.js'));

let falseClose = false;
const WAIT_MS = (fd.GONE_POLL_MS || 1000) * 2 + 500;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.on('close', () => { if (!res.writableEnded) falseClose = true; });
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, len: body.length }));
    }, WAIT_MS);
  });
});

(async () => {
  const f = await fd.start({ nodeServer: srv, port: 0, host: '127.0.0.1' });
  const r = await fetch(`http://127.0.0.1:${f.port}/api/pair/local/wait`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'a'.repeat(32) }),
  });
  await r.text();
  console.log(JSON.stringify({ status: r.status, falseClose }));
  process.exit(0);
})();
