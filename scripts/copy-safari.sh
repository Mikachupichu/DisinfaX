#!/usr/bin/env bash
#
# Copy the built Safari extension into the Xcode project, replacing the previous web
# assets instead of merging with them.
#
# Why not a plain `cp -R`: cp never deletes. Vite hashes the popup chunk and CSS, so every
# build that touches popup code emits new filenames and the old ones stay behind forever.
# Xcode references `chunks/`, `assets/`, `content-scripts/`, `_locales/` and `icon/` as
# FOLDER references, so it bundles every file inside them — orphans included. That shipped
# dead code inside the .appex, and Tailwind's content scanner also read those stale bundles
# and fed their class names back into the next build's CSS.
#
# Deletion is allowlist-based, not a list of things to remove: everything in the target is
# cleared EXCEPT the native sources that legitimately live alongside the web assets. A new
# kind of build output therefore cannot survive as an orphan, and a new native file cannot
# be deleted by accident as long as it matches one of the keep patterns below.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=".output/safari-mv2"
DEST="DisinfaX/Shared (Extension)"

# Refuse to clear the destination unless a real build is there to replace it. Without this,
# running the script after a failed build would leave the Xcode project with no extension.
if [ ! -f "$SRC/manifest.json" ] || [ ! -f "$SRC/background.js" ]; then
  echo "error: $SRC does not contain a completed build — run 'npm run build:safari' first" >&2
  exit 1
fi
[ -d "$DEST" ] || { echo "error: $DEST not found" >&2; exit 1; }

# Every root-level entry in the build must be declared in the Xcode project. Xcode copies
# these by explicit path (the folder references under `Resources` point straight at
# .output/safari-mv2), so an output nobody declared is simply absent from the shipped
# appex — and nothing fails: the build succeeds, the extension loads, and the missing piece
# goes unnoticed until whatever needed it does nothing at all. `selection.js` shipped
# missing for exactly this reason, for as long as the on-demand script has existed.
#
# Checked before the destination is touched, so a rejection leaves the project as it was.
PBX="DisinfaX/DisinfaX.xcodeproj/project.pbxproj"
undeclared=""
for path in "$SRC"/*; do
  name="$(basename "$path")"
  grep -qF "safari-mv2/$name" "$PBX" || undeclared="$undeclared $name"
done
if [ -n "$undeclared" ]; then
  echo "error: built but not declared in project.pbxproj, so not bundled:$undeclared" >&2
  echo "  add a PBXFileReference for it, plus one PBXBuildFile per extension target" >&2
  echo "  (iOS and macOS), and list each in that target's Resources build phase" >&2
  exit 1
fi

# Native files to preserve. Dotfiles (.storekit.storekit) are skipped by the glob below.
keep() {
  case "$1" in
    *.swift|*.plist|*.entitlements|*.h|*.m|*.pbxproj) return 0 ;;
    *) return 1 ;;
  esac
}

removed=0
for path in "$DEST"/*; do
  [ -e "$path" ] || continue          # empty-glob guard
  name="$(basename "$path")"
  if keep "$name"; then continue; fi
  rm -rf "$path"
  removed=$((removed + 1))
done

cp -R "$SRC"/* "$DEST"/

echo "copied $SRC -> $DEST (cleared $removed stale entr$([ $removed -eq 1 ] && echo y || echo ies))"
