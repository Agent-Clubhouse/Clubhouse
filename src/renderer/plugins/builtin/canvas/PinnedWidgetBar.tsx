/**
 * PinnedWidgetBar — toolbar strip that renders pinned plugin widgets.
 *
 * Extracted from CanvasWorkspace to isolate pinned-widget recomputation from
 * the main canvas render cycle.
 */

import React from 'react';
import type { CanvasView, Viewport, Size } from './canvas-types';
import type { PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import type { PluginAPI, CanvasWidgetMetadata } from '../../../../shared/plugin-types';
import { getRegisteredWidgetType } from '../../canvas-widget-registry';
import { screenToCanvas } from './canvas-operations';

interface PinnedWidgetBarProps {
  views: CanvasView[];
  viewport: Viewport;
  containerRef: React.RefObject<HTMLDivElement | null>;
  containerSize: Size;
  api: PluginAPI;
  onUpdateView: (viewId: string, updates: Partial<CanvasView>) => void;
}

export function PinnedWidgetBar({
  views,
  viewport,
  containerRef,
  containerSize,
  api,
  onUpdateView,
}: PinnedWidgetBarProps) {
  const pinnedWidgets = views
    .filter((v): v is PluginCanvasViewType =>
      v.type === 'plugin' && !!(v.metadata as CanvasWidgetMetadata).__pinnedToControls
    )
    .map((view) => {
      const registered = getRegisteredWidgetType(view.pluginWidgetType);
      if (!registered) return null;

      const onUpdateMetadata = (updates: CanvasWidgetMetadata) => {
        const newMetadata = { ...view.metadata, ...updates };
        const isUnpinning =
          updates.__pinnedToControls === false &&
          (view.metadata as CanvasWidgetMetadata).__pinnedToControls === true;

        if (isUnpinning) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) {
            onUpdateView(view.id, { metadata: newMetadata });
            return;
          }

          const viewportCenter = screenToCanvas(
            rect.left + containerSize.width / 2,
            rect.top + containerSize.height / 2,
            rect,
            viewport,
          );

          const widgetSize = view.size || { width: 300, height: 300 };
          const viewportWidth = containerSize.width / viewport.zoom;
          const viewportHeight = containerSize.height / viewport.zoom;

          const doesOverlap = (px: number, py: number) => {
            for (const other of views) {
              if (other.id === view.id || other.type === 'zone') continue;
              const { x: ox, y: oy } = other.position;
              const ow = other.size.width;
              const oh = other.size.height;
              if (px < ox + ow && px + widgetSize.width > ox && py < oy + oh && py + widgetSize.height > oy) {
                return true;
              }
            }
            return false;
          };

          const candidates = [
            { x: viewportCenter.x - widgetSize.width / 2, y: viewportCenter.y - widgetSize.height / 2 },
            { x: viewportCenter.x - viewportWidth / 3, y: viewportCenter.y - viewportHeight / 3 },
            { x: viewportCenter.x + viewportWidth / 3 - widgetSize.width, y: viewportCenter.y - viewportHeight / 3 },
            { x: viewportCenter.x - viewportWidth / 3, y: viewportCenter.y + viewportHeight / 3 - widgetSize.height },
            { x: viewportCenter.x + viewportWidth / 3 - widgetSize.width, y: viewportCenter.y + viewportHeight / 3 - widgetSize.height },
          ];

          let finalPos = candidates[0];
          for (const candidate of candidates) {
            if (!doesOverlap(candidate.x, candidate.y)) {
              finalPos = candidate;
              break;
            }
          }

          onUpdateView(view.id, { metadata: newMetadata, position: finalPos, size: widgetSize });
        } else {
          onUpdateView(view.id, { metadata: newMetadata });
        }
      };

      return { view, registered, onUpdateMetadata };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (pinnedWidgets.length === 0) return null;

  return (
    <div
      className="absolute top-12 right-3 flex items-center gap-1 bg-ctp-mantle/90 backdrop-blur-sm rounded-lg border border-surface-0 px-1.5 py-1 shadow-sm flex-wrap max-w-[calc(100%-24px)]"
      data-testid="canvas-pinned-widgets"
    >
      {pinnedWidgets.map((item) => {
        const PinnedComponent = item.registered.descriptor.pinnedComponent;
        if (!PinnedComponent) return null;
        return (
          <div key={item.view.id} className="flex items-center gap-1 px-2 py-1 bg-surface-0/50 rounded">
            <div className="flex-1">
              <PinnedComponent
                widgetId={item.view.id}
                api={item.registered.pluginApi ?? api}
                metadata={item.view.metadata}
                onUpdateMetadata={item.onUpdateMetadata}
              />
            </div>
            <button
              onClick={() => item.onUpdateMetadata({ __pinnedToControls: false })}
              className="w-4 h-4 flex items-center justify-center rounded text-ctp-accent hover:bg-surface-1 transition-colors flex-shrink-0"
              title="Unpin from toolbar"
              data-testid={`canvas-unpin-${item.view.id}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="12 2 8 8 16 8" />
                <rect x="11" y="8" width="2" height="8" />
                <circle cx="12" cy="19" r="3" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
