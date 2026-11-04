#!/usr/bin/env bash
# Publishes a built release. .github/workflows/release.yml runs this after the
# builds succeed; docs/release-publishing.md has the order, what a failure at
# each step leaves for users, and the rollback.
#
# The order is the safety property: everything a manifest points at goes live
# before the manifest does, so an updater can't be told about a version it can't
# fetch. Every step can be repeated, so the recovery from a failure is GitHub's
# "re-run failed jobs".
set -euo pipefail

: "${VERSION:?}" "${IS_PREVIEW:?}" "${GITHUB_REPOSITORY:?}"
: "${RELEASE_MESSAGE?}" "${RELEASE_NOTES?}"
ACCOUNT="${RELEASE_ACCOUNT:-stclubhousereleases}"
CONTAINER="${RELEASE_CONTAINER:-releases}"
AZ_BLOB=(--account-name "$ACCOUNT" --container-name "$CONTAINER" --auth-mode login)
if [ "$IS_PREVIEW" = "true" ]; then
  # Copy installers to the preview/ slot (constantly overwritten)
  SLOT="preview"
  FEED="preview"
else
  SLOT="latest"
  FEED="stable"
fi

blob_exists() {
  local exists
  # A failed lookup stops the run. Only a clean "false" means the blob is missing.
  exists="$(az storage blob exists "${AZ_BLOB[@]}" --name "$1" --query exists --output tsv)" || exit 1
  [ "$exists" = "true" ]
}

upload_mutable() { # file blob [content-type]
  az storage blob upload "${AZ_BLOB[@]}" --name "$2" --file "$1" --overwrite \
    ${3:+--content-type "$3"} --output none
}

# Versioned artifacts never change once published. On a re-run, identical bytes
# are already done; different bytes stop the run.
upload_immutable() { # file blob
  if blob_exists "$2"; then
    local existing
    existing="$(mktemp)"
    az storage blob download "${AZ_BLOB[@]}" --name "$2" --file "$existing" --output none
    if cmp -s "$1" "$existing"; then
      echo "Already uploaded: $2"
      rm -f "$existing"
      return 0
    fi
    echo "::error::$2 already exists with different bytes. A rebuilt run can't replace a published artifact; cut a new version."
    exit 1
  fi
  az storage blob upload "${AZ_BLOB[@]}" --name "$2" --file "$1" --overwrite false --output none
}

# Writes artifacts/history.json, or stops the run with nothing published.
prepare_history() {
  if ! blob_exists "updates/v2/history.json"; then
    echo "::error::updates/v2/history.json is missing. Restore it before releasing; refusing to start a new history."
    exit 1
  fi
  az storage blob download "${AZ_BLOB[@]}" --name "updates/v2/history.json" --file "$WORK/history-existing.json" --output none
  if ! jq -e 'type == "array" and length > 0' "$WORK/history-existing.json" > /dev/null; then
    echo "::error::updates/v2/history.json is not a non-empty array. Refusing to overwrite it."
    exit 1
  fi

  # Create the new entry
  jq -n \
    --arg version "$VERSION" \
    --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg message "$RELEASE_MESSAGE" \
    --arg notes "$RELEASE_NOTES" \
    '{
      version: $version,
      releaseDate: $date,
      releaseMessage: $message,
      releaseNotes: $notes
    }' > "$WORK/new-entry.json"

  # Replace an existing version in place; prepend new versions.
  jq --slurpfile entry "$WORK/new-entry.json" 'if any(.[]; .version == $entry[0].version) then map(if .version == $entry[0].version then $entry[0] else . end) else [$entry[0]] + . end' "$WORK/history-existing.json" > artifacts/history.json

  echo "Updated history.json ($(jq length artifacts/history.json) entries):"
  jq '.[0]' artifacts/history.json
}

publish_squirrel_feed() { # feed
  local feed="$1"
  for WIN_ARCH in x64 arm64; do
    local src="artifacts/squirrel-win32-${WIN_ARCH}"
    local dest="squirrel/${feed}/win32-${WIN_ARCH}"
    echo "Uploading Squirrel files for win32-${WIN_ARCH} to ${dest}/"
    # Packages first: RELEASES names them, so it can't arrive before they do.
    for nupkg in "$src"/*.nupkg; do
      echo "  Uploading $(basename "$nupkg")"
      upload_mutable "$nupkg" "${dest}/$(basename "$nupkg")"
    done
    upload_mutable "$src/RELEASES" "${dest}/RELEASES"
  done
}

WORK="$(mktemp -d)"

# ---------------------------------------------------------------------------
# 0. Preflight: nothing below is written unless all of this holds.
# ---------------------------------------------------------------------------

for WIN_ARCH in x64 arm64; do
  if [ ! -f "artifacts/squirrel-win32-${WIN_ARCH}/RELEASES" ] || ! compgen -G "artifacts/squirrel-win32-${WIN_ARCH}/*.nupkg" > /dev/null; then
    echo "::error::No Squirrel files for win32-${WIN_ARCH}. Windows couldn't install this version."
    exit 1
  fi
done

# A stable build also goes to the preview feed, so a preview-channel Windows
# client that's offered it can install it: those clients only read that feed.
# Not when preview has moved past this version, which would put an older build
# at the head of the feed.
CROSS_PUBLISH=false
if [ "$IS_PREVIEW" != "true" ]; then
  prepare_history

  az storage blob download "${AZ_BLOB[@]}" --name "updates/v2/preview.json" --file "$WORK/preview-current.json" --output none
  PREVIEW_BASE="$(jq -er .version "$WORK/preview-current.json")"
  PREVIEW_BASE="${PREVIEW_BASE%%-*}"
  PREVIEW_BASE="${PREVIEW_BASE%rc}"
  NEWEST="$(printf '%s\n%s\n' "$PREVIEW_BASE" "$VERSION" | sort -V | tail -n 1)"
  if [ "$NEWEST" = "$VERSION" ]; then
    CROSS_PUBLISH=true
  else
    echo "Preview is on ${PREVIEW_BASE}, past ${VERSION}: leaving squirrel/preview alone."
  fi
fi

# ---------------------------------------------------------------------------
# 1. Versioned artifacts: nothing points at them yet.
# ---------------------------------------------------------------------------

for file in artifacts/Clubhouse-*.zip artifacts/Clubhouse-*.dmg artifacts/Clubhouse-*.exe artifacts/Clubhouse-*.deb artifacts/Clubhouse-*.rpm; do
  [ -f "$file" ] || continue
  upload_immutable "$file" "artifacts/$(basename "$file")"
done

# ---------------------------------------------------------------------------
# 2. Squirrel feeds: Windows clients only read them once a manifest says so.
# ---------------------------------------------------------------------------

publish_squirrel_feed "$FEED"
if [ "$CROSS_PUBLISH" = "true" ]; then
  publish_squirrel_feed preview
fi

# ---------------------------------------------------------------------------
# 3. Website download slots.
# ---------------------------------------------------------------------------

# Copy DMGs to the appropriate slot (latest/ or preview/)
for ARCH in arm64 x64; do
  az storage blob copy start \
    --account-name "$ACCOUNT" \
    --destination-container "$CONTAINER" \
    --destination-blob "${SLOT}/Clubhouse-${SLOT}-darwin-${ARCH}.dmg" \
    --source-uri "https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/artifacts/Clubhouse-${VERSION}-darwin-${ARCH}.dmg" \
    --auth-mode login
done

# Copy Windows installers to the appropriate slot
for WIN_ARCH in x64 arm64; do
  az storage blob copy start \
    --account-name "$ACCOUNT" \
    --destination-container "$CONTAINER" \
    --destination-blob "${SLOT}/Clubhouse-${SLOT}-win32-${WIN_ARCH}-Setup.exe" \
    --source-uri "https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/artifacts/Clubhouse-${VERSION}-win32-${WIN_ARCH}-Setup.exe" \
    --auth-mode login
done

# Copy Linux packages to the appropriate slot
for LINUX_ARCH in x64; do
  for EXT in deb rpm; do
    SRC_BLOB="artifacts/Clubhouse-${VERSION}-linux-${LINUX_ARCH}.${EXT}"
    DEST_BLOB="${SLOT}/Clubhouse-${SLOT}-linux-${LINUX_ARCH}.${EXT}"
    # Only copy if the source artifact exists
    EXISTS=$(az storage blob exists \
      --account-name "$ACCOUNT" \
      --container-name "$CONTAINER" \
      --name "$SRC_BLOB" \
      --auth-mode login \
      --query "exists" --output tsv)
    if [ "$EXISTS" = "true" ]; then
      az storage blob copy start \
        --account-name "$ACCOUNT" \
        --destination-container "$CONTAINER" \
        --destination-blob "$DEST_BLOB" \
        --source-uri "https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${SRC_BLOB}" \
        --auth-mode login
    fi
  done
done

# Wait for copies to complete
SLOT_BLOBS=(
  "${SLOT}/Clubhouse-${SLOT}-darwin-arm64.dmg"
  "${SLOT}/Clubhouse-${SLOT}-darwin-x64.dmg"
  "${SLOT}/Clubhouse-${SLOT}-win32-x64-Setup.exe"
  "${SLOT}/Clubhouse-${SLOT}-win32-arm64-Setup.exe"
)

# Add Linux blobs to wait list if they were uploaded
for LINUX_ARCH in x64; do
  for EXT in deb rpm; do
    BLOB="${SLOT}/Clubhouse-${SLOT}-linux-${LINUX_ARCH}.${EXT}"
    EXISTS=$(az storage blob exists \
      --account-name "$ACCOUNT" \
      --container-name "$CONTAINER" \
      --name "$BLOB" \
      --auth-mode login \
      --query "exists" --output tsv 2>/dev/null)
    if [ "$EXISTS" = "true" ]; then
      SLOT_BLOBS+=("$BLOB")
    fi
  done
done
for BLOB in "${SLOT_BLOBS[@]}"; do
  while true; do
    STATUS=$(az storage blob show \
      --account-name "$ACCOUNT" \
      --container-name "$CONTAINER" \
      --name "$BLOB" \
      --query "properties.copy.status" \
      --output tsv \
      --auth-mode login)
    if [ "$STATUS" = "success" ]; then
      echo "Copy complete: $BLOB"
      break
    elif [ "$STATUS" = "failed" ] || [ "$STATUS" = "aborted" ]; then
      echo "::error::Blob copy failed for $BLOB"
      exit 1
    fi
    sleep 2
  done
done

# ---------------------------------------------------------------------------
# 4. GitHub release: no updater reads it.
# ---------------------------------------------------------------------------

RELEASE_TITLE="v${VERSION} — ${RELEASE_MESSAGE}"
RELEASE_BODY="$RELEASE_NOTES"

PRERELEASE_FLAG=""
MANIFEST_FILE="artifacts/latest.json"
if [ "$IS_PREVIEW" = "true" ]; then
  PRERELEASE_FLAG="--prerelease"
  MANIFEST_FILE="artifacts/preview.json"
fi

ASSETS=()
for file in artifacts/Clubhouse-*.zip artifacts/Clubhouse-*.dmg artifacts/Clubhouse-*.exe artifacts/Clubhouse-*.deb artifacts/Clubhouse-*.rpm; do
  [ -f "$file" ] || continue
  ASSETS+=("$file")
done
ASSETS+=("$MANIFEST_FILE")

if gh release view "v${VERSION}" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then
  gh release upload "v${VERSION}" --repo "$GITHUB_REPOSITORY" --clobber "${ASSETS[@]}"
else
  # shellcheck disable=SC2086
  gh release create "v${VERSION}" \
    --repo "$GITHUB_REPOSITORY" \
    --title "${RELEASE_TITLE}" \
    --notes "${RELEASE_BODY}" \
    $PRERELEASE_FLAG \
    "${ASSETS[@]}"
fi

# ---------------------------------------------------------------------------
# 5. History, then manifests. The v2 manifest goes last: it's what clients read.
# ---------------------------------------------------------------------------

if [ "$IS_PREVIEW" = "true" ]; then
  # Seed v2/latest.json from the legacy path if it doesn't exist yet.
  # This is needed because no stable release may have shipped since the
  # v2 migration, and clients check both manifests in parallel.
  EXISTS=$(az storage blob exists \
    --account-name "$ACCOUNT" \
    --container-name "$CONTAINER" \
    --name "updates/v2/latest.json" \
    --auth-mode login \
    --query "exists" --output tsv)
  if [ "$EXISTS" != "true" ]; then
    echo "Seeding v2/latest.json from legacy latest.json"
    az storage blob copy start \
      --account-name "$ACCOUNT" \
      --destination-container "$CONTAINER" \
      --destination-blob "updates/v2/latest.json" \
      --source-uri "https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/updates/latest.json" \
      --auth-mode login
  fi

  # Dual-publish to legacy path so clients on old URLs can bridge
  # to this version, which knows how to check v2 paths.
  # Remove this once legacy paths are pinned with static message (#458).
  upload_mutable artifacts/preview.json "updates/preview.json" application/json

  upload_mutable artifacts/preview.json "updates/v2/preview.json" application/json
else
  # The client hides versions newer than itself, so history can go first.
  upload_mutable artifacts/history.json "updates/v2/history.json" application/json
  upload_mutable artifacts/history.json "updates/history.json" application/json

  # Dual-publish to legacy paths so clients on old URLs can bridge
  # to this version, which knows how to check v2 paths.
  # Remove this once legacy paths are pinned with static message (#458).
  upload_mutable artifacts/latest.json "updates/latest.json" application/json

  upload_mutable artifacts/latest.json "updates/v2/latest.json" application/json
fi
