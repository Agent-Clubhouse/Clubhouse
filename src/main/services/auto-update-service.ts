import { app, BrowserWindow } from 'electron';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPC } from '../../shared/ipc-channels';
import { UpdateSettings, UpdateStatus, UpdateState, UpdateManifest, UpdateArtifact, PendingReleaseNotes } from '../../shared/types';
import { createSettingsStore } from './settings-store';
import { appLog } from './log-service';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UPDATE_URL = 'https://stclubhousereleases.blob.core.windows.net/releases/updates/latest.json';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

const settingsStore = createSettingsStore<UpdateSettings>('update-settings.json', {
  autoUpdate: true,
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
 * Simple semver comparison. Returns true if a > b.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
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

function fetchJSON(url: string): Promise<UpdateManifest> {
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
    meta: { manual, currentVersion: app.getVersion() },
  });

  try {
    const manifest = await fetchJSON(UPDATE_URL);
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
    // On Windows, Squirrel handles the update — just run the installer
    try {
      if (fs.existsSync(downloadPath)) {
        const { spawn } = require('child_process');
        spawn(downloadPath, ['--update'], { detached: true, stdio: 'ignore' }).unref();
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
