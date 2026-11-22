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
BUN_VERSION=1.3.11
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "bun $(bun --version) != pinned $BUN_VERSION" >&2; exit 3; }
SRC=$(mktemp -d)
trap 'rm -rf $SRC' EXIT
git -C $REPO archive $REF | tar -x -C $SRC
cp $HERE/hyprmux-runtime.js $SRC/hyprmux-runtime.js
rm -rf $OUT; mkdir -p $OUT/server/radar
( cd $SRC && bun build --compile --target=bun-darwin-arm64 hyprmux-runtime.js --outfile $OUT/hyprmux-runtime )
cp -R $SRC/public $SRC/bin $SRC/lib $OUT/server/
cp -R $HERE/server-extras/node-compat $HERE/server-extras/hyprmux-bin $OUT/server/
cp $SRC/radar/verdict.schema.json $OUT/server/radar/
cp $SRC/package.json $OUT/server/package.json   # GET /api/version reads the Bridge version from it
echo "$REF" > $OUT/server/SERVER_REF
echo "runtime ok: $REF"
