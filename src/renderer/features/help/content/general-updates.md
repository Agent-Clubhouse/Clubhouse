# Updates

Clubhouse checks for updates automatically and applies them with minimal disruption.

## How it works

1. **Check.** On startup, after 30 seconds, and every 4 hours, while **Automatic updates** is on in **Settings > Updates**. **Check now** works with it off.
2. **Download.** In the background, with SHA-256 verification.
3. **Notify.** In the new layout, an **Update ready** card in the sidebar offers **Restart**, **Download manually** and **Later**. In the classic layout, a banner offers **Restart to update**.
4. **Apply.** If agents are running, the **Update ready** dialog asks before **Restart now**.

A downloaded update stays ready, even when a later check fails or a newer version can't be downloaded. An update whose build needs a newer version of your operating system is skipped, and Clubhouse stays on the version it has.

In the update dialog, **Interrupt** ends the current turn. After restart, only the conversation resumes, not the interrupted turn. **Stop now** ends the agent and prevents it from resuming after restart. Each action shows progress and reports a failure or timeout. If interrupt takes too long, choose **Stop now**. Restart stays unavailable until agents are idle and pending actions are resolved.

Cancelling the dialog does not undo a stop. If you wake that agent before updating later, its new conversation can resume normally.

## After updating

A **What's new** dialog shows release notes on first launch after an update. View past release notes anytime in **Settings > What's new**.

## Update settings

Found in **Settings > Updates**:

| Setting | Description |
|---------|-------------|
| **Automatic updates** | Check every 4 hours and download in the background |
| **Preview versions** | Get upcoming features early, before they're released |
| **Status** | **Up to date**, **Checking…**, **Downloading…**, **Update ready** or **Update failed**, with **Check now** to check straight away |
| **Last checked** | When the last check finished. After a failed check it says **Couldn't check** and why. |
| **Download manually** | Shown when an update is ready or failed, to download it yourself |

## Architecture

**Settings > About** shows your app version and architecture (arm64 or x64). If running under Rosetta on Apple Silicon, a notice recommends switching to the native arm64 build for better performance.
