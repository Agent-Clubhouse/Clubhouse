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
 * produced by Claude Code's `--verbose --output-format stream-json`.
 */
export function parseTranscript(events: StreamJsonEvent[]): TranscriptSummary {
  let summary: string | null = null;
  let costUsd = 0;
  let durationMs = 0;
  const filesModified = new Set<string>();
  const toolsUsed = new Set<string>();
  let lastAssistantText = '';

  for (const event of events) {
    // Result event: summary, cost, duration
    if (event.type === 'result') {
      if (typeof event.result === 'string' && event.result) {
        summary = event.result;
      }
      if (event.total_cost_usd != null) costUsd = event.total_cost_usd as number;
      else if (event.cost_usd != null) costUsd = event.cost_usd;
      if (event.duration_ms != null) durationMs = event.duration_ms;
    }

    // --verbose format: assistant messages contain text and tool_use blocks
    if (event.type === 'assistant') {
      const msg = event.message as { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> } | undefined;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            lastAssistantText = block.text;
          }
          if (block.type === 'tool_use' && block.name) {
            toolsUsed.add(block.name);
            // Track file modifications from Write/Edit tool inputs
            if ((block.name === 'Write' || block.name === 'Edit') && block.input) {
              const filePath = block.input.file_path as string | undefined;
              if (filePath) filesModified.add(filePath);
            }
          }
        }
      }
    }

    // Legacy streaming format fallback
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const toolName = event.content_block.name;
      if (toolName) toolsUsed.add(toolName);
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        lastAssistantText += delta.text;
      }
    }
    if (event.type === 'message_start') {
      lastAssistantText = '';
    }
  }

  // Fall back to last assistant text if no explicit result
  if (!summary && lastAssistantText.trim()) {
    const text = lastAssistantText.trim();
    summary = text.length > 500 ? text.slice(0, 497) + '...' : text;
  }

  return {
    summary,
    filesModified: Array.from(filesModified),
    costUsd,
    durationMs,
    toolsUsed: Array.from(toolsUsed),
  };
}
