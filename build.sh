#!/usr/bin/env bash
#
# Reproduces the submitted Firefox add-on from this source archive.
#
#   bash build.sh         -> .output/firefox-mv2/
#
# See README.md for environment requirements and installation instructions.
#
# This script exists because `wxt build` reliably finishes its work but does not always
# exit — it leaves an esbuild service running and hangs. Running the command directly is
# therefore fine but can appear to stall forever. This waits for wxt's own completion
# marker, then terminates the process, so the build always returns.

set -uo pipefail
set +m                       # suppress job-control noise when we stop the hung process
cd "$(dirname "$0")"

BROWSER="${1:-firefox}"      # bash build.sh chrome  also works

command -v node >/dev/null || { echo "error: node is not installed — see README.md" >&2; exit 1; }
command -v npm  >/dev/null || { echo "error: npm is not installed — see README.md" >&2; exit 1; }

echo "node $(node --version), npm $(npm --version)"
echo

# --ignore-scripts is REQUIRED here, not a preference. This project's postinstall hook runs
# `wxt prepare`, and like `wxt build` it completes its work, prints "✔ Finished", and then
# never exits — so a plain `npm ci` hangs forever and the build never starts. Skipping the
# hook avoids that entirely. `wxt prepare` only generates TypeScript types under .wxt/ for
# editor tooling; `wxt build` does not need them, which is why the output below is identical.
echo "==> npm ci --ignore-scripts  (exact versions from package-lock.json)"
npm ci --ignore-scripts || { echo "error: npm ci failed" >&2; exit 1; }

echo
echo "==> npx wxt build -b $BROWSER"
LOG="$(mktemp)"
( exec nohup npx wxt build -b "$BROWSER" >"$LOG" 2>&1 ) &
BUILD_PID=$!

waited=0
while [ $waited -lt 600 ]; do
  grep -q "Finished in" "$LOG" 2>/dev/null && break
  grep -qE "ERROR|✖" "$LOG" 2>/dev/null && break
  sleep 2; waited=$((waited + 2))
done
pkill -f "wxt build" 2>/dev/null; wait $BUILD_PID 2>/dev/null

cat "$LOG"
if ! grep -q "Finished in" "$LOG" 2>/dev/null; then
  rm -f "$LOG"; echo "error: build did not complete" >&2; exit 1
fi
rm -f "$LOG"

case "$BROWSER" in
  firefox) OUT=".output/firefox-mv2" ;;
  chrome)  OUT=".output/chrome-mv3" ;;
  *)       OUT=".output/$BROWSER" ;;
esac

echo
echo "Build complete: $OUT"
echo "This directory is the contents of the submitted zip. See README.md section 3 for the"
echo "one expected variance (an unused Tailwind utility class in assets/popup-*.css)."
