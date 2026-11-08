import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugin-manifest-registry', () => ({ getManifest: vi.fn(() => ({ permissions: ['mcp.tools'] })) }));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));
vi.mock('./mcp-call-gate', async (original) => ({ ...await original<typeof import('./mcp-call-gate')>(), mcpCallAccess: () => 'open' }));

import { getScopedToolList, listToolGrants, _resetForTesting } from './tool-registry';
import { toolGrantDeclarations } from './tool-grants';
import { mcpAdapter } from './mcp-adapter';
import { registerClubhouseMcpTools } from './tools/register-all';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { _resetOrchestrationGateForTesting, setOrchestrationEnabled } from './orchestration-gate';
import {
  _resetDispatcherGateForTesting, isDispatcherAgent, isDispatcherChatAgent, isTrackedDispatcher, setDispatcherAgent, setDispatcherChatAgent,
} from './dispatcher-gate';
import { callerGrants } from './grant-check';

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
});

describe('the Dispatcher\'s chat', () => {
  it('is offered reading tools and start_work, and nothing that acts', () => {
    // update_agent and update_project name their target in the arguments, so a listing can't
    // check it; the call is refused (below: the chat holds no agent.display or project.display).
    expect(names('chat')).toEqual(['inspect_helper', 'list_agents', 'list_settings', 'read_helper_presets', 'read_memory', 'read_settings', 'start_work', 'update_agent', 'update_project']);
    for (const name of ['update_agent', 'update_project']) {
      const tool = listToolGrants().find((t) => t.kind === 'global' && t.name === name)!;
      const actions = toolGrantDeclarations(tool.grant!).flatMap((d) => d.actions);
      expect(actions.some((action) => callerGrants('chat').some((g) => g.action === action)), name).toBe(false);
    }
  });

  it('never gets the orchestration tools, whatever its policy says', () => {
    setOrchestrationEnabled('chat', true, { crossProject: true });
    expect(names('chat')).not.toContain('start_helper');
    expect(names('chat')).not.toContain('list_projects');
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

describe('the Dispatcher', () => {
  it('keeps its own tools, gets tell_user, and is not offered start_work', () => {
    const tools = names('dispatcher');
    expect(tools).toEqual(expect.arrayContaining(['list_agents', 'inspect_helper', 'tell_user', 'create_action']));
    expect(tools).not.toContain('start_work');
    expect(tools).not.toContain('read_memory');
  });

  it('is not offered tell_user once it is tracked as the chat instead', () => {
    setDispatcherChatAgent('dispatcher', true);
    expect(isDispatcherAgent('dispatcher')).toBe(false);
    expect(names('dispatcher')).not.toContain('tell_user');
  });
});
