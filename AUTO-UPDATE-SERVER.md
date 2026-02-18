# Auto-Update Server Requirements

This document describes the server-side infrastructure, API contract, and artifact
hosting required for Clubhouse's in-app automatic update system.

---

## Overview

The Clubhouse app checks for updates by fetching a static JSON manifest from a known URL.
If a newer version is found, it silently downloads the platform-appropriate artifact,
verifies its SHA-256 checksum, and prompts the user to restart.

No authentication is required for update checks or downloads.

---

## 1. JSON Manifest (`latest.json`)

The app fetches a single endpoint to determine whether a new version is available.

### URL

```
GET https://<update-host>/updates/latest.json
```

For example: `https://clubhouse-releases.blob.core.windows.net/updates/latest.json`

### Schema

```jsonc
{
  "version": "0.26.0",
  "releaseDate": "2026-02-17T00:00:00Z",
  "releaseNotes": "Bug fixes and performance improvements.",
  "mandatory": false,
  "artifacts": {
    "darwin-arm64": {
      "url": "https://clubhouse-releases.blob.core.windows.net/artifacts/Clubhouse-0.26.0-darwin-arm64.zip",
      "sha256": "a1b2c3d4e5f6...64-char-hex-digest",
      "size": 98000000
    },
    "darwin-x64": {
      "url": "https://clubhouse-releases.blob.core.windows.net/artifacts/Clubhouse-0.26.0-darwin-x64.zip",
      "sha256": "f6e5d4c3b2a1...64-char-hex-digest",
      "size": 102000000
    },
    "win32-x64": {
      "url": "https://clubhouse-releases.blob.core.windows.net/artifacts/Clubhouse-0.26.0-win32-x64-setup.exe",
      "sha256": "1a2b3c4d5e6f...64-char-hex-digest",
      "size": 85000000
    },
    "linux-x64": {
      "url": "https://clubhouse-releases.blob.core.windows.net/artifacts/clubhouse_0.26.0_amd64.deb",
      "sha256": "6f5e4d3c2b1a...64-char-hex-digest",
      "size": 78000000
    }
  }
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `string` | Yes | Semver version string (e.g., `"0.26.0"`) |
| `releaseDate` | `string` | Yes | ISO 8601 date of the release |
| `releaseNotes` | `string` | No | Brief description shown to the user |
| `mandatory` | `boolean` | No | If `true`, the app will auto-restart after download (future use) |
| `artifacts` | `object` | Yes | Keyed by `{platform}-{arch}` identifier |
| `artifacts.*.url` | `string` | Yes | Direct download URL for the artifact |
| `artifacts.*.sha256` | `string` | Yes | Hex-encoded SHA-256 digest of the file |
| `artifacts.*.size` | `number` | No | File size in bytes (for progress display) |

### Platform Keys

The app constructs its key as `${process.platform}-${process.arch}`:

| Key | Platform |
|-----|----------|
| `darwin-arm64` | macOS Apple Silicon |
| `darwin-x64` | macOS Intel |
| `win32-x64` | Windows 64-bit |
| `linux-x64` | Linux 64-bit |

---

## 2. Artifact Formats

### macOS (`darwin-*`)

**Format:** ZIP archive containing the signed `.app` bundle.

The ZIP is the standard format for Electron auto-updates on macOS. It contains:
```
Clubhouse.app/
  Contents/
    MacOS/
    Resources/
    Info.plist
    ...
```

**How updates are applied:**
1. Download ZIP to a temp directory
2. Verify SHA-256 checksum
3. Extract the `.app` bundle
4. On restart: move the new `.app` to the install location (typically `/Applications/Clubhouse.app`), then relaunch

**Generating the artifact:**
```bash
# electron-forge already produces this:
npm run make
# Output: out/make/zip/darwin/arm64/Clubhouse-darwin-arm64-0.26.0.zip
```

### Windows (`win32-x64`)

**Format:** Squirrel installer (`.exe`) or NSIS setup.

The current forge config uses `MakerSquirrel` which produces a Squirrel-based installer.
Squirrel handles incremental updates natively:
- The installer can be run silently with `--update` flag
- It replaces the app in `%LOCALAPPDATA%\Clubhouse\` and relaunches

**Generating the artifact:**
```bash
npm run make  # on Windows
# Output: out/make/squirrel.windows/x64/ClubhouseSetup.exe
```

### Linux (`linux-x64`)

**Format:** `.deb` package (primary) or `.AppImage`.

For `.deb` packages, the update flow is:
1. Download the new `.deb` file
2. On restart: run `sudo dpkg -i <file>` (requires elevated privileges)
3. Relaunch from the installed path

**Note:** Linux auto-updates are harder because they often require `sudo`. A common
alternative is to distribute an AppImage with built-in update support. For the initial
implementation, Linux updates will show a "Download" button that opens the website
instead of auto-applying.

---

## 3. Azure Blob Storage Setup

### Container Structure

```
clubhouse-releases (Storage Account)
  updates/
    latest.json          <- manifest (overwritten each release)
  artifacts/
    Clubhouse-0.25.0-darwin-arm64.zip
    Clubhouse-0.25.0-darwin-x64.zip
    Clubhouse-0.25.0-win32-x64-setup.exe
    clubhouse_0.25.0_amd64.deb
    Clubhouse-0.26.0-darwin-arm64.zip
    ...                  <- keep old versions for rollback
```

### Access Configuration

- **Container access level:** Blob (anonymous read for blobs)
- **Authentication:** None required for downloads (public read)
- **CORS:** Not needed (Electron's `net` module bypasses browser CORS)
- **CDN (optional):** Place Azure CDN in front for global edge caching
  - Suggested cache TTL for `latest.json`: 5 minutes (short for fast rollouts)
  - Suggested cache TTL for artifacts: 1 year (immutable, versioned filenames)

### Upload Script (CI/CD)

```bash
#!/bin/bash
# publish-release.sh — run from CI after `npm run make`
VERSION=$(node -p "require('./package.json').version")
PLATFORM="darwin"
ARCH="arm64"

ARTIFACT="out/make/zip/${PLATFORM}/${ARCH}/Clubhouse-${PLATFORM}-${ARCH}-${VERSION}.zip"
SHA256=$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')
SIZE=$(stat -f%z "$ARTIFACT")

# Upload artifact
az storage blob upload \
  --container-name clubhouse-releases \
  --name "artifacts/Clubhouse-${VERSION}-${PLATFORM}-${ARCH}.zip" \
  --file "$ARTIFACT" \
  --content-type application/zip

# Generate and upload manifest
cat > /tmp/latest.json <<EOF
{
  "version": "${VERSION}",
  "releaseDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "releaseNotes": "",
  "mandatory": false,
  "artifacts": {
    "${PLATFORM}-${ARCH}": {
      "url": "https://clubhouse-releases.blob.core.windows.net/artifacts/Clubhouse-${VERSION}-${PLATFORM}-${ARCH}.zip",
      "sha256": "${SHA256}",
      "size": ${SIZE}
    }
  }
}
EOF

az storage blob upload \
  --container-name clubhouse-releases \
  --name "updates/latest.json" \
  --file /tmp/latest.json \
  --content-type application/json \
  --overwrite
```

In practice you'd build for all platforms and merge the artifacts into a single `latest.json`.

---

## 4. Code Signing & Notarization

### macOS

macOS Gatekeeper will block unsigned apps. For distribution outside the Mac App Store:

1. **Apple Developer ID** — Enroll in the Apple Developer Program ($99/year)
2. **Developer ID Application certificate** — Create in Xcode or developer.apple.com
3. **Sign the app:**
   ```bash
   # electron-forge handles this via osxSign in forge.config.ts
   # Update the config from ad-hoc to real signing:
   osxSign: {
     identity: 'Developer ID Application: Your Name (TEAMID)',
     optionsForFile: () => ({
       entitlements: path.resolve(__dirname, 'entitlements.plist'),
       'entitlements-inherit': path.resolve(__dirname, 'entitlements.plist'),
     }),
   },
   ```
4. **Notarize the app** — Submit to Apple's notary service:
   ```bash
   # Add to forge.config.ts:
   osxNotarize: {
     appleId: process.env.APPLE_ID,
     appleIdPassword: process.env.APPLE_ID_PASSWORD,
     teamId: process.env.APPLE_TEAM_ID,
   },
   ```
5. **Staple the notarization ticket** — electron-forge does this automatically

The auto-update client does NOT need to verify the signature itself — macOS Gatekeeper
handles this when the `.app` is launched. If the downloaded app isn't signed/notarized,
macOS will show a warning dialog.

### Windows

Windows SmartScreen will warn on unsigned executables:

1. **EV Code Signing Certificate** — Purchase from a CA (DigiCert, Sectigo, etc.)
2. **Sign during build:**
   ```typescript
   // forge.config.ts MakerSquirrel options
   new MakerSquirrel({
     certificateFile: process.env.WIN_CERT_FILE,
     certificatePassword: process.env.WIN_CERT_PASSWORD,
   })
   ```
3. SmartScreen reputation builds over time with signed binaries

### Linux

Linux doesn't have a system-level code signing requirement. Package managers may verify
GPG signatures if you set up a PPA/repo, but for direct downloads it's optional.

---

## 5. Version Comparison

The app uses **semver** comparison. A new version is available when the manifest version
is strictly greater than `app.getVersion()` (which reads from `package.json`).

Comparison is done with a simple semver parser — no external dependency needed:
```typescript
// "0.26.0" > "0.25.0" → true
// "0.25.0" > "0.25.0" → false
// "1.0.0"  > "0.25.0" → true
```

---

## 6. Alternative: GitHub Releases

Instead of Azure Blob, you could use GitHub Releases as the artifact host:

**Pros:**
- Free hosting (up to 2GB per file)
- Built-in versioning via git tags
- Download URLs are stable: `https://github.com/<owner>/<repo>/releases/download/v0.26.0/Clubhouse-darwin-arm64.zip`
- No infrastructure to manage

**Cons:**
- Rate-limited: 60 requests/hour unauthenticated, 5,000 authenticated
- No CDN — downloads come from GitHub's servers (slower globally)
- No staged rollouts or feature flags
- Tied to GitHub availability

**Hybrid approach:** Use GitHub Releases for the public website download button,
and a `latest.json` manifest (hosted anywhere — even GitHub Pages) for the in-app
auto-update check. The manifest can point to GitHub Release download URLs.

---

## 7. Update Flow Summary

```
App Startup / Every 4 Hours
         │
         ▼
  GET /updates/latest.json
         │
         ▼
  Compare version to app.getVersion()
         │
    ┌────┴────┐
    │ Same    │ Newer
    │         │
    ▼         ▼
  (idle)   Download artifact
              │
              ▼
         Verify SHA-256
              │
              ▼
         Store in temp dir
              │
              ▼
         Show blue info bar:
         "Update v0.26.0 ready — Restart to apply"
              │
              ▼
         User clicks Restart
              │
              ▼
         Warn if agents running → confirm
              │
              ▼
         Kill PTY sessions, restore configs
              │
              ▼
         Replace .app with new version
              │
              ▼
         Relaunch app
```

---

## 8. Configuration

The app stores update settings in `~/.clubhouse/update-settings.json`:

```json
{
  "autoUpdate": true,
  "lastCheck": "2026-02-17T12:00:00Z",
  "dismissedVersion": null
}
```

| Field | Description |
|-------|-------------|
| `autoUpdate` | Whether to check for updates automatically |
| `lastCheck` | ISO timestamp of last successful check |
| `dismissedVersion` | If user dismisses an update, don't re-prompt for this version |

The update endpoint URL is compiled into the app (not user-configurable for security).
