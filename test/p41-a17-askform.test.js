'use strict';
// p41 A17 — askForm: answer a multi-question / multi-select AskUserQuestion (sessions/choice.js).
// Fixtures: test/fixtures/askform/synthetic-* = invented text on the geometry of a read-only live capture
// of a review step. The question tabs are HAND-BUILT below from Claude Code's selector layout
// (test/fixtures/grids/a14-ask.json) plus the tab bar seen live — the fake terminal renders them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createChoiceReader, LIMITS, askFormOf, formAt, planAnswers } = require('../sessions/choice');

LIMITS.choiceReadbackPollMs = 1;
LIMITS.askFormStepTimeoutMs = 60;

const FIX = path.join(__dirname, 'fixtures', 'askform');
const live = JSON.parse(fs.readFileSync(path.join(FIX, 'synthetic-form-input.json'), 'utf8')).input;
const reviewGrid = JSON.parse(fs.readFileSync(path.join(FIX, 'synthetic-review-narrow.grid.json'), 'utf8')).grid;

// Transcript messages exactly as transcript-claude.js emits them for one AskUserQuestion tool_use.
const msgsOf = (input, uuid = 'u1:0') => input.questions.map((q, k) => ({
  id: k ? `${uuid}:${k}` : uuid, ts: 1, kind: 'question',
  question: { header: q.header, text: q.question, multi: !!q.multiSelect, options: q.options.map((o) => ({ label: o.label, description: o.description || '' })) },
}));

// ---- fake Claude Code tabbed selector ----------------------------------------------------------
function fakeForm(input, opts = {}) {
  const qs = input.questions;
  const s = { tab: opts.tab || 0, marked: qs.map(() => 0), answers: qs.map(() => null), checked: qs.map((q) => q.options.map(() => false)),
    other: qs.map(() => ''), reviewMarked: 0, submitted: false, cancelled: false, seq: 1, keys: [] };
  const itemsOf = (k) => {
    const q = qs[k];
    const it = q.options.map((o, i) => (q.multiSelect ? `[${s.checked[k][i] ? '✔' : ' '}] ${o.label}` : o.label));
    it.push(s.other[k] || 'Type something.');
    if (q.multiSelect) it.push('Next');
    it.push('Chat about this');
    return it;
  };
  function render() {
    const lines = ['─'.repeat(80), '←  ' + qs.map((q, k) => `${s.answers[k] ? '☒' : '☐'} ${q.header}`).join('  ') + '  ✔ Submit  →', ''];
    if (s.tab < qs.length) {
      const k = s.tab;
      lines.push(qs[k].question, '');
      itemsOf(k).forEach((t, i) => {
        lines.push(`${i === s.marked[k] ? '❯' : ' '} ${i + 1}. ${t}`);
        if (i < qs[k].options.length && qs[k].options[i].description) lines.push(`     ${qs[k].options[i].description}`);
      });
      lines.push('', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel');
    } else {
      lines.push('Review your answers', '');
      qs.forEach((q, k) => { lines.push(` ● ${q.question}`, `   → ${s.answers[k] || ''}`); });
      lines.push('', 'Ready to submit your answers?', '');
      ['Submit answers', 'Cancel'].forEach((t, i) => lines.push(`${i === s.reviewMarked ? '❯' : ' '} ${i + 1}. ${t}`));
    }
    return { columns: 100, rows: lines.length, styles: [{ id: 0, foreground: '#FFFFFF', background: '#000000' }],
      spans: lines.map((text, row) => ({ row, column: 0, style_id: 0, text })), cursor: { row: lines.length - 1, column: 0, visible: false } };
  }
  const bump = () => { s.seq++; };
  const io = {
    async pressKey(k) {
      s.keys.push(k);
      if (opts.onKey && opts.onKey(k, s) === 'swallow') return { ok: true };
      if (s.tab === qs.length) {
        if (k === 'up') s.reviewMarked = Math.max(0, s.reviewMarked - 1);
        else if (k === 'down') s.reviewMarked = Math.min(1, s.reviewMarked + 1);
        else if (k === 'left') s.tab--;
        else if (k === 'enter') { if (s.reviewMarked === 0) s.submitted = true; else s.cancelled = true; }
        bump(); return { ok: true };
      }
      const t = s.tab, n = itemsOf(t).length, q = qs[t];
      if (k === 'up') s.marked[t] = Math.max(0, s.marked[t] - 1);
      else if (k === 'down') s.marked[t] = Math.min(n - 1, s.marked[t] + 1);
      else if (k === 'left') s.tab = Math.max(0, t - 1);
      else if (k === 'right') s.tab = t + 1;
      else if (k === 'space' && q.multiSelect && s.marked[t] < q.options.length) s.checked[t][s.marked[t]] = !s.checked[t][s.marked[t]];
      else if (k === 'enter') {
        const m = s.marked[t];
        if (q.multiSelect) {
          if (itemsOf(t)[m] === 'Next') { s.answers[t] = q.options.filter((o, i) => s.checked[t][i]).map((o) => o.label).join(', '); s.tab++; }
        } else if (m < q.options.length) { s.answers[t] = q.options[m].label; s.tab++; }
        else if (m === q.options.length && s.other[t]) { s.answers[t] = s.other[t]; s.tab++; }
      }
      bump(); return { ok: true };
    },
    async sendText(text, submit) {
      s.keys.push(`text:${text}${submit ? '+enter' : ''}`);
      const t = s.tab;
      if (t < qs.length && s.marked[t] === qs[t].options.length) s.other[t] += text;
      bump(); return { ok: true };
    },
  };
  const readGrid = async () => ({ seq: s.seq, grid: render() });
  return { s, io, readGrid, render };
}

async function setup(input, opts) {
  const f = fakeForm(input, opts);
  const r = createChoiceReader({ readGrid: f.readGrid });
  const current = await r.choiceFor({ status: 'needs-you', surface: 'S1', lastMsgs: msgsOf(input) });
  return { f, r, current };
}

const multiInput = { questions: [
  { header: 'Approach', question: 'Which approach should I take?', multiSelect: false,
    options: [{ label: 'Small patch', description: 'Touch one file only' }, { label: 'Refactor', description: 'Restructure the module' }] },
  { header: 'Targets', question: 'Which platforms should ship first?', multiSelect: true,
    options: [{ label: 'iOS', description: '' }, { label: 'Android', description: '' }, { label: 'Web', description: '' }] },
  { header: 'Name', question: 'What should the flag be called?', multiSelect: false,
    options: [{ label: 'fast-path', description: '' }, { label: 'quick-mode', description: '' }] },
] };

// ---- shape -------------------------------------------------------------------------------------

test('askForm shape: N questions of one pending AskUserQuestion, stable choiceId, before the live menu', async () => {
  const { current } = await setup(live);
  assert.equal(current.source, 'askForm');
  assert.match(current.choiceId, /^[0-9a-f]{16}$/);
  assert.deepEqual(current.options, []);
  assert.equal(current.questions.length, 3);
  assert.deepEqual(current.questions[2], { header: 'Shape', question: live.questions[2].question, multiSelect: false, options: [
    { label: 'Circle, auto sized (Recommended)', description: live.questions[2].options[0].description },
    { label: 'Square, fixed size', description: live.questions[2].options[1].description }] });
  const again = await setup(live);
  assert.equal(again.current.choiceId, current.choiceId);
  const other = await setup({ questions: [live.questions[0], { ...live.questions[1], question: 'changed' }, live.questions[2]] });
  assert.notEqual(other.current.choiceId, current.choiceId);
});

test('askForm only for the trailing tool_use; single single-select question stays A14; not while working', async () => {
  const older = msgsOf(multiInput, 'u0:0');
  const one = msgsOf({ questions: [multiInput.questions[0]] }, 'u2:0');
  assert.equal(askFormOf([...older, ...one]), null);
  const f = askFormOf([...one, ...msgsOf(live, 'u3:1')]);
  assert.equal(f.questions.length, 3);
  const r = createChoiceReader({ readGrid: async () => null });
  assert.equal(await r.choiceFor({ status: 'working', surface: 'S1', lastMsgs: msgsOf(live) }), null);
});

test('review fixture (synthetic text on live 36-col geometry): located as the review step with every answer readable', () => {
  const qs = askFormOf(msgsOf(live)).questions;
  const at = formAt(reviewGrid, qs);
  assert.equal(at.review, true);
  assert.equal(at.tab, 3);
  assert.deepEqual(at.menu.items.map((i) => i.text), ['Submit answers', 'Cancel']);
  assert.equal(at.menu.markedIndex, 0);
  for (const q of qs) assert.ok(at.reviewText.includes(q.options[0].label.replace(/\s+/g, '')), q.header);
  assert.ok(!at.reviewText.includes('Square,fixedsize'));
});

test('planAnswers: every question once, single = one pick, Other text checked, no control chars', () => {
  const qs = askFormOf(msgsOf(multiInput)).questions;
  assert.ok(Array.isArray(planAnswers(qs, [{ q: 0, picks: [1] }, { q: 1, picks: [2, 0] }, { q: 2, other: 'turbo' }])));
  assert.equal(planAnswers(qs, [{ q: 0, picks: [1] }]).error, 'bad_answers');
  assert.equal(planAnswers(qs, [{ q: 0, picks: [0, 1] }, { q: 1, picks: [0] }, { q: 2, picks: [0] }]).error, 'bad_answers');
  assert.equal(planAnswers(qs, [{ q: 0, picks: [5] }, { q: 1, picks: [0] }, { q: 2, picks: [0] }]).error, 'bad_answers');
  assert.equal(planAnswers(qs, [{ q: 0, picks: [0] }, { q: 0, picks: [0] }, { q: 2, picks: [0] }]).error, 'bad_answers');
  assert.equal(planAnswers(qs, [{ q: 0, picks: [0] }, { q: 1, picks: [0] }, { q: 2, other: 'a\nb' }]).error, 'bad_other');
  assert.equal(planAnswers(qs, [{ q: 0, picks: [0] }, { q: 1, other: 'x' }, { q: 2, picks: [0] }]).error, 'other_multi_unsupported');
});

// ---- commit ------------------------------------------------------------------------------------

test('choose drives N questions with readback, then verifies the review and submits', async () => {
  const { f, r, current } = await setup(live);
  const res = await r.commitForm({ current, choiceId: current.choiceId, surface: 'S1',
    answers: [{ q: 0, picks: [1] }, { q: 1, picks: [2] }, { q: 2, picks: [0] }] }, f.io);
  assert.deepEqual(res, { code: 200, body: { ok: true } });
  assert.equal(f.s.submitted, true);
  assert.deepEqual(f.s.answers, ['Pear', 'Red', 'Circle, auto sized (Recommended)']);
  assert.deepEqual(f.s.keys, ['down', 'enter', 'down', 'down', 'enter', 'enter', 'enter']);
});

test('multiSelect toggles, Other text, starting from a later tab', async () => {
  const { f, r, current } = await setup(multiInput, { tab: 2 });
  const res = await r.commitForm({ current, choiceId: current.choiceId, surface: 'S1',
    answers: [{ q: 2, other: 'turbo mode' }, { q: 0, picks: [0] }, { q: 1, picks: [2, 0] }] }, f.io);
  assert.deepEqual(res, { code: 200, body: { ok: true } });
  assert.equal(f.s.submitted, true);
  assert.deepEqual(f.s.answers, ['Small patch', 'iOS, Web', 'turbo mode']);
  assert.deepEqual(f.s.checked[1], [true, false, true]);
  assert.ok(f.s.keys.includes('text:turbo mode'));
  assert.ok(!f.s.keys.some((k) => k.endsWith('+enter')));
});

test('mismatch mid-way (highlight jumps on question 2) -> 409 selection_moved, no Enter after, never submitted', async () => {
  let armed = true;
  const { f, r, current } = await setup(live, { onKey: (k, s) => {
    if (armed && s.tab === 1 && k === 'down') { armed = false; s.marked[1] = 2; s.seq++; return 'swallow'; }
    return null;
  } });
  const res = await r.commitForm({ current, choiceId: current.choiceId, surface: 'S1',
    answers: [{ q: 0, picks: [0] }, { q: 1, picks: [1] }, { q: 2, picks: [0] }] }, f.io);
  assert.equal(res.code, 409);
  assert.equal(res.body.error, 'selection_moved');
  assert.equal(res.body.step, 'q:1:pick');
  assert.equal(f.s.submitted, false);
  assert.deepEqual(f.s.keys, ['enter', 'down']);
  assert.equal(f.s.answers[1], null);
});

test('a key that does nothing -> 409 no_confirmation, never submitted', async () => {
  const { f, r, current } = await setup(live, { onKey: (k, s) => (s.tab === 2 && k === 'enter' ? 'swallow' : null) });
  const res = await r.commitForm({ current, choiceId: current.choiceId, surface: 'S1',
    answers: [{ q: 0, picks: [0] }, { q: 1, picks: [0] }, { q: 2, picks: [1] }] }, f.io);
  assert.deepEqual([res.code, res.body.error, res.body.step], [409, 'no_confirmation', 'q:2']);
  assert.equal(f.s.submitted, false);
});

test('review not showing an answer -> 409 at review, Submit never pressed', async () => {
  const { f, r, current } = await setup(live, { onKey: (k, s) => {
    if (s.tab === 2 && k === 'enter') { s.answers[2] = 'Square, fixed size'; s.tab = 3; s.seq++; return 'swallow'; }
    return null;
  } });
  const res = await r.commitForm({ current, choiceId: current.choiceId, surface: 'S1',
    answers: [{ q: 0, picks: [0] }, { q: 1, picks: [0] }, { q: 2, picks: [0] }] }, f.io);
  assert.deepEqual([res.code, res.body.error, res.body.step], [409, 'selection_moved', 'review:q:2']);
  assert.equal(f.s.submitted, false);
});

test('stale choiceId -> 409 stale before any key; screen not this form -> 409 stale, nothing sent', async () => {
  const { f, r, current } = await setup(live);
  const res = await r.commitForm({ current, choiceId: 'deadbeefdeadbeef', surface: 'S1', answers: [] }, f.io);
  assert.deepEqual([res.code, res.body.error], [409, 'stale']);
  assert.equal(res.body.choice.choiceId, current.choiceId);
  assert.deepEqual(f.s.keys, []);
  const other = await setup(multiInput);
  const res2 = await r.commitForm({ current: other.current, choiceId: other.current.choiceId, surface: 'S1',
    answers: [{ q: 0, picks: [0] }, { q: 1, picks: [0] }, { q: 2, picks: [0] }] }, f.io);
  assert.deepEqual([res2.code, res2.body.error, res2.body.step], [409, 'stale', 'locate']);
  assert.deepEqual(f.s.keys, []);
  const bad = await r.commitForm({ current, choiceId: current.choiceId, surface: 'S1', answers: [{ q: 0, picks: [0] }] }, f.io);
  assert.deepEqual([bad.code, bad.body.error], [400, 'bad_answers']);
  assert.deepEqual(f.s.keys, []);
});
