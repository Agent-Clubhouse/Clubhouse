import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));
vi.mock('./mcp-call-gate', async (original) => ({ ...await original<typeof import('./mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
// list_projects (#3913): registered projects, one of them with no agents at all.
const registered = vi.hoisted(() => [
  { id: 'proj_goobers', name: 'goobers', path: '/work/goobers' },
  { id: 'proj_kaizen', name: 'kaizen', displayName: 'Kaizen', path: '/work/kaizen' },
]);
vi.mock('../project-store', async (original) => ({ ...await original<typeof import('../project-store')>(), list: async () => [...registered] }));
vi.mock('../git-service', async (original) => ({
  ...await original<typeof import('../git-service')>(),
  findGitCommonDir: async (dir: string) => `${dir}/.git`,
  getDefaultBranch: async () => 'main',
}));
vi.mock('../agent-config', async (original) => ({
  ...await original<typeof import('../agent-config')>(),
  getDurableConfig: async (_projectPath: string, id: string) => ({ id, name: id }),
  isSameProject: async (a: string, b: string) => a === b,
}));
// start_work's one effect: filing the request with the Dispatcher (#3578).
const handOff = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ outcome: 'delivered', requestId: 'req_1' })));
vi.mock('../dispatcher/dispatcher-channel', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-channel')>(),
  handOffToDispatcher: handOff,
}));

import { callTool, getScopedToolList, listToolGrants, _resetForTesting } from './tool-registry';
import { toolGrantDeclarations } from './tool-grants';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { _resetOrchestrationGateForTesting, setOrchestrationEnabled } from './orchestration-gate';
import {
  _resetDispatcherGateForTesting, isDispatcherAgent, isDispatcherChatAgent, isTrackedDispatcher, setDispatcherAgent, setDispatcherChatAgent,
} from './dispatcher-gate';
import { callerGrants } from './grant-check';
import { agentRegistry } from '../agent-registry';
import { DISPATCHER_CHAT_INSTRUCTIONS } from '../dispatcher/dispatcher-service';

/**
 * The Dispatcher's chat (#3036) reads, and hands work to the Dispatcher; it
 * never acts on agents. These are the tools it is offered, from the real
 * registrations through the real groups and grant check.
 */

const PROJECT = '/p';

function names(agentId: string): string[] {
  return getScopedToolList(agentId).map((t) => t.name).sort();
}

beforeEach(() => {
  _resetForTesting();
  mcpAdapter._resetForTesting();
  _resetMcpCallGateForTesting();
  _resetOrchestrationGateForTesting();
  _resetDispatcherGateForTesting();
  registerClubhouseMcpTools();
  setMcpCaller('chat', PROJECT, {});
  setMcpCaller('dispatcher', PROJECT, {});
  setDispatcherChatAgent('chat', true);
  setDispatcherAgent('dispatcher', true);
  handOff.mockClear();
});

describe('the Dispatcher\'s chat', () => {
  it('is offered reading tools and start_work, and nothing that acts', () => {
    // update_agent and update_project name their target in the arguments, so a listing can't
    // check it; the call is refused (below: the chat holds no agent.display or project.display).
    expect(names('chat')).toEqual(['get_annex_network_settings', 'get_delivery', 'inspect_helper', 'list_abilities', 'list_agents', 'list_group_projects', 'list_other_dispatchers', 'list_projects', 'list_settings', 'read_agent_config', 'read_helper_presets', 'read_memory', 'read_settings', 'search_memory', 'start_work', 'update_agent', 'update_project']);
    expect(names('chat')).not.toContain('open_group_project_directory');
    for (const name of ['update_agent', 'update_project']) {
      const tool = listToolGrants().find((t) => t.kind === 'global' && t.name === name)!;
      const actions = toolGrantDeclarations(tool.grant!).flatMap((d) => d.actions);
      expect(actions.some((action) => callerGrants('chat').some((g) => g.action === action)), name).toBe(false);
    }
  });

  it('never gets the orchestration tools, whatever its policy says', () => {
    setOrchestrationEnabled('chat', true, { crossProject: true });
    expect(names('chat')).not.toContain('start_helper');
  });

  it('has no grant that acts on an agent, a project, an Action or a setting', () => {
    const acting = callerGrants('chat').filter((g) => !g.action.endsWith('.read') && g.mode !== 'off');
    expect(acting).toEqual([
      { action: 'agent.message', target: { kind: 'self' }, mode: 'allow', source: 'structural' },
      // Waking the Dispatcher alone, for a hand-off to a sleeping one (#3037).
      { action: 'agent.wake', target: { kind: 'connected', onlyDispatcher: true }, mode: 'allow', source: 'structural' },
    ]);
  });

  it('is tracked apart from the Dispatcher, and both lose their tools when untracked', () => {
    expect(isDispatcherChatAgent('chat')).toBe(true);
    expect(isDispatcherAgent('chat')).toBe(false);
    expect(isTrackedDispatcher('chat')).toBe(true);
    setDispatcherAgent('chat', false);
    expect(isTrackedDispatcher('chat')).toBe(false);
    expect(names('chat')).not.toContain('start_work');
  });
});

describe('the Dispatcher\'s chat and project questions (#3913)', () => {
  it('lists a registered project that has no agents, with names, paths and branches only', async () => {
    agentRegistry.register('chat', { projectPath: PROJECT, orchestrator: 'claude-code', runtime: 'chat' });
    expect(names('chat')).toContain('list_projects');
    const result = await callTool('chat', 'list_projects', {});
    expect(result.isError).toBeFalsy();
    // No agent is connected to the chat, yet both projects are listed.
    expect(JSON.parse(result.content[0].text)).toEqual({
      projects: [
        { name: 'goobers', path: '/work/goobers', defaultBranch: 'main' },
        { name: 'Kaizen', path: '/work/kaizen', defaultBranch: 'main' },
      ],
    });
    // It reads with project.read, which the chat holds; no write or display grant comes with it.
    const tool = listToolGrants().find((t) => t.kind === 'global' && t.name === 'list_projects')!;
    expect(toolGrantDeclarations(tool.grant!).flatMap((d) => d.actions)).toEqual(['project.read']);
  });

  it('is told that list_agents is not a project list', () => {
    expect(DISPATCHER_CHAT_INSTRUCTIONS).toContain('`list_projects`');
    expect(DISPATCHER_CHAT_INSTRUCTIONS).toMatch(/list_agents. lists agents, not projects/);
  });
});

describe('the Dispatcher', () => {
  it('keeps its own tools, gets tell_user, and is not offered start_work', () => {
    const tools = names('dispatcher');
    expect(tools).toEqual(expect.arrayContaining(['list_agents', 'inspect_helper', 'tell_user', 'create_action', 'search_memory', 'read_memory', 'write_memory']));
    expect(tools).not.toContain('start_work');
    expect(names('chat')).not.toContain('write_memory');
    setMcpCaller('ordinary', PROJECT, {});
    expect(names('ordinary')).not.toContain('write_memory');
  });

  it('is not offered tell_user once it is tracked as the chat instead', () => {
    setDispatcherChatAgent('dispatcher', true);
    expect(isDispatcherAgent('dispatcher')).toBe(false);
    expect(names('dispatcher')).not.toContain('tell_user');
  });
});

describe('a relayed merge or release go-ahead (#3578)', () => {
  // What the Auto classifier refused: the chat relaying the user's approval for a merge and a release.
  const relay = 'The user said yes, merge #517, then tag 1.0 and publish the release notes.';

  it('goes from the chat through Clubhouse\'s group and grant check, and only files a request with the Dispatcher', async () => {
    const result = await callTool('chat', 'start_work', { request: relay });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Request req_1 is under way') });
    expect(handOff).toHaveBeenCalledExactlyOnceWith('chat', relay, undefined);
    // Its grant is a message to its own Dispatcher, nothing that merges, releases or changes an agent.
    const startWork = listToolGrants().find((t) => t.kind === 'global' && t.name === 'start_work')!;
    expect(toolGrantDeclarations(startWork.grant!)).toEqual([{ actions: ['agent.message'], target: 'self' }]);
  });

  it('is refused by Clubhouse for any agent but the chat, whatever its CLI allows', async () => {
    setMcpCaller('ordinary', PROJECT, {});
    for (const caller of ['ordinary', 'dispatcher']) {
      expect((await callTool(caller, 'start_work', { request: relay })).isError, caller).toBe(true);
    }
    expect(handOff).not.toHaveBeenCalled();
  });

  it('leaves the acting to the Dispatcher, whose tools still need its own connections and grants', async () => {
    await callTool('chat', 'start_work', { request: relay });
    // Reaching a project agent takes a wire the user made: with none, the Dispatcher's message is refused.
    const refused = await callTool('dispatcher', 'clubhouse__release_lead__send_message', { message: relay });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({ text: expect.stringContaining('No connection found') });
    // And the chat itself has no wire tools to act with.
    expect((await callTool('chat', 'clubhouse__release_lead__send_message', { message: relay })).isError).toBe(true);
  });
});
