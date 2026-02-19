# Updates

Clubhouse includes a built-in update system that checks for new versions, downloads them in the background, and applies them with minimal disruption to your workflow.

## Automatic Update Checking

When automatic updates are enabled (the default), Clubhouse checks for new versions:

- **On startup** -- After a 30-second delay to let the app settle.
- **Periodically** -- Every 4 hours while the app is running.

Automatic checking can be toggled on or off in **Settings > Updates**.

## Update Available Banner

When a newer version is detected, a blue info banner appears at the top of the window. The banner displays:

- The new version number (for example, "Update v0.28.0 is ready").
- An optional release message from the developer, if one is included with the release.

The banner provides two actions:

- **Restart to update** -- Applies the update immediately (see below).
- **Dismiss (x)** -- Hides the banner for this session.

## Download and Verification

When an update is found, Clubhouse automatically downloads the appropriate artifact for your platform and architecture. During the download:

- A **progress percentage** is tracked and shown in the Settings > Updates status area.
- If the file has already been downloaded from a previous check, Clubhouse verifies it before skipping the download.

After the download completes, the file is verified using a **SHA-256 checksum** to ensure integrity. If verification fails, the file is deleted and the download is retried on the next check.

## Applying an Update

Click **Restart to update** in the banner to apply the downloaded update. If any agents are currently running, a confirmation dialog appears:

- The dialog shows how many agents are running and warns that they will be stopped.
- You can choose **Restart anyway** to proceed or **Cancel** to go back.

On macOS, the update extracts the new application bundle, replaces the current one, and relaunches. On Windows, the installer runs automatically. On Linux, the app relaunches and expects a manual install.

## Dismissing a Version

If you dismiss the update banner using the **x** button, the banner hides for the current session. The update remains available and the banner reappears the next time the state transitions to "ready" (for example, on the next app launch).

To skip a specific version entirely so it does not prompt you again, the dismissed version is tracked in update settings. A manually triggered check clears any previously dismissed version.

## What's New Dialog

After an update is installed and Clubhouse relaunches, a **"What's New"** dialog appears automatically. This dialog shows:

- The newly installed version number in the header.
- Release notes rendered as formatted text.

Click **Got it** or press `Escape` to dismiss the dialog. The dialog only appears once per upgrade -- it does not show on fresh installs or when the version has not changed.

## What's New Settings Page

Navigate to **Settings > What's New** to view a complete history of recent release notes. This page shows release notes for versions up to your current build, including any versions you may have skipped. The history covers up to 5 versions or 3 months, whichever is fewer.

Each version is displayed with its release title as a heading, followed by the full release notes, and separated by a horizontal rule from the next version. Versions are ordered newest-first so the most recent changes appear at the top.

## Update Settings

Navigate to **Settings > Updates** to manage update behavior. The settings page provides:

| Setting | Description |
|---------|-------------|
| **Automatic updates** toggle | Enable or disable background update checking (every 4 hours). |
| **Status** | Shows the current update state: Up to date, Checking, Downloading (with progress percentage), Update ready (with version), or Error (with details). |
| **Check now** button | Manually trigger an update check at any time, regardless of the auto-update setting. |
| **Last checked** | Displays the timestamp of the most recent update check. |

## Architecture Information

The **Settings > About** page displays your current app version along with architecture details:

- **Architecture**: Shows whether the app is running as `arm64` (native Apple Silicon) or `x64`.
- **Rosetta indicator**: If the app is running under Rosetta translation on Apple Silicon hardware, a notice appears recommending the native arm64 build for better performance.

This information is helpful for diagnosing performance issues. If you are on an Apple Silicon Mac and see the Rosetta indicator, switching to the arm64 build of Clubhouse improves performance.
