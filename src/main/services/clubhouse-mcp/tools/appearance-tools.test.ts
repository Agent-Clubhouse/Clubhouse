import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateProjectAppearance: vi.fn(async () => ({ id: 'p1' })),
  updateAgentAppearance: vi.fn(async () => ({ id: 'a1' })),
}));

vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../appearance-service', async () => {
  class AppearanceError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return { AppearanceError, ...mocks };
});
vi.mock('../dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher',
}));

import { AppearanceError } from '../../appearance-service';
import { agentRegistry } from '../../agent-registry';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { registerAppearanceTools } from './appearance-tools';

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content[0].text ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  registerAppearanceTools();
  agentRegistry.register('a1', { projectPath: '/one', cwd: '/one/worktree', orchestrator: 'claude-code', runtime: 'chat' });
  agentRegistry.register('dispatcher', { projectPath: '/dispatcher', orchestrator: 'claude-code', runtime: 'chat' });
});

describe('appearance tools', () => {
  it('lists both tools for any agent, with no name on update_agent', () => {
    const tools = getScopedToolList('a1');
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['update_project', 'update_agent']));
    const updateAgent = tools.find((t) => t.name === 'update_agent')!;
    expect(Object.keys(updateAgent.inputSchema.properties as object)).toEqual(['agent_id', 'color', 'emoji', 'image_path']);
  });

  it('asks as an agent in its own scope, with its working directory', async () => {
    await callTool('a1', 'update_project', { display_name: 'Shiny', color: 'rose', emoji: '', image_path: '/i.png' });
    expect(mocks.updateProjectAppearance).toHaveBeenCalledWith(
      { scope: 'own', agentId: 'a1', projectPath: '/one', cwd: '/one/worktree' },
      undefined,
      { displayName: 'Shiny', color: 'rose', emoji: '', imagePath: '/i.png' },
    );
    await callTool('a1', 'update_agent', { agent_id: 'a2', color: 'teal' });
    expect(mocks.updateAgentAppearance).toHaveBeenCalledWith(
      { scope: 'own', agentId: 'a1', projectPath: '/one', cwd: '/one/worktree' },
      'a2',
      { color: 'teal' },
    );
  });

  it('asks with full scope for the Dispatcher', async () => {
    await callTool('dispatcher', 'update_project', { project: 'two', color: 'teal' });
    expect(mocks.updateProjectAppearance).toHaveBeenCalledWith({ scope: 'all', agentId: 'dispatcher', cwd: '/dispatcher' }, 'two', { color: 'teal' });
  });

  it('lets the Dispatcher ask about itself, by default or by id (#2645)', async () => {
    await callTool('dispatcher', 'update_agent', { color: 'teal' });
    expect(mocks.updateAgentAppearance).toHaveBeenLastCalledWith({ scope: 'all', agentId: 'dispatcher', cwd: '/dispatcher' }, undefined, { color: 'teal' });
    await callTool('dispatcher', 'update_agent', { agent_id: 'dispatcher', emoji: '🦊' });
    expect(mocks.updateAgentAppearance).toHaveBeenLastCalledWith({ scope: 'all', agentId: 'dispatcher', cwd: '/dispatcher' }, 'dispatcher', { emoji: '🦊' });
  });

  it('asks with its own scope when another agent names the Dispatcher', async () => {
    await callTool('a1', 'update_agent', { agent_id: 'dispatcher', color: 'teal' });
    expect(mocks.updateAgentAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'own', agentId: 'a1' }), 'dispatcher', { color: 'teal' });
  });

  it('returns what changed', async () => {
    expect(JSON.parse(text(await callTool('a1', 'update_project', { color: 'rose' })))).toEqual({ project: { id: 'p1' } });
    expect(JSON.parse(text(await callTool('a1', 'update_agent', { color: 'rose' })))).toEqual({ agent: { id: 'a1' } });
  });

  it.each([
    ['update_agent', { name: 'renamed' }, 'name'],
    ['update_agent', { model: 'opus', color: 'rose' }, 'model'],
    ['update_project', { name: 'folder' }, 'name'],
    ['update_project', { orchestrator: 'codex-cli' }, 'orchestrator'],
  ])('refuses %s with a setting it does not change', async (tool, args, field) => {
    const result = await callTool('a1', tool, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`can't change ${field}`);
    expect(mocks.updateProjectAppearance).not.toHaveBeenCalled();
    expect(mocks.updateAgentAppearance).not.toHaveBeenCalled();
  });

  it('passes a refusal back as the tool error', async () => {
    mocks.updateAgentAppearance.mockRejectedValueOnce(new AppearanceError('out_of_scope', 'You can only change yourself.'));
    const result = await callTool('a1', 'update_agent', { agent_id: 'a2', color: 'teal' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('You can only change yourself.');
  });

  it('refuses a field of the wrong type', async () => {
    const result = await callTool('a1', 'update_agent', { color: 7 });
    expect(result.isError).toBe(true);
    expect(mocks.updateAgentAppearance).not.toHaveBeenCalled();
  });

  it('refuses an agent Clubhouse does not know', async () => {
    const result = await callTool('ghost', 'update_project', { color: 'rose' });
    expect(result.isError).toBe(true);
    expect(mocks.updateProjectAppearance).not.toHaveBeenCalled();
  });
});
