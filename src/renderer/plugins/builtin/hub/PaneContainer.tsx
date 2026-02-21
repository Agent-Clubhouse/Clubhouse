import React, { useCallback, useMemo, useRef } from 'react';
import type { PaneNode, LeafPane } from './pane-tree';
import { collectLeaves, findLeaf } from './pane-tree';

export interface PaneComponentProps {
  pane: LeafPane;
  focused: boolean;
  canClose: boolean;
}

interface PaneContainerProps {
  tree: PaneNode;
  focusedPaneId: string;
  PaneComponent: React.ComponentType<PaneComponentProps>;
  zoomedPaneId?: string | null;
  onSplitResize?: (splitId: string, ratio: number) => void;
  onResizeStart?: (splitId: string) => number;
}

function PaneDivider({
  orientation,
  splitId,
  startRatio,
  parentRef,
  onResize,
}: {
  orientation: 'horizontal' | 'vertical';
  splitId: string;
  startRatio: number;
  parentRef: React.RefObject<HTMLDivElement | null>;
  onResize?: (splitId: string, ratio: number) => void;
}) {
  const isHorizontal = orientation === 'horizontal';
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!onResize || !parentRef.current) return;
    draggingRef.current = true;
    const startPos = isHorizontal ? e.clientX : e.clientY;
    const parentRect = parentRef.current.getBoundingClientRect();
    const parentSize = isHorizontal ? parentRect.width : parentRect.height;
    const currentRatio = startRatio;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

    const handleMouseMove = (ev: MouseEvent) => {
      const currentPos = isHorizontal ? ev.clientX : ev.clientY;
      const delta = currentPos - startPos;
      const newRatio = currentRatio + delta / parentSize;
      onResize(splitId, newRatio);
    };

    const handleMouseUp = () => {
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [isHorizontal, splitId, startRatio, parentRef, onResize]);

  return (
    <div
      className={`flex-shrink-0 bg-surface-2 hover:bg-ctp-accent/40 transition-colors ${
        isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize'
      }`}
      style={{ [isHorizontal ? 'width' : 'height']: 4 }}
      onMouseDown={handleMouseDown}
      data-testid={`pane-divider-${splitId}`}
    />
  );
}

function PaneContainerInner({
  tree,
  focusedPaneId,
  PaneComponent,
  canClose,
  onSplitResize,
}: PaneContainerProps & { canClose: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);

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
  const ratio = tree.ratio ?? 0.5;
  const sizeProp = isHorizontal ? 'width' : 'height';

  return (
    <div
      ref={parentRef}
      className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} w-full h-full min-w-0 min-h-0`}
    >
      <div className="min-w-0 min-h-0 overflow-hidden" style={{ [sizeProp]: `calc(${ratio * 100}% - 2px)` }}>
        <PaneContainerInner
          tree={tree.children[0]}
          focusedPaneId={focusedPaneId}
          PaneComponent={PaneComponent}
          canClose={canClose}
          onSplitResize={onSplitResize}
        />
      </div>
      <PaneDivider
        orientation={tree.direction}
        splitId={tree.id}
        startRatio={ratio}
        parentRef={parentRef}
        onResize={onSplitResize}
      />
      <div className="min-w-0 min-h-0 overflow-hidden" style={{ [sizeProp]: `calc(${(1 - ratio) * 100}% - 2px)` }}>
        <PaneContainerInner
          tree={tree.children[1]}
          focusedPaneId={focusedPaneId}
          PaneComponent={PaneComponent}
          canClose={canClose}
          onSplitResize={onSplitResize}
        />
      </div>
    </div>
  );
}

export function PaneContainer({ tree, focusedPaneId, PaneComponent, zoomedPaneId, onSplitResize }: PaneContainerProps) {
  const leafCount = useMemo(() => collectLeaves(tree).length, [tree]);
  const canClose = leafCount > 1;

  // Zoom mode: render only the zoomed leaf at full size
  if (zoomedPaneId) {
    const zoomedLeaf = findLeaf(tree, zoomedPaneId);
    if (zoomedLeaf) {
      return (
        <div className="w-full h-full overflow-hidden">
          <PaneComponent pane={zoomedLeaf} focused={true} canClose={canClose} />
        </div>
      );
    }
  }

  return (
    <div className="w-full h-full overflow-hidden">
      <PaneContainerInner
        tree={tree}
        focusedPaneId={focusedPaneId}
        PaneComponent={PaneComponent}
        canClose={canClose}
        onSplitResize={onSplitResize}
      />
    </div>
  );
}
