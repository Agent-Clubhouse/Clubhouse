# Updates

Clubhouse checks for updates automatically and applies them with minimal disruption.

## How It Works

1. **Check** — On startup (after 30s) and every 4 hours. Toggle auto-check in **Settings > Updates**.
2. **Download** — Happens in the background with SHA-256 verification.
3. **Notify** — A blue banner shows the new version. Click **Restart to update** or dismiss.
4. **Apply** — If agents are running, a confirmation dialog warns before restarting.

## After Updating

A **What's New** dialog shows release notes on first launch after an update. View past release notes anytime in **Settings > What's New**.

## Update Settings

Found in **Settings > Updates**:

| Setting | Description |
|---------|-------------|
| **Auto-update toggle** | Enable/disable background checking |
| **Status** | Current state: up to date, checking, downloading, ready, or error |
| **Check now** | Trigger an immediate check |
| **Last checked** | Timestamp of most recent check |

## Architecture

**Settings > About** shows your app version and architecture (arm64 or x64). If running under Rosetta on Apple Silicon, a notice recommends switching to the native arm64 build for better performance.
