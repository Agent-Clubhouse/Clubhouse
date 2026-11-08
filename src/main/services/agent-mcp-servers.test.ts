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
import { PROJECT_MCP_JSON_INVALID_NOTICE, resolveAgentMcpServers, resolveProjectMcpServers } from './agent-mcp-servers';

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
