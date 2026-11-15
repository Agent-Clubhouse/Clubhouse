import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CLUBHOUSE_BRIDGE_ENV_VARS, getBridgeScriptPath } from './clubhouse-mcp/injection';
import { injectMcpServerSection } from './toml-utils';
import { isClubhouseBridgeOnlyToml, stripLegacyClubhouseBridgeToml } from './toml-config-cleanup';

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

/** A file as injectClubhouseMcp wrote it into an empty .codex/config.toml, today's bridge definition. */
const current = (bridgePath = getBridgeScriptPath()) => injectMcpServerSection('', 'clubhouse', {
  command: 'node',
  args: [bridgePath],
  env: { CLUBHOUSE_MCP_FALLBACK_PORT: '23456', CLUBHOUSE_MCP_FALLBACK_AGENT_ID: 'durable_1731-abc' },
  env_vars: [...CLUBHOUSE_BRIDGE_ENV_VARS],
});
/** The same, with the bridge definition from before #2222. */
const beforeNonceFix = (env: Record<string, string> = {
  CLUBHOUSE_MCP_PORT: '51234', CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_HOOK_NONCE: '3f2b8c1e-0a4d-4f6e-9b7a-1c2d3e4f5a6b',
}) => injectMcpServerSection('', 'clubhouse', { command: 'node', args: ['/Applications/Clubhouse.app/Contents/Resources/app.asar.unpacked/.webpack/main/bridge/clubhouse-mcp-bridge.js'], env });

describe('isClubhouseBridgeOnlyToml (#1728)', () => {
  it('recognises every file Clubhouse wrote on its own', () => {
    expect(isClubhouseBridgeOnlyToml(current())).toBe(true);
    expect(isClubhouseBridgeOnlyToml(current('C:\\Users\\me\\AppData\\Local\\clubhouse\\app-0.42.0\\resources\\app.asar.unpacked\\.webpack\\main\\bridge\\clubhouse-mcp-bridge.js'))).toBe(true);
    expect(isClubhouseBridgeOnlyToml(beforeNonceFix())).toBe(true);
    // A snapshot restore scrubbed the nonce line from the older file.
    expect(isClubhouseBridgeOnlyToml(beforeNonceFix({ CLUBHOUSE_MCP_PORT: '51234', CLUBHOUSE_AGENT_ID: 'agent-1' }))).toBe(true);
  });

  it('ignores line endings and trailing whitespace', () => {
    expect(isClubhouseBridgeOnlyToml(current().replace(/\n/g, '\r\n'))).toBe(true);
    expect(isClubhouseBridgeOnlyToml(current().replace(/\n/g, '   \n') + '\n\n')).toBe(true);
  });

  it('rejects anything a person could have added or changed', () => {
    const variants = [
      // User settings beside the bridge.
      `model = "o3"\n\n${current()}`,
      `${current()}\n[mcp_servers.github]\ncommand = "gh"\n`,
      `${current()}  [mcp_servers.user]\n  command = "mine"\n`,
      `notes = """\n\n\n[x]\n"""\n${current()}`,
      // A user env setting or forwarded variable that shares the prefix.
      current().replace('CLUBHOUSE_MCP_FALLBACK_AGENT_ID', 'CLUBHOUSE_USER_SETTING = "x"\nCLUBHOUSE_MCP_FALLBACK_AGENT_ID'),
      current().replace('"CLUBHOUSE_MCP_PORT"]', '"CLUBHOUSE_MCP_PORT", "CLUBHOUSE_MY_API_KEY"]'),
      // Comments, extra keys and edited values.
      current().replace('command = "node"', '# mine now\ncommand = "node"'),
      current().replace('command = "node"', 'command = "node"\nstartup_timeout_sec = 30'),
      current().replace('command = "node"', 'command = "/usr/local/bin/node"'),
      current().replace('clubhouse-mcp-bridge.js', 'clubhouse-mcp-bridge.js", "--debug'),
      // Duplicate keys and malformed TOML.
      current().replace(/(CLUBHOUSE_MCP_FALLBACK_AGENT_ID = .*)/, '$1\n$1'),
      `model = definitely-not-toml\n${current()}`,
      current().replace('command = "node"', 'command = "node'),
      `${current()}\n[mcp_servers.clubhouse]\ncommand = "node"\n`,
      // Other bridge-looking servers.
      current('/x/other-bridge.js'),
      current().replace('[mcp_servers.clubhouse]', '[mcp_servers.my_clubhouse]').replace('[mcp_servers.clubhouse.env]', '[mcp_servers.my_clubhouse.env]'),
      '',
    ];
    for (const variant of variants) expect(isClubhouseBridgeOnlyToml(variant), variant).toBe(false);
  });
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

  it('deletes a Clubhouse-only config, and the folder it leaves empty', async () => {
    await fsp.writeFile(configPath, current());
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(true);
    await expect(fsp.stat(codexDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a folder with other files when the config goes', async () => {
    await fsp.writeFile(configPath, current());
    await fsp.writeFile(path.join(codexDir, 'hooks.json'), '{"hooks":{}}');
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(true);
    await expect(fsp.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readFile(path.join(codexDir, 'hooks.json'), 'utf-8')).toBe('{"hooks":{}}');
  });

  it('leaves any other file byte for byte, bridge included', async () => {
    for (const user of [
      `model = "saved-legacy-model"\n\n${current()}`,
      '[mcp_servers.clubhouse]\ncommand = "my-clubhouse-server"\n',
      current().replace(/(CLUBHOUSE_MCP_FALLBACK_AGENT_ID = .*)/, '$1\n$1'),
      `${current()}  [mcp_servers.user]\n  command = "mine"\n`,
    ]) {
      await fsp.writeFile(configPath, user);
      expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
      expect(await fsp.readFile(configPath, 'utf-8')).toBe(user);
    }
  });

  it('does nothing without a config file', async () => {
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
    expect((await fsp.stat(codexDir)).isDirectory()).toBe(true);
  });
});
