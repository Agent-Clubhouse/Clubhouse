/**
 * WireInstructionsDialog — modal dialog for editing per-wire custom instructions.
 * Instructions are scoped per-tool (or "All Tools" by default).
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';

/** Known tool suffixes for each target kind. */
const TOOL_SUFFIXES: Record<string, string[]> = {
  agent: ['send_message', 'get_status', 'read_output', 'check_connectivity', 'send_file'],
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

  // Focus textarea on mount / tool change
  useEffect(() => {
    textareaRef.current?.focus();
  }, [selectedTool]);

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

  // Count how many tools have instructions set
  const instructionCount = useMemo(() => {
    return Object.values(drafts).filter((v) => v.trim()).length;
  }, [drafts]);

  return (
    // React bubbles portal events through this tree; keep a mousedown in the
    // dialog from reaching the canvas workspace and its wire popover.
    <div onMouseDown={(e) => e.stopPropagation()}>
      <Modal
        open
        onClose={onClose}
        title="Wire instructions"
        width="w-[420px]"
        backdropTestId="wire-instructions-dialog"
        initialFocusRef={textareaRef}
        footer={
          <>
            <span className="mr-auto text-xs text-ctp-overlay1">
              {instructionCount > 0 ? `${instructionCount} instruction${instructionCount > 1 ? 's' : ''} set` : 'No instructions set'}
            </span>
            <Button kind="quiet" onClick={onClose} data-testid="wire-instructions-cancel">Cancel</Button>
            <Button kind="primary" onClick={handleSave} data-testid="wire-instructions-save">Save</Button>
          </>
        }
      >
        <div className="text-xs text-ctp-overlay1 truncate mb-3">{binding.label}</div>
        <label className="block text-xs text-ctp-subtext1" htmlFor="wire-instructions-tool">
          Apply to
        </label>
        <select
          id="wire-instructions-tool"
          value={selectedTool}
          onChange={(e) => setSelectedTool(e.target.value)}
          className="mt-1 w-full h-7 bg-ctp-base border border-surface-1 rounded-md px-2 text-xs text-ctp-text focus-ring"
          data-testid="wire-instructions-tool-select"
        >
          {dropdownOptions.map((suffix) => (
            <option key={suffix} value={suffix}>
              {suffix === '*' ? 'All tools' : toolLabel(suffix)}
              {drafts[suffix]?.trim() ? ' *' : ''}
            </option>
          ))}
        </select>
        <textarea
          ref={textareaRef}
          value={currentValue}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder={`e.g. "Do not transmit raw telemetry over this connection"`}
          aria-label="Instructions"
          className="mt-2 w-full h-32 bg-ctp-base border border-surface-1 rounded-md px-2.5 py-2 text-xs text-ctp-text placeholder:text-ctp-overlay1 resize-none focus-ring"
          data-testid="wire-instructions-textarea"
        />
        <div className="text-xs text-ctp-overlay1 mt-1">
          {selectedTool === '*'
            ? 'Applies to every tool on this wire unless a tool has its own.'
            : `Applies only to ${toolLabel(selectedTool)}.`}
        </div>
      </Modal>
    </div>
  );
}
