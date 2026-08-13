/**
 * Tests for AgentCanvasView — specifically the "connecting" pending state
 * shown when a remote agent card has an agentId but the agent isn't in the
 * store yet (timing issue during remote canvas hydration), and the create-
 * from-card flow (LB-M68).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock AddAgentDialog with a minimal stub that auto-submits via a button so
// we can drive handleCreateDurable without rendering the full form (which has
// orchestrator/model store dependencies that would balloon test setup).
vi.mock('../../../features/agents/AddAgentDialog', () => ({
  AddAgentDialog: ({ onCreate, error }: {
    onCreate: (
      name: string, color: string, model: string, useWorktree: boolean,
      orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[], structuredMode?: boolean,
    ) => void;
    error?: string | null;
  }) => (
    <div>
      {error && <div data-testid="stub-add-agent-error">{error}</div>}
      <button
        data-testid="stub-add-agent-submit"
        onClick={() => onCreate('NewAgent', 'emerald', 'default', false)}
      >
        Submit
      </button>
      <button
        data-testid="stub-add-agent-submit-free-agent"
        onClick={() => onCreate('NewAgent', 'emerald', 'default', false, 'claude-code', true, undefined, true)}
      >
        Submit (free agent + structured)
      </button>
    </div>
  ),
}));

import { AgentCanvasView } from './AgentCanvasView';
import type { AgentCanvasView as AgentCanvasViewType } from './canvas-types';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';

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
  projects?: Array<{ id: string; name: string; path: string }>;
  createDurable?: (opts: { projectId?: string; name: string; color: string }) => Promise<string>;
} = {}): PluginAPI {
  // Mutable agents list so newly-created agents become visible to subsequent .list() calls
  const agentsList = [...(options.agents ?? [])];
  const projects = options.projects ?? [];
  return {
    agents: {
      list: () => agentsList,
      onAnyChange: () => ({ dispose: () => {} }),
      createDurable: options.createDurable
        ? async (opts: { projectId?: string; name: string; color: string }) => {
            const id = await options.createDurable!(opts);
            // Push the freshly-created agent into the list so the next .list() finds it.
            agentsList.push({
              id,
              name: opts.name,
              status: 'sleeping',
              kind: 'durable',
              projectId: opts.projectId ?? 'proj-1',
            } as AgentInfo);
            return id;
          }
        : async () => 'agent-new',
    },
    projects: { list: () => projects },
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

  // ── #1536: picker wheel containment ───────────────────────────────
  //
  // Scrolling the picker list must not pan the canvas underneath. The canvas
  // workspace turns any wheel event that bubbles up to it into a pan (which in
  // turn calls onViewportChange), so we model that by wrapping the picker in a
  // parent whose onWheel spy stands in for the workspace pan handler and assert
  // plain wheel events never reach it — while Ctrl/Cmd+wheel zoom gestures do.

  describe('picker wheel containment', () => {
    it('stops plain wheel propagation over the agent list (no canvas pan)', () => {
      const view = makeView({ agentId: null });
      const api = stubApi({
        agents: [{ id: 'agent-1', name: 'Alpha', status: 'sleeping', kind: 'durable', projectId: 'proj-1' }],
      });
      // Parent onWheel stands in for CanvasWorkspace's pan handler, which would
      // call onViewportChange for any wheel event that reaches it.
      const onViewportChange = vi.fn();

      render(
        <div onWheel={onViewportChange} data-testid="workspace">
          <AgentCanvasView view={view} api={api} onUpdate={noop} />
        </div>
      );

      const scroll = screen.getByTestId('canvas-agent-picker-scroll');
      fireEvent.wheel(scroll, { deltaY: 120 });

      expect(onViewportChange).not.toHaveBeenCalled();
    });

    it('stops plain wheel propagation over the project list (app mode)', () => {
      const view = makeView({ agentId: null });
      const api = stubApi({
        mode: 'app',
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
      });
      const onViewportChange = vi.fn();

      render(
        <div onWheel={onViewportChange} data-testid="workspace">
          <AgentCanvasView view={view} api={api} onUpdate={noop} />
        </div>
      );

      // App mode starts on the project-selection step.
      expect(screen.getByText('Select a project')).toBeTruthy();
      const scroll = screen.getByTestId('canvas-agent-picker-scroll');
      fireEvent.wheel(scroll, { deltaY: -120 });

      expect(onViewportChange).not.toHaveBeenCalled();
    });

    it('lets Ctrl+wheel zoom gestures bubble to the canvas', () => {
      const view = makeView({ agentId: null });
      const api = stubApi({
        agents: [{ id: 'agent-1', name: 'Alpha', status: 'sleeping', kind: 'durable', projectId: 'proj-1' }],
      });
      const onViewportChange = vi.fn();

      render(
        <div onWheel={onViewportChange} data-testid="workspace">
          <AgentCanvasView view={view} api={api} onUpdate={noop} />
        </div>
      );

      const scroll = screen.getByTestId('canvas-agent-picker-scroll');
      fireEvent.wheel(scroll, { deltaY: 120, ctrlKey: true });

      // Zoom gesture must reach the workspace so canvas zoom keeps working.
      expect(onViewportChange).toHaveBeenCalledTimes(1);
    });

    it('lets Meta+wheel zoom gestures bubble to the canvas', () => {
      const view = makeView({ agentId: null });
      const api = stubApi({
        agents: [{ id: 'agent-1', name: 'Alpha', status: 'sleeping', kind: 'durable', projectId: 'proj-1' }],
      });
      const onViewportChange = vi.fn();

      render(
        <div onWheel={onViewportChange} data-testid="workspace">
          <AgentCanvasView view={view} api={api} onUpdate={noop} />
        </div>
      );

      const scroll = screen.getByTestId('canvas-agent-picker-scroll');
      fireEvent.wheel(scroll, { deltaY: 120, metaKey: true });

      expect(onViewportChange).toHaveBeenCalledTimes(1);
    });
  });

  // ── LB-M68: create-from-card flow ─────────────────────────────────

  describe('"+ New Agent" create-from-card flow', () => {
    it('invokes onCreateAgentCard with the parent view and new agent when callback is provided', async () => {
      const view = makeView({
        agentId: null,
        position: { x: 200, y: 300 },
        size: { width: 480, height: 480 },
      });
      const onCreateAgentCard = vi.fn();
      const onUpdate = vi.fn();
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: async () => 'agent-new-id',
      });

      render(
        <AgentCanvasView
          view={view}
          api={api}
          onUpdate={onUpdate}
          onCreateAgentCard={onCreateAgentCard}
        />
      );

      // Open the dialog (mocked to a single submit button)
      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      // Trigger the dialog's onCreate via the mocked submit button
      fireEvent.click(screen.getByTestId('stub-add-agent-submit'));

      await waitFor(() => expect(onCreateAgentCard).toHaveBeenCalled());
      const [parentView, newAgent] = onCreateAgentCard.mock.calls[0];
      expect(parentView.id).toBe('cv_agent_1');
      expect(parentView.position).toEqual({ x: 200, y: 300 });
      expect(parentView.size).toEqual({ width: 480, height: 480 });
      expect(newAgent.id).toBe('agent-new-id');
      expect(newAgent.name).toBe('NewAgent');

      // The current card should NOT have been mutated (parent stays in picker mode)
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('falls back to legacy assign-to-current behavior when onCreateAgentCard is not provided', async () => {
      const view = makeView({ agentId: null });
      const onUpdate = vi.fn();
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: async () => 'agent-legacy-id',
      });

      render(
        <AgentCanvasView
          view={view}
          api={api}
          onUpdate={onUpdate}
        />
      );

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      fireEvent.click(screen.getByTestId('stub-add-agent-submit'));

      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      const updateArg = onUpdate.mock.calls[0][0];
      expect(updateArg.agentId).toBe('agent-legacy-id');
      expect(updateArg.title).toBe('NewAgent');
      // No position field should be in the update — caller relies on existing
      // store behavior of preserving position via spread merge.
      expect(updateArg).not.toHaveProperty('position');
    });
  });

  // ── #1564: error surfacing + structuredMode/freeAgentMode pass-through ──

  describe('create-agent failure surfacing (#1564)', () => {
    it('surfaces the createDurable error in the dialog instead of swallowing it', async () => {
      const view = makeView({ agentId: null });
      const onUpdate = vi.fn();
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: async () => {
          throw new Error("Plugin 'canvas' requires 'agents.free-agent-mode' permission to use freeAgentMode");
        },
      });

      render(<AgentCanvasView view={view} api={api} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      fireEvent.click(screen.getByTestId('stub-add-agent-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('stub-add-agent-error')).toBeTruthy();
      });
      expect(screen.getByTestId('stub-add-agent-error').textContent).toContain('agents.free-agent-mode');
      // Dialog stays open (the stub submit button is still present) so the user can retry.
      expect(screen.getByTestId('stub-add-agent-submit')).toBeTruthy();
      // No card should have been assigned/created on failure.
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('clears a previous error on the next successful create attempt', async () => {
      const view = makeView({ agentId: null });
      const onUpdate = vi.fn();
      let shouldFail = true;
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: async () => {
          if (shouldFail) throw new Error('boom');
          return 'agent-recovered';
        },
      });

      render(<AgentCanvasView view={view} api={api} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      fireEvent.click(screen.getByTestId('stub-add-agent-submit'));
      await waitFor(() => expect(screen.getByTestId('stub-add-agent-error')).toBeTruthy());

      shouldFail = false;
      fireEvent.click(screen.getByTestId('stub-add-agent-submit'));
      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    });

    it('passes freeAgentMode and structuredMode through to api.agents.createDurable', async () => {
      const view = makeView({ agentId: null });
      const onUpdate = vi.fn();
      const createDurableSpy = vi.fn(async () => 'agent-new-id');
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: createDurableSpy,
      });

      render(<AgentCanvasView view={view} api={api} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      fireEvent.click(screen.getByTestId('stub-add-agent-submit-free-agent'));

      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      expect(createDurableSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orchestrator: 'claude-code',
          freeAgentMode: true,
          structuredMode: true,
        }),
      );
    });
  });
});
