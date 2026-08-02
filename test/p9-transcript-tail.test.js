'use strict';
// S-002 — §5.2.1, the bounded, boundary-aware transcript tail read.
//
// EVERY FIXTURE HERE IS INVENTED: invented prose, invented uuids, invented session ids, invented
// tool inputs, invented timestamps, written into a fresh temp directory and removed afterwards.
// This repository is public and a real transcript excerpt, id or home path in a test file is the
// one mistake that cannot be taken back.
//
// Two of the tests build a file as head + tail where the tail is EXACTLY one 256 KB window, so the
// read opens on the tail's first byte and the boundary byte at `offset - 1` is the head's last
// byte. That is the only way to aim the boundary rule at a chosen byte instead of hoping a fixture
// lands there.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLastAssistantText } = require('../radar/classify');

const WINDOW = 262144;                       // §5.2.1's 256 KB, spelled as the acceptance criteria spell it
const TS = '2026-07-30T10:00:00.000Z';       // invented

const dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-tail-'));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

const write = (dir, name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };

const textBlocks = (...texts) => texts.map((t) => ({ type: 'text', text: t }));

const asstLine = (content, over) => JSON.stringify(Object.assign({
  type: 'assistant',
  uuid: 'fixture-uuid-a1',
  sessionId: 'fixture-inbox-1',
  timestamp: TS,
  message: { role: 'assistant', content },
}, over || {}));

const userLine = (n) => JSON.stringify({
  type: 'user',
  uuid: `fixture-uuid-u${n}`,
  message: { role: 'user', content: `synthetic turn ${n}` },
});

// An assistant turn carrying no text at all — the shape that must never satisfy the walk.
const toolLine = (n) => JSON.stringify({
  type: 'assistant',
  uuid: `fixture-uuid-t${n}`,
  timestamp: TS,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `fixture-tool-${n}`, name: 'Read', input: { file: '/fixture/notes.txt' } }] },
});

// head + tail, tail exactly WINDOW bytes. `first` is the tail's first line (the element the
// boundary rule decides the fate of); a pad record absorbs the slack so the arithmetic is exact.
function windowFile(dir, name, head, first, rest) {
  const PAD_OPEN = '{"type":"user","uuid":"fixture-uuid-pad","message":{"role":"user","content":"';
  const PAD_CLOSE = '"}}';
  const fixed = [first].concat(rest).join('\n') + '\n';
  const padWidth = WINDOW - fixed.length - (PAD_OPEN.length + PAD_CLOSE.length + 1);
  assert.ok(padWidth >= 0, 'fixture content does not fit inside one window');
  const pad = PAD_OPEN + 'x'.repeat(padWidth) + PAD_CLOSE;
  const tail = [first, pad].concat(rest).join('\n') + '\n';
  assert.strictEqual(Buffer.byteLength(tail), WINDOW, 'tail must be exactly one window');
  assert.ok(head.length > 0, 'head must exist for there to be a boundary byte');
  return write(dir, name, head + tail);
}

test('AC1 - a 2000+ line transcript yields exactly its last assistant text', () => {
  const dir = tmpdir();
  const LAST = 'Two migration orders are viable and they are not equivalent. Build the index before the backfill, or after?';
  const OLDER = 'An older answer that must never win a backwards walk.';
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(i % 5 === 0 ? toolLine(i) : userLine(i));
  lines.splice(1900, 0, asstLine(textBlocks(OLDER)));
  lines.push(asstLine(textBlocks(LAST)));
  lines.push(toolLine(9001));                                  // the winner is not the last line
  lines.push(userLine(9001));
  assert.ok(lines.length >= 2000, 'fixture must be at least 2000 lines');

  const p = write(dir, 'long.jsonl', lines.join('\n') + '\n');
  assert.deepStrictEqual(readLastAssistantText(p), { text: LAST, ts: TS });
});

test('AC2 - a transcript larger than one window costs one window plus one boundary byte', (t) => {
  const dir = tmpdir();
  // The ONLY qualifying record sits in the head, outside the window. A reader that took the whole
  // file would answer with it; a windowed reader cannot see it at all, so null is the proof.
  const head = asstLine(textBlocks('Head text that lives outside the window and must stay invisible.')) + '\n'
    + userLine(1) + '\n';
  const p = windowFile(dir, 'big.jsonl', head, userLine(2), [toolLine(3), userLine(4)]);
  const size = fs.statSync(p).size;
  assert.ok(size > WINDOW, 'fixture must exceed one window');

  const spy = t.mock.method(fs, 'readSync');                   // calls through; restored at test end
  const got = readLastAssistantText(p);
  const calls = spy.mock.calls;

  assert.ok(calls.length > 0, 'the function must actually read');
  const delivered = calls.reduce((n, c) => n + c.result, 0);
  assert.ok(delivered <= WINDOW + 1, `read ${delivered} bytes; the window allows ${WINDOW + 1}`);
  const requested = calls.reduce((n, c) => n + c.arguments[3], 0);
  assert.ok(requested <= WINDOW + 1, `requested ${requested} bytes; the window allows ${WINDOW + 1}`);
  for (const c of calls) assert.ok(c.arguments[4] >= size - WINDOW - 1, 'no read may reach before the boundary byte');

  const boundary = calls.filter((c) => c.arguments[3] === 1);
  assert.strictEqual(boundary.length, 1, 'exactly one boundary byte is read');
  assert.strictEqual(boundary[0].arguments[4], size - WINDOW - 1, 'the boundary byte is the one at offset-1');

  assert.strictEqual(got, null, 'the head record was never in reach');
});

test('AC3 - a sub-window transcript whose only qualifying record is its first line returns it', () => {
  const dir = tmpdir();
  const ONLY = 'I need the staging credential before I can run the check.';
  const p = write(dir, 'small.jsonl',
    [asstLine(textBlocks(ONLY)), userLine(1), toolLine(2), userLine(3)].join('\n') + '\n');
  assert.ok(fs.statSync(p).size < WINDOW, 'fixture must be smaller than one window');
  assert.deepStrictEqual(readLastAssistantText(p), { text: ONLY, ts: TS });
});

test('AC4 - a window opening mid-line discards the severed element and answers with the later record', () => {
  const dir = tmpdir();
  const GHOST = 'Ghost text from a severed line that must never be returned.';
  const LATER = 'The rename touches two consumers. Do you want them updated in this pass?';
  const ghost = asstLine(textBlocks(GHOST));

  // Synthetic by design: a severed fragment normally fails JSON.parse and would be dropped by
  // accident. This one parses cleanly as a whole record, so only a real boundary check can drop it.
  const head = '{"type":"user","uuid":"fixture-uuid-sev","message":{"role":"user","content":"' + 'y'.repeat(64);

  const control = write(dir, 'ghost-control.jsonl', ghost + '\n');
  assert.deepStrictEqual(readLastAssistantText(control), { text: GHOST, ts: TS },
    'the fixture is only discriminating if the ghost element would otherwise win');

  const p = windowFile(dir, 'mid.jsonl', head, ghost, [userLine(1), asstLine(textBlocks(LATER)), userLine(2)]);
  const size = fs.statSync(p).size;
  assert.notStrictEqual(fs.readFileSync(p)[size - WINDOW - 1], 0x0a, 'the byte before the window must not be a newline');

  const got = readLastAssistantText(p);
  assert.strictEqual(got.text, LATER);
  assert.notStrictEqual(got.text, GHOST);

  // The same window with nothing else qualifying: the severed element is the only candidate left,
  // and it must still be refused.
  const bare = windowFile(dir, 'mid-bare.jsonl', head, ghost, [userLine(1), toolLine(2)]);
  assert.strictEqual(readLastAssistantText(bare), null, 'a severed element is never a record');
});

test('AC5 - a window opening exactly on a record boundary keeps its first element', () => {
  const dir = tmpdir();
  const ONLY = 'Both branches build. Which one should I keep?';
  const head = userLine(0) + '\n';                              // the boundary byte is this newline
  const p = windowFile(dir, 'edge.jsonl', head, asstLine(textBlocks(ONLY)), [userLine(1), toolLine(2)]);
  const size = fs.statSync(p).size;
  assert.ok(size > WINDOW, 'fixture must exceed one window');
  assert.strictEqual(fs.readFileSync(p)[size - WINDOW - 1], 0x0a, 'the byte before the window must be a newline');

  assert.deepStrictEqual(readLastAssistantText(p), { text: ONLY, ts: TS });
});

test('AC6 - every non-empty text block of the winning record is joined in array order', () => {
  const dir = tmpdir();
  const content = textBlocks('  Alpha finding.  ', '   ', 'Beta finding.', 'Gamma finding.');
  const p = write(dir, 'multi.jsonl', [userLine(1), asstLine(content)].join('\n') + '\n');
  assert.deepStrictEqual(readLastAssistantText(p),
    { text: 'Alpha finding.\n\nBeta finding.\n\nGamma finding.', ts: TS });
});

test('AC7 - tool_use blocks in the winning record contribute nothing', () => {
  const dir = tmpdir();
  const content = [
    { type: 'tool_use', id: 'fixture-tool-11', name: 'Read', input: { file: '/fixture/plan.md' } },
    { type: 'text', text: 'Read the plan.' },
    { type: 'tool_use', id: 'fixture-tool-12', name: 'Write', input: { file: '/fixture/plan.md' } },
    { type: 'text', text: 'Rewrote step 3. Approve before I apply it?' },
  ];
  const p = write(dir, 'mixed.jsonl', asstLine(content) + '\n');
  assert.deepStrictEqual(readLastAssistantText(p),
    { text: 'Read the plan.\n\nRewrote step 3. Approve before I apply it?', ts: TS });
});

test('AC8 - a missing path, an empty file, an unreadable path and a text-free transcript all return null', () => {
  const dir = tmpdir();
  const empty = write(dir, 'empty.jsonl', '');
  const toolOnly = write(dir, 'toolonly.jsonl',
    [userLine(1), toolLine(1), userLine(2), toolLine(2)].join('\n') + '\n');
  const missing = path.join(dir, 'not-here.jsonl');

  assert.doesNotThrow(() => {
    assert.strictEqual(readLastAssistantText(missing), null, 'missing path');
    assert.strictEqual(readLastAssistantText(empty), null, 'empty file');
    assert.strictEqual(readLastAssistantText(dir), null, 'a directory is a read that throws');
    assert.strictEqual(readLastAssistantText(toolOnly), null, 'no text block anywhere');
  });
});

test('AC9 - an absent, empty or unparseable timestamp yields ts null without losing the text', () => {
  const dir = tmpdir();
  const TEXT = 'The seed file is ambiguous. Which of the two orgs owns it?';
  const noTs = JSON.stringify({
    type: 'assistant', uuid: 'fixture-uuid-a2',
    message: { role: 'assistant', content: textBlocks(TEXT) },
  });

  const cases = [
    ['absent', noTs],
    ['empty', asstLine(textBlocks(TEXT), { timestamp: '' })],
    ['blank', asstLine(textBlocks(TEXT), { timestamp: '   ' })],
    ['unparseable', asstLine(textBlocks(TEXT), { timestamp: 'the day before yesterday' })],
    ['non-string', asstLine(textBlocks(TEXT), { timestamp: 1783166400000 })],
  ];
  for (const [name, line] of cases) {
    const p = write(dir, `ts-${name}.jsonl`, line + '\n');
    assert.deepStrictEqual(readLastAssistantText(p), { text: TEXT, ts: null }, name);
  }

  const good = write(dir, 'ts-valid.jsonl', asstLine(textBlocks(TEXT)) + '\n');
  assert.deepStrictEqual(readLastAssistantText(good), { text: TEXT, ts: TS }, 'valid timestamp control');
});
