#!/usr/bin/env bash
set -euo pipefail
# launchd label prefix — no personal identifier in the repo. Override to namespace per user/host.
LABEL_PREFIX="${CMUX_REMOTE_LABEL_PREFIX:-com.cmux-remote}"
launchctl remove com.cmuxremote.app.bridge 2>/dev/null || true
launchctl remove com.cmuxremote.app.server 2>/dev/null || true
for port in 8799 8080; do
  pids=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
done
pkill -f 'cloudflared.*cmux-remote.*127.0.0.1:8080' 2>/dev/null || true
echo "cmux-remote stopped"
