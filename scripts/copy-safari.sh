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
