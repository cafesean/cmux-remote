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
};
const WAITING = new Set(['needs-you', 'your-turn']);

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

  async function menuFor(surface) {
    if (!readGrid || !surface) return null;
    let e = cache.get(surface);
    if (!e || now() - e.at >= LIMITS.choiceScreenTtlMs) {
      e = { at: now(), read: withTimeout(readGrid(surface), LIMITS.choiceScreenTimeoutMs), hash: e && e.hash, menu: e && e.menu };
      touch(surface, e);
    }
    const grid = await e.read;
    if (!grid || grid.plain) return null;
    const h = gridHash(grid);
    if (h !== e.hash) {
      e.hash = h;
      try { e.menu = menuparse.menuChoice(grid, { tailRows: LIMITS.choiceScreenTailRows }); } catch (_) { e.menu = null; }
    }
    return e.menu;
  }

  // input: {status, lastMsgs, surface, screen: bool}. Returns a Choice or null.
  async function choiceFor({ status, lastMsgs = [], surface, screen = true }) {
    if (!WAITING.has(status)) return null;
    const m = screen ? await menuFor(surface) : null;
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

  return { choiceFor, menuFor };
}

module.exports = { createChoiceReader, LIMITS, WAITING };
