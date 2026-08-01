#!/usr/bin/env bash
set -euo pipefail
# launchd label prefix — no personal identifier in the repo. Override to namespace per user/host.
LABEL_PREFIX="${CMUX_REMOTE_LABEL_PREFIX:-com.cmux-remote}"
repo="$(cd "$(dirname "$0")" && pwd)"
logdir="$HOME/Library/Logs/cmux-remote"
mkdir -p "$logdir"

launchctl remove com.cmuxremote.app.bridge 2>/dev/null || true
launchctl remove com.cmuxremote.app.server 2>/dev/null || true
for port in 8799 8080; do
  pids=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
done

launchctl submit -l com.cmuxremote.app.bridge -- /bin/bash -lc "cd '$repo' && exec /opt/homebrew/bin/node bridge.js >>'$logdir/bridge.out.log' 2>>'$logdir/bridge.err.log'"
launchctl submit -l com.cmuxremote.app.server -- /bin/bash -lc "cd '$repo' && exec /opt/homebrew/bin/node server.js >>'$logdir/server.out.log' 2>>'$logdir/server.err.log'"

echo "cmux-remote bridge/server submitted"
launchctl list | grep "${LABEL_PREFIX#com.}" || true
