import { EventEmitter } from 'events';

export interface StreamJsonEvent {
  type: string;
  subtype?: string;
  content_block?: { type: string; text?: string; name?: string; id?: string };
  message?: { role?: string; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  session_id?: string;
  tools?: string[];
  [key: string]: unknown;
}

/**
 * Line-buffered JSONL parser for Claude Code's `--output-format stream-json`.
 * Emits 'line' events for each parsed JSON object.
 *
 * Uses array-based chunk accumulation and indexOf scanning to avoid
 * O(n) string reallocation on every chunk and unnecessary re-splitting.
 */
export class JsonlParser extends EventEmitter {
  private chunks: string[] = [];

  feed(chunk: string): void {
    this.chunks.push(chunk);

    // Fast path: no newline in this chunk means no complete line yet
    if (chunk.indexOf('\n') === -1) return;

    // Join only when we know there's at least one complete line
    const buffer = this.chunks.join('');
    let start = 0;
    let idx: number;

    while ((idx = buffer.indexOf('\n', start)) !== -1) {
      const line = buffer.substring(start, idx).trim();
      start = idx + 1;
      if (!line) continue;
      try {
        const parsed: StreamJsonEvent = JSON.parse(line);
        this.emit('line', parsed);
      } catch {
        // Skip malformed lines
      }
    }

    // Keep only the unprocessed remainder
    const remainder = start < buffer.length ? buffer.substring(start) : '';
    this.chunks = remainder ? [remainder] : [];
  }

  flush(): void {
    const buffer = this.chunks.join('').trim();
    if (buffer) {
      try {
        const parsed: StreamJsonEvent = JSON.parse(buffer);
        this.emit('line', parsed);
      } catch {
        // Skip
      }
    }
    this.chunks = [];
    this.emit('end');
  }
}
