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
 */
export class JsonlParser extends EventEmitter {
  private buffer = '';

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: StreamJsonEvent = JSON.parse(trimmed);
        this.emit('line', parsed);
      } catch {
        // Skip malformed lines
      }
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      try {
        const parsed: StreamJsonEvent = JSON.parse(this.buffer.trim());
        this.emit('line', parsed);
      } catch {
        // Skip
      }
    }
    this.buffer = '';
    this.emit('end');
  }
}
