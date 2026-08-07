#!/usr/bin/env bash
# cmux-remote-deploy — publish a COMMIT as a release and point the agents at it.
#
# A release is `git archive <ref>` exploded into
#
#   ~/Library/Application Support/cmux-remote/releases/<sha12>
#
# plus the `.env` carried forward from the release currently live. Only tracked
# content at a commit can ship, which is the whole point: the working tree's
# uncommitted state can no longer leak into — or silently differ from — what is
# running. CURRENT_RELEASE names the live one, PREVIOUS_RELEASE the one to fall
# back to.
#
# A failed health probe rolls back on its own. That is the difference between a
# deploy and a hand-edited plist.
#
# Usage:
#   scripts/cmux-remote-deploy.sh deploy [<ref>] [--force] [--ignore-dirty] [--env <file>]
#   scripts/cmux-remote-deploy.sh rollback
#   scripts/cmux-remote-deploy.sh list
#
# Sandbox overrides (see test/release-deploy.test.js): CMUX_REMOTE_SUPPORT_DIR,
# CMUX_REMOTE_AGENTS_DIR, CMUX_REMOTE_LABEL_PREFIX, CMUX_LAUNCHCTL,
# CMUX_REMOTE_HEALTH_URL (empty disables the probe), CMUX_REMOTE_KEEP.
set -euo pipefail

PROG=cmux-remote-deploy
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/cmux-launchd.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/cmux-launchd.sh"

KEEP="${CMUX_REMOTE_KEEP:-5}"
PREFIX="$(resolve_prefix)"
BRIDGE="$PREFIX.bridge"
SERVER="$PREFIX.server"

git_repo() { git -C "$REPO" "$@"; }

# Point both agents at a release, flip the pointer, restart, probe.
activate() {
  local sha=$1 dir="$RELEASES/$1"
  [ -d "$dir" ] || die "no such release: $sha"
  set_workdir "$BRIDGE" "$dir"
  set_workdir "$SERVER" "$dir"
  write_file_atomic "$POINTER" "$dir"
  kickstart_all "$BRIDGE" "$SERVER"
  health_wait
}

# Keep the newest $KEEP releases. The live and previous ones are exempt even if
# they age out of that window — pruning your own rollback target is not pruning.
prune() {
  local cur prev n=0 sha
  cur=$(basename "$(current_release)" 2>/dev/null || true)
  prev=$(basename "$(previous_release)" 2>/dev/null || true)
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    case "$sha" in .*) continue ;; esac
    [ -d "$RELEASES/$sha" ] || continue
    n=$((n + 1))
    [ "$n" -le "$KEEP" ] && continue
    if [ "$sha" = "$cur" ] || [ "$sha" = "$prev" ]; then continue; fi
    rm -rf "$RELEASES/$sha"
    say "pruned $sha"
  done <<EOF
$(ls -t "$RELEASES" 2>/dev/null)
EOF
}

cmd_deploy() {
  local ref=HEAD force=0 ignore_dirty=0 env_src="" sha dir tmp prev_dir dirty
  while [ $# -gt 0 ]; do
    case "$1" in
      --force)        force=1 ;;
      --ignore-dirty) ignore_dirty=1 ;;
      --env)          shift; env_src=${1:?--env needs a path} ;;
      -*)             die "unknown flag: $1" ;;
      *)              ref=$1 ;;
    esac
    shift
  done

  git_repo rev-parse --verify --quiet "$ref^{commit}" >/dev/null || die "not a commit: $ref"
  sha=$(git_repo rev-parse --short=12 "$ref^{commit}")
  dir="$RELEASES/$sha"

  # Uncommitted work is NOT in the archive. Say so rather than ship a release
  # that quietly lacks what the tree has.
  dirty=$(git_repo status --porcelain | wc -l | tr -d ' ')
  if [ "$dirty" != 0 ] && [ "$ignore_dirty" = 0 ]; then
    git_repo status --short >&2
    die "$dirty uncommitted worktree entries — none of this ships in $sha. Commit them, or pass --ignore-dirty"
  fi

  # The .env is the one thing a release cannot get from git.
  if [ -z "$env_src" ]; then
    prev_dir=$(current_release)
    [ -n "$prev_dir" ] && [ -f "$prev_dir/.env" ] || die "no .env to carry forward (CURRENT_RELEASE=${prev_dir:-unset}) — pass --env <file>"
    env_src="$prev_dir/.env"
  fi
  [ -f "$env_src" ] || die "no such env file: $env_src"
  [ -s "$env_src" ] || die "env file is empty: $env_src"

  if [ -d "$dir" ]; then
    [ "$force" = 1 ] || die "release $sha already exists — re-export with --force, or activate it with: $0 rollback"
    rm -rf "$dir"
  fi

  # Export to a temp dir and rename, so a partial export is never a release.
  mkdir -p "$RELEASES"
  tmp="$RELEASES/.tmp-$sha.$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  trap 'rm -rf "$tmp"' EXIT
  git_repo archive --format=tar "$ref^{commit}" | tar -x -C "$tmp"
  cp "$env_src" "$tmp/.env"

  # Syntax-gate the release itself, while the old one is still serving.
  local entry
  for entry in server.js bridge.js radar-server.js; do
    [ -f "$tmp/$entry" ] || continue
    (cd "$tmp" && node -c "$entry") || die "$entry fails to parse in $sha — nothing was activated"
  done

  mv "$tmp" "$dir"
  trap - EXIT
  say "exported $ref -> $sha ($(git_repo log -1 --format=%s "$ref^{commit}"))"

  prev_dir=$(current_release)
  [ -n "$prev_dir" ] && [ "$prev_dir" != "$dir" ] && write_file_atomic "$PREVIOUS" "$prev_dir"

  if activate "$sha"; then
    say "live: $sha"
    prune
  else
    say "health probe FAILED — rolling back"
    if [ -n "$prev_dir" ] && [ -d "$prev_dir" ]; then
      activate "$(basename "$prev_dir")" || die "rollback to $prev_dir also failed — the deploy is DOWN, inspect: scripts/cmux-remote-ctl.sh status"
      die "rolled back to $(basename "$prev_dir"); $sha stays on disk for inspection"
    fi
    die "no previous release to roll back to — the deploy is DOWN, inspect: scripts/cmux-remote-ctl.sh status"
  fi
}

cmd_rollback() {
  local prev_dir cur_dir
  prev_dir=$(previous_release)
  [ -n "$prev_dir" ] || die "no PREVIOUS_RELEASE recorded"
  [ -d "$prev_dir" ] || die "PREVIOUS_RELEASE points at a missing directory: $prev_dir"
  cur_dir=$(current_release)
  [ "$prev_dir" != "$cur_dir" ] || die "PREVIOUS_RELEASE is the live release: $prev_dir"
  say "rolling back to $(basename "$prev_dir")"
  # Swap, so a rollback can be undone by another rollback.
  write_file_atomic "$PREVIOUS" "$cur_dir"
  activate "$(basename "$prev_dir")" || die "rollback failed — inspect: scripts/cmux-remote-ctl.sh status"
  say "live: $(basename "$prev_dir")"
}

cmd_list() {
  local cur prev sha mark
  cur=$(basename "$(current_release)" 2>/dev/null || true)
  prev=$(basename "$(previous_release)" 2>/dev/null || true)
  printf '%-14s %-9s %s\n' RELEASE MARK SUBJECT
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    mark=""
    [ "$sha" = "$prev" ] && mark=previous
    [ "$sha" = "$cur" ] && mark=LIVE
    printf '%-14s %-9s %s\n' "$sha" "$mark" "$(git_repo log -1 --format=%s "$sha" 2>/dev/null || printf '(not in this repo)')"
  done <<EOF
$(ls -t "$RELEASES" 2>/dev/null)
EOF
}

case "${1:-}" in
  deploy)   shift; cmd_deploy "$@" ;;
  rollback) cmd_rollback ;;
  list)     cmd_list ;;
  *)        die "usage: $(basename "$0") {deploy [<ref>] [--force] [--ignore-dirty] [--env <file>]|rollback|list}" ;;
esac
