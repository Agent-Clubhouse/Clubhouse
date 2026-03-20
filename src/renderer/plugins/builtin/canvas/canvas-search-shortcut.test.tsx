import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CanvasSearch } from './CanvasSearch';
import type { CanvasView } from './canvas-types';

// ── Fixtures ────────────────────────────────────────────────────────────

const baseView = {
  position: { x: 0, y: 0 },
  size: { width: 480, height: 480 },
  zIndex: 0,
};

const views: CanvasView[] = [
  {
    ...baseView,
    id: 'cv_1',
    type: 'agent',
    title: 'Agent',
    displayName: 'My Agent',
    metadata: {},
    agentId: 'agent_1',
  } as CanvasView,
  {
    ...baseView,
    id: 'cv_2',
    type: 'anchor',
    title: 'Anchor',
    displayName: 'Source Files',
    metadata: {},
    label: 'Source Files',
  } as CanvasView,
];

/** Three agent views sharing the "agent" type for cycling tests. */
const multiAgentViews: CanvasView[] = [
  {
    ...baseView,
    id: 'cv_a1',
    type: 'agent',
    title: 'Agent',
    displayName: 'Agent',
    metadata: { agentName: 'alpha' },
    agentId: 'agent_a1',
  } as CanvasView,
  {
    ...baseView,
    id: 'cv_a2',
    type: 'agent',
    title: 'Agent',
    displayName: 'Agent (2)',
    metadata: { agentName: 'beta' },
    agentId: 'agent_a2',
  } as CanvasView,
  {
    ...baseView,
    id: 'cv_a3',
    type: 'agent',
    title: 'Agent',
    displayName: 'Agent (3)',
    metadata: { agentName: 'gamma' },
    agentId: 'agent_a3',
  } as CanvasView,
];

// ── Helpers ─────────────────────────────────────────────────────────────

/** Wrap CanvasSearch inside DOM that mirrors the real canvas panel structure. */
function renderWithCanvasPanel(onSelectView = vi.fn(), viewList = views) {
  return render(
    <div data-testid="canvas-panel">
      <div data-testid="canvas-workspace" tabIndex={-1}>
        <div data-testid="canvas-controls">
          <CanvasSearch views={viewList} onSelectView={onSelectView} />
        </div>
      </div>
    </div>,
  );
}

function pressMetaF() {
  fireEvent.keyDown(document, { key: 'f', metaKey: true });
}

function pressCtrlF() {
  fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('canvas search — Cmd/Ctrl+F shortcut', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('opens search when Cmd+F is pressed with focus inside the canvas workspace', () => {
    renderWithCanvasPanel();
    const workspace = screen.getByTestId('canvas-workspace');

    // Focus the workspace (simulates user clicking on the canvas background)
    act(() => workspace.focus());
    expect(document.activeElement).toBe(workspace);

    // Verify search is initially closed (toggle button visible)
    expect(screen.getByTestId('canvas-search-toggle')).toBeInTheDocument();

    // Press Cmd+F
    pressMetaF();

    // Search input should now be visible
    expect(screen.getByTestId('canvas-search-input')).toBeInTheDocument();
  });

  it('opens search when Ctrl+F is pressed (Windows/Linux)', () => {
    renderWithCanvasPanel();
    const workspace = screen.getByTestId('canvas-workspace');
    act(() => workspace.focus());

    pressCtrlF();

    expect(screen.getByTestId('canvas-search-input')).toBeInTheDocument();
  });

  it('does NOT open search when Cmd+F is pressed with focus outside the canvas', () => {
    render(
      <div>
        <button data-testid="outside-button">Outside</button>
        <div data-testid="canvas-panel">
          <div data-testid="canvas-workspace" tabIndex={-1}>
            <div data-testid="canvas-controls">
              <CanvasSearch views={views} onSelectView={vi.fn()} />
            </div>
          </div>
        </div>
      </div>,
    );

    // Focus the outside button
    const outsideBtn = screen.getByTestId('outside-button');
    act(() => outsideBtn.focus());
    expect(document.activeElement).toBe(outsideBtn);

    pressMetaF();

    // Search should remain closed
    expect(screen.getByTestId('canvas-search-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-search-input')).not.toBeInTheDocument();
  });

  it('opens search when focus is on a child element inside the canvas panel', () => {
    render(
      <div data-testid="canvas-panel">
        <button data-testid="tab-bar-button">Tab</button>
        <div data-testid="canvas-workspace" tabIndex={-1}>
          <div data-testid="canvas-controls">
            <CanvasSearch views={views} onSelectView={vi.fn()} />
          </div>
        </div>
      </div>,
    );

    // Focus a button in the tab bar area (inside canvas-panel but outside workspace)
    const tabBtn = screen.getByTestId('tab-bar-button');
    act(() => tabBtn.focus());

    pressMetaF();

    // Search should open since focus is within the canvas panel
    expect(screen.getByTestId('canvas-search-input')).toBeInTheDocument();
  });

  it('returns focus to workspace when search is closed via Escape', () => {
    renderWithCanvasPanel();
    const workspace = screen.getByTestId('canvas-workspace');
    act(() => workspace.focus());

    // Open search
    pressMetaF();
    expect(screen.getByTestId('canvas-search-input')).toBeInTheDocument();

    // Press Escape to close
    const input = screen.getByTestId('canvas-search-input');
    fireEvent.keyDown(input, { key: 'Escape' });

    // Search should be closed and workspace should have focus
    expect(screen.getByTestId('canvas-search-toggle')).toBeInTheDocument();
    expect(document.activeElement).toBe(workspace);
  });

  it('returns focus to workspace when a search result is selected', () => {
    const onSelectView = vi.fn();
    renderWithCanvasPanel(onSelectView);
    const workspace = screen.getByTestId('canvas-workspace');
    act(() => workspace.focus());

    // Open search
    pressMetaF();

    // Click on first result
    const result = screen.getByTestId('canvas-search-result-cv_1');
    fireEvent.click(result);

    expect(onSelectView).toHaveBeenCalledWith('cv_1');
    expect(document.activeElement).toBe(workspace);
  });

  it('returns focus to workspace when toggle button closes search', () => {
    renderWithCanvasPanel();
    const workspace = screen.getByTestId('canvas-workspace');
    act(() => workspace.focus());

    // Open search
    pressMetaF();
    expect(screen.getByTestId('canvas-search-input')).toBeInTheDocument();

    // Click close button
    fireEvent.click(screen.getByTestId('canvas-search-close'));

    expect(screen.getByTestId('canvas-search-toggle')).toBeInTheDocument();
    expect(document.activeElement).toBe(workspace);
  });

  it('does NOT open when CanvasSearch is not within a canvas-panel', () => {
    // Render without the canvas-panel wrapper
    render(
      <div data-testid="canvas-workspace" tabIndex={-1}>
        <CanvasSearch views={views} onSelectView={vi.fn()} />
      </div>,
    );

    const workspace = screen.getByTestId('canvas-workspace');
    act(() => workspace.focus());

    pressMetaF();

    // Should NOT open because there's no canvas-panel ancestor
    expect(screen.getByTestId('canvas-search-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-search-input')).not.toBeInTheDocument();
  });
});

describe('canvas search — Enter-to-cycle through multiple matches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function openSearchAndType(onSelectView: ReturnType<typeof vi.fn>, query: string) {
    renderWithCanvasPanel(onSelectView, multiAgentViews);
    const workspace = screen.getByTestId('canvas-workspace');
    act(() => workspace.focus());
    pressMetaF();
    const input = screen.getByTestId('canvas-search-input');
    fireEvent.change(input, { target: { value: query } });
    return input;
  }

  it('navigates to first match on Enter, then cycles on subsequent presses', () => {
    const onSelectView = vi.fn();
    const input = openSearchAndType(onSelectView, 'agent');

    // First Enter: navigate to first match (cv_a1)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectView).toHaveBeenCalledTimes(1);
    expect(onSelectView).toHaveBeenCalledWith('cv_a1');

    // Second Enter: navigate to second match (cv_a2)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectView).toHaveBeenCalledTimes(2);
    expect(onSelectView).toHaveBeenCalledWith('cv_a2');

    // Third Enter: navigate to third match (cv_a3)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectView).toHaveBeenCalledTimes(3);
    expect(onSelectView).toHaveBeenCalledWith('cv_a3');
  });

  it('wraps around after the last match', () => {
    const onSelectView = vi.fn();
    const input = openSearchAndType(onSelectView, 'agent');

    // Cycle through all 3 matches
    fireEvent.keyDown(input, { key: 'Enter' }); // cv_a1
    fireEvent.keyDown(input, { key: 'Enter' }); // cv_a2
    fireEvent.keyDown(input, { key: 'Enter' }); // cv_a3

    // Fourth Enter should wrap back to first
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectView).toHaveBeenCalledTimes(4);
    expect(onSelectView).toHaveBeenLastCalledWith('cv_a1');
  });

  it('does not close search when cycling with multiple matches', () => {
    const onSelectView = vi.fn();
    const input = openSearchAndType(onSelectView, 'agent');

    fireEvent.keyDown(input, { key: 'Enter' });

    // Search should still be open
    expect(screen.getByTestId('canvas-search-input')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-search-results')).toBeInTheDocument();
  });

  it('closes search on Enter when there is exactly one match', () => {
    const onSelectView = vi.fn();
    const input = openSearchAndType(onSelectView, 'alpha');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectView).toHaveBeenCalledWith('cv_a1');
    // Search should be closed
    expect(screen.getByTestId('canvas-search-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-search-input')).not.toBeInTheDocument();
  });

  it('shows match counter when cycling', () => {
    const onSelectView = vi.fn();
    const input = openSearchAndType(onSelectView, 'agent');

    // No counter before first Enter
    expect(screen.queryByTestId('canvas-search-match-count')).not.toBeInTheDocument();

    // First Enter: should show "1 / 3"
    fireEvent.keyDown(input, { key: 'Enter' });
    const counter = screen.getByTestId('canvas-search-match-count');
    expect(counter.textContent).toContain('1');
    expect(counter.textContent).toContain('3');
  });

  it('does nothing on Enter when no results match', () => {
    const onSelectView = vi.fn();
    const input = openSearchAndType(onSelectView, 'nonexistent');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectView).not.toHaveBeenCalled();
  });
});
