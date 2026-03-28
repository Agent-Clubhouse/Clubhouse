#!/usr/bin/env bash
# Verifies that src/shared/plugin-types.ts matches its committed hash lockfile.
# If the file was intentionally modified, update the hash with:
#   shasum -a 256 src/shared/plugin-types.ts > src/shared/plugin-types.ts.sha256

set -euo pipefail

LOCKFILE="src/shared/plugin-types.ts.sha256"
TARGET="src/shared/plugin-types.ts"

if [ ! -f "$LOCKFILE" ]; then
  echo "::error::Hash lockfile not found: $LOCKFILE"
  echo "Generate it with: shasum -a 256 $TARGET > $LOCKFILE"
  exit 1
fi

EXPECTED=$(awk '{print $1}' "$LOCKFILE")
ACTUAL=$(shasum -a 256 "$TARGET" | awk '{print $1}')

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "::error file=$TARGET::plugin-types.ts hash mismatch!"
  echo ""
  echo "The plugin API surface has changed without updating the hash lockfile."
  echo ""
  echo "  Expected: $EXPECTED"
  echo "  Actual:   $ACTUAL"
  echo ""
  echo "If this change is intentional:"
  echo "  1. Verify backward compatibility for stable API versions"
  echo "  2. Update the lockfile: shasum -a 256 $TARGET > $LOCKFILE"
  echo "  3. Commit both files together"
  echo ""
  echo "If this change is NOT intentional, revert your modifications to $TARGET."
  exit 1
fi

echo "plugin-types.ts hash verified: $ACTUAL"
