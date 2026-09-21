'use strict';
// p18 — radar is not supported on the tmux backend (owner decision, 2026-09-21; specs.md D15).
//
// Every radar route that could type into a pane or start a session answers 501 unsupported_backend
// under BACKEND=tmux, before it reads a body, runs the dispatcher, loads the handoff module or calls
// a bridge. Under cmux (or BACKEND unset) the same request reaches the dispatcher exactly as before.
// In process, no tmux needed; the real-tmux proof is test/tmux-review-fixes.test.js 1b.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createRadar } = require('../radar-server');

const REFUSAL = { error: 'unsupported_backend', backend: 'tmux', detail: 'unsupported: radar is not available on the tmux backend' };
const ROUTES = [
  ['/api/radar/dispatch', { workRefUrns: ['urn:work:jira:PROJ-1'], authority: 'sean', runId: 'run-1' }],
  ['/api/radar/inbox/reply', { machine: 'box', sessionId: 'sess-1', text: 'hello' }],
  ['/api/radar/handoff/preview', { selectors: ['PROJ-1'] }],
  ['/api/radar/handoff', { selectors: ['PROJ-1'], idempotencyKey: 'k1' }],
];

async function mount(env) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p18-gate-')));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1, role: 'leader', collectorId: 'box', repos: [{ id: 'r', path: '/repo/r' }],
    bridges: [{ id: 'box', baseUrl: 'http://127.0.0.1:9', secretRef: 'GATE_SECRET' }],
  }));
  const seen = { bridge: [], dispatch: 0, handoff: 0 };
  const radar = createRadar({
    createCollector: () => ({ paths: { dir, config: path.join(dir, 'config.json') }, getState: async () => null,
      scan: async () => ({ ok: true, published: true, warnings: [], error: null, durationMs: 1, state: null }),
      start: () => {}, stop: () => {}, isScanning: () => false }),
    scanOnStart: false, log: () => {}, env: Object.assign({ GATE_SECRET: 's' }, env),
    bridgeHttp: async (url) => { seen.bridge.push(url); return { ok: true, status: 200, json: { ok: true } }; },
    createDispatcher: () => ({ dispatch: async () => { seen.dispatch++; return { status: 299, payload: { reached: true } }; } }),
    createHandoff: () => { seen.handoff++; throw new Error('handoff reached'); },
  });
  const srv = http.createServer((req, res) => radar.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const post = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const close = async () => {
    await new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { post, seen, close };
}

test('BACKEND=tmux: every pane-writing radar route is refused, and nothing behind it runs', async () => {
  for (const backend of ['tmux', ' TMUX ']) {                  // normalised the way bridge.js normalises it
    const m = await mount({ BACKEND: backend });
    try {
      for (const [route, body] of ROUTES) {
        const r = await m.post(route, body);
        assert.equal(r.status, 501, `${backend} ${route}`);
        assert.deepEqual(r.json, REFUSAL, `${backend} ${route}`);
      }
      assert.deepEqual(m.seen, { bridge: [], dispatch: 0, handoff: 0 });
    } finally { await m.close(); }
  }
});

test('BACKEND=cmux or unset: the same dispatch reaches the dispatcher — the gate is the only difference', async () => {
  for (const env of [{}, { BACKEND: 'cmux' }]) {
    const m = await mount(env);
    try {
      const r = await m.post(...ROUTES[0]);
      assert.equal(r.status, 299, JSON.stringify(env));
      assert.deepEqual(r.json, { reached: true });
      assert.equal(m.seen.dispatch, 1);
    } finally { await m.close(); }
  }
});
