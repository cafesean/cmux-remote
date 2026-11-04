'use strict';
// p41 A5 — the status square of a session (spec §3 "Where needs you comes from").
//
//   statusFor({lastMsgs, events, marker, toolRunning, surfaceId, unread = true, usage, model})
//     -> {status, preview, contextPct?}
//   contextPct(usage, model) -> 0..100 | undefined
//   contextUsage(transcriptPath, {fs}) -> Promise<{usage, model} | null>   usage of the last assistant row
//
//   lastMsgs    the newest Msgs of the thread (A2, oldest first; callouts already split out by A4)
//   events      hook events of THIS session (radar/eventlog.js: ts, event, notificationType)
//   marker      the parsed ~/.claude/needs-you/<session_id> JSON, or null
//   surfaceId   the cmux surface id of this pane; a marker for another surface is ignored
//   toolRunning true (or the running {name, target}) while a tool call has no result yet
//   unread      false once the person has opened the finished thread (finished falls back to your-turn)
//
// Precedence, first match wins:
//   needs-you  a Notification newer than the last UserPromptSubmit and the last Stop, an unanswered
//              question (the last message), a needs-you callout in the last assistant message, or a fresh
//              marker. A marker counts only when its cmux surface is this pane AND it is newer than the
//              newest user prompt (hook event or thread message). The hook clears a marker only on the next
//              prompt or Stop, so old markers pile up (48 on one Mac): they must never raise an alert.
//   working    a tool is running, or the latest of UserPromptSubmit/Stop is a UserPromptSubmit.
//   finished   a done callout or a line starting `DONE` / `status: DONE` in the last assistant message, a
//              Stop after it, and the thread unread.
//   your-turn  the latest of UserPromptSubmit/Stop is a Stop and nothing runs.
//   idle       everything else, and any session whose newest event is a SessionEnd.
const fs = require('fs');

const PREVIEW_MAX = 120;
const USAGE_TAIL = 256 * 1024;

// First match wins, so the [1m] variants come before the plain names.
const CONTEXT_WINDOWS = [
  { re: /\[1m\]/i, tokens: 1000000 },
  { re: /opus/i, tokens: 200000 },
  { re: /sonnet/i, tokens: 200000 },
];

const DONE_LINE = /^\s*(?:[Ss]tatus:\s*)?DONE\b/m;

function contextPct(usage, model) {
  if (!usage || typeof usage !== 'object') return undefined;
  const win = CONTEXT_WINDOWS.find((w) => w.re.test(String(model || '')));
  if (!win) return undefined;
  const used = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .reduce((n, k) => n + (Number(usage[k]) || 0), 0);
  return Math.max(0, Math.min(100, Math.round((used / win.tokens) * 100)));
}

// The newest assistant row with usage in the last 256 KB of the transcript. A half-written last line and
// sidechain (sub-agent) rows are skipped.
async function contextUsage(file, deps) {
  const f = ((deps && deps.fs) || fs.promises);
  let fh;
  try {
    fh = await f.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - USAGE_TAIL);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();                   // began mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch (_) { continue; }
      if (row && row.type === 'assistant' && !row.isSidechain && row.message && row.message.usage) {
        return { usage: row.message.usage, model: row.message.model || '' };
      }
    }
    return null;
  } catch (_) { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

const oneLine = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const firstLine = (text) => {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return oneLine(line, PREVIEW_MAX);
};
const toolLine = (t) => oneLine(`${t.name || ''} ${t.target || ''}`, PREVIEW_MAX);

function newest(events, names) {
  let ts = -Infinity;
  for (const e of events) if (names.includes(e.event) && e.ts > ts) ts = e.ts;
  return ts;
}

// The assistant message that ends the thread: its text and the callouts that follow it. todo and
// attachment messages do not end it; a user or tools message after it means the agent has moved on.
function tailOf(msgs) {
  let i = msgs.length - 1;
  while (i >= 0 && (msgs[i].kind === 'todo' || msgs[i].kind === 'attachment')) i--;
  if (i < 0) return { last: null, question: null, text: null, callouts: [], ts: -Infinity };
  const last = msgs[i];
  if (last.kind === 'question') return { last, question: last.question || null, text: null, callouts: [], ts: last.ts };
  const callouts = [];
  let text = null;
  for (; i >= 0 && (msgs[i].kind === 'callout' || msgs[i].kind === 'assistant'); i--) {
    if (msgs[i].kind === 'callout') callouts.unshift(msgs[i].callout);
    else { text = msgs[i].text; break; }
  }
  const isTail = last.kind === 'callout' || last.kind === 'assistant';
  return { last, question: null, text: isTail ? text : null, callouts: isTail ? callouts : [], ts: last.ts };
}

function markerAsk(marker) {
  return oneLine(marker.ask || marker.name || '', PREVIEW_MAX);
}

function markerFresh(marker, surfaceId, lastPromptTs) {
  if (!marker || !surfaceId) return false;
  const sid = marker.cmux && marker.cmux.surface_id;
  if (!sid || String(sid).toLowerCase() !== String(surfaceId).toLowerCase()) return false;
  const ts = Number(marker.epoch) * 1000;
  return Number.isFinite(ts) && ts > lastPromptTs;
}

function needsYouPreview(reasons) {
  const r = reasons.find((x) => x.text) || reasons[0];
  return r.text ? `Needs you: ${r.text}` : 'Needs you';
}

function statusFor(input) {
  const { lastMsgs = [], events = [], marker = null, toolRunning = false, surfaceId = null, unread = true } = input || {};
  const pct = contextPct(input && input.usage, input && input.model);
  const out = (status, preview) => (pct === undefined ? { status, preview } : { status, preview, contextPct: pct });

  const tail = tailOf(lastMsgs);
  const lastAssistantText = (() => {
    for (let i = lastMsgs.length - 1; i >= 0; i--) if (lastMsgs[i].kind === 'assistant') return lastMsgs[i].text;
    return '';
  })();
  const idlePreview = firstLine(lastAssistantText);

  const lastEnd = newest(events, ['SessionEnd']);
  const lastEvent = events.reduce((m, e) => (e.ts >= m ? e.ts : m), -Infinity);
  if (lastEnd > -Infinity && lastEnd >= lastEvent) return out('idle', idlePreview);

  const lastPrompt = newest(events, ['UserPromptSubmit']);
  const lastStop = newest(events, ['Stop']);
  const lastUserMsg = lastMsgs.reduce((m, x) => (x.kind === 'user' && x.ts > m ? x.ts : m), -Infinity);

  const reasons = [];
  if (tail.question) reasons.push({ text: oneLine(tail.question.text || tail.question.header, PREVIEW_MAX) });
  for (const c of tail.callouts) {
    if (c.type !== 'needs-you') continue;
    const generic = c.title.toLowerCase() === 'needs you';
    reasons.push({ text: oneLine(generic && c.body ? c.body.split('\n')[0] : c.title, PREVIEW_MAX) });
  }
  if (markerFresh(marker, surfaceId, Math.max(lastPrompt, lastUserMsg))) reasons.push({ text: markerAsk(marker) });
  const note = events.filter((e) => e.event === 'Notification' && e.ts > lastPrompt && e.ts > lastStop).pop();
  if (note) {
    const t = note.notificationType;
    reasons.push({ text: t === 'permission_prompt' ? 'permission needed' : t === 'idle_prompt' ? 'waiting for input' : '' });
  }
  if (reasons.length) return out('needs-you', needsYouPreview(reasons));

  const lastTurn = Math.max(lastPrompt, lastStop);
  if (toolRunning) {
    let running = toolRunning && typeof toolRunning === 'object' ? toolRunning : null;
    for (let i = lastMsgs.length - 1; !running && i >= 0; i--) {
      if (lastMsgs[i].kind === 'tools') running = (lastMsgs[i].items || []).filter((t) => t.status === 'running').pop() || null;
    }
    return out('working', running ? toolLine(running) : idlePreview);
  }
  if (lastPrompt > lastStop) return out('working', idlePreview);

  if (lastStop > -Infinity && lastStop === lastTurn) {
    const done = tail.callouts.some((c) => c.type === 'done') || (tail.text != null && DONE_LINE.test(tail.text));
    if (unread && done && lastStop > tail.ts) return out('finished', idlePreview);
    return out('your-turn', idlePreview);
  }
  return out('idle', idlePreview);
}

module.exports = { statusFor, contextPct, contextUsage, CONTEXT_WINDOWS, PREVIEW_MAX };
