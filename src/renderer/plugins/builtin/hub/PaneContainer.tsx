import React, { useMemo } from 'react';
import type { PaneNode, LeafPane } from './pane-tree';
import { collectLeaves } from './pane-tree';

export interface PaneComponentProps {
  pane: LeafPane;
  focused: boolean;
  canClose: boolean;
}

interface PaneContainerProps {
  tree: PaneNode;
  focusedPaneId: string;
  PaneComponent: React.ComponentType<PaneComponentProps>;
}

function PaneContainerInner({ tree, focusedPaneId, PaneComponent, canClose }: PaneContainerProps & { canClose: boolean }) {
  if (tree.type === 'leaf') {
    return (
      <PaneComponent
        pane={tree}
        focused={tree.id === focusedPaneId}
        canClose={canClose}
      />
    );
  }

  const isHorizontal = tree.direction === 'horizontal';

  return (
    <div
      className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} w-full h-full min-w-0 min-h-0`}
    >
      <div className="flex-1 min-w-0 min-h-0">
        <PaneContainerInner
          tree={tree.children[0]}
          focusedPaneId={focusedPaneId}
          PaneComponent={PaneComponent}
          canClose={canClose}
        />
      </div>
      <div className={`${isHorizontal ? 'w-px' : 'h-px'} bg-surface-2 flex-shrink-0`} />
      <div className="flex-1 min-w-0 min-h-0">
        <PaneContainerInner
          tree={tree.children[1]}
          focusedPaneId={focusedPaneId}
          PaneComponent={PaneComponent}
          canClose={canClose}
        />
      </div>
    </div>
  );
}

export function PaneContainer({ tree, focusedPaneId, PaneComponent }: PaneContainerProps) {
  const leafCount = useMemo(() => collectLeaves(tree).length, [tree]);
  const canClose = leafCount > 1;

  return (
    <div className="w-full h-full overflow-hidden">
      <PaneContainerInner tree={tree} focusedPaneId={focusedPaneId} PaneComponent={PaneComponent} canClose={canClose} />
    </div>
  );
}
