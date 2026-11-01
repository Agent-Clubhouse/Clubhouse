/**
 * Installing the clubhouse command from the packaged app (#2598). The script
 * is copied out to `<base dir>/bin` rather than run from the bundle: a Windows
 * update changes the bundle's path, and nothing outside the bundle needs
 * signing. Each start refreshes an installed copy, so it follows app updates.
 *
 * Getting it onto PATH needs no admin rights:
 * - macOS and Linux: a symlink in the first writable folder already on the
 *   user's PATH, else ~/.local/bin, and the result says to add that.
 * - Windows: the bin folder on the user's own PATH.
 *
 * On Linux the app's own binary is also called clubhouse, and its desktop entry
 * runs that name. So the wrapper there hands anything that isn't a CLI command
 * to the app, and a symlink that shadows it changes nothing for the desktop.
 */

import { execFile } from 'child_process';
import { app } from 'electron';
import { constants } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { CliInstallStatus } from '../../shared/types';
import { getBaseDirPath } from './base-dir';
import { appLog } from './log-service';
import { getShellEnvironment } from '../util/shell';

const execFileAsync = promisify(execFile);

const COMMAND = 'clubhouse';
const SCRIPT_FILE = 'clubhouse.js';
const WRAPPER_FILE = process.platform === 'win32' ? 'clubhouse.cmd' : COMMAND;
/** The CLI's first words, for the Linux wrapper. Keep in step with COMMANDS in clubhouse-cli.js. */
const CLI_WORDS = 'projects|agents|project|agent|help|--help|-h|--json|--dev';

function binDir(): string {
  return path.join(getBaseDirPath(), 'bin');
}

function wrapperPath(): string {
  return path.join(binDir(), WRAPPER_FILE);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function unixWrapper(scriptPath: string, linuxAppPath?: string): string {
  const passthrough = linuxAppPath
    ? `case "\${1:-}" in\n  ${CLI_WORDS}) ;;\n  *) exec ${shellQuote(linuxAppPath)} "$@" ;;\nesac\n`
    : '';
  return `#!/bin/sh\n${passthrough}if ! command -v node >/dev/null 2>&1; then\n  echo "clubhouse: needs Node.js on your PATH." >&2\n  exit 127\nfi\nexec node ${shellQuote(scriptPath)} "$@"\n`;
}

export function windowsWrapper(): string {
  return [
    '@echo off',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo clubhouse: needs Node.js on your PATH. 1>&2',
    '  exit /b 127',
    ')',
    `node "%~dp0${SCRIPT_FILE}" %*`,
    '',
  ].join('\r\n');
}

/** Write the script and its wrapper to the bin folder. */
async function writeFiles(): Promise<void> {
  const dir = binDir();
  await fsp.mkdir(dir, { recursive: true });
  // Inside the app's asar, which fs reads through. The bridge script sits beside it the same way.
  const source = await fsp.readFile(path.join(__dirname, 'cli', 'clubhouse-cli.js'));
  const script = path.join(dir, SCRIPT_FILE);
  await fsp.writeFile(script, source);
  const wrapper = process.platform === 'win32'
    ? windowsWrapper()
    : unixWrapper(script, process.platform === 'linux' ? process.execPath : undefined);
  await fsp.writeFile(wrapperPath(), wrapper, { mode: 0o755 });
  // writeFile keeps the mode of a file that already exists.
  await fsp.chmod(wrapperPath(), 0o755);
}

function pathDirs(): string[] {
  const value = getShellEnvironment().PATH ?? process.env.PATH ?? '';
  return value.split(path.delimiter).filter(Boolean);
}

const FALLBACK_DIR = (): string => path.join(os.homedir(), '.local', 'bin');

/** Where a symlink could go, best first. */
function linkDirs(): string[] {
  const home = os.homedir();
  return [FALLBACK_DIR(), path.join(home, 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
}

/** True when `dir/clubhouse` is our symlink, false when something else is there, null when nothing is. */
async function linkState(dir: string): Promise<boolean | null> {
  const link = path.join(dir, COMMAND);
  try {
    return await fsp.readlink(link) === wrapperPath();
  } catch (err) {
    // telemetry-exempt: which of these it is, is the answer
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : false;
  }
}

async function isWritable(dir: string): Promise<boolean> {
  return fsp.access(dir, constants.W_OK).then(() => true, () => false);
}

/** The folder holding our symlink, if any. */
async function findLinkDir(): Promise<string | null> {
  for (const dir of linkDirs()) {
    if (await linkState(dir) === true) return dir;
  }
  return null;
}

/** The first `clubhouse` on PATH, if it isn't ours. */
async function shadowingCommand(link: string): Promise<string | null> {
  const ours = await fsp.realpath(link).catch((): string => link);
  for (const dir of pathDirs()) {
    const candidate = path.join(dir, COMMAND);
    const real = await fsp.realpath(candidate).catch((): null => null);
    if (real) return real === ours ? null : candidate;
  }
  return null;
}

async function unixStatus(): Promise<CliInstallStatus> {
  const dir = await findLinkDir();
  if (!dir) return { supported: true, installed: false };
  const commandPath = path.join(dir, COMMAND);
  if (!pathDirs().includes(dir)) {
    return { supported: true, installed: true, commandPath, note: `Add ${dir} to your PATH to use the clubhouse command.` };
  }
  const shadow = await shadowingCommand(commandPath);
  return {
    supported: true, installed: true, commandPath,
    ...(shadow && { note: `${shadow} comes first on your PATH. Put ${dir} ahead of it to use the clubhouse command.` }),
  };
}

async function installUnix(): Promise<void> {
  const onPath = new Set(pathDirs());
  let target: string | null = null;
  for (const dir of linkDirs()) {
    if (onPath.has(dir) && await isWritable(dir) && await linkState(dir) !== false) {
      target = dir;
      break;
    }
  }
  if (!target) {
    target = FALLBACK_DIR();
    await fsp.mkdir(target, { recursive: true });
  }
  const link = path.join(target, COMMAND);
  const state = await linkState(target);
  if (state === false) throw new Error(`${link} already exists, and isn't this command. Move it and try again.`);
  if (state === null) await fsp.symlink(wrapperPath(), link);
}

async function uninstallUnix(): Promise<void> {
  for (const dir of linkDirs()) {
    if (await linkState(dir) === true) await fsp.unlink(path.join(dir, COMMAND));
  }
}

/**
 * Edit the user's own PATH with a script that takes the folder from its
 * environment, so nothing needs quoting. It goes through the registry because
 * [Environment]::GetEnvironmentVariable expands %VAR% entries, and writing that
 * back would change them for good. Clearing a variable tells running programs
 * about the change.
 */
async function editUserPath(change: string): Promise<void> {
  const script = [
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`,
    `$dirs = @($key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_ })`,
    change,
    `$key.SetValue('Path', ($dirs -join ';'), 'ExpandString')`,
    `[Environment]::SetEnvironmentVariable('CLUBHOUSE_PATH_REFRESH', $null, 'User')`,
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CLUBHOUSE_BIN: binDir() },
    windowsHide: true,
  });
}

async function windowsStatus(): Promise<CliInstallStatus> {
  const installed = await fsp.access(wrapperPath()).then(() => true, () => false);
  if (!installed) return { supported: true, installed: false };
  return { supported: true, installed: true, commandPath: wrapperPath(), note: 'Open a new terminal to use the clubhouse command.' };
}

function installWindows(): Promise<void> {
  return editUserPath('if ($dirs -notcontains $env:CLUBHOUSE_BIN) { $dirs += $env:CLUBHOUSE_BIN }');
}

function uninstallWindows(): Promise<void> {
  return editUserPath('$dirs = @($dirs | Where-Object { $_ -ne $env:CLUBHOUSE_BIN })');
}

export async function getCliInstallStatus(): Promise<CliInstallStatus> {
  if (!app.isPackaged) return { supported: false, installed: false };
  return process.platform === 'win32' ? windowsStatus() : unixStatus();
}

export async function installCli(): Promise<CliInstallStatus> {
  if (!app.isPackaged) throw new Error('The command can only be installed from a packaged build.');
  // Windows counts the files as installed, so they come last: a failed PATH edit leaves nothing behind.
  if (process.platform === 'win32') {
    await installWindows();
    await writeFiles();
  } else {
    await writeFiles();
    await installUnix();
  }
  appLog('core:cli', 'info', 'Installed the clubhouse command');
  return getCliInstallStatus();
}

export async function uninstallCli(): Promise<CliInstallStatus> {
  if (!app.isPackaged) throw new Error('The command can only be removed from a packaged build.');
  if (process.platform === 'win32') await uninstallWindows();
  else await uninstallUnix();
  await fsp.rm(path.join(binDir(), SCRIPT_FILE), { force: true });
  await fsp.rm(wrapperPath(), { force: true });
  appLog('core:cli', 'info', 'Removed the clubhouse command');
  return getCliInstallStatus();
}

/** At startup: if the command is installed, bring its files up to this version of the app. */
export async function refreshInstalledCli(): Promise<void> {
  if (!app.isPackaged) return;
  const installed = await fsp.access(wrapperPath()).then(() => true, () => false);
  if (installed) await writeFiles();
}
