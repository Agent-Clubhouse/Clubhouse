import type { ReactNode } from 'react';
import { ProjectRail } from '../panels/ProjectRail';
import { ResizeDivider } from './ResizeDivider';
import { usePanelStore } from '../stores/panelStore';

/**
 * Wraps the ProjectRail and its optional resize divider in a CSS grid.
 * Subscribes to rail-related panel state so that toggling the rail pin
 * does not force the parent App to re-render its entire subtree.
 */
export function RailSection({ children }: { children: ReactNode }) {
  const railPinned = usePanelStore((s) => s.railPinned);
  const resizeRail = usePanelStore((s) => s.resizeRail);
  const toggleRailPin = usePanelStore((s) => s.toggleRailPin);

  const railGridColumns = railPinned
    ? 'var(--rail-width, 68px) auto 1fr'
    : 'var(--rail-width, 68px) 1fr';

  return (
    <div className="flex-1 min-h-0 grid grid-rows-[1fr]" style={{ gridTemplateColumns: railGridColumns }}>
      <ProjectRail />
      {railPinned && (
        <ResizeDivider
          onResize={resizeRail}
          onToggleCollapse={toggleRailPin}
          collapsed={false}
          collapseDirection="left"
        />
      )}
      {children}
    </div>
  );
}
