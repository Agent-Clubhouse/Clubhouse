import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodexCliProvider } from '../orchestrators/codex-cli-provider';
import { _resetForTesting, restoreForAgent, snapshotFile, stripClubhouseHooksFromFile } from './config-pipeline';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe('Codex hook directory cleanup', () => {
  let cwd: string;
  let codexDir: string;
  let hooksPath: string;

  beforeEach(async () => {
    _resetForTesting();
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-codex-hooks-'));
    codexDir = path.join(cwd, '.codex');
    hooksPath = path.join(codexDir, 'hooks.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetForTesting();
    await fsp.rm(cwd, { recursive: true, force: true });
  });

  it('writes working hooks, then removes the empty directory on restore', async () => {
    await snapshotFile('dispatcher', hooksPath);
    await new CodexCliProvider().writeHooksConfig(cwd, 'http://127.0.0.1:9999/hook');
    expect(JSON.parse(await fsp.readFile(hooksPath, 'utf-8')).hooks.Stop).toHaveLength(1);

    await restoreForAgent('dispatcher');

    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the empty directory when stopped-agent hooks are stripped', async () => {
    await new CodexCliProvider().writeHooksConfig(cwd, 'http://127.0.0.1:9999/hook');
    expect(await stripClubhouseHooksFromFile(hooksPath)).toBe(true);
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a leftover empty directory even when hooks are already absent', async () => {
    await fsp.mkdir(codexDir);
    expect(await stripClubhouseHooksFromFile(hooksPath)).toBe(false);
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves user config and hooks during cleanup', async () => {
    await fsp.mkdir(codexDir);
    const configPath = path.join(codexDir, 'config.toml');
    const config = 'model = "saved-legacy-model"\n';
    const userHooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } };
    await fsp.writeFile(configPath, config);
    await fsp.writeFile(hooksPath, JSON.stringify(userHooks));
    await snapshotFile('dispatcher', hooksPath);
    await new CodexCliProvider().writeHooksConfig(cwd, 'http://127.0.0.1:9999/hook');

    await restoreForAgent('dispatcher');

    expect(await fsp.readFile(configPath, 'utf-8')).toBe(config);
    expect(JSON.parse(await fsp.readFile(hooksPath, 'utf-8'))).toEqual(userHooks);
  });

  it('preserves other files when removing generated hooks', async () => {
    await snapshotFile('dispatcher', hooksPath);
    await new CodexCliProvider().writeHooksConfig(cwd, 'http://127.0.0.1:9999/hook');
    await fsp.writeFile(path.join(codexDir, 'config.toml'), 'model = "saved-model"');
    await restoreForAgent('dispatcher');
    expect(await fsp.readFile(path.join(codexDir, 'config.toml'), 'utf-8')).toBe('model = "saved-model"');
    await expect(fsp.stat(hooksPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes an empty directory after a failed hooks write', async () => {
    vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('write failed'));
    await expect(new CodexCliProvider().writeHooksConfig(cwd, 'http://127.0.0.1:9999/hook')).rejects.toThrow('write failed');
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
