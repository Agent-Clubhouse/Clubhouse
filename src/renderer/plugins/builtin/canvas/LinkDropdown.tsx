/**
 * LinkDropdown — dropdown listing connectable canvas widgets for an agent.
 * Click to bind/unbind. Shows current connection state.
 */

import React, { useMemo, useRef, useEffect } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

interface LinkDropdownProps {
  /** The agent view that owns this dropdown. */
  agentView: AgentCanvasViewType;
  /** All views on the canvas. */
  views: CanvasView[];
  /** Callback to close the dropdown. */
  onClose: () => void;
}

function isValidLinkTarget(source: AgentCanvasViewType, target: CanvasView): boolean {
  if (target.id === source.id) return false;
  if (target.type === 'agent' && (target as AgentCanvasViewType).agentId) return true;
  if (target.type === 'plugin' && (target as PluginCanvasViewType).pluginWidgetType === 'plugin:browser:webview') return true;
  return false;
}

function targetLabel(view: CanvasView): string {
  return view.displayName || view.title;
}

function targetKind(view: CanvasView): 'agent' | 'browser' {
  if (view.type === 'agent') return 'agent';
  return 'browser';
}

export function LinkDropdown({ agentView, views, onClose }: LinkDropdownProps) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const bind = useMcpBindingStore((s) => s.bind);
  const unbind = useMcpBindingStore((s) => s.unbind);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const agentId = agentView.agentId;

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const targets = useMemo(
    () => views.filter((v) => isValidLinkTarget(agentView, v)),
    [agentView, views],
  );

  const agentBindings = useMemo(
    () => bindings.filter((b) => b.agentId === agentId),
    [bindings, agentId],
  );

  const isBound = (targetId: string) => agentBindings.some((b) => b.targetId === targetId);

  const handleToggle = async (target: CanvasView) => {
    if (!agentId) return;
    if (isBound(target.id)) {
      await unbind(agentId, target.id);
    } else {
      await bind(agentId, {
        targetId: target.id,
        targetKind: targetKind(target),
        label: targetLabel(target),
      });
    }
  };

  return (
    <div
      ref={dropdownRef}
      className="absolute top-full left-0 mt-1 w-56 bg-ctp-mantle border border-surface-2 rounded-lg shadow-xl overflow-hidden"
      style={{ zIndex: 99999 }}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="link-dropdown"
    >
      <div className="px-3 py-2 text-[10px] text-ctp-subtext0 uppercase tracking-wider border-b border-surface-0">
        Link to Widget
      </div>
      {targets.length === 0 ? (
        <div className="px-3 py-3 text-xs text-ctp-overlay0 italic">
          No connectable widgets on canvas
        </div>
      ) : (
        <div className="py-1 max-h-48 overflow-y-auto">
          {targets.map((target) => {
            const bound = isBound(target.id);
            return (
              <button
                key={target.id}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  bound
                    ? 'text-ctp-blue bg-ctp-blue/10 hover:bg-ctp-blue/20'
                    : 'text-ctp-text hover:bg-surface-1'
                }`}
                onClick={() => handleToggle(target)}
                data-testid={`link-target-${target.id}`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  bound ? 'bg-ctp-blue' : 'bg-ctp-overlay0'
                }`} />
                <span className="truncate">{targetLabel(target)}</span>
                <span className="text-[10px] text-ctp-overlay0 flex-shrink-0 ml-auto">
                  {targetKind(target)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
