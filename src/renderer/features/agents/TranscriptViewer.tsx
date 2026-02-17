import { useState, useEffect } from 'react';

interface TranscriptEvent {
  type: string;
  subtype?: string;
  content_block?: { type: string; text?: string; name?: string; id?: string };
  message?: { content?: Array<{ type: string; name?: string; id?: string; text?: string }> };
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  delta?: { type?: string; text?: string };
  [key: string]: unknown;
}

interface Props {
  agentId: string;
}

export function TranscriptViewer({ agentId }: Props) {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await window.clubhouse.agent.readTranscript(agentId);
        if (cancelled || !raw) return;
        const parsed = raw.split('\n')
          .filter((line: string) => line.trim())
          .map((line: string) => {
            try { return JSON.parse(line) as TranscriptEvent; } catch { return null; }
          })
          .filter(Boolean) as TranscriptEvent[];
        setEvents(parsed);
      } catch {
        // Transcript not available
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  if (loading) {
    return <div className="text-xs text-ctp-subtext0 p-3">Loading transcript...</div>;
  }

  if (events.length === 0) {
    return <div className="text-xs text-ctp-subtext0 p-3 italic">No transcript data available.</div>;
  }

  // Group events into displayable items
  const items = buildDisplayItems(events);

  return (
    <div className="space-y-2 p-3 max-h-[400px] overflow-y-auto">
      {items.map((item, i) => (
        <TranscriptItem key={i} item={item} />
      ))}
    </div>
  );
}

type DisplayItem =
  | { kind: 'tool'; name: string; id?: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; text: string; costUsd?: number; durationMs?: number };

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function buildDisplayItems(events: TranscriptEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let currentText = '';

  for (const event of events) {
    // --verbose format: assistant messages contain tool_use and text blocks
    if (event.type === 'assistant' && event.message) {
      const msg = event.message as { content?: Array<{ type: string; name?: string; id?: string; text?: string }> };
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.name) {
            if (currentText.trim()) {
              items.push({ kind: 'text', text: currentText.trim() });
              currentText = '';
            }
            items.push({ kind: 'tool', name: block.name, id: block.id });
          } else if (block.type === 'text' && block.text) {
            currentText += block.text;
          }
        }
      }
    }

    // --verbose format: user messages (tool results) — skip, not useful to display

    // Legacy streaming format: content_block_start
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      if (currentText.trim()) {
        items.push({ kind: 'text', text: currentText.trim() });
        currentText = '';
      }
      items.push({ kind: 'tool', name: event.content_block.name || 'unknown', id: event.content_block.id });
    }

    // Legacy streaming format: content_block_delta
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        currentText += delta.text;
      }
    }

    if (event.type === 'message_start') {
      if (currentText.trim()) {
        items.push({ kind: 'text', text: currentText.trim() });
        currentText = '';
      }
    }

    if (event.type === 'result') {
      if (currentText.trim()) {
        items.push({ kind: 'text', text: currentText.trim() });
        currentText = '';
      }
      items.push({
        kind: 'result',
        text: typeof event.result === 'string' ? event.result : '',
        costUsd: event.cost_usd as number | undefined,
        durationMs: event.duration_ms as number | undefined,
      });
    }
  }

  if (currentText.trim()) {
    items.push({ kind: 'text', text: currentText.trim() });
  }

  return items;
}

function TranscriptItem({ item }: { item: DisplayItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'tool') {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext1 font-mono">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </svg>
          {item.name}
        </span>
      </div>
    );
  }

  if (item.kind === 'text') {
    const truncated = item.text.length > 200;
    const displayText = expanded ? item.text : item.text.slice(0, 200);
    return (
      <div className="text-xs text-ctp-text">
        <p className="whitespace-pre-wrap">{displayText}{truncated && !expanded ? '...' : ''}</p>
        {truncated && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-indigo-400 hover:text-indigo-300 cursor-pointer mt-0.5"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    );
  }

  // Result
  return (
    <div className="border-t border-surface-0 pt-2 mt-2">
      {item.text && <p className="text-xs text-ctp-text mb-1">{item.text}</p>}
      <div className="flex gap-3 text-[10px] text-ctp-subtext0">
        {item.costUsd != null && <span>${item.costUsd.toFixed(4)}</span>}
        {item.durationMs != null && <span>{formatDuration(item.durationMs)}</span>}
      </div>
    </div>
  );
}
