#!/usr/bin/env node
'use strict';
// server.js — the push relay (p41 E1). Zero dependencies.
//
// A user's server posts a push event here; we forward it to the Expo push API. The relay exists
// because the app's push token is only usable through Expo, and a self-hosted server has no Expo
// credentials of its own.
//
// WHAT CROSSES THIS SERVICE: a session id, a kind and a short title. Nothing else. Terminal text
// and transcript content never leave the user's server. That is enforced here, not promised:
// `pushPayload` builds the outgoing message from three named fields, so a field a client adds to
// the body has nowhere to go.
const http = require('http');
const crypto = require('crypto');
const { createStore, hashKey } = require('./store');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const KINDS = ['needs-you', 'done', 'handover', 'context', 'resources', 'custom'];
const PLATFORMS = ['ios', 'android'];

const LIMITS = {
  titleMax: 120,          // longer titles are truncated, not rejected
  sessionIdMax: 200,
  pushesPerMinute: 60,    // per serverKey, sliding window
  windowMs: 60 * 1000,
  expoTimeoutMs: 10 * 1000,
  bodyMaxBytes: 4096,
};

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// The ONLY place a push body is read. Anything not named here is dropped.
function pushPayload(body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const kind = body.kind;
  if (!sessionId || sessionId.length > LIMITS.sessionIdMax) return { error: 'bad_session_id' };
  if (!KINDS.includes(kind)) return { error: 'bad_kind' };
  const title = typeof body.title === 'string' ? body.title.slice(0, LIMITS.titleMax) : '';
  return { sessionId, kind, title };
}

function createRelay(opts = {}) {
  const store = opts.store || createStore(opts.dataPath || process.env.RELAY_DATA || './relay-data.json');
  const enrolSecret = opts.enrolSecret !== undefined ? opts.enrolSecret : process.env.RELAY_ENROL_SECRET || '';
  const expoToken = opts.expoToken !== undefined ? opts.expoToken : process.env.EXPO_ACCESS_TOKEN || '';
  const doFetch = opts.fetch || fetch;
  const now = opts.now || Date.now;
  const log = opts.log || ((m) => console.error(`[relay] ${m}`));
  const sent = new Map();   // key hash -> timestamps of pushes inside the window

  function allow(hash) {
    const t = now();
    const recent = (sent.get(hash) || []).filter((ts) => t - ts < LIMITS.windowMs);
    if (recent.length >= LIMITS.pushesPerMinute) {
      sent.set(hash, recent);
      return Math.max(1, Math.ceil((recent[0] + LIMITS.windowMs - t) / 1000));
    }
    recent.push(t);
    sent.set(hash, recent);
    return 0;
  }

  async function sendToExpo(hash, tokens, p) {
    const messages = tokens.map((to) => ({
      to, title: p.title || p.kind, sound: 'default', data: { sessionId: p.sessionId, kind: p.kind },
    }));
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (expoToken) headers.authorization = `Bearer ${expoToken}`;
    const res = await doFetch(EXPO_URL, {
      method: 'POST', headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(LIMITS.expoTimeoutMs),
    });
    if (!res.ok) throw new Error(`expo_http_${res.status}`);
    const json = await res.json().catch(() => ({}));
    // A token Expo says is dead will never work again; drop it so the list does not grow forever.
    (Array.isArray(json.data) ? json.data : []).forEach((ticket, i) => {
      if (ticket && ticket.status === 'error' && ticket.details && ticket.details.error === 'DeviceNotRegistered') {
        store.removeToken(hash, tokens[i]);
      }
    });
  }

  async function handle(req, res, route) {
    const body = route.body;
    const serverKey = typeof body.serverKey === 'string' ? body.serverKey : '';
    if (!serverKey) return reply(res, 400, { error: 'missing_server_key' });
    const hash = hashKey(serverKey);

    if (route.path === '/v1/register') {
      const { deviceToken, platform } = body;
      if (typeof deviceToken !== 'string' || !deviceToken) return reply(res, 400, { error: 'bad_device_token' });
      if (!PLATFORMS.includes(platform)) return reply(res, 400, { error: 'bad_platform' });
      if (!store.has(hash)) {
        // First sight of this key: only the operator's enrolment secret may mint one. Unset secret
        // means nobody can enrol, never everybody.
        const given = req.headers['x-relay-enrol'] || '';
        if (!enrolSecret || !safeEqual(given, enrolSecret)) return reply(res, 401, { error: 'enrolment_required' });
      }
      store.addToken(hash, deviceToken, platform, now());
      return reply(res, 200, { ok: true });
    }

    // /v1/push
    if (!store.has(hash)) return reply(res, 401, { error: 'unknown_server_key' });
    const p = pushPayload(body);
    if (p.error) return reply(res, 400, { error: p.error });
    let tokens = store.tokens(hash);
    if (typeof body.deviceToken === 'string' && body.deviceToken) {
      tokens = tokens.filter((t) => t === body.deviceToken);
      if (!tokens.length) return reply(res, 404, { error: 'unknown_device_token' });
    }
    if (!tokens.length) return reply(res, 404, { error: 'no_devices' });
    const retry = allow(hash);
    if (retry) { res.setHeader('retry-after', String(retry)); return reply(res, 429, { error: 'rate_limited' }); }
    try {
      await sendToExpo(hash, tokens, p);
    } catch (e) {
      log(`expo push failed (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);   // v1: no retry
      return reply(res, 502, { error: 'push_failed' });
    }
    return reply(res, 200, { ok: true, sent: tokens.length });
  }

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://relay').pathname;
    if (req.method === 'GET' && path === '/healthz') return reply(res, 200, { ok: true });
    if (req.method !== 'POST' || (path !== '/v1/register' && path !== '/v1/push')) return reply(res, 404, { error: 'not_found' });
    const chunks = [];
    let size = 0, dead = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyMaxBytes) { dead = true; reply(res, 413, { error: 'too_large' }); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, { error: 'bad_json' });
      handle(req, res, { path, body }).catch((e) => { log(`handler error: ${e.message}`); reply(res, 500, { error: 'internal' }); });
    });
  });
  return server;
}

function reply(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

module.exports = { createRelay, pushPayload, LIMITS, KINDS, EXPO_URL };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createRelay().listen(port, () => console.error(`[relay] listening on :${port}`));
}
