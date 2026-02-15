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
      children: [
        { type: 'leaf', id: 'p1', agentId: null },
        { type: 'leaf', id: 'p2', agentId: null },
      ],
    };

    const { container } = render(
      <PaneContainer tree={split} focusedPaneId="p1" PaneComponent={TestPane} />,
    );

    expect(screen.getByTestId('pane-p1')).toBeInTheDocument();
    expect(screen.getByTestId('pane-p2')).toBeInTheDocument();
    expect(screen.getByTestId('focused-p1').textContent).toBe('true');
    expect(screen.getByTestId('focused-p2').textContent).toBe('false');

    // Divider present (w-px element)
    const divider = container.querySelector('.w-px');
    expect(divider).not.toBeNull();
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
});
