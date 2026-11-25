import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const logs = vi.hoisted(() => [] as Array<{ level: string; msg: string; meta?: unknown }>);
vi.mock('./log-service', () => ({
  appLog: (_ns: string, level: string, msg: string, opts?: { meta?: unknown }) => { logs.push({ level, msg, meta: opts?.meta }); },
}));

const rmFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmFailure.error) throw rmFailure.error;
      return actual.rm(...args);
    },
  };
});

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { companionWorkspacesDir, removeCompanionState } from './companion-state-cleanup';

describe('removeCompanionState', () => {
  let home: string;

  beforeEach(async () => {
    logs.length = 0;
    rmFailure.error = undefined;
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'companion-state-'));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('removes every companion workspace and logs which ones, leaving the rest of the Clubhouse folder', async () => {
    const dir = companionWorkspacesDir(home);
    fs.mkdirSync(path.join(dir, 'my-plugin', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'my-plugin', 'notes.md'), 'x');
    fs.mkdirSync(path.join(home, '.clubhouse', 'plugin-data', 'my-plugin'), { recursive: true });

    expect(await removeCompanionState(home)).toBe(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.clubhouse', 'plugin-data', 'my-plugin'))).toBe(true);
    expect(logs).toEqual([expect.objectContaining({ level: 'info', meta: { dir, workspaces: ['my-plugin'] } })]);
  });

  it('does nothing and logs nothing when there are no companion workspaces', async () => {
    expect(await removeCompanionState(home)).toBeNull();
    expect(logs).toEqual([]);
  });

  it('keeps a symlinked workspaces folder, logs it, and leaves its target untouched', async () => {
    const target = path.join(home, 'elsewhere');
    fs.mkdirSync(path.join(target, 'my-plugin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.clubhouse'), { recursive: true });
    const dir = companionWorkspacesDir(home);
    fs.symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir');

    expect(await removeCompanionState(home)).toBeNull();
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(target, 'my-plugin'))).toBe(true);
    expect(logs).toEqual([expect.objectContaining({ level: 'info', meta: { dir } })]);
  });

  it('leaves a plain file at that path alone', async () => {
    const dir = companionWorkspacesDir(home);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a folder');

    expect(await removeCompanionState(home)).toBeNull();
    expect(fs.readFileSync(dir, 'utf-8')).toBe('not a folder');
    expect(logs).toEqual([]);
  });

  it('logs a warning and doesn\'t throw when the delete fails', async () => {
    const dir = companionWorkspacesDir(home);
    fs.mkdirSync(path.join(dir, 'my-plugin'), { recursive: true });
    rmFailure.error = new Error('EBUSY: resource busy');

    expect(await removeCompanionState(home)).toBeNull();
    rmFailure.error = undefined; // afterEach removes the temp home with the same rm
    expect(fs.existsSync(path.join(dir, 'my-plugin'))).toBe(true);
    expect(logs).toEqual([expect.objectContaining({ level: 'warn', meta: { dir, error: 'EBUSY: resource busy' } })]);
  });
});
