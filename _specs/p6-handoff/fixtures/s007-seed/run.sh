#!/usr/bin/env bash
# p6 S-007 acceptance oracle — the seed contract, proven over HTTP. Runs from a fresh checkout;
# exits 0 on pass.
#
# What it proves: seedText = <brief or seedOverride> + "\n" + the FIRST TURN line, where the line
# is 116 bytes and its separator makes 117 (spec §6.8) — so with the default seedMaxBytes 12288 the
# largest legal override is 12171 (final seed EXACTLY 12288), 12172 is 413 seed_too_large, and a
# 12288-byte override is rejected outright. Plus §7.2: SAFETY_NOTICE is byte-equal to the PLAIN
# TEXT of the spec sentence — 334 UTF-8 bytes, committed as fixtures/s007-seed/SAFETY_NOTICE.txt
# (no markdown asterisks, no backticks, ASCII apostrophe, em dash retained).
#
# All boundary numbers are COMPUTED from the running config's seedMaxBytes (§11), never hard-coded
# beyond the two §6.8 constants (116/117) that are themselves asserted first.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s007-seed" "S-007"
export TMP    # node payload writers read process.env.TMP; the harness sets it unexported

fail() {
  echo "S-007 FAIL: $*" >&2
  cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
  exit 1
}

# The config-rewrite-then-restart dance is _lib.sh's shared p6_restart_server: the handoff module
# snapshots its config once at boot, so rewrites must land before a restart to be seen.

# --- the two §6.8 constants, asserted before anything depends on them --------------------------
export FT='FIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until the operator replies.'
node -e 'const ft=process.env.FT;
if(Buffer.byteLength(ft,"utf8")!==116){console.error("FIRST TURN line is "+Buffer.byteLength(ft,"utf8")+" bytes, not 116");process.exit(1);}
if(Buffer.byteLength("\n"+ft,"utf8")!==117)process.exit(1);' \
  || fail 'the FIRST TURN constants do not hold'

# --- a real repo so the fixture selector resolves ----------------------------------------------
# One epic-mapped branch plus one untracked file: the dirty worktree mints wt:<path>:dirty, so
# epic:PROJ-907 resolves to at least one fact key and preview cannot 422.
REPO_DIR="$TMP/p6fix/s007-repo"
mkdir -p "$REPO_DIR"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
export REPO_DIR
git -C "$REPO_DIR" init -q -b 'feature/PROJ-907-seed'
echo 's007 fixture' >"$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'
echo 'dirty' >"$REPO_DIR/UNTRACKED.txt"

chmod +x "$RADAR_DIR/stand-in-claude"
# polyrepoRoot too: §M2 falls back to it whenever |R| != 1, and the committed /tmp/p6fix
# placeholder exists nowhere — an unrewritten root would 422 workdir_unresolved.
export P6FIX_ROOT="$(cd "$TMP/p6fix" && pwd -P)"
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"s007-repo",path:process.env.REPO_DIR}];
c.polyrepoRoot=process.env.P6FIX_ROOT;
c.claudeBin=process.env.RADAR_DIR+"/stand-in-claude";
fs.writeFileSync(f,JSON.stringify(c,null,2));'
p6_restart_server || fail 'server restart after the config rewrite never came ready'

curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan.json" \
  || fail 'POST /api/radar/scan failed'
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/state.json","utf8"));
const r=st.repos&&st.repos["s007-repo"];
if(!(st.epics||[]).some((e)=>e.key==="PROJ-907"))process.exit(1);
if(!r||!(r.worktrees||[]).some((w)=>w.dirty&&(w.dirty.staged+w.dirty.unstaged+w.dirty.untracked)>0))process.exit(2);' \
  || fail 'the scan did not publish epic PROJ-907 with a dirty worktree — the selector would not resolve'

# The boundary numbers, computed from the RUNNING config (§11).
SEED_MAX="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8")).seedMaxBytes??12288)')"
OVERRIDE_MAX=$(( SEED_MAX - 117 ))
[ "$OVERRIDE_MAX" = "12171" ] || fail "seedMaxBytes=$SEED_MAX gives override max $OVERRIDE_MAX — fixture expects the 12288 default"
export SEED_MAX OVERRIDE_MAX

post_preview() { # <payload-file> <out-file> -> echoes HTTP code
  curl -s -o "$2" -w '%{http_code}' -XPOST \
    -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' \
    -d @"$1" "$BASE/api/radar/handoff/preview"
}

# --- default seed: brief + "\n" + FIRST TURN, first line /radar-handoff ------------------------
node -e 'require("fs").writeFileSync(process.env.TMP+"/p7-default.json",JSON.stringify({selectors:["epic:PROJ-907"]}))'
CODE=$(post_preview "$TMP/p7-default.json" "$EVIDENCE/preview-default.json")
[ "$CODE" = "200" ] || fail "default preview answered $CODE, expected 200 (body in $EVIDENCE/preview-default.json)"
node -e 'const fs=require("fs");
const env=JSON.parse(fs.readFileSync(process.env.EVIDENCE+"/preview-default.json","utf8"));
const s=env.plan.seedText, ft=process.env.FT;
if(s.split("\n")[0]!=="/radar-handoff"){console.error("seed line 1 is not /radar-handoff");process.exit(1);}
if(!s.endsWith("\n"+ft)){console.error("seed does not end with newline + the FIRST TURN line");process.exit(1);}
if(s.includes("UNRESOLVED SELECTORS")){console.error("an UNRESOLVED SELECTORS line is unreachable from p6 and must not render");process.exit(1);}' \
  || fail 'the default seedText violates the §6.8 contract'

# --- boundary: an override of seedMaxBytes-117 yields a final seed of EXACTLY seedMaxBytes -----
node -e 'const fs=require("fs");
fs.writeFileSync(process.env.TMP+"/p7-max.json",JSON.stringify({selectors:["epic:PROJ-907"],seedOverride:"a".repeat(Number(process.env.OVERRIDE_MAX))}))'
CODE=$(post_preview "$TMP/p7-max.json" "$EVIDENCE/boundary-ok.json")
[ "$CODE" = "200" ] || fail "override of $OVERRIDE_MAX bytes answered $CODE, expected 200"
node -e 'const fs=require("fs");
const env=JSON.parse(fs.readFileSync(process.env.EVIDENCE+"/boundary-ok.json","utf8"));
const s=env.plan.seedText, ft=process.env.FT, max=Number(process.env.SEED_MAX);
if(Buffer.byteLength(s,"utf8")!==max){console.error("final seed is "+Buffer.byteLength(s,"utf8")+" bytes, expected exactly "+max);process.exit(1);}
if(s!=="a".repeat(Number(process.env.OVERRIDE_MAX))+"\n"+ft){console.error("seed is not override + newline + FIRST TURN, byte for byte");process.exit(1);}' \
  || fail 'the largest legal override does not produce a final seed of exactly seedMaxBytes'

# --- one more byte is refused: 12172 -> 413 seed_too_large {limit} -----------------------------
node -e 'const fs=require("fs");
fs.writeFileSync(process.env.TMP+"/p7-over.json",JSON.stringify({selectors:["epic:PROJ-907"],seedOverride:"a".repeat(Number(process.env.OVERRIDE_MAX)+1)}))'
CODE=$(post_preview "$TMP/p7-over.json" "$EVIDENCE/boundary-too-large.json")
[ "$CODE" = "413" ] || fail "override of $((OVERRIDE_MAX+1)) bytes answered $CODE, expected 413"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/boundary-too-large.json","utf8"));
if(b.error!=="seed_too_large")process.exit(1);
if(b.limit!==Number(process.env.SEED_MAX)){console.error("limit is "+b.limit+", expected the applied cap "+process.env.SEED_MAX);process.exit(1);}
if(typeof b.message!=="string"||!b.message)process.exit(1);' \
  || fail 'the 413 body is not seed_too_large with the applied limit'

# --- and a seedMaxBytes-sized override is rejected outright (the cap is on the FINAL seed) -----
node -e 'const fs=require("fs");
fs.writeFileSync(process.env.TMP+"/p7-full.json",JSON.stringify({selectors:["epic:PROJ-907"],seedOverride:"a".repeat(Number(process.env.SEED_MAX))}))'
CODE=$(post_preview "$TMP/p7-full.json" "$EVIDENCE/boundary-full-size.json")
[ "$CODE" = "413" ] || fail "a ${SEED_MAX}-byte override answered $CODE, expected 413 — the join bytes must count"

# --- §7.2 SAFETY_NOTICE: plain text, 334 bytes, byte-equal to the committed literal ------------
# Deliberately LAST, so a wrong constant fails the story after the seed-cap machinery has already
# been proven — one defect, one failing tail, everything else evidenced.
node -e 'const fs=require("fs");
const lit=fs.readFileSync(process.env.FIX+"/SAFETY_NOTICE.txt","utf8");
if(Buffer.byteLength(lit,"utf8")!==334){console.error("committed literal is "+Buffer.byteLength(lit,"utf8")+" bytes, not 334 — fixture rot");process.exit(1);}
const got=require(process.cwd()+"/radar/handoff.js").SAFETY_NOTICE;
if(typeof got!=="string"){console.error("radar/handoff.js exports no SAFETY_NOTICE string");process.exit(1);}
if(got!==lit){console.error("SAFETY_NOTICE is "+Buffer.byteLength(got,"utf8")+" bytes, spec pins the 334-byte PLAIN TEXT (spec §7.2: the ** and backticks are markdown emphasis in the spec document, not part of the string)");process.exit(1);}
fs.writeFileSync(process.env.EVIDENCE+"/safety-notice.txt",got);' \
  || fail 'SAFETY_NOTICE does not match the §7.2 plain-text literal'

cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
echo "S-007 PASS — evidence in $EVIDENCE"
