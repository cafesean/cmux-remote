'use strict';
// p42: plan enforcement for a Mac run by HyprMux Bridge. One async authorize() is awaited at every entry
// point AFTER the sync credential check (authed / verifyKey stay sync). It never rejects: hub and internal
// errors resolve to the stale-state decision below.
//
// Admission modes (first matching row wins). "Answer" = freshest hub read <= 24 h old.
//   no owner,  answer disabled, or none and enforcedLastKnown false  -> D (no checks, a0482e0 behaviour)
//   no owner,  anything else (fresh install, never read)              -> F (built-in Free from the local key list)
//   owner,     enforced true                                          -> E (entitlement limits)
//   owner,     disabled                                               -> D
//   owner,     none, enforcedLastKnown true or never read             -> E with built-in Free
//   owner,     none, enforcedLastKnown false                          -> D
//
// Files (state dir, written by the Bridge core except the two caches written here):
//   owner.json {ownerSub, ownerEpoch}; hub-access-token {ownerSub, ownerEpoch, accessToken, exp}
//   plan-cache.json (owner-scoped, ignored for any other owner); install-policy.json (never deleted)
const fs = require('fs');
const path = require('path');

const FREE = Object.freeze({ maxMachines: 1, maxDevices: 1, remoteDesktop: 'view' });
const TTL_MS = 300 * 1000;
const STALE_MS = 24 * 3600 * 1000;
const FAIL_BACKOFF_MS = 60 * 1000;
const TIMEOUT_MS = 5000;
const SCREEN_INPUT = /^\/api\/cmux\/screen\/(mouse|tap|scroll|type|key|dialogs\/press|dialogs\/type)$/;

class PolicyRefusal extends Error {
  constructor(status, body) { super(body && body.error ? String(body.error) : 'policy_refusal'); this.status = status; this.body = body; }
}
const planLimit = (limit, reason) => new PolicyRefusal(402, { error: 'PLAN_LIMIT', code: 'PLAN_LIMIT', details: reason ? { limit, reason } : { limit } });
const busy = () => new PolicyRefusal(503, { error: 'BUSY', code: 'BUSY' });

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
// The one error mapper: a typed refusal is sent exactly; anything else is one 500. One response per request.
function respond(res, err, fallback = 'internal') {
  if (!res || res.headersSent || res.writableEnded) return;
  if (err instanceof PolicyRefusal) return sendJson(res, err.status, err.body);
  return sendJson(res, 500, { error: fallback });
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writePrivate(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('hub_timeout')), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// hub: { plans() -> {enforced, defaultPlan, plans}, entitlement(token) -> {enforced, plan, limits} | null,
//        devices(token) -> [{id, status, publicKey}] }. Throws/rejects on failure; 404 PLANS_NOT_CONFIGURED
//        is reported as { enforced:false }.
function createPolicy({ hub, stateDir, now = Date.now, timeoutMs = TIMEOUT_MS, log = console } = {}) {
  const f = (n) => path.join(stateDir, n);
  let cache = null;          // { ownerSub, ownerEpoch, answer: {enforced, limits, free, fetchedAt}, devices: {id: {status, publicKey, fetchedAt}} }
  let inflight = null;
  let lastFail = -Infinity;

  const owner = () => { const o = readJson(f('owner.json')); return o && typeof o === 'object' ? { ownerSub: o.ownerSub || null, ownerEpoch: Number(o.ownerEpoch) || 0 } : { ownerSub: null, ownerEpoch: 0 }; };
  const installPolicy = () => readJson(f('install-policy.json')) || {};
  // The owner token is used only when it names the current owner + epoch and is not expired.
  function ownerToken(o) {
    const t = readJson(f('hub-access-token'));
    if (!t || !o.ownerSub || t.ownerSub !== o.ownerSub || Number(t.ownerEpoch) !== o.ownerEpoch || !t.accessToken) return null;
    if (Number(t.exp) && Number(t.exp) * 1000 <= now()) return null;
    return t.accessToken;
  }
  function loadCache(o) {
    if (cache && cache.ownerSub === o.ownerSub && cache.ownerEpoch === o.ownerEpoch) return cache;
    const disk = readJson(f('plan-cache.json'));
    cache = disk && disk.ownerSub === o.ownerSub && Number(disk.ownerEpoch) === o.ownerEpoch ? disk : { ownerSub: o.ownerSub, ownerEpoch: o.ownerEpoch, answer: null, devices: {} };
    return cache;
  }

  async function fetchAnswer(o) {
    if (!o.ownerSub) {
      const p = await hub.plans();
      const def = p && Array.isArray(p.plans) ? p.plans.find((x) => x.code === p.defaultPlan) : null;
      return { answer: { enforced: !!(p && p.enforced === true), limits: (def && def.limits) || FREE, free: true }, devices: null };
    }
    const token = ownerToken(o);
    if (!token) throw new Error('no_owner_token');
    const [ent, devs] = await Promise.all([hub.entitlement(token), hub.devices(token)]);
    const enforced = !!(ent && ent.enforced === true);
    const limits = (ent && ent.limits) || FREE;
    const free = !ent || !ent.plan || ent.plan === 'free' || ent.plan.code === 'free';
    const t = now();
    const devices = {};
    for (const d of Array.isArray(devs) ? devs : []) if (d && d.id) devices[d.id] = { status: d.status, publicKey: d.publicKey || null, fetchedAt: t };
    return { answer: { enforced, limits, free }, devices };
  }

  // Single flight per owner; after a failure the next hub call waits >= 60 s.
  function refresh() {
    if (inflight) return inflight;
    if (now() - lastFail < FAIL_BACKOFF_MS) return Promise.resolve(false);
    const o = owner();
    inflight = withTimeout(fetchAnswer(o), timeoutMs).then((r) => {
      const o2 = owner();
      if (o2.ownerSub !== o.ownerSub || o2.ownerEpoch !== o.ownerEpoch) return false;   // owner changed mid-flight: discard
      const c = loadCache(o);
      const t = now();
      c.answer = { ...r.answer, fetchedAt: t };
      if (r.devices) { c.devices = r.devices; c.devicesAt = t; }
      if (o.ownerSub) { try { writePrivate(f('plan-cache.json'), c); } catch (e) { log.error(`plan-policy: cache write: ${e.message}`); } }
      try { writePrivate(f('install-policy.json'), { enforcedLastKnown: r.answer.enforced, enforcedAt: t, ownerSub: o.ownerSub, ownerEpoch: o.ownerEpoch }); } catch (_) {}
      return true;
    }, () => { lastFail = now(); return false; }).finally(() => { inflight = null; });
    return inflight;
  }

  // Await a refresh only when the cached answer is older than the TTL (bounded by timeoutMs).
  async function ensureFresh() {
    const c = loadCache(owner());
    if (c.answer && now() - c.answer.fetchedAt < TTL_MS) return;
    await withTimeout(refresh(), timeoutMs).catch(() => false);
  }

  function decide() {
    const o = owner();
    const c = loadCache(o);
    const a = c.answer && now() - c.answer.fetchedAt <= STALE_MS ? c.answer : null;
    const lastKnown = installPolicy().enforcedLastKnown;
    if (!o.ownerSub) {
      if ((a && !a.enforced) || (!a && lastKnown === false)) return { mode: 'D' };
      return { mode: 'F', limits: FREE, free: true, owner: o };
    }
    if (a && a.enforced) return { mode: 'E', limits: a.limits || FREE, free: !!a.free, owner: o, devices: c.devices || {}, devicesAt: c.devicesAt || 0 };
    if (a || lastKnown === false) return { mode: 'D' };
    return { mode: 'E', limits: FREE, free: true, owner: o, devices: freshDevices(c.devices), devicesAt: c.devicesAt || 0 };
  }
  function freshDevices(d) { const out = {}; for (const [k, v] of Object.entries(d || {})) if (v && now() - v.fetchedAt <= STALE_MS) out[k] = v; return out; }

  // The one key that F admits: oldest non-local record by createdAt, tie -> lowest id.
  function fEligible(list) {
    return list.filter((d) => d.local !== true).sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1))[0] || null;
  }
  function deviceCheck(d, dev, list) {
    if (!dev || dev.local === true) return null;        // the Mac's own window is not a device
    if (d.mode === 'F') { const e = fEligible(list); return e && e.id === dev.id ? null : planLimit('devices'); }
    if (!dev.hubDeviceId || dev.ownerSub !== d.owner.ownerSub || Number(dev.ownerEpoch) !== d.owner.ownerEpoch) return planLimit('devices', 'unbound');
    const s = d.devices[dev.hubDeviceId];
    if (!s) return planLimit('devices', 'not_in_plan');
    if (s.status !== 'active') return planLimit('devices', 'paused');
    return null;
  }
  // Allowed machine ids: local first, then config order, <= maxMachines (null = all).
  function allowedMachines(ids, d = decide()) {
    if (d.mode === 'D' || d.limits.maxMachines == null) return ids.slice();
    return ids.slice(0, Math.max(0, Number(d.limits.maxMachines) || 0));
  }

  // ctx: { cred: {kind:'server'|'device', dev}, op: 'api'|'start'|'claim'|'devices'|'download', local, method, path,
  //        machineId, machineIds, keys (pairing.list() with hubDeviceId/owner), hubDeviceId (claim) }
  // -> null (allow) | PolicyRefusal. Never rejects.
  async function authorize(req, u, ctx = {}) {
    try {
      await ensureFresh();
      let d = decide();
      if (d.mode === 'D') return null;
      const { cred = {}, op = 'api' } = ctx;
      if (cred.kind === 'server' && !ctx.local && d.free) return planLimit('devices', 'server_token_remote');
      if (op === 'start') return null;
      if (op === 'claim') {
        if (d.mode === 'F') return null;                  // local count happens in the sync commit (claimAllowed)
        if (!ctx.hubDeviceId) return planLimit('devices', 'not_in_plan');
        // Fail closed: needs a device answer <= 300 s old (or a fresh read within timeoutMs), else 503 BUSY.
        const fresh = (x) => x.devicesAt && now() - x.devicesAt <= TTL_MS;
        if (!fresh(d)) { await withTimeout(refresh(), timeoutMs).catch(() => false); d = decide(); if (d.mode === 'D') return null; }
        if (!fresh(d)) return busy();
        const s = d.devices[ctx.hubDeviceId];
        if (!s) return planLimit('devices', 'not_in_plan');
        if (s.status !== 'active') return planLimit('devices', s.status === 'missing' ? 'not_in_plan' : 'paused');
        return null;
      }
      if (cred.kind === 'device') { const r = deviceCheck(d, cred.dev, ctx.keys || []); if (r) return r; }
      if (op === 'api' && ctx.method === 'POST' && SCREEN_INPUT.test(ctx.path || '') && d.limits.remoteDesktop === 'view') return planLimit('remoteDesktop');
      if (ctx.machineId && ctx.machineIds && !allowedMachines(ctx.machineIds, d).includes(ctx.machineId)) return planLimit('machines');
      return null;
    } catch (e) {
      log.error(`plan-policy: authorize: ${(e && e.message) || e}`);
      return null;
    }
  }

  // Sync, inside the claim commit: F counts the local key list (non-local keys) against maxDevices.
  function claimAllowed(list) {
    const d = decide();
    if (d.mode !== 'F') return true;
    return list.filter((x) => x.local !== true).length < FREE.maxDevices;
  }

  // ---- open sessions (R5) --------------------------------------------------------------------------------
  // Every admitted request registers {cred, machineId, credOk, close}; short requests untrack on close. A
  // re-check runs after every refresh outcome and on every owner-barrier tick: the cached answer is re-applied
  // (no hub call of its own) and a session whose device, machine or credential no longer passes is closed.
  const sessions = new Set();
  function track(sess) { sessions.add(sess); return () => sessions.delete(sess); }
  let lastOwnerKey = null;
  function recheck(machineIds) {
    const d = decide();
    const ok = (x) => {
      if (x.credOk && !x.credOk()) return false;
      if (d.mode === 'D') return true;
      if (x.cred && x.cred.kind === 'server' && !x.local && d.free) return false;
      if (x.cred && x.cred.kind === 'device') {
        const dev = x.currentDev ? x.currentDev() : x.cred.dev;
        if (!dev || deviceCheck(d, dev, x.keys ? x.keys() : [])) return false;
      }
      const ids = typeof machineIds === 'function' ? machineIds() : machineIds;
      if (x.machineId && ids && !allowedMachines(ids, d).includes(x.machineId)) return false;
      return true;
    };
    let closed = 0;
    for (const x of [...sessions]) if (!ok(x)) { sessions.delete(x); closed++; try { x.close(); } catch (_) {} }
    return closed;
  }
  const sessionCount = () => sessions.size;

  // Server poll driver (R7): refresh at the cached answer's fetchedAt + 300 s (backoff 30 s -> 300 s while the
  // hub fails), and re-read owner.json every 5 s; each outcome re-checks open sessions.
  function startPoll({ machineIds, barrierMs = 5000, setT = setTimeout, clearT = clearTimeout } = {}) {
    let stopped = false, pollT = null, barT = null, backoff = 30000;
    const ownerKey = () => { const o = owner(); return o.ownerSub + '#' + o.ownerEpoch; };
    lastOwnerKey = ownerKey();
    function schedule() {
      if (stopped) return;
      const c = loadCache(owner());
      const due = c.answer ? Math.max(0, c.answer.fetchedAt + TTL_MS - now()) : 0;
      pollT = setT(tick, due || backoff);
      if (pollT && pollT.unref) pollT.unref();
    }
    async function tick() {
      const okR = await refresh().catch(() => false);
      backoff = okR ? 30000 : Math.min(backoff * 2, TTL_MS);
      recheck(machineIds);
      schedule();
    }
    function barrier() {
      if (stopped) return;
      const k = ownerKey();
      if (k !== lastOwnerKey) { lastOwnerKey = k; cache = null; recheck(machineIds); refresh().then(() => recheck(machineIds), () => {}); }
      barT = setT(barrier, barrierMs);
      if (barT && barT.unref) barT.unref();
    }
    schedule(); barrier();
    return () => { stopped = true; clearT(pollT); clearT(barT); };
  }

  // This installation's id for proofs: <state>/bridge-install-id (0600), created once.
  let installIdMemo = null;
  function installId() {
    if (installIdMemo) return installIdMemo;
    const file = f('bridge-install-id');
    let v = ''; try { v = fs.readFileSync(file, 'utf8').trim(); } catch (_) {}
    if (!/^[0-9a-f]{32}$/.test(v)) { v = require('crypto').randomBytes(16).toString('hex'); try { writePrivate(file, v); } catch (_) {} }
    installIdMemo = v.replace(/"/g, '');
    return installIdMemo;
  }

  // For claim/bind: the device row from an answer <= 300 s old, refreshing once (<= timeoutMs) if needed.
  // -> { mode, owner, fresh, row: {status, publicKey} | null }. Never rejects. Owner-null makes no hub call.
  async function deviceAnswer(hubDeviceId) {
    try {
      const o = owner();
      if (!o.ownerSub) return { mode: decide().mode, owner: o, fresh: false, row: null };
      const isFresh = () => { const c = loadCache(owner()); return !!(c.devicesAt && now() - c.devicesAt <= TTL_MS); };
      if (!isFresh()) await withTimeout(refresh(), timeoutMs).catch(() => false);
      const c = loadCache(owner());
      const d = decide();
      return { mode: d.mode, owner: owner(), fresh: isFresh(), row: (c.devices || {})[hubDeviceId] || null };
    } catch (e) { return { mode: 'E', owner: owner(), fresh: false, row: null }; }
  }

  return { authorize, decide, refresh, ensureFresh, allowedMachines, claimAllowed, startPoll, owner, installId, deviceAnswer, track, recheck, sessionCount };
}

// Default hub client over fetch (Node >= 18). Tests inject their own.
function createHubClient({ base, slug = 'hyprmux', fetchImpl = globalThis.fetch }) {
  const root = String(base || '').replace(/\/+$/, '') + '/api/v1/apps/' + slug;
  async function get(p, token) {
    const r = await fetchImpl(root + p, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    if (r.status === 404) { const b = await r.json().catch(() => ({})); if (b && (b.code === 'PLANS_NOT_CONFIGURED' || (b.error && b.error.code === 'PLANS_NOT_CONFIGURED'))) return { enforced: false }; }
    if (!r.ok) throw new Error('hub_' + r.status);
    const b = await r.json();
    // The hub answers in its envelope {success, data}; older stubs answer the bare object.
    return b && typeof b === 'object' && b.success === true && 'data' in b ? b.data : b;
  }
  return {
    plans: () => get('/plans'),
    entitlement: async (t) => { const b = await get('/entitlement', t); return b && 'entitlement' in b ? (b.entitlement ? { ...b.entitlement, enforced: b.enforced ?? b.entitlement.enforced } : { enforced: false }) : b; },
    devices: async (t) => { const b = await get('/devices', t); return Array.isArray(b) ? b : (b && b.devices) || []; },
  };
}

module.exports = { createPolicy, createHubClient, PolicyRefusal, respond, planLimit, FREE, TTL_MS, STALE_MS, FAIL_BACKOFF_MS, SCREEN_INPUT };
