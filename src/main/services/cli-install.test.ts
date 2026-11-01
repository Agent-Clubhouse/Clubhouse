import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isPackaged: true, baseDir: '', home: '', pathValue: '' }));

vi.mock('electron', () => ({ app: { get isPackaged() { return mocks.isPackaged; } } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => mocks.baseDir }));
vi.mock('../util/shell', () => ({ getShellEnvironment: () => ({ PATH: mocks.pathValue }) }));
vi.mock('os', async (importOriginal) => ({ ...await importOriginal<typeof os>(), homedir: () => mocks.home }));

import { getCliInstallStatus, installCli, refreshInstalledCli, uninstallCli, unixWrapper, windowsWrapper } from './cli-install';

describe('wrappers', () => {
  it('runs the script on node, and explains a missing node', () => {
    const wrapper = unixWrapper('/home/me/.clubhouse/bin/clubhouse.js');
    expect(wrapper.startsWith('#!/bin/sh\n')).toBe(true);
    expect(wrapper).toContain('needs Node.js');
    expect(wrapper).toContain(`exec node '/home/me/.clubhouse/bin/clubhouse.js' "$@"`);
    expect(wrapper).not.toContain('case');
    expect(windowsWrapper()).toContain('node "%~dp0clubhouse.js" %*');
    expect(windowsWrapper()).toContain('needs Node.js');
  });

  it('quotes paths', () => {
    expect(unixWrapper(`/it's/clubhouse.js`)).toContain(`exec node '/it'\\''s/clubhouse.js'`);
  });

  it('on Linux, hands anything but a CLI command to the app that shares the name', () => {
    const wrapper = unixWrapper('/s.js', '/usr/lib/clubhouse/clubhouse');
    expect(wrapper).toContain(`*) exec '/usr/lib/clubhouse/clubhouse' "$@"`);
    for (const word of ['projects', 'agents', 'project', 'agent', 'help', '--help', '--json', '--dev']) {
      expect(wrapper.split('\n').find((line) => line.endsWith(') ;;'))).toContain(word);
    }
  });
});

describe.skipIf(process.platform === 'win32')('install on macOS and Linux', () => {
  let root: string;
  let localBin: string;

  beforeEach(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-install-')));
    mocks.isPackaged = true;
    mocks.home = path.join(root, 'home');
    mocks.baseDir = path.join(mocks.home, '.clubhouse');
    localBin = path.join(mocks.home, '.local', 'bin');
    mocks.pathValue = '/usr/bin';
    await fsp.mkdir(mocks.home, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const wrapper = () => path.join(mocks.baseDir, 'bin', 'clubhouse');

  it('offers nothing in a dev build', async () => {
    mocks.isPackaged = false;
    expect(await getCliInstallStatus()).toEqual({ supported: false, installed: false });
    await expect(installCli()).rejects.toThrow('packaged');
    await refreshInstalledCli();
    await expect(fsp.access(wrapper())).rejects.toThrow();
  });

  it('starts out not installed', async () => {
    expect(await getCliInstallStatus()).toEqual({ supported: true, installed: false });
  });

  it('links into a writable folder on PATH and copies the script out', async () => {
    await fsp.mkdir(localBin, { recursive: true });
    mocks.pathValue = `${localBin}:/usr/bin`;
    const status = await installCli();
    expect(status).toEqual({ supported: true, installed: true, commandPath: path.join(localBin, 'clubhouse') });
    expect(await fsp.readlink(path.join(localBin, 'clubhouse'))).toBe(wrapper());
    expect((await fsp.stat(wrapper())).mode & 0o111).toBe(0o111);
    expect(await fsp.readFile(path.join(mocks.baseDir, 'bin', 'clubhouse.js'), 'utf8')).toContain('The clubhouse CLI');
  });

  it('falls back to ~/.local/bin and says to add it to PATH', async () => {
    const status = await installCli();
    expect(status.commandPath).toBe(path.join(localBin, 'clubhouse'));
    expect(status.note).toContain(`Add ${localBin} to your PATH`);
  });

  it('says so when something else comes first on PATH', async () => {
    const other = path.join(root, 'other');
    await fsp.mkdir(other);
    await fsp.writeFile(path.join(other, 'clubhouse'), 'the app');
    await fsp.mkdir(localBin, { recursive: true });
    mocks.pathValue = `${other}:${localBin}`;
    const status = await installCli();
    expect(status.installed).toBe(true);
    expect(status.note).toContain(`${path.join(other, 'clubhouse')} comes first`);
  });

  it('skips a folder where something else already has the name, and never overwrites it', async () => {
    const other = path.join(mocks.home, 'bin');
    await fsp.mkdir(other, { recursive: true });
    await fsp.writeFile(path.join(other, 'clubhouse'), 'mine');
    await fsp.mkdir(localBin, { recursive: true });
    await fsp.writeFile(path.join(localBin, 'clubhouse'), 'also mine');
    mocks.pathValue = `${localBin}:${other}`;
    await expect(installCli()).rejects.toThrow('already exists');
    expect(await fsp.readFile(path.join(other, 'clubhouse'), 'utf8')).toBe('mine');
    expect(await fsp.readFile(path.join(localBin, 'clubhouse'), 'utf8')).toBe('also mine');
  });

  it('can be installed twice', async () => {
    await installCli();
    expect((await installCli()).installed).toBe(true);
  });

  it('refreshes an installed copy at startup, and leaves an uninstalled one alone', async () => {
    await refreshInstalledCli();
    await expect(fsp.access(wrapper())).rejects.toThrow();
    await installCli();
    const script = path.join(mocks.baseDir, 'bin', 'clubhouse.js');
    await fsp.writeFile(script, 'old version');
    await refreshInstalledCli();
    expect(await fsp.readFile(script, 'utf8')).toContain('The clubhouse CLI');
  });

  it('removes only what it installed', async () => {
    await installCli();
    const other = path.join(mocks.home, 'bin');
    await fsp.mkdir(other, { recursive: true });
    await fsp.writeFile(path.join(other, 'clubhouse'), 'mine');
    expect(await uninstallCli()).toEqual({ supported: true, installed: false });
    await expect(fsp.lstat(path.join(localBin, 'clubhouse'))).rejects.toThrow();
    await expect(fsp.access(wrapper())).rejects.toThrow();
    expect(await fsp.readFile(path.join(other, 'clubhouse'), 'utf8')).toBe('mine');
  });
});
