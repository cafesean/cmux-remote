'use strict';
// classify.js — the inbox classifier (spec §5.2).
//
// This file currently holds exactly one contract: §5.2.1, the transcript reader. It answers the
// only question the classifier needs off disk — what did this session LAST SAY — and it answers it
// without reading the transcript.
//
// TWO RULES SHAPE EVERY LINE BELOW.
//
// 1. BOUNDED READ. A transcript is an append-only NDJSON log that grows without limit; a long
//    session is tens of megabytes. This runs inside a sweep, over every blocked session, so the
//    cost of an answer must not scale with how long the session has been alive. We read at most
//    the trailing 256 KB, positioned, and never the whole path. The last thing said is at the end
//    by construction, so a bounded tail is not an approximation of the answer — it IS the answer,
//    with a stated blind spot: a session whose final 256 KB contains no assistant text at all
//    reads as null. That is the honest outcome and rule 2 catches it.
//
// 2. NEVER THROWS. null is the caller's `unknown`, and by principle 2 an `unknown` row is SHOWN,
//    not suppressed. A missing file, a permission error, a directory where a file was expected, a
//    half-written final line — every one of them is null, because the risky direction here is
//    hiding a question the operator needed to see. Nothing in this function is allowed to abort a
//    sweep.
//
// THE BOUNDARY BYTE. Slicing a byte range out of a line-oriented file lands mid-record almost
// every time, and the leading fragment that results is not a record — it is the back half of one.
// Discarding it unconditionally is wrong too: when the window happens to begin exactly after a
// newline, the first element is a whole record and throwing it away silently loses a message. So
// the read that decides this is explicit — one extra byte, at `offset - 1`. `\n` there means the
// window opens on a record boundary and the first element is kept; anything else means it is a
// severed tail and it is dropped. A file at or under 256 KB is read from byte 0, has no byte at
// -1, and its first line is always a whole record.
//
// A severed fragment usually fails JSON.parse and would be dropped anyway. "Usually" is not a
// contract: a record ending in a nested object can be severed at that object's opening brace, and
// what remains parses cleanly as a complete record that was never a record. That is the case this
// byte exists for.

const fs = require('fs');

// 256 KB. The tail window, in bytes — never the file.
const MAX_TAIL_BYTES = 262144;

const NEWLINE = 0x0a;

// Every non-empty text block of one record, in array order, trimmed, joined by a blank line.
// A model turn is frequently several text blocks around a tool call, and the question is as often
// in the last one as the first — concatenating all of them is what makes the classifier see the
// whole utterance rather than a fragment of it.
function textOfRecord(rec) {
  if (!rec || typeof rec !== 'object' || rec.type !== 'assistant') return null;
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    const trimmed = block.text.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// The record's own timestamp, or null. Only a non-empty string that Date.parse resolves is kept —
// the value keys a cache downstream, and a key built from `undefined` or `Invalid Date` collides
// across sessions.
function tsOfRecord(rec) {
  const raw = rec && rec.timestamp;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

function readLastAssistantText(transcriptPath) {
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const offset = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const length = size - offset;

    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    // A short read is legal on any fd; loop until the window is filled or the file stops giving.
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }

    // The one boundary byte. Read only when there is a byte before the window to read.
    let firstElementIsWhole = true;
    if (offset > 0) {
      const edge = Buffer.allocUnsafe(1);
      const n = fs.readSync(fd, edge, 0, 1, offset - 1);
      firstElementIsWhole = n === 1 && edge[0] === NEWLINE;
    }

    // Decoding the window as utf8 can mangle a multi-byte character split by the window start —
    // but that can only ever be inside the first element, and the first element is kept only when
    // the byte before it was a newline, which is by definition a character boundary too.
    const lines = buf.slice(0, got).toString('utf8').split('\n');
    const stopAt = firstElementIsWhole ? 0 : 1;

    for (let i = lines.length - 1; i >= stopAt; i--) {
      const line = lines[i];
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const text = textOfRecord(rec);
      if (text === null) continue;
      return { text, ts: tsOfRecord(rec) };
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* nothing left to salvage */ } }
  }
}

module.exports = { readLastAssistantText };
