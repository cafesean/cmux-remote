# shellcheck shell=bash
# Shared launchd + release helpers for the cmux-remote ops scripts.
#
# Every path, binary and label here is overridable, so the scripts can be
# exercised against a sandbox instead of the real deploy — that is what
# test/release-deploy.test.js does, and it is the reason no ops script needs to
# be "tested in production".

SUPPORT="${CMUX_REMOTE_SUPPORT_DIR:-$HOME/Library/Application Support/cmux-remote}"
AGENTS="${CMUX_REMOTE_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOGDIR="${CMUX_REMOTE_LOG_DIR:-$HOME/Library/Logs/cmux-remote}"
RELEASES="$SUPPORT/releases"
POINTER="$SUPPORT/CURRENT_RELEASE"
PREVIOUS="$SUPPORT/PREVIOUS_RELEASE"
LAUNCHCTL="${CMUX_LAUNCHCTL:-launchctl}"
PLISTBUDDY="${CMUX_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
DOMAIN="gui/$(id -u)"

die() { printf '%s: %s\n' "${PROG:-cmux-remote}" "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

# Explicit env wins; otherwise derive the prefix from the loaded agents, so no
# machine-specific label is committed to the repo.
resolve_prefix() {
  if [ -n "${CMUX_REMOTE_LABEL_PREFIX:-}" ]; then printf '%s' "$CMUX_REMOTE_LABEL_PREFIX"; return; fi
  local found count
  found=$("$LAUNCHCTL" list \
    | awk '$3 ~ /\.cmux-remote\.(bridge|server)$/ { sub(/\.(bridge|server)$/, "", $3); print $3 }' \
    | sort -u)
  [ -n "$found" ] || die "no cmux-remote agents loaded — set CMUX_REMOTE_LABEL_PREFIX=<prefix ending in .cmux-remote>"
  count=$(printf '%s\n' "$found" | wc -l | tr -d ' ')
  [ "$count" = 1 ] || die "$(printf 'several prefixes loaded:\n%s\nset CMUX_REMOTE_LABEL_PREFIX to pick one' "$found")"
  printf '%s' "$found"
}

plist_of()   { printf '%s/%s.plist' "$AGENTS" "$1"; }
workdir_of() { "$PLISTBUDDY" -c 'Print :WorkingDirectory' "$(plist_of "$1")" 2>/dev/null || printf '(unset)'; }

# "<pid> <last-exit>" for a label, or "- -" when it is not loaded.
jobline_of() {
  "$LAUNCHCTL" list | awk -v L="$1" '$3 == L { print $1, $2; found = 1 } END { if (!found) print "-", "-" }'
}

set_workdir() {
  local label=$1 dir=$2 plist
  plist=$(plist_of "$label")
  [ -f "$plist" ] || die "no plist at $plist"
  # Set fails when the key is absent, so Add covers a plist that never had one.
  "$PLISTBUDDY" -c "Set :WorkingDirectory $dir" "$plist" 2>/dev/null \
    || "$PLISTBUDDY" -c "Add :WorkingDirectory string $dir" "$plist" \
    || die "could not set WorkingDirectory in $plist"
}

# Pointer writes go through a temp file: a half-written CURRENT_RELEASE would
# leave the deploy with no idea which release is live.
write_file_atomic() {
  local path=$1 content=$2 tmp
  tmp="$path.tmp.$$"
  printf '%s\n' "$content" >"$tmp"
  mv -f "$tmp" "$path"
}

current_release() { [ -f "$POINTER" ] && head -n 1 "$POINTER" || true; }
previous_release() { [ -f "$PREVIOUS" ] && head -n 1 "$PREVIOUS" || true; }

kickstart_all() {
  local label
  for label in "$@"; do
    "$LAUNCHCTL" kickstart -k "$DOMAIN/$label" >/dev/null 2>&1 \
      || die "kickstart failed for $label — check: $LAUNCHCTL print $DOMAIN/$label"
    say "restarted $label"
  done
}

# The probe, in order of precedence:
#   CMUX_REMOTE_HEALTH_CMD  — any shell command; exit 0 means healthy. Use this
#                             when a bare GET is not a real answer (a token-gated
#                             endpoint, a queue depth, a version match).
#   CMUX_REMOTE_HEALTH_URL  — plain GET. Empty disables the probe entirely.
health_wait() {
  local tries="${1:-${CMUX_REMOTE_HEALTH_TRIES:-20}}" i=1
  local cmd="${CMUX_REMOTE_HEALTH_CMD:-}" url="${CMUX_REMOTE_HEALTH_URL-http://127.0.0.1:8080/}"
  local what
  if [ -n "$cmd" ]; then what="$cmd"; elif [ -n "$url" ]; then what="$url"; else say "health probe disabled"; return 0; fi
  while [ "$i" -le "$tries" ]; do
    # Quiet: a retry loop that narrates every refused connection buries the
    # one line that matters.
    if [ -n "$cmd" ]; then
      if bash -c "$cmd" >/dev/null 2>&1; then say "health ok on attempt $i ($what)"; return 0; fi
    elif curl -fs -o /dev/null --max-time 3 "$url" 2>/dev/null; then
      say "health ok on attempt $i ($what)"; return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}
