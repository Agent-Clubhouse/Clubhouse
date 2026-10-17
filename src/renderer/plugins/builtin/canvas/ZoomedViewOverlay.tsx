/**
 * ZoomedViewOverlay — full-screen overlay for a zoomed canvas view.
 *
 * Extracted from CanvasWorkspace so the zoomed overlay can be independently
 * rendered without affecting the main canvas transform layer.
 */

import React from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, Viewport, Size } from './canvas-types';
import type { PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import type { PluginAPI, CanvasWidgetMetadata } from '../../../../shared/plugin-types';
import { AgentCanvasView } from './AgentCanvasView';
import { getRegisteredWidgetType } from '../../canvas-widget-registry';
import { buildProjectContext } from './CanvasView';
import type { AgentInfo } from '../../../../shared/plugin-types';

interface ZoomedViewOverlayProps {
  view: CanvasView;
  api: PluginAPI;
  viewport: Viewport;
  onClose: () => void;
  onUpdateView: (viewId: string, updates: Partial<CanvasView>) => void;
  onCreateAgentCard?: (parentView: AgentCanvasViewType, agent: AgentInfo) => void;
}

export function ZoomedViewOverlay({
  view,
  api,
  onClose,
  onUpdateView,
  onCreateAgentCard,
}: ZoomedViewOverlayProps) {
  return (
    <div
      className="absolute inset-0 z-canvas-dialog flex items-center justify-center bg-ctp-crust/80 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="canvas-zoom-overlay"
    >
      <div
        className="w-[calc(100%-48px)] h-[calc(100%-48px)] flex flex-col bg-ctp-base border border-surface-1 rounded-lg overflow-hidden shadow-2xl"
      >
        {/* Title bar: name, project, Restore */}
        <div className="flex items-center gap-2 h-9 pl-3 pr-1.5 bg-ctp-mantle border-b border-surface-0 flex-shrink-0">
          <span className="text-[13px] font-medium text-ctp-text truncate">{view.displayName || view.title}</span>
          {(() => {
            const ctx = buildProjectContext(view, api.projects.list());
            return ctx ? <span className="text-xs text-ctp-overlay1 truncate flex-shrink-0">{ctx}</span> : null;
          })()}
          <span className="flex-1" />
          <button
            type="button"
            className="h-7 px-2.5 rounded-md border border-surface-1 text-xs font-medium text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text transition-colors"
            onClick={onClose}
            data-testid="canvas-zoom-restore"
          >
            Restore
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto" onWheel={(e) => e.stopPropagation()}>
          {view.type === 'agent' && (
            <AgentCanvasView
              view={view as AgentCanvasViewType}
              api={api}
              onUpdate={(u: Partial<CanvasView>) => onUpdateView(view.id, u)}
              onCreateAgentCard={onCreateAgentCard}
            />
          )}
          {view.type === 'plugin' && (() => {
            const pluginView = view as PluginCanvasViewType;
            const registered = getRegisteredWidgetType(pluginView.pluginWidgetType);
            if (!registered) return null;
            const Component = registered.descriptor.component;
            return (
              <Component
                widgetId={view.id}
                api={registered.pluginApi ?? api}
                metadata={view.metadata}
                onUpdateMetadata={(updates: CanvasWidgetMetadata) => onUpdateView(view.id, { metadata: { ...view.metadata, ...updates } })}
                size={view.size as Size}
              />
            );
          })()}
        </div>
      </div>
    </div>
  );
}
