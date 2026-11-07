import { randomUUID } from 'crypto';
import type { StreamJsonEvent } from './jsonl-parser';
import type { SessionEvent, SessionSummary, SessionTranscriptPage } from '../../shared/session-types';

type EventUsage = NonNullable<SessionEvent['usage']>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const reported = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A message's usage as the transcript reported it. A field the transcript left out stays absent: it is not zero. */
function readEventUsage(raw: unknown): EventUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const usage: EventUsage = {
    inputTokens: reported(u.input_tokens),
    outputTokens: reported(u.output_tokens),
    cacheReadTokens: reported(u.cache_read_input_tokens),
    cacheWriteTokens: reported(u.cache_creation_input_tokens),
  };
  for (const key of Object.keys(usage) as Array<keyof EventUsage>) if (usage[key] === undefined) delete usage[key];
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * A later record of the same message. A stream can repeat a message with a
 * count still growing, so a figure only moves up; one that comes back lower
 * disagrees with the earlier record and flags a conflict, keeping the higher
 * count. A field the later record left out keeps what was known.
 */
function mergeRepeatedUsage(earlier: EventUsage | undefined, later: EventUsage): EventUsage {
  const merged: EventUsage = { ...earlier };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const next = later[key];
    if (next === undefined) continue;
    const prev = merged[key];
    if (prev !== undefined && next < prev) merged.conflict = true;
    merged[key] = prev === undefined ? next : Math.max(prev, next);
  }
  return merged;
}

/**
 * Normalize raw StreamJsonEvent[] from Claude Code's JSONL transcript
 * into richer SessionEvent[] with timestamps and usage data.
 *
 * A message's usage is counted once. Claude Code writes one record per content
 * block of a message, each repeating the message's id and usage (an earlier
 * record's output count can still be partial), so usage rides on the first event
 * of the message, whatever its block type, and a later record with the same id
 * updates it rather than adding to it. A message with no id counts once per record.
 */
export function normalizeSessionEvents(rawEvents: StreamJsonEvent[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  /** The first event of each message id: it carries the message's usage, or says it had none. */
  const heads = new Map<string, SessionEvent>();
  let lastTimestamp = 0;

  const noteAssistant = (from: number, messageId: string | undefined, usage: EventUsage | undefined, hadContent: boolean, ts: number, model: string | undefined): void => {
    const known = messageId ? heads.get(messageId) : undefined;
    if (known) {
      if (usage) {
        known.usage = mergeRepeatedUsage(known.usage, usage);
        delete known.usageMissing;
      }
      return;
    }
    if (!usage && !hadContent) return;
    // Text or a tool call stands for the message. One with neither (thinking only) gets a usage-only event, not invented text.
    let head = events.slice(from).find((e) => e.type === 'assistant_message' || e.type === 'tool_use');
    if (!head) {
      head = { id: randomUUID(), timestamp: ts, type: 'usage', model };
      events.push(head);
    }
    if (model && !head.model) head.model = model;
    if (usage) head.usage = usage;
    else head.usageMissing = true;
    if (messageId) {
      head.messageId = messageId;
      heads.set(messageId, head);
    }
  };

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
        id?: string;
        role?: string;
        content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown>; id?: string }>;
        usage?: unknown;
        model?: string;
      } | undefined;

      const from = events.length;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            events.push({
              id: randomUUID(),
              timestamp: ts,
              type: 'assistant_message',
              text: block.text,
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
      noteAssistant(from, str(msg?.id) ?? str((raw as any).uuid), readEventUsage(msg?.usage), Array.isArray(msg?.content) && msg.content.length > 0, ts, (msg as any)?.model ?? (raw as any).model);
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

    // Raw conversation format: role-based messages (no top-level 'type', uses 'role' instead)
    // Claude Code may store sessions in this format directly.
    const rawRole = (raw as any).role as string | undefined;
    if (rawRole === 'user' || rawRole === 'human') {
      const content = (raw as any).content;
      let text = '';
      if (Array.isArray(content)) {
        text = content
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('\n');
      } else if (typeof content === 'string') {
        text = content;
      }
      events.push({
        id: randomUUID(),
        timestamp: ts,
        type: 'user_message',
        text: text || '[user message]',
      });
      continue;
    }

    if (rawRole === 'assistant') {
      const content = (raw as any).content;
      const usage = readEventUsage((raw as any).usage);
      const model = (raw as any).model as string | undefined;
      const from = events.length;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push({
              id: randomUUID(),
              timestamp: ts,
              type: 'assistant_message',
              text: block.text,
              model,
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
            const resultText = typeof block.content === 'string'
              ? block.content
              : block.text;
            events.push({
              id: randomUUID(),
              timestamp: ts,
              type: 'tool_result',
              text: resultText ? String(resultText).slice(0, 500) : undefined,
              toolName: block.tool_use_id,
            });
          }
        }
      } else if (typeof content === 'string') {
        events.push({
          id: randomUUID(),
          timestamp: ts,
          type: 'assistant_message',
          text: content,
          model,
        });
      }
      noteAssistant(from, str((raw as any).id), usage, (Array.isArray(content) && content.length > 0) || typeof content === 'string', ts, model);
      continue;
    }
  }

  return events;
}

/**
 * Most of a transcript read for a summary (#2277). Larger ones are read as
 * head and tail, so the summary keeps its start, latest result and last reply
 * but undercounts tools and files from the middle.
 */
export const SUMMARY_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Build an aggregated summary from normalized events.
 */
export function buildSessionSummary(events: SessionEvent[], orchestrator?: string): SessionSummary {
  let summary: string | null = null;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens: number | undefined;
  let totalCacheWriteTokens: number | undefined;
  let usageEvents = 0;
  let usageGaps = 0;
  let usageConflicts = 0;
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
      if (event.model && !model) model = event.model;
    }

    // Usage rides on the first event of its message (text, tool call, or a usage-only record).
    if (event.usageMissing) usageGaps++;
    if (event.usage) {
      usageEvents++;
      // Only what the transcript reported is added; a field it left out is not counted as zero.
      if (event.usage.inputTokens === undefined || event.usage.outputTokens === undefined) usageGaps++;
      if (event.usage.conflict) usageConflicts++;
      totalInputTokens += event.usage.inputTokens ?? 0;
      totalOutputTokens += event.usage.outputTokens ?? 0;
      if (event.usage.cacheReadTokens !== undefined) totalCacheReadTokens = (totalCacheReadTokens ?? 0) + event.usage.cacheReadTokens;
      if (event.usage.cacheWriteTokens !== undefined) totalCacheWriteTokens = (totalCacheWriteTokens ?? 0) + event.usage.cacheWriteTokens;
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
    ...(totalCacheReadTokens !== undefined && { totalCacheReadTokens }),
    ...(totalCacheWriteTokens !== undefined && { totalCacheWriteTokens }),
    // `complete` only when every message reported input and output and no repeats disagreed; a conflict's merged count is not an actual sample.
    tokenUsage: usageEvents === 0 ? 'none' : usageGaps > 0 || usageConflicts > 0 ? 'partial' : 'complete',
    ...(usageConflicts > 0 && { tokenUsageConflicts: usageConflicts }),
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
