#!/usr/bin/env bash
# cmux-remote-ctl — control the DEPLOYED instance.
#
# The live bridge/server run from a release directory:
#
#   ~/Library/Application Support/cmux-remote/releases/<sha>
#
# each with its own .env, launched by two per-user launchd agents whose
# WorkingDirectory points at that release. The working tree is NOT the live
# instance. So this script:
#
#   * only ever talks to launchd — it never starts a process out of the repo,
#     because a repo-cwd job has no .env and would take the ports from the
#     release it just displaced;
#   * never kills by port — the previous start/stop pair freed 8080/8799 with
#     lsof, which killed the live release-based server as a side effect;
#   * discovers the label prefix from launchd, so no personal identifier is
#     committed here. Override with CMUX_REMOTE_LABEL_PREFIX.
#
# Publishing a new release is scripts/cmux-remote-deploy.sh, not this.
#
# Usage: scripts/cmux-remote-ctl.sh {status|restart|stop|start|logs} [--follow]
set -euo pipefail

PROG=cmux-remote-ctl
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/cmux-launchd.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/cmux-launchd.sh"

PREFIX="$(resolve_prefix)"
LABELS=("$PREFIX.bridge" "$PREFIX.server")

status() {
  printf 'prefix          %s\n' "$PREFIX"
  printf 'CURRENT_RELEASE %s\n' "$(current_release || printf '(unset)')"
  printf 'PREVIOUS        %s\n' "$(previous_release || printf '(unset)')"
  printf '\n%-14s %-8s %-5s %s\n' JOB PID EXIT WORKINGDIRECTORY
  local label short wd
  for label in "${LABELS[@]}"; do
    short=${label##*.}
    wd=$(workdir_of "$label")
    # shellcheck disable=SC2046 # deliberate word split: "<pid> <exit>"
    printf '%-14s %-8s %-5s %s\n' "$short" $(jobline_of "$label") "$wd"
    [ "$wd" = "$REPO" ] && printf '  !! %s is running out of the WORKING TREE, not a release — redeploy\n' "$short"
  done
  printf '\nlisteners\n'
  local port
  for port in 8080 8799; do
    printf '  %-5s %s\n' "$port" "$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true)"
  done
}

case "${1:-status}" in
  status) status ;;

  restart)
    # kickstart -k: SIGKILL the current instance and relaunch from the SAME
    # plist, so the release and .env in play are unchanged.
    kickstart_all "${LABELS[@]}"
    printf '\n'; status ;;

  stop)
    # bootout, not kill: KeepAlive relaunches anything that merely dies.
    for label in "${LABELS[@]}"; do
      "$LAUNCHCTL" bootout "$DOMAIN/$label" 2>/dev/null && printf 'booted out %s\n' "$label" \
        || printf '%s was not loaded\n' "$label"
    done
    printf 'bring them back with: %s start\n' "$0" ;;

  start)
    for label in "${LABELS[@]}"; do
      [ -f "$(plist_of "$label")" ] || die "no plist at $(plist_of "$label")"
      "$LAUNCHCTL" bootstrap "$DOMAIN" "$(plist_of "$label")" && printf 'bootstrapped %s\n' "$label"
    done
    printf '\n'; status ;;

  logs)
    if [ "${2:-}" = --follow ]; then
      tail -f "$LOGDIR"/bridge.err.log "$LOGDIR"/server.err.log
    else
      tail -n 40 "$LOGDIR"/bridge.err.log "$LOGDIR"/server.err.log
    fi ;;

  *) die "usage: $(basename "$0") {status|restart|stop|start|logs [--follow]}" ;;
esac
