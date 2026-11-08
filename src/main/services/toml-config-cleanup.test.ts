import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import * as fsp from 'fs/promises';
import { cleanupStaleJsonInTomlConfigs } from './toml-config-cleanup';

const tomlConventions = {
  configDir: '.codex',
  localInstructionsFile: 'AGENTS.md',
  legacyInstructionsFile: 'AGENTS.md',
  mcpConfigFile: '.codex/config.toml',
  localSettingsFile: 'config.toml',
  settingsFormat: 'toml' as const,
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
};

describe('cleanupStaleJsonInTomlConfigs', () => {
  beforeEach(() => {
    vi.mocked(fsp.readFile).mockReset();
    vi.mocked(fsp.unlink).mockReset();
    vi.mocked(fsp.unlink).mockResolvedValue(undefined);
  });

  it('removes file that starts with { (JSON object)', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('{"mcpServers": {}}');
    await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);
    expect(fsp.unlink).toHaveBeenCalled();
  });

  it('does not remove file that starts with [ (could be TOML section header)', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('[{"test": true}]');
    await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it('removes file with leading whitespace before JSON', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('  \n  {"mcpServers": {}}');
    await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);
    expect(fsp.unlink).toHaveBeenCalled();
  });

  it('does not remove valid TOML content', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('[mcpServers]\nfoo = "bar"');
    await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it('does nothing when file does not exist', async () => {
    vi.mocked(fsp.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it('deduplicates paths when mcpConfigFile and configDir/localSettingsFile resolve to same path', async () => {
    vi.mocked(fsp.readFile).mockResolvedValue('{"stale": true}');
    await cleanupStaleJsonInTomlConfigs('/worktree', tomlConventions);
    expect(fsp.unlink).toHaveBeenCalledTimes(1);
  });
});
