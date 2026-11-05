# Sessions wire contract (p41)

This is the one description of the JSON that moves between the bridge, the server and the native app.
The fixtures in `test/fixtures/p41` are examples of it, and `test/p41-contract.test.js` checks them. If
a shape changes, change this file, the fixtures and the test together.

All timestamps are milliseconds since the Unix epoch. Optional fields are left out, never sent as null,
except `cursor` on a thread, which is null on purpose.

## Session

One terminal, agent or browser surface on one machine.

- `id`: string. `<machine>:<surfaceId>`, for example `mini:surface:12`. Unique across all machines.
- `machine`: string. The paired host name, for example `mini`.
- `workspace`: string. The cmux workspace (or tmux session) that holds the surface.
- `surface`: string. The surface id inside the machine, for example `surface:12`.
- `kind`: one of `claude`, `codex`, `terminal`, `browser`. How the app should show it: a chat thread
  for the first two, the terminal mirror for `terminal`, the screenshot mirror for `browser`.
- `title`: string. The session title shown in the list and the thread header.
- `status`: one of `needs-you` (waiting on a person), `working`, `finished`, `idle`, `your-turn` (the
  agent replied and the next move is yours).
- `preview`: string. One short line of the latest activity.
- `lastActivity`: number. When the session last changed.
- `model`: string, optional. The model name, for chat kinds.
- `contextPct`: number 0 to 100, optional. How full the model context is.
- `reach`: `cmux` or `tmux`. How input reaches the pane. On a cmux host, a tmux session that runs
  claude or codex but that no cmux pane shows (detached, or its cmux pane was closed) is still listed,
  under workspace `tmux`, with `reach: 'tmux'` and a minted tmux surface id (`lib/tmux-ids.js`). The
  app sends to it exactly as to any session (`{machine, surface}` on `/cmux/send` and `/cmux/key`); the
  bridge resolves that id to the tmux pane and types with tmux (paste, then Enter after a settle).
  `expect_seq` is refused there (`409 seq_unavailable`): a tmux-only pane has no grid seq.

Agent detection (`sessions/procs.js`) walks the process tree: cmux surface -> the tmux session whose
session env `CMUX_SURFACE_ID` names it (attached first, then newest) -> its active pane -> the nearest
claude/codex descendant. A claude pid's `~/.claude/sessions/<pid>.json` names its transcript; that and
the newest hook-event transcript compete, newest mtime wins (so a /clear still moves the thread).
Limits (`procs.js` / `routes.js` LIMITS): procTreeDepth 6, procTreeNodes 512, tmuxSessionsMax 64,
psTimeoutMs/tmuxTimeoutMs 3000, sessionFileMaxBytes 64 KiB, tmuxSubmitSettleMs 150,
procSnapshotTtlMs 2000 (one ps+tmux snapshot shared by list, describe and every stream tick).

## Session list

The reply to a list read from one bridge.

- `machineId`: string. The machine this bridge runs on. Equals `machine` on every session below.
- `sessions`: Session[]. Every session on that machine.

## Msg

One item in a thread. Every message has `id`, `ts` and `kind`; the kind decides which other field is set.
An `id` is stable. A message that is sent again with the same `id` replaces the earlier copy (this is how
a running tool call becomes a finished one).

- `id`: string. Stable and unique within the thread.
- `ts`: number. When the message happened.
- `kind`: one of `user`, `assistant`, `tools`, `callout`, `question`, `todo`, `attachment`.
- `text`: string. Markdown. Set for `user` and `assistant`.
- `items`: Tool[]. Set for `tools`. A run of consecutive tool calls is one message.
- `callout`: set for `callout`. `{type, title, body, options}`. `type` is a string such as `needs-you`,
  `done`, `handover`, `decision`, `warning`, `info` or a custom type. `options` is the list of tap
  answers, empty when there are none. A callout written inside a code fence is example text and is not
  turned into a `callout` message.
- `question`: set for `question`. `{header, text, options, multi}`. `options` is a list of
  `{label, description}`. `multi` is true when more than one option may be chosen.
- `todos`: set for `todo`. A list of `{text, done}`. The newest `todo` message is the current list.
- `attachment`: set for `attachment`. `{mime, name, url}`. `url` is `/api/sessions/:id/attachment/:n`, where `n` is the 0-based index of this attachment among the attachments of the thread, oldest first. It is relative to the server base URL.

## Tool

One tool call inside a `tools` message.

- `id`: string. The tool call id from the transcript.
- `name`: string. The tool, for example `Read`, `Edit`, `Bash`, `shell`.
- `target`: string. What it acted on: a file path, a command, a pattern. Shown on one line.
- `status`: one of `running`, `ok`, `error`.
- `lines`: integer, optional. Number of output lines, shown as "3 lines".
- `output`: string, optional. The result text, cut to 2000 characters. Tapping a tool line shows it.

## Thread

The reply to a thread read.

- `title`: string. The session title.
- `messages`: Msg[]. Oldest first. A page of the thread, not the whole file.
- `cursor`: string or null. An opaque string: pass it back as `before` to get the next older page, and do
  not parse it. It points at the oldest message in this page. It is null when there is nothing older. A
  `before` that the bridge cannot read, or that does not match the file, is answered with 400
  `{error:'bad_cursor'}`; the app drops it and reads the newest page again.

## Stream event

One line of the live stream (`thread-stream`). Sent as server-sent events, one JSON object per event.

- `type`: one of `msg`, `status`, `reset`, `unsupported`, `gone`.
- `session`: string. The Session `id` the event belongs to.
- `msg`: Msg. Set for `msg`. A new message, or a replacement for an earlier one with the same `id`.
- `status`: Session status. Set for `status`. The session changed state.
- `reset`: no extra field. The transcript changed under the pane (restart, `/clear`, `/resume`). Drop
  the cached thread for this session and read it again.
- `unsupported`: string, `'codex'`. Sent once, at open, for a Codex pane (transcripts are not read yet); the
  stream then carries heartbeats only. The thread read for such a pane returns
  `{title, messages: [], cursor: null, unsupported: 'codex'}`.
- `gone`: no extra field. The pane was closed. The bridge ends the stream right after this event; do not
  reconnect for this session.

## Routes

The bridge is the process on each machine. The server is the account service the app talks to, and it
passes requests through to the right bridge. The session `id` goes in the path, URL-encoded.

| What | Bridge path | Server path |
|---|---|---|
| List sessions | `GET /cmux/sessions` | `GET /api/sessions` |
| Read a thread page | `GET /cmux/sessions/:id/thread?before=<cursor>&limit=<n>` | `GET /api/sessions/:id/thread?before=<cursor>&limit=<n>` |
| Live stream | `GET /cmux/sessions/:id/thread-stream` | `GET /api/sessions/:id/thread-stream` |
| Attachment bytes | `GET /cmux/sessions/:id/attachment/:n` | `GET /api/sessions/:id/attachment/:n` |
| Send text and keys | `WS /cmux/sessions/:id/input` | `WS /api/sessions/:id/input` |
| List sub-agents (A10) | `GET /cmux/sessions/:id/subagents` | `GET /api/sessions/:id/subagents` |
| Sub-agent thread page (A10) | `GET /cmux/sessions/:id/subagents/:agentId/thread?before=&limit=` | `GET /api/sessions/:id/subagents/:agentId/thread?before=&limit=` |
| Sub-agent live stream (A10) | `GET /cmux/sessions/:id/subagents/:agentId/thread-stream` | `GET /api/sessions/:id/subagents/:agentId/thread-stream` |

The list returns a Session list, `{machineId, sessions: Session[]}`, where `machineId` is the bridge's own
machine and every session in it has that `machine`. The thread read returns a Thread; `limit` is the page
size in messages and defaults to 80. The stream returns Stream events. The attachment route returns the
image bytes. New routes are additive; no existing bridge route changes shape.

### Sub-agents (A10)

Claude Code sub-agents of a session (its Agent/Task calls). Additive: a client that ignores them is unaffected.

- `Session.subagents`: `{running: number, total: number}`, on Claude sessions with a transcript only. Cached
  per session for `LIMITS.subagentCountTtlMs`.
- List: `{subagents: Subagent[], total}`, newest `startedAt` first, at most `LIMITS.subagentsMax` entries;
  `total` counts all. A non-Claude session answers `{subagents: [], total: 0}`.
- `Subagent`: `{agentId, description, agentType, model, toolUseId, status: 'running'|'done', startedAt,
  lastActivity, preview}` (times in ms; strings may be `''` when the sub-agent has no meta file).
  `status` is `done` when its meta says `finished`, or its last record is an assistant turn with no tool call
  pending; otherwise `running` while the file was written within `LIMITS.subagentLiveMs`, else `done`.
  (A parent tool_result is NOT used: a background agent gets one at launch.)
- `agentId` matches `^a[A-Za-z0-9][A-Za-z0-9-]{4,78}$` (plain `a`+hex, or a named teammate
  `a<name>-<16 hex>`). Anything else is 400 `bad_agent_id`; an unknown or refused sub-agent is 404.
- Thread and stream: the same Thread and Stream event shapes as the session's own, with an opaque cursor.
  Stream events carry `agentId` beside `session`; types are `msg`, `reset`, `gone` (no `status`).
- `Tool.agentId` (optional): set on an `Agent`/`Task` tool when its sub-agent is known (the result's
  `toolUseResult.agentId`, else a meta file whose `toolUseId` is the tool id). Use it to open that thread.

### Input WebSocket

Input is one WebSocket per open session (spec section 2.7, which supersedes the POST in section 4.1). The
app sends one JSON frame per action:

- `{t:'text', v:string}`: text typed into the pane. The bridge keeps its existing delay before the Enter
  that follows text.
- `{t:'key', v:...}`: one named key. `v` is one of `enter`, `escape`, `tab`, `up`, `down`, `left`,
  `right`, `backspace`, `ctrl+c`, `ctrl+d`, `ctrl+l`, `ctrl+r`.
- `{t:'combo', v:string}`: a key combination not in the key list, for example `shift+tab`.

## Fixtures

- `sessions.json`: a Session list (`{machineId, sessions}`) with every kind and every status, all on one machine.
- `thread-claude.json`: a Thread built from real Claude Code transcript shapes (user string, assistant
  text, tool_use and tool_result pairs, an AskUserQuestion, a TodoWrite, a pasted image, a callout,
  a callout inside a code fence). The text is generic; nothing private is kept.
- `thread-codex.json`: a Thread in the same normalised shape for a Codex session. It is hand-written.
  A real Codex rollout file exists under `~/.codex/sessions`, but its content is private, so only its
  shapes were used (user and assistant messages, `function_call` and `function_call_output` pairs,
  an image view). Re-check this fixture against a real rollout when the Codex normaliser (task A2) lands.
- `stream.ndjson`: Stream events, one per line, including a replaced message and a `reset`.
