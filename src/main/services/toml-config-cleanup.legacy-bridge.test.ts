import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getBridgeScriptPath } from './clubhouse-mcp/injection';
import { injectMcpServerSection, mcpServerToToml } from './toml-utils';
import { stripLegacyClubhouseBridgeToml, withoutInjectedBridgeSection } from './toml-config-cleanup';

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

  it('keeps a user server that mentions the bridge in a comment or env value', async () => {
    for (const user of [
      '[mcp_servers.clubhouse]\n# was clubhouse-mcp-bridge.js\ncommand = "my-server"\n',
      '[mcp_servers.clubhouse]\ncommand = "my-server"\n\n[mcp_servers.clubhouse.env]\nNOTE = "/x/clubhouse-mcp-bridge.js"\n',
      // The exact shape plus one comment is no longer only what Clubhouse wrote.
      withBridge('').replace('[mcp_servers.clubhouse]\n', '[mcp_servers.clubhouse]\n# mine now\n'),
      withBridge('').replace('command = "node"', 'command = "node"\nstartup_timeout_sec = 30'),
    ]) {
      await fsp.writeFile(configPath, user);
      expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
      expect(await fsp.readFile(configPath, 'utf-8')).toBe(user);
    }
  });

  it('leaves a section whose values are not valid TOML untouched', async () => {
    for (const broken of [
      withBridge('').replace('command = "node"', 'command = "node'),
      withBridge('').replace(/args = \[(.*)\]/, 'args = [$1'),
      `${withBridge('')}\n[mcp_servers.clubhouse]\ncommand = "node"\n`,
    ]) {
      await fsp.writeFile(configPath, broken);
      expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
      expect(await fsp.readFile(configPath, 'utf-8')).toBe(broken);
    }
  });

  it('removes only the section\'s lines, keeping the rest byte for byte', async () => {
    const before = '# my settings\nmodel   =  "o3"   # inline\n\n';
    const after = '[mcp_servers.github]\ncommand = "gh"\n';
    const section = mcpServerToToml('clubhouse', { command: 'node', args: [getBridgeScriptPath()], env: { CLUBHOUSE_MCP_FALLBACK_PORT: '1' } });
    // The blank line after the section is the section's; the one before is the user's.
    expect(withoutInjectedBridgeSection(`${before}${section}\n\n${after}`)).toBe(`${before}${after}`);
  });

  it('keeps an indented user table that follows the section (QA #3527)', async () => {
    const user = '  [mcp_servers.user]\n  command = "mine"\n';
    await fsp.writeFile(configPath, `${withBridge('')}${user}`);
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(true);
    expect(await fsp.readFile(configPath, 'utf-8')).toBe(user);
  });

  it('keeps multiline strings byte for byte, and isn\'t fooled by a header inside one', async () => {
    const user = 'notes = """\nfirst\n\n\n\n[mcp_servers.clubhouse]\nlast"""\nraw = \'\'\'\n[x]\n\'\'\'\n';
    await fsp.writeFile(configPath, `${user}\n${withBridge('')}`);
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(true);
    expect(await fsp.readFile(configPath, 'utf-8')).toBe(`${user}\n`);
  });

  it('isn\'t fooled by a [ line inside a multiline array', () => {
    const user = 'matrix = [\n[1, 2],\n  [3, 4],\n]\n';
    expect(withoutInjectedBridgeSection(`${user}${withBridge('')}`)).toBe(user);
  });

  it('leaves the bridge alone when something else adds to its table', () => {
    for (const extra of [
      'mcp_servers.clubhouse.startup_timeout_sec = 30\n',
      '[mcp_servers]\nclubhouse.enabled = false\n',
      '[mcp_servers."clubhouse".tools]\nx = 1\n',
      '  [ mcp_servers . clubhouse ]\ncommand = "dup"\n',
    ]) {
      expect(withoutInjectedBridgeSection(`${extra}\n${withBridge('')}`)).toBeNull();
    }
  });

  it('leaves malformed TOML elsewhere in the file untouched', async () => {
    for (const broken of [
      `title = "unterminated\n${withBridge('')}`,
      `notes = """never closed\n${withBridge('')}`,
      `list = [1, 2\n${withBridge('')}`,
      `[unclosed\n${withBridge('')}`,
      `just words\n${withBridge('')}`,
    ]) {
      await fsp.writeFile(configPath, broken);
      expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
      expect(await fsp.readFile(configPath, 'utf-8')).toBe(broken);
    }
  });

  it('recognises every shape Clubhouse wrote, Windows paths included', () => {
    const shapes = [
      // Before #2222: port, agent id and nonce in env, no env_vars.
      { command: 'node', args: ['/Applications/Clubhouse.app/Contents/Resources/app.asar.unpacked/.webpack/main/bridge/clubhouse-mcp-bridge.js'], env: { CLUBHOUSE_MCP_PORT: '1', CLUBHOUSE_AGENT_ID: 'a-1', CLUBHOUSE_HOOK_NONCE: 'n' } },
      { command: 'node', args: ['C:\\Users\\me\\AppData\\Local\\clubhouse\\bridge\\clubhouse-mcp-bridge.js'], env: { CLUBHOUSE_MCP_FALLBACK_PORT: '1', CLUBHOUSE_MCP_FALLBACK_AGENT_ID: 'a-1' }, env_vars: ['CLUBHOUSE_MCP_PORT', 'CLUBHOUSE_HOOK_NONCE'] },
      { command: 'node', args: ['/x/clubhouse-mcp-bridge.js'] },
    ];
    for (const def of shapes) {
      expect(withoutInjectedBridgeSection(`${mcpServerToToml('clubhouse', def)}\n`)).toBe('');
      expect(withoutInjectedBridgeSection(`${mcpServerToToml('clubhouse', def).replace(/\n/g, '\r\n')}\r\n`)).toBe('');
    }
    expect(withoutInjectedBridgeSection(mcpServerToToml('clubhouse', { command: 'node', args: ['/x/other.js'] }))).toBeNull();
    expect(withoutInjectedBridgeSection(mcpServerToToml('clubhouse', { command: 'python', args: ['/x/clubhouse-mcp-bridge.js'] }))).toBeNull();
  });

  it('does nothing without a config file', async () => {
    expect(await stripLegacyClubhouseBridgeToml(cwd, conventions)).toBe(false);
    expect((await fsp.stat(codexDir)).isDirectory()).toBe(true);
  });
});
