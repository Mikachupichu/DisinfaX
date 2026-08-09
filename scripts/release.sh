#!/usr/bin/env bash
#
# One-command release: builds and zips all three targets, syncs the Safari bundle into the
# Xcode project, and verifies the result. Run this instead of the individual npm scripts.
#
#   npm run release
#
# Why a script rather than chaining the npm scripts:
#
#  1. `wxt build` / `wxt zip` finish their work and then DO NOT EXIT — they leave an esbuild
#     service running and hang forever. Chaining with `&&` therefore stalls after the first
#     target, and the Safari script's own `cp` step never fires (leaving the Xcode project
#     silently holding a previous build). This script watches each step's log for wxt's own
#     completion marker, then terminates the hung process itself.
#  2. Those hangs leak: a machine that has run this a few dozen times accumulates hundreds of
#     stray node/esbuild processes. Step 0 clears them before starting.
#  3. It refuses to run with KEEP_LOGS set, which would ship a build full of debug logging.
#
# Exits non-zero if any step fails or any verification check fails.

set -uo pipefail
set +m
cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
die() { echo "${RED}error:${OFF} $1" >&2; exit 1; }

# A KEEP_LOGS build keeps every console.* call. Never submittable.
[ -z "${KEEP_LOGS:-}" ] || die "KEEP_LOGS is set — unset it; a submission build must strip logs"

echo "${BOLD}0. Clearing leaked build processes${OFF}"
before=$(pgrep -f "wxt (build|zip)" 2>/dev/null | wc -l | tr -d ' ')
pkill -f "wxt (build|zip)" 2>/dev/null; pkill -f "esbuild --service" 2>/dev/null; sleep 1
pkill -9 -f "wxt (build|zip)" 2>/dev/null; pkill -9 -f "esbuild --service" 2>/dev/null; sleep 1
echo "   cleared $before leaked process(es)"

rm -rf .output

# Run one wxt step, wait for its completion marker, then kill the process it leaves behind.
# $1 = human label, $2 = marker to wait for, rest = command
step() {
  local label="$1" marker="$2"; shift 2
  local log; log="$(mktemp)"
  echo "${BOLD}$label${OFF}"
  ( exec nohup "$@" >"$log" 2>&1 ) &
  local pid=$!
  local waited=0
  while [ $waited -lt 600 ]; do
    grep -q "$marker" "$log" 2>/dev/null && break
    grep -qE "ERROR|✖" "$log" 2>/dev/null && break
    sleep 2; waited=$((waited + 2))
  done
  pkill -f "wxt (build|zip)" 2>/dev/null; wait $pid 2>/dev/null
  if ! grep -q "$marker" "$log" 2>/dev/null; then
    echo "--- last 25 lines ---"; tail -25 "$log"; rm -f "$log"
    die "$label did not complete"
  fi
  rm -f "$log"
  echo "   done"
}

step "1. Chrome  (build + zip)"  "Zipped extension in" npx wxt zip
step "2. Firefox (build + zip + sources)" "Zipped extension in" npx wxt zip -b firefox
step "3. Safari  (build)" "Finished in" npx wxt build -b safari

echo "${BOLD}4. Syncing Safari bundle into the Xcode project${OFF}"
bash scripts/copy-safari.sh || die "Safari copy failed"

echo
echo "${BOLD}5. Verifying${OFF}"
bash scripts/verify-release.sh || die "verification failed — do not submit"

echo
echo "${GREEN}${BOLD}Release artifacts:${OFF}"
ls -1 .output/*.zip
echo "Safari: DisinfaX/Shared (Extension)/  (build via Xcode)"
