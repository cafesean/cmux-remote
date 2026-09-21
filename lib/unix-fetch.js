'use strict';
// p19 — the server's way to reach a bridge over a UNIX socket (specs.md D2, §6). Built-ins only.
//
// Node's global fetch cannot dial a UNIX socket without the undici package, and cmux-remote has no
// dependencies. So a `unix:` machine goes through http.request({ socketPath }) instead, and this file
// hands back the slice of fetch's Response the relays in server.js actually use — status, ok,
// headers.get(), body (a web ReadableStream: getReader() and Readable.fromWeb both work), json(),
// text() — so not one relay handler changes.
//
//   agent: false   one connection per request: a restarted bridge never leaves a pooled dead socket
//                  behind. UNIX connects are cheap, and the long-lived calls are SSE streams anyway.
//   abort          before the headers: the promise rejects (like fetch). After them: the body stream
//                  errors, so a pending reader.read() rejects — the path the SSE relays already catch.
const http = require('http');
const { Readable } = require('stream');
const { SocketConfigError, validateSocketPath } = require('./unix-listen');

// null when url is not a unix: URL; the socket path when it is valid; throws SocketConfigError otherwise.
// `unix://host/x` normalises to a `//` path and is refused, like any relative or over-long path.
function parseUnixBaseUrl(url) {
  const m = /^unix:([\s\S]*)$/i.exec(String(url == null ? '' : url));
  if (!m) return null;
  const v = validateSocketPath(m[1]);
  if (!v.ok) throw new SocketConfigError(v.code, v.detail);
  return m[1];
}

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function responseLike(res) {
  const status = res.statusCode;
  const body = Readable.toWeb(res);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const v = res.headers[String(name).toLowerCase()];
        if (v == null) return null;
        return Array.isArray(v) ? v.join(', ') : String(v);
      },
    },
    body,
    async text() { return (await readAll(body)).toString('utf8'); },
    async json() { return JSON.parse((await readAll(body)).toString('utf8')); },
  };
}

// Promise<ResponseLike>. Rejects (like fetch) on connect errors and on abort before the headers.
// init: { method, headers, body (string | Buffer), signal } — any other key (the server passes
// `timeout`) is ignored, as fetch ignores it.
function unixFetch(socketPath, pathAndQuery, init = {}) {
  const signal = init.signal;
  if (signal && signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    // Header values are stringified the way fetch's Headers does it, so an unset secret in a machine
    // entry travels as it would over http(s) instead of throwing here.
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) {
      if (k.toLowerCase() !== 'content-length') headers[k] = String(v);
    }
    let payload = null;
    if (init.body != null) {
      payload = Buffer.isBuffer(init.body) ? init.body
        : init.body instanceof Uint8Array ? Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
        : Buffer.from(String(init.body), 'utf8');
      headers['content-length'] = String(payload.length);
    }
    const req = http.request({
      socketPath, path: pathAndQuery, method: init.method || 'GET', headers, signal, agent: false,
    });
    req.once('response', (res) => resolve(responseLike(res)));
    req.on('error', (e) => reject(e && e.name === 'AbortError' ? abortError() : e));
    req.end(payload || undefined);
  });
}

module.exports = { parseUnixBaseUrl, unixFetch };
