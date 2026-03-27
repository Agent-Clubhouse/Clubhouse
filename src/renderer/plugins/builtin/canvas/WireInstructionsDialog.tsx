/**
 * WireInstructionsDialog — modal dialog for editing per-wire custom instructions.
 * Instructions are scoped per-tool (or "All Tools" by default).
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

/** Known tool suffixes for each target kind. */
const TOOL_SUFFIXES: Record<string, string[]> = {
  agent: ['send_message', 'get_status', 'read_output', 'check_connectivity', 'send_file', 'wake'],
  browser: ['navigate', 'screenshot', 'get_console', 'click', 'type', 'evaluate', 'get_page_content', 'get_accessibility_tree'],
  'group-project': ['list_members', 'post_bulletin', 'read_bulletin', 'read_topic', 'get_project_info', 'shoulder_tap', 'broadcast'],
  terminal: [],
};

/** Human-friendly labels for tool suffixes. */
function toolLabel(suffix: string): string {
  return suffix.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface WireInstructionsDialogProps {
  binding: McpBindingEntry;
  onSave: (instructions: Record<string, string>) => void;
  onClose: () => void;
}

export function WireInstructionsDialog({ binding, onSave, onClose }: WireInstructionsDialogProps) {
  const suffixes = TOOL_SUFFIXES[binding.targetKind] || [];
  const dropdownOptions = ['*', ...suffixes];

  // Initialize from existing instructions
  const [selectedTool, setSelectedTool] = useState<string>('*');
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    return { ...(binding.instructions || {}) };
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Focus textarea on mount / tool change
  useEffect(() => {
    textareaRef.current?.focus();
  }, [selectedTool]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const currentValue = drafts[selectedTool] || '';

  const handleTextChange = (value: string) => {
    setDrafts((prev) => ({ ...prev, [selectedTool]: value }));
  };

  const handleSave = () => {
    // Clean empty entries
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(drafts)) {
      if (value.trim()) cleaned[key] = value.trim();
    }
    onSave(cleaned);
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.target === backdropRef.current) {
      onClose();
    }
  };

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Count how many tools have instructions set
  const instructionCount = useMemo(() => {
    return Object.values(drafts).filter((v) => v.trim()).length;
  }, [drafts]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: 100000 }}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      data-testid="wire-instructions-dialog"
    >
      <div className="bg-ctp-mantle border border-surface-2 rounded-lg shadow-2xl w-[420px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 bg-ctp-base border-b border-surface-0">
          <div className="text-sm text-ctp-text font-medium">Wire Instructions</div>
          <div className="text-[10px] text-ctp-subtext0 mt-0.5">
            {binding.label} ({binding.targetKind})
          </div>
        </div>

        {/* Tool selector */}
        <div className="px-4 pt-3">
          <label className="text-[10px] text-ctp-subtext1 uppercase tracking-wider font-medium">
            Apply to
          </label>
          <select
            value={selectedTool}
            onChange={(e) => setSelectedTool(e.target.value)}
            className="mt-1 w-full bg-ctp-base border border-surface-2 rounded px-2 py-1.5 text-xs text-ctp-text focus:outline-none focus:ring-1 focus:ring-ctp-accent"
            data-testid="wire-instructions-tool-select"
          >
            {dropdownOptions.map((suffix) => (
              <option key={suffix} value={suffix}>
                {suffix === '*' ? 'All Tools' : toolLabel(suffix)}
                {drafts[suffix]?.trim() ? ' *' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Instructions textarea */}
        <div className="px-4 pt-2 pb-3 flex-1">
          <textarea
            ref={textareaRef}
            value={currentValue}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={`e.g. "Do not transmit raw telemetry over this connection"`}
            className="w-full h-32 bg-ctp-base border border-surface-2 rounded px-2.5 py-2 text-xs text-ctp-text placeholder-ctp-overlay0 resize-none focus:outline-none focus:ring-1 focus:ring-ctp-accent"
            data-testid="wire-instructions-textarea"
          />
          <div className="text-[10px] text-ctp-overlay0 mt-1">
            {selectedTool === '*'
              ? 'Applied to all tools on this wire unless overridden per-tool.'
              : `Applied only to the ${toolLabel(selectedTool)} tool.`}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-surface-0 flex items-center justify-between">
          <span className="text-[10px] text-ctp-overlay0">
            {instructionCount > 0 ? `${instructionCount} instruction${instructionCount > 1 ? 's' : ''} set` : 'No instructions set'}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 rounded transition-colors"
              data-testid="wire-instructions-cancel"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 text-xs text-white bg-ctp-accent hover:bg-ctp-accent/80 rounded transition-colors"
              data-testid="wire-instructions-save"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
