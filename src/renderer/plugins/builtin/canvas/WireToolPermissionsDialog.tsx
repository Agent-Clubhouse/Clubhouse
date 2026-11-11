/**
 * Agent wires summarize connection permissions; other targets keep wire-scoped controls.
 */

import React, { useEffect, useState } from 'react';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import { Toggle } from '../../../components/Toggle';
import { GROUP_PROJECT_TOOL_SUFFIXES } from '../../../../shared/group-project-permissions';
import { CONNECTION_SWITCHES, localDirectionTools, WAKE_TOOL, type ConnectionDirection } from '../../../../shared/connection-grants';
import { CONNECTION_SOURCE_LABELS, type AgentConnectionSources } from '../../../../shared/connection-sources';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import { AgentConnectionSummary } from '../../../features/agents/helpers/AgentConnectionSummary';
import { isDispatcherAgent } from '../../../features/dispatcher/dispatcherStore';

/** Known tool suffixes for each target kind. */
const TOOL_SUFFIXES: Record<string, string[]> = {
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
  onNavigate?: () => void;
}

export function WireToolPermissionsDialog(props: WireToolPermissionsDialogProps) {
  return props.binding.targetKind === 'agent'
    ? <AgentConnectionPermissionsDialog {...props} />
    : <WireScopedToolPermissionsDialog {...props} />;
}

function AgentConnectionPermissionsDialog({ binding, onClose, onNavigate }: WireToolPermissionsDialogProps) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const agents = useAgentStore((s) => s.agents);
  const [snapshot, setSnapshot] = useState<{ grants: ConnectionDirection[]; sources: AgentConnectionSources } | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => window.clubhouse.mcpBinding.onConnectionGrantsChanged(() => setReload((n) => n + 1)), []);
  useEffect(() => {
    let alive = true;
    setSnapshot(null);
    setFailed(false);
    Promise.all([
      window.clubhouse.mcpBinding.getConnectionGrants(binding.agentId),
      window.clubhouse.mcpBinding.getConnectionSources(binding.agentId),
    ]).then(([grants, sources]) => {
      if (alive) setSnapshot({ grants, sources });
    }).catch(() => {
      // telemetry-exempt: the dialog reports the failed read and offers a retry.
      if (alive) setFailed(true);
    });
    return () => { alive = false; };
  }, [binding.agentId, bindings, reload]);

  const from = agents[binding.agentId];
  const to = agents[binding.targetId];
  const fromName = from?.name ?? binding.agentName ?? binding.agentId;
  const toName = to?.name ?? binding.targetName ?? binding.label;
  const pairs = snapshot?.sources.pairs.filter((p) => (p.agentId === binding.agentId && p.targetId === binding.targetId)
    || (p.agentId === binding.targetId && p.targetId === binding.agentId)) ?? [];
  const family = from?.parentAgentId === binding.targetId || to?.parentAgentId === binding.agentId
    || pairs.some((p) => p.sources.some((s) => s.kind === 'helper'));
  const dispatcher = isDispatcherAgent(from ?? { id: binding.agentId, projectId: '' })
    || isDispatcherAgent(to ?? { id: binding.targetId, projectId: '' });
  const showWake = !family && !dispatcher;
  const directions = [
    { fromId: binding.agentId, toId: binding.targetId, fromName, toName },
    { fromId: binding.targetId, toId: binding.agentId, fromName: toName, toName: fromName },
  ];

  return (
    <div onMouseDown={(e) => e.stopPropagation()}>
      <Modal open onClose={onClose} title="Connection permissions" backdropTestId="wire-tool-permissions-dialog" footer={<Button onClick={onClose}>Close</Button>}>
        <AgentConnectionSummary agentId={binding.agentId} onNavigate={() => { onClose(); onNavigate?.(); }} />
        <p className="mb-3 text-xs text-ctp-overlay1">On only describes the connection switch. The sender's Clubhouse permissions can still turn a tool off or require Ask first.</p>
        {failed ? (
          <p role="alert" className="text-xs text-ctp-error">
            Couldn't read the connection permissions. <Button kind="quiet" onClick={() => setReload((n) => n + 1)}>Try again</Button>
          </p>
        ) : !snapshot ? <p className="text-xs text-ctp-overlay1">Loading connection permissions...</p> : (
          <div className="flex gap-4">
            {directions.map((d) => {
              const live = bindings.find((b) => b.targetKind === 'agent' && b.agentId === d.fromId && b.targetId === d.toId)
                ?? (d.fromId === binding.agentId ? binding : undefined);
              const saved = snapshot.grants.find((g) => !g.from.machineId && !g.to.machineId && g.from.agentId === d.fromId && g.to.agentId === d.toId);
              const pair = pairs.find((p) => p.agentId === d.fromId && p.targetId === d.toId);
              const connected = !!live || !!pair?.bound || !!pair?.sources.some((s) => !s.suspended);
              const tools = localDirectionTools(saved, live?.disabledTools, live?.enabledTools);
              const sources = [...new Set(pair?.sources.map((s) => CONNECTION_SOURCE_LABELS[s.kind]) ?? [])];
              return (
                <section key={d.fromId} aria-label={`${d.fromName} to ${d.toName}`} className="flex-1 min-w-0 text-xs text-ctp-subtext1" data-testid={`wire-connection-direction-${d.fromId}-${d.toId}`}>
                  <h3 className="mb-2 text-[13px] text-ctp-text">{d.fromName}{' \u2192 '}{d.toName}</h3>
                  {!connected ? <p>Not connected this way.</p> : (
                    <>
                      <ul className="space-y-1">
                        {CONNECTION_SWITCHES.filter((s) => showWake || s.tool !== WAKE_TOOL).map(({ tool, label }) => (
                          <li key={tool} className="flex justify-between gap-2">
                            <span>{label}</span>
                            <span>{tools.allowed.includes(tool) ? 'On' : 'Off'}</span>
                          </li>
                        ))}
                      </ul>
                      {sources.length > 0 && <p className="mt-2 text-ctp-overlay1">From: {sources.join(', ')}.</p>}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {!showWake && <p className="mt-3 text-xs text-ctp-overlay1">This connection has no Wake it switch. The Dispatcher and helpers use their own wake tools.</p>}
        {snapshot && snapshot.sources.unreadable.length > 0 && <p role="alert" className="mt-2 text-xs text-ctp-error">Some connection sources couldn't be read: {snapshot.sources.unreadable.join(', ')}.</p>}
      </Modal>
    </div>
  );
}

function WireScopedToolPermissionsDialog({ binding, onSave, onClose }: WireToolPermissionsDialogProps) {
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
