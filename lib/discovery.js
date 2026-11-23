'use strict';
// HMX-137 S1: local discovery. The HyprMux Bridge server listens on a port it picked once at random, so the HyprMux
// app on the same Mac could never find it ("This version can't run HyprMux on this Mac" with a Bridge running).
// When HMX_DISCOVERY_PORT is set, a second tiny loopback listener answers ONLY `GET /api/pair/hello` with the
// same public hello plus `port` = the real server port; the app then talks to that port. Everything else is 404.
// The hello carries no secret (app, version, serverId, localMachine, localMac, hasPublicUrl, autoPair).
// A port already in use (another Bridge, a dev server) is logged and skipped: discovery is best effort.
const http = require('http');

function parsePort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * @param {{ port: unknown, serverPort: number, hello: () => object, host?: string, log?: (s: string) => void }} o
 * @returns {Promise<import('http').Server|null>} the listener, or null when off or the port is taken
 */
function startDiscovery(o) {
  const port = parsePort(o.port);
  const log = o.log || ((s) => console.log(s));
  if (!port || !o.serverPort || port === o.serverPort) return Promise.resolve(null);
  const srv = http.createServer((req, res) => {
    const p = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || p !== '/api/pair/hello') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"not_found"}');
    }
    let body;
    try { body = JSON.stringify({ ...o.hello(), port: o.serverPort }); } catch (_) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"hello_failed"}');
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((resolve) => {
    srv.once('error', (e) => { log(`discovery: off (${e.code || e.message}) on 127.0.0.1:${port}`); resolve(null); });
    srv.listen(port, o.host || '127.0.0.1', () => { log(`discovery: hello on 127.0.0.1:${port} -> port ${o.serverPort}`); resolve(srv); });
  });
}

module.exports = { startDiscovery, parsePort };
