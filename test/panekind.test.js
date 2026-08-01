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
