'use strict';
// p41 A14 — Session.choice: the answer buttons for what a waiting session is asking RIGHT NOW
// (sessions/CONTRACT.md "Session.choice"). Three sources, first match wins:
//
//   1. menu     the live terminal selector (permission prompt, AskUserQuestion, any numbered/arrow
//               menu), parsed by the SAME public/menuparse.js the PWA runs. send = the PWA's keys.
//   2. ask      the pending AskUserQuestion in the transcript (no readable live menu). send = the
//               option's number, typed without Enter (Claude Code's selector picks on a digit).
//   3. callout  a callout with `options:` in the last assistant message. send = the option as a
//               normal message + Enter.
//
// Only while the session waits (needs-you / your-turn). The screen read is capped (LIMITS) and the
// parse is cached per surface by screen hash; the read itself is shared for `screenTtlMs`.
const crypto = require('crypto');
const menuparse = require('../public/menuparse.js');
const { tailOf } = require('./status');

const LIMITS = {
  choiceScreenTailRows: 40,     // bottom grid rows the menu parser looks at
  choiceScreenTimeoutMs: 1500,  // a screen read slower than this is "no live menu"
  choiceScreenTtlMs: 1500,      // one screen read per surface is shared this long (list + streams)
  choiceCacheMax: 64,           // surfaces whose last read/parse is cached
  choiceOptionsMax: 9,          // buttons per choice
  choiceLabelMax: 200,          // chars per label / question
  choiceReadbackTimeoutMs: 4000, // POST /cmux/choose: wait this long for a frame newer than the arrows (= app.js READBACK_TIMEOUT_MS)
  choiceReadbackPollMs: 150,    // screen re-read cadence while waiting for that frame
};
const WAITING = new Set(['needs-you', 'your-turn']);

// Stable id of WHAT is being asked: source + question + option labels. POST /cmux/choose refuses a pick
// whose choiceId no longer matches the freshly recomputed choice.
const choiceIdOf = (c) => crypto.createHash('sha1').update(JSON.stringify([c.source, c.question, c.options.map((o) => o.label)])).digest('hex').slice(0, 16);
const withId = (c) => (c ? { choiceId: choiceIdOf(c), ...c } : c);
// readGrid may answer the grid itself or the bridge's {seq, grid} payload.
const screenOf = (r) => (r && r.grid ? { seq: r.seq, grid: r.grid } : r ? { seq: undefined, grid: r } : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s) => String(s || '').slice(0, LIMITS.choiceLabelMax);
const gridHash = (grid) => crypto.createHash('md5').update(JSON.stringify([grid.spans || grid.row_spans, grid.cursor, grid.rows])).digest('hex');

function withTimeout(p, ms) {
  let t;
  return Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => { t = setTimeout(() => r(null), ms); })])
    .finally(() => clearTimeout(t));
}

function createChoiceReader({ readGrid, now = Date.now } = {}) {
  const cache = new Map();   // surface -> {at, read: Promise<grid|null>, hash, menu}
  const touch = (k, v) => {
    cache.delete(k); cache.set(k, v);
    while (cache.size > LIMITS.choiceCacheMax) cache.delete(cache.keys().next().value);
  };

  async function menuFor(surface, fresh) {
    if (!readGrid || !surface) return null;
    let e = cache.get(surface);
    if (fresh || !e || now() - e.at >= LIMITS.choiceScreenTtlMs) {
      e = { at: now(), read: withTimeout(readGrid(surface), LIMITS.choiceScreenTimeoutMs), hash: e && e.hash, menu: e && e.menu };
      touch(surface, e);
    }
    const sc = screenOf(await e.read);
    const grid = sc && sc.grid;
    if (!grid || grid.plain) return null;
    const h = gridHash(grid);
    if (h !== e.hash) {
      e.hash = h;
      try { e.menu = menuparse.menuChoice(grid, { tailRows: LIMITS.choiceScreenTailRows }); } catch (_) { e.menu = null; }
    }
    return e.menu;
  }

  // input: {status, lastMsgs, surface, screen: bool}. Returns a Choice or null.
  async function choiceFor(input) { return withId(await rawChoice(input)); }
  async function rawChoice({ status, lastMsgs = [], surface, screen = true, fresh = false }) {
    if (!WAITING.has(status)) return null;
    const m = screen ? await menuFor(surface, fresh) : null;
    if (m && m.options.length) {
      return { source: 'menu', question: clip(m.question),
        options: m.options.slice(0, LIMITS.choiceOptionsMax).map((o) => ({ label: clip(o.label), send: { keys: o.send.keys } })) };
    }
    const tail = tailOf(lastMsgs);
    const q = tail.question;
    if (q && !q.multi && Array.isArray(q.options) && q.options.length) {
      return { source: 'ask', question: clip(q.text || q.header),
        options: q.options.slice(0, LIMITS.choiceOptionsMax).map((o, i) => ({ label: clip(o.label), send: { text: String(i + 1), submit: false } })) };
    }
    const c = [...tail.callouts].reverse().find((x) => Array.isArray(x.options) && x.options.length);
    if (c) {
      return { source: 'callout', question: clip(c.title),
        options: c.options.slice(0, LIMITS.choiceOptionsMax).map((o) => ({ label: clip(o), send: { text: o, submit: true } })) };
    }
    return null;
  }

  // Execute a pick against a choice recomputed NOW (caller passes it). Never trusts the app's keys.
  //   io: {pressKey(key) -> {ok}, sendText(text, submit) -> {ok}}
  // -> {code, body}. Menu picks are the PWA's commitMenuPick: arrows computed from the CURRENT
  // highlight, then a frame strictly newer than the arrows must show `label` highlighted, and only
  // then Enter. Anything unproved sends no Enter.
  async function commit({ current, choiceId, index, label, surface }, io) {
    const stale = (error) => ({ code: 409, body: { error, choice: current || null } });
    if (!current) return stale('stale');
    if (current.choiceId !== choiceId) return stale('stale');
    const opt = current.options[index];
    if (!opt || opt.label !== label) return stale('stale');
    if (current.source !== 'menu') {
      const r = await io.sendText(opt.send.text, !!opt.send.submit);
      return r && r.ok ? { code: 200, body: { ok: true } } : { code: 502, body: { error: (r && r.error) || 'send_failed' } };
    }
    const first = screenOf(await withTimeout(readGrid(surface), LIMITS.choiceScreenTimeoutMs));
    const menu = first && first.grid && !first.grid.plain ? menuparse.parseNumberedMenu(first.grid, { tailRows: LIMITS.choiceScreenTailRows }) : null;
    if (!menu || !menu.items[index] || menu.items[index].text !== label) return stale('stale');
    const steps = menuparse.stepsTo(menu, index);
    for (const k of steps) {
      const r = await io.pressKey(k);
      if (!r || !r.ok) return { code: 502, body: { error: 'key_failed' } };
    }
    let seen = first;
    if (steps.length) {
      if (!Number.isFinite(first.seq)) return { code: 409, body: { error: 'no_confirmation' } };
      const until = now() + LIMITS.choiceReadbackTimeoutMs;
      seen = null;
      while (!seen && now() < until) {
        await sleep(LIMITS.choiceReadbackPollMs);
        const sc = screenOf(await withTimeout(readGrid(surface), LIMITS.choiceScreenTimeoutMs));
        if (sc && sc.grid && Number.isFinite(sc.seq) && sc.seq !== first.seq) seen = sc;
      }
      if (!seen) return { code: 409, body: { error: 'no_confirmation' } };
    }
    const after = menuparse.parseNumberedMenu(seen.grid, { tailRows: LIMITS.choiceScreenTailRows });
    const nowText = after && after.items[after.markedIndex] && after.items[after.markedIndex].text;
    if (nowText !== label) return { code: 409, body: { error: 'selection_moved' } };
    const r = await io.pressKey('enter');
    return r && r.ok ? { code: 200, body: { ok: true } } : { code: 502, body: { error: 'key_failed' } };
  }

  return { choiceFor, menuFor, commit };
}

module.exports = { createChoiceReader, choiceIdOf, LIMITS, WAITING };
