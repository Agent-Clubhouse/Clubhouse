import React from 'react';
import { render, screen } from '@testing-library/react';
import { PaneContainer } from './PaneContainer';
import type { PaneComponentProps } from './PaneContainer';
import type { LeafPane, SplitPane } from './pane-tree';

function TestPane({ pane, focused, canClose }: PaneComponentProps) {
  return (
    <div data-testid={`pane-${pane.id}`}>
      <span data-testid={`focused-${pane.id}`}>{String(focused)}</span>
      <span data-testid={`canclose-${pane.id}`}>{String(canClose)}</span>
    </div>
  );
}

describe('PaneContainer', () => {
  it('single leaf renders one pane', () => {
    const leaf: LeafPane = { type: 'leaf', id: 'p1', agentId: null };

    render(
      <PaneContainer tree={leaf} focusedPaneId="p1" PaneComponent={TestPane} />,
    );

    expect(screen.getByTestId('pane-p1')).toBeInTheDocument();
    expect(screen.getByTestId('focused-p1').textContent).toBe('true');
  });

  it('horizontal split renders two panes with divider', () => {
    const split: SplitPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    render(
      <PaneContainer tree={split} focusedPaneId="p1" PaneComponent={TestPane} />,
    );

    expect(screen.getByTestId('pane-p1')).toBeInTheDocument();
    expect(screen.getByTestId('pane-p2')).toBeInTheDocument();
    expect(screen.getByTestId('focused-p1').textContent).toBe('true');
    expect(screen.getByTestId('focused-p2').textContent).toBe('false');

    // Divider present
    expect(screen.getByTestId('pane-divider-s1')).toBeInTheDocument();
  });

  it('canClose false for single pane, true for multi', () => {
    // Single pane
    const leaf: LeafPane = { type: 'leaf', id: 'p1', agentId: null };
    const { unmount } = render(
      <PaneContainer tree={leaf} focusedPaneId="p1" PaneComponent={TestPane} />,
    );
    expect(screen.getByTestId('canclose-p1').textContent).toBe('false');
    unmount();

    // Multi pane
    const split: SplitPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    render(
      <PaneContainer tree={split} focusedPaneId="p1" PaneComponent={TestPane} />,
    );
    expect(screen.getByTestId('canclose-p1').textContent).toBe('true');
    expect(screen.getByTestId('canclose-p2').textContent).toBe('true');
  });

  it('renders ratio-based sizing', () => {
    const split: SplitPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.3,
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    const { container } = render(
      <PaneContainer tree={split} focusedPaneId="p1" PaneComponent={TestPane} />,
    );

    // Find the pane wrappers
    const paneWrappers = container.querySelectorAll('.min-w-0.min-h-0.overflow-hidden');
    expect(paneWrappers.length).toBe(2);
    expect((paneWrappers[0] as HTMLElement).style.width).toBe('calc(30% - 2px)');
    expect((paneWrappers[1] as HTMLElement).style.width).toBe('calc(70% - 2px)');
  });

  it('defaults to 0.5 ratio when ratio is undefined', () => {
    const split: SplitPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    const { container } = render(
      <PaneContainer tree={split} focusedPaneId="p1" PaneComponent={TestPane} />,
    );

    const paneWrappers = container.querySelectorAll('.min-w-0.min-h-0.overflow-hidden');
    expect((paneWrappers[0] as HTMLElement).style.width).toBe('calc(50% - 2px)');
  });

  it('zoom mode renders only the zoomed pane', () => {
    const split: SplitPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    render(
      <PaneContainer
        tree={split}
        focusedPaneId="p1"
        PaneComponent={TestPane}
        zoomedPaneId="p2"
      />,
    );

    expect(screen.getByTestId('pane-p2')).toBeInTheDocument();
    expect(screen.queryByTestId('pane-p1')).toBeNull();
    expect(screen.getByTestId('focused-p2').textContent).toBe('true');
  });

  it('zoom mode falls back to normal when pane not found', () => {
    const split: SplitPane = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    render(
      <PaneContainer
        tree={split}
        focusedPaneId="p1"
        PaneComponent={TestPane}
        zoomedPaneId="nonexistent"
      />,
    );

    // Falls through to normal rendering
    expect(screen.getByTestId('pane-p1')).toBeInTheDocument();
    expect(screen.getByTestId('pane-p2')).toBeInTheDocument();
  });
});
