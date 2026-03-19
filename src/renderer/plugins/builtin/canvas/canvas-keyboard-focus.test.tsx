import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CanvasWorkspace } from './CanvasWorkspace';
import { CanvasViewComponent } from './CanvasView';
import type { CanvasView, Viewport } from './canvas-types';
import type { PluginAPI } from '../../../../shared/plugin-types';

// ── Fixtures ────────────────────────────────────────────────────────────

const baseView: CanvasView = {
  id: 'cv_1',
  type: 'agent',
  title: 'Agent',
  displayName: 'My Agent',
  position: { x: 0, y: 0 },
  size: { width: 480, height: 480 },
  zIndex: 0,
  metadata: {},
  agentId: 'agent_1',
} as CanvasView;

const defaultViewport: Viewport = { panX: 0, panY: 0, zoom: 1 };

function stubApi(): PluginAPI {
  return {
    agents: {
      list: () => [],
      onAnyChange: () => ({ dispose: () => {} }),
      getDetailedStatus: () => null,
    },
    projects: { list: () => [] },
    context: { mode: 'project', projectId: 'p1' },
    widgets: {
      AgentAvatar: () => null,
      AgentTerminal: () => null,
      SleepingAgent: () => null,
    },
    settings: {
      get: () => undefined,
      getAll: () => ({}),
      set: () => {},
      onChange: () => ({ dispose: () => {} }),
    },
  } as unknown as PluginAPI;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function renderWorkspace(overrides: {
  views?: CanvasView[];
  viewport?: Viewport;
  selectedViewId?: string | null;
  onViewportChange?: (v: Viewport) => void;
  onSelectView?: (id: string | null) => void;
  onClearSelection?: () => void;
} = {}) {
  const props = {
    views: overrides.views ?? [],
    viewport: overrides.viewport ?? defaultViewport,
    zoomedViewId: null,
    selectedViewId: overrides.selectedViewId ?? null,
    selectedViewIds: [] as string[],
    api: stubApi(),
    onViewportChange: overrides.onViewportChange ?? vi.fn(),
    onAddView: vi.fn(),
    onAddPluginView: vi.fn(),
    onRemoveView: vi.fn(),
    onMoveView: vi.fn(),
    onMoveViews: vi.fn(),
    onResizeView: vi.fn(),
    onFocusView: vi.fn(),
    onUpdateView: vi.fn(),
    onZoomView: vi.fn(),
    onSelectView: overrides.onSelectView ?? vi.fn(),
    onToggleSelectView: vi.fn(),
    onSetSelectedViewIds: vi.fn(),
    onClearSelection: overrides.onClearSelection ?? vi.fn(),
  };
  return render(<CanvasWorkspace {...props} />);
}

// ── Tests: auto-focus & arrow-key panning ────────────────────────────────

describe('canvas keyboard focus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-focuses the workspace container on mount', () => {
    renderWorkspace();
    const ws = screen.getByTestId('canvas-workspace');
    expect(document.activeElement).toBe(ws);
  });

  it('pans canvas with arrow keys when no widget is selected', () => {
    const onViewportChange = vi.fn();
    renderWorkspace({ onViewportChange });
    const ws = screen.getByTestId('canvas-workspace');

    fireEvent.keyDown(ws, { key: 'ArrowRight' });

    expect(onViewportChange).toHaveBeenCalledWith(
      expect.objectContaining({ panX: -40 }),
    );
  });

  it('does NOT pan canvas with arrow keys when a widget is selected', () => {
    const onViewportChange = vi.fn();
    renderWorkspace({
      views: [baseView],
      selectedViewId: baseView.id,
      onViewportChange,
    });
    const ws = screen.getByTestId('canvas-workspace');

    fireEvent.keyDown(ws, { key: 'ArrowRight' });

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('Escape deselects and returns focus to the workspace', () => {
    const onClearSelection = vi.fn();
    renderWorkspace({
      views: [baseView],
      selectedViewId: baseView.id,
      onClearSelection,
    });
    const ws = screen.getByTestId('canvas-workspace');

    fireEvent.keyDown(ws, { key: 'Escape' });

    expect(onClearSelection).toHaveBeenCalled();
    expect(document.activeElement).toBe(ws);
  });

  it('clicking empty canvas space deselects and focuses the workspace', () => {
    const onSelectView = vi.fn();
    const onClearSelection = vi.fn();
    renderWorkspace({
      views: [baseView],
      selectedViewId: baseView.id,
      onSelectView,
      onClearSelection,
    });
    const ws = screen.getByTestId('canvas-workspace');

    // Simulate clicking empty space (target === currentTarget)
    fireEvent.mouseDown(ws, { button: 0 });

    expect(onSelectView).toHaveBeenCalledWith(null);
    expect(onClearSelection).toHaveBeenCalled();
    expect(document.activeElement).toBe(ws);
  });

  it('workspace regains focus when selectedViewId transitions to null', () => {
    const multiSelectProps = {
      selectedViewIds: [] as string[],
      onMoveViews: vi.fn(),
      onToggleSelectView: vi.fn(),
      onSetSelectedViewIds: vi.fn(),
      onClearSelection: vi.fn(),
    };

    const { rerender } = render(
      <CanvasWorkspace
        views={[baseView]}
        viewport={defaultViewport}
        zoomedViewId={null}
        selectedViewId={baseView.id}
        api={stubApi()}
        onViewportChange={vi.fn()}
        onAddView={vi.fn()}
        onAddPluginView={vi.fn()}
        onRemoveView={vi.fn()}
        onMoveView={vi.fn()}
        onResizeView={vi.fn()}
        onFocusView={vi.fn()}
        onUpdateView={vi.fn()}
        onZoomView={vi.fn()}
        onSelectView={vi.fn()}
        {...multiSelectProps}
      />,
    );

    // Blur the workspace to simulate focus being on a widget's internal element
    const ws = screen.getByTestId('canvas-workspace');
    act(() => { (document.activeElement as HTMLElement)?.blur?.(); });
    expect(document.activeElement).not.toBe(ws);

    // Re-render with selection cleared
    rerender(
      <CanvasWorkspace
        views={[baseView]}
        viewport={defaultViewport}
        zoomedViewId={null}
        selectedViewId={null}
        api={stubApi()}
        onViewportChange={vi.fn()}
        onAddView={vi.fn()}
        onAddPluginView={vi.fn()}
        onRemoveView={vi.fn()}
        onMoveView={vi.fn()}
        onResizeView={vi.fn()}
        onFocusView={vi.fn()}
        onUpdateView={vi.fn()}
        onZoomView={vi.fn()}
        onSelectView={vi.fn()}
        {...multiSelectProps}
      />,
    );

    expect(document.activeElement).toBe(ws);
  });
});

// ── Tests: widget content pointer-events isolation ───────────────────────

describe('canvas view pointer-events isolation', () => {
  function renderView(isSelected: boolean) {
    return render(
      <CanvasViewComponent
        view={baseView}
        api={stubApi()}
        zoom={1}
        isSelected={isSelected}
        onClose={vi.fn()}
        onFocus={vi.fn()}
        onSelect={vi.fn()}
        onToggleSelect={vi.fn()}
        onCenterView={vi.fn()}
        onZoomView={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onResizeEnd={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
  }

  it('blocks pointer-events on content area when widget is not selected', () => {
    renderView(false);
    const viewEl = screen.getByTestId(`canvas-view-${baseView.id}`);
    // The content wrapper is the div after the title bar
    const contentWrapper = viewEl.querySelector('.flex-1.min-h-0.overflow-hidden.rounded-b-lg') as HTMLElement;
    expect(contentWrapper).not.toBeNull();
    expect(contentWrapper.style.pointerEvents).toBe('none');
  });

  it('allows pointer-events on content area when widget is selected', () => {
    renderView(true);
    const viewEl = screen.getByTestId(`canvas-view-${baseView.id}`);
    const contentWrapper = viewEl.querySelector('.flex-1.min-h-0.overflow-hidden.rounded-b-lg') as HTMLElement;
    expect(contentWrapper).not.toBeNull();
    // When selected, pointer-events should not be set (defaults to auto)
    expect(contentWrapper.style.pointerEvents).toBe('');
  });

  it('clicking an unselected widget calls onSelect but not content handlers', () => {
    const onSelect = vi.fn();
    render(
      <CanvasViewComponent
        view={baseView}
        api={stubApi()}
        zoom={1}
        isSelected={false}
        onClose={vi.fn()}
        onFocus={vi.fn()}
        onSelect={onSelect}
        onToggleSelect={vi.fn()}
        onCenterView={vi.fn()}
        onZoomView={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onResizeEnd={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    const viewEl = screen.getByTestId(`canvas-view-${baseView.id}`);
    fireEvent.mouseDown(viewEl, { button: 0 });
    expect(onSelect).toHaveBeenCalled();
  });
});
