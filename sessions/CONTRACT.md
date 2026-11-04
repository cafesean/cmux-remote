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
- `attachment`: set for `attachment`. `{mime, name, url}`. `url` is relative to the server base URL.

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
- `cursor`: string or null. Pass it as `before` to get the next older page. It is the id of the oldest
  message in this page. It is null when there is nothing older.

## Stream event

One line of the live stream (`thread-stream`). Sent as server-sent events, one JSON object per event.

- `type`: one of `msg`, `status`, `reset`.
- `session`: string. The Session `id` the event belongs to.
- `msg`: Msg. Set for `msg`. A new message, or a replacement for an earlier one with the same `id`.
- `status`: Session status. Set for `status`. The session changed state.
- `reset`: no extra field. The transcript changed under the pane (restart, `/clear`, `/resume`). Drop
  the cached thread for this session and read it again.

## Routes

The bridge is the process on each machine. The server is the account service the app talks to, and it
passes requests through to the right bridge. The session `id` goes in the path, URL-encoded.

| What | Bridge path | Server path |
|---|---|---|
| List sessions | `GET /cmux/sessions` | `GET /api/sessions` |
| Read a thread page | `GET /cmux/sessions/:id/thread?before=<cursor>` | `GET /api/sessions/:id/thread?before=<cursor>` |
| Live stream | `GET /cmux/sessions/:id/thread-stream` | `GET /api/sessions/:id/thread-stream` |
| Send text and keys | `POST /cmux/sessions/:id/input` | `POST /api/sessions/:id/input` |

The list returns Session[]. The thread read returns a Thread. The stream returns Stream events. The input
route is unchanged from today: text plus keys sent to the pane. New routes are additive; no existing
bridge route changes shape.

## Fixtures

- `sessions.json`: a Session[] with every kind and every status.
- `thread-claude.json`: a Thread built from real Claude Code transcript shapes (user string, assistant
  text, tool_use and tool_result pairs, an AskUserQuestion, a TodoWrite, a pasted image, a callout,
  a callout inside a code fence). The text is generic; nothing private is kept.
- `thread-codex.json`: a Thread in the same normalised shape for a Codex session. It is hand-written.
  A real Codex rollout file exists under `~/.codex/sessions`, but its content is private, so only its
  shapes were used (user and assistant messages, `function_call` and `function_call_output` pairs,
  an image view). Re-check this fixture against a real rollout when the Codex normaliser (task A2) lands.
- `stream.ndjson`: Stream events, one per line, including a replaced message and a `reset`.
