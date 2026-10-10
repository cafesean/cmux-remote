'use strict';
// alerts.js — phone alerts (p20). cmux already raises a notification when a Claude session finishes
// a turn or asks for input ("Completed in <dir>", "⛔ NEEDS YOU — <name>"). This polls each machine's
// notification list through its bridge and turns every NEW unread one into a Web Push, so the phone
// buzzes even when the app is closed.
//
// State file (0600): { vapid: <private JWK>, subs: [{ endpoint, keys, origin, addedAt }] }.
// Polling runs only while at least one device is subscribed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const webpush = require('./webpush');

const DEFAULT_FILE = path.join(os.homedir(), '.local', 'share', 'cmux-remote', 'push.json');

function createAlerts({ machines, bridge, file = process.env.PUSH_STATE_FILE || DEFAULT_FILE, pollMs = 5000, log = console }) {
  let store = load();
  // machineId -> Set of notification ids already seen. A machine with no entry has not been seeded:
  // its first successful poll only records ids, so a restart never re-buzzes old notifications.
  const seen = new Map();
  let timer = null;
  let polling = null;

  function load() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { /* first run */ }
    if (!s.vapid || !s.vapid.d) s.vapid = webpush.generateVapidKeys();
    if (!Array.isArray(s.subs)) s.subs = [];
    return s;
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  save();   // persist freshly generated VAPID keys now: a key change silently orphans every subscription

  // The JWT `sub` claim. Apple rejects a JWT without a usable contact, and the page's own https
  // origin is one we know is real without asking anyone for an address.
  const subjectFor = (sub) => process.env.PUSH_SUBJECT
    || (/^https:\/\//.test(sub.origin || '') ? sub.origin : 'mailto:cmux-remote@localhost.localdomain');

  function validSub(s) {
    return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint)
      && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
  }

  function subscribe(sub, origin) {
    if (!validSub(sub)) return false;
    store.subs = store.subs.filter((x) => x.endpoint !== sub.endpoint);
    store.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, origin: origin || '', addedAt: new Date().toISOString() });
    save();
    start();
    return true;
  }
  function unsubscribe(endpoint) {
    const n = store.subs.length;
    store.subs = store.subs.filter((x) => x.endpoint !== endpoint);
    if (store.subs.length !== n) save();
    if (!store.subs.length) stop();
    return n !== store.subs.length;
  }

  async function sendTo(subs, payload) {
    const results = await Promise.all(subs.map((s) => webpush.sendPush(s, payload, { vapid: store.vapid, subject: subjectFor(s) })
      .then((r) => ({ s, r }))));
    const dead = results.filter((x) => x.r.gone).map((x) => x.s.endpoint);
    if (dead.length) { store.subs = store.subs.filter((x) => !dead.includes(x.endpoint)); save(); }
    for (const { r } of results) if (!r.ok && !r.gone) log.error(`push: send failed ${r.status} ${r.detail}`);
    return results.map((x) => ({ ok: x.r.ok, status: x.r.status }));
  }

  // One push per surface per poll: a finished turn and its NEEDS YOU banner arrive together, and
  // the banner is the one that matters.
  function pick(items) {
    const bySurface = new Map();
    for (const n of items) {
      const k = n.surface_id || n.id;
      const cur = bySurface.get(k);
      const needs = /NEEDS YOU/i.test(n.title || '');
      if (!cur || (needs && !/NEEDS YOU/i.test(cur.title || ''))) bySurface.set(k, n);
    }
    return [...bySurface.values()];
  }

  function payloadFor(m, n) {
    const needs = /NEEDS YOU/i.test(n.title || '');
    const title = needs ? n.title : `✅ ${n.tab_title || n.title || 'Done'}`;
    const body = (needs ? n.body : [n.subtitle, n.body].filter(Boolean).join(' — ')) || '';
    return {
      title: machines.length > 1 ? `${title} · ${m.label}` : title,
      body: body.length > 240 ? body.slice(0, 239) + '…' : body,
      tag: n.surface_id || n.id,
      machine: m.id,
      surface: n.surface_id || null,
    };
  }

  async function pollMachine(m) {
    let list;
    try {
      const r = await bridge(m, '/cmux/notifications', { timeout: 8000 });
      if (!r.ok) return;
      const d = await r.json();
      list = Array.isArray(d && d.notifications) ? d.notifications : null;
    } catch (_) { return; }
    if (!list) return;
    const prev = seen.get(m.id);
    seen.set(m.id, new Set(list.map((n) => n.id)));
    if (!prev) return;   // seeding poll
    const fresh = list.filter((n) => n && n.id && !prev.has(n.id) && !n.is_read);
    if (!fresh.length || !store.subs.length) return;
    for (const n of pick(fresh)) {
      const p = payloadFor(m, n);
      const r = await sendTo(store.subs, p);
      log.log(`push: "${p.title}" → ${r.filter((x) => x.ok).length}/${r.length} device(s)`);
    }
  }

  // One poll at a time; a caller arriving mid-poll waits for that poll instead of starting another.
  function tick() {
    if (!polling) polling = Promise.all(machines.map(pollMachine)).finally(() => { polling = null; });
    return polling;
  }

  function start() {
    if (timer || !store.subs.length) return;
    timer = setInterval(() => { tick().catch((e) => log.error(`push: poll failed ${(e && e.message) || e}`)); }, pollMs);
    if (timer.unref) timer.unref();
    tick().catch(() => {});
  }
  function stop() { if (timer) clearInterval(timer); timer = null; seen.clear(); }

  return {
    publicKey: () => webpush.vapidPublicKey(store.vapid),
    count: () => store.subs.length,
    has: (endpoint) => store.subs.some((x) => x.endpoint === endpoint),
    subscribe, unsubscribe, start, stop, tick,
    test: (endpoint) => {
      const subs = store.subs.filter((x) => !endpoint || x.endpoint === endpoint);
      return sendTo(subs, { title: '🔔 cmux-remote', body: 'Phone alerts are on.', tag: 'cmux-test' })
        .then((r) => { log.log(`push: test → ${r.filter((x) => x.ok).length}/${r.length} device(s) [${r.map((x) => x.status).join(',')}]`); return r; });
    },
    _payloadFor: payloadFor, _pick: pick,
  };
}

module.exports = { createAlerts };
