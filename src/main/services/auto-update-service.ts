import { app, BrowserWindow } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPC } from '../../shared/ipc-channels';
import { UpdateSettings, UpdateStatus, UpdateState, UpdateManifest, UpdateArtifact, PendingReleaseNotes, VersionHistoryEntry, VersionHistory } from '../../shared/types';
import { createSettingsStore } from './settings-store';
import { appLog } from './log-service';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UPDATE_URL = 'https://stclubhousereleases.blob.core.windows.net/releases/updates/latest.json';
const PREVIEW_UPDATE_URL = 'https://stclubhousereleases.blob.core.windows.net/releases/updates/preview.json';
const HISTORY_URL = 'https://stclubhousereleases.blob.core.windows.net/releases/updates/history.json';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_HISTORY_VERSIONS = 5;
const MAX_HISTORY_MONTHS = 3;

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

const settingsStore = createSettingsStore<UpdateSettings>('update-settings.json', {
  autoUpdate: true,
  previewChannel: false,
  lastCheck: null,
  dismissedVersion: null,
  lastSeenVersion: null,
});

export const getSettings = settingsStore.get;
export const saveSettings = settingsStore.save;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let status: UpdateStatus = {
  state: 'idle',
  availableVersion: null,
  releaseNotes: null,
  releaseMessage: null,
  downloadProgress: 0,
  error: null,
  downloadPath: null,
};

let checkTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Parse a version string, separating the numeric parts from an optional
 * pre-release suffix (e.g. "rc").  "1.2.3rc" → { parts: [1,2,3], rc: true }
 */
export function parseVersion(v: string): { parts: number[]; rc: boolean } {
  const rc = v.endsWith('rc');
  const base = rc ? v.slice(0, -2) : v;
  return { parts: base.split('.').map(Number), rc };
}

/**
 * Semver comparison that understands the `rc` suffix.
 * Returns true if a > b.
 *
 * Rules:
 * - Numeric parts are compared left-to-right (major.minor.patch).
 * - When the numeric parts are equal, the stable release (no suffix) is
 *   considered newer than the rc pre-release: 1.0.0 > 1.0.0rc.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const na = va.parts[i] || 0;
    const nb = vb.parts[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  // Base versions are equal — stable beats rc
  if (!va.rc && vb.rc) return true;
  return false;
}

function broadcastStatus(): void {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    try {
      win.webContents.send(IPC.APP.UPDATE_STATUS_CHANGED, { ...status });
    } catch {
      // Window may be destroyed
    }
  }
}

function setState(state: UpdateState, patch?: Partial<UpdateStatus>): void {
  status = { ...status, state, ...patch };
  broadcastStatus();
}

function fetchJSON<T = UpdateManifest>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function downloadFile(
  url: string,
  destPath: string,
  expectedSize: number | undefined,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 300_000 }, (res) => {
      // Follow redirects (Azure CDN may redirect)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, destPath, expectedSize, onProgress)
          .then(resolve)
          .catch(reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const totalSize = expectedSize || parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const file = fs.createWriteStream(destPath);

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (totalSize > 0) {
          onProgress(Math.min(99, Math.round((downloadedBytes / totalSize) * 100)));
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        onProgress(100);
        resolve();
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

export function verifySHA256(filePath: string, expectedHash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      resolve(actual === expectedHash);
    });
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Core update flow
// ---------------------------------------------------------------------------

/**
 * Fetch the best available manifest.  When the preview channel is enabled we
 * fetch both the stable and preview manifests and pick whichever reports the
 * newer version (stable wins on a tie).
 */
async function fetchBestManifest(previewChannel: boolean): Promise<UpdateManifest> {
  if (!previewChannel) {
    return fetchJSON(UPDATE_URL);
  }

  // Fetch both in parallel; preview may not exist yet so we tolerate failure.
  const [stable, preview] = await Promise.all([
    fetchJSON(UPDATE_URL),
    fetchJSON(PREVIEW_UPDATE_URL).catch(() => null as UpdateManifest | null),
  ]);

  if (!preview) return stable;

  // Pick whichever is newer. isNewerVersion handles rc suffixes and
  // considers a stable release newer than its rc counterpart.
  if (isNewerVersion(preview.version, stable.version)) {
    return preview;
  }
  return stable;
}

export async function checkForUpdates(manual = false): Promise<UpdateStatus> {
  if (status.state === 'downloading') {
    return status;
  }

  const settings = getSettings();
  if (!manual && !settings.autoUpdate) {
    return status;
  }

  setState('checking');
  appLog('update:check', 'info', 'Checking for updates', {
    meta: { manual, currentVersion: app.getVersion(), previewChannel: settings.previewChannel },
  });

  try {
    const manifest = await fetchBestManifest(settings.previewChannel);
    const currentVersion = app.getVersion();

    if (!isNewerVersion(manifest.version, currentVersion)) {
      appLog('update:check', 'info', 'App is up to date', {
        meta: { currentVersion, latestVersion: manifest.version },
      });
      setState('idle');
      saveSettings({ ...settings, lastCheck: new Date().toISOString() });
      return status;
    }

    // Check if user dismissed this version
    if (!manual && settings.dismissedVersion === manifest.version) {
      appLog('update:check', 'info', 'Update dismissed by user', {
        meta: { version: manifest.version },
      });
      setState('idle');
      saveSettings({ ...settings, lastCheck: new Date().toISOString() });
      return status;
    }

    const key = platformKey();
    const artifact = manifest.artifacts[key];
    if (!artifact) {
      appLog('update:check', 'warn', `No artifact for platform ${key}`, {
        meta: { version: manifest.version, availableKeys: Object.keys(manifest.artifacts) },
      });
      setState('idle');
      return status;
    }

    appLog('update:check', 'info', `Update available: ${manifest.version}`, {
      meta: { currentVersion, newVersion: manifest.version },
    });

    // Start download
    saveSettings({ ...settings, lastCheck: new Date().toISOString(), dismissedVersion: null });
    await downloadUpdate(manifest.version, manifest.releaseNotes || null, manifest.releaseMessage || null, artifact);

    return status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appLog('update:check', 'error', `Update check failed: ${msg}`);
    setState('error', { error: msg });
    return status;
  }
}

async function downloadUpdate(
  version: string,
  releaseNotes: string | null,
  releaseMessage: string | null,
  artifact: UpdateArtifact,
): Promise<void> {
  const tmpDir = path.join(app.getPath('temp'), 'clubhouse-updates');
  fs.mkdirSync(tmpDir, { recursive: true });

  const ext = path.extname(new URL(artifact.url).pathname) || '.zip';
  const destPath = path.join(tmpDir, `Clubhouse-${version}${ext}`);

  // Skip download if file already exists and hash matches
  if (fs.existsSync(destPath)) {
    try {
      const valid = await verifySHA256(destPath, artifact.sha256);
      if (valid) {
        appLog('update:download', 'info', 'Update already downloaded and verified');
        writePendingUpdateInfo({ version, downloadPath: destPath, releaseNotes, releaseMessage });
        setState('ready', {
          availableVersion: version,
          releaseNotes,
          releaseMessage,
          downloadProgress: 100,
          downloadPath: destPath,
          error: null,
        });
        return;
      }
    } catch {
      // Re-download if verification fails
    }
    fs.unlinkSync(destPath);
  }

  setState('downloading', {
    availableVersion: version,
    releaseNotes,
    releaseMessage,
    downloadProgress: 0,
    error: null,
  });

  try {
    await downloadFile(artifact.url, destPath, artifact.size, (percent) => {
      status = { ...status, downloadProgress: percent };
      broadcastStatus();
    });

    appLog('update:download', 'info', 'Download complete, verifying checksum');

    const valid = await verifySHA256(destPath, artifact.sha256);
    if (!valid) {
      fs.unlinkSync(destPath);
      throw new Error('SHA-256 checksum verification failed');
    }

    appLog('update:download', 'info', 'Update verified and ready to install');
    writePendingUpdateInfo({ version, downloadPath: destPath, releaseNotes, releaseMessage });
    setState('ready', {
      downloadProgress: 100,
      downloadPath: destPath,
      error: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appLog('update:download', 'error', `Download failed: ${msg}`);
    setState('error', { error: msg, downloadProgress: 0 });
  }
}

// ---------------------------------------------------------------------------
// Apply update (quit, replace, relaunch)
// ---------------------------------------------------------------------------

export async function applyUpdate(): Promise<void> {
  if (status.state !== 'ready' || !status.downloadPath) {
    throw new Error('No update ready to apply');
  }

  const downloadPath = status.downloadPath!;

  // Persist release notes for the What's New dialog after restart
  if (status.availableVersion && status.releaseNotes) {
    writePendingReleaseNotes({
      version: status.availableVersion,
      releaseNotes: status.releaseNotes,
    });
  }

  clearPendingUpdateInfo();

  appLog('update:apply', 'info', 'Applying update', {
    meta: { version: status.availableVersion, downloadPath },
  });

  setState('idle', {
    availableVersion: null,
    releaseNotes: null,
    releaseMessage: null,
    downloadProgress: 0,
    downloadPath: null,
    error: null,
  });

  if (process.platform === 'darwin') {
    try {
      const appPath = app.getPath('exe');
      // The exe path is like /Applications/Clubhouse.app/Contents/MacOS/Clubhouse
      // We need /Applications/Clubhouse.app
      const appBundlePath = appPath.replace(/\/Contents\/MacOS\/.*$/, '');

      if (appBundlePath.endsWith('.app') && fs.existsSync(downloadPath)) {
        const { execSync } = require('child_process');
        const tmpExtract = path.join(app.getPath('temp'), 'clubhouse-update-extract');

        // Clean up any previous extract
        if (fs.existsSync(tmpExtract)) {
          fs.rmSync(tmpExtract, { recursive: true, force: true });
        }
        fs.mkdirSync(tmpExtract, { recursive: true });

        // Extract ZIP
        execSync(`unzip -o -q "${downloadPath}" -d "${tmpExtract}"`, { timeout: 60_000 });

        // Find the .app inside
        const extracted = fs.readdirSync(tmpExtract).find((f) => f.endsWith('.app'));
        if (!extracted) throw new Error('No .app found in update archive');

        const newAppPath = path.join(tmpExtract, extracted);

        // Replace: remove old, move new
        // Use a small shell script that runs after the app quits
        const script = path.join(app.getPath('temp'), 'clubhouse-update.sh');
        fs.writeFileSync(script, [
          '#!/bin/bash',
          'sleep 1',
          `rm -rf "${appBundlePath}"`,
          `mv "${newAppPath}" "${appBundlePath}"`,
          `open "${appBundlePath}"`,
          `rm -rf "${tmpExtract}"`,
          `rm -f "${downloadPath}"`,
          `rm -f "${script}"`,
        ].join('\n'), { mode: 0o755 });

        const { spawn } = require('child_process');
        spawn('bash', [script], { detached: true, stdio: 'ignore' }).unref();

        app.exit(0);
        return;
      }
    } catch (err) {
      appLog('update:apply', 'error', `Failed to apply update: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  } else if (process.platform === 'win32') {
    // On Windows, re-run the Squirrel Setup.exe to update in-place.
    // --silent skips the animated installer UI for a seamless auto-update.
    try {
      if (fs.existsSync(downloadPath)) {
        const { spawn } = require('child_process');
        spawn(downloadPath, ['--silent'], { detached: true, stdio: 'ignore' }).unref();
        app.exit(0);
        return;
      }
    } catch (err) {
      appLog('update:apply', 'error', `Failed to apply Windows update: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  // Linux / fallback: just relaunch (manual install expected)
  app.relaunch();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Apply update silently on quit (no relaunch)
// ---------------------------------------------------------------------------

export function applyUpdateOnQuit(): void {
  if (status.state !== 'ready' || !status.downloadPath) {
    return; // No update ready — nothing to do
  }

  const downloadPath = status.downloadPath;

  // Persist release notes for the What's New dialog after next launch
  if (status.availableVersion && status.releaseNotes) {
    writePendingReleaseNotes({
      version: status.availableVersion,
      releaseNotes: status.releaseNotes,
    });
  }

  clearPendingUpdateInfo();

  appLog('update:apply-on-quit', 'info', 'Applying update on quit (silent)', {
    meta: { version: status.availableVersion, downloadPath },
  });

  if (process.platform === 'darwin') {
    try {
      const appPath = app.getPath('exe');
      const appBundlePath = appPath.replace(/\/Contents\/MacOS\/.*$/, '');

      if (appBundlePath.endsWith('.app') && fs.existsSync(downloadPath)) {
        const { execSync } = require('child_process');
        const tmpExtract = path.join(app.getPath('temp'), 'clubhouse-update-extract');

        if (fs.existsSync(tmpExtract)) {
          fs.rmSync(tmpExtract, { recursive: true, force: true });
        }
        fs.mkdirSync(tmpExtract, { recursive: true });

        execSync(`unzip -o -q "${downloadPath}" -d "${tmpExtract}"`, { timeout: 60_000 });

        const extracted = fs.readdirSync(tmpExtract).find((f) => f.endsWith('.app'));
        if (!extracted) throw new Error('No .app found in update archive');

        const newAppPath = path.join(tmpExtract, extracted);

        // Shell script replaces the app bundle after quit — NO relaunch
        const script = path.join(app.getPath('temp'), 'clubhouse-update.sh');
        fs.writeFileSync(script, [
          '#!/bin/bash',
          'sleep 1',
          `rm -rf "${appBundlePath}"`,
          `mv "${newAppPath}" "${appBundlePath}"`,
          `rm -rf "${tmpExtract}"`,
          `rm -f "${downloadPath}"`,
          `rm -f "${script}"`,
        ].join('\n'), { mode: 0o755 });

        const { spawn } = require('child_process');
        spawn('bash', [script], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (err) {
      appLog('update:apply-on-quit', 'error', `Failed to apply update on quit: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (process.platform === 'win32') {
    try {
      if (fs.existsSync(downloadPath)) {
        const { spawn } = require('child_process');
        spawn(downloadPath, ['--update'], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (err) {
      appLog('update:apply-on-quit', 'error', `Failed to apply Windows update on quit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Linux: no-op — manual install expected
}

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

export function dismissUpdate(): void {
  if (status.availableVersion) {
    const settings = getSettings();
    saveSettings({ ...settings, dismissedVersion: status.availableVersion });
  }
  setState('idle', {
    availableVersion: null,
    releaseNotes: null,
    releaseMessage: null,
    downloadProgress: 0,
    downloadPath: null,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Pending update info (persisted so banner shows immediately on next launch)
// ---------------------------------------------------------------------------

interface PendingUpdateInfo {
  version: string;
  downloadPath: string;
  releaseNotes: string | null;
  releaseMessage: string | null;
}

function pendingUpdateInfoPath(): string {
  return path.join(app.getPath('userData'), 'pending-update-info.json');
}

export function writePendingUpdateInfo(info: PendingUpdateInfo): void {
  try {
    fs.writeFileSync(pendingUpdateInfoPath(), JSON.stringify(info), 'utf-8');
  } catch {
    // Non-critical
  }
}

export function readPendingUpdateInfo(): PendingUpdateInfo | null {
  try {
    const data = fs.readFileSync(pendingUpdateInfoPath(), 'utf-8');
    return JSON.parse(data) as PendingUpdateInfo;
  } catch {
    return null;
  }
}

export function clearPendingUpdateInfo(): void {
  try {
    fs.unlinkSync(pendingUpdateInfoPath());
  } catch {
    // File may not exist
  }
}

// ---------------------------------------------------------------------------
// Pending release notes (persisted across restarts for What's New dialog)
// ---------------------------------------------------------------------------

function pendingNotesPath(): string {
  return path.join(app.getPath('userData'), 'pending-release-notes.json');
}

function writePendingReleaseNotes(notes: PendingReleaseNotes): void {
  try {
    fs.writeFileSync(pendingNotesPath(), JSON.stringify(notes), 'utf-8');
  } catch {
    // Non-critical — dialog just won't show
  }
}

export function getPendingReleaseNotes(): PendingReleaseNotes | null {
  try {
    const data = fs.readFileSync(pendingNotesPath(), 'utf-8');
    return JSON.parse(data) as PendingReleaseNotes;
  } catch {
    return null;
  }
}

export function clearPendingReleaseNotes(): void {
  try {
    fs.unlinkSync(pendingNotesPath());
  } catch {
    // File may not exist
  }
}

// ---------------------------------------------------------------------------
// Version history (for What's New settings page)
// ---------------------------------------------------------------------------

/**
 * Filter version history entries to only include versions that:
 * - Are <= the current app version (user shouldn't see future versions)
 * - Are within the last MAX_HISTORY_MONTHS months
 * - Are capped at MAX_HISTORY_VERSIONS entries
 * Results are returned newest-first.
 */
export function filterVersionHistory(
  entries: VersionHistoryEntry[],
  currentVersion: string,
): VersionHistoryEntry[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MAX_HISTORY_MONTHS);

  return entries
    .filter((entry) => {
      // Only include versions <= current version
      if (isNewerVersion(entry.version, currentVersion)) return false;
      // Only include entries within the time window
      const entryDate = new Date(entry.releaseDate);
      if (entryDate < cutoff) return false;
      return true;
    })
    .sort((a, b) => {
      // Newest first: sort by version descending
      if (isNewerVersion(a.version, b.version)) return -1;
      if (isNewerVersion(b.version, a.version)) return 1;
      return 0;
    })
    .slice(0, MAX_HISTORY_VERSIONS);
}

/**
 * Compose version history entries into a single markdown document.
 * Each version gets an H1 header with the release title, followed by
 * its release notes content, and separated by horizontal rules.
 */
export function composeVersionHistoryMarkdown(entries: VersionHistoryEntry[]): string {
  return entries
    .map((entry) => {
      const title = entry.releaseMessage || `v${entry.version}`;
      const header = `# ${title}`;
      const notes = entry.releaseNotes || '';
      return `${header}\n\n${notes}`;
    })
    .join('\n\n----\n\n');
}

export async function getVersionHistory(): Promise<{ markdown: string; entries: VersionHistoryEntry[] }> {
  const currentVersion = app.getVersion();
  appLog('update:history', 'info', 'Fetching version history', { meta: { currentVersion } });

  try {
    const entries = await fetchJSON<VersionHistoryEntry[]>(HISTORY_URL);
    if (!Array.isArray(entries)) {
      appLog('update:history', 'warn', 'Invalid history.json format');
      return { markdown: '', entries: [] };
    }
    const filtered = filterVersionHistory(entries, currentVersion);
    const markdown = composeVersionHistoryMarkdown(filtered);
    return { markdown, entries: filtered };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appLog('update:history', 'error', `Failed to fetch version history: ${msg}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function getStatus(): UpdateStatus {
  return { ...status };
}

export function startPeriodicChecks(): void {
  if (checkTimer) return;

  const settings = getSettings();

  // Seed lastSeenVersion on first launch to prevent What's New on fresh install
  if (settings.lastSeenVersion === null) {
    saveSettings({ ...settings, lastSeenVersion: app.getVersion() });
  }

  // Clear dismissedVersion on startup so the banner always shows if an update
  // is already downloaded. The dismiss is session-scoped (renderer-side timer).
  if (settings.dismissedVersion) {
    saveSettings({ ...settings, dismissedVersion: null });
  }

  // Restore ready state immediately if a pending update was downloaded in a
  // previous session and the file is still on disk.
  const pending = readPendingUpdateInfo();
  if (pending && fs.existsSync(pending.downloadPath)) {
    const currentVersion = app.getVersion();
    if (isNewerVersion(pending.version, currentVersion)) {
      appLog('update:restore', 'info', 'Restoring pending update from previous session', {
        meta: { version: pending.version },
      });
      setState('ready', {
        availableVersion: pending.version,
        releaseNotes: pending.releaseNotes,
        releaseMessage: pending.releaseMessage,
        downloadProgress: 100,
        downloadPath: pending.downloadPath,
        error: null,
      });
    } else {
      // The pending update is for a version we already have (or older) — clean up
      clearPendingUpdateInfo();
    }
  }

  if (!settings.autoUpdate) return;

  // Check on startup (delayed to let the app settle)
  setTimeout(() => {
    checkForUpdates().catch(() => {});
  }, 30_000); // 30 second delay after startup

  // Periodic checks
  checkTimer = setInterval(() => {
    const currentSettings = getSettings();
    if (currentSettings.autoUpdate) {
      checkForUpdates().catch(() => {});
    }
  }, CHECK_INTERVAL_MS);
}

export function stopPeriodicChecks(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
