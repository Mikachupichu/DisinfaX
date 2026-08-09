#!/usr/bin/env bash
#
# Pre-submission verification. Run AFTER building all three targets and both zips.
#
# Why this exists: the zip config can guarantee that unwanted files are EXCLUDED (the
# sources allowlist in wxt.config.ts is default-deny), but no config can guarantee that
# everything NEEDED is INCLUDED — add a new top-level source directory and the allowlist
# silently drops it. The only real proof is to rebuild the extension from the sources zip
# alone and compare. That is what check 5 does.
#
# Exits non-zero on any failure. No output is uploaded anywhere; everything runs locally.

set -uo pipefail
set +m   # no job-control chatter when we pkill the wxt build that refuses to exit
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=1; }

# Anything that must never reach a store or a reviewer. Extend this list freely — it is a
# tripwire, not the mechanism (the allowlist is the mechanism).
FORBIDDEN='config\.yaml|venv/|DisinfaX/|CLAUDE|README|\.env|\.git|\.swift$|\.plist$|xcodeproj|storekit|Apple Payments'

echo "1. Build outputs contain only extension assets"
for d in chrome-mv3 firefox-mv2 safari-mv2; do
  [ -d ".output/$d" ] || { bad "$d missing — build it first"; continue; }
  stray=$(find ".output/$d" -type f ! -path '*/_locales/*' ! -path '*/icon/*' \
    ! -name '*.js' ! -name '*.json' ! -name '*.html' ! -name '*.svg' ! -name '*.css' ! -name '*.png')
  [ -z "$stray" ] && ok "$d" || bad "$d has non-asset files:\n$stray"
done

echo "2. Production log stripping (a KEEP_LOGS build must never be submitted)"
for d in chrome-mv3 firefox-mv2 safari-mv2; do
  [ -d ".output/$d" ] || continue
  n=$(grep -rlo 'ttft-ext\|\[misinfo\]' ".output/$d" 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "0" ] && ok "$d has no debug logging" || bad "$d still contains debug logging in $n file(s)"
done

echo "3. Zips contain nothing forbidden"
for z in .output/*.zip; do
  [ -e "$z" ] || { bad "no zips found — run npm run zip && npm run zip:firefox"; break; }
  hits=$(unzip -Z1 "$z" | grep -iE "$FORBIDDEN" || true)
  [ -z "$hits" ] && ok "$(basename "$z")" || bad "$(basename "$z") contains:\n$hits"
done

echo "4. Safari folder matches the build and has no orphans"
SAFARI_DIR="DisinfaX/Shared (Extension)"
if [ -d ".output/safari-mv2" ] && [ -d "$SAFARI_DIR" ]; then
  # cp -R never deletes, so a renamed/removed file lingers here forever — and Xcode ships
  # every file in these folder references, so an orphan is dead code inside the .appex.
  orphans=""
  for sub in chunks assets; do
    for f in "$SAFARI_DIR/$sub"/*; do
      [ -e "$f" ] || continue
      grep -q "$sub/$(basename "$f")" "$SAFARI_DIR/popup.html" 2>/dev/null || orphans="$orphans $sub/$(basename "$f")"
    done
  done
  [ -z "$orphans" ] && ok "no orphaned chunks/assets" || bad "orphans (delete the web files and re-copy):$orphans"
  cmp -s ".output/safari-mv2/background.js" "$SAFARI_DIR/background.js" \
    && ok "background.js matches the build" \
    || bad "background.js differs — the cp step did not run (wxt hangs before it)"
else
  bad "safari-mv2 or the Xcode folder is missing"
fi

echo "5. Sources zip actually rebuilds the extension (inclusion proof)"
SRC_ZIP=$(ls .output/*sources*.zip 2>/dev/null | head -1)
if [ -z "$SRC_ZIP" ]; then
  bad "no sources zip — run npm run zip:firefox"
else
  TMP=$(mktemp -d)
  unzip -q "$SRC_ZIP" -d "$TMP"
  ln -s "$ROOT/node_modules" "$TMP/node_modules"
  ( cd "$TMP" && exec nohup npx wxt build -b firefox >"$TMP/build.log" 2>&1 ) &
  BUILD_PID=$!
  for _ in $(seq 1 90); do grep -q "Finished in" "$TMP/build.log" 2>/dev/null && break; sleep 2; done
  pkill -f "wxt build" 2>/dev/null; wait $BUILD_PID 2>/dev/null   # wxt does not exit on its own
  if ! grep -q "Finished in" "$TMP/build.log" 2>/dev/null; then
    bad "sources zip does NOT build — a required file is missing from includeSources:"
    tail -20 "$TMP/build.log"
  else
    # background.js and the content scripts are the security-relevant code. The popup CSS is
    # excluded from this comparison on purpose: Tailwind's content scanner walks whatever else
    # happens to be on disk and honours .gitignore (which is not shipped), so it can differ by
    # a couple of unused utility classes between environments without any source differing.
    same=1
    for f in background.js content-scripts/relay.js content-scripts/capture.js; do
      cmp -s "$TMP/.output/firefox-mv2/$f" ".output/firefox-mv2/$f" || { bad "$f differs from the shipped build"; same=0; }
    done
    [ "$same" = "1" ] && ok "background.js + content scripts rebuild byte-identically"
  fi
  rm -rf "$TMP"
fi

echo
[ "$FAIL" = "0" ] && echo "ALL CHECKS PASSED — safe to submit" || echo "CHECKS FAILED — do not submit"
exit $FAIL
