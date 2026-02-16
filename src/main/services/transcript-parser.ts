import { StreamJsonEvent } from './jsonl-parser';

export interface TranscriptSummary {
  summary: string | null;
  filesModified: string[];
  costUsd: number;
  durationMs: number;
  toolsUsed: string[];
}

/**
 * Extracts a structured summary from an array of JSONL transcript events
 * produced by Claude Code's `--output-format stream-json`.
 */
export function parseTranscript(events: StreamJsonEvent[]): TranscriptSummary {
  let summary: string | null = null;
  let costUsd = 0;
  let durationMs = 0;
  const filesModified = new Set<string>();
  const toolsUsed = new Set<string>();
  let lastAssistantText = '';

  for (const event of events) {
    // Track cost from result events
    if (event.cost_usd != null) {
      costUsd = event.cost_usd;
    }
    if (event.duration_ms != null) {
      durationMs = event.duration_ms;
    }

    // Track tools used
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const toolName = event.content_block.name;
      if (toolName) {
        toolsUsed.add(toolName);
      }
    }

    // Track file modifications from tool_use events (Write, Edit)
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const name = event.content_block.name;
      if (name === 'Write' || name === 'Edit') {
        // File path will be in the accumulated input — we track tool names at minimum
      }
    }

    // Accumulate assistant text for summary extraction
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        lastAssistantText += delta.text;
      }
    }

    // Reset text accumulator on new message
    if (event.type === 'message_start') {
      lastAssistantText = '';
    }

    // Extract result text if present
    if (event.type === 'result' && typeof event.result === 'string') {
      summary = event.result;
    }

    // Track files from tool results
    if (event.type === 'tool_result') {
      const filePath = (event as Record<string, unknown>).file_path as string | undefined;
      if (filePath) {
        filesModified.add(filePath);
      }
    }
  }

  // Fall back to last assistant text if no explicit result
  if (!summary && lastAssistantText.trim()) {
    // Take the last paragraph as summary, truncated to reasonable length
    const paragraphs = lastAssistantText.trim().split('\n\n');
    const last = paragraphs[paragraphs.length - 1].trim();
    summary = last.length > 500 ? last.slice(0, 497) + '...' : last;
  }

  return {
    summary,
    filesModified: Array.from(filesModified),
    costUsd,
    durationMs,
    toolsUsed: Array.from(toolsUsed),
  };
}
