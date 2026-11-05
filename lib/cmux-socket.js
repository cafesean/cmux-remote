'use strict';
// p41 D88: one v2 call straight over the cmux Unix socket (newline-delimited JSON, `auth <password>`
// first when a socket password is set) — for params that must NOT sit in ps-visible argv (typed
// browser text, passwords). `cmux rpc <method> <json>` would put them there. Params, the password and
// the reply body are never logged and never copied into an error message.
const net = require('net');
const os = require('os');
const path = require('path');

const CMUX_SOCKET_TIMEOUT_MS = 10000;   // whole call: connect + auth + reply
const CMUX_SOCKET_MAX_REPLY = 1024 * 1024;

function createCmuxSocket({ auth } = {}) {
  let seq = 0;
  function call(method, params, { timeoutMs = CMUX_SOCKET_TIMEOUT_MS } = {}) {
    const a = (auth && auth()) || {};
    const sockPath = a.path || path.join(os.homedir(), '.local', 'state', 'cmux', 'cmux.sock');
    const pw = a.password || '';
    const id = `cmr-${process.pid}-${++seq}`;
    return new Promise((resolve, reject) => {
      let buf = '', done = false, authed = !pw;
      const s = net.createConnection(sockPath);
      const fin = (err, v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); err ? reject(new Error(err)) : resolve(v); };
      const t = setTimeout(() => fin('cmux_socket_timeout'), timeoutMs);
      const sendReq = () => s.write(JSON.stringify({ id, method, params }) + '\n');
      s.on('error', () => fin('cmux_socket_error'));
      s.on('close', () => fin('cmux_socket_closed'));
      s.on('connect', () => (pw ? s.write(`auth ${pw}\n`) : sendReq()));
      s.on('data', (d) => {
        buf += d;
        if (buf.length > CMUX_SOCKET_MAX_REPLY) return fin('cmux_socket_reply_too_large');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j = null; try { j = JSON.parse(line); } catch (_) {}
          if (!authed) {   // the auth reply: JSON {ok:false} or a plain-text line
            if (j && j.ok === false) return fin('cmux_socket_auth_failed');
            if (!j && /error|denied|invalid/i.test(line)) return fin('cmux_socket_auth_failed');
            authed = true; sendReq(); continue;
          }
          if (!j || j.id !== id) continue;
          return j.ok === false ? fin('cmux_rpc_' + String((j.error && j.error.code) || 'failed').replace(/[^a-z_]/gi, '').slice(0, 40)) : fin(null, j);
        }
      });
    });
  }
  return { call };
}
module.exports = { createCmuxSocket, CMUX_SOCKET_TIMEOUT_MS, CMUX_SOCKET_MAX_REPLY };
