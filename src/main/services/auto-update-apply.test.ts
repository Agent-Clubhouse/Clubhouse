import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn, execFileSync } from 'child_process';
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

/** Run a script attached and resolve with its exit code. */
function runScript(scriptPath: string, env?: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { stdio: 'ignore', env: env ?? process.env });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

/** Write a minimal but complete mock .app bundle. */
async function writeBundle(bundlePath: string, version: string): Promise<void> {
  await fsp.mkdir(path.join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
  await fsp.writeFile(path.join(bundlePath, 'Contents', 'Info.plist'), '<plist/>');
  await fsp.writeFile(path.join(bundlePath, 'Contents', 'MacOS', 'Test'), '#!/bin/sh\n', { mode: 0o755 });
  await fsp.writeFile(path.join(bundlePath, 'Contents', 'version'), version);
}

function readVersion(bundlePath: string): Promise<string> {
  return fsp.readFile(path.join(bundlePath, 'Contents', 'version'), 'utf-8');
}

/** Zip the contents of `srcDir` (relative entries) into `zipPath`. */
function zipDir(srcDir: string, zipPath: string, entry: string): void {
  execFileSync('zip', ['-r', '-q', zipPath, entry], { cwd: srcDir });
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
    await writeBundle(appBundlePath, 'old');

    // Mock "new" app in extract dir
    const tmpExtract = path.join(tmpDir, 'extract');
    const newAppPath = path.join(tmpExtract, 'Test.app');
    await writeBundle(newAppPath, 'new');

    // Mock downloaded update archive
    const downloadPath = path.join(tmpDir, 'Clubhouse-1.0.0.zip');
    await fsp.writeFile(downloadPath, 'fake-archive');

    const scriptPath = path.join(tmpDir, 'clubhouse-update.sh');
    const backupPath = `${appBundlePath}.update-backup`;

    return { tmpDir, appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath, backupPath };
  }

  /** Replace the placeholder download with a real zip of the extract dir, then remove the extract dir. */
  async function zipNewAppAsDownload(env: Awaited<ReturnType<typeof createMacTestEnv>>) {
    await fsp.rm(env.downloadPath, { force: true });
    zipDir(env.tmpExtract, env.downloadPath, 'Test.app');
    await fsp.rm(env.tmpExtract, { recursive: true, force: true });
  }

  /**
   * PATH prefix with an `mv` that fails when moving anything out of the
   * extract dir — simulates the new bundle failing to move into place after
   * the old one has already been moved aside.
   */
  async function envWithFailingMv(tmpDir: string): Promise<NodeJS.ProcessEnv> {
    const binDir = path.join(tmpDir, 'fakebin');
    await fsp.mkdir(binDir);
    await fsp.writeFile(
      path.join(binDir, 'mv'),
      '#!/bin/bash\ncase "$1" in */extract/*) echo "mv: simulated failure" >&2; exit 1;; esac\nexec /bin/mv "$@"\n',
      { mode: 0o755 },
    );
    return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
  }

  it('quit script extracts zip, replaces the app bundle and cleans up all temp files', async () => {
    const env = await createMacTestEnv();
    await zipNewAppAsDownload(env);

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    // Spawn with the exact same flags as production
    spawn('bash', [env.scriptPath], { detached: true, stdio: 'ignore' }).unref();

    // Wait for the script to self-delete (proves it ran to completion)
    await waitForFileRemoval(env.scriptPath);

    expect(await readVersion(env.appBundlePath)).toBe('new');
    expect(fs.existsSync(env.tmpExtract)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(false);
    expect(fs.existsSync(env.scriptPath)).toBe(false);
    expect(fs.existsSync(env.backupPath)).toBe(false);
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

    expect(await readVersion(env.appBundlePath)).toBe('new');

    // Cleanup should have happened even though `open` on a fake .app fails
    expect(fs.existsSync(env.tmpExtract)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(false);
    expect(fs.existsSync(env.backupPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);

  it('script does not exit prematurely if the old app bundle is missing', async () => {
    const env = await createMacTestEnv();
    await zipNewAppAsDownload(env);
    await fsp.rm(env.appBundlePath, { recursive: true });

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    expect(await runScript(env.scriptPath)).toBe(0);

    // The new app should still be moved into place
    expect(await readVersion(env.appBundlePath)).toBe('new');
    expect(fs.existsSync(env.tmpExtract)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(false);
  }, SCRIPT_TIMEOUT_MS);

  // ── Failure cases ────────────────────────────────────────────────────────

  it('relaunch script restores the old bundle, keeps artifacts and exits non-zero when the move fails', async () => {
    const env = await createMacTestEnv();

    const script = buildMacUpdateScript(
      env.appBundlePath, env.newAppPath, env.tmpExtract, env.downloadPath, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    expect(await runScript(env.scriptPath, await envWithFailingMv(env.tmpDir))).not.toBe(0);

    expect(await readVersion(env.appBundlePath)).toBe('old');
    expect(fs.existsSync(env.backupPath)).toBe(false);
    expect(await readVersion(env.newAppPath)).toBe('new');
    expect(fs.existsSync(env.downloadPath)).toBe(true);
  }, SCRIPT_TIMEOUT_MS);

  it('quit script restores the old bundle, keeps artifacts and exits non-zero when the move fails', async () => {
    const env = await createMacTestEnv();
    await zipNewAppAsDownload(env);

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    expect(await runScript(env.scriptPath, await envWithFailingMv(env.tmpDir))).not.toBe(0);

    expect(await readVersion(env.appBundlePath)).toBe('old');
    expect(fs.existsSync(env.backupPath)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(true);
    expect(fs.existsSync(env.tmpExtract)).toBe(true);
  }, SCRIPT_TIMEOUT_MS);

  it('quit script leaves the old bundle untouched when the archive holds an incomplete bundle', async () => {
    const env = await createMacTestEnv();
    // Partial extraction: bundle dir without Info.plist or executable
    await fsp.rm(path.join(env.newAppPath, 'Contents', 'Info.plist'));
    await fsp.rm(path.join(env.newAppPath, 'Contents', 'MacOS'), { recursive: true });
    await zipNewAppAsDownload(env);

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    expect(await runScript(env.scriptPath)).not.toBe(0);

    expect(await readVersion(env.appBundlePath)).toBe('old');
    expect(fs.existsSync(env.backupPath)).toBe(false);
    expect(fs.existsSync(env.downloadPath)).toBe(true);
  }, SCRIPT_TIMEOUT_MS);

  it('quit script leaves the old bundle untouched when the archive is truncated', async () => {
    const env = await createMacTestEnv();
    await zipNewAppAsDownload(env);
    const zip = await fsp.readFile(env.downloadPath);
    await fsp.writeFile(env.downloadPath, zip.subarray(0, Math.floor(zip.length / 2)));

    const script = buildMacQuitUpdateScript(
      env.appBundlePath, env.downloadPath, env.tmpExtract, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    expect(await runScript(env.scriptPath)).not.toBe(0);

    expect(await readVersion(env.appBundlePath)).toBe('old');
    expect(fs.existsSync(env.downloadPath)).toBe(true);
  }, SCRIPT_TIMEOUT_MS);

  it('relaunch script refuses a bundle with no executable', async () => {
    const env = await createMacTestEnv();
    await fsp.chmod(path.join(env.newAppPath, 'Contents', 'MacOS', 'Test'), 0o644);

    const script = buildMacUpdateScript(
      env.appBundlePath, env.newAppPath, env.tmpExtract, env.downloadPath, env.scriptPath,
    );
    await fsp.writeFile(env.scriptPath, script, { mode: 0o755 });

    expect(await runScript(env.scriptPath)).not.toBe(0);

    expect(await readVersion(env.appBundlePath)).toBe('old');
    expect(fs.existsSync(env.newAppPath)).toBe(true);
    expect(fs.existsSync(env.downloadPath)).toBe(true);
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
  const build = () => buildMacUpdateScript(appBundlePath, newAppPath, tmpExtract, downloadPath, scriptPath);

  it('starts with a bash shebang', () => {
    expect(build().startsWith('#!/bin/bash')).toBe(true);
  });

  it('waits before replacing (sleep)', () => {
    expect(build()).toContain('sleep 1');
  });

  it('binds every path as a single-quoted variable', () => {
    const script = build();
    expect(script).toContain(`APP='${appBundlePath}'`);
    expect(script).toContain(`NEW_APP='${newAppPath}'`);
    expect(script).toContain(`EXTRACT='${tmpExtract}'`);
    expect(script).toContain(`DOWNLOAD='${downloadPath}'`);
    expect(script).toContain(`SCRIPT='${scriptPath}'`);
  });

  it('never deletes the installed bundle outright — moves it aside first', () => {
    const lines = build().split('\n');
    expect(lines.some((l) => /rm -rf "\$APP"$/.test(l.trim()) && !l.startsWith('  '))).toBe(false);
    const asideIdx = lines.findIndex((l) => l.includes('mv "$APP" "$BACKUP"'));
    const intoIdx = lines.findIndex((l) => l.includes('mv "$NEW_APP" "$APP"'));
    const dropBackupIdx = lines.lastIndexOf('rm -rf "$BACKUP"');
    expect(asideIdx).toBeGreaterThan(-1);
    expect(intoIdx).toBeGreaterThan(asideIdx);
    expect(dropBackupIdx).toBeGreaterThan(intoIdx);
  });

  it('verifies the new bundle before moving the old one aside', () => {
    const script = build();
    const verifyIdx = script.indexOf('Contents/Info.plist');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(script).toContain('Contents/MacOS/*');
    expect(verifyIdx).toBeLessThan(script.indexOf('mv "$APP" "$BACKUP"'));
  });

  it('relaunches, then cleans up the extract dir, download, and self-deletes', () => {
    const script = build();
    const openIdx = script.indexOf('open "$APP"');
    expect(openIdx).toBeGreaterThan(script.indexOf('mv "$NEW_APP" "$APP"'));
    expect(script.indexOf('rm -rf "$EXTRACT"')).toBeGreaterThan(openIdx);
    expect(script).toContain('rm -f "$DOWNLOAD"');
    expect(script.trimEnd().endsWith('rm -f "$SCRIPT"\nexit 0')).toBe(true);
  });

  it('failure path does not remove the extract dir or download', () => {
    const script = build();
    const failFn = script.slice(script.indexOf('fail() {'), script.indexOf('}', script.indexOf('fail() {')));
    expect(failFn).toContain('exit 1');
    expect(failFn).not.toContain('$EXTRACT');
    expect(failFn).not.toContain('$DOWNLOAD');
  });

  it('uses LF line endings', () => {
    expect(build()).not.toContain('\r');
  });
});

describe('buildMacQuitUpdateScript', () => {
  const appBundlePath = '/Applications/Clubhouse.app';
  const downloadPath = '/tmp/Clubhouse-1.0.0.zip';
  const tmpExtract = '/tmp/extract';
  const scriptPath = '/tmp/clubhouse-update.sh';
  const build = () => buildMacQuitUpdateScript(appBundlePath, downloadPath, tmpExtract, scriptPath);

  it('does NOT relaunch the app', () => {
    expect(build()).not.toContain('open');
  });

  it('extracts the update archive via unzip and aborts if unzip fails', () => {
    expect(build()).toContain('unzip -o -q "$DOWNLOAD" -d "$EXTRACT" || fail');
  });

  it('finds the .app bundle in the extract directory', () => {
    const script = build();
    expect(script).toContain('find "$EXTRACT"');
    expect(script).toContain('*.app');
  });

  it('aborts if no .app is found', () => {
    expect(build()).toContain('if [ -z "$NEW_APP" ]; then fail');
  });

  it('moves the old bundle aside and restores it on failure', () => {
    const script = build();
    expect(script).toContain('mv "$APP" "$BACKUP"');
    expect(script).toContain('mv "$BACKUP" "$APP"');
    expect(script).toContain('BACKUP="$APP.update-backup"');
  });

  it('still performs the full cleanup sequence on success', () => {
    const script = build();
    expect(script).toContain('sleep 1');
    expect(script).toContain(`APP='${appBundlePath}'`);
    expect(script.trimEnd().endsWith('rm -rf "$EXTRACT"\nrm -f "$DOWNLOAD"\nrm -f "$SCRIPT"\nexit 0')).toBe(true);
  });
});
