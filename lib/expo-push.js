'use strict';
// expo-push.js — D96: the native iPhone app's push channel. The app registers an Expo push token
// (POST /api/push/register) and each new cmux alert goes to the Expo Push API, which hands it to
// APNs/FCM. No SDK: one JSON POST per batch of at most EXPO_BATCH messages.
//
// Expo answers per message, in order: { data: [{ status: 'ok' } | { status: 'error', details: { error } }] }.
// `DeviceNotRegistered` means the app was uninstalled or the token rotated: that token is dropped.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Expo's documented cap per request.
const EXPO_BATCH = 100;
// One batch POST gives up after this long, so a slow Expo never holds up the next poll.
const EXPO_TIMEOUT_MS = 10000;
// Registered native devices kept per server; the oldest is dropped past this.
const EXPO_MAX_TOKENS = 50;
// Expo push tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[xxxx]).
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;

const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// payload = alerts' { title, body, tag, machine, surface } -> one Expo message per token.
function messageFor(token, payload) {
  return {
    to: token,
    title: payload.title,
    body: payload.body || '',
    sound: 'default',
    priority: 'high',
    // iOS groups by thread; Android replaces by tag-ish collapse id.
    threadId: payload.tag || undefined,
    data: { machine: payload.machine || null, surface: payload.surface || null, tag: payload.tag || null,
      ...(payload.kind ? { kind: payload.kind, id: payload.id || null } : {}) },   // D135 deep link {kind:'mac-dialog', machine, id}
  };
}

// -> [{ token, ok, gone, error }] in token order. Never throws: a failed batch marks its tokens not ok.
async function sendExpo(tokens, payload, { fetchImpl = globalThis.fetch, timeoutMs = EXPO_TIMEOUT_MS, batch = EXPO_BATCH } = {}) {
  const results = [];
  for (const group of chunk(tokens, batch)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(group.map((t) => messageFor(t, payload))),
        signal: ctrl.signal,
      });
      const d = await r.json().catch(() => null);
      const tickets = d && Array.isArray(d.data) ? d.data : null;
      if (!r.ok || !tickets) {
        for (const token of group) results.push({ token, ok: false, gone: false, error: `http_${r.status}` });
        continue;
      }
      group.forEach((token, i) => {
        const t = tickets[i] || {};
        const err = t.details && t.details.error;
        results.push({ token, ok: t.status === 'ok', gone: err === 'DeviceNotRegistered', error: t.status === 'ok' ? null : (err || t.message || 'error') });
      });
    } catch (e) {
      for (const token of group) results.push({ token, ok: false, gone: false, error: (e && e.name === 'AbortError') ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

module.exports = { sendExpo, validToken, messageFor, EXPO_PUSH_URL, EXPO_BATCH, EXPO_TIMEOUT_MS, EXPO_MAX_TOKENS };
