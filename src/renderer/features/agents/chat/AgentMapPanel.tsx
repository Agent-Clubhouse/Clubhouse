/**
 * Agent map (docs/structured-chat-research.md, Phase 4 "Depth"; mockup
 * "Subagents"): this agent and its subagents (Claude Task subagents, Codex
 * child threads), with status, tool count, elapsed time and tokens. Each
 * subagent expands to its own stream, and "Show in conversation" jumps back
 * to where it started. Shown in the Subagents card of Agent details (#2032).
 *
 * Gated on `capabilities.subagents`: 'full' shows named subagents with
 * status; 'ids_only' groups the work by id and says names and status aren't
 * reported; 'none' has nothing to list.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../../../stores/chatStore';
import type { Agent } from '../../../../shared/types';
import type { ChatViewState } from '../../../stores/chatStore';
import { AgentAvatar } from '../AgentAvatar';
import { chatDot, DOT_CLASS, DOT_LABEL, StatusDot, type AgentDot } from '../agent-status';
import { AgentMessage, ThoughtRow } from './MessageBlocks';
import { ToolRow } from './ToolBlocks';
import { scrollWithin } from './scroll';
import { ChevronDown, ChevronRight } from './icons';
import { formatDuration, formatElapsed, formatTokens, type AgentMap, type AgentMapNode, type AgentMapStatus } from './view-model';

/** Subagent states in the shared status words; cancelled and unknown have their own. */
const STATUS_LABELS: Record<AgentMapStatus, string> = {
  running: DOT_LABEL.working,
  completed: DOT_LABEL.idle,
  failed: DOT_LABEL.error,
  cancelled: 'Stopped',
  unknown: 'Status not reported',
};
const STATUS_DOT: Record<AgentMapStatus, AgentDot | null> = {
  running: 'working', completed: 'idle', failed: 'error', cancelled: 'sleeping', unknown: null,
};

function NodeDot({ status }: { status: AgentMapStatus }) {
  const dot = STATUS_DOT[status];
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot ? DOT_CLASS[dot] : 'border border-ctp-overlay0'}`} aria-hidden="true" />;
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

/** "4 · 1 running · 1 failed", the Subagents card's one-line answer. */
export function subagentSummary(map: AgentMap): string {
  if (map.nodes.length === 0) return 'none yet';
  const running = map.nodes.filter((n) => n.status === 'running').length;
  const failed = map.nodes.filter((n) => n.status === 'failed').length;
  if (map.mode === 'ids_only') return `${map.nodes.length} ${map.nodes.length === 1 ? 'thread' : 'threads'}`;
  return [String(map.nodes.length), running ? `${running} running` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
}

/** The last steps of a subagent's stream; the whole stream is in the conversation. */
const STREAM_TAIL = 6;

/**
 * A subagent's stream. Its items keep their identity unless an event changed
 * them, so compare them one by one: the clock tick and chunks for other
 * messages then don't re-render (or re-parse the markdown of) this stream.
 */
const NodeStream = memo(function NodeStream({ items }: { items: ChatItem[] }) {
  if (items.length === 0) return <span className="text-[12px] text-ctp-overlay0">No activity yet.</span>;
  const shown = items.slice(-STREAM_TAIL);
  return (
    <>
      {items.length > shown.length && <span className="text-[11.5px] text-ctp-overlay0">{items.length - shown.length} earlier steps</span>}
      {shown.map((c) => {
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
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>('[data-agent-map-scroller]');
    if (open && el && scroller) scrollWithin(scroller, el, 'nearest');
  }, [open]);
  const meta = nodeMeta(node, now);
  const line = node.status === 'running' && node.activity ? node.activity : STATUS_LABELS[node.status];
  return (
    <div ref={ref} className="flex flex-col" data-testid="agent-map-node" data-subagent-id={node.subagentId} data-status={node.status}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex items-start gap-2 py-[5px] pl-3 pr-2.5 ml-9 mr-1.5 rounded-md text-left ${open ? 'bg-surface-0' : 'hover:bg-surface-0'}`}
      >
        <span className="mt-[3px] flex">{open ? <ChevronDown size={11} className="text-ctp-overlay0" /> : <ChevronRight size={11} className="text-ctp-overlay0" />}</span>
        <span className="flex flex-col min-w-0 flex-1">
          <span className="flex items-center gap-[7px] min-w-0 text-[12.5px]">
            <NodeDot status={node.status} />
            <span className="font-medium text-ctp-text truncate">{node.description ?? node.label}</span>
          </span>
          <span className={`text-xs truncate ${node.status === 'failed' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>{line}</span>
          <span className="text-[11.5px] text-ctp-overlay0 truncate tabular-nums">{[node.description ? node.label : '', meta].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      {open && (
        <div className="mt-0.5 mb-2 ml-[58px] mr-2.5 pl-2.5 border-l border-surface-1 flex flex-col gap-1.5" data-testid="agent-map-stream">
          <NodeStream items={node.items} />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onShowInStream}
              className="h-7 px-2.5 rounded-md border border-surface-1 text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text"
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

export interface SubagentListProps {
  /** The subagent whose last jump found no target in the conversation. */
  missedSubagentId?: string | null;
  agent: Agent;
  state: Pick<ChatViewState, 'state'>;
  map: AgentMap;
  /** The subagent to expand, e.g. after "Open in details" from a subagent card. */
  selected: string | null;
  onSelect: (subagentId: string | null) => void;
  onShowInStream: (subagentId: string) => void;
}

/** This agent and its subagents, for the Subagents card. */
export function SubagentList({ missedSubagentId, agent, state, map, selected, onSelect, onShowInStream }: SubagentListProps) {
  const anyRunning = map.nodes.some((n) => n.status === 'running');
  const now = useNow(anyRunning);
  const rootDot = chatDot(state.state);
  return (
    <div className="flex flex-col" data-testid="chat-agent-map" aria-label="Subagents">
      <div className="flex items-center gap-2 h-7 pr-3.5 pl-[33px] text-[12.5px]" data-testid="agent-map-root">
        <StatusDot dot={rootDot} />
        <AgentAvatar agent={agent} size="2xs" />
        <span className="font-semibold text-ctp-text truncate">{agent.name}</span>
        <span className="text-xs text-ctp-overlay1">{DOT_LABEL[rootDot]}</span>
      </div>
      {map.mode === 'ids_only' && (
        <p className="pr-3.5 pl-[33px] py-1 text-xs text-ctp-overlay1" data-testid="agent-map-ids-only">
          This agent says which work belongs to a child thread, but not its name or status.
        </p>
      )}
      {map.nodes.length === 0 ? (
        <p className="pr-3.5 pl-[33px] py-1.5 text-xs text-ctp-overlay1">No subagents in this conversation yet.</p>
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
  );
}
