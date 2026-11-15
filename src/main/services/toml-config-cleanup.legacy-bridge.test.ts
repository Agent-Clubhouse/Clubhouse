import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getBridgeScriptPath } from './clubhouse-mcp/injection';
import { injectMcpServerSection } from './toml-utils';
import { stripLegacyClubhouseBridgeToml } from './toml-config-cleanup';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

const conventions = {
  configDir: '.codex',
  localInstructionsFile: 'AGENTS.md',
  legacyInstructionsFile: 'AGENTS.md',
  mcpConfigFile: '.codex/config.toml',
  localSettingsFile: 'config.toml',
  settingsFormat: 'toml' as const,
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
};

/** The section an older Clubhouse injected, as injectClubhouseMcp wrote it. */
const withBridge = (toml: string) => injectMcpServerSection(toml, 'clubhouse', {
  command: 'node',
  args: [getBridgeScriptPath()],
  env: { CLUBHOUSE_MCP_PORT: '23456', CLUBHOUSE_AGENT_ID: 'agent-1' },
  env_vars: ['CLUBHOUSE_HOOK_NONCE'],
});

describe('stripLegacyClubhouseBridgeToml (#1728)', () => {
  let cwd: string;
  let codexDir: string;
  let configPath: string;

  beforeEach(async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-codex-toml-'));
    codexDir = path.join(cwd, '.codex');
    configPath = path.join(codexDir, 'config.toml');
    await fsp.mkdir(codexDir);
  });

  afterEach(async () => {
    await fsp.rm(cwd, { recursive: true, force: true });
  });

  it('deletes a config holding only the injected bridge, and the folder it leaves empty', async () => {
    await fsp.writeFile(configPath, withBridge(''));
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(true);
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the user\'s settings and servers, and the folder', async () => {
    const user = 'model = "saved-legacy-model"\n\n[mcp_servers.github]\ncommand = "gh"\n';
    await fsp.writeFile(configPath, withBridge(user));
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(true);
    const left = await fsp.readFile(configPath, 'utf-8');
    expect(left).toContain('model = "saved-legacy-model"');
    expect(left).toContain('[mcp_servers.github]');
    expect(left).not.toContain('mcp_servers.clubhouse');
  });

  it('keeps a folder with other files when the config goes', async () => {
    await fsp.writeFile(configPath, withBridge(''));
    await fsp.writeFile(path.join(codexDir, 'hooks.json'), '{"hooks":{}}');
    await stripLegacyClubhouseBridgeToml(cwd, conventions);
    await expect(fsp.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readFile(path.join(codexDir, 'hooks.json'), 'utf-8')).toBe('{"hooks":{}}');
  });

  it('leaves a user\'s own server named clubhouse alone', async () => {
    const user = '[mcp_servers.clubhouse]\ncommand = "my-clubhouse-server"\n';
    await fsp.writeFile(configPath, user);
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
    expect(await fsp.readFile(configPath, 'utf-8')).toBe(user);
  });

  it('does nothing without a config file', async () => {
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
    expect((await fsp.stat(codexDir)).isDirectory()).toBe(true);
  });
});
