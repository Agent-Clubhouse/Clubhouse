/**
 * WireToolPermissionsDialog — popout dialog for toggling individual tools on/off per wire.
 */

import React, { useState } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { Toggle } from '../../../components/Toggle';
import { GROUP_PROJECT_TOOL_SUFFIXES } from '../../../../shared/group-project-permissions';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';

/** Known tool suffixes for each target kind. */
const TOOL_SUFFIXES: Record<string, string[]> = {
  agent: ['send_message', 'get_status', 'read_output', 'check_connectivity', 'send_file', 'clear_agent', 'compact_agent'],
  browser: ['navigate', 'screenshot', 'get_console', 'click', 'type', 'evaluate', 'get_page_content', 'get_accessibility_tree'],
  'group-project': [...GROUP_PROJECT_TOOL_SUFFIXES],
  terminal: [],
};

/** Human-friendly labels for tool suffixes. */
function toolLabel(suffix: string): string {
  return suffix.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Short description hints for tools. */
const TOOL_HINTS: Record<string, string> = {
  send_message: 'Inject messages into the agent\'s CLI',
  get_status: 'Check running/sleeping status',
  read_output: 'Read the agent\'s output buffer',
  check_connectivity: 'Check link direction',
  send_file: 'Send content via temp file',
  clear_agent: 'Send /clear to this agent (clears its context)',
  compact_agent: 'Send /compact to this agent (compacts its context)',
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
  read_message: 'Read a single message by ID',
  get_project_info: 'Get project details',
  query_polling: 'Read the current project polling setting',
  shoulder_tap: 'Inject urgent message into an agent\'s CLI',
  broadcast: 'Inject urgent message into all agents\' CLIs',
  wake_agent: 'Wake a sleeping agent in this project',
  sleep_agent: 'Stop a connected agent in this project',
  toggle_polling: 'Turn project-wide polling on or off (the real setting)',
  nudge_polling: 'Nudge one connected agent to start polling (no setting change)',
  clear_topic: 'Delete a bulletin channel and all its messages',
  delete_messages: 'Delete specific messages by ID',
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

  // Initialize from existing disabledTools
  const [disabled, setDisabled] = useState<Set<string>>(() => {
    return new Set(binding.disabledTools || []);
  });

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

  const disabledCount = disabled.size;
  const enabledCount = suffixes.length - disabledCount;

  const handleEnableAll = () => setDisabled(new Set());
  const handleDisableAll = () => setDisabled(new Set(suffixes));

  return (
    // React bubbles portal events through this tree; keep a mousedown in the
    // dialog from reaching the canvas workspace and its wire popover.
    <div onMouseDown={(e) => e.stopPropagation()}>
      <Modal
        open
        onClose={onClose}
        title="Tool permissions"
        backdropTestId="wire-tool-permissions-dialog"
        padding="none"
        footer={
          <>
            <span className="mr-auto text-xs text-ctp-overlay1">
              {enabledCount} of {suffixes.length} on
            </span>
            <Button kind="quiet" onClick={onClose} data-testid="wire-permissions-cancel">Cancel</Button>
            <Button kind="primary" onClick={handleSave} data-testid="wire-permissions-save">Save</Button>
          </>
        }
      >
        <div className="px-4 pt-3 text-xs text-ctp-overlay1 truncate">{binding.label}</div>
        <div className="px-3 py-2 flex gap-1">
          <Button kind="quiet" onClick={handleEnableAll} data-testid="wire-permissions-enable-all">Turn all on</Button>
          <Button kind="quiet" onClick={handleDisableAll} data-testid="wire-permissions-disable-all">Turn all off</Button>
        </div>
      {/* Tool list */}
      <div className="px-2 pb-2 space-y-0.5">
        {suffixes.map((suffix) => {
          const isEnabled = !disabled.has(suffix);
          return (
            <div
              key={suffix}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-0 transition-colors"
              data-testid={`wire-permission-${suffix}`}
            >
              <div className="flex-1 min-w-0">
                <div className={`text-[13px] ${isEnabled ? 'text-ctp-text' : 'text-ctp-subtext0'}`}>
                  {toolLabel(suffix)}
                </div>
                {TOOL_HINTS[suffix] && (
                  <div className="text-xs text-ctp-overlay1 truncate">
                    {TOOL_HINTS[suffix]}
                  </div>
                )}
              </div>
              <Toggle checked={isEnabled} onChange={(val) => handleToggle(suffix, val)} aria-label={toolLabel(suffix)} />
            </div>
          );
        })}
      </div>

      </Modal>
    </div>
  );
}
