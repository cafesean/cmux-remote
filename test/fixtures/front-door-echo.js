'use strict';
// Test-only: lib/front-door.js with an echo websocket and an allow-all gate, compiled with bun to prove the
// handshake, framing and the lib/ws.js limits of the Bun adapter. Production has no echo (server.js wires
// the screen socket). Prints "echo on <port>".
const http = require('http');
const frontDoor = require('../../lib/front-door');
const bunWs = require('../../lib/bun-ws');
const node = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('node'); });
frontDoor.start({
  nodeServer: node, port: 0, host: '127.0.0.1',
  wsGate: async () => ({ ctx: {} }),
  websocket: bunWs.websocket((conn) => { conn.on('message', (m) => { conn.markHello(); conn.send(m); }); }),
}).then((f) => console.log('echo on ' + f.port));
