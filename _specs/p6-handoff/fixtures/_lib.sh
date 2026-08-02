#!/usr/bin/env bash
# p6 §11 — the canonical proof harness, sourced by every fixtures/<name>/run.sh.
#
# Three ordering rules here are load-bearing, and each fixes a way an earlier draft was not
# executable:
#   * the trap is installed BEFORE RADAR_DIR is created or populated, so a failure during setup
#     still cleans up;
#   * the guard runs BEFORE the copy and BEFORE the server starts, so an unset or real RADAR_DIR
#     aborts before anything can be written to it — an unmet precondition otherwise fakes a PASS;
#   * `cd "$REPO"` happens in the CALLER's shell (this file is sourced, not executed), so later
#     relative `node radar/...` paths do not depend on where the engineer was standing.
#
# Ports are ephemeral, never 8080: PORT=0 binds one and server.js logs the BOUND port, which is
# both the readiness probe and the port capture. No proof can collide with — or accidentally
# drive — the live server.

set -euo pipefail

p6_harness_start() {
  local fixture="$1" story="$2"

  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  cd "$REPO"
  # EXPORTED, not a plain shell var: run.sh node oracles read process.env.FIX, and an unexported
  # one yields "undefined/..." ENOENT rather than an honest failure.
  export FIX="$REPO/_specs/p6-handoff/fixtures/$fixture"
  [ -d "$FIX" ] || { echo "fixture missing: $FIX" >&2; return 1; }

  # macOS: mktemp answers /var/..., git reports worktrees under /private/var/... . The longest-
  # prefix worktree join then silently never fires and the proof passes against nothing. Canonicalise
  # once, here, so no fixture has to rediscover it. (Every story that creates a repo or a process
  # under $TMP hits this: s004, s005, s006, s011.)
  TMP="$(cd "$(mktemp -d)" && pwd -P)"
  trap 'if [ -f "$TMP/radar/server.pid" ]; then kill "$(cat "$TMP/radar/server.pid")" 2>/dev/null || true; fi; rm -rf "$TMP"' EXIT

  export RADAR_DIR="$TMP/radar"
  [ -n "$RADAR_DIR" ] && [ "$RADAR_DIR" != "$HOME/.radar" ] || { echo 'harness precondition failed' >&2; return 1; }
  mkdir -p "$RADAR_DIR"
  cp -R "$FIX/." "$RADAR_DIR/"
  rm -f "$RADAR_DIR/run.sh"

  export EVIDENCE="$REPO/_specs/p6-handoff/evidence/$story"
  mkdir -p "$EVIDENCE"

  export SERVER_TOKEN=test-token
  RADAR_ENABLED=1 PORT=0 node server.js >"$RADAR_DIR/server.log" 2>&1 &
  echo $! >"$RADAR_DIR/server.pid"

  local i
  for i in $(seq 1 200); do
    BASE=$(/usr/bin/sed -nE 's#.*server on (http://[^ ]+) with.*#\1#p' "$RADAR_DIR/server.log" || true)
    [ -n "${BASE:-}" ] && break
    sleep 0.1
  done
  [ -n "${BASE:-}" ] || { echo 'server never bound' >&2; cat "$RADAR_DIR/server.log" >&2; return 1; }
  export BASE

  # The fixture cannot know an ephemeral port, so point the CLI at the one actually bound.
  node -e 'const f=process.env.RADAR_DIR+"/config.json";const fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.serverBaseUrl=process.env.BASE;fs.writeFileSync(f,JSON.stringify(c,null,2))'

  curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >/dev/null \
    || { echo 'server not ready' >&2; return 1; }
}

# Restart the server in place. NOTE: no longer required for config rewrites — the handoff module
# now re-reads config at request, sweep and startup boundaries, so an edit takes effect on the next
# press. Kept because a restart is still the honest way to prove startup recovery, and because a
# fixture that wants a clean server generation should not have to invent one.
#
# The _lib trap keeps working because the pid file is updated in place.
p6_restart_server() {
  local old i
  old="$(cat "$RADAR_DIR/server.pid")"
  kill "$old" 2>/dev/null || true
  wait "$old" 2>/dev/null || true
  : >"$RADAR_DIR/server.log"
  RADAR_ENABLED=1 PORT=0 node server.js >>"$RADAR_DIR/server.log" 2>&1 &
  echo $! >"$RADAR_DIR/server.pid"
  for i in $(seq 1 200); do
    BASE=$(/usr/bin/sed -nE 's#.*server on (http://[^ ]+) with.*#\1#p' "$RADAR_DIR/server.log" | tail -1 || true)
    [ -n "${BASE:-}" ] && break
    sleep 0.1
  done
  [ -n "${BASE:-}" ] || return 1
  export BASE
  node -e 'const f=process.env.RADAR_DIR+"/config.json";const fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.serverBaseUrl=process.env.BASE;fs.writeFileSync(f,JSON.stringify(c,null,2))'
  curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >/dev/null
}

# Pids whose command carries a uuid. A node matcher with the uuid in the ENVIRONMENT, never in
# argv: a `bash -c '... <uuid> ...'` probe matches ITSELF, so an absence poll never succeeds and
# the bound always expires — the same family as pgrep -f finding its own command line.
p6_uuid_pids() {
  P6_UUID="$1" node -e '
    const { execFileSync } = require("child_process");
    const out = execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8" });
    const hits = out.split("\n").filter((l) => l.includes(process.env.P6_UUID));
    for (const l of hits) console.log(l.trim().split(/\s+/)[0]);
  '
}

# Poll until a node expression exits 0, or fail after a stated bound. Every timed acceptance bullet
# uses this rather than a bare sleep: a proof that needs longer than its bound is a FAIL.
p6_wait_for() {
  local bound_s="$1" every_s="$2"; shift 2
  local waited=0
  while ! "$@" >/dev/null 2>&1; do
    sleep "$every_s"
    waited=$(( waited + every_s ))
    if [ "$waited" -ge "$bound_s" ]; then
      echo "bound ${bound_s}s exceeded waiting for: $*" >&2
      return 1
    fi
  done
}
