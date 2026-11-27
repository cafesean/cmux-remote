#!/bin/zsh
# Build the bundled server pieces for HyprMux Bridge.app from THIS checkout's HEAD.
#   <out>/hyprmux-runtime   one bun-compiled binary: server | bridge | tunnel (hyprmux-runtime.js)
#   <out>/server/{public,bin,lib,radar/verdict.schema.json,node-compat,hyprmux-bin}   run-time files
# Usage: scripts/bridge-app/build-runtime.sh <out-dir>
set -euo pipefail
HERE=${0:A:h}
OUT=${1:?out dir}
REPO=${HERE:h:h}
REF=$(git -C $REPO rev-parse HEAD)
# Pinned toolchain: the bun that compiles the notarized binary is part of the supply chain.
# HMX k211: a host bun of another version no longer stops the build; the pinned official release is fetched once
# into a cache and checked against its published sha256 (SHASUMS256.txt of that release) before use.
BUN_VERSION=1.3.11
BUN_ZIP_SHA256=6f5a3467ed9caec4795bf78cd476507d9f870c7d57b86c945fcb338126772ffc   # bun-darwin-aarch64.zip
BUN=$(command -v bun || true)
if [ -z "$BUN" ] || [ "$($BUN --version)" != "$BUN_VERSION" ]; then
  CACHE=${HYPRMUX_BUN_CACHE:-$HOME/.cache/hyprmux-build/bun-$BUN_VERSION}
  BUN=$CACHE/bun-darwin-aarch64/bun
  if [ ! -x $BUN ]; then
    mkdir -p $CACHE
    curl -fsSL -o $CACHE/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-darwin-aarch64.zip"
    [ "$(shasum -a 256 $CACHE/bun.zip | cut -d' ' -f1)" = "$BUN_ZIP_SHA256" ] || { echo "bun zip sha256 mismatch" >&2; rm -f $CACHE/bun.zip; exit 3; }
    ditto -x -k $CACHE/bun.zip $CACHE && rm -f $CACHE/bun.zip
  fi
fi
[ "$($BUN --version)" = "$BUN_VERSION" ] || { echo "bun $($BUN --version) != pinned $BUN_VERSION" >&2; exit 3; }
echo "bun: $BUN ($BUN_VERSION)"
SRC=$(mktemp -d)
trap 'rm -rf $SRC' EXIT
git -C $REPO archive $REF | tar -x -C $SRC
cp $HERE/hyprmux-runtime.js $SRC/hyprmux-runtime.js
rm -rf $OUT; mkdir -p $OUT/server/radar
( cd $SRC && $BUN build --compile --target=bun-darwin-arm64 hyprmux-runtime.js --outfile $OUT/hyprmux-runtime )
cp -R $SRC/public $SRC/bin $SRC/lib $OUT/server/
cp -R $HERE/server-extras/node-compat $HERE/server-extras/hyprmux-bin $OUT/server/
cp $SRC/radar/verdict.schema.json $OUT/server/radar/
cp $SRC/package.json $OUT/server/package.json   # GET /api/version reads the Bridge version from it
echo "$REF" > $OUT/server/SERVER_REF
echo "runtime ok: $REF"
