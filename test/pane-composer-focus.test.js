// Tapping a pane must land the caret in the composer.
//
// The bug this pins: one composer node is re-parented into whichever pane has focus. Two functions
// move it, and only one of them focuses it — so tapping the thin compose BAR put the caret in the
// box while tapping the PANE did not, and the operator had to tap twice to type once.
//
//   focusPane(paneId)    moves the composer (via mountComposer), does NOT focus it
//   takeComposer(paneId) moves it AND focuses it
//
// The fix routes the two user-gesture paths in wirePaneTaps through takeComposer. The two
// NON-gesture callers must keep using focusPane: uploadFiles() runs on a file drop, and stealing
// focus mid-drop pops the keyboard over the drop target.
//
// Proof style follows test/p8-client-wiring.test.js: lift the shipped source of each function out
// of public/app.js and RUN it against fakes. A regex would pass against the same words sitting in a
// comment or in dead code; evaluating the extracted function cannot — it either behaves or it does
// not. A bad extraction cannot pass quietly either, because `new Function` throws on malformed text.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// A brace matcher that skips comments and string literals — app.js is full of both, and a naive
// depth counter would stop at a `{` inside a comment.
function matchBrace(src, open) {
  assert.equal(src[open], '{', 'matchBrace must start on a {');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return i; }
  }
  throw new Error('unbalanced braces from ' + open);
}

function fnSrc(name) {
  const at = APP.indexOf('function ' + name + '(');
  assert.ok(at > 0, 'public/app.js must declare function ' + name);
  return APP.slice(at, matchBrace(APP, APP.indexOf('{', at)) + 1);
}

function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); if (n < 0) break; i = n - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    out += c;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === '\\') { out += src[++i]; continue; }
        if (src[i] === c) break;
      }
    }
  }
  return out;
}

// ---- harness ---------------------------------------------------------------------------------
// A DOM stub that records handlers so a gesture can be replayed exactly as the browser would.
function fakeEl() {
  const handlers = {};
  return {
    handlers,
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    fire(type, ev) { for (const h of handlers[type] || []) h(ev || {}); },
  };
}

function wireUp(state) {
  const calls = { take: [], focus: [], menu: [] };
  const fn = new Function(
    'state', 'takeComposer', 'focusPane', 'tryMenuClick',
    fnSrc('wirePaneTaps') + '\nreturn wirePaneTaps;',
  );
  const wire = fn(
    state,
    (id) => calls.take.push(id),
    (id) => calls.focus.push(id),
    (v, row) => calls.menu.push(row),
  );
  const v = { paneId: 'p2', screenEl: fakeEl(), headEl: fakeEl() };
  wire(v);
  return { v, calls };
}

const tap = (v, ev) => {
  v.screenEl.fire('pointerdown', Object.assign({ clientX: 10, clientY: 10 }, ev));
  v.screenEl.fire('pointerup', Object.assign({ clientX: 10, clientY: 10, target: null }, ev));
};

// ---- the gesture paths -------------------------------------------------------------------------

test('tapping an unfocused pane takes the composer — the caret lands without a second tap', () => {
  const { v, calls } = wireUp({ tabType: 'terminal', focusPane: 'p1', tab: { id: 't1' } });
  tap(v);
  assert.deepEqual(calls.take, ['p2'], 'the pane tap must call takeComposer');
  assert.deepEqual(calls.focus, [], 'focusPane alone would move the box without focusing it — the bug');
});

test('clicking the pane header takes the composer too', () => {
  const { v, calls } = wireUp({ tabType: 'terminal', focusPane: 'p1', tab: { id: 't1' } });
  v.headEl.fire('click', {});
  assert.deepEqual(calls.take, ['p2']);
  assert.deepEqual(calls.focus, []);
});

test('tapping the ALREADY-focused pane does not re-take it — that path is for row menus', () => {
  const { v, calls } = wireUp({ tabType: 'terminal', focusPane: 'p2', tab: { id: 't1' } });
  tap(v);
  assert.deepEqual(calls.take, [], 're-taking a focused pane would fight the caret on every tap');
});

test('a scroll is not a tap — a drag past the slop threshold takes nothing', () => {
  const { v, calls } = wireUp({ tabType: 'terminal', focusPane: 'p1', tab: { id: 't1' } });
  v.screenEl.fire('pointerdown', { clientX: 10, clientY: 10 });
  v.screenEl.fire('pointermove', { clientX: 10, clientY: 40 });
  v.screenEl.fire('pointerup', { clientX: 10, clientY: 40, target: null });
  assert.deepEqual(calls.take, [], 'scrolling the transcript must never grab the keyboard');
});

test('a non-terminal surface takes nothing on tap', () => {
  const { v, calls } = wireUp({ tabType: 'browser', focusPane: 'p1', tab: { id: 't1' } });
  tap(v);
  assert.deepEqual(calls.take, []);
  assert.deepEqual(calls.focus, []);
});

// ---- the traps ---------------------------------------------------------------------------------

test('focusPane itself never focuses — its non-gesture callers must not pop the keyboard', () => {
  const src = stripComments(fnSrc('focusPane'));
  assert.ok(!/\.focus\s*\(/.test(src),
    'putting elText.focus() inside focusPane would fire it from the file-drop path (uploadFiles)');
});

test('the file-drop path still uses focusPane, not takeComposer', () => {
  const src = stripComments(fnSrc('uploadFiles'));
  assert.ok(/focusPane\(/.test(src), 'a drop must still move the composer to the drop target');
  assert.ok(!/takeComposer\(/.test(src), 'focusing mid-drop steals the caret while files are landing');
});

test('takeComposer focuses AFTER re-parenting, because moving a node drops its focus', () => {
  const src = stripComments(fnSrc('takeComposer'));
  const mount = src.indexOf('mountComposer(');
  const focus = src.search(/\.focus\s*\(/);
  assert.ok(mount > 0 && focus > 0, 'takeComposer must both mount and focus');
  assert.ok(focus > mount, 'focusing before the appendChild would be undone by it');
});

test('the gesture focus is synchronous — iOS ignores .focus() deferred out of the gesture', () => {
  const src = stripComments(fnSrc('wirePaneTaps'));
  assert.ok(!/setTimeout|requestAnimationFrame|await\s/.test(src),
    'deferring the take out of pointerup silently drops the keyboard on iOS');
});
