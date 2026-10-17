/**
 * LinkDropdown — dropdown listing connectable canvas widgets for an agent.
 * Click to bind/unbind. Shows current connection state.
 */

import React, { useMemo, useRef, useEffect } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, PluginCanvasView as PluginCanvasViewType } from './canvas-types';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { CANVAS_Z } from './canvas-chrome';

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

  const resolveTargetId = (target: CanvasView) =>
    target.type === 'agent' ? (target as AgentCanvasViewType).agentId ?? target.id : target.id;

  const isBound = (target: CanvasView) => agentBindings.some((b) => b.targetId === resolveTargetId(target));

  const handleToggle = async (target: CanvasView) => {
    if (!agentId) return;
    if (isBound(target)) {
      await unbind(agentId, resolveTargetId(target));
    } else {
      const projectName = (target.metadata?.projectName as string)
        || (agentView.metadata?.projectName as string)
        || undefined;
      await bind(agentId, {
        targetId: resolveTargetId(target),
        targetKind: targetKind(target),
        label: targetLabel(target),
        agentName: agentView.displayName || agentView.title,
        targetName: target.displayName || target.title,
        projectName,
      });
    }
  };

  return (
    <div
      ref={dropdownRef}
      className="absolute top-full left-0 mt-1 w-56 py-1 bg-ctp-mantle border border-surface-1 rounded-lg shadow-xl overflow-hidden"
      style={{ zIndex: CANVAS_Z.popover }}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="link-dropdown"
    >
      <div className="h-7 flex items-center px-3 text-xs text-ctp-overlay1">
        Link to widget
      </div>
      {targets.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-ctp-overlay1">
          No widgets on this canvas to link
        </div>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          {targets.map((target) => {
            const bound = isBound(target);
            return (
              <button
                key={target.id}
                role="menuitemcheckbox"
                aria-checked={bound}
                className="w-full h-7 flex items-center gap-2 px-3 text-left text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text transition-colors"
                onClick={() => handleToggle(target)}
                data-testid={`link-target-${target.id}`}
              >
                <span className="w-3.5 flex-shrink-0 flex items-center text-ctp-text" aria-hidden="true">
                  {bound && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  )}
                </span>
                <span className="truncate">{targetLabel(target)}</span>
                <span className="text-xs text-ctp-overlay1 flex-shrink-0 ml-auto">
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
