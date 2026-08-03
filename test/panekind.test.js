'use strict';
// paneKind decides which pane a generated git command is handed to (spec §7.3.1). Getting it wrong
// hands a destructive command to something that was not asked for, so these tests are about the
// SAFE answer as much as the right one: every ambiguity must land on `unknown`, and `unknown` is
// never a permitted target.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { paneKind } = require('../public/menuparse.js');

const DIR = path.join(__dirname, 'fixtures', 'grids');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')).grid;

test('a real Claude session is an agent, not a shell', () => {
  assert.strictEqual(paneKind({ grid: load('claude-slash'), status: '' }).kind, 'agent');
  assert.strictEqual(paneKind({ grid: load('claude-at'), status: '' }).kind, 'agent');
});

test('a running-agent status wins outright, whatever the grid shows', () => {
  const r = paneKind({ grid: load('neg-numbered-prose'), status: 'claude_code=Running' });
  assert.strictEqual(r.kind, 'agent');
  assert.strictEqual(r.why, 'status');
});

test('a plain shell at a themed prompt is a shell', () => {
  assert.strictEqual(paneKind({ grid: load('neg-numbered-prose'), status: '' }).kind, 'shell');
});

test('no grid is unknown, not a guess', () => {
  assert.strictEqual(paneKind({}).kind, 'unknown');
  assert.strictEqual(paneKind(null).kind, 'unknown');
  assert.strictEqual(paneKind({ grid: {} }).kind, 'unknown');
});

test('an alternate-screen TUI is neither shell nor agent', () => {
  const grid = { active_screen: 'alternate', row_spans: [{ row: 0, column: 0, style_id: 0, text: 'vim' }], styles: [{ id: 0, background: '#000000', foreground: '#FFFFFF' }] };
  assert.strictEqual(paneKind({ grid, status: '' }).kind, 'altscreen');
});

test('an agent that exited leaves a shell prompt below its box, and that is a shell', () => {
  // Both signatures present is the NORMAL case, not the ambiguous one — a live Claude session shows
  // the shell prompt that launched it, still above. Position decides which is current, and a shell
  // prompt below the box means the agent is gone.
  const styles = [
    { id: 0, background: '#000000', foreground: '#999999', inverse: false },
    { id: 1, background: '#1A1A1A', foreground: '#FFFFFF', inverse: false },
  ];
  const grid = {
    active_screen: 'primary', cursor: { row: 6, column: 0 }, styles,
    row_spans: [
      { row: 0, column: 0, style_id: 0, text: '────────────────' },
      { row: 1, column: 0, style_id: 0, text: '❯ ' },
      { row: 2, column: 0, style_id: 0, text: '────────────────' },
      { row: 4, column: 0, style_id: 1, text: ' demouser@127  ~ ' },
    ],
  };
  const r = paneKind({ grid, status: '' });
  assert.strictEqual(r.kind, 'shell');
  assert.match(r.why, /below/);
});

test('a live agent shows a shell prompt too, and is still an agent', () => {
  // The regression that position ordering exists to fix: every real Claude capture contains the
  // shell prompt that started it, so a naive "both signals -> unknown" rule refused to route to any
  // real agent pane at all.
  const g = load('claude-slash');
  const r = paneKind({ grid: g, status: '' });
  assert.strictEqual(r.kind, 'agent');
});

test('the verdict carries the frame it was computed from, so staleness is checkable', () => {
  const grid = load('claude-slash');
  const r = paneKind({ grid, status: '' });
  assert.strictEqual(r.seq, grid.state_seq, 'a verdict older than the pane current frame must be recomputable');
});

// ---- a labelled box border ------------------------------------------------------------------------

// MEASURED FAILURE, not a hypothetical. Claude Code draws the session's NAME into the top rule of its
// input box — `──────── my-session ──` — so that row is not pure rule characters. `isRule` was false
// for it, which had two compounding effects: the box became invisible to lastBoxedPrompt (it needs
// rule/glyph/rule), and the decorated border, which carries a non-default background, was counted by
// lastShellPrompt as a themed shell prompt. paneKind therefore answered `shell` for every NAMED
// session, and the p9 reply gate refused every reply to one as `not_at_prompt` — permanently.
//
// Synthesised, never captured: a real grid of a named session carries the operator's own session name.
const LABELLED = (name) => {
  const styles = [
    { id: 0, background: '#000000', foreground: '#999999', inverse: false },
    // The border's own style — a non-default background, which is exactly the shell-prompt signature.
    { id: 1, background: '#1A1A1A', foreground: '#777777', inverse: false },
  ];
  const pad = '─'.repeat(64);
  return {
    active_screen: 'primary', cursor: { row: 3, column: 2 }, styles,
    row_spans: [
      { row: 0, column: 0, style_id: 0, text: 'some earlier output' },
      { row: 1, column: 0, style_id: 1, text: `${pad} ${name} ──` },
      { row: 2, column: 0, style_id: 0, text: '❯ ' },
      { row: 3, column: 0, style_id: 0, text: '─'.repeat(88) },
      { row: 4, column: 0, style_id: 0, text: '  fixture-model | ctx 1k/1M (1%)' },
    ],
  };
};

test('a named session\'s labelled box border is still a border, so the pane is an agent', () => {
  const r = paneKind({ grid: LABELLED('fixture-session-name'), status: '' });
  assert.strictEqual(r.kind, 'agent', `expected agent, got ${JSON.stringify(r)}`);
  assert.strictEqual(r.why, 'boxed prompt below shell prompt');
});

test('the labelled border is NOT counted as the shell prompt that outranks its own box', () => {
  // The bug read the box's top rule as a prompt BELOW the box, which is what produced `shell`. If the
  // exclusion regressed, this is the assertion that catches it — the border row is row 1, the glyph
  // row 2, so a border counted as a prompt loses to nothing and `shell` wins.
  for (const name of ['a', 'x-cmux-inbox-testing', 'a name with several words in it']) {
    assert.strictEqual(paneKind({ grid: LABELLED(name), status: '' }).kind, 'agent', `name: ${name}`);
  }
});

// The tightening that keeps this safe. A false negative costs a refusal; a false positive types into a
// SHELL. So a row only counts as a border when it is mostly rule characters, contains a drawn run
// rather than scattered punctuation, and carries only a short label.
test('a prose or status row containing dashes is NOT a border', () => {
  const styles = [
    { id: 0, background: '#000000', foreground: '#999999', inverse: false },
    { id: 1, background: '#1A1A1A', foreground: '#FFFFFF', inverse: false },
  ];
  const withBody = (text) => ({
    active_screen: 'primary', cursor: { row: 3, column: 0 }, styles,
    row_spans: [
      { row: 0, column: 0, style_id: 0, text: '─'.repeat(40) },
      { row: 1, column: 0, style_id: 0, text: '❯ ' },
      { row: 2, column: 0, style_id: 0, text: '─'.repeat(40) },
      // A candidate prompt BELOW the box. If it is wrongly judged a border it is skipped and the
      // pane stays `agent`; judged correctly it is a shell prompt below the box, so `shell` wins.
      { row: 4, column: 0, style_id: 1, text },
    ],
  });
  const prose = 'The deploy touched three services - and the retry budget is per-request now.';
  assert.strictEqual(paneKind({ grid: withBody(prose), status: '' }).kind, 'shell',
    'prose with a dash must remain a shell prompt, not become a border');
  const statusLine = '  fixture-name | fixture-model | ctx 421k/1M (42%) | main | 00:05:40';
  assert.strictEqual(paneKind({ grid: withBody(statusLine), status: '' }).kind, 'shell',
    'a status line must remain a shell prompt, not become a border');
  const longLabel = '─'.repeat(14) + ' this label is far too long to be a box title, it is a sentence ' + '─'.repeat(2);
  assert.strictEqual(paneKind({ grid: withBody(longLabel), status: '' }).kind, 'shell',
    'a long remainder disqualifies a row from being a border');
});
