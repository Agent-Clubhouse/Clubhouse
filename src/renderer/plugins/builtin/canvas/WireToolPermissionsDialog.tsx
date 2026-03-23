/**
 * WireToolPermissionsDialog — popout dialog for toggling individual tools on/off per wire.
 */

import React, { useState, useRef, useEffect } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { Toggle } from '../../../components/Toggle';

/** Known tool suffixes for each target kind. */
const TOOL_SUFFIXES: Record<string, string[]> = {
  agent: ['send_message', 'get_status', 'read_output', 'check_connectivity', 'send_file', 'wake'],
  browser: ['navigate', 'screenshot', 'get_console', 'click', 'type', 'evaluate', 'get_page_content', 'get_accessibility_tree'],
  'group-project': ['list_members', 'post_bulletin', 'read_bulletin', 'read_topic', 'get_project_info', 'shoulder_tap', 'broadcast'],
  'agent-queue': ['invoke', 'get_output', 'list', 'cancel', 'get_queue_info'],
  terminal: [],
};

/** Human-friendly labels for tool suffixes. */
function toolLabel(suffix: string): string {
  return suffix.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short description hints for tools. */
const TOOL_HINTS: Record<string, string> = {
  send_message: 'Inject messages into terminal',
  get_status: 'Check running/sleeping status',
  read_output: 'Read terminal output buffer',
  check_connectivity: 'Check link direction',
  send_file: 'Send content via temp file',
  wake: 'Wake sleeping agents',
  navigate: 'Load URLs',
  screenshot: 'Capture page screenshots',
  get_console: 'Read console logs',
  click: 'Click elements by selector',
  type: 'Type into form fields',
  evaluate: 'Run JavaScript in page',
  get_page_content: 'Get page HTML',
  get_accessibility_tree: 'Get accessibility tree',
  list_members: 'List connected agents',
  post_bulletin: 'Post to bulletin board',
  read_bulletin: 'Read bulletin digest',
  read_topic: 'Read topic messages',
  get_project_info: 'Get project details',
  shoulder_tap: 'Direct message an agent',
  broadcast: 'Message all agents',
  invoke: 'Submit a task to the queue',
  get_output: 'Get task status and output',
  list: 'List all tasks in queue',
  cancel: 'Cancel a pending task',
  get_queue_info: 'Get queue configuration',
};

interface WireToolPermissionsDialogProps {
  binding: McpBindingEntry;
  onSave: (disabledTools: string[]) => void;
  onClose: () => void;
}

export function WireToolPermissionsDialog({ binding, onSave, onClose }: WireToolPermissionsDialogProps) {
  const suffixes = TOOL_SUFFIXES[binding.targetKind] || [];
  const backdropRef = useRef<HTMLDivElement>(null);

  // Initialize from existing disabledTools
  const [disabled, setDisabled] = useState<Set<string>>(() => {
    return new Set(binding.disabledTools || []);
  });

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

  const handleToggle = (suffix: string, enabled: boolean) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (enabled) {
        next.delete(suffix);
      } else {
        next.add(suffix);
      }
      return next;
    });
  };

  const handleSave = () => {
    onSave([...disabled]);
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

  const disabledCount = disabled.size;
  const enabledCount = suffixes.length - disabledCount;

  const handleEnableAll = () => setDisabled(new Set());
  const handleDisableAll = () => setDisabled(new Set(suffixes));

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: 100000 }}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      data-testid="wire-tool-permissions-dialog"
    >
      <div className="bg-ctp-mantle border border-surface-2 rounded-lg shadow-2xl w-[360px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 bg-ctp-base border-b border-surface-0">
          <div className="text-sm text-ctp-text font-medium">Tool Permissions</div>
          <div className="text-[10px] text-ctp-subtext0 mt-0.5">
            {binding.label} ({binding.targetKind})
          </div>
        </div>

        {/* Bulk actions */}
        <div className="px-4 pt-2 flex gap-2">
          <button
            onClick={handleEnableAll}
            className="text-[10px] text-ctp-accent hover:underline"
            data-testid="wire-permissions-enable-all"
          >
            Enable All
          </button>
          <span className="text-[10px] text-ctp-overlay0">|</span>
          <button
            onClick={handleDisableAll}
            className="text-[10px] text-ctp-red hover:underline"
            data-testid="wire-permissions-disable-all"
          >
            Disable All
          </button>
        </div>

        {/* Tool list */}
        <div className="px-4 py-2 flex-1 overflow-y-auto space-y-0.5">
          {suffixes.map((suffix) => {
            const isEnabled = !disabled.has(suffix);
            return (
              <div
                key={suffix}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-1 transition-colors"
                data-testid={`wire-permission-${suffix}`}
              >
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-medium ${isEnabled ? 'text-ctp-text' : 'text-ctp-overlay0 line-through'}`}>
                    {toolLabel(suffix)}
                  </div>
                  {TOOL_HINTS[suffix] && (
                    <div className="text-[10px] text-ctp-overlay0 truncate">
                      {TOOL_HINTS[suffix]}
                    </div>
                  )}
                </div>
                <Toggle checked={isEnabled} onChange={(val) => handleToggle(suffix, val)} />
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-surface-0 flex items-center justify-between">
          <span className="text-[10px] text-ctp-overlay0">
            {enabledCount}/{suffixes.length} enabled
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-ctp-subtext0 hover:bg-surface-1 rounded transition-colors"
              data-testid="wire-permissions-cancel"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 text-xs text-white bg-ctp-accent hover:bg-ctp-accent/80 rounded transition-colors"
              data-testid="wire-permissions-save"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
