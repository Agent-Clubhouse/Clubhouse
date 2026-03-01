import { randomUUID } from 'crypto';
import type { StreamJsonEvent } from './jsonl-parser';
import type { SessionEvent, SessionSummary, SessionTranscriptPage } from '../../shared/session-types';

/**
 * Normalize raw StreamJsonEvent[] from Claude Code's JSONL transcript
 * into richer SessionEvent[] with timestamps and usage data.
 */
export function normalizeSessionEvents(rawEvents: StreamJsonEvent[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  let lastTimestamp = 0;

  for (const raw of rawEvents) {
    // Derive timestamp — use explicit timestamp if present, else increment
    const ts = typeof raw.timestamp === 'number'
      ? raw.timestamp
      : (lastTimestamp > 0 ? lastTimestamp + 1 : Date.now());
    lastTimestamp = ts;

    // --verbose format: 'user' type messages
    if (raw.type === 'user') {
      const msg = raw.message as { content?: Array<{ type: string; text?: string }> } | undefined;
      let text = '';
      if (msg?.content) {
        text = msg.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');
      } else if (typeof raw.message === 'string') {
        text = raw.message;
      }
      events.push({
        id: randomUUID(),
        timestamp: ts,
        type: 'user_message',
        text: text || '[user message]',
      });
      continue;
    }

    // --verbose format: 'assistant' type messages with content blocks
    if (raw.type === 'assistant') {
      const msg = raw.message as {
        role?: string;
        content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown>; id?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      } | undefined;

      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            events.push({
              id: randomUUID(),
              timestamp: ts,
              type: 'assistant_message',
              text: block.text,
              usage: msg.usage ? {
                inputTokens: msg.usage.input_tokens ?? 0,
                outputTokens: msg.usage.output_tokens ?? 0,
              } : undefined,
              model: (msg as any).model ?? (raw as any).model,
            });
          }
          if (block.type === 'tool_use' && block.name) {
            const filePath = (block.name === 'Write' || block.name === 'Edit')
              ? (block.input?.file_path as string | undefined)
              : undefined;
            events.push({
              id: randomUUID(),
              timestamp: ts,
              type: 'tool_use',
              toolName: block.name,
              toolInput: block.input,
              filePath,
            });
          }
          if (block.type === 'tool_result') {
            const resultText = typeof (block as any).content === 'string'
              ? (block as any).content
              : block.text;
            events.push({
              id: randomUUID(),
              timestamp: ts,
              type: 'tool_result',
              text: resultText ? String(resultText).slice(0, 500) : undefined,
              toolName: (block as any).tool_use_id,
            });
          }
        }
      }
      continue;
    }

    // 'result' type — final summary event
    if (raw.type === 'result') {
      events.push({
        id: randomUUID(),
        timestamp: ts,
        type: 'result',
        text: typeof raw.result === 'string' ? raw.result : undefined,
        costUsd: (raw.total_cost_usd as number | undefined) ?? raw.cost_usd,
        durationMs: raw.duration_ms,
      });
      continue;
    }

    // 'system' type
    if (raw.type === 'system') {
      events.push({
        id: randomUUID(),
        timestamp: ts,
        type: 'system',
        text: typeof raw.message === 'string' ? raw.message : JSON.stringify(raw),
      });
      continue;
    }

    // Legacy streaming format: content_block_start with tool_use
    if (raw.type === 'content_block_start' && raw.content_block?.type === 'tool_use') {
      events.push({
        id: randomUUID(),
        timestamp: ts,
        type: 'tool_use',
        toolName: raw.content_block.name,
      });
      continue;
    }
  }

  return events;
}

/**
 * Build an aggregated summary from normalized events.
 */
export function buildSessionSummary(events: SessionEvent[], orchestrator?: string): SessionSummary {
  let summary: string | null = null;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let model: string | null = null;
  const filesModified = new Set<string>();
  const toolsUsed = new Set<string>();
  let totalToolCalls = 0;
  let lastAssistantText = '';

  for (const event of events) {
    if (event.type === 'result') {
      if (event.text) summary = event.text;
      if (event.costUsd != null) totalCostUsd = event.costUsd;
      if (event.durationMs != null) totalDurationMs = event.durationMs;
    }

    if (event.type === 'assistant_message') {
      if (event.text) lastAssistantText = event.text;
      if (event.usage) {
        totalInputTokens += event.usage.inputTokens;
        totalOutputTokens += event.usage.outputTokens;
      }
      if (event.model && !model) model = event.model;
    }

    if (event.type === 'tool_use') {
      totalToolCalls++;
      if (event.toolName) toolsUsed.add(event.toolName);
      if (event.filePath) filesModified.add(event.filePath);
    }
  }

  // Fall back to last assistant text if no explicit result summary
  if (!summary && lastAssistantText.trim()) {
    const text = lastAssistantText.trim();
    summary = text.length > 500 ? text.slice(0, 497) + '...' : text;
  }

  // Derive timestamps from events
  const startedAt = events.length > 0
    ? new Date(events[0].timestamp).toISOString()
    : null;
  const lastActiveAt = events.length > 0
    ? new Date(events[events.length - 1].timestamp).toISOString()
    : null;

  // If no explicit duration, derive from event timestamps
  if (totalDurationMs === 0 && events.length >= 2) {
    totalDurationMs = events[events.length - 1].timestamp - events[0].timestamp;
  }

  return {
    summary,
    filesModified: Array.from(filesModified),
    totalToolCalls,
    toolsUsed: Array.from(toolsUsed),
    totalCostUsd,
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    model,
    orchestrator: orchestrator ?? null,
    eventCount: events.length,
    startedAt,
    lastActiveAt,
  };
}

/**
 * Paginate a list of events.
 */
export function paginateEvents(events: SessionEvent[], offset: number, limit: number): SessionTranscriptPage {
  const page = events.slice(offset, offset + limit);
  return {
    events: page,
    totalEvents: events.length,
  };
}
