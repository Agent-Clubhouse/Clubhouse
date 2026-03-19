/**
 * WireOverlay — SVG component rendering MCP binding wires behind canvas widgets.
 *
 * Rendered inside the canvas transform container (before views) so wires are
 * in canvas-space and track with pan/zoom automatically.
 */

import React, { useMemo } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { computeWirePath, viewRect } from './wire-utils';

/** CSS animation for ambient wire glow */
const WIRE_GLOW_KEYFRAMES = `
@keyframes wire-pulse {
  0%, 100% { filter: drop-shadow(0 0 3px rgba(137, 180, 250, 0.4)); }
  50% { filter: drop-shadow(0 0 6px rgba(137, 180, 250, 0.7)); }
}
`;

interface WireOverlayProps {
  views: CanvasView[];
  bindings: McpBindingEntry[];
  /** Optional per-view position overrides (e.g. during drag). */
  viewPositions?: Map<string, { x: number; y: number }>;
  onWireClick?: (binding: McpBindingEntry, event: React.MouseEvent) => void;
}

/**
 * Resolve a binding to its source and target views.
 * Source is the agent view (by agentId), target is looked up by targetId = view.id.
 */
function resolveBindingViews(
  binding: McpBindingEntry,
  viewMap: Map<string, CanvasView>,
): { source: CanvasView; target: CanvasView } | null {
  // Find agent view by agentId
  let source: CanvasView | undefined;
  for (const v of viewMap.values()) {
    if (v.type === 'agent' && (v as AgentCanvasViewType).agentId === binding.agentId) {
      source = v;
      break;
    }
  }
  if (!source) return null;

  const target = viewMap.get(binding.targetId);
  if (!target) return null;

  return { source, target };
}

export const WireOverlay = React.memo(function WireOverlay({
  views,
  bindings,
  viewPositions,
  onWireClick,
}: WireOverlayProps) {
  const viewMap = useMemo(() => {
    const m = new Map<string, CanvasView>();
    for (const v of views) m.set(v.id, v);
    return m;
  }, [views]);

  const wires = useMemo(() => {
    const result: Array<{
      key: string;
      path: string;
      binding: McpBindingEntry;
    }> = [];

    for (const binding of bindings) {
      const resolved = resolveBindingViews(binding, viewMap);
      if (!resolved) continue;

      const { source, target } = resolved;
      const srcPos = viewPositions?.get(source.id) ?? source.position;
      const tgtPos = viewPositions?.get(target.id) ?? target.position;

      const srcRect = viewRect(srcPos, source.size);
      const tgtRect = viewRect(tgtPos, target.size);
      const { path } = computeWirePath(srcRect, tgtRect);

      result.push({
        key: `${binding.agentId}--${binding.targetId}`,
        path,
        binding,
      });
    }

    return result;
  }, [bindings, viewMap, viewPositions]);

  if (wires.length === 0) return null;

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none overflow-visible"
      style={{ width: 1, height: 1, zIndex: 0 }}
    >
      <style>{WIRE_GLOW_KEYFRAMES}</style>
      {wires.map(({ key, path, binding }) => (
        <g key={key}>
          {/* Invisible thick hitbox for click interaction */}
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={8}
            style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
            onClick={(e) => onWireClick?.(binding, e)}
            data-testid={`wire-hitbox-${key}`}
          />
          {/* Visible styled wire */}
          <path
            d={path}
            fill="none"
            stroke="var(--ctp-blue, #89b4fa)"
            strokeWidth={2}
            strokeLinecap="round"
            style={{
              pointerEvents: 'none',
              animation: 'wire-pulse 3s ease-in-out infinite',
            }}
            data-testid={`wire-path-${key}`}
          />
        </g>
      ))}
    </svg>
  );
});
