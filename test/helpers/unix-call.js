'use strict';
// p19: raw http.request callers for the socket tests — deliberately NOT lib/unix-fetch.js, so a test
// that talks to a socket never uses the code under test to check itself.
//
// `target` is either a socket path ('/…/bridge.sock') or a TCP base ('http://127.0.0.1:<port>'), so
// the TCP-vs-unix contract drives both sides of every comparison through the very same client code.
//
//   call(target, method, pathAndQuery, { headers, token, secret, body })
//        -> { status, headers, text, json, body }   body: object -> JSON, string/Buffer -> raw
//   firstFrame(target, pathAndQuery, opts) -> { status, json }   the first SSE `data:` frame, then hang up
//   openStream(target, pathAndQuery, opts) -> { status, headers, close() }   an SSE request left open
//
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)
const http = require('http');

function endpoint(target) {
  if (typeof target === 'string' && target.startsWith('/')) return { socketPath: target };
  const u = new URL(target);
  return { hostname: u.hostname, port: Number(u.port) };
}

function headersFor(o) {
  const h = Object.assign({}, o.headers);
  if (o.token) h.authorization = `Bearer ${o.token}`;
  if (o.secret) h['x-bridge-secret'] = o.secret;
  return h;
}

function call(target, method, pathAndQuery, opts) {
  const o = opts || {};
  const headers = headersFor(o);
  let payload = null;
  if (o.body !== undefined) {
    if (Buffer.isBuffer(o.body) || typeof o.body === 'string') payload = Buffer.from(o.body);
    else { payload = Buffer.from(JSON.stringify(o.body)); headers['content-type'] = headers['content-type'] || 'application/json'; }
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ ...endpoint(target), method, path: pathAndQuery, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON — keep the text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

function firstFrame(target, pathAndQuery, opts, timeoutMs = 10000) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({ ...endpoint(target), method: 'GET', path: pathAndQuery, headers: headersFor(o), agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) { clearTimeout(timer); req.destroy(); return resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, json: null, text: buf }); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`no data frame from ${pathAndQuery}`)); }, timeoutMs);
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) { clearTimeout(timer); reject(e); } });
    req.end();
  });
}

function openStream(target, pathAndQuery, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({ ...endpoint(target), method: 'GET', path: pathAndQuery, headers: headersFor(o), agent: false }, (res) => {
      res.on('data', () => {});
      res.on('error', () => {});
      resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy() });
    });
    req.on('error', (e) => { if (!/socket hang up|aborted/.test(String(e))) reject(e); });
    req.end();
  });
}

module.exports = { call, firstFrame, openStream };
