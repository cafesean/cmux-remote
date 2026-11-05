'use strict';
// readBody for the JSON POST routes in server.js (BUG2 round 1: extracted so its failure path is testable).
//
// Parses the body, learns an unknown `machine` (ensureMachine, may do one list sweep), then runs cb(b).
// cb runs inside a promise chain, so a sync throw OR a rejected async handler must be caught HERE:
// server.js has no unhandledRejection handler and Node would kill the whole process. The reply is a
// 500 when headers are not sent yet; nothing but the error NAME is logged (never body or message text).
// The response is found at req.cmuxRes (handleApi sets it) so the many call sites keep their signature.
function createReadBody({ ensureMachine, sendJson, log }) {
  const logf = log || ((m) => console.error(m));
  return function readBody(req, cb, cap = 256 * 1024) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > cap) req.destroy(); });
    req.on('end', () => {
      let b;
      try { b = JSON.parse(body || '{}'); } catch (_) { return cb(null); }
      // a body naming a machine we cannot find yet may name a bridge machineId — learn it first
      const mid = b && typeof b.machine === 'string' ? b.machine : '';
      (mid ? Promise.resolve(ensureMachine(mid)).catch(() => {}) : Promise.resolve())
        .then(() => cb(b))
        .catch((e) => {
          logf(`readBody: handler failed (${(e && e.name) || 'Error'})`);
          const res = req.cmuxRes;
          if (!res) return;
          try {
            if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
            else if (!res.writableEnded) res.end();
          } catch (_) { /* socket gone */ }
        });
    });
  };
}

module.exports = { createReadBody };
