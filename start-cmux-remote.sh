#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")" && pwd)"
logdir="$HOME/Library/Logs/cmux-remote"
mkdir -p "$logdir"

launchctl remove com.seanliao.cmux-remote.bridge 2>/dev/null || true
launchctl remove com.seanliao.cmux-remote.server 2>/dev/null || true
for port in 8799 8080; do
  pids=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
done

launchctl submit -l com.seanliao.cmux-remote.bridge -- /bin/bash -lc "cd '$repo' && exec /opt/homebrew/bin/node bridge.js >>'$logdir/bridge.out.log' 2>>'$logdir/bridge.err.log'"
launchctl submit -l com.seanliao.cmux-remote.server -- /bin/bash -lc "cd '$repo' && exec /opt/homebrew/bin/node server.js >>'$logdir/server.out.log' 2>>'$logdir/server.err.log'"

echo "cmux-remote bridge/server submitted"
launchctl list | grep cmux-remote || true
