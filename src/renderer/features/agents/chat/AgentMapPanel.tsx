/**
 * Agent map (docs/structured-chat-research.md, Phase 4 "Depth"; mockup
 * "Subagents"): this agent and its subagents (Claude Task subagents, Codex
 * child threads), with status, tool count, elapsed time and tokens. Each
 * subagent expands to its own stream, and "Show in conversation" jumps back
 * to where it started.
 *
 * Gated on `capabilities.subagents`: 'full' shows named subagents with
 * status; 'ids_only' groups the work by id and says names and status aren't
 * reported; 'none' never opens the panel (ChatView hides its toggle).
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../../../stores/chatStore';
import type { Agent } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';
import { AgentAvatar } from '../AgentAvatar';
import { AgentMessage, ThoughtRow } from './MessageBlocks';
import { ToolRow } from './ToolBlocks';
import { AgentsIcon, ChevronDown, ChevronRight, XIcon } from './icons';
import { formatDuration, formatElapsed, formatTokens, isRunningState, type AgentMap, type AgentMapNode, type AgentMapStatus } from './view-model';

const STATUS_LABELS: Record<AgentMapStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  unknown: 'status not reported',
};

function StatusDot({ status }: { status: AgentMapStatus | 'idle' }) {
  const cls = status === 'running' ? 'bg-ctp-success'
    : status === 'failed' ? 'bg-ctp-error'
      : status === 'completed' ? 'bg-ctp-accent'
        : status === 'idle' ? 'bg-ctp-accent'
          : 'border border-ctp-overlay0 bg-transparent';
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cls}`} aria-hidden="true" />;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function nodeMeta(node: AgentMapNode, now: number): string {
  const parts: string[] = [];
  if (node.toolCount) parts.push(`${node.toolCount} ${node.toolCount === 1 ? 'tool' : 'tools'}`);
  if (node.durationMs !== undefined) parts.push(formatDuration(node.durationMs));
  else if (node.status === 'running' && node.startTs) parts.push(formatElapsed(now - node.startTs));
  if (node.tokens) parts.push(`${formatTokens(node.tokens)} tok`);
  return parts.join(' · ');
}

/**
 * A subagent's stream. Its items keep their identity unless an event changed
 * them, so compare them one by one: the clock tick and chunks for other
 * messages then don't re-render (or re-parse the markdown of) this stream.
 */
const NodeStream = memo(function NodeStream({ items }: { items: ChatItem[] }) {
  if (items.length === 0) return <span className="text-[12px] text-ctp-overlay0">No activity yet.</span>;
  return (
    <>
      {items.map((c) => {
        if (c.kind === 'tool_call') return <ToolRow key={c.id} tool={c} />;
        if (c.kind === 'agent_message') return <AgentMessage key={c.id} item={c} />;
        if (c.kind === 'thought') return <ThoughtRow key={c.id} item={c} />;
        return null;
      })}
    </>
  );
}, (a, b) => a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]));

function NodeRow({ node, open, onToggle, onShowInStream, now, missed }: {
  node: AgentMapNode;
  open: boolean;
  onToggle: () => void;
  onShowInStream: () => void;
  now: number;
  /** The last "Show in conversation" for this node found nothing to show. */
  missed: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  const meta = nodeMeta(node, now);
  return (
    <div ref={ref} className="flex flex-col" data-testid="agent-map-node" data-subagent-id={node.subagentId} data-status={node.status}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex items-center gap-2 min-h-[30px] pl-6 pr-3.5 text-[12.5px] text-left ${open ? 'bg-surface-0' : 'hover:bg-surface-0/50'}`}
      >
        {open ? <ChevronDown className="text-ctp-overlay0" /> : <ChevronRight className="text-ctp-overlay0" />}
        <AgentsIcon className="text-ctp-mauve" />
        <span className="flex flex-col min-w-0 flex-1 py-1">
          <span className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-ctp-text truncate">{node.label}</span>
            <StatusDot status={node.status} />
            <span className={`text-[11.5px] whitespace-nowrap ${node.status === 'failed' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>{STATUS_LABELS[node.status]}</span>
          </span>
          {node.description && <span className="text-[11.5px] text-ctp-subtext0 truncate">{node.description}</span>}
        </span>
        {meta && <span className="text-[11.5px] text-ctp-overlay0 whitespace-nowrap tabular-nums">{meta}</span>}
      </button>
      {open && (
        <div className="pl-12 pr-3.5 py-2 flex flex-col gap-1.5 border-b border-surface-0" data-testid="agent-map-stream">
          <NodeStream items={node.items} />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onShowInStream}
              className="h-6 px-2 rounded-md bg-surface-0 text-[11.5px] text-ctp-subtext1 hover:text-ctp-text"
            >
              Show in conversation
            </button>
            {missed && (
              <span className="text-[11.5px] text-ctp-overlay1" role="status" data-testid="agent-map-jump-missed">
                Not in the loaded conversation.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export interface AgentMapPanelProps {
  /** DOM id the header toggle points at with aria-controls. */
  id?: string;
  /** The subagent whose last jump found no target in the conversation. */
  missedSubagentId?: string | null;
  agent: Agent;
  state: Pick<ChatViewState, 'state'>;
  map: AgentMap;
  /** The subagent to expand, e.g. after "jump to" from a tool card. */
  selected: string | null;
  onSelect: (subagentId: string | null) => void;
  onShowInStream: (subagentId: string) => void;
  onClose: () => void;
}

export function AgentMapPanel({ id, missedSubagentId, agent, state, map, selected, onSelect, onShowInStream, onClose }: AgentMapPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Opening moves focus into the panel; closing returns it to the toggle (ChatView).
  useEffect(() => { closeRef.current?.focus(); }, []);
  const anyRunning = map.nodes.some((n) => n.status === 'running');
  const now = useNow(anyRunning);
  const running = isRunningState(state.state);
  const counts = map.nodes.reduce((acc, n) => { acc[n.status === 'running' ? 'running' : 'other']++; return acc; }, { running: 0, other: 0 });
  return (
    <aside
      id={id}
      className="w-[360px] flex-shrink-0 border-l border-surface-0 bg-ctp-mantle flex flex-col min-h-0"
      data-testid="chat-agent-map"
      aria-label="Agent map"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
    >
      <div className="h-[42px] flex-shrink-0 flex items-center gap-2.5 px-3.5 border-b border-surface-0 text-[12.5px]">
        <span className="font-semibold text-ctp-text">Agents</span>
        <span className="text-ctp-overlay1">
          {map.nodes.length} {map.nodes.length === 1 ? 'subagent' : 'subagents'}
          {counts.running > 0 && `, ${counts.running} running`}
        </span>
        <button ref={closeRef} type="button" onClick={onClose} className="ml-auto text-ctp-overlay1 hover:text-ctp-text" aria-label="Close agent map">
          <XIcon />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-2">
        <div className="flex items-center gap-2 h-[30px] px-3.5 text-[12.5px]" data-testid="agent-map-root">
          <AgentAvatar agent={agent} size="xs" />
          <span className="font-semibold text-ctp-text truncate">{agent.name}</span>
          <StatusDot status={running ? 'running' : 'idle'} />
          <span className="text-[11.5px] text-ctp-overlay1">{running ? 'working' : 'idle'}</span>
        </div>
        {map.mode === 'ids_only' && (
          <p className="px-3.5 py-1.5 text-[12px] text-ctp-subtext0" data-testid="agent-map-ids-only">
            This agent reports which work belongs to a subagent, but not its name or status.
          </p>
        )}
        {map.nodes.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px] text-ctp-overlay0">No subagents in this conversation yet.</p>
        ) : (
          map.nodes.map((node) => (
            <NodeRow
              key={node.subagentId}
              node={node}
              now={now}
              open={selected === node.subagentId}
              onToggle={() => onSelect(selected === node.subagentId ? null : node.subagentId)}
              onShowInStream={() => onShowInStream(node.subagentId)}
              missed={missedSubagentId === node.subagentId}
            />
          ))
        )}
      </div>
    </aside>
  );
}
