#!/usr/bin/env bash
# Sets chatCliDenylist in the live update manifests to what
# release/chat-cli-denylist.json says, without a release. Every other byte of
# each manifest stays as it was. .github/workflows/publish-cli-denylist.yml runs
# this; docs/release-publishing.md has the operation.
#
# Dry unless DRY_RUN is exactly "false". A dry run reads the public manifests
# with curl and needs no Azure login, so it has no way to write. Every manifest
# is read and checked before the first upload, and an upload that succeeds is
# never repeated, so the recovery from a failure is GitHub's "re-run failed jobs".
set -euo pipefail

: "${GITHUB_REPOSITORY:?}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST_FILE="${LIST_FILE:-release/chat-cli-denylist.json}"
ACCOUNT="${RELEASE_ACCOUNT:-stclubhousereleases}"
CONTAINER="${RELEASE_CONTAINER:-releases}"
AZ_BLOB=(--account-name "$ACCOUNT" --container-name "$CONTAINER" --auth-mode login)
DRY=true
if [ "${DRY_RUN:-true}" = "false" ]; then
  DRY=false
fi

# The order a release writes them in: each channel's legacy path, then the v2
# path that clients read.
BLOBS=(updates/latest.json updates/v2/latest.json updates/preview.json updates/v2/preview.json)

node "$SCRIPT_DIR/cli-denylist.mjs" validate --list "$LIST_FILE"

REWRITE_ARGS=(--list "$LIST_FILE")
if [ "${CLEAR_LIST:-false}" = "true" ]; then
  REWRITE_ARGS+=(--allow-clear)
fi

if [ "$DRY" = "false" ]; then
  # A release reads main's file, so main is the only thing that may go live.
  if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
    echo "::error::Publishing runs from main only, so the next release can't drop what this writes. This run is on ${GITHUB_REF:-no ref}."
    exit 1
  fi
  # A running release may have read main's list already and uploads its manifest
  # later, which would undo this run if main changed in between.
  ACTIVE=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow release.yml --limit 20 \
    --json status --jq '[.[] | select(.status != "completed")] | length')
  if [ "$ACTIVE" != "0" ]; then
    echo "::error::A Release run is in progress or queued. Re-run this job once it finishes."
    exit 1
  fi
fi

WORK="$(mktemp -d)"
TO_UPLOAD=()
ETAGS=()

for BLOB in "${BLOBS[@]}"; do
  FILE="$WORK/$(echo "$BLOB" | tr / _)"
  if [ "$DRY" = "true" ]; then
    # Manifests are public. The real run re-reads them through Azure.
    curl -fsSL "https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${BLOB}" -o "$FILE"
    ETAG=""
  else
    # Pin the blob's ETag so anything else writing it at the same time makes the
    # upload fail instead of being overwritten.
    ETAG=$(az storage blob show "${AZ_BLOB[@]}" --name "$BLOB" --query properties.etag --output tsv)
    az storage blob download "${AZ_BLOB[@]}" --name "$BLOB" --file "$FILE" --if-match "$ETAG" --output none
  fi

  STATUS=$(node "$SCRIPT_DIR/cli-denylist.mjs" rewrite-manifest --file "$FILE" --out "$FILE.new" "${REWRITE_ARGS[@]}")
  echo "::group::${BLOB}: ${STATUS}"
  diff -u <(jq '.chatCliDenylist' "$FILE") <(jq '.chatCliDenylist' "$FILE.new") || true
  echo "$(wc -c < "$FILE") -> $(wc -c < "$FILE.new") bytes; only chatCliDenylist can differ"
  echo "::endgroup::"

  if [ "$STATUS" = "status=updated" ]; then
    TO_UPLOAD+=("$BLOB")
    ETAGS+=("$ETAG")
  fi
done

if [ "$DRY" = "true" ]; then
  echo "Dry run: ${#TO_UPLOAD[@]} manifest(s) would change. Nothing was written."
  exit 0
fi

for i in "${!TO_UPLOAD[@]}"; do
  BLOB="${TO_UPLOAD[$i]}"
  FILE="$WORK/$(echo "$BLOB" | tr / _)"
  az storage blob upload "${AZ_BLOB[@]}" --name "$BLOB" --file "$FILE.new" --overwrite \
    --if-match "${ETAGS[$i]}" --content-type application/json --output none
  echo "Published ${BLOB}"
done
echo "Done: ${#TO_UPLOAD[@]} manifest(s) changed."
