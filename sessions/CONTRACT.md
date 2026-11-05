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
- `title`: string. The session title shown in the list and the thread header. Chosen by priority
  (sessions/titles.js): transcript custom-title, tmux session name, `<workspace title> <surface ref>`,
  the tab title only when it is not a process/wrapper/shell/prompt title (`cswap`, `zsh`, `user@host:~`).
  The id never depends on the title, the account, the Claude config dir or the wrapper. One transcript
  sessionId is one row: a tmux session also shown by a cmux surface is listed once, as the cmux surface.
- `aliases`: optional string[]. Ids of rows this one replaced (same transcript session, e.g. a tmux-only row
  and the cmux surface attached to it). The app moves pins and unread state from an alias id to this id.
- `status`: one of `needs-you` (waiting on a person), `working`, `finished`, `idle`, `your-turn` (the
  agent replied and the next move is yours).
- `preview`: string. One short line of the latest activity.
- `lastActivity`: number. When the session last changed.
- `model`: string, optional. The model name, for chat kinds.
- `contextPct`: number 0 to 100, optional. How full the model context is.
- `statusLine`: optional object, what Sean's terminal status line shows. Claude kind with a joined transcript only.
  `{account, lastReplyAt, ctxUsed, ctxLimit, ctxPct, model, title, branch, repo, writtenAt}`; every field is a
  string or number or `null`. `lastReplyAt` is ISO UTC (the app formats it local); `ctxPct` may exceed 100.
  Source: the sidecar `<configDir>/statusline/<sessionId>.json` written by `~/.claude/get-session-name.sh`
  (`~/.claude` and each cswap config dir), opened safely (no symlink, size cap, bad JSON ignored). With no
  sidecar the bridge fills what it knows (`model`, `contextPct` as `ctxPct`, `title`, `lastActivity` as
  `writtenAt`) plus `branch`/`repo` from git on the pane cwd (cached); `account` is `null` then. Example:
  `{"account":"jet","lastReplyAt":"2026-11-05T01:19:28.440Z","ctxUsed":205000,"ctxLimit":200000,"ctxPct":102,"model":"Opus 5.5","title":"x-cmux-native-3","branch":"integration/p41-native","repo":"cmux-remote","writtenAt":"2026-11-05T01:19:42Z"}`.
  Limits (`sessions/statusline.js`): sidecarMaxBytes 16 KiB, gitCacheTtlMs 10000, gitCacheMax 128, gitTimeoutMs 2000, strMax 300.
- `choice`: optional object (A14), the answer buttons for what the session is waiting on right now. Present only
  when `status` is `needs-you` or `your-turn` (never while working) and a source is found; absent otherwise.
  `{choiceId: string, source: 'menu'|'ask'|'callout', question: string, options: [{label: string, send: Send}]}`.
  `choiceId` is a stable 16-hex hash of (source, question, option labels). Sources, first match wins:
  1. `menu`: the live terminal selector (permission prompt `Do you want to proceed? ❯ 1. Yes 2. … 3. No`, the
     AskUserQuestion selector when it is on screen, any numbered menu with a `❯` highlight), parsed from the
     pane's current screen by `public/menuparse.js` `menuChoice` (the PWA's own parser). Items must be numbered
     1..n consecutively with exactly one `❯` row. Slash/@ completion menus are not offered (the operator is typing).
  2. `ask`: the transcript's pending AskUserQuestion (the last message), single-select, ONLY when no live menu
     was readable (e.g. a `reach: 'tmux'` row, or a screen read that timed out). Executed as the option's
     1-based number typed without Enter.
  3. `callout`: the last callout with `options:` in the last assistant message. `question` is its title.
     Executed as the option text sent as a normal message plus Enter.

  `options[].send` is DOCUMENTATION ONLY (what the bridge would do against the screen it read for the list:
  menu `{keys}` = arrows from that highlight + `enter`; ask `{text:'<n>', submit:false}`; callout
  `{text, submit:true}`). The app must NOT replay it: relative arrows from a stale snapshot can pick another option.

  How the app sends a pick: ONE call, `POST /api/cmux/choose {machine, surface, choiceId, index, label}`
  (device auth like `/api/cmux/key`; bridge path `POST /cmux/choose {surface, choiceId, index, label}`).
  The bridge recomputes the choice NOW (fresh screen read + transcript):
  - choice gone, `choiceId` differs, or `options[index].label !== label` -> `409 {error:'stale', choice: <fresh or null>}`,
    nothing sent. Repaint the buttons from `choice`.
  - menu: re-reads the screen, walks arrows from the CURRENT highlight, waits for a frame newer than the arrows
    (`choiceReadbackTimeoutMs`), and presses Enter only if that frame shows `label` highlighted (the PWA's
    commitMenuPick). Otherwise `409 {error:'selection_moved'}` or `409 {error:'no_confirmation'}`, no Enter sent
    (arrows may have moved the highlight; nothing was selected).
  - ask / callout: types the digit / sends the text (+Enter) through the same path as `/cmux/send`.
  - success `200 {ok:true}`; `400 bad_json|bad_surface`, `404 not_found` (no such surface), `502` key/send failure.
  Limits (`sessions/choice.js`): choiceScreenTailRows 40, choiceScreenTimeoutMs 1500, choiceScreenTtlMs 1500
  (one screen read per surface shared by list + streams; the parse is cached by screen hash), choiceCacheMax 64,
  choiceOptionsMax 9, choiceLabelMax 200, choiceReadbackTimeoutMs 4000, choiceReadbackPollMs 150.
  A17 `askForm` (checked BEFORE `menu`): the pending AskUserQuestion (trailing `question` messages of one tool_use)
  when it has more than one question or any multi-select question:
  `{choiceId, source:'askForm', question: <first question>, options: [], questions:[{header, question, multiSelect,
  options:[{label, description}]}]}`. `choiceId` = hash of ('askForm', every header/question/multiSelect/label).
  Answer ALL questions in one call: `POST /api/cmux/choose {machine, surface, choiceId, answers:[{q, picks:[i…]} |
  {q, other:'text'}]}` (bridge `POST /cmux/choose {surface, choiceId, answers}`). Every question exactly once;
  single-select = one pick; `other` only on single-select (1..askFormOtherMax chars, no control chars).
  - `choiceId` differs / no askForm now -> `409 {error:'stale', step:'choice', choice}` before any key;
    screen is not this form -> `409 {error:'stale', step:'locate'}`; bad answers -> `400 bad_answers|bad_other|other_multi_unsupported`.
  - The bridge locates the tab on screen (question text + every option label), goes back to question 1 with ←,
    then per question: arrows from the CURRENT highlight + readback, Enter (single) / space toggles verified per
    checkbox then Next row or → (multi) / arrows to "Type something." + typed text read back + Enter (Other);
    each step waits for the next tab on a fresh screen. On the review step every answer must be on screen, then
    arrows to `Submit answers` + readback + Enter. Any mismatch -> `409 {error:'selection_moved'|'no_confirmation', step}`
    (`q:<i>[:pick|:toggle:<j>|:other|:next]`, `tab:<t>`, `review[:q:<i>]`, `submit`); Submit is never pressed then.
  - `other`: trimmed, 1..askFormOtherMax chars, NO backslash (`cmux send` turns \n \r \t into Enter/Tab), no C0/C1
    controls, no U+2028/2029 -> else `400 bad_other`. The Other input is emptied first (backspace + placeholder
    readback), one probe character is typed and read back IN the Other row (a leading digit is probed with `x` +
    backspace), then the rest; the row must equal the text exactly before Enter.
  - Review: each question's own `● question` / `→ answer` pair must equal the planned answer exactly (multi: labels
    joined `, ` in option order).
  - One drive per surface: a second choose while one runs -> `409 {error:'busy'}`, no keys.
  - Success `200 {ok:true, confirmed}`: Submit was pressed; `confirmed` = a fresh screen showed the form closed.
  Limits: askFormQuestionsMax 8, askFormOtherMax 500, askFormLookbackRows 16, askFormStepTimeoutMs 4000,
  askFormRelayTimeoutMs 90000 (server relay timeout for an askForm choose).
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
- `kind`: one of `user`, `assistant`, `tools`, `callout`, `question`, `todo`, `attachment`, `peer`. An app
  ignores a kind it does not know.
- `text`: string. Markdown. Set for `user`, `assistant` and `peer`.
- `from`: string. Set for `peer` (D60): the name of the Claude session that sent the message, or
  `another session` when it is not known. A `peer` message is agent-to-agent, not typed by the human.
- `items`: Tool[]. Set for `tools`. A run of consecutive tool calls is one message.
- `callout`: set for `callout`. `{type, title, body, options}`. `type` is a string such as `needs-you`,
  `done`, `handover`, `decision`, `warning`, `info` or a custom type. `options` is the list of tap
  answers, empty when there are none. A callout written inside a code fence is example text and is not
  turned into a `callout` message.
- `question`: set for `question`. `{header, text, options, multi}`. `options` is a list of
  `{label, description}`. `multi` is true when more than one option may be chosen.
- `todos`: set for `todo`. A list of `{text, done}`. The newest `todo` message is the current list.
- `attachment`: set for `attachment`. `{mime, name, url}`. `url` is `/api/sessions/:id/attachment/:n`, where `n` is the 0-based index of this attachment among the attachments of the thread, oldest first. It is relative to the server base URL.
  D57: an image the human uploaded and whose path they typed (inside the bridge's `UPLOAD_DIR`, extension png/jpg/jpeg/gif/webp/heic) is also an `attachment`, after the message text with that path token removed; its `url` is `/api/sessions/:id/upload/:rel` (`rel` = the path relative to `UPLOAD_DIR`, one URI-encoded segment). The route serves only a regular file whose real path is inside `UPLOAD_DIR`, up to 20 MB.

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
| Upload image bytes (D57) | `GET /cmux/sessions/:id/upload/:rel` | `GET /api/sessions/:id/upload/:rel` |
| Send text and keys | `WS /cmux/sessions/:id/input` | `WS /api/sessions/:id/input` |
| Answer a choice (A14) | `POST /cmux/choose` | `POST /api/cmux/choose` |
| Rename a session (A16) | `POST /cmux/session-name` `{sessionId, name}` | `POST /api/sessions/:id/name` `{name}` |
| List sub-agents (A10) | `GET /cmux/sessions/:id/subagents` | `GET /api/sessions/:id/subagents` |
| Sub-agent thread page (A10) | `GET /cmux/sessions/:id/subagents/:agentId/thread?before=&limit=` | `GET /api/sessions/:id/subagents/:agentId/thread?before=&limit=` |
| Sub-agent live stream (A10) | `GET /cmux/sessions/:id/subagents/:agentId/thread-stream` | `GET /api/sessions/:id/subagents/:agentId/thread-stream` |

The list returns a Session list, `{machineId, sessions: Session[]}`, where `machineId` is the bridge's own
machine and every session in it has that `machine`. The thread read returns a Thread; `limit` is the page
size in messages and defaults to 80. The stream returns Stream events. The attachment route returns the
image bytes. New routes are additive; no existing bridge route changes shape.

### Rename a session (A16)

`POST /api/sessions/:id/name {name}` (device auth; `:id` is `Session.id`, optional `?machine=`) relays to the owning
bridge's `POST /cmux/session-name {sessionId, name}`. `name` is trimmed; empty clears. Replies:
`200 {ok:true, sessionId, name: string|null, title}` (`title` = the Session.title now in effect),
`400 bad_json|bad_id|bad_name` (not a string, over `nameMax`, control chars), `404 not_found|no_machine`,
`409 names_full`, `413 too_large` (server), `502`. Names live in `~/.cmux-remote/session-names.json` (0600, atomic),
keyed by transcript sessionId (else the surface id). A named Session has `userNamed: true` and its `title` is the
name: title priority is user name > transcript custom-title > tmux name > workspace+ref > non-volatile tab title.
Limits (`sessions/names.js`): nameMax 80, nameKeyMax 128, nameEntriesMax 500, nameFileMaxBytes 256 KiB;
server `lib/sessions-proxy.js`: nameBodyMax 4096, nameTimeoutMs 20000.

### Sub-agents (A10)

Claude Code sub-agents of a session (its Agent/Task calls). Additive: a client that ignores them is unaffected.

- `Session.subagents`: `{running: number, total: number}`, on Claude sessions with a transcript only. Counted
  from a readdir + lstat; only files written within `LIMITS.subagentLiveMs` are opened (at most
  `LIMITS.subagentCountOpenMax`, `LIMITS.subagentConcurrency` at once). Cached per session for
  `LIMITS.subagentCountTtlMs` (`subagentCountTtlIdleMs` when none is live); a new sub-agent file drops the cache.
- List: `{subagents: Subagent[], total}`, newest `startedAt` first, at most `LIMITS.subagentsMax` entries;
  `total` counts all. A non-Claude session answers `{subagents: [], total: 0}`.
- `Subagent`: `{agentId, description, agentType, model, toolUseId, status: 'running'|'done', startedAt,
  lastActivity, preview}` (times in ms; strings may be `''` when the sub-agent has no meta file).
  `status` is `done` when its meta says `finished`, or its last record is an assistant turn with no tool call
  pending; otherwise `running` while the file was written within `LIMITS.subagentLiveMs`, else `done`.
  (A parent tool_result is NOT used: a background agent gets one at launch.)
- `agentId` matches `^a[A-Za-z0-9][A-Za-z0-9-]{4,78}$` (plain `a`+hex, or a named teammate
  `a<name>-<16 hex>`). Anything else is 400 `bad_agent_id` (bridge and server alike); an unknown or refused sub-agent is 404.
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

## Graceful restart (p41 A18)

On SIGTERM/SIGINT the server (`server.js`) and bridge (`bridge.js`) tell every open SSE stream
(sessions list/thread, cmux layout/panes/grid/stream, browser stream, radar) a final frame, then end it:

    retry: <retryMs>
    event: restarting
    data: {"retryMs":500}

Clients must treat `restarting` as "reconnect now (after ~retryMs, reset backoff)", not as an error.
Then in-flight non-stream requests get a drain window (`RESTART_DRAIN_MS`, default 3000) and the process
exits 75 (EX_TEMPFAIL). Nonzero on purpose: the launchd plists use KeepAlive {SuccessfulExit=false}, so exit 0 would NOT be relaunched. Hint is `RESTART_RETRY_MS` (default 500). Defaults live in `lib/graceful.js` LIMITS.
`GET /healthz` (no auth) returns `{ok,ready,draining}`: 200 once listening, 503 while draining.
The server listens before any slow work; nothing blocks startup.
