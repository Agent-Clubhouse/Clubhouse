import { useState, useEffect, useRef, useCallback } from 'react';
import { Agent, AgentHookEvent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';

interface Props {
  agent: Agent;
}

type FeedItem =
  | { kind: 'tool'; name: string; ts: number }
  | { kind: 'text'; text: string; ts: number }
  | { kind: 'result'; text: string; ts: number };

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

export function HeadlessAgentView({ agent }: Props) {
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  const killAgent = useAgentStore((s) => s.killAgent);

  // Elapsed time counter
  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(tick);
  }, [agent.id]);

  // Real-time feed from hook events (primary source — instant, no polling delay)
  const appendItem = useCallback((item: FeedItem) => {
    setFeedItems((prev) => [...prev, item]);
  }, []);

  useEffect(() => {
    const removeListener = window.clubhouse.agent.onHookEvent(
      (agentId: string, event: AgentHookEvent) => {
        if (agentId !== agent.id) return;
        const ts = event.timestamp || Date.now();

        if (event.kind === 'pre_tool' && event.toolName) {
          appendItem({ kind: 'tool', name: event.toolVerb || event.toolName, ts });
        } else if (event.kind === 'stop') {
          appendItem({ kind: 'result', text: event.message || 'Done', ts });
        } else if (event.kind === 'notification' && event.message) {
          appendItem({ kind: 'text', text: event.message, ts });
        }
      },
    );
    return () => removeListener();
  }, [agent.id, appendItem]);

  // Poll transcript for full activity feed (tools + text content)
  // This serves as both supplementary (to hook events) and primary source when hooks don't fire
  useEffect(() => {
    let cancelled = false;
    let lastEventCount = 0;
    let pollCount = 0;

    async function poll() {
      if (cancelled) return;
      pollCount++;
      try {
        const raw = await window.clubhouse.agent.readTranscript(agent.id);
        if (cancelled) return;
        if (raw == null || raw.length === 0) return;

        const events = raw.split('\n')
          .filter((line: string) => line.trim())
          .map((line: string) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);

        if (events.length === lastEventCount) return;
        lastEventCount = events.length;

        // Build a complete feed from the transcript.
        // Supports both --verbose format (assistant/user/result events)
        // and legacy streaming format (content_block_start/delta/stop).
        const items: FeedItem[] = [];
        let currentText = '';
        const now = Date.now();

        for (const event of events) {
          // --verbose format: assistant messages with tool_use and text blocks
          if (event.type === 'assistant' && event.message) {
            const content = (event.message as { content?: Array<{ type: string; name?: string; text?: string }> }).content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_use' && block.name) {
                  if (currentText.trim()) {
                    items.push({ kind: 'text', text: currentText.trim(), ts: now });
                    currentText = '';
                  }
                  items.push({ kind: 'tool', name: block.name, ts: now });
                } else if (block.type === 'text' && block.text) {
                  currentText += block.text;
                }
              }
              // Flush text after each assistant message
              if (currentText.trim()) {
                items.push({ kind: 'text', text: currentText.trim(), ts: now });
                currentText = '';
              }
            }
          }

          // Legacy streaming format
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            if (currentText.trim()) {
              items.push({ kind: 'text', text: currentText.trim(), ts: now });
              currentText = '';
            }
            items.push({ kind: 'tool', name: event.content_block.name || 'unknown', ts: now });
          }
          if (event.type === 'content_block_delta') {
            const delta = event.delta as { type?: string; text?: string } | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              currentText += delta.text;
            }
          }
          if (event.type === 'content_block_stop' || event.type === 'message_stop') {
            if (currentText.trim()) {
              items.push({ kind: 'text', text: currentText.trim(), ts: now });
              currentText = '';
            }
          }

          // Final result (same in both formats)
          if (event.type === 'result') {
            if (currentText.trim()) {
              items.push({ kind: 'text', text: currentText.trim(), ts: now });
              currentText = '';
            }
            const msg = typeof event.result === 'string' ? event.result : 'Done';
            items.push({ kind: 'result', text: msg, ts: now });
          }
        }
        if (currentText.trim()) {
          items.push({ kind: 'text', text: currentText.trim(), ts: now });
        }

        // Only update if we have more items than the current feed
        if (items.length > 0) {
          setFeedItems((prev) => items.length > prev.length ? items : prev);
        }
      } catch {
        // transcript not ready yet
      }
    }

    // Poll faster initially (every 500ms for first 10 polls), then every 2s
    let interval: ReturnType<typeof setInterval>;
    const fastInterval = setInterval(() => {
      poll();
      if (pollCount >= 10) {
        clearInterval(fastInterval);
        interval = setInterval(poll, 2000);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(fastInterval);
      if (interval) clearInterval(interval);
    };
  }, [agent.id]);

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
                <LiveFeedItem key={i} item={item} isLatest={i === feedItems.length - 1} />
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
