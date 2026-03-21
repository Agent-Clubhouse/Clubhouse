/**
 * WireConfigPopover — click-on-wire popover showing binding details with
 * disconnect, bidirectional toggle, and custom instructions controls.
 */

import React, { useRef, useEffect, useState } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { Toggle } from '../../../components/Toggle';
import { WireInstructionsDialog } from './WireInstructionsDialog';

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
  const setInstructions = useMcpBindingStore((s) => s.setInstructions);
  const bindings = useMcpBindingStore((s) => s.bindings);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [bidirectional, setBidirectional] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  // Keep binding in sync with store (instructions may change)
  const liveBinding = bindings.find(
    (b) => b.agentId === binding.agentId && b.targetId === binding.targetId,
  ) || binding;

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

  // Close on click outside (skip when instructions dialog is open)
  useEffect(() => {
    if (showInstructions) return;
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
  }, [onClose, showInstructions]);

  const handleDisconnect = async () => {
    await unbind(binding.agentId, binding.targetId);
    // Also remove reverse binding if bidirectional
    if (bidirectional && isAgentToAgent) {
      await unbind(binding.targetId, binding.agentId);
    }
    onClose();
  };

  const handleBidirectionalToggle = async (newValue: boolean) => {
    if (!newValue) {
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

  const handleSaveInstructions = async (instructions: Record<string, string>) => {
    await setInstructions(binding.agentId, binding.targetId, instructions);
    // Mirror instructions to the reverse binding for bidirectional agent-to-agent wires
    if (bidirectional && isAgentToAgent) {
      await setInstructions(binding.targetId, binding.agentId, instructions);
    }
  };

  const hasInstructions = liveBinding.instructions && Object.keys(liveBinding.instructions).length > 0;

  return (
    <>
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
            <div
              className="flex items-center gap-2 px-2 py-1.5"
              data-testid="wire-bidirectional-toggle"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ctp-subtext0 flex-shrink-0">
                <polyline points="7 17 2 12 7 7" />
                <polyline points="17 7 22 12 17 17" />
                <line x1="2" y1="12" x2="22" y2="12" />
              </svg>
              <span className="flex-1 text-xs text-ctp-subtext0">Bidirectional</span>
              <Toggle checked={bidirectional} onChange={handleBidirectionalToggle} />
            </div>
          )}

          {/* Set Instructions */}
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 rounded transition-colors"
            onClick={() => setShowInstructions(true)}
            data-testid="wire-instructions-button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <span className="flex-1 text-left">
              {hasInstructions ? 'Edit Instructions' : 'Set Instructions'}
            </span>
            {hasInstructions && (
              <span className="w-1.5 h-1.5 rounded-full bg-ctp-accent flex-shrink-0" />
            )}
          </button>

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

      {/* Instructions dialog */}
      {showInstructions && (
        <WireInstructionsDialog
          binding={liveBinding}
          onSave={handleSaveInstructions}
          onClose={() => setShowInstructions(false)}
        />
      )}
    </>
  );
}
