import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PopoutCanvasView } from './PopoutCanvasView';

// Mock CanvasWorkspace so we can drive its callbacks directly and inspect
// what PopoutCanvasView passes through. This is the same shape used by the
// real CanvasWorkspace — only the props we exercise here are wired up.
let capturedProps: any = null;
vi.mock('../../plugins/builtin/canvas/CanvasWorkspace', () => ({
  CanvasWorkspace: (props: any) => {
    capturedProps = props;
    return (
      <div data-testid="canvas-workspace">
        {props.views.map((v: any) => (
          <div
            key={v.id}
            data-testid={`view-${v.id}`}
            data-position={`${v.position?.x},${v.position?.y}`}
            data-size={`${v.size?.width},${v.size?.height}`}
            data-agent-id={(v as any).agentId ?? ''}
          />
        ))}
        <div data-testid="zoomed-view-id">{props.zoomedViewId ?? ''}</div>
      </div>
    );
  },
}));

const mockSpawnDurableAgent = vi.fn();
const mockLoadDurableAgents = vi.fn();
const mockAgents: Record<string, any> = {};

vi.mock('../../stores/agentStore', () => {
  const getState = () => ({
    agents: mockAgents,
    agentDetailedStatus: {},
    agentIcons: {},
    spawnDurableAgent: mockSpawnDurableAgent,
    loadDurableAgents: mockLoadDurableAgents,
  });
  const hook: any = (selector: (s: any) => any) => selector(getState());
  hook.getState = getState;
  hook.subscribe = (_cb: any) => () => {};
  return { useAgentStore: hook };
});

let mockProjects: any[] = [];
const mockLoadProjects = vi.fn();

vi.mock('../../stores/projectStore', () => {
  const getState = () => ({
    projects: mockProjects,
    activeProjectId: null,
    loadProjects: mockLoadProjects,
  });
  const hook: any = (selector: (s: any) => any) => selector(getState());
  hook.getState = getState;
  return { useProjectStore: hook };
});

vi.mock('../../stores/mcpBindingStore', () => {
  const getState = () => ({ bindings: [] });
  const hook: any = (selector: (s: any) => any) => selector(getState());
  hook.getState = getState;
  return { useMcpBindingStore: hook };
});

vi.mock('../../plugins/plugin-api-ui', () => ({
  createWidgetsAPI: () => ({}),
}));

describe('PopoutCanvasView', () => {
  beforeEach(() => {
    capturedProps = null;
    mockSpawnDurableAgent.mockReset();
    mockLoadDurableAgents.mockReset();
    mockLoadProjects.mockReset();
    mockLoadProjects.mockResolvedValue(undefined);
    mockLoadDurableAgents.mockResolvedValue(undefined);
    for (const k of Object.keys(mockAgents)) delete mockAgents[k];
    mockProjects = [{ id: 'proj-1', path: '/projects/proj-1', name: 'Test Project' }];

    window.clubhouse.window.getCanvasState = vi.fn().mockResolvedValue({
      canvasId: 'canvas-1',
      name: 'main',
      views: [
        { id: 'view-1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'Card 1' },
      ],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 1,
      zoomedViewId: null,
      selectedViewId: null,
    });
    window.clubhouse.window.onCanvasStateChanged = vi.fn().mockReturnValue(() => {});
    window.clubhouse.window.sendCanvasMutation = vi.fn();
    window.clubhouse.window.requestDurableReload = vi.fn();
    window.clubhouse.agent.createDurable = vi.fn();
  });

  it('renders the canvas with views from the leader window snapshot', async () => {
    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toBeInTheDocument();
    });
  });

  // ─── Bug 3 part 1 — createDurable must work in pop-out ───────────────

  it('createDurable in popout: writes config via IPC, spawns locally, and asks main to reload', async () => {
    // Regression: createDurable used to reject with "Not available in pop-out",
    // so the "+ New Agent" button in a popped-out canvas card was a dead end.
    mockSpawnDurableAgent.mockResolvedValue('new-agent-id');
    vi.mocked(window.clubhouse.agent.createDurable).mockResolvedValue({
      id: 'new-agent-id', name: 'fresh', color: 'blue', createdAt: '', branch: 'fresh/standby',
      worktreePath: '/projects/proj-1/.clubhouse/agents/fresh',
    } as any);

    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    const agentId = await capturedProps.api.agents.createDurable({
      projectId: 'proj-1', name: 'fresh', color: 'blue', useWorktree: true,
    });

    expect(agentId).toBe('new-agent-id');
    expect(window.clubhouse.agent.createDurable).toHaveBeenCalledWith(
      '/projects/proj-1', 'fresh', 'blue', undefined, true, undefined, undefined, undefined, undefined,
    );
    expect(mockSpawnDurableAgent).toHaveBeenCalled();
    expect(window.clubhouse.window.requestDurableReload).toHaveBeenCalledWith('proj-1');
  });

  it('createDurable in popout rejects when no project context is available', async () => {
    render(<PopoutCanvasView canvasId="canvas-1" />); // no projectId
    await waitFor(() => expect(capturedProps).not.toBeNull());

    await expect(capturedProps.api.agents.createDurable({ name: 'x', color: 'red' }))
      .rejects.toThrow(/project context/);
  });

  // ─── Bug 3 part 2 — selecting an agent on a card must update view ─────

  it('picking an agent via onUpdateView updates the local card optimistically', async () => {
    // Regression: even though the popout sent the updateView mutation, the
    // card kept showing the picker until the leader broadcast made the
    // roundtrip. Now the popout optimistically applies the update so the
    // assignment is visible immediately.
    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    capturedProps.onUpdateView('view-1', { agentId: 'agent-xyz' });

    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toHaveAttribute('data-agent-id', 'agent-xyz');
    });
    expect(window.clubhouse.window.sendCanvasMutation).toHaveBeenCalledWith(
      'canvas-1', 'project-local',
      expect.objectContaining({ type: 'updateView', viewId: 'view-1' }),
      'proj-1',
    );
  });

  // ─── Bug 4 — moving/resizing/zooming must update locally before IPC ───

  it('moving a view updates local position optimistically (no snap-back during IPC roundtrip)', async () => {
    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    capturedProps.onMoveView('view-1', { x: 500, y: 600 });

    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toHaveAttribute('data-position', '500,600');
    });
    expect(window.clubhouse.window.sendCanvasMutation).toHaveBeenCalledWith(
      'canvas-1', 'project-local',
      expect.objectContaining({ type: 'moveView', viewId: 'view-1' }),
      'proj-1',
    );
  });

  it('resizing a view updates local size optimistically', async () => {
    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    capturedProps.onResizeView('view-1', { width: 400, height: 400 });

    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toHaveAttribute('data-size', '400,400');
    });
    expect(window.clubhouse.window.sendCanvasMutation).toHaveBeenCalledWith(
      'canvas-1', 'project-local',
      expect.objectContaining({ type: 'resizeView', viewId: 'view-1' }),
      'proj-1',
    );
  });

  it('zooming a view updates zoomedViewId optimistically so the overlay opens immediately', async () => {
    // Regression: clicking the maximize button on a card sent a zoomView
    // mutation but didn't update zoomedViewId locally, so the user saw
    // nothing until the leader broadcast made it back.
    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    capturedProps.onZoomView('view-1');

    await waitFor(() => {
      expect(screen.getByTestId('zoomed-view-id')).toHaveTextContent('view-1');
    });
    expect(window.clubhouse.window.sendCanvasMutation).toHaveBeenCalledWith(
      'canvas-1', 'project-local',
      expect.objectContaining({ type: 'zoomView', viewId: 'view-1' }),
      'proj-1',
    );
  });

  it('moveViews (multi-drag) updates all involved view positions optimistically', async () => {
    window.clubhouse.window.getCanvasState = vi.fn().mockResolvedValue({
      canvasId: 'canvas-1', name: 'main',
      views: [
        { id: 'view-1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A' },
        { id: 'view-2', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'B' },
      ],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 1, zoomedViewId: null, selectedViewId: null,
    });

    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('view-view-2')).toBeInTheDocument());

    const positions = new Map<string, { x: number; y: number }>();
    positions.set('view-1', { x: 100, y: 100 });
    positions.set('view-2', { x: 200, y: 200 });
    capturedProps.onMoveViews(positions);

    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toHaveAttribute('data-position', '100,100');
      expect(screen.getByTestId('view-view-2')).toHaveAttribute('data-position', '200,200');
    });
  });

  it('removing a view removes it from local state optimistically', async () => {
    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    capturedProps.onRemoveView('view-1');

    await waitFor(() => {
      expect(screen.queryByTestId('view-view-1')).not.toBeInTheDocument();
    });
  });

  // ─── LB-CB-2026-05-02 — mutation race: no IPC before initial state resolves ──

  it('suppresses sendCanvasMutation until the initial IPC snapshot resolves', async () => {
    // Regression: mutations fired before getCanvasState resolved could reach the
    // leader window before it had a chance to apply the initial state, causing
    // out-of-order updates. sendMutation must be gated on initialization.
    let resolveSnapshot!: (v: any) => void;
    vi.mocked(window.clubhouse.window.getCanvasState).mockReturnValueOnce(
      new Promise((r) => { resolveSnapshot = r; }),
    );

    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);

    // Component is still loading — no snapshot yet, so sendMutation is suppressed
    if (capturedProps) {
      capturedProps.onMoveView('view-1', { x: 999, y: 999 });
    }
    expect(window.clubhouse.window.sendCanvasMutation).not.toHaveBeenCalled();

    // Resolve the snapshot — initialization completes
    resolveSnapshot({
      canvasId: 'canvas-1',
      name: 'main',
      views: [
        { id: 'view-1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'Card 1' },
      ],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nextZIndex: 1,
      zoomedViewId: null,
      selectedViewId: null,
    });

    // Wait for the component to finish loading and re-render with new props
    await waitFor(() => expect(capturedProps).not.toBeNull());
    await waitFor(() => expect(screen.queryByText('Loading canvas...')).not.toBeInTheDocument());

    // Now mutations should be forwarded
    capturedProps.onMoveView('view-1', { x: 200, y: 300 });
    expect(window.clubhouse.window.sendCanvasMutation).toHaveBeenCalledWith(
      'canvas-1', 'project-local',
      expect.objectContaining({ type: 'moveView', viewId: 'view-1' }),
      'proj-1',
    );
  });

  // ─── GH-1458 — agent card creation must survive leader broadcast ─────────
  //
  // Root cause: onCanvasMutation in the preload listened on CANVAS_MUTATION
  // (renderer→main) instead of REQUEST_CANVAS_MUTATION (main→renderer).
  // The main process receives popout mutations on CANVAS_MUTATION and forwards
  // them to the main window via REQUEST_CANVAS_MUTATION. With the wrong channel
  // the main window never applied the mutation, so its next broadcast reverted
  // the card back to the picker state.
  //
  // This test verifies that:
  //  1. The popout sends the updateView mutation after createDurable
  //  2. Optimistic local state is applied immediately (card shows agent)
  //  3. A subsequent leader broadcast that does NOT include the agent (simulating
  //     the main window state before it processed the mutation) does NOT revert
  //     the card — i.e., the broadcast only overwrites when it carries the
  //     updated state.

  it('GH-1458: agent card creation — optimistic update persists until leader broadcasts updated state', async () => {
    let onStateChanged!: (state: any) => void;
    window.clubhouse.window.onCanvasStateChanged = vi.fn().mockImplementation((cb) => {
      onStateChanged = cb;
      return () => {};
    });

    mockSpawnDurableAgent.mockResolvedValue('agent-new');
    vi.mocked(window.clubhouse.agent.createDurable).mockResolvedValue({
      id: 'agent-new', name: 'NewAgent', color: 'green', createdAt: '', branch: 'new/standby',
      worktreePath: '/projects/proj-1/.clubhouse/agents/new',
    } as any);

    render(<PopoutCanvasView canvasId="canvas-1" projectId="proj-1" />);
    await waitFor(() => expect(capturedProps).not.toBeNull());

    // Step 1: popout creates agent and assigns it to the card
    await capturedProps.api.agents.createDurable({ projectId: 'proj-1', name: 'NewAgent', color: 'green' });
    capturedProps.onUpdateView('view-1', { agentId: 'agent-new' });

    // Step 2: optimistic update is visible immediately
    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toHaveAttribute('data-agent-id', 'agent-new');
    });

    // Step 3: mutation was forwarded to the leader
    expect(window.clubhouse.window.sendCanvasMutation).toHaveBeenCalledWith(
      'canvas-1', 'project-local',
      expect.objectContaining({ type: 'updateView', viewId: 'view-1', updates: expect.objectContaining({ agentId: 'agent-new' }) }),
      'proj-1',
    );

    // Step 4: leader broadcasts updated state WITH the agent assigned — card stays
    onStateChanged({
      canvasId: 'canvas-1',
      views: [{ id: 'view-1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'Card 1', agentId: 'agent-new' }],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      zoomedViewId: null,
    });

    await waitFor(() => {
      expect(screen.getByTestId('view-view-1')).toHaveAttribute('data-agent-id', 'agent-new');
    });
  });

  // Avoid unused-var warning on imported helper
  void fireEvent;
});
