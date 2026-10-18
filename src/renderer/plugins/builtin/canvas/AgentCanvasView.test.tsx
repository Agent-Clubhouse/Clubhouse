/**
 * Tests for AgentCanvasView — specifically the "connecting" pending state
 * shown when a remote agent card has an agentId but the agent isn't in the
 * store yet (timing issue during remote canvas hydration), and the create-
 * from-card flow (LB-M68).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock AddAgentDialog with a minimal stub that auto-submits via a button so
// we can drive handleCreateDurable without rendering the full form (which has
// orchestrator/model store dependencies that would balloon test setup).
vi.mock('../../../features/agents/chat/AgentView', () => ({
  AgentView: ({ agentId, zoneThemeId, context }: { agentId: string; zoneThemeId?: string; context?: string }) => (
    <div data-testid="agent-view" data-zone-theme={zoneThemeId} data-context={context}>{agentId}</div>
  ),
}));

// The New agent page can't open in tests by default (classic shell), so the
// dialog path runs; the page tests below turn it on.
const openNewAgentPage = vi.fn((..._args: unknown[]) => false);
vi.mock('../../../chrome/startPage', () => ({
  openNewAgentPage: (...args: unknown[]) => openNewAgentPage(...args),
}));

vi.mock('../../../features/agents/AddAgentDialog', () => ({
  AddAgentDialog: ({ onCreate, error }: {
    onCreate: (
      name: string, color: string, model: string, useWorktree: boolean,
      orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[], persona?: string,
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
        onClick={() => onCreate('NewAgent', 'emerald', 'default', false, 'claude-code', true)}
      >
        Submit (free agent)
      </button>
      <button
        data-testid="stub-add-agent-submit-with-persona"
        onClick={() => onCreate('NewAgent', 'emerald', 'default', false, 'claude-code', undefined, undefined, 'qa')}
      >
        Submit (persona)
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
      getDetailedStatus: () => null,
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

    expect(screen.getByTestId('canvas-widget-picker')).toBeTruthy();
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
    expect(screen.queryByTestId('canvas-widget-picker')).toBeNull();
  });

  it('shows the runtime-aware AgentView in canvas mode when the agent is running', () => {
    const view = makeView({ agentId: 'agent-1', displayName: 'Alpha' });
    const api = stubApi({
      agents: [{ id: 'agent-1', name: 'Alpha', status: 'running', kind: 'durable', projectId: 'proj-1' }],
    });

    render(<AgentCanvasView view={view} api={api} onUpdate={noop} zoneThemeId="latte" />);

    const card = screen.getByTestId('agent-view');
    expect(card).toHaveAttribute('data-zone-theme', 'latte');
    expect(card).toHaveAttribute('data-context', 'canvas');
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
      expect(screen.getByPlaceholderText('Find a project')).toBeTruthy();
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
      const [parentView, agentId] = onCreateAgentCard.mock.calls[0];
      expect(parentView.id).toBe('cv_agent_1');
      expect(parentView.position).toEqual({ x: 200, y: 300 });
      expect(parentView.size).toEqual({ width: 480, height: 480 });
      expect(agentId).toBe('agent-new-id');

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

  // ── #1564: error surfacing + freeAgentMode pass-through ──

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

    it('passes freeAgentMode through to api.agents.createDurable', async () => {
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
        }),
      );
      expect((createDurableSpy.mock.calls[0] as unknown[])[0]).not.toHaveProperty('structuredMode');
    });
  });

  // ── #1565: persona pass-through ─────────────────────────────────────

  describe('persona pass-through (#1565)', () => {
    it('passes the selected persona through to api.agents.createDurable', async () => {
      const view = makeView({ agentId: null });
      const onUpdate = vi.fn();
      const createDurableSpy = vi.fn(async () => 'agent-new-id');
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: createDurableSpy,
      });

      render(<AgentCanvasView view={view} api={api} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      fireEvent.click(screen.getByTestId('stub-add-agent-submit-with-persona'));

      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      expect(createDurableSpy).toHaveBeenCalledWith(
        expect.objectContaining({ persona: 'qa' }),
      );
    });

    it('omits persona when none is selected', async () => {
      const view = makeView({ agentId: null });
      const onUpdate = vi.fn();
      const createDurableSpy = vi.fn(async () => 'agent-new-id');
      const api = stubApi({
        projects: [{ id: 'proj-1', name: 'Proj', path: '/tmp/proj' }],
        createDurable: createDurableSpy,
      });

      render(<AgentCanvasView view={view} api={api} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      fireEvent.click(screen.getByTestId('stub-add-agent-submit'));

      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      expect(createDurableSpy).toHaveBeenCalledWith(
        expect.objectContaining({ persona: undefined }),
      );
    });
  });

  it('renames a card titled with the raw agent id once the agent shows up', () => {
    const view = makeView({ agentId: 'agent-7', title: 'agent-7', displayName: 'agent-7' });
    const onUpdate = vi.fn();
    render(<AgentCanvasView view={view} api={stubApi({ agents: [{ id: 'agent-7', name: 'bold-falcon', status: 'sleeping', kind: 'durable', projectId: 'proj-1' }] })} onUpdate={onUpdate} />);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ title: 'bold-falcon', displayName: 'bold-falcon' }));
  });

  it('keeps a name the user gave the card', () => {
    const view = makeView({ agentId: 'agent-7', title: 'Reviewer', displayName: 'Reviewer' });
    const onUpdate = vi.fn();
    render(<AgentCanvasView view={view} api={stubApi({ agents: [{ id: 'agent-7', name: 'bold-falcon', status: 'sleeping', kind: 'durable', projectId: 'proj-1' }] })} onUpdate={onUpdate} />);
    for (const [update] of onUpdate.mock.calls) expect(update).not.toHaveProperty('displayName');
  });

  // ── New agent page (#2031) ─────────────────────────────────────────

  describe('New agent page', () => {
    beforeEach(() => {
      openNewAgentPage.mockReset();
      openNewAgentPage.mockReturnValue(false);
    });

    const project = { id: 'proj-1', name: 'Proj', path: '/tmp/proj' };

    it('opens the page with Durable, this card\'s project and stayInView, and no dialog', () => {
      openNewAgentPage.mockReturnValue(true);
      render(<AgentCanvasView view={makeView()} api={stubApi({ projects: [project] })} onUpdate={noop} onCreateAgentCard={vi.fn()} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));

      expect(openNewAgentPage).toHaveBeenCalledWith('durable', 'proj-1', expect.objectContaining({ stayInView: true, onCreated: expect.any(Function) }));
      expect(screen.queryByTestId('stub-add-agent-submit')).toBeNull();
    });

    it('places a sibling card for the agent the page created', () => {
      openNewAgentPage.mockReturnValue(true);
      const onCreateAgentCard = vi.fn();
      const onUpdate = vi.fn();
      const view = makeView({ position: { x: 200, y: 300 } });
      render(<AgentCanvasView view={view} api={stubApi({ projects: [project] })} onUpdate={onUpdate} onCreateAgentCard={onCreateAgentCard} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      const { onCreated } = openNewAgentPage.mock.calls[0][2] as { onCreated: (id: string) => void };
      onCreated('agent-from-page');

      expect(onCreateAgentCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'cv_agent_1' }), 'agent-from-page');
      // This card stays a picker.
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('still places the card when onCreated arrives after the card unmounted (the page replaced the pane)', () => {
      openNewAgentPage.mockReturnValue(true);
      const onCreateAgentCard = vi.fn();
      const view = makeView({ position: { x: 200, y: 300 } });
      const { unmount } = render(<AgentCanvasView view={view} api={stubApi({ projects: [project] })} onUpdate={noop} onCreateAgentCard={onCreateAgentCard} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      const { onCreated } = openNewAgentPage.mock.calls[0][2] as { onCreated: (id: string) => void };
      unmount();
      // With a worktree, onCreated comes seconds later, after spawn.
      onCreated('agent-after-spawn');

      expect(onCreateAgentCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'cv_agent_1' }), 'agent-after-spawn');
    });

    it('falls back to the dialog where the page can\'t open', () => {
      openNewAgentPage.mockReturnValue(false);
      render(<AgentCanvasView view={makeView()} api={stubApi({ projects: [project] })} onUpdate={noop} />);

      fireEvent.click(screen.getByTestId('canvas-create-agent'));

      expect(openNewAgentPage).toHaveBeenCalled();
      expect(screen.getByTestId('stub-add-agent-submit')).toBeTruthy();
    });

    it('uses the dialog, without trying the page, for a remote project', () => {
      const remote = { id: 'remote||sat-1||proj-9', name: 'Remote', path: '/remote' };
      render(<AgentCanvasView view={makeView()} api={stubApi({ mode: 'app', projects: [remote] })} onUpdate={noop} />);
      // App canvas: pick the remote project, then New agent.
      fireEvent.click(screen.getByText('Remote'));
      fireEvent.click(screen.getByTestId('canvas-create-agent'));
      expect(screen.getByTestId('stub-add-agent-submit')).toBeTruthy();
      expect(openNewAgentPage).not.toHaveBeenCalled();
    });
  });
});
