# cmux-remote

View and drive your local [cmux](https://github.com/manaflow-ai/cmux) terminal and browser tabs from any
browser or phone. A live, colored mirror of your agent sessions — you can read them, type into them,
press keys, drive cmux's browser surfaces, and open or close tabs and workspaces from across the room or
across the world. Installable as an iOS Home-Screen app that launches instantly.

Self-hostable, multi-machine, **zero dependencies** (plain Node, no `npm install`). Nothing about your
machines, secrets, or tunnels is ever committed — the repo ships only placeholders.

---

## What it does

- **Live terminal mirror.** Renders cmux's real render-grid (via `terminal.replay`) in the browser with
  true colors, text attributes, cursor, and scrollback — not a plain-text screen scrape. Falls back to
  `read-screen` text when a grid replay is briefly unavailable. Updates arrive as an **SSE push
  stream**: the bridge watches each viewed tab (fast while it's changing, backed off when idle) and
  pushes a frame only when the grid's hash moves; if the stream can't establish, the client falls back
  to self-scheduling conditional polls where an unchanged tab answers `{same:1}` (~10 bytes).
- **Instant loads.** Grids are cached per tab in memory *and* localStorage — reopening a tab, or the
  whole app, paints the last-seen terminal immediately (before any network) and the live stream catches
  up. A service worker caches the app shell, and `/api/cmux/bootstrap` collapses startup into a single
  round trip, so a cold open over a tunnel is one RTT, not five.
- **Browser-surface mirror.** cmux browser tabs (WKWebView) get a tap-, type-, and scroll-able
  screenshot mirror: frames stream over SSE (downscaled + JPEG-recompressed with macOS's built-in
  `sips`), taps become real synthetic clicks, typing is local-echo with debounced sync, and link taps /
  the URL bar drive real cmux `goto` navigation.
- **Full workspace → tab tree.** Enumerates cmux's whole `Window > Workspace > Pane > Surface`
  hierarchy, exposing both the pane grouping and a flat tab list, so a workspace with several tabs
  offers **all** of them, each with its live status (`Running`, etc.).
- **Multi-pane mirror — the layout follows cmux.** A split workspace is mirrored *as a split*: every
  pane streams at once, positioned exactly as it sits on the Mac, with a focus outline on the one your
  keyboard is driving. **Dividers are draggable**, and a drag resizes the real cmux split — as does a
  new pane created from the ⊞ menu (left/right/up/down). It works the other way too: a split made or
  dragged on the Mac appears on the phone within a tick, pushed over SSE. Tap a pane to focus it and
  the desktop follows. The split view is the default whenever the **viewport** can hold it, including
  for a workspace that has only one pane — a new workspace has exactly one, and it should not be
  wearing the phone layout on a desktop. On a narrow screen
  (or with **Split view: Off**) the mirror collapses to one pane at a time — the phone behaviour —
  and the tab strip switches between them.
- **2000 rows of scrollback per pane.** `terminal.replay` is capped at **240** scrollback rows by cmux
  and takes no parameter to raise it, so a pane used to attach showing roughly one screen of history.
  The rows above that window are fetched once per pane from `read-screen --scrollback` and painted as
  plain (unstyled — cmux has no styles for them) rows on top of the live grid, joined to it by content
  rather than by counting rows, so nothing is duplicated or swallowed at the seam. A **full-screen TUI**
  is the one case with no history to show: cmux defines an alternate screen as having zero scrollback,
  and what `read-screen` reports there belongs to the primary buffer behind the TUI.
- **Workspaces can be named.** cmux labels an unnamed workspace after whatever tab is in front of it,
  so several read the same thing. **✎** on any row of the workspace list renames it (an emptied box
  clears the name and hands the label back to that derived default).
- **The chrome lives on the panes, like cmux.** Each pane header carries its own **⊞** (split
  ←↑↓→ from *this* pane, new terminal/browser tab in it, even out the splits, close it) and its own
  **×** that kills the whole pane, tabs and all. The toolbar is down to the workspace chip, 📁 Files,
  ⚙ and ⟳ — no global split or new-tab buttons, and no tab strip: in split view every pane is its
  own switcher. The strip comes back **only in the one-pane view** — a viewport too narrow to split, or
  `Split view: Off` — where it *is* the switcher and carries the `+` / `+🌐` buttons.
- **Arranging is dragging, not a menu.** Grab a pane by its title bar and drop it where you want it:
  on another pane's **edge** to sit beside it, or on its **middle** to join it as a tab. A tab chip
  drags the same way, which is how one tab gets a pane of its own. The drop zone drawn under your
  finger is the box the pane will actually fill. Each drop is one `drop-surface` call, and the
  desktop rearranges with it. (The drag listeners live on `window`, not on the header element — a
  header band is ~22px tall and a mouse leaves it long before the 8px arm threshold, so binding them
  to the element makes the drag impossible to start with a mouse while still passing a touch test.)
- **Drop a file in and the agent can read it.** Dragging an image into a terminal on the Mac hands
  the agent a *path*; from a phone there is no path, so cmux-remote uploads the file to the Mac
  (`~/Downloads/cmux-remote/<date>/`, `UPLOAD_DIR`) and types the absolute path — quoted — into the
  composer, targeting whichever pane you dropped on. Same for a **pasted** screenshot and for the
  **📎** button (photo library / Files on iOS, where there is no drag) and the **📋** button, which
  READS the clipboard on a tap — iOS has no ⌘V and its paste menu fires no paste event at a plain
  page. A clipboard image has no filename, so it is stamped `pasted-YYYYMMDD-HHMMSS.ext` instead of
  piling up as image.png, image-1.png; images that arrive only through `DataTransfer.items` (Firefox,
  some Safari builds) are picked up too, and a paste carrying no files is left alone so typing still
  works. Names are reduced to a
  basename with control characters and shell syntax stripped, files are never overwritten, and the
  size cap (`UPLOAD_MAX_BYTES`, 32 MB) is enforced twice — at the server before the tunnel and at the
  bridge. See the warning in `.env.example`: this directory is writable by anyone holding
  `SERVER_TOKEN`.
- **A pane opens at the top.** The source terminal is far taller than a mirrored pane, so landing at
  the tail shows trailing blank rows with the prompt scrolled off. A pane that has just appeared —
  new, dropped, or switched to another surface — pins to the top of the grid across the first
  repaints, and releases the moment you scroll off it (the ⇩ chip jumps to the tail).
- **Real input.** Two modes: **Compose** (batched line, autocorrect on, Send to submit) and **Live**
  (every keystroke forwarded raw). Plus a touch key-bar with a d-pad — `enter`, `escape`, arrows
  (hold-to-repeat), `tab`, `ctrl+c/d/l/r`, `backspace`, `space`, page up/down, home/end.
- **Tab + workspace lifecycle.** Open a new terminal or browser tab in a workspace, spin up a whole new
  workspace (optional `cwd` + startup `command`), close a tab, or close a whole workspace — all from
  the UI.
- **Filesystem browse.** A third tab type beside terminals and browser surfaces: walk the machine's
  directories from your phone and read files in place — markdown rendered (GFM tables included, with
  a Raw toggle), code syntax-highlighted, images inline, binaries and device files stubbed. Listings
  are paged and cached, so a `node_modules` with tens of thousands of entries scrolls instead of
  hanging, and a directory you have visited paints before the network answers. **Read-only** — there
  is no write endpoint — and scoped to `FS_ROOTS`, which defaults to just the directories cmux
  currently has open.
- **Download any file.** The ⤓ button in the viewer pulls the **whole original** onto your device —
  a zip, a video, a PDF, the untouched HEIC rather than the downscaled preview. It streams (a
  multi-gigabyte file never lands in anyone's memory) and honours byte ranges, so an interrupted
  download resumes instead of starting over.
- **Phone-first UI.** The font auto-fits the source terminal's column count to your screen width (the
  pty is never resized — your desktop layout is untouched), with A+/A− zoom on top; installable as a
  standalone iOS Home-Screen app.
- **Multi-machine.** Register several Macs; switch between them in the UI. Each Mac runs its own bridge;
  the browser only ever sees machine **labels** — every URL, secret, and tunnel token stays server-side.
- **Bring your own reachability.** LAN IP, a Cloudflare tunnel, Tailscale, ngrok — anything that can
  forward a port. None of it lives in the repo.

### What it is not

- **Not a cmux fork.** It drives cmux through its own CLI/socket. A same-user process inherits cmux's
  socket, so there's no separate cmux password.
- **Not a hosted product.** No accounts, no cloud relay. You run the two pieces yourself.

---

## How it works

Two small Node processes and two independent trust layers:

```
 browser / phone ──► server ──────────────► bridge ──────► cmux
   (labels only)     (UI + /api/cmux/*,     (per-Mac,       (drives the
                      holds the registry,    :8799)          real tabs)
                      secrets stay here)
        └── SERVER_TOKEN ──┘   └── BRIDGE_SECRET ══ CMUX_MACHINE_SECRET ──┘
              layer 1                       layer 2
```

- **bridge** (`bridge.js`) runs on **each Mac where cmux is installed**. It shells out to the cmux CLI
  (`tree`, `list-status`, `read-screen`, `rpc terminal.replay`, `send`, `send-key`, `new-surface`,
  `new-workspace`, `close-surface`, `close-workspace`, and the `browser` subcommands) and exposes them
  under `/cmux/*` on `:8799`, including the SSE watch streams for terminal grids and browser frames.
  Requests are gated by a shared secret; surface/workspace ids are regex-validated, keys are
  allow-listed, and text is sent via argv (never a shell), so there's no command injection.
- **server** (`server.js`) hosts the web UI and proxies `/api/cmux/*` to the right bridge on `:8080`
  (including pass-through SSE relays). It owns the **machine registry** and injects each bridge's
  secret (and optional Cloudflare Access token) server-side. The client never receives a URL or secret.
  Static assets are served with ETags and a short max-age so revalidation is cheap through a tunnel.

**Why address by *surface*, not workspace (the v2 design):** a cmux workspace ref only ever resolves to
its *focused* surface, which hid sibling tabs and made keys like the up-arrow land on the wrong terminal.
Every read and write here is addressed by a specific surface — by its stable UUID for grid replay (a
`surface:N` ref doesn't resolve from a detached background process), which is what makes multi-tab
mirroring and arrow keys behave correctly.

**How the split layout is mirrored (the v3 design):** cmux exposes no split *tree* over its socket — no
directions, no divider list — so the mirror doesn't try to model one. `rpc pane.list` gives each pane's
desktop pixel frame; `panelayout.js` turns those into fractions of the panes' **bounding box** and
derives the dividers geometrically (two panes whose facing edges touch and whose spans overlap share
one). Absolutely-positioned percentage boxes then reproduce *any* split tree, nesting included. Three
cmux behaviours are load-bearing here, each verified against 0.64.20 rather than assumed:

- `pane.list`'s `container_frame` is the whole window content box — it includes the sidebar, so the
  leftmost pane starts at x≈240 and normalising against it squashes the mirror. The pane bbox is the
  correct reference.
- The rpc methods take **UUIDs as `<thing>_id`**. A `workspace` *ref* parameter is accepted and then
  silently ignored, answering for whatever workspace is currently selected.
- `pane.resize` takes a direction plus an amount in **desktop pixels**, and only ever pushes a border
  *outward*: asking a pane to move a border it doesn't touch fails with `invalid_state`. So dragging a
  divider one way resizes the pane before it, and the other way resizes the pane after it — which is
  why `/api/cmux/resize-pane` wants both. It then closes the loop against `pane.list` rather than
  trusting the estimate.
- A workspace cmux has **never displayed** reports every frame as 0×0. That layout is flagged
  `estimated` and mirrored as equal tiles with no drag handles, instead of a blank screen.

**How dragging a pane somewhere else works:** cmux has no `move-pane` — panes are not movable objects,
only surfaces are — so rearranging is expressed entirely through the dragged surface:

| drop | cmux calls |
|---|---|
| middle of a pane | `move-surface --surface S --pane TARGET` |
| edge of a pane | `move-surface` into the target, then `drag-surface-to-split --surface S <edge>` |

Moving the last surface out of a pane **collapses that pane**, which is exactly what dragging a
single-tab pane elsewhere should look like. `split-off` is deliberately *not* used for this: it
refuses with `invalid_state: splitting off would leave the source pane empty`, and in a normal
one-tab-per-pane workspace that is every pane — which is why the old "move this tab out" buttons in
the ⊞ menu could only ever error, and why they are gone.

---

## Requirements

- **Node 18+** (uses global `fetch`; no dependencies to install).
- **cmux** installed on each machine you want to mirror. The bridge defaults to the macOS app's CLI at
  `/Applications/cmux.app/Contents/Resources/bin/cmux` — override with `CMUX_BIN` if yours lives
  elsewhere.
- **macOS** for the browser-surface mirror (frames are recompressed with the built-in `/usr/bin/sips`;
  terminal mirroring itself has no macOS-specific dependency).

---

## Quickstart — one Mac

The bridge and server can run side by side on the same machine.

```bash
S=$(openssl rand -hex 16)     # the bridge's password
T=$(openssl rand -hex 16)     # the UI login token

# terminal 1 — the bridge (drives cmux, listens on :8799):
BRIDGE_SECRET=$S node bridge.js

# terminal 2 — the server (UI + proxy on :8080):
SERVER_TOKEN=$T \
CMUX_MACHINE_URL=http://localhost:8799 \
CMUX_MACHINE_SECRET=$S \
node server.js
```

Open <http://localhost:8080>, enter `T`, and pick a tab. `S` appears twice on purpose: once to set the
bridge's password, once to tell the server what that password is (trust layer 2).

Prefer a file to inline env vars? `cp .env.example .env`, fill it in, then just `node bridge.js` /
`node server.js`. `.env` is gitignored, so none of your values are ever committed.

## From your phone

Point any tunnel at the **server** port (`:8080`) and open the resulting URL on your phone:

```bash
cloudflared tunnel --url http://localhost:8080   # free, no account → an https URL that works on cellular
```

Or use the Mac's LAN IP (if your Wi-Fi allows device-to-device), or Tailscale. Because a token gates the
UI, the tunnel is safe to hand out — but keep `SERVER_TOKEN` set whenever the server is reachable beyond a
trusted LAN.

**iOS Home-Screen app:** open the URL in Safari → Share → **Add to Home Screen**. It installs as a
standalone full-screen app with its own icon; the service worker caches the shell and the last-seen
grids persist locally, so relaunches paint in tens of milliseconds even before the network answers.
(Standalone mode has its own storage — it asks for the access token once on first open.)

---

## Configuration

A `.env` in the working directory is auto-loaded by both processes.

### The four settings you actually need

| Variable | Set on | What it's for | How to set |
|---|---|---|---|
| `BRIDGE_SECRET` | bridge (each Mac) | password the server presents to reach this bridge | `openssl rand -hex 16` |
| `CMUX_MACHINE_SECRET` | server | **must equal that bridge's `BRIDGE_SECRET`** | copy the same value |
| `CMUX_MACHINE_URL` | server | how the server reaches the bridge | `http://<mac-ip>:8799`, or a tunnel URL |
| `SERVER_TOKEN` | server | password to open the web UI | `openssl rand -hex 16` |

If `SERVER_TOKEN` or `BRIDGE_SECRET` is left empty, that layer is **open** — only acceptable on a fully
trusted LAN. Both processes print a warning at startup when a secret is missing.

### Other environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | server UI/proxy port |
| `HOST` / `SERVER_HOST` | `127.0.0.1` | server bind address |
| `BRIDGE_PORT` | `8799` | bridge port |
| `BRIDGE_HOST` | `127.0.0.1` | bridge bind address |
| `CMUX_BIN` | macOS app path | path to the cmux CLI |
| `CMUX_MACHINE_LABEL` | `My Mac` | display name for the single default machine |
| `CMUX_MACHINE_ACCESS_ID` / `CMUX_MACHINE_ACCESS_SECRET` | — | optional Cloudflare Access service token for a bridge behind a gated named tunnel |
| `FS_ROOTS` | `workspace-cwds` | directories the Files tab may read: colon-separated absolute paths and/or the literal `workspace-cwds`. `FS_ROOTS=/` exposes the whole disk — see Security notes |
| `FS_READ_MAX` | `1048576` | max bytes read from one file; larger files are shown truncated |
| `FS_PAGE_MAX` | `500` | ceiling on the per-page entry count a client may request |
| `RADAR_ENABLED` | unset (**off**) | set to `1` to mount the radar collector and its `/api/radar/*` routes — see [Radar](#radar-p5) |
| `RADAR_DIR` | `~/.radar` | radar's own directory: config, snapshot, aliases, decisions |

### Multiple machines

Register more Macs either inline as JSON or via a gitignored file. Later sources override earlier ones by
`id`.

```bash
# inline: extends/overrides the single default machine above
CMUX_MACHINES='[{"id":"laptop","label":"Laptop","baseUrl":"https://laptop.example.com","secret":"..."}]'

# or point at a gitignored JSON file
CMUX_CONFIG=./config.json
```

```jsonc
// config.json — gitignored; real URLs/secrets live here, never committed
{
  "machines": [
    { "id": "studio", "label": "Studio Mac", "baseUrl": "https://...", "secret": "..." },
    { "id": "laptop", "label": "Laptop",     "baseUrl": "https://...", "secret": "...",
      "accessId": "cf-access-client-id", "accessSecret": "cf-access-client-secret" }
  ]
}
```

Adding a machine is just another row. The repo ships only `config.example.json` with placeholders.

---

## Running as a background service

The live instance does **not** run from the working tree. A deploy copies the tree to a release
directory keyed by commit sha —

```
~/Library/Application Support/cmux-remote/releases/<sha>     # + its own .env
~/Library/Application Support/cmux-remote/CURRENT_RELEASE     # pointer to the live one
```

— and two per-user launchd agents (`<your-prefix>.cmux-remote.bridge` / `.server`) run `bridge.js`
and `server.js` with `WorkingDirectory` set to that release. Logs go to
`~/Library/Logs/cmux-remote/`.

`scripts/cmux-remote-ctl.sh` is the only thing you should point at that deploy:

```bash
./scripts/cmux-remote-ctl.sh status            # release in play, pids, last exit, port listeners
./scripts/cmux-remote-ctl.sh restart           # kickstart -k both agents, same release and .env
./scripts/cmux-remote-ctl.sh stop              # bootout (KeepAlive relaunches anything merely killed)
./scripts/cmux-remote-ctl.sh start             # bootstrap both plists again
./scripts/cmux-remote-ctl.sh logs [--follow]   # tail both stderr logs
```

It resolves the agent label prefix from launchd, so no machine-specific identifier is committed
here; override with `CMUX_REMOTE_LABEL_PREFIX`. It talks to launchd only — it never launches a
process out of the working tree (a repo-cwd job has no `.env` and would take `8080`/`8799` from the
release it displaced) and never kills by port (that is what used to take the live server down).
`status` prints a `!!` line if an agent is running out of the working tree.

To run the tree directly for development, start it in the foreground instead — `npm run server` and
`npm run bridge`, with your own `.env` — and stop the deployed agents first so the ports are free.

---

## HTTP API

Handy for debugging or scripting. The **server** exposes `/api/cmux/*` (token-gated via `Authorization:
Bearer <SERVER_TOKEN>`, `x-app-token`, or `?token=` — the latter for `EventSource`, which can't set
headers); it relays to the **bridge**'s `/cmux/*` (secret-gated via `x-bridge-secret`). JSON responses
are marked no-store; the `*stream*` endpoints are long-lived SSE.

| Method & path | Purpose |
|---|---|
| `GET /api/cmux/machines` | list registered machines (id + label only) |
| `GET /api/cmux/bootstrap?machine=` | machines + the (default) machine's tree in one round trip — what the UI boots from |
| `GET /api/cmux/tree?machine=` | full workspace → tab tree with per-tab status |
| `GET /api/cmux/grid?machine=&surface=&h=` | colored render-grid for one tab (styles + spans + cursor + `h` hash); pass the last `h` back — unchanged grid returns `{same:1}` |
| `GET /api/cmux/grid-stream?machine=&surface=&h=` | SSE push of grid frames — one frame per hash change; `h` suppresses the initial frame if still current |
| `GET /api/cmux/panes-stream?machine=&surfaces=a,b,c&h=h1,h2,h3` | SSE push for **several** panes over one connection — frames are `{surface, grid, h}`; the bridge walks the surfaces one at a time (concurrent `terminal.replay` calls starve each other) and sends only what changed. Max 6 surfaces |
| `GET /api/cmux/layout?machine=&workspace=&h=` | pane geometry for a workspace: each pane as fractions of the pane bounding box (`x,y,w,h`) plus the derived dividers (`handles`), the desktop box size, and which pane is focused. `h` dedupes like `/grid` |
| `GET /api/cmux/layout-stream?machine=&workspace=&h=` | SSE push of layout frames — this is how a split created or dragged **on the Mac** reaches the mirror |
| `POST /api/cmux/new-pane` | `{machine, workspace, direction, type?, pane?}` — split (`left\|right\|up\|down`). cmux splits the **focused** pane and has no `--relative-to`, so `pane` is focused first |
| `POST /api/cmux/upload?machine=` | raw body, filename in `x-file-name` (percent-encoded) — writes the file under `UPLOAD_DIR/<date>/` and answers `{path,name,bytes}`. The only non-JSON POST in the API |
| `POST /api/cmux/close-pane` | `{machine, workspace, pane}` — kill a pane and every tab in it. cmux has no close-pane either: a pane exists only while it holds surfaces, so this closes them all (list read from the live tree, not from the client) |
| `POST /api/cmux/drop-surface` | `{machine, workspace, surface, pane, edge}` — the drag-to-arrange move. `edge: 'center'` drops the tab **into** the target pane; `left\|right\|up\|down` drops it as a new pane on that side. Emptying the source pane collapses it |
| `POST /api/cmux/split-off` | `{machine, surface, direction, workspace?}` — move an existing tab out into its own pane. **Fails on a single-tab pane** (`invalid_state`); the UI uses `drop-surface` instead |
| `POST /api/cmux/focus-pane` | `{machine, pane, workspace?}` — focus a pane on the desktop |
| `POST /api/cmux/focus-surface` | `{machine, surface}` — select a tab inside its pane |
| `POST /api/cmux/resize-pane` | `{machine, workspace, paneA, paneB, axis, target}` — drag a divider: `paneA`/`paneB` are the panes either side of it and `target` is where it should land (0..1 of the layout box) |
| `POST /api/cmux/equalize` | `{machine, workspace}` — even out every split |
| `GET /api/cmux/screen?machine=&surface=&lines=` | plain-text snapshot / scrollback paging |
| `GET /api/cmux/history?machine=&surface=&rows=` | the scrollback **above** the render-grid, as plain rows — cmux caps `terminal.replay` at 240 scrollback rows and takes no parameter to raise it, so this is what makes a pane remember `rows` (default 2000) instead of one screen. Answers `{rows, aligned, styledRows, bufferRows}`; `complete:true` when the replay window already reaches the top of the buffer (no read is paid for), `altScreen:true` for a full-screen TUI, where cmux defines the scrollback as empty and the history behind it belongs to another screen. Fetched once per pane, never on the streaming frames |
| `GET /api/cmux/stream?machine=&surface=` | SSE of base64 plain-text screen frames, emitted on change |
| `POST /api/cmux/send` | `{machine, surface, text, submit}` — type text, optionally press enter |
| `POST /api/cmux/key` | `{machine, surface, key}` — press one allow-listed key |
| `POST /api/cmux/new-surface` | `{machine, workspace, pane?}` — add a terminal tab (to a specific pane, if given) |
| `POST /api/cmux/new-workspace` | `{machine, cwd?, command?}` — create a workspace |
| `POST /api/cmux/close-tab` | `{machine, surface}` — close a tab |
| `POST /api/cmux/rename-workspace` | `{machine, workspace, title}` — give a workspace a name of its own. Without one cmux labels it after whatever tab is in front of it, so several can read the same thing. An **empty** title clears the custom name and hands the label back to that derived default |
| `POST /api/cmux/close-workspace` | `{machine, workspace}` — close a workspace and all its tabs |
| `POST /api/cmux/browser/open` | `{machine, workspace, url?}` — open a browser tab |
| `GET /api/cmux/browser/info?machine=&surface=` | current url/title/viewport of a browser tab |
| `GET /api/cmux/browser/stream?machine=&surface=` | SSE of base64 JPEG/PNG screenshot frames, emitted on change (adaptive cadence) |
| `POST /api/cmux/browser/tap` | `{machine, surface, fx, fy}` — click at a viewport fraction; anchor taps become real `goto` navigations |
| `POST /api/cmux/browser/type` | `{machine, surface, text}` — replace the focused field's value (React-safe) |
| `POST /api/cmux/browser/key` | `{machine, surface, key}` — press one allow-listed key on the page |
| `POST /api/cmux/browser/scroll` | `{machine, surface, dy, dx?}` — scroll the page |
| `POST /api/cmux/browser/nav` | `{machine, surface, action, url?}` — goto / back / forward / reload |
| `POST /api/cmux/browser/zoom` | `{machine, surface, dir}` — page zoom in / out / reset |
| `GET /api/cmux/fs/roots?machine=` | browsable roots — cmux's open workspace directories and/or the paths in `FS_ROOTS` |
| `GET /api/cmux/fs/list?machine=&path=&offset=&limit=&h=` | one page of a directory (`entries`, `total`, `parent`, `h`); pass the last `h` back and an unchanged listing returns `{same:1}` |
| `GET /api/cmux/fs/read?machine=&path=` | one file — `text` (with a `lang` hint and a `truncated` flag), `image` (data URI), `binary`, or `special` |
| `GET /api/cmux/fs/download-ticket?machine=&path=` | mint a short-lived `{ticket, ttl}` for one file (requires `SERVER_TOKEN`) |
| `GET /api/cmux/fs/download?ticket=` | the file's original bytes as an attachment — streamed, `Range`-capable, no size cap. The **only** `/api` route not gated by `SERVER_TOKEN`: the ticket is its credential |

---

## Radar (p5)

Radar is a **collector** that reads ground truth off the local disks — repos, branches, worktrees,
merge state — and publishes a snapshot to `~/.radar/state.json`. It is **read-only outside its own
directory**: it never writes to git, Jira, a database, or a deploy, and it removes nothing. Cleanup
output is command strings for you to run yourself.

It works standalone via the CLI with no server at all:

```bash
npm run radar -- status          # render the current snapshot (scans if stale)
npm run radar -- scan            # force a scan and publish state.json
npm run radar -- help            # tag / decide / decided / flag
```

### The Radar tab

With `RADAR_ENABLED=1` the web UI grows a **◎** control next to **📁** in the tab strip. It is the
same board the CLI prints, in the reading order that is also the priority order: **one hero** (the
single most urgent thing) → **a queue of at most four rows** with a `+N more` expander → folded
sections for `moving`, `parked` and `worktrees to clean`. Folds are remembered per browser.

Two colours carry meaning and nothing else does. **Green is action or live** — the Jump button,
`● live now`, the sweep. **Red is urgent** — the NOW label, the hero frame, a cache deadline, a
ladder violation. Everything else, *including finished ladder stages*, is neutral and reads by
shape: filled = done, outlined = current, hatched = **unknown**. Unknown never looks like progress.

The tab fetches only its own server's `/api/radar/state`, once a minute. On a machine configured as
`role: "viewer"` that route is proxied to the leader **by the viewer's server** using
`leaderBaseUrl` + `leaderTokenRef` — so the browser stays same-origin and never holds a leader
credential. If a fetch fails the last snapshot keeps rendering behind a `state stale — fetch failed`
badge and the next tick retries; a `401` raises a re-auth prompt.

Every write (`tag`, `decide`, `close`, `flag`) is optimistic: the row disappears immediately, and if
the server refuses, the row comes back with the server's message as an inline chip beside it.
`runbook` and `context` popovers are read-only — radar merges nothing, deploys nothing, and removes
no worktree; cleanup is a command string with a copy button.

The whole tab is one self-contained file (`public/radar.js`) that ships its own styles and DOM and
is reached through a single global. If it fails to load or throws while mounting, no chip renders
and the terminal mirror is untouched.

```bash
# browser proof (Playwright is borrowed — this repo has no dependencies)
PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p5-radar-smoke.mjs
# and the same UI against YOUR real repos, with screenshots
RADAR_DIR=/tmp/radar-real SHOT_DIR=/tmp/shots \
  PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p5-radar-real.mjs
```

### Turning it on in the server

Radar is **off by default**, and off means the module is never even loaded: with `RADAR_ENABLED`
unset, nothing under `radar/` is required, no timer is installed, no handler is registered, and
every `/api/radar/*` path 404s exactly as it did before radar existed.

```bash
RADAR_ENABLED=1 node server.js          # or set RADAR_ENABLED=1 in the release .env, then restart
```

| Method & path | Purpose |
|---|---|
| `GET /api/radar/state` | the last atomic snapshot, verbatim (`radar/state.schema.json` is the contract). `503 no_snapshot` before the first scan — an empty board and a board that was never computed must not look alike |
| `POST /api/radar/scan` | force a scan; coalesced, so concurrent callers join the one in-flight scan instead of starting a second git fan-out. Returns a receipt (`ok`, `published`, `durationMs`, `warnings`), not the snapshot |
| `POST /api/radar/tag` | `{kind:"branch", repo, branch, epic}` — pin an orphan branch to an epic (`branchOverrides`). `{kind:"spec", specFolder, epic}` — pin an orphan spec folder (appends its p-numeral to `aliases.epics[epic]`). Both take effect on the next scan |
| `POST /api/radar/decide` | `{title, context?, epic?}` — open a decision item |
| `POST /api/radar/decisions/:id/close` | close one (reopening is a new `decide` with a new id) |
| `POST /api/radar/flag` | `{epic, state:"on"\|"off"\|"n/a"}` — assert feature-flag state. Radar never detects a flag; the response says `asserted: true` |

All of them sit behind the same `SERVER_TOKEN` gate as `/api/cmux/*`, with **one extra rule**: a
radar route refuses a token in the URL. The shared gate accepts `?token=` because `EventSource`
cannot set headers, and no radar route is an `EventSource` — so a token in a radar URL (which would
land in browser history, referrers, and every access log that records query strings) is answered
`401 token_in_url` even when the token is valid. **`Authorization: Bearer <SERVER_TOKEN>` only.**
Bodies are capped at 16 KB (`413`); malformed input is `400`; a well-formed request naming something
radar does not know is `422`.

### Deploy notes

**Syntax-gate before every restart.** `node -c` parses without executing, so a typo is caught while
the old process is still serving instead of after you have killed it:

```bash
cd /path/to/cmux-remote
node -c server.js && node -c radar-server.js && npm test && ./scripts/cmux-remote-ctl.sh restart
```

**Rollback is unsetting one variable.** Remove `RADAR_ENABLED` from `.env` (or the environment) and
restart. That is the entire procedure — there is no second switch, no migration, and no state to
undo. The collector's interval is cleared on shutdown, and with the variable unset it is never
created in the first place.

Radar is an add-on to a terminal mirror people depend on, so it is wired to fail alone: the module
load, the scheduler, the boot scan, and every request handler each sit in their own `try`/`catch`,
and a collector that throws on every single call still leaves `/api/cmux/*` and the UI answering
`200` (`test/radar-server.test.js` proves exactly that against a real server child with a poisoned
collector). A failure shows up as a radar-scoped error and a line on stderr, never as a dead cmux.

---

## Security notes

- **Two secrets, two layers.** `SERVER_TOKEN` guards who can open the UI; `BRIDGE_SECRET` guards which
  server can drive a given Mac. Set both whenever anything is reachable beyond a trusted LAN.
- **Secrets never reach the browser.** The client receives machine labels only. Bridge URLs, secrets, and
  Cloudflare Access tokens are injected server-side.
- **Inputs are validated.** Surface/workspace ids are regex-checked, keys are allow-listed, and text is
  passed to cmux as argv — no shell, no injection. Request bodies are capped at 256 KB.
- **Filesystem browse is read-only and root-scoped.** There is no write endpoint — nothing can create,
  rename, or delete a file. `FS_ROOTS` defaults to `workspace-cwds`, i.e. only the directories cmux
  currently has open. Every path is resolved with `realpath` *before* it is checked against the roots,
  so `../` and symlinks cannot escape one, and non-regular files (devices, FIFOs, sockets) are never
  read — opening a FIFO would otherwise block the bridge forever. Reads are capped by `FS_READ_MAX`.
- **Downloads use a ticket, not the token.** A download is a navigation, and a navigation cannot send
  an `Authorization` header — so the client trades `SERVER_TOKEN`, over an authenticated request, for
  a random ticket bound to one machine and one path, valid for two minutes. That keeps the key to the
  whole UI out of browser history, share sheets, and any log that records query strings. A ticket can
  do exactly one thing: fetch that one file. It is deliberately reusable within its TTL, because a
  resumed byte-range is a second request for the same file. The path a ticket carries is **not**
  trusted — it goes through the same `realpath` jail as everything else, so a ticket for
  `/etc/passwd` is refused like any other out-of-root path. Note that `FS_READ_MAX` does not apply:
  a download is the whole file, by design.
- **`FS_ROOTS=/` is a deliberate, and large, decision.** It makes the entire disk readable by anyone
  holding `SERVER_TOKEN`: SSH keys, cloud credentials, browser cookie stores, `.env` files, and
  `BRIDGE_SECRET` itself. That turns a leaked UI token from "someone can watch my terminals" into
  "someone can take every credential on the machine". If you set it, use a long random
  `SERVER_TOKEN` and keep an identity gate (Cloudflare Access, Tailscale) in front of the tunnel.
  On macOS the bridge also needs Full Disk Access granted to its `node` binary before `~/Desktop`,
  `~/Documents`, and `~/Downloads` will list — until then those return a permission error rather
  than appearing empty.
- **Rendered markdown is sanitized.** `marked` passes raw HTML through by design and the viewer runs
  in the same origin that holds `SERVER_TOKEN`, so rendered output always goes through DOMPurify
  before insertion; code and raw markdown are inserted as text and never touch `innerHTML`.
- **Nothing sensitive is committed.** `.env`, `config.json`, logs, and `node_modules` are gitignored; the
  repo carries only `.env.example` and `config.example.json` with placeholder values.

---

## Project layout

```
cmux-remote/
├── bridge.js              # runs on each Mac — drives cmux, exposes /cmux/* (:8799)
├── fsbrowse.js            # filesystem browse: roots, realpath jail, paged listing, file reads
├── panelayout.js          # pane geometry: cmux pixel frames → bbox fractions + derived dividers
├── server.js              # UI host + /api/cmux/* proxy (:8080); owns the machine registry
├── radar-server.js        # /api/radar/* routes — required ONLY when RADAR_ENABLED is set
├── radar/                 # the radar collector: config, git module, derivations, CLI, schema
├── loadenv.js             # tiny zero-dep .env loader (used by both)
├── public/
│   ├── index.html         # the web UI (PWA metas + service-worker registration)
│   ├── app.js             # pane mirror (one view per cmux pane), browser mirror, input modes, caches
│   ├── sw.js              # service worker — cache-first app shell, background revalidate
│   ├── manifest.webmanifest  # standalone-app manifest
│   ├── icon-180.png       # Home-Screen icon
│   └── vendor/            # committed client libs (marked, DOMPurify, highlight.js) — no npm install
├── test/                  # node:test units (fs jail, pane layout) + Playwright smokes (phone, multi-pane)
├── scripts/               # ops + harnesses: cmux-remote-ctl.sh (launchd control), eval/browser runs
├── config.example.json    # placeholder machine registry
├── .env.example           # every env var, placeholders only
└── LICENSE                # MIT
```

---

## License

MIT — see [LICENSE](LICENSE).
