#!/usr/bin/env bash
# p6 S-006 acceptance oracle — one real preview->commit over HTTP (the story's REAL DATA bullet),
# plus the size gate. Exits 0 on pass.
#
# Proven live, against this story's OWN fixture selection (its repo/branch live under this run's
# $TMP, so its fact keys are disjoint from every other story's by construction):
#   1. preview -> commit answers 201 and the ledger holds claim, intent, process, status(active),
#      result in exactly that order; exactly ONE /usr/bin/script leader carries the sessionUuid.
#   2. an immediate double-submit with the same idempotencyKey returns the stored 201 envelope
#      BYTE-FOR-BYTE, appends nothing to the ledger, and spawns nothing (still one leader).
#   3. 413 plan_too_large is decided at PREVIEW, persisting nothing — over the REAL route, with a
#      CRAFTED SELECTION: a bloat repo carries ~100 branches with ~470-byte names all mapped to
#      one epic and all minting three fact keys, so ONE tiny `epic:` selector (the request stays
#      far under the 16 KiB BODY_CAP) balloons into a plan whose intent line exceeds LINE_MAX
#      (131072). That is the §4.8 seam exactly: request size and plan size are different axes,
#      and only the plan-side gate can catch this one. The transport cap is asserted separately
#      (an oversize BODY answers 413 body_too_large — size beats shape, §7.1 step 1), and the
#      committed config raises seedMaxBytes to 200000 so the seed gate can never mask either.
#      (The exact one-byte boundary pair is a unit-level assert in the protocol suite.)
#   4. all five routes inherit authed() and the token-in-URL refusal: a query-string token is
#      401 token_in_url and a missing bearer is 401, per route (§7.1).
#   5. teardown kills the whole dispatch set and proves no process carries the sessionUuid.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s006-dispatch" "S-006"

PHASE=setup
UUID1=""

kill_uuid() {
  [ -n "${1:-}" ] || return 0
  local pids p
  pids=$(/bin/ps -axww -o pid=,command= | /usr/bin/grep -F "$1" | /usr/bin/grep -v grep | /usr/bin/awk '{print $1}') || true
  for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
}

fail() {
  echo "S-006 FAIL [$PHASE]: $*" >&2
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  kill_uuid "$UUID1"
  exit 1
}

restart_server() {
  local old
  old="$(cat "$RADAR_DIR/server.pid" 2>/dev/null || true)"
  [ -n "$old" ] && kill "$old" 2>/dev/null || true
  p6_wait_for 10 1 bash -c "! kill -0 '$old' 2>/dev/null" || fail 'previous server would not die'
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  : >"$RADAR_DIR/server.log"
  HOME="$FAKE_HOME" RADAR_ENABLED=1 PORT=0 node server.js >>"$RADAR_DIR/server.log" 2>&1 &
  echo $! >"$RADAR_DIR/server.pid"
  local i
  BASE=""
  for i in $(seq 1 200); do
    BASE=$(/usr/bin/sed -nE 's#.*server on (http://[^ ]+) with.*#\1#p' "$RADAR_DIR/server.log" | tail -1)
    [ -n "${BASE:-}" ] && break
    sleep 0.1
  done
  [ -n "${BASE:-}" ] || fail 'restarted server never bound'
  export BASE
  node -e 'const f=process.env.RADAR_DIR+"/config.json";const fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.serverBaseUrl=process.env.BASE;fs.writeFileSync(f,JSON.stringify(c,null,2))'
  p6_wait_for 30 1 curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" \
    || fail 'restarted server never published a snapshot'
}

post_json() {
  curl -s -o "$3" -w '%{http_code}' -XPOST -H "Authorization: Bearer $SERVER_TOKEN" \
    -H 'Content-Type: application/json' -d "$2" "$BASE$1"
}

leader_count() {
  /bin/ps -axww -o command= | /usr/bin/grep -F "$UUID1" | /usr/bin/grep -c '^/usr/bin/script' || true
}

# ---- setup -------------------------------------------------------------------------------------
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME"
REPO_API="$TMP/p6fix/app-api"
mkdir -p "$REPO_API"
git -C "$REPO_API" init -q -b feature/s006
echo 's006 fixture' >"$REPO_API/README.md"
git -C "$REPO_API" add README.md
git -C "$REPO_API" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'

# Stand-in: writes the transcript (commit must confirm 201) and idles in a BOUNDED loop so the
# sessionUuid stays in its argv for the dispatch-set scan — never `exec sleep` (argv erasure).
STAND_IN="$TMP/p6fix/stand-in-claude"
cat >"$STAND_IN" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (s006 stand-in)"; exit 0; fi
trap '' HUP
sid=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
slug="$(pwd | /usr/bin/sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$HOME/.claude/projects/$slug"
printf '%s\n' '{"type":"user","note":"s006 stand-in transcript"}' >"$HOME/.claude/projects/$slug/$sid.jsonl"
i=0; while [ "$i" -lt 300 ]; do sleep 1; i=$((i+1)); done
EOF
chmod +x "$STAND_IN"

# Bloat repo for the crafted plan_too_large selection: 100 branches, each name ~470 bytes (ref
# components under NAME_MAX via '/' every 150 chars), all mapped to ALPHA-966 by ISSUE_KEY_RE and
# all pointing at a tip neither develop nor main contains — so each mints unpushed +
# unmerged-develop + unmerged-main, ~1.5 KB of fact keys, 100× clears LINE_MAX with margin.
export BLOAT_KEY='ALPHA-966'
REPO_BLOAT="$TMP/p6fix/s966-repo"
mkdir -p "$REPO_BLOAT"
git -C "$REPO_BLOAT" init -q -b main
echo 'bloat fixture' >"$REPO_BLOAT/README.md"
git -C "$REPO_BLOAT" add README.md
git -C "$REPO_BLOAT" -c user.name=fixture -c user.email=fixture@invalid commit -qm base
git -C "$REPO_BLOAT" branch develop
git -C "$REPO_BLOAT" checkout -qb bloat-tip
echo tip >>"$REPO_BLOAT/README.md"
git -C "$REPO_BLOAT" add README.md
git -C "$REPO_BLOAT" -c user.name=fixture -c user.email=fixture@invalid commit -qm tip
BLOAT_X="$(git -C "$REPO_BLOAT" rev-parse HEAD)"
git -C "$REPO_BLOAT" checkout -q main
# mod-git's merge checks compare against refs/remotes/origin/<branch> — a missing origin/develop
# is UNKNOWN (null) and mints nothing — so the fixture ships a bare origin holding only the base:
# every bloat branch then reads unmerged-develop AND unmerged-main, tripling its fact keys.
BLOAT_ORIGIN="$TMP/p6fix/s966-origin.git"
git init -q --bare "$BLOAT_ORIGIN"
git -C "$REPO_BLOAT" remote add origin "$BLOAT_ORIGIN"
git -C "$REPO_BLOAT" push -q origin main develop
SEG="$(printf 'x%.0s' $(seq 1 150))"
for i in $(seq 1 150); do
  git -C "$REPO_BLOAT" branch "${BLOAT_KEY}/${SEG}/${SEG}/${SEG}/br${i}" "$BLOAT_X"
done

export REPO_API REPO_BLOAT STAND_IN
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"app-api",path:process.env.REPO_API},{id:"s966-repo",path:process.env.REPO_BLOAT}];
c.claudeBin=process.env.STAND_IN;
c.polyrepoRoot=require("path").dirname(process.env.REPO_API);
fs.writeFileSync(f,JSON.stringify(c,null,2));'

restart_server
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan-setup.json" \
  || fail 'POST /api/radar/scan failed'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-setup.json"
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-setup.json","utf8"));
const r=st.repos&&st.repos["app-api"];const b=r&&(r.branches||[]).find((x)=>x.name==="feature/s006");
if(!b||!(b.unpushed>0)){console.error("feature/s006 unpushed="+(b&&b.unpushed));process.exit(1);}' \
  || fail 'fixture repo did not scan into an unpushed>0 branch'
# Precondition for the crafted 413: the bloat epic's fact keys ALONE already exceed LINE_MAX, so
# the refusal below can only be about plan size — never about the seed or the selectors.
node -e 'const fs=require("fs");const hk=require(process.cwd()+"/radar/handoff-keys");
const st=JSON.parse(fs.readFileSync(process.env.EVIDENCE+"/state-setup.json","utf8"));
const keys=hk.keysForSelector(st,"epic:"+process.env.BLOAT_KEY);
const bytes=Buffer.byteLength(JSON.stringify(keys),"utf8");
if(bytes<=131072){console.error("bloat factKeys are only "+bytes+" bytes over "+keys.length+" keys — the crafted selection does not exceed LINE_MAX");process.exit(1);}
console.error("bloat factKeys: "+keys.length+" keys, "+bytes+" bytes");' \
  || fail 'the crafted selection does not resolve past LINE_MAX — the 413 below would be vacuous'

# ---- 0. the five routes inherit authed() and the token-in-URL refusal (§7.1) -------------------
PHASE=auth
for RP in "POST /api/radar/handoff/preview" "POST /api/radar/handoff" \
          "POST /api/radar/recovery/adopt" "POST /api/radar/recovery/discard" \
          "GET /api/radar/handoff/h-x"; do
  M="${RP%% *}"; P="${RP#* }"
  S=$(curl -s -o "$TMP/auth-q.json" -w '%{http_code}' -X "$M" \
    -H "Authorization: Bearer $SERVER_TOKEN" "$BASE$P?token=$SERVER_TOKEN")
  [ "$S" = 401 ] || fail "query-string token on $M $P answered $S, expected 401"
  /usr/bin/grep -q 'token_in_url' "$TMP/auth-q.json" || fail "$M $P did not answer token_in_url"
  S=$(curl -s -o /dev/null -w '%{http_code}' -X "$M" "$BASE$P")
  [ "$S" = 401 ] || fail "missing bearer on $M $P answered $S, expected 401"
done

# ---- 1. preview -> commit, ledger order, exactly one child -------------------------------------
PHASE=dispatch
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-api:feature/s006"],"seedOverride":"S-006 fixture seed"}' "$EVIDENCE/preview.json")
[ "$S" = 200 ] || fail "preview answered $S: $(cat "$EVIDENCE/preview.json")"
export HID="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview.json","utf8")).plan.handoffId')"
UUID1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview.json","utf8")).plan.sessionUuid')"
export UUID1
BODY="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s006-commit-1"})')"
S=$(post_json /api/radar/handoff "$BODY" "$EVIDENCE/commit.json")
[ "$S" = 201 ] || fail "commit answered $S: $(cat "$EVIDENCE/commit.json")"

export IDEM=s006-commit-1
node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const mine=recs.filter((r)=>r.idempotencyKey===process.env.IDEM||r.id===process.env.HID);
const seq=mine.map((r)=>r.t).join(",");
if(seq!=="claim,intent,process,status,result"){console.error("ledger order: "+seq);process.exit(1);}
if(mine.find((r)=>r.t==="status").to!=="active"){console.error("status is not active");process.exit(1);}' \
  || fail 'ledger does not hold claim,intent,process,status(active),result in order'

N=$(leader_count)
[ "$N" -eq 1 ] || fail "expected exactly one script leader carrying the uuid, found $N"

# ---- 2. double-submit: stored envelope byte-for-byte, no append, no spawn ----------------------
PHASE=replay
LINES_BEFORE=$(/usr/bin/wc -l <"$RADAR_DIR/handoffs/ledger.jsonl")
S=$(post_json /api/radar/handoff "$BODY" "$EVIDENCE/commit-replay.json")
[ "$S" = 201 ] || fail "replay answered $S"
cmp -s "$EVIDENCE/commit.json" "$EVIDENCE/commit-replay.json" \
  || fail 'replay body is not byte-identical to the stored 201 envelope'
LINES_AFTER=$(/usr/bin/wc -l <"$RADAR_DIR/handoffs/ledger.jsonl")
[ "$LINES_BEFORE" -eq "$LINES_AFTER" ] || fail "replay appended $((LINES_AFTER-LINES_BEFORE)) ledger line(s)"
N=$(leader_count)
[ "$N" -eq 1 ] || fail "replay spawned something: $N leaders now carry the uuid"

# ---- 3. plan_too_large is decided at PREVIEW, persisting nothing -------------------------------
# Two layers, because request size and plan size are different axes:
#   (a) over HTTP the §7 BODY_CAP (16 KiB) fires FIRST — size beats shape, so an oversize BODY is
#       413 body_too_large before any field is read. Asserted for the ordering.
#   (b) the plan-size gate is proven over the REAL route with the CRAFTED SELECTION: one tiny
#       `epic:` selector resolves to ~150 KB of fact keys server-side, so the serialised intent
#       record exceeds LINE_MAX while the request stays small and the 10 KB seedOverride stays
#       far inside seedMaxBytes — the refusal can only be plan_too_large, and nothing persists.
PHASE=plan-too-large
PREVIEWS_BEFORE=$(ls "$RADAR_DIR/handoffs/previews" 2>/dev/null | /usr/bin/wc -l)
BIGBODY="$(node -p 'JSON.stringify({selectors:["branch:app-api:feature/s006"],seedOverride:"a".repeat(70000)})')"
S=$(post_json /api/radar/handoff/preview "$BIGBODY" "$EVIDENCE/body-too-large.json")
[ "$S" = 413 ] || fail "oversize HTTP preview answered $S, expected 413"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/body-too-large.json","utf8"));
if(b.error!=="body_too_large"){console.error("error="+b.error);process.exit(1);}' \
  || fail 'the transport cap did not answer body_too_large'

CRAFTED="$(node -p 'JSON.stringify({selectors:["epic:"+process.env.BLOAT_KEY],seedOverride:"a".repeat(10000)})')"
S=$(post_json /api/radar/handoff/preview "$CRAFTED" "$EVIDENCE/plan-too-large.json")
[ "$S" = 413 ] || fail "the crafted over-LINE_MAX selection answered $S, expected 413: $(head -c 200 "$EVIDENCE/plan-too-large.json")"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/plan-too-large.json","utf8"));
if(b.error!=="plan_too_large"){console.error("error="+b.error);process.exit(1);}
if(typeof b.incidentId!=="string"||!b.incidentId){console.error("no incidentId");process.exit(2);}
if(typeof b.message!=="string"||!b.message){console.error("no message");process.exit(3);}' \
  || fail 'the crafted refusal is not plan_too_large {incidentId, message}'
PREVIEWS_AFTER=$(ls "$RADAR_DIR/handoffs/previews" 2>/dev/null | /usr/bin/wc -l)
[ "$PREVIEWS_BEFORE" -eq "$PREVIEWS_AFTER" ] || fail 'the refused plan was persisted'
# Contrast: the SAME override on a small selection previews 200 — the refusal above was plan
# size, not the override and not the selector.
CONTRAST="$(node -p 'JSON.stringify({selectors:["branch:app-api:feature/s006"],seedOverride:"a".repeat(10000)})')"
S=$(post_json /api/radar/handoff/preview "$CONTRAST" "$TMP/contrast.json")
[ "$S" = 200 ] || fail "the contrast preview answered $S, expected 200"
# The complement is already on the ledger: the normal plan above reached the sheet and committed
# 201 — it could not have failed on size at commit, because preview proved its lines fit.

# ---- teardown ----------------------------------------------------------------------------------
PHASE=teardown
kill_uuid "$UUID1"
p6_wait_for 10 1 bash -c "! /bin/ps -axww -o command= | /usr/bin/grep -F '$UUID1' | /usr/bin/grep -qv grep" \
  || fail 'a process still carries the sessionUuid after teardown'
cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
echo "S-006 PASS — evidence in $EVIDENCE"
