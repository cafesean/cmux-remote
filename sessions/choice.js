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
  // A17 askForm (multi-question / multi-select AskUserQuestion)
  askFormQuestionsMax: 8,       // questions per form offered as buttons (more -> no askForm choice)
  askFormOtherMax: 500,         // chars of "Other" free text per answer
  askFormLookbackRows: 16,      // grid rows above option 1 searched for the question text
  askFormStepTimeoutMs: 4000,   // per key step: wait this long for the screen to show the expected state
  askFormRelayTimeoutMs: 90000, // server.js relay timeout for an askForm choose (a single pick keeps 20000)
};
const WAITING = new Set(['needs-you', 'your-turn']);

// Stable id of WHAT is being asked: source + question + option labels. POST /cmux/choose refuses a pick
// whose choiceId no longer matches the freshly recomputed choice.
const choiceIdOf = (c) => crypto.createHash('sha1').update(JSON.stringify(c.source === 'askForm'
  ? [c.source, c.questions.map((q) => [q.header, q.question, q.multiSelect, q.options.map((o) => o.label)])]
  : [c.source, c.question, c.options.map((o) => o.label)])).digest('hex').slice(0, 16);
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
    const form = askFormOf(lastMsgs);
    if (form) return form;
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

  // A17: answer a whole askForm. Drives Claude Code's tabbed selector one question at a time; every key
  // is followed by a fresh screen that must show the expected state (highlight / tab / checkbox / text)
  // before the next key. The final Submit is pressed only after the review step shows every answer.
  // Any mismatch stops with 409 {error, step} and the form is left unsubmitted.
  // One drive per surface at a time: a second choose while one runs is 409 busy (no keys).
  const inFlight = new Set();
  async function commitForm(args, io) {
    if (inFlight.has(args.surface)) return { code: 409, body: { error: 'busy' } };
    inFlight.add(args.surface);
    try { return await driveForm(args, io); } finally { inFlight.delete(args.surface); }
  }
  async function driveForm({ current, choiceId, answers, surface }, io) {
    const stale = (error, step) => ({ code: 409, body: { error, step, choice: current || null } });
    if (!current || current.source !== 'askForm' || current.choiceId !== choiceId) return stale('stale', 'choice');
    const qs = current.questions;
    const plan = planAnswers(qs, answers);
    if (plan.error) return { code: 400, body: { error: plan.error } };
    const read = async () => screenOf(await withTimeout(readGrid(surface), LIMITS.choiceScreenTimeoutMs));
    const locate = (sc) => (sc && sc.grid && !sc.grid.plain ? formAt(sc.grid, qs) : null);
    // Poll fresh screens until `want(f)` holds; f = the located form state. null on timeout.
    const waitFor = async (want) => {
      const until = now() + LIMITS.askFormStepTimeoutMs;
      let last = null;
      do {
        await sleep(LIMITS.choiceReadbackPollMs);
        last = locate(await read());
        if (last && want(last)) return { ok: last };
      } while (now() < until);
      return { last };
    };
    const press = async (k) => { const r = await io.pressKey(k); return !!(r && r.ok); };
    const keyFail = (step) => ({ code: 502, body: { error: 'key_failed', step } });
    const sameTab = (a, b) => a.tab === b.tab;
    // Arrows from the CURRENT highlight to item `idx`, then readback that `idx` is highlighted.
    async function moveTo(st, idx, step) {
      if (!st.menu.items[idx]) return { err: stale('selection_moved', step) };
      const steps = menuparse.stepsTo(st.menu, idx);
      if (!steps.length) return { st };
      for (const k of steps) if (!(await press(k))) return { err: keyFail(step) };
      const w = await waitFor((f) => sameTab(f, st) && f.menu.markedIndex === idx);
      if (w.ok) return { st: w.ok };
      return { err: w.last && sameTab(w.last, st) ? stale('selection_moved', step) : { code: 409, body: { error: 'no_confirmation', step } } };
    }

    let st = locate(await read());
    if (!st) return stale('stale', 'locate');
    while (st.tab > 0) {                                   // back to question 1, one confirmed tab at a time
      const step = `tab:${st.tab}`;
      if (!(await press('left'))) return keyFail(step);
      const want = st.tab - 1;
      const w = await waitFor((f) => f.tab === want);
      if (!w.ok) return { code: 409, body: { error: 'no_confirmation', step } };
      st = w.ok;
    }
    for (let q = 0; q < qs.length; q++) {
      const a = plan[q];
      const step = `q:${q}`;
      if (st.tab !== q) return stale('selection_moved', step);
      if (a.other !== undefined) {
        const oi = qs[q].options.length;
        const ostep = `${step}:other`;
        const m = await moveTo(st, oi, ostep);
        if (m.err) return m.err;
        st = m.st;
        const onOther = (f) => f.tab === q && f.menu.markedIndex === oi;
        // The input must be EMPTY (placeholder) before typing: old text from an earlier attempt is
        // erased with backspace and the placeholder read back, so "old"+"new" can never be submitted.
        if (!isPlaceholder(otherRowText(st, oi))) {
          const n = Math.min(otherRowText(st, oi).length + 2, LIMITS.askFormOtherMax + 2);
          for (let i = 0; i < n; i++) if (!(await press('backspace'))) return keyFail(ostep);
          const w = await waitFor((f) => onOther(f) && isPlaceholder(otherRowText(f, oi)));
          if (!w.ok) return stale('selection_moved', `${ostep}:clear`);
          st = w.ok;
        }
        // Probe: ONE non-digit character first, read back IN the Other row, before the rest is typed —
        // proves keystrokes land in the input and are not selector hotkeys (a digit would pick/submit).
        const probe = /^[0-9]/.test(a.other) ? 'x' : a.other[0];
        const r1 = await io.sendText(probe, false);
        if (!r1 || !r1.ok) return { code: 502, body: { error: 'send_failed', step: ostep } };
        const w1 = await waitFor((f) => onOther(f) && compact(otherRowText(f, oi)) === compact(probe));
        if (!w1.ok) return stale('selection_moved', `${ostep}:probe`);
        let rest = a.other.slice(1);
        if (probe !== a.other[0]) {
          if (!(await press('backspace'))) return keyFail(ostep);
          const w2 = await waitFor((f) => onOther(f) && isPlaceholder(otherRowText(f, oi)));
          if (!w2.ok) return stale('selection_moved', `${ostep}:probe`);
          rest = a.other;
        }
        if (rest) {
          const r = await io.sendText(rest, false);
          if (!r || !r.ok) return { code: 502, body: { error: 'send_failed', step: ostep } };
        }
        const w = await waitFor((f) => onOther(f) && compact(otherRowText(f, oi)) === compact(a.other));
        if (!w.ok) return stale('selection_moved', ostep);
        st = w.ok;
        if (!(await press('enter'))) return keyFail(step);
      } else if (!qs[q].multiSelect) {
        const m = await moveTo(st, a.picks[0], `${step}:pick`);
        if (m.err) return m.err;
        st = m.st;
        if (!(await press('enter'))) return keyFail(step);
      } else {
        for (let i = 0; i < qs[q].options.length; i++) {
          const wantOn = a.picks.includes(i);
          if (st.checked[i] === wantOn) continue;
          const m = await moveTo(st, i, `${step}:toggle:${i}`);
          if (m.err) return m.err;
          st = m.st;
          if (!(await press(ASK_FORM_TOGGLE_KEY))) return keyFail(`${step}:toggle:${i}`);
          const w = await waitFor((f) => f.tab === q && f.checked[i] === wantOn);
          if (!w.ok) return stale('selection_moved', `${step}:toggle:${i}`);
          st = w.ok;
        }
        // Leave the question: its own Next/Submit row when it draws one, else the tab bar's →.
        const next = st.menu.items.findIndex((it, i) => i > qs[q].options.length && /^(next|submit|done|continue)\b/i.test(it.text));
        if (next >= 0) {
          const m = await moveTo(st, next, `${step}:next`);
          if (m.err) return m.err;
          if (!(await press('enter'))) return keyFail(step);
        } else if (!(await press('right'))) return keyFail(step);
      }
      const w = await waitFor((f) => f.tab === q + 1);
      if (!w.ok) return { code: 409, body: { error: 'no_confirmation', step } };
      st = w.ok;
    }
    // Review: every planned answer must be on screen before Submit is pressed.
    if (!st.review) return stale('selection_moved', 'review');
    // Per question: its own `● question` / `→ answer` pair, answer matched EXACTLY (multi: the exact
    // comma-joined set in option order), never a substring of the whole block.
    for (let q = 0; q < qs.length; q++) {
      const a = plan[q];
      const want = a.other !== undefined ? a.other : a.picks.map((i) => qs[q].options[i].label).join(', ');
      const pairs = st.reviewPairs.filter((p) => p.question === compact(qs[q].question));
      if (pairs.length !== 1 || pairs[0].answer !== compact(want)) return stale('selection_moved', `review:q:${q}`);
    }
    const submitAt = st.menu.items.findIndex((it) => /^submit/i.test(it.text));
    if (submitAt < 0) return stale('selection_moved', 'review');
    const m = await moveTo(st, submitAt, 'submit');
    if (m.err) return m.err;
    if (!(await press('enter'))) return keyFail('submit');
    // Read back that the form closed. Submit WAS pressed, so this is 200 either way; `confirmed` says
    // whether a fresh screen proved it.
    const until = now() + LIMITS.askFormStepTimeoutMs;
    let gone = false;
    while (!gone && now() < until) {
      await sleep(LIMITS.choiceReadbackPollMs);
      const sc = await read();
      gone = !!(sc && sc.grid) && !locate(sc);
    }
    return { code: 200, body: { ok: true, confirmed: gone } };
  }

  return { choiceFor, menuFor, commit, commitForm };
}

// ---- A17 askForm ------------------------------------------------------------------------------

// Multi-select toggle key in Claude Code's selector (UNVERIFIED live: see task-A17-report.md).
const ASK_FORM_TOGGLE_KEY = 'space';

// The pending AskUserQuestion's questions (the transcript's trailing `question` messages of ONE
// tool_use: ids `<uuid>:<block>` then `<uuid>:<block>:<k>`). Offered as askForm when there is more than
// one question or any is multi-select; a single single-select question stays menu/ask (A14).
function askFormOf(msgs) {
  let i = msgs.length - 1;
  while (i >= 0 && (msgs[i].kind === 'todo' || msgs[i].kind === 'attachment')) i--;
  if (i < 0 || msgs[i].kind !== 'question') return null;
  const id = String(msgs[i].id || '');
  const m = /^(.+:\d+):\d+$/.exec(id);
  const base = m ? m[1] : id;
  const qs = [msgs[i]];
  if (base) for (let j = i - 1; j >= 0 && msgs[j].kind === 'question' && (msgs[j].id === base || String(msgs[j].id || '').startsWith(`${base}:`)); j--) qs.unshift(msgs[j]);
  if (qs.length > LIMITS.askFormQuestionsMax) return null;
  if (qs.length < 2 && !qs.some((x) => x.question && x.question.multi)) return null;
  const questions = qs.map((x) => x.question || {}).map((q) => ({
    header: clip(q.header), question: clip(q.text), multiSelect: !!q.multi,
    options: (Array.isArray(q.options) ? q.options : []).slice(0, LIMITS.choiceOptionsMax)
      .map((o) => ({ label: clip(o.label), description: clip(o.description) })),
  }));
  if (questions.some((q) => !q.options.length)) return null;
  return { source: 'askForm', question: questions[0].question || questions[0].header, questions, options: [] };
}

const isPlaceholder = (t) => /^type something\.?$/i.test(String(t).trim());
// The Other row's full text (it wraps for long input): its rows up to the next item, minus `❯ n.`.
function otherRowText(f, oi) {
  const it = f.menu.items[oi];
  const next = f.menu.items[oi + 1];
  const rows = f.rows.filter((r) => r.row >= it.startRow && (!next || r.row < next.startRow) && !(r.isRuleish && !r.isBlank) && !r.isBlank);
  return rows.map((r) => r.trimmed).join(' ').replace(/^\s*[❯▶►▸➤»‣]?\s*\d{1,2}[.)]\s*/, '').trim();
}
// Review block -> [{question, answer}] (compacted). `●` starts a question, `→` its answer; rows after
// either continue it (wraps). The `│` gutter is ignored.
function reviewPairsOf(lines) {
  const out = [];
  let cur = null, part = null;
  for (const raw of lines) {
    const t = raw.replace(/^[\s│|]+/, '');
    if (!t) { part = null; continue; }               // a blank row ends the pair (e.g. before "Ready to submit")
    if (t.startsWith('●')) { cur = { question: t.slice(1), answer: null }; out.push(cur); part = 'q'; }
    else if (t.startsWith('→') && cur) { cur.answer = t.slice(1); part = 'a'; }
    else if (cur && part === 'a') cur.answer += ' ' + t;
    else if (cur && part === 'q') cur.question += ' ' + t;
  }
  return out.map((p) => ({ question: compact(p.question), answer: p.answer === null ? null : compact(p.answer) }));
}

const compact = (s) => String(s || '').replace(/[\s│|]+/g, '');
const CHECKBOX_RE = /^(\[.?\]|[☐☒◻◼])\s*/;
const isChecked = (text) => /^(\[[^\s\]]\]|[☒◼])/.test(text);
// A selector row's text is the label's first wrapped row: a prefix of the label (whitespace-free compare).
function itemIs(text, label) {
  const t = compact(String(text).replace(CHECKBOX_RE, ''));
  const l = compact(label);
  return !!t && (t === l || (l.startsWith(t) && t.length >= Math.min(l.length, 8)));
}

// Where the live screen is in the form: {tab, review, menu, checked[], textBelow, reviewText}, tab =
// question index or questions.length for the review step. null when the screen is not this form.
function formAt(grid, qs) {
  const menu = menuparse.parseNumberedMenu(grid, { tailRows: LIMITS.choiceScreenTailRows });
  if (!menu) return null;
  const rows = menuparse.buildRows(grid).rows;
  const first = menu.items[0].startRow;
  const above = [];
  for (const r of rows) {
    if (r.row >= first || r.row < first - LIMITS.askFormLookbackRows) continue;
    if (r.isRuleish && !r.isBlank) above.length = 0; else above.push(r.trimmed);   // only rows below the form's top rule
  }
  const aboveText = compact(above.join(' '));
  const textBelow = compact(rows.filter((r) => r.row >= first).map((r) => r.trimmed).join(' '));
  const base = { menu, rows, textBelow, checked: [] };
  if (/Readytosubmityouranswers\?/.test(aboveText) || /^submit answers/i.test(menu.items[0].text)) {
    // The review lists every answer above the prompt; read the whole form block (past the lookback).
    let start = rows.findIndex((r) => r.row >= first);
    let i = start - 1;
    while (i >= 0 && !(rows[i].isRuleish && !rows[i].isBlank)) i--;
    const block = [];                                   // rows with no spans are blank rows: keep them as ''
    rows.slice(i + 1, start).forEach((r, k, arr) => { if (k && r.row > arr[k - 1].row + 1) block.push(''); block.push(r.trimmed); });
    return { ...base, tab: qs.length, review: true, reviewText: compact(block.join(' ')), reviewPairs: reviewPairsOf(block) };
  }
  const hits = [];
  qs.forEach((q, k) => {
    if (!aboveText.includes(compact(q.question))) return;
    if (q.options.every((o, i) => menu.items[i] && itemIs(menu.items[i].text, o.label))) hits.push(k);
  });
  if (hits.length !== 1) return null;
  const q = qs[hits[0]];
  return { ...base, tab: hits[0], review: false, checked: q.options.map((o, i) => isChecked(menu.items[i].text)) };
}

// answers -> per-question plan, or {error}. Every question exactly once; single-select = one pick.
function planAnswers(qs, answers) {
  if (!Array.isArray(answers) || answers.length !== qs.length) return { error: 'bad_answers' };
  const plan = new Array(qs.length);
  for (const a of answers) {
    if (!a || !Number.isInteger(a.q) || a.q < 0 || a.q >= qs.length || plan[a.q]) return { error: 'bad_answers' };
    const q = qs[a.q];
    if (a.other !== undefined) {
      if (q.multiSelect) return { error: 'other_multi_unsupported' };
      // No backslash: `cmux send` turns \n \r \t into Enter/Tab (would answer/submit unread). No C0/C1
      // controls or Unicode line breaks. Trimmed, because the readback compares the row exactly.
      if (typeof a.other !== 'string' || !a.other.trim() || a.other !== a.other.trim() || a.other.length > LIMITS.askFormOtherMax
        || /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(a.other)) return { error: 'bad_other' };
      plan[a.q] = { other: a.other };
      continue;
    }
    const p = a.picks;
    if (!Array.isArray(p) || !p.length || new Set(p).size !== p.length) return { error: 'bad_answers' };
    if (!p.every((i) => Number.isInteger(i) && i >= 0 && i < q.options.length)) return { error: 'bad_answers' };
    if (!q.multiSelect && p.length !== 1) return { error: 'bad_answers' };
    plan[a.q] = { picks: [...p].sort((x, y) => x - y) };
  }
  return plan;
}

module.exports = { createChoiceReader, choiceIdOf, LIMITS, WAITING, askFormOf, formAt, planAnswers };
