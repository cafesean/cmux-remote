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
  # Nothing loaded is exactly the state `start` exists to leave — and discovering
  # the prefix from the loaded agents cannot work there. Fall back to the plist
  # FILES, which survive a bootout. Without this, `stop` prints "bring them back
  # with: ctl start" and `start` then refuses to run.
  # sed -E: BSD sed has no \| alternation in a basic regex, so the GNU spelling
  # silently matches nothing here and the fallback looks like "no plists found".
  [ -n "$found" ] || found=$(ls "$AGENTS" 2>/dev/null \
    | sed -nE 's/^(.*\.cmux-remote)\.(bridge|server)\.plist$/\1/p' \
    | sort -u)
  [ -n "$found" ] || die "no cmux-remote agents loaded or installed — set CMUX_REMOTE_LABEL_PREFIX=<prefix ending in .cmux-remote>"
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

# RESTART the running job from the spec launchd ALREADY HOLDS. Correct only when
# the plist has not changed — `ctl restart`, where the point is to bounce the
# process without touching which release is in play.
kickstart_all() {
  local label
  for label in "$@"; do
    "$LAUNCHCTL" kickstart -k "$DOMAIN/$label" >/dev/null 2>&1 \
      || die "kickstart failed for $label — check: $LAUNCHCTL print $DOMAIN/$label"
    say "restarted $label"
  done
}

# RELOAD the job so launchd re-reads the plist FILE. This is what a deploy needs
# and kickstart cannot do.
#
# launchd caches the job spec at bootstrap time. Editing WorkingDirectory on disk
# and then calling `kickstart -k` relaunches the process from the CACHED spec, so
# it comes back in the OLD release directory while the plist, the pointer and
# `ctl status` all read as the new one — status reports the plist, not the
# process. The deploy then health-probes the old release, passes, and reports a
# release that is not running. Two deploys shipped nothing that way before the
# process cwd was checked directly:
#
#   lsof -a -p <pid> -d cwd     # the only honest answer
#
# bootout can fail legitimately (job not loaded), so only bootstrap is fatal.
reload_all() {
  local label i
  for label in "$@"; do
    "$LAUNCHCTL" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    # bootout is ASYNCHRONOUS: it returns while the job is still tearing down, and
    # bootstrapping a half-unloaded label fails ("Input/output error" / "service
    # already loaded"). That failure took the bridge down and left the two agents
    # on DIFFERENT releases. Wait for the label to actually disappear.
    i=0
    while "$LAUNCHCTL" print "$DOMAIN/$label" >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -ge 50 ] && break     # ~5s, then try anyway rather than hang a deploy
      sleep 0.1
    done
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$(plist_of "$label")" >/dev/null 2>&1 \
      || die "bootstrap failed for $label — it is now DOWN, bring it back with: $LAUNCHCTL bootstrap $DOMAIN $(plist_of "$label")"
    say "reloaded $label"
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
