import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  buildMacUpdateScript,
  buildMacQuitUpdateScript,
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

  it('quit script extracts zip, replaces the app bundle and cleans up all temp files', async () => {
    const env = await createMacTestEnv();

    // Remove the fake download placeholder so `zip` can create a fresh archive
    await fsp.rm(env.downloadPath, { force: true });

    // Create a real zip containing the mock "new" app bundle
    const { execSync } = await import('child_process');
    execSync(`cd "${env.tmpExtract}" && zip -r -q "${env.downloadPath}" Test.app`);

    // Remove the pre-created extract dir so the script can recreate it
    await fsp.rm(env.tmpExtract, { recursive: true, force: true });

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
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

    // Remove the fake download placeholder so `zip` can create a fresh archive
    await fsp.rm(env.downloadPath, { force: true });

    // Create a real zip containing the mock "new" app bundle
    const { execSync } = await import('child_process');
    execSync(`cd "${env.tmpExtract}" && zip -r -q "${env.downloadPath}" Test.app`);

    // Remove both the extract dir and old app bundle
    await fsp.rm(env.tmpExtract, { recursive: true, force: true });
    await fsp.rm(env.appBundlePath, { recursive: true });

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
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
  const downloadPath = '/tmp/Clubhouse-1.0.0.zip';
  const tmpExtract = '/tmp/extract';
  const scriptPath = '/tmp/clubhouse-update.sh';

  it('does NOT relaunch the app', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, downloadPath, tmpExtract, scriptPath);
    expect(script).not.toContain('open');
  });

  it('extracts the update archive via unzip', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, downloadPath, tmpExtract, scriptPath);
    expect(script).toContain(`unzip -o -q "${downloadPath}" -d "${tmpExtract}"`);
  });

  it('finds the .app bundle in the extract directory', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, downloadPath, tmpExtract, scriptPath);
    expect(script).toContain('find');
    expect(script).toContain('*.app');
  });

  it('aborts with cleanup if no .app is found', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, downloadPath, tmpExtract, scriptPath);
    expect(script).toContain('if [ -z "$APP_PATH" ]');
    expect(script).toContain('exit 1');
  });

  it('still performs the full replacement and cleanup sequence', () => {
    const script = buildMacQuitUpdateScript(appBundlePath, downloadPath, tmpExtract, scriptPath);
    expect(script).toContain('sleep 1');
    expect(script).toContain(`rm -rf "${appBundlePath}"`);
    expect(script).toContain(`rm -rf "${tmpExtract}"`);
    expect(script).toContain(`rm -f "${downloadPath}"`);
    expect(script).toContain(`rm -f "${scriptPath}"`);
  });
});
