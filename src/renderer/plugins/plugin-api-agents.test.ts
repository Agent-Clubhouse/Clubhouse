import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentsAPI } from './plugin-api-agents';
import { createMockContext } from './testing';
import { useAgentStore } from '../stores/agentStore';
import { useProjectStore } from '../stores/projectStore';

describe('agents API session readers', () => {
  const listSessions = vi.fn(async () => [{ sessionId: 's1', startedAt: '', lastActiveAt: '' }]);
  const getSessionSummary = vi.fn(async () => null);
  const readSessionTranscript = vi.fn(async () => null);

  beforeEach(() => {
    listSessions.mockClear();
    getSessionSummary.mockClear();
    readSessionTranscript.mockClear();
    Object.assign(window.clubhouse.agent, { listSessions, getSessionSummary, readSessionTranscript });
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'one', path: '/projects/one' }] as never });
    useAgentStore.setState({ agents: { a1: { id: 'a1', projectId: 'p1', name: 'alpha', orchestrator: 'claude-code' } } as never });
  });

  it('falls back to the agent\'s project path in an app-scope plugin', async () => {
    const api = createAgentsAPI(createMockContext({ scope: 'app', projectId: undefined, projectPath: undefined }));
    await expect(api.listSessions('a1')).resolves.toHaveLength(1);
    expect(listSessions).toHaveBeenCalledWith('/projects/one', 'a1', 'claude-code');
    await api.getSessionSummary('a1', 's1');
    expect(getSessionSummary).toHaveBeenCalledWith('/projects/one', 'a1', 's1', 'claude-code');
    await api.readSessionTranscript('a1', 's1', 0, 10);
    expect(readSessionTranscript).toHaveBeenCalledWith('/projects/one', 'a1', 's1', 0, 10, 'claude-code');
  });

  it('keeps using the plugin\'s project path when it has one', async () => {
    const api = createAgentsAPI(createMockContext({ projectPath: '/projects/ctx' }));
    await api.listSessions('a1');
    expect(listSessions).toHaveBeenCalledWith('/projects/ctx', 'a1', 'claude-code');
  });

  it('returns nothing for an unknown local agent with no project path', async () => {
    const api = createAgentsAPI(createMockContext({ scope: 'app', projectId: undefined, projectPath: undefined }));
    await expect(api.listSessions('nope')).resolves.toEqual([]);
    expect(listSessions).not.toHaveBeenCalled();
  });
});
