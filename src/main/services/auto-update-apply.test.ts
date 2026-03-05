import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  buildMacUpdateScript,
  buildMacQuitUpdateScript,
  buildWindowsUpdateScript,
  buildWindowsQuitUpdateScript,
} from './auto-update-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT_TIMEOUT_MS = 15_000;

/** Poll until a file is removed from disk (indicates script self-deleted). */
async function waitForFileRemoval(filePath: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fsp.access(filePath);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return; // File gone — script finished
    }
  }
  throw new Error(`Timed out waiting for ${filePath} to be removed (${timeoutMs}ms)`);
}

/** Poll until a file appears on disk. */
async function waitForFile(filePath: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fsp.access(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Timed out waiting for ${filePath} to appear (${timeoutMs}ms)`);
}

// ---------------------------------------------------------------------------
// macOS integration tests — actually execute the generated shell scripts
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'darwin')('macOS update script execution (integration)', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  /** Create a temp dir with mock old/new app bundles, download file, and script path. */
  async function createMacTestEnv() {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-update-test-'));
    tmpDirs.push(tmpDir);

    // Mock "old" app bundle
    const appBundlePath = path.join(tmpDir, 'Test.app');
    await fsp.mkdir(path.join(appBundlePath, 'Contents'), { recursive: true });
    await fsp.writeFile(path.join(appBundlePath, 'Contents', 'version'), 'old');

    // Mock "new" app in extract dir
    const tmpExtract = path.join(tmpDir, 'extract');
    const newAppPath = path.join(tmpExtract, 'Test.app');
    await fsp.mkdir(path.join(newAppPath, 'Contents'), { recursive: true });
    await fsp.writeFile(path.join(newAppPath, 'Contents', 'version'), 'new');

    // Mock downloaded update archive
    const downloadPath = path.join(tmpDir, 'Clubhouse-1.0.0.zip');
    await fsp.writeFile(downloadPath, 'fake-archive');

    const scriptPath = path.join(tmpDir, 'clubhouse-update.sh');

    return { tmpDir, appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath };
  }

  it('quit script replaces the app bundle and cleans up all temp files', async () => {
    const env = await createMacTestEnv();

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.newAppPath, env.tmpExtract, env.downloadPath, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    // Spawn with the exact same flags as production
    spawn('bash', [env.scriptPath], { detached: true, stdio: 'ignore' }).unref();

    // Wait for the script to self-delete (proves it ran to completion)
    await waitForFileRemoval(env.scriptPath);

    // The app bundle should now contain the "new" version
    const version = await fsp.readFile(path.join(env.appBundlePath, 'Contents', 'version'), 'utf-8');
    expect(version).toBe('new');

    // Extract dir should be cleaned up
    expect(fs.existsSync(env.tmpExtract)).toBe(false);

    // Download file should be cleaned up
    expect(fs.existsSync(env.downloadPath)).toBe(false);

    // Script should be self-deleted
    expect(fs.existsSync(env.scriptPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);

  it('relaunch script replaces the app bundle and cleans up', async () => {
    const env = await createMacTestEnv();

    const script = buildMacUpdateScript(
      env.appBundlePath, env.newAppPath, env.tmpExtract, env.downloadPath, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    // Spawn with the exact same flags as production
    spawn('bash', [env.scriptPath], { detached: true, stdio: 'ignore' }).unref();

    // Wait for the script to self-delete
    await waitForFileRemoval(env.scriptPath);

    // The app bundle should now contain the "new" version
    const version = await fsp.readFile(path.join(env.appBundlePath, 'Contents', 'version'), 'utf-8');
    expect(version).toBe('new');

    // Cleanup should have happened even though `open` on a fake .app fails
    expect(fs.existsSync(env.tmpExtract)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);

  it('script does not exit prematurely if the old app bundle is missing', async () => {
    const env = await createMacTestEnv();

    // Remove the old app bundle before running the script
    await fsp.rm(env.appBundlePath, { recursive: true });

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.newAppPath, env.tmpExtract, env.downloadPath, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    spawn('bash', [env.scriptPath], { detached: true, stdio: 'ignore' }).unref();
    await waitForFileRemoval(env.scriptPath);

    // The new app should still be moved into place
    const version = await fsp.readFile(path.join(env.appBundlePath, 'Contents', 'version'), 'utf-8');
    expect(version).toBe('new');

    // Cleanup should still complete
    expect(fs.existsSync(env.tmpExtract)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Windows integration tests — actually execute the generated batch scripts
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'win32')('Windows update script execution (integration)', () => {
  const tmpDirs: string[] = [];
  const logFile = path.join(os.tmpdir(), 'clubhouse-update.log');

  beforeEach(async () => {
    // Clean the shared log file before each test
    await fsp.unlink(logFile).catch(() => {});
  });

  afterEach(async () => {
    await fsp.unlink(logFile).catch(() => {});
    for (const dir of tmpDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  /**
   * Create a temp dir with a mock installer .exe and script path.
   *
   * IMPORTANT: Mock installers must be real .exe files, not .cmd/.bat.
   * Batch scripts that call another .cmd without `call` transfer control
   * permanently (never return), causing the rest of the script to never
   * execute.  In production, the installer is a Squirrel .exe.  We copy
   * a small system executable (hostname.exe) as the mock to match this.
   */
  async function createWinTestEnv() {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-update-test-'));
    tmpDirs.push(tmpDir);

    const systemRoot = process.env.SystemRoot || 'C:\\Windows';

    // Mock installer: copy hostname.exe — it prints the hostname, ignores
    // extra args, and exits 0.  This mirrors production where the installer
    // is a real .exe that returns control to the batch script.
    const installerPath = path.join(tmpDir, 'mock-installer.exe');
    await fsp.copyFile(path.join(systemRoot, 'System32', 'hostname.exe'), installerPath);

    // Mock Update.exe: same approach
    const updateExePath = path.join(tmpDir, 'Update.exe');
    await fsp.copyFile(path.join(systemRoot, 'System32', 'hostname.exe'), updateExePath);

    const scriptPath = path.join(tmpDir, 'clubhouse-update.cmd');

    return { tmpDir, installerPath, updateExePath, scriptPath };
  }

  it('update script writes to the log file and cleans up', async () => {
    const env = await createWinTestEnv();

    const script = buildWindowsUpdateScript(
      env.installerPath, env.updateExePath, 'Clubhouse.exe',
    );
    await fsp.writeFile(env.scriptPath, script);

    // Spawn with the exact same flags as production
    spawn('cmd.exe', ['/c', env.scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();

    // Wait for the log file to appear (proves the delay mechanism worked)
    await waitForFile(logFile);

    // Wait for the script to self-delete (proves it ran to completion)
    await waitForFileRemoval(env.scriptPath);

    // Log file should contain expected entries
    const log = await fsp.readFile(logFile, 'utf-8');
    expect(log).toContain('Running installer:');
    expect(log).toContain(env.installerPath);
    expect(log).toContain('Installer exit code:');

    // The mock installer should have been deleted
    expect(fs.existsSync(env.installerPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);

  it('quit script writes to the log file and cleans up without relaunching', async () => {
    const env = await createWinTestEnv();

    const script = buildWindowsQuitUpdateScript(env.installerPath);
    await fsp.writeFile(env.scriptPath, script);

    // Spawn with the exact same flags as production
    spawn('cmd.exe', ['/c', env.scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();

    await waitForFile(logFile);
    await waitForFileRemoval(env.scriptPath);

    // Log file should contain expected entries
    const log = await fsp.readFile(logFile, 'utf-8');
    expect(log).toContain('Running installer (quit):');
    expect(log).toContain(env.installerPath);
    expect(log).toContain('Installer exit code:');

    // The mock installer should have been deleted
    expect(fs.existsSync(env.installerPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);

  it('log file reports non-zero exit code when installer fails', async () => {
    const env = await createWinTestEnv();

    // Replace mock installer with where.exe — it returns non-zero when
    // given `--silent` (not a valid search target), simulating a failed install
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    await fsp.copyFile(path.join(systemRoot, 'System32', 'where.exe'), env.installerPath);

    const script = buildWindowsQuitUpdateScript(env.installerPath);
    await fsp.writeFile(env.scriptPath, script);

    spawn('cmd.exe', ['/c', env.scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();

    await waitForFileRemoval(env.scriptPath);

    const log = await fsp.readFile(logFile, 'utf-8');
    expect(log).toContain('Installer FAILED');
  }, SCRIPT_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// macOS script builder unit tests (structure validation)
// ---------------------------------------------------------------------------

describe('buildMacUpdateScript', () => {
  const appBundlePath = '/Applications/Clubhouse.app';
  const newAppPath = '/tmp/extract/Clubhouse.app';
  const tmpExtract = '/tmp/extract';
  const downloadPath = '/tmp/Clubhouse-1.0.0.zip';
  const scriptPath = '/tmp/clubhouse-update.sh';

  it('starts with a bash shebang', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script.startsWith('#!/bin/bash')).toBe(true);
  });

  it('waits before replacing (sleep)', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).toContain('sleep 1');
  });

  it('removes the old app bundle before moving the new one', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    const lines = script.split('\n');
    const rmIdx = lines.findIndex((l) => l.includes('rm -rf') && l.includes(appBundlePath));
    const mvIdx = lines.findIndex((l) => l.includes('mv'));
    expect(rmIdx).toBeGreaterThan(-1);
    expect(mvIdx).toBeGreaterThan(rmIdx);
  });

  it('moves the new app to the old bundle path', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).toContain(`mv "${newAppPath}" "${appBundlePath}"`);
  });

  it('relaunches the app via open', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).toContain(`open "${appBundlePath}"`);
  });

  it('cleans up the extract dir, download, and self-deletes', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).toContain(`rm -rf "${tmpExtract}"`);
    expect(script).toContain(`rm -f "${downloadPath}"`);
    expect(script).toContain(`rm -f "${scriptPath}"`);
  });

  it('uses LF line endings', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).not.toContain('\r');
    expect(script.split('\n').length).toBe(8);
  });

  it('executes steps in correct order', () => {
    const script = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    const lines = script.split('\n');
    expect(lines[0]).toBe('#!/bin/bash');
    expect(lines[1]).toContain('sleep');
    expect(lines[2]).toContain('rm -rf');
    expect(lines[2]).toContain(appBundlePath);
    expect(lines[3]).toContain('mv');
    expect(lines[4]).toContain('open');
    expect(lines[5]).toContain(`rm -rf "${tmpExtract}"`);
    expect(lines[6]).toContain(`rm -f "${downloadPath}"`);
    expect(lines[7]).toContain(`rm -f "${scriptPath}"`);
  });
});

describe('buildMacQuitUpdateScript', () => {
  const appBundlePath = '/Applications/Clubhouse.app';
  const newAppPath = '/tmp/extract/Clubhouse.app';
  const tmpExtract = '/tmp/extract';
  const downloadPath = '/tmp/Clubhouse-1.0.0.zip';
  const scriptPath = '/tmp/clubhouse-update.sh';

  it('does NOT relaunch the app', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).not.toContain('open');
  });

  it('has one fewer line than the relaunch script (no open)', () => {
    const updateScript = buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    const quitScript = buildMacQuitUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(quitScript.split('\n').length).toBe(updateScript.split('\n').length - 1);
  });

  it('still performs the full replacement and cleanup sequence', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);
    expect(script).toContain('sleep 1');
    expect(script).toContain(`rm -rf "${appBundlePath}"`);
    expect(script).toContain(`mv "${newAppPath}" "${appBundlePath}"`);
    expect(script).toContain(`rm -rf "${tmpExtract}"`);
    expect(script).toContain(`rm -f "${downloadPath}"`);
    expect(script).toContain(`rm -f "${scriptPath}"`);
  });
});
