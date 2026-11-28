#!/bin/zsh
# Developer ID sign + notarize + staple "HyprMux Bridge.app" and build HyprMuxBridge.dmg.
# Runs on the Mac that holds the Developer ID Application certificate. Input = the unsigned app from
# package-bridge.sh. Order is inside-out:
#   1 hyprmux-runtime (hardened runtime + JIT entitlements)   2 HyprMuxBridge (hardened runtime)
#   2b hm-screen-stream (hardened runtime, no entitlements: native Swift, no JIT)   3 the app
#   4 verify   5 notarize app zip + staple   6 DMG, sign, notarize, staple
# cloudflared keeps Cloudflare's own Developer ID signature (hardened + timestamped; pinned in cloudflared.ref).
# The Bridge is not sandboxed and uses no restricted entitlement, so no provisioning profile is embedded.
#
# Usage: scripts/bridge-app/sign-bridge.sh <"HyprMux Bridge.app"> <out-dir>
# Env:   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (App Store Connect key, for notarytool)
#        SIGN_ID (default "Developer ID Application: Imaginato Pte. Ltd. (7CTVV9C45A)")
#        SIGN_DRY_RUN=1 prints the codesign commands in order (steps 0-3) and stops: no signing, no
#        notarization, no DMG, no ASC key needed.
set -euo pipefail
HERE=${0:A:h}
APP=${1:?HyprMux Bridge.app}; OUT=${2:?out dir}
SIGN_ID=${SIGN_ID:-"Developer ID Application: Imaginato Pte. Ltd. (7CTVV9C45A)"}
DRY=${SIGN_DRY_RUN:-}
[ -n "$DRY" ] || : ${ASC_KEY_ID:?} ${ASC_ISSUER_ID:?} ${ASC_KEY_PATH:?}
C="$APP/Contents"
mkdir -p "$OUT"

# 0. sanity: the pieces package-bridge.sh adds
for f in MacOS/HyprMuxBridge MacOS/hyprmux-runtime MacOS/hm-screen-stream MacOS/hm-key-tap MacOS/cloudflared Library/LaunchAgents/com.hyprmux.bridge.core.plist Info.plist; do
  [ -e "$C/$f" ] || { echo "missing $f (run package-bridge.sh first)" >&2; exit 2; }
done
CF_TEAM=$(grep '^team=' $HERE/cloudflared.ref | cut -d= -f2-)
CF_SIG=$(codesign -dv "$C/MacOS/cloudflared" 2>&1 || true)
if [ -n "$DRY" ]; then echo "dry run: cloudflared team check (team=$CF_TEAM) not enforced" >&2
else [[ "$CF_SIG" == *"TeamIdentifier=$CF_TEAM"* ]] || { echo "cloudflared lost Cloudflare's signature" >&2; exit 3; }; fi

sign() {
  if [ -n "$DRY" ]; then print -r -- codesign --force --timestamp --options runtime --sign ${(q-)SIGN_ID} ${(q-)@}; return; fi
  codesign --force --timestamp --options runtime --sign "$SIGN_ID" "$@"
}

# 1. runtime  2. menu bar / core binary
sign --entitlements $HERE/entitlements-runtime.plist "$C/MacOS/hyprmux-runtime"
sign "$C/MacOS/HyprMuxBridge"
# 2b. screen video helper (inner binary: signed before the app)
sign "$C/MacOS/hm-screen-stream"
sign "$C/MacOS/hm-key-tap"   # HMX k110: hardened runtime, no entitlements (native Swift)
# Any bundled native addons under Resources/server are signed too (none expected; listed for notarization).
for lib in "$C"/Resources/server/**/*.(dylib|node)(N); do sign "$lib"; done
# 3. app
sign "$APP"
[ -z "$DRY" ] || { echo "dry run: stopped before verify (step 4)" >&2; exit 0; }

# 4. verify (never pipe codesign into tail under set -e: it hides the failure)
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements - "$C/MacOS/hyprmux-runtime" > "$OUT/runtime-entitlements.txt" 2>&1

# 5. notarize the app, staple
ditto -c -k --keepParent "$APP" "$OUT/HyprMuxBridge.zip"
xcrun notarytool submit "$OUT/HyprMuxBridge.zip" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait --output-format json > "$OUT/notary-app.json"
grep -q '"status" *: *"Accepted"' "$OUT/notary-app.json" || { echo "app notarization not accepted: see $OUT/notary-app.json (notarytool log <id>)" >&2; exit 4; }
xcrun stapler staple "$APP"

# 6. DMG (with an /Applications link), sign, notarize, staple
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/HyprMux Bridge.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "HyprMux Bridge" -srcfolder "$STAGE" -ov -format UDZO "$OUT/HyprMuxBridge.dmg"
codesign --force --timestamp --sign "$SIGN_ID" "$OUT/HyprMuxBridge.dmg"
xcrun notarytool submit "$OUT/HyprMuxBridge.dmg" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait --output-format json > "$OUT/notary-dmg.json"
grep -q '"status" *: *"Accepted"' "$OUT/notary-dmg.json" || { echo "dmg notarization not accepted: see $OUT/notary-dmg.json" >&2; exit 4; }
xcrun stapler staple "$OUT/HyprMuxBridge.dmg"

spctl -a -vvv -t install "$OUT/HyprMuxBridge.dmg" 2>&1 | tee "$OUT/spctl-dmg.txt"
spctl -a -vvv -t execute "$APP" 2>&1 | tee "$OUT/spctl-app.txt"
shasum -a 256 "$OUT/HyprMuxBridge.dmg" | tee "$OUT/HyprMuxBridge.dmg.sha256"
echo "signed + notarized: $OUT/HyprMuxBridge.dmg"
