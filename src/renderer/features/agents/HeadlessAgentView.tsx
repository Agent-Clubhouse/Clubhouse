import { useState, useEffect, useRef, useCallback } from 'react';
import { Agent, AgentHookEvent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';

export const MAX_FEED_ITEMS = 200;
const TRANSCRIPT_PAGE_SIZE = 100;

interface Props {
  agent: Agent;
}

type FeedItem =
  | { id: string; kind: 'tool'; name: string; ts: number }
  | { id: string; kind: 'text'; text: string; ts: number }
  | { id: string; kind: 'result'; text: string; ts: number };

interface TranscriptEvent {
  type: string;
  content_block?: { type: string; name?: string };
  message?: { content?: Array<{ type: string; name?: string; text?: string }> };
  result?: string;
  delta?: { type?: string; text?: string };
  [key: string]: unknown;
}

interface TranscriptParseState {
  pendingText: string;
  signatureCounts: Map<string, number>;
}

function capFeedItems(items: FeedItem[]): FeedItem[] {
  return items.length > MAX_FEED_ITEMS
    ? items.slice(items.length - MAX_FEED_ITEMS)
    : items;
}

function nextFeedItemId(counts: Map<string, number>, signature: string): string {
  const next = (counts.get(signature) ?? 0) + 1;
  counts.set(signature, next);
  return `${signature}:${next}`;
}

function flushPendingTranscriptText(
  items: FeedItem[],
  state: TranscriptParseState,
  ts: number,
): void {
  const text = state.pendingText.trim();
  if (!text) return;

  items.push({
    id: nextFeedItemId(state.signatureCounts, `text:${text}`),
    kind: 'text',
    text,
    ts,
  });
  state.pendingText = '';
}

function buildTranscriptFeedItems(
  events: TranscriptEvent[],
  state: TranscriptParseState,
): FeedItem[] {
  const items: FeedItem[] = [];

  for (const event of events) {
    const ts = Date.now();

    if (event.type === 'assistant' && event.message) {
      const content = (
        event.message as { content?: Array<{ type: string; name?: string; text?: string }> }
      ).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name) {
            flushPendingTranscriptText(items, state, ts);
            items.push({
              id: nextFeedItemId(state.signatureCounts, `tool:${block.name}`),
              kind: 'tool',
              name: block.name,
              ts,
            });
          } else if (block.type === 'text' && block.text) {
            state.pendingText += block.text;
          }
        }
        flushPendingTranscriptText(items, state, ts);
      }
      continue;
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      flushPendingTranscriptText(items, state, ts);
      const name = event.content_block.name || 'unknown';
      items.push({
        id: nextFeedItemId(state.signatureCounts, `tool:${name}`),
        kind: 'tool',
        name,
        ts,
      });
      continue;
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        state.pendingText += delta.text;
      }
      continue;
    }

    if (event.type === 'content_block_stop' || event.type === 'message_start' || event.type === 'message_stop') {
      flushPendingTranscriptText(items, state, ts);
      continue;
    }

    if (event.type === 'result') {
      flushPendingTranscriptText(items, state, ts);
      const text = typeof event.result === 'string' ? event.result : 'Done';
      items.push({
        id: nextFeedItemId(state.signatureCounts, `result:${text}`),
        kind: 'result',
        text,
        ts,
      });
    }
  }

  return items;
}

function createNotificationFeedItem(
  message: string,
  ts: number,
  counts: Map<string, number>,
): FeedItem {
  return {
    id: nextFeedItemId(counts, `notification:${message}`),
    kind: 'text',
    text: message,
    ts,
  };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function AnimatedTreehouse() {
  return (
    <svg width="200" height="200" viewBox="0 0 120 120" className="drop-shadow-lg">
      {/* Ground with grass tufts */}
      <ellipse cx="60" cy="112" rx="50" ry="5" fill="#45475a" opacity="0.4" />
      <circle cx="30" cy="110" r="4" fill="#a6e3a1" opacity="0.3" />
      <circle cx="45" cy="111" r="5" fill="#a6e3a1" opacity="0.25" />
      <circle cx="75" cy="111" r="4.5" fill="#a6e3a1" opacity="0.3" />
      <circle cx="88" cy="110" r="3.5" fill="#a6e3a1" opacity="0.25" />

      {/* Support stilts */}
      <rect x="30" y="60" width="4" height="52" fill="#7f6b55" />
      <rect x="86" y="60" width="4" height="52" fill="#7f6b55" />
      <rect x="55" y="72" width="4" height="40" fill="#7f6b55" />
      {/* Cross braces */}
      <line x1="32" y1="75" x2="57" y2="90" stroke="#6b5a48" strokeWidth="2" />
      <line x1="88" y1="75" x2="59" y2="90" stroke="#6b5a48" strokeWidth="2" />

      {/* Stairs */}
      <line x1="40" y1="112" x2="30" y2="65" stroke="#7f6b55" strokeWidth="2" />
      <line x1="48" y1="112" x2="38" y2="65" stroke="#7f6b55" strokeWidth="2" />
      {/* Stair treads */}
      <line x1="39" y1="105" x2="47" y2="105" stroke="#6b5a48" strokeWidth="1.5" />
      <line x1="38" y1="98" x2="46" y2="98" stroke="#6b5a48" strokeWidth="1.5" />
      <line x1="37" y1="91" x2="45" y2="91" stroke="#6b5a48" strokeWidth="1.5" />
      <line x1="36" y1="84" x2="44" y2="84" stroke="#6b5a48" strokeWidth="1.5" />
      <line x1="35" y1="77" x2="43" y2="77" stroke="#6b5a48" strokeWidth="1.5" />
      <line x1="33" y1="70" x2="41" y2="70" stroke="#6b5a48" strokeWidth="1.5" />

      {/* Platform / deck */}
      <rect x="22" y="58" width="76" height="5" rx="1" fill="#8b7355" />
      <rect x="24" y="58" width="72" height="2" rx="1" fill="#9e8468" opacity="0.5" />

      {/* House body - wood plank look */}
      <rect x="26" y="28" width="68" height="32" rx="2" fill="#8b7355" />
      {/* Plank lines */}
      <line x1="26" y1="35" x2="94" y2="35" stroke="#7f6b55" strokeWidth="0.5" opacity="0.6" />
      <line x1="26" y1="42" x2="94" y2="42" stroke="#7f6b55" strokeWidth="0.5" opacity="0.6" />
      <line x1="26" y1="49" x2="94" y2="49" stroke="#7f6b55" strokeWidth="0.5" opacity="0.6" />
      {/* Front face highlight */}
      <rect x="28" y="30" width="64" height="28" rx="1" fill="#9e8468" opacity="0.2" />

      {/* Roof */}
      <polygon points="18,30 60,6 102,30" fill="#585b70" />
      <polygon points="22,30 60,10 98,30" fill="#6c7086" opacity="0.3" />
      {/* Roof edge trim */}
      <line x1="18" y1="30" x2="102" y2="30" stroke="#45475a" strokeWidth="1.5" />

      {/* Chimney */}
      <rect x="80" y="10" width="8" height="16" rx="1" fill="#585b70" />
      <rect x="78" y="8" width="12" height="3" rx="1" fill="#6c7086" />

      {/* Smoke puffs */}
      <circle cx="84" cy="4" r="2.5" fill="#9399b2" opacity="0.35" className="animate-smoke" />
      <circle cx="86" cy="0" r="2" fill="#9399b2" opacity="0.25" className="animate-smoke-delay" />
      <circle cx="85" cy="-4" r="1.5" fill="#9399b2" opacity="0.15" className="animate-smoke-delay2" />

      {/* Left window - warm glow */}
      <rect x="34" y="36" width="14" height="12" rx="1.5" fill="#1e1e2e" />
      <rect x="35" y="37" width="12" height="10" rx="1" fill="#f9e2af" opacity="0.7" className="animate-window-glow" />
      <line x1="41" y1="37" x2="41" y2="47" stroke="#7f6b55" strokeWidth="1" />
      <line x1="35" y1="42" x2="47" y2="42" stroke="#7f6b55" strokeWidth="1" />
      {/* Shadow figure */}
      <ellipse cx="39" cy="42" rx="2.5" ry="4" fill="#1e1e2e" opacity="0.35" className="animate-shadow-drift" />

      {/* Right window - warm glow */}
      <rect x="72" y="36" width="14" height="12" rx="1.5" fill="#1e1e2e" />
      <rect x="73" y="37" width="12" height="10" rx="1" fill="#f9e2af" opacity="0.6" className="animate-window-glow-alt" />
      <line x1="79" y1="37" x2="79" y2="47" stroke="#7f6b55" strokeWidth="1" />
      <line x1="73" y1="42" x2="85" y2="42" stroke="#7f6b55" strokeWidth="1" />
      {/* Shadow figure */}
      <ellipse cx="81" cy="43" rx="2" ry="3.5" fill="#1e1e2e" opacity="0.3" className="animate-shadow-drift-alt" />

      {/* Door */}
      <rect x="52" y="40" width="14" height="20" rx="2" fill="#6b5a48" />
      <rect x="53" y="41" width="12" height="18" rx="1.5" fill="#5a4a3a" />
      <circle cx="62" cy="51" r="1" fill="#f9e2af" opacity="0.8" />

      {/* Satellite dish on roof */}
      <line x1="36" y1="20" x2="36" y2="14" stroke="#9399b2" strokeWidth="1" />
      <path d="M30 14 Q36 10 42 14" fill="none" stroke="#9399b2" strokeWidth="1.5" />
      <circle cx="36" cy="14" r="1" fill="#9399b2" />

      {/* Flag on roof */}
      <line x1="60" y1="6" x2="60" y2="-2" stroke="#9399b2" strokeWidth="1" />
      <polygon points="60,-2 72,-1 60,3" fill="#f38ba8" opacity="0.8" />
      <text x="65" y="2" textAnchor="middle" fill="#1e1e2e" fontSize="3" fontWeight="bold" fontFamily="monospace">C</text>

      {/* Railing on deck */}
      <line x1="24" y1="58" x2="24" y2="52" stroke="#7f6b55" strokeWidth="1.5" />
      <line x1="42" y1="58" x2="42" y2="52" stroke="#7f6b55" strokeWidth="1.5" />
      <line x1="78" y1="58" x2="78" y2="52" stroke="#7f6b55" strokeWidth="1.5" />
      <line x1="96" y1="58" x2="96" y2="52" stroke="#7f6b55" strokeWidth="1.5" />
      <line x1="24" y1="53" x2="42" y2="53" stroke="#7f6b55" strokeWidth="1" />
      <line x1="78" y1="53" x2="96" y2="53" stroke="#7f6b55" strokeWidth="1" />
    </svg>
  );
}

/** How recently a hook must have fired for us to consider hooks "active" and skip polling. */
const HOOK_ACTIVE_THRESHOLD_MS = 5_000;

/** Fallback poll interval — only used when hooks are not actively firing. */
const FALLBACK_POLL_INTERVAL_MS = 5_000;

export function HeadlessAgentView({ agent }: Props) {
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  const transcriptOffsetRef = useRef(0);
  const transcriptParseStateRef = useRef<TranscriptParseState>({
    pendingText: '',
    signatureCounts: new Map(),
  });
  const notificationCountsRef = useRef<Map<string, number>>(new Map());
  const syncingTranscriptRef = useRef(false);
  const syncRequestedRef = useRef(false);
  const lastHookTimestampRef = useRef(0);
  const flushRafRef = useRef(0);
  const feedBufferRef = useRef<FeedItem[]>([]);
  const killAgent = useAgentStore((s) => s.killAgent);
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);

  // Batch feed-item state updates: push to buffer ref (O(1)), flush to state
  // once per animation frame to avoid copying the full array on every event.
  const scheduleFlush = useCallback(() => {
    if (flushRafRef.current) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = 0;
      feedBufferRef.current = capFeedItems(feedBufferRef.current);
      setFeedItems([...feedBufferRef.current]);
    });
  }, []);

  // Elapsed time counter — use the store's spawn timestamp so remounts
  // don't reset the timer (fixes #185).
  useEffect(() => {
    const start = spawnedAt || Date.now();
    setElapsed(Date.now() - start);
    if (agent.status !== 'running') return;
    const tick = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(tick);
  }, [agent.id, spawnedAt, agent.status]);

  const appendNotificationItem = useCallback((message: string, ts: number) => {
    feedBufferRef.current.push(
      createNotificationFeedItem(message, ts, notificationCountsRef.current),
    );
    scheduleFlush();
  }, [scheduleFlush]);

  // Sync transcript incrementally — hook events trigger immediate syncs while a
  // low-frequency fallback poll (5 s) catches anything hooks miss.
  useEffect(() => {
    let cancelled = false;

    prevCountRef.current = 0;
    transcriptOffsetRef.current = 0;
    transcriptParseStateRef.current = {
      pendingText: '',
      signatureCounts: new Map(),
    };
    notificationCountsRef.current = new Map();
    syncingTranscriptRef.current = false;
    syncRequestedRef.current = false;
    lastHookTimestampRef.current = 0;
    feedBufferRef.current = [];
    setFeedItems([]);

    async function syncTranscript(): Promise<void> {
      if (cancelled) return;
      if (syncingTranscriptRef.current) {
        syncRequestedRef.current = true;
        return;
      }

      syncingTranscriptRef.current = true;
      try {
        while (!cancelled) {
          syncRequestedRef.current = false;
          const page = await window.clubhouse.agent.readTranscriptPage(
            agent.id,
            transcriptOffsetRef.current,
            TRANSCRIPT_PAGE_SIZE,
          );
          if (cancelled || !page) return;

          if (page.events.length === 0) {
            if (page.totalEvents > transcriptOffsetRef.current) {
              transcriptOffsetRef.current = page.totalEvents;
            }
            return;
          }

          transcriptOffsetRef.current += page.events.length;
          const newItems = buildTranscriptFeedItems(
            page.events as TranscriptEvent[],
            transcriptParseStateRef.current,
          );

          if (newItems.length > 0) {
            feedBufferRef.current.push(...newItems);
            scheduleFlush();
          }

          if (transcriptOffsetRef.current >= page.totalEvents) return;
        }
      } catch {
        // transcript not ready yet
      } finally {
        syncingTranscriptRef.current = false;
        if (syncRequestedRef.current && !cancelled) {
          void syncTranscript();
        }
      }
    }

    const removeListener = window.clubhouse.agent.onHookEvent(
      (agentId: string, event: AgentHookEvent) => {
        if (agentId !== agent.id) return;
        lastHookTimestampRef.current = Date.now();

        if (event.kind === 'notification' && event.message) {
          appendNotificationItem(event.message, event.timestamp || Date.now());
          return;
        }

        if (event.kind === 'pre_tool' || event.kind === 'post_tool' || event.kind === 'stop') {
          void syncTranscript();
        }
      },
    );

    // Initial sync on mount
    void syncTranscript();

    // Low-frequency fallback poll — only fires when hooks haven't been active
    // and the agent is still running.  Hook-triggered syncs handle the common
    // case so this only matters for startup or providers without hook support.
    const fallbackInterval = setInterval(() => {
      if (Date.now() - lastHookTimestampRef.current < HOOK_ACTIVE_THRESHOLD_MS) return;
      void syncTranscript();
    }, FALLBACK_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      removeListener();
      clearInterval(fallbackInterval);
      if (flushRafRef.current) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = 0;
      }
    };
  }, [agent.id, appendNotificationItem]);

  // Auto-scroll when new items appear
  useEffect(() => {
    if (feedItems.length > prevCountRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
    prevCountRef.current = feedItems.length;
  }, [feedItems.length]);

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <div className="flex flex-col items-center gap-4 w-[420px] max-w-full overflow-hidden px-4">
        {/* Animated treehouse */}
        <AnimatedTreehouse />

        {/* Agent info */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/20 text-indigo-400">
              Headless
            </span>
            <span className="text-xs text-ctp-subtext0 font-mono tabular-nums">
              {formatElapsed(elapsed)}
            </span>
          </div>
          {agent.mission && (
            <p className="text-sm text-ctp-subtext1 line-clamp-3 break-words overflow-hidden">{agent.mission}</p>
          )}
        </div>

        {/* Live transcript feed */}
        <div className="w-full bg-ctp-mantle border border-surface-0 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-surface-0">
            <span className="text-[10px] text-ctp-subtext0 uppercase tracking-wider">Live Activity</span>
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          </div>
          <div
            ref={feedRef}
            className="p-3 space-y-1.5 h-[240px] overflow-y-auto"
          >
            {feedItems.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-xs text-ctp-subtext0 italic animate-pulse">Starting agent...</span>
              </div>
            ) : (
              feedItems.map((item, i) => (
                <LiveFeedItem key={item.id} item={item} isLatest={i === feedItems.length - 1} />
              ))
            )}
          </div>
        </div>

        {/* Stop button */}
        <button
          onClick={() => killAgent(agent.id)}
          className="px-4 py-1.5 text-xs rounded-lg border border-red-500/30
            hover:bg-red-500/20 transition-colors cursor-pointer text-red-400"
        >
          Stop Agent
        </button>
      </div>
    </div>
  );
}

function LiveFeedItem({ item, isLatest }: { item: FeedItem; isLatest: boolean }) {
  if (item.kind === 'tool') {
    return (
      <div className={`flex items-center gap-1.5 text-xs ${isLatest ? 'animate-pulse' : ''}`}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-accent flex-shrink-0">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="font-mono text-ctp-subtext1">{item.name}</span>
      </div>
    );
  }

  if (item.kind === 'text') {
    const truncated = item.text.length > 300;
    const display = truncated ? item.text.slice(0, 300) + '...' : item.text;
    return (
      <p className="text-xs text-ctp-subtext0 leading-relaxed">{display}</p>
    );
  }

  // result
  return (
    <div className="flex items-center gap-1.5 text-xs border-t border-surface-0 pt-1.5 mt-1">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span className="text-green-400">{item.text || 'Done'}</span>
    </div>
  );
}
