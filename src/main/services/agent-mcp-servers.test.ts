import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig, ProjectAgentDefaults } from '../../shared/types';

const h = vi.hoisted(() => ({ defaults: {} as ProjectAgentDefaults }));
const mockManagedMcp = vi.fn(async () => ({ workiq: { command: 'npx' } }));

vi.mock('./managed-agents', () => ({ managedMcpServersFor: (...args: unknown[]) => mockManagedMcp(...(args as [])) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./source-control-settings', () => ({ effectiveAppSourceControlProvider: () => 'github' }));
vi.mock('./agent-settings-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-settings-service')>(),
  readProjectAgentDefaults: vi.fn(async () => h.defaults),
}));

import { appLog } from './log-service';
import { PROJECT_MCP_JSON_INVALID_NOTICE, resolveAgentMcpServers, resolveProjectMcpServers, tomlMcpServerNames } from './agent-mcp-servers';
import { snapshotFile, restoreForAgent } from './config-pipeline';

const conventions = { configDir: '.claude', mcpConfigFile: '.mcp.json', localSettingsFile: 'settings.local.json' } as never;
let worktree: string;

function agent(extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id: 'a', name: 'ada', color: 'indigo', createdAt: '', worktreePath: worktree, ...extra };
}

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-servers-'));
  h.defaults = { mcpJson: JSON.stringify({ mcpServers: { clubhouse: { command: 'bridge' }, linear: { command: 'npx', args: ['linear', '@@AgentName'] } } }) };
  mockManagedMcp.mockClear();
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('managed agents MCP (#2896)', () => {
  it('a managed agent gets its own MCP parts, never project defaults, in terminal and chat', async () => {
    const managed = agent({ managed: { version: 1, blocks: [], skills: [], mcps: ['p'] } });
    await expect(resolveProjectMcpServers('/project', managed)).resolves.toEqual({ workiq: { command: 'npx' } });
    await expect(resolveAgentMcpServers('/project', managed, { cwd: worktree, conventions })).resolves.toEqual({ workiq: { command: 'npx' } });
    expect(mockManagedMcp).toHaveBeenCalledWith(managed);
  });
});

describe('unmanaged agents', () => {
  it('silently ignores a leftover bridge alongside user servers, then removes it on restore', async () => {
    const file = path.join(worktree, '.mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    await snapshotFile('bridge-agent', file);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {
      clubhouse: { command: 'node', args: [path.join(worktree, 'clubhouse-mcp-bridge.js')] },
      own: { command: 'own' },
    } }));
    const onNotice = vi.fn();
    vi.mocked(appLog).mockClear();
    await expect(resolveAgentMcpServers(worktree, agent(), { cwd: worktree, conventions, onNotice }))
      .resolves.toEqual({ own: { command: 'own' } });
    expect(onNotice).not.toHaveBeenCalled();
    expect(appLog).not.toHaveBeenCalled();
    await restoreForAgent('bridge-agent');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { own: { command: 'own' } } });
    await expect(resolveAgentMcpServers(worktree, agent(), { cwd: worktree, conventions, onNotice }))
      .resolves.toEqual({ own: { command: 'own' } });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it.each([
    { command: 'user-server' },
    { command: 'node', args: ['server.js', '--label', 'clubhouse-mcp-bridge'] },
    { command: 'node', args: ['clubhouse-mcp-bridge-wrapper.js'] },
  ])('still rejects a non-bridge server named clubhouse with a notice: %j', async (clubhouse) => {
    fs.writeFileSync(path.join(worktree, '.mcp.json'), JSON.stringify({ mcpServers: {
      clubhouse, own: { command: 'own' },
    } }));
    const onNotice = vi.fn();
    await expect(resolveAgentMcpServers(worktree, agent(), { cwd: worktree, conventions, onNotice }))
      .resolves.toEqual({ own: { command: 'own' } });
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Configured clubhouse entry is reserved'));
    expect(appLog).toHaveBeenCalledWith('core:mcp', 'warn', expect.stringContaining('Configured clubhouse entry is reserved'));
  });

  it('get the project defaults with wildcards filled and the clubhouse entry left out when they have no MCP file', async () => {
    await expect(resolveAgentMcpServers('/project', agent(), { cwd: worktree, conventions })).resolves.toEqual({ linear: { command: 'npx', args: ['linear', 'ada'] } });
  });

  it('use their own MCP file whole, an empty map included, whatever the old Clubhouse Mode setting says', async () => {
    fs.writeFileSync(path.join(worktree, '.mcp.json'), JSON.stringify({ mcpServers: { own: { command: 'own' } } }));
    await expect(resolveAgentMcpServers('/project', agent({ clubhouseModeOverride: undefined }), { cwd: worktree, conventions })).resolves.toEqual({ own: { command: 'own' } });
    fs.writeFileSync(path.join(worktree, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    await expect(resolveAgentMcpServers('/project', agent(), { cwd: worktree, conventions })).resolves.toEqual({});
  });
});

describe('project MCP JSON that is not JSON (D10)', () => {
  const withConditional = '{ "mcpServers": {\n@@If(github)\n"gh": { "command": "gh" }\n@@EndIf\n} }';

  it('gives no project servers with a warning that has a code only, and tells the agent, rather than failing the start', async () => {
    h.defaults = { mcpJson: withConditional };
    const notices: string[] = [];
    await expect(resolveProjectMcpServers('/project', agent(), (m) => notices.push(m))).resolves.toEqual({});
    expect(notices).toEqual([PROJECT_MCP_JSON_INVALID_NOTICE]);
    expect(appLog).toHaveBeenCalledWith('core:mcp', 'warn', expect.any(String), { meta: { code: 'conditional_wildcards' } });

    h.defaults = { mcpJson: '{ not json' };
    await expect(resolveProjectMcpServers('/project')).resolves.toEqual({});
    expect(appLog).toHaveBeenCalledWith('core:mcp', 'warn', expect.any(String), { meta: { code: 'invalid_json' } });
  });

  it('reaches chat through its notices when the agent has no MCP file of its own', async () => {
    h.defaults = { mcpJson: withConditional };
    const onNotice = vi.fn();
    await expect(resolveAgentMcpServers('/project', agent(), { cwd: worktree, conventions, onNotice })).resolves.toEqual({});
    expect(onNotice).toHaveBeenCalledWith(PROJECT_MCP_JSON_INVALID_NOTICE);
  });

  it('still fails on JSON that is not a valid MCP configuration', async () => {
    h.defaults = { mcpJson: JSON.stringify({ servers: {} }) };
    await expect(resolveProjectMcpServers('/project', agent())).rejects.toThrow(/mcpServers/);
  });
});

describe('tomlMcpServerNames (#2849)', () => {
  const names = (toml: string) => tomlMcpServerNames(toml);
  it('reads server names from tables, quoted or bare, and from dotted keys', () => {
    expect(names('[mcp_servers.linear]\ncommand = "npx"\n')).toEqual({ names: ['linear'], unknown: false });
    expect(names('model = "o3"\r\n\r\n  [ mcp_servers."my server" ]\r\n').names).toEqual(['my server']);
    expect(names('[mcp_servers.docs.env]\nKEY = "v"\n[mcp_servers.docs]\n').names).toEqual(['docs']);
    expect(names('mcp_servers.linear.command = "npx"\n').names).toEqual(['linear']);
    expect(names('["mcp_servers".linear]\ncommand = "npx"\n').names).toEqual(['linear']);
    expect(names('\uFEFF[mcp_servers.linear]\ncommand = "npx"\n').names).toEqual(['linear']);
    expect(names('[mcp_servers.clubhouse]\ncommand = "node"\n[mcp_servers.linear]\n').names).toEqual(['clubhouse', 'linear']);
  });

  it('says when servers are listed in a form whose names it does not read', () => {
    expect(names('[mcp_servers]\nlinear = { command = "npx" }\n')).toEqual({ names: [], unknown: true });
    expect(names('mcp_servers = { linear = { command = "npx" } }\n')).toEqual({ names: [], unknown: true });
  });

  it('finds nothing in other tables, keys or comments', () => {
    expect(names('')).toEqual({ names: [], unknown: false });
    expect(names('model = "o3"\n[profiles.fast]\nmodel = "o4"\nmcp_servers_note = "x"\n')).toEqual({ names: [], unknown: false });
    expect(names('# [mcp_servers.linear]\n')).toEqual({ names: [], unknown: false });
  });
});
