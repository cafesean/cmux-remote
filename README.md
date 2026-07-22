# cmux-remote

View and drive your local [cmux](https://github.com/manaflow-ai/cmux) terminal and browser tabs from any
browser or phone. A live, colored mirror of your agent sessions — you can read them, type into them,
press keys, drive cmux's browser surfaces, and open or close tabs and workspaces from across the room or
across the world. Installable as an iOS Home-Screen app that launches instantly.

Self-hostable, multi-machine, **zero dependencies** (plain Node, no `npm install`). Nothing about your
machines, secrets, or tunnels is ever committed — the repo ships only placeholders.

By Sean Liao.

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
  hierarchy and flattens it into a flat tab list, so a workspace with several tabs exposes **all** of
  them, each with its live status (`Running`, etc.).
- **Real input.** Two modes: **Compose** (batched line, autocorrect on, Send to submit) and **Live**
  (every keystroke forwarded raw). Plus a touch key-bar with a d-pad — `enter`, `escape`, arrows
  (hold-to-repeat), `tab`, `ctrl+c/d/l/r`, `backspace`, `space`, page up/down, home/end.
- **Tab + workspace lifecycle.** Open a new terminal or browser tab in a workspace, spin up a whole new
  workspace (optional `cwd` + startup `command`), close a tab, or close a whole workspace — all from
  the UI.
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

`start-cmux-remote.sh` submits both processes under `launchctl` (macOS) and logs to
`~/Library/Logs/cmux-remote/`. It frees ports `8799`/`8080` first, so it doubles as a restart.

```bash
./start-cmux-remote.sh    # submit bridge + server via launchctl
./stop-cmux-remote.sh     # remove both, free the ports, kill a matching cloudflared
```

Put your real values in `.env` before running these — the launchd jobs `cd` into the repo and both
processes auto-load it.

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
| `GET /api/cmux/screen?machine=&surface=&lines=` | plain-text snapshot / scrollback paging |
| `GET /api/cmux/stream?machine=&surface=` | SSE of base64 plain-text screen frames, emitted on change |
| `POST /api/cmux/send` | `{machine, surface, text, submit}` — type text, optionally press enter |
| `POST /api/cmux/key` | `{machine, surface, key}` — press one allow-listed key |
| `POST /api/cmux/new-surface` | `{machine, workspace}` — add a terminal tab to a workspace |
| `POST /api/cmux/new-workspace` | `{machine, cwd?, command?}` — create a workspace |
| `POST /api/cmux/close-tab` | `{machine, surface}` — close a tab |
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

---

## Security notes

- **Two secrets, two layers.** `SERVER_TOKEN` guards who can open the UI; `BRIDGE_SECRET` guards which
  server can drive a given Mac. Set both whenever anything is reachable beyond a trusted LAN.
- **Secrets never reach the browser.** The client receives machine labels only. Bridge URLs, secrets, and
  Cloudflare Access tokens are injected server-side.
- **Inputs are validated.** Surface/workspace ids are regex-checked, keys are allow-listed, and text is
  passed to cmux as argv — no shell, no injection. Request bodies are capped at 256 KB.
- **Nothing sensitive is committed.** `.env`, `config.json`, logs, and `node_modules` are gitignored; the
  repo carries only `.env.example` and `config.example.json` with placeholder values.

---

## Project layout

```
cmux-remote/
├── bridge.js              # runs on each Mac — drives cmux, exposes /cmux/* (:8799)
├── server.js              # UI host + /api/cmux/* proxy (:8080); owns the machine registry
├── loadenv.js             # tiny zero-dep .env loader (used by both)
├── public/
│   ├── index.html         # the web UI (PWA metas + service-worker registration)
│   ├── app.js             # terminal + browser mirrors, input modes, tab/workspace controls, caches
│   ├── sw.js              # service worker — cache-first app shell, background revalidate
│   ├── manifest.webmanifest  # standalone-app manifest
│   └── icon-180.png       # Home-Screen icon
├── start-cmux-remote.sh   # launchctl submit both processes (doubles as restart)
├── stop-cmux-remote.sh    # stop both, free ports
├── config.example.json    # placeholder machine registry
├── .env.example           # every env var, placeholders only
└── LICENSE                # MIT
```

---

## License

MIT © Sean Liao — see [LICENSE](LICENSE).
