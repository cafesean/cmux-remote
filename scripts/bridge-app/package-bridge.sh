#!/bin/zsh
# Assemble HyprMux Bridge.app (unsigned; signing + notarization is a separate step).
#   Contents/MacOS/HyprMuxBridge                    menu bar app + `--core` agent (swift build -c release)
#   Contents/MacOS/hm-screen-stream                 screen video helper, spawned by the runtime (swift build -c release)
#   Contents/MacOS/hyprmux-runtime                  bun-compiled server|bridge|tunnel (build-runtime.sh)
#   Contents/MacOS/cloudflared                      pinned + verified (cloudflared.ref), Cloudflare's signature kept
#   Contents/Resources/server/                      files the server reads at run time
#   Contents/Resources/StatusBarIconTemplate*.png   menu bar logo (template image, 18 pt @1x/@2x)
#   Contents/Resources/AppIcon.icns                 app icon (HyprMux mark, colours swapped)
#   Contents/Library/LaunchAgents/*.plist           registered by the Bridge with SMAppService.agent
#   Contents/Info.plist                             version = package.json version
# Usage: scripts/bridge-app/package-bridge.sh <out-dir> [work-dir]   -> <out-dir>/HyprMux Bridge.app
# Test seams (local builds only): BRIDGE_MENU_BIN, BRIDGE_SCREEN_STREAM_BIN, BRIDGE_RUNTIME_DIR, BRIDGE_CLOUDFLARED_BIN use prebuilt pieces.
set -euo pipefail
HERE=${0:A:h}
REPO=${HERE:h:h}
OUT=${1:?out dir}
WORK=${2:-$(mktemp -d)}
APP="$OUT/HyprMux Bridge.app"
C="$APP/Contents"
VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' $REPO/package.json | head -1)
rm -rf "$APP"; mkdir -p "$C/MacOS" "$C/Resources" "$C/Library/LaunchAgents"

# 1. menu bar / core binary
if [ -n "${BRIDGE_MENU_BIN:-}" ]; then MENU=$BRIDGE_MENU_BIN; else
  swift build -c release --package-path $REPO/native/hyprmux-bridge >&2
  MENU=$(swift build -c release --package-path $REPO/native/hyprmux-bridge --show-bin-path)/HyprMuxBridge
fi
install -m 755 "$MENU" "$C/MacOS/HyprMuxBridge"

# 1b. screen video helper: next to hyprmux-runtime, which finds it at dirname(execPath)/hm-screen-stream
# (lib/screen-stream.js). Spawned by the runtime, so the Screen Recording grant stays on the Bridge.
if [ -n "${BRIDGE_SCREEN_STREAM_BIN:-}" ]; then SS=$BRIDGE_SCREEN_STREAM_BIN; else
  swift build -c release --package-path $REPO/native/hyprmux-bridge --product hm-screen-stream >&2
  SS=$(swift build -c release --package-path $REPO/native/hyprmux-bridge --show-bin-path)/hm-screen-stream
fi
install -m 755 "$SS" "$C/MacOS/hm-screen-stream"

# 1c. HMX k110: key tap helper (⌘Tab/⌘Space/⌘` for Remote Desktop), found the same way (lib/key-capture.js).
if [ -n "${BRIDGE_KEY_TAP_BIN:-}" ]; then KT=$BRIDGE_KEY_TAP_BIN; else
  swift build -c release --package-path $REPO/native/hyprmux-bridge --product hm-key-tap >&2
  KT=$(swift build -c release --package-path $REPO/native/hyprmux-bridge --show-bin-path)/hm-key-tap
fi
install -m 755 "$KT" "$C/MacOS/hm-key-tap"

# 2. runtime
RT=${BRIDGE_RUNTIME_DIR:-}
if [ -z "$RT" ]; then RT=$WORK/rt; $HERE/build-runtime.sh $RT; fi
install -m 755 $RT/hyprmux-runtime "$C/MacOS/hyprmux-runtime"
if [ -d $RT/server ]; then cp -R $RT/server "$C/Resources/server"; fi

# 3. cloudflared (pinned, both hashes + Cloudflare team checked)
ref() { grep "^$1=" $HERE/cloudflared.ref | cut -d= -f2-; }
if [ -n "${BRIDGE_CLOUDFLARED_BIN:-}" ]; then CF=$BRIDGE_CLOUDFLARED_BIN; else
  mkdir -p $WORK/cfd
  curl -fsSL -o $WORK/cfd/cf.tgz "$(ref url)"
  [ "$(shasum -a 256 $WORK/cfd/cf.tgz | cut -d' ' -f1)" = "$(ref tgz_sha256)" ] || { echo "cloudflared tgz sha256 mismatch" >&2; exit 3; }
  tar -xzf $WORK/cfd/cf.tgz -C $WORK/cfd
  [ "$(shasum -a 256 $WORK/cfd/cloudflared | cut -d' ' -f1)" = "$(ref bin_sha256)" ] || { echo "cloudflared binary sha256 mismatch" >&2; exit 3; }
  SIG=$(codesign -dv $WORK/cfd/cloudflared 2>&1 || true)   # not `| grep -q`: SIGPIPE + pipefail fails it
  [[ "$SIG" == *"TeamIdentifier=$(ref team)"* ]] || { echo "cloudflared not signed by Cloudflare" >&2; exit 3; }
  CF=$WORK/cfd/cloudflared
fi
install -m 755 "$CF" "$C/MacOS/cloudflared"

# 4. menu bar logo
cp $HERE/Resources/StatusBarIconTemplate.png $HERE/Resources/StatusBarIconTemplate@2x.png "$C/Resources/"
# app icon (Finder, Applications, System Settings privacy panes): the HyprMux mark, colours swapped
cp $HERE/Resources/AppIcon.icns "$C/Resources/AppIcon.icns"

# 5. LaunchAgents + Info.plist
cp $HERE/LaunchAgents/*.plist "$C/Library/LaunchAgents/"
for p in "$C"/Library/LaunchAgents/*.plist; do plutil -lint -s "$p"; done
# Public PKCE client (no secret); HYPRMUX_HUB_CLIENT_ID='' builds with sign-in hidden.
HUB_CLIENT_ID=${HYPRMUX_HUB_CLIENT_ID-apmcnx_appmatic-hub.zDT0bZHA-Xs3xskZ7iiqyw}
sed -e "s/__VERSION__/$VERSION/g" -e "s/__HUB_CLIENT_ID__/$HUB_CLIENT_ID/g" $HERE/Info.plist > "$C/Info.plist"
plutil -lint -s "$C/Info.plist"
echo "packaged: $APP ($VERSION, cloudflared $(ref version))"
