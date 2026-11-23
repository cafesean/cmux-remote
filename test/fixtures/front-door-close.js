'use strict';
// p41 D303 fixture, run under Bun: SSE handlers behind lib/front-door.js count open streams the way
// sessions/routes.js stream() does (++ after an await, -- on req/res 'close'). Five clients connect and leave.
// Prints one JSON line: { leaked } (open streams still counted after every client has gone).
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fd = require(path.join(__dirname, '..', '..', 'lib', 'front-door.js'));

// The handler awaits 400 ms before it listens (sessions/routes.js awaits findTab first; on a busy cmux that
// read is slow), and each client leaves after 150 ms: the client is gone before the handler listens.
let streams = 0;
const srv = http.createServer(async (req, res) => {
  await new Promise((r) => setTimeout(r, 400));
  streams++;
  let closed = false;
  const done = () => { if (closed) return; closed = true; streams--; clearInterval(hb); };
  req.on('close', done);
  res.on('close', done);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(': connected\n\n');
  const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, 100);
});

function client(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /s HTTP/1.1\r\nhost: x\r\n\r\n');
      setTimeout(() => { s.destroy(); resolve(); }, 150);
    });
    s.on('error', resolve);
  });
}

(async () => {
  const f = await fd.start({ nodeServer: srv, port: 0, host: '127.0.0.1' });
  for (let i = 0; i < 5; i++) await client(f.port);
  await new Promise((r) => setTimeout(r, 400 + (fd.GONE_POLL_MS || 1000) + 800));
  console.log(JSON.stringify({ leaked: streams }));
  process.exit(0);
})();
