import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  StructuredEvent,
  TextDelta,
  TextDone,
  ToolStart,
  ToolOutput,
  ToolEnd,
  FileDiff,
  CommandOutput,
  PermissionRequest,
  PlanUpdate,
  Thinking,
  ErrorEvent,
  UsageEvent,
  EndEvent,
} from '../../../../shared/structured-events';
import { useAgentStore } from '../../../stores/agentStore';
import { MessageStream } from './MessageStream';
import { ToolCard, type ToolStatus } from './ToolCard';
import { PermissionBanner } from './PermissionBanner';
import { FileDiffViewer } from './FileDiffViewer';
import { CommandOutputPanel } from './CommandOutputPanel';
import { ThinkingPanel } from './ThinkingPanel';
import { PlanProgress } from './PlanProgress';
import { ErrorBanner } from './ErrorBanner';
import { ActionBar } from './ActionBar';

export const MAX_EVENTS = 500;

interface Props {
  agentId: string;
}

/**
 * A feed item represents one visual block in the event stream.
 * Multiple StructuredEvents may collapse into a single feed item
 * (e.g. consecutive text_delta events become one MessageStream).
 */
type FeedItemBody =
  | { kind: 'text'; text: string; isStreaming: boolean }
  | { kind: 'tool'; tool: ToolStart; output: string; end?: ToolEnd; status: ToolStatus }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'diff'; diff: FileDiff }
  | { kind: 'command'; command: CommandOutput }
  | { kind: 'thinking'; text: string; isStreaming: boolean }
  | { kind: 'plan'; plan: PlanUpdate }
  | { kind: 'error'; error: ErrorEvent };

/**
 * `key` is a stable, monotonically assigned identity used as the React key.
 * It must never be derived from the item's position: the feed is trimmed to
 * MAX_EVENTS and answered permissions are removed, both of which shift
 * indexes. Index keys let React reuse one item's component state (e.g. a
 * PermissionBanner's "already responded" flag) for a different item.
 */
export type FeedItem = FeedItemBody & { key: number };

export interface ViewState {
  feedItems: FeedItem[];
  /** Next FeedItem.key to hand out */
  nextKey: number;
  pendingPermissions: Map<string, PermissionRequest>;
  plan: PlanUpdate | null;
  usage: UsageEvent | null;
  isComplete: boolean;
  endReason?: string;
}

export const initialState: ViewState = {
  feedItems: [],
  nextKey: 0,
  pendingPermissions: new Map(),
  plan: null,
  usage: null,
  isComplete: false,
};

export function StructuredAgentView({ agentId }: Props) {
  const [state, setState] = useState<ViewState>(initialState);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const killAgent = useAgentStore((s) => s.killAgent);
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agentId]);

  // Elapsed time counter
  useEffect(() => {
    const start = spawnedAt || Date.now();
    setElapsed(Date.now() - start);
    const tick = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(tick);
  }, [agentId, spawnedAt]);

  // Subscribe to structured events via IPC
  useEffect(() => {
    setState(initialState);

    const removeListener = window.clubhouse.agent.onStructuredEvent(
      (eventAgentId: string, rawEvent: { type: string; timestamp: number; data: unknown }) => {
        if (eventAgentId !== agentId) return;
        const event = rawEvent as unknown as StructuredEvent;
        setState((prev) => processEvent(prev, event));
      },
    );

    return () => removeListener();
  }, [agentId]);

  // Auto-scroll: scroll to bottom on new events unless user has scrolled up
  useEffect(() => {
    if (!userScrolledUpRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.feedItems.length]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // If user is within 50px of bottom, consider them "at bottom"
    userScrolledUpRef.current = scrollHeight - scrollTop - clientHeight > 50;
  }, []);

  const handleStop = useCallback(() => {
    window.clubhouse.agent.cancelStructured(agentId);
    killAgent(agentId);
  }, [agentId, killAgent]);

  const handleSendMessage = useCallback(
    (message: string) => {
      window.clubhouse.agent.sendStructuredMessage(agentId, message);
    },
    [agentId],
  );

  const handlePermissionResponse = useCallback(
    (requestId: string, approved: boolean) => {
      window.clubhouse.agent.respondPermission(agentId, requestId, approved);
      setState((prev) => {
        const next = { ...prev, pendingPermissions: new Map(prev.pendingPermissions) };
        next.pendingPermissions.delete(requestId);
        // Remove from feed items
        next.feedItems = prev.feedItems.filter(
          (item) => !(item.kind === 'permission' && item.request.id === requestId),
        );
        return next;
      });
    },
    [agentId],
  );

  return (
    <div className="flex flex-col h-full bg-ctp-base" data-testid="structured-agent-view">
      {/* Plan progress (sticky at top when active) */}
      {state.plan && (
        <div className="px-3 pt-3">
          <PlanProgress plan={state.plan} />
        </div>
      )}

      {/* Scrollable event feed */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
        onScroll={handleScroll}
        data-testid="event-feed"
      >
        {state.feedItems.length === 0 && !state.isComplete && (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-ctp-subtext0 italic animate-pulse">Starting agent...</span>
          </div>
        )}

        {state.feedItems.map((item) => (
          <FeedItemRenderer key={item.key} item={item} onPermissionRespond={handlePermissionResponse} />
        ))}

        {/* End summary */}
        {state.isComplete && state.endReason && (
          <div className="flex items-center gap-2 pt-2 border-t border-surface-0" data-testid="end-summary">
            <EndIcon reason={state.endReason} />
            <span className="text-xs text-ctp-subtext0">
              Session {state.endReason === 'complete' ? 'completed' : state.endReason}
            </span>
          </div>
        )}
      </div>

      {/* Bottom action bar */}
      <ActionBar
        agentId={agentId}
        elapsed={elapsed}
        usage={state.usage}
        isComplete={state.isComplete}
        onStop={handleStop}
        onSendMessage={handleSendMessage}
      />
    </div>
  );
}

/** Render a single feed item to the appropriate component. */
function FeedItemRenderer({
  item,
  onPermissionRespond,
}: {
  item: FeedItem;
  onPermissionRespond: (requestId: string, approved: boolean) => void;
}) {
  switch (item.kind) {
    case 'text':
      return <MessageStream text={item.text} isStreaming={item.isStreaming} />;
    case 'tool':
      return <ToolCard tool={item.tool} output={item.output} end={item.end} status={item.status} />;
    case 'permission':
      return <PermissionBanner request={item.request} onRespond={onPermissionRespond} />;
    case 'diff':
      return <FileDiffViewer diff={item.diff} />;
    case 'command':
      return <CommandOutputPanel command={item.command} />;
    case 'thinking':
      return <ThinkingPanel text={item.text} isStreaming={item.isStreaming} />;
    case 'plan':
      return <PlanProgress plan={item.plan} />;
    case 'error':
      return <ErrorBanner error={item.error} />;
  }
}

function EndIcon({ reason }: { reason: string }) {
  if (reason === 'complete') {
    return (
      <svg className="w-3.5 h-3.5 text-ctp-green" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 8 7 11 12 5" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 text-ctp-red" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <line x1="6" y1="6" x2="10" y2="10" />
      <line x1="10" y1="6" x2="6" y2="10" />
    </svg>
  );
}

// ── Event processing (pure function) ──────────────────────────────────

export function processEvent(prev: ViewState, event: StructuredEvent): ViewState {
  // Lazy-copy: only clone a data structure when this event actually mutates it.
  // This avoids copying up to 500 feedItems on every event.
  let feedItems = prev.feedItems;
  let nextKey = prev.nextKey;
  let pendingPermissions = prev.pendingPermissions;
  let plan = prev.plan;
  let usage = prev.usage;
  let isComplete = prev.isComplete;
  let endReason = prev.endReason;

  let feedCloned = false;
  function cloneFeed() {
    if (!feedCloned) {
      feedItems = [...feedItems];
      feedCloned = true;
    }
  }
  function push(item: FeedItemBody) {
    cloneFeed();
    feedItems.push({ ...item, key: nextKey++ } as FeedItem);
  }
  // Tool/command items are located by their event id, never by a cached
  // index: trimming and permission removal shift positions, so a cached
  // index would attach output/completion to the wrong card.
  function findToolIdx(id: string): number {
    for (let i = feedItems.length - 1; i >= 0; i--) {
      const item = feedItems[i];
      if (item.kind === 'tool' && item.tool.id === id) return i;
    }
    return -1;
  }
  function findCommandIdx(id: string): number {
    for (let i = feedItems.length - 1; i >= 0; i--) {
      const item = feedItems[i];
      if (item.kind === 'command' && item.command.id === id) return i;
    }
    return -1;
  }

  switch (event.type) {
    case 'text_delta': {
      const data = event.data as TextDelta;
      const last = feedItems[feedItems.length - 1];
      if (last && last.kind === 'text' && last.isStreaming) {
        cloneFeed();
        feedItems[feedItems.length - 1] = { ...last, text: last.text + data.text };
      } else {
        push({ kind: 'text', text: data.text, isStreaming: true });
      }
      break;
    }

    case 'text_done': {
      const data = event.data as TextDone;
      const last = feedItems[feedItems.length - 1];
      if (last && last.kind === 'text') {
        cloneFeed();
        feedItems[feedItems.length - 1] = { kind: 'text', text: data.text, isStreaming: false, key: last.key };
      } else {
        push({ kind: 'text', text: data.text, isStreaming: false });
      }
      break;
    }

    case 'tool_start': {
      const data = event.data as ToolStart;
      push({ kind: 'tool', tool: data, output: '', status: 'running' });
      break;
    }

    case 'tool_output': {
      const data = event.data as ToolOutput;
      const idx = findToolIdx(data.id);
      if (idx !== -1) {
        cloneFeed();
        const item = feedItems[idx] as Extract<FeedItem, { kind: 'tool' }>;
        feedItems[idx] = { ...item, output: item.output + data.output };
      }
      break;
    }

    case 'tool_end': {
      const data = event.data as ToolEnd;
      const idx = findToolIdx(data.id);
      if (idx !== -1) {
        cloneFeed();
        const item = feedItems[idx] as Extract<FeedItem, { kind: 'tool' }>;
        feedItems[idx] = {
          ...item,
          end: data,
          status: data.status === 'error' ? 'error' : 'completed',
        };
      }
      break;
    }

    case 'file_diff': {
      const data = event.data as FileDiff;
      push({ kind: 'diff', diff: data });
      break;
    }

    case 'command_output': {
      const data = event.data as CommandOutput;
      const existingIdx = findCommandIdx(data.id);
      if (existingIdx !== -1) {
        cloneFeed();
        feedItems[existingIdx] = { kind: 'command', command: data, key: feedItems[existingIdx].key };
      } else {
        push({ kind: 'command', command: data });
      }
      break;
    }

    case 'permission_request': {
      const data = event.data as PermissionRequest;
      pendingPermissions = new Map(pendingPermissions);
      pendingPermissions.set(data.id, data);
      push({ kind: 'permission', request: data });
      break;
    }

    case 'plan_update': {
      const data = event.data as PlanUpdate;
      plan = data;
      break;
    }

    case 'thinking': {
      const data = event.data as Thinking;
      const last = feedItems[feedItems.length - 1];
      if (last && last.kind === 'thinking' && last.isStreaming) {
        cloneFeed();
        feedItems[feedItems.length - 1] = {
          kind: 'thinking',
          text: last.text + data.text,
          isStreaming: data.isPartial,
          key: last.key,
        };
      } else {
        push({ kind: 'thinking', text: data.text, isStreaming: data.isPartial });
      }
      break;
    }

    case 'error': {
      const data = event.data as ErrorEvent;
      push({ kind: 'error', error: data });
      break;
    }

    case 'usage': {
      const data = event.data as UsageEvent;
      if (usage) {
        usage = {
          inputTokens: usage.inputTokens + data.inputTokens,
          outputTokens: usage.outputTokens + data.outputTokens,
          cacheReadTokens: (usage.cacheReadTokens ?? 0) + (data.cacheReadTokens ?? 0),
          cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + (data.cacheWriteTokens ?? 0),
          costUsd: (usage.costUsd ?? 0) + (data.costUsd ?? 0),
        };
      } else {
        usage = data;
      }
      break;
    }

    case 'end': {
      const data = event.data as EndEvent;
      isComplete = true;
      endReason = data.reason;
      if (data.summary) {
        push({ kind: 'text', text: data.summary, isStreaming: false });
      }
      break;
    }
  }

  // Cap feed items
  if (feedItems.length > MAX_EVENTS) {
    feedItems = feedItems.slice(feedItems.length - MAX_EVENTS);
  }

  // Skip state update if nothing changed
  if (
    feedItems === prev.feedItems &&
    nextKey === prev.nextKey &&
    pendingPermissions === prev.pendingPermissions &&
    plan === prev.plan &&
    usage === prev.usage &&
    isComplete === prev.isComplete &&
    endReason === prev.endReason
  ) {
    return prev;
  }

  return { feedItems, nextKey, pendingPermissions, plan, usage, isComplete, endReason };
}
