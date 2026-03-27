/**
 * Tests for AgentCanvasView — specifically the "connecting" pending state
 * shown when a remote agent card has an agentId but the agent isn't in the
 * store yet (timing issue during remote canvas hydration).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { AgentCanvasView } from './AgentCanvasView';
import type { AgentCanvasView as AgentCanvasViewType } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

const noop = () => {};

function makeView(overrides: Partial<AgentCanvasViewType> = {}): AgentCanvasViewType {
  return {
    id: 'cv_agent_1',
    type: 'agent',
    title: 'TestAgent',
    displayName: 'TestAgent',
    position: { x: 0, y: 0 },
    size: { width: 480, height: 480 },
    zIndex: 0,
    metadata: {},
    agentId: null,
    ...overrides,
  };
}

function stubApi(options: {
  agents?: Array<{ id: string; name: string; status: string; kind: string; projectId: string }>;
  mode?: string;
} = {}): PluginAPI {
  const agents = options.agents ?? [];
  return {
    agents: {
      list: () => agents,
      onAnyChange: () => ({ dispose: () => {} }),
    },
    projects: { list: () => [] },
    context: { mode: options.mode ?? 'project', projectId: 'proj-1' },
    widgets: {
      AgentAvatar: () => null,
      AgentTerminal: ({ agentId }: { agentId: string }) => <div data-testid="agent-terminal">{agentId}</div>,
      SleepingAgent: ({ agentId }: { agentId: string }) => <div data-testid="sleeping-agent">{agentId}</div>,
    },
    settings: {
      get: () => undefined,
      getAll: () => ({}),
      set: () => {},
      onChange: () => ({ dispose: () => {} }),
    },
  } as unknown as PluginAPI;
}

describe('AgentCanvasView', () => {
  it('shows picker when no agentId is set', () => {
    const view = makeView({ agentId: null });
    render(<AgentCanvasView view={view} api={stubApi()} onUpdate={noop} />);

    expect(screen.getByText('Assign an agent')).toBeTruthy();
  });

  it('shows connecting state when agentId is set but agent not in store', () => {
    const view = makeView({
      agentId: 'remote||sat-1||agent-1',
      displayName: 'RemoteAlpha',
    });

    // No agents in the store
    render(<AgentCanvasView view={view} api={stubApi({ agents: [] })} onUpdate={noop} />);

    expect(screen.getByText('RemoteAlpha')).toBeTruthy();
    expect(screen.getByText('Connecting...')).toBeTruthy();
    // Should NOT show the picker
    expect(screen.queryByText('Assign an agent')).toBeNull();
  });

  it('shows terminal when agent is found and running', () => {
    const view = makeView({
      agentId: 'agent-1',
      displayName: 'Alpha',
    });

    const api = stubApi({
      agents: [{ id: 'agent-1', name: 'Alpha', status: 'running', kind: 'durable', projectId: 'proj-1' }],
    });

    render(<AgentCanvasView view={view} api={api} onUpdate={noop} />);

    expect(screen.getByTestId('agent-terminal')).toBeTruthy();
  });

  it('shows sleeping widget when agent is found and sleeping', () => {
    const view = makeView({
      agentId: 'agent-1',
      displayName: 'Alpha',
    });

    const api = stubApi({
      agents: [{ id: 'agent-1', name: 'Alpha', status: 'sleeping', kind: 'durable', projectId: 'proj-1' }],
    });

    render(<AgentCanvasView view={view} api={api} onUpdate={noop} />);

    expect(screen.getByTestId('sleeping-agent')).toBeTruthy();
  });

  it('falls back to agentId when displayName is missing', () => {
    const view = makeView({
      agentId: 'remote||sat-1||agent-1',
      displayName: '',
      title: '',
    });

    render(<AgentCanvasView view={view} api={stubApi({ agents: [] })} onUpdate={noop} />);

    expect(screen.getByText('remote||sat-1||agent-1')).toBeTruthy();
    expect(screen.getByText('Connecting...')).toBeTruthy();
  });
});
