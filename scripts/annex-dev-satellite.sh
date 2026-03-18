#!/usr/bin/env bash
#
# Launch a Clubhouse instance as "satellite" (Instance A) with an isolated
# userData directory. Used for manual Annex V2 testing.
#
# Usage: ./scripts/annex-dev-satellite.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MAIN_ENTRY="$PROJECT_DIR/.webpack/$(uname -m | sed 's/arm64/arm64/;s/x86_64/x64/')/main"

# Create a persistent temp dir (survives between runs for easier testing)
USER_DATA="${TMPDIR:-/tmp}/clubhouse-annex-satellite"
mkdir -p "$USER_DATA"

echo "=== Clubhouse Annex V2 — Satellite (Instance A) ==="
echo "userData: $USER_DATA"
echo "main:     $MAIN_ENTRY"
echo ""

# Check if webpack build exists
if [ ! -d "$MAIN_ENTRY" ]; then
  echo "ERROR: Webpack build not found at $MAIN_ENTRY"
  echo "Run 'npm start' first to create the build, or 'npm run make' for a production build."
  exit 1
fi

export CLUBHOUSE_USER_DATA="$USER_DATA"
exec npx electron "$MAIN_ENTRY"
