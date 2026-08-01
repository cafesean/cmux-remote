# Radar hook install — HUMAN GATE

Radar's `blocked` detection is fed by three Claude Code hooks. Installing them edits
`~/.claude/settings.json`, which is **global to every Claude session the operator runs on this machine**.
The war-game designates this the mission's only human gate: **an agent must not apply it.** Everything
below is written so you can paste it, and so radar is fully fixture-tested without it.

Nothing else in radar depends on this. Without the hooks, sessions simply never appear; with them,
they do. There is no half-installed state.

---

## 1. What gets installed

One script, invoked by three hook events:

| Hook event | Why radar wants it |
|---|---|
| `Notification` | carries `notification_type` — `permission_prompt` / `idle_prompt` are the ONLY things that mean "blocked" |
| `UserPromptSubmit` | clears blocked, and sets the prompt-cache clock (`cacheExpiresAt` = submit + 60 min) |
| `Stop` | clears blocked when the turn ended without you |

The script is `radar/hook-receiver.js`. It reads the hook payload on stdin, appends one normalized
NDJSON line to `~/.radar/events/<UTC-day>.ndjson`, and exits. It **always exits 0 and always prints
nothing**, so it cannot inject text into a session or surface an error banner. Measured cost: ~37 ms
per invocation (Node process start dominates).

It writes only under `~/.radar/`. It reads nothing else, calls no network, and spawns nothing.

---

## 2. The exact entries to add

**Append to the existing arrays. Never replace them.** `~/.claude/settings.json` already has
occupants in all three slots — claude-remote (`$HOME/.claude/hooks/claude-remote-*.sh`), the
supacode-managed cmux hooks, a `Glass.aiff` chime on Stop, and a caveman-mode
`UserPromptSubmit` context injector. Overwriting any of them breaks unrelated tooling.

Add this object to the end of `hooks.Notification`:

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "/absolute/path/to/node /path/to/cmux-remote/radar/hook-receiver.js",
      "timeout": 5
    }
  ]
}
```

Add this object to the end of `hooks.UserPromptSubmit`:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "/absolute/path/to/node /path/to/cmux-remote/radar/hook-receiver.js",
      "timeout": 5
    }
  ]
}
```

Add this object to the end of `hooks.Stop`:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "/absolute/path/to/node /path/to/cmux-remote/radar/hook-receiver.js",
      "timeout": 5
    }
  ]
}
```

Notes on the shape, each one deliberate:

- **Absolute `node` path.** A hook's shell is not your login shell. `node` on PATH is the kind of
  assumption that works on your machine and fails on machine-b. If the Node install moves, this
  string is the one thing to update.
- **`matcher: "*"` on Notification only.** For `Notification`, Claude Code matches on
  `notification_type`, so `*` means "every subtype" — which is what radar needs, since it decides
  which subtypes matter itself. `Stop` and `UserPromptSubmit` have no match query, so the key is
  omitted (exactly like the existing supacode entries).
- **`timeout: 5`.** Far beyond the ~37 ms this takes; it exists so a wedged filesystem cannot hold
  a session.

### Optional: `PermissionRequest`

The installed CLI (**Claude Code 2.1.220**) does expose a `PermissionRequest` hook, and
`mod-sessions.js` already treats it as a blocking signal (`notificationType: "permission_request"`).
It is **not** in the recommended install, for one reason: `PermissionRequest` is a *decision* hook
that runs inside the permission path, before the prompt is answered — so it adds latency to every
permission decision and its output is interpreted. `Notification` + `permission_prompt` already
covers the same event from outside that path.

If you want it anyway, append to `hooks.PermissionRequest` (the key does not exist yet — create it
as an array):

```json
"PermissionRequest": [
  {
    "matcher": "*",
    "hooks": [
      {
        "type": "command",
        "command": "/absolute/path/to/node /path/to/cmux-remote/radar/hook-receiver.js",
        "timeout": 5
      }
    ]
  }
]
```

---

## 3. Append procedure

```bash
# 1. Back up first — this file is global.
cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d-%H%M%S)

# 2. Edit ~/.claude/settings.json by hand and append the objects above to the THREE existing
#    arrays: hooks.Notification, hooks.UserPromptSubmit, hooks.Stop.
#    Append — do not replace, do not reorder, do not touch the existing entries.

# 3. Prove it is still valid JSON before any session reloads it.
python3 -m json.tool ~/.claude/settings.json > /dev/null && echo "settings.json OK"

# 4. Prove all three slots kept their previous occupants AND gained radar.
python3 - <<'PY'
import json
h = json.load(open('$HOME/.claude/settings.json'))['hooks']
for k in ('Notification', 'UserPromptSubmit', 'Stop'):
    cmds = [x['command'] for g in h.get(k, []) for x in g.get('hooks', [])]
    print(k, '->', len(cmds), 'commands; radar present:', any('hook-receiver.js' in c for c in cmds))
PY
```

Hooks are picked up by **new** sessions. Existing sessions keep the old config.

### Verify it is live

```bash
# A real session writes here as soon as you submit a prompt in a NEW Claude session.
ls -la ~/.radar/events/
tail -3 ~/.radar/events/$(date -u +%F).ndjson
```

Or force one without a session:

```bash
echo '{"session_id":"probe","transcript_path":"/tmp/p.jsonl","cwd":"'"$PWD"'","hook_event_name":"Notification","notification_type":"permission_prompt"}' \
  | node /path/to/cmux-remote/radar/hook-receiver.js
tail -1 ~/.radar/events/$(date -u +%F).ndjson
```

### Rollback

Delete the three appended objects (or restore the `.bak-*` file). Radar goes quiet; nothing else
changes. `~/.radar/events/` can be deleted at any time — it is a cache, and dated files older than
48 h are pruned automatically anyway.

---

## 4. Bridge config, on every machine

The hooks write locally. For the leader to see **another** machine's sessions, that machine's
`bridge.js` must be reachable and `~/.radar/config.json` on the leader must list it:

```jsonc
{
  "configVersion": 1,
  "role": "leader",
  "sessionSweepSec": 60,
  "bridges": [
    { "id": "machine-a",  "baseUrl": "http://127.0.0.1:8799",       "secretRef": "BRIDGE_SECRET",      "local": true },
    { "id": "machine-b", "baseUrl": "http://machine-b.local:8799",  "secretRef": "BRIDGE_SECRET_MINI" }
  ]
}
```

- `local: true` — read this machine's events straight off disk. The leader's own sessions then keep
  working even when its own bridge is down.
- `secretRef` names an **environment variable** holding the bridge secret. Secrets never go in the
  config file.
- **Omit `bridges` entirely and radar probes nothing over HTTP** — it reads only this machine's own
  event log. That is the safe default: no speculative connection to whatever is listening on 8799.

Each machine also needs `RADAR_MACHINE_ID` set (or it falls back to `os.hostname()`), because
session identity is `{machine, session_id}` and the machine half comes from the bridge.

---

## 5. U1 probe results (recorded 2026-07-31)

Probed on this machine so the module's assumptions are written down rather than believed.

### `cmux list-status` vocabulary

```
$ cmux list-status --workspace workspace:2
claude_code=Running icon=bolt.fill color=#4C8DFF

$ cmux list-status --workspace workspace:5
claude_code=Needs input icon=bell.fill color=#4C8DFF
```

Two values observed: `Running` (`icon=bolt.fill`) and `Needs input` (`icon=bell.fill`).

### `--surface` is IGNORED — status is not per-tab

```
$ cmux list-status --help
Flags:
  --workspace <id|ref|index>   Target workspace (default: $CMUX_WORKSPACE_ID)
  --window <id|ref|index>      Window context for workspace refs and indexes
```

`--surface` is not a documented flag, and passing it changes nothing:

```
$ for s in surface:182 surface:189 surface:173 surface:9999 bogus; do cmux list-status --surface $s; done
claude_code=Running icon=bolt.fill color=#4C8DFF     # x5 — identical, including for `bogus`
```

Every call answered for the **caller's** workspace (`$CMUX_WORKSPACE_ID`), whose real status was
`Running`. Meanwhile the same instant's per-workspace probe showed `workspace:46` and `workspace:5`
at `Needs input`.

And from a **detached** bridge process (no `$CMUX_WORKSPACE_ID` inherited — i.e. the launchd bridge,
which is how it actually runs), a real `/cmux/tree` against live cmux returns `status: ""` for every
tab:

```
{"id":"2FAABD2E-…","ref":"surface:182","title":"✳ x-meter-track-chat-3","type":"terminal","status":"","statusCovered":true}
```

So in production the per-tab status is not merely wrong, it is empty.

**Consequences, both load-bearing:**

1. `mod-sessions.js` never derives `blocked` from cmux status. Hook events are the sole oracle.
   §M2's "bridge waiting-state (if U1 confirms)" — U1 does not confirm it, it refutes it.
2. `bridge.js`'s existing `statusOfSurface()` (`list-status --surface <ref>`, `bridge.js:174`)
   therefore reports the same status for every tab. Its regex `/=(\S+)/` also truncates
   `Needs input` to `Needs`. **Both are pre-existing defects outside this story's scope and were
   deliberately left untouched** — `/cmux/tree` is what the operator's team runs, and S-004a is required to
   be purely additive. Radar carries the value through as advisory `tabStatus` only.

### `PermissionRequest` availability

Present. Extracted from the installed binary
(`/opt/homebrew/Caskroom/claude-code@latest/2.1.220/claude`):

```
hook_event_name:"PermissionRequest"   tool_name, tool_input, permission_suggestions
hook_event_name:"Notification"        message, title, notification_type
```

Base payload on every hook: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
`agent_id`, `agent_type`, `effort`.

`notification_type` values present in the binary include `permission_prompt` and `idle_prompt` (the
two radar treats as blocking) alongside ~18 others — `edit_prompt`, `followup_prompt`,
`hook_prompt`, `interrupted_prompt`, `chrome_permission_prompt`, … all of which radar treats as
inert. That long list is exactly why the blocking set is an allowlist and not a pattern match.
