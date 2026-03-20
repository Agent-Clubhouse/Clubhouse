import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStatusSlice } from './agentStatusSlice';
import type { AgentState, AgentStatusSlice } from './types';
import type { AgentHookEvent, AgentDetailedStatus } from '../../../shared/types';

// Minimal state that the slice needs
function createMinimalState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agents: {},
    agentActivity: {},
    agentSpawnedAt: {},
    agentTerminalAt: {},
    agentDetailedStatus: {},
    activeAgentId: null,
    agentSettingsOpenFor: null,
    deleteDialogAgent: null,
    configChangesDialogAgent: null,
    configChangesProjectPath: null,
    sessionNamePromptFor: null,
    projectActiveAgent: {},
    cancelledAgentIds: {},
    agentIcons: {},
    ...overrides,
  } as AgentState;
}

describe('agentStatusSlice – handleHookEvent', () => {
  let state: AgentState;
  let slice: AgentStatusSlice;

  function initSlice(initial: Partial<AgentState> = {}) {
    state = createMinimalState({
      agents: {
        'agent-1': {
          id: 'agent-1',
          name: 'Test Agent',
          projectId: 'proj-1',
          status: 'running',
          kind: 'durable',
          color: 'blue',
        } as any,
      },
      ...initial,
    });

    const set = (updater: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => {
      if (typeof updater === 'function') {
        Object.assign(state, updater(state));
      } else {
        Object.assign(state, updater);
      }
    };
    const get = () => state;

    slice = createStatusSlice(set as any, get as any);
  }

  beforeEach(() => {
    initSlice();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets needs_permission on permission_request event', () => {
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']).toEqual(
      expect.objectContaining({ state: 'needs_permission', toolName: 'Bash' }),
    );
  });

  it('guards needs_permission from being overwritten by notification', () => {
    // Set permission state
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    // Try to overwrite with notification
    slice.handleHookEvent('agent-1', {
      kind: 'notification',
      message: 'Some notification',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('needs_permission');
  });

  it('guards needs_permission from being overwritten by stop', () => {
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    slice.handleHookEvent('agent-1', {
      kind: 'stop',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('needs_permission');
  });

  it('guards needs_permission from being overwritten by post_tool', () => {
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    slice.handleHookEvent('agent-1', {
      kind: 'post_tool',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('needs_permission');
  });

  it('allows pre_tool to clear needs_permission (permission approved)', () => {
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    slice.handleHookEvent('agent-1', {
      kind: 'pre_tool',
      toolName: 'Bash',
      toolVerb: 'Running command',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('working');
  });

  it('allows permission_resolved to clear needs_permission (permission denied/timed out)', () => {
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    slice.handleHookEvent('agent-1', {
      kind: 'permission_resolved',
      toolName: 'Bash',
      message: 'deny',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('idle');
    expect(state.agentDetailedStatus['agent-1']?.message).toBe('Thinking');
  });

  it('allows a new permission_request to replace existing needs_permission', () => {
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Write',
      timestamp: Date.now(),
    });

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('needs_permission');
    expect(state.agentDetailedStatus['agent-1']?.toolName).toBe('Write');
  });

  it('does not auto-clear needs_permission in clearStaleStatuses', () => {
    const pastTimestamp = Date.now() - 60_000; // 60s ago, well past stale threshold
    slice.handleHookEvent('agent-1', {
      kind: 'permission_request',
      toolName: 'Bash',
      timestamp: pastTimestamp,
    });

    slice.clearStaleStatuses();

    expect(state.agentDetailedStatus['agent-1']?.state).toBe('needs_permission');
  });
});
