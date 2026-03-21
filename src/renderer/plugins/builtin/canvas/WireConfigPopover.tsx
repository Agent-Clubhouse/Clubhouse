/**
 * WireConfigPopover — click-on-wire popover showing binding details with
 * disconnect and bidirectional toggle controls.
 */

import React, { useRef, useEffect, useState } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';

interface WireConfigPopoverProps {
  binding: McpBindingEntry;
  /** Screen-space position where the popover appears. */
  x: number;
  y: number;
  onClose: () => void;
}

export function WireConfigPopover({ binding, x, y, onClose }: WireConfigPopoverProps) {
  const unbind = useMcpBindingStore((s) => s.unbind);
  const bind = useMcpBindingStore((s) => s.bind);
  const bindings = useMcpBindingStore((s) => s.bindings);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [bidirectional, setBidirectional] = useState(false);

  // Check if reverse binding exists (agent-to-agent only)
  const isAgentToAgent = binding.targetKind === 'agent';
  useEffect(() => {
    if (isAgentToAgent) {
      const reverse = bindings.some(
        (b) => b.agentId === binding.targetId && b.targetId === binding.agentId,
      );
      setBidirectional(reverse);
    }
  }, [bindings, binding, isAgentToAgent]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the same click
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const handleDisconnect = async () => {
    await unbind(binding.agentId, binding.targetId);
    // Also remove reverse binding if bidirectional
    if (bidirectional && isAgentToAgent) {
      await unbind(binding.targetId, binding.agentId);
    }
    onClose();
  };

  const handleBidirectionalToggle = async () => {
    if (bidirectional) {
      // Remove reverse binding
      await unbind(binding.targetId, binding.agentId);
    } else {
      // Create reverse binding
      // Find the source agent's label from bindings
      const sourceLabel = bindings.find(
        (b) => b.targetId === binding.agentId && b.targetKind === 'agent',
      )?.label || binding.agentId;
      await bind(binding.targetId, {
        targetId: binding.agentId,
        targetKind: 'agent',
        label: sourceLabel,
      });
    }
  };

  return (
    <div
      ref={popoverRef}
      className="fixed bg-ctp-mantle border border-surface-2 rounded-lg shadow-xl overflow-hidden"
      style={{ left: x, top: y, zIndex: 99999, minWidth: 200 }}
      data-testid="wire-config-popover"
    >
      {/* Header */}
      <div className="px-3 py-2 bg-ctp-base border-b border-surface-0">
        <div className="text-xs text-ctp-text font-medium">Wire Connection</div>
        <div className="text-[10px] text-ctp-subtext0 mt-0.5">
          {binding.label} ({binding.targetKind})
        </div>
      </div>

      {/* Actions */}
      <div className="p-2 space-y-1">
        {/* Bidirectional toggle (agent-to-agent only) */}
        {isAgentToAgent && (
          <button
            className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded transition-colors ${
              bidirectional
                ? 'text-ctp-blue bg-ctp-blue/20 ring-1 ring-ctp-blue/40'
                : 'text-ctp-overlay1 hover:bg-surface-1'
            }`}
            onClick={handleBidirectionalToggle}
            data-testid="wire-bidirectional-toggle"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="7 17 2 12 7 7" />
              <polyline points="17 7 22 12 17 17" />
              <line x1="2" y1="12" x2="22" y2="12" />
            </svg>
            <span className="flex-1 text-left">Bidirectional</span>
            {/* Toggle pill indicator */}
            <span
              className={`relative inline-flex h-3.5 w-6 flex-shrink-0 rounded-full transition-colors ${
                bidirectional ? 'bg-ctp-blue' : 'bg-surface-2'
              }`}
              data-testid="wire-bidirectional-pill"
            >
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full bg-white shadow-sm transform transition-transform mt-[2px] ${
                  bidirectional ? 'translate-x-[13px]' : 'translate-x-[1px]'
                }`}
              />
            </span>
          </button>
        )}

        {/* Disconnect */}
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-ctp-red hover:bg-red-500/10 rounded transition-colors"
          onClick={handleDisconnect}
          data-testid="wire-disconnect"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Disconnect
        </button>
      </div>
    </div>
  );
}
