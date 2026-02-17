import { describe, it, expect } from 'vitest';
import { parseTranscript } from './transcript-parser';
import { StreamJsonEvent } from './jsonl-parser';

describe('parseTranscript', () => {
  // ============================================================
  // Text-only transcripts (synthesized from text mode)
  // ============================================================
  describe('text-only transcript (text mode output)', () => {
    it('handles single result event with text content', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'result',
          result: 'The bug was in the auth middleware. I fixed it by updating the token validation.',
          duration_ms: 5000,
          cost_usd: 0,
        },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe('The bug was in the auth middleware. I fixed it by updating the token validation.');
      expect(summary.durationMs).toBe(5000);
      expect(summary.costUsd).toBe(0);
      expect(summary.toolsUsed).toEqual([]);
      expect(summary.filesModified).toEqual([]);
    });

    it('handles result with zero cost (text mode always has cost 0)', () => {
      const events: StreamJsonEvent[] = [
        { type: 'result', result: 'Done', duration_ms: 1000, cost_usd: 0 },
      ];

      const summary = parseTranscript(events);
      expect(summary.costUsd).toBe(0);
    });

    it('handles multiline text result', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'result',
          result: 'Step 1: Found the issue\nStep 2: Fixed auth middleware\nStep 3: Updated tests',
          duration_ms: 8000,
          cost_usd: 0,
        },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toContain('Step 1');
      expect(summary.summary).toContain('Step 3');
    });

    it('handles very long text result without truncation in summary', () => {
      // Result text is used as-is when it comes from a result event
      const longText = 'x'.repeat(1000);
      const events: StreamJsonEvent[] = [
        { type: 'result', result: longText, duration_ms: 0, cost_usd: 0 },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe(longText);
    });
  });

  // ============================================================
  // Empty and degenerate transcripts
  // ============================================================
  describe('empty and degenerate transcripts', () => {
    it('handles empty transcript', () => {
      const summary = parseTranscript([]);
      expect(summary.summary).toBeNull();
      expect(summary.durationMs).toBe(0);
      expect(summary.costUsd).toBe(0);
      expect(summary.toolsUsed).toEqual([]);
      expect(summary.filesModified).toEqual([]);
    });

    it('handles result event with empty string', () => {
      const events: StreamJsonEvent[] = [
        { type: 'result', result: '', duration_ms: 1000, cost_usd: 0 },
      ];

      const summary = parseTranscript(events);
      // Empty result string is falsy, so summary should be null
      expect(summary.summary).toBeNull();
    });

    it('handles result event with no result field', () => {
      const events: StreamJsonEvent[] = [
        { type: 'result', duration_ms: 1000, cost_usd: 0.01 },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBeNull();
      expect(summary.costUsd).toBe(0.01);
      expect(summary.durationMs).toBe(1000);
    });
  });

  // ============================================================
  // Verbose format (Claude Code --verbose --output-format stream-json)
  // ============================================================
  describe('verbose format', () => {
    it('extracts tools and files from assistant messages', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me fix that.' },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
            ],
          },
        },
        {
          type: 'result',
          result: 'Fixed the issue.',
          duration_ms: 3000,
          total_cost_usd: 0.05,
        },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe('Fixed the issue.');
      expect(summary.durationMs).toBe(3000);
      expect(summary.costUsd).toBe(0.05);
      expect(summary.toolsUsed).toEqual(['Edit']);
      expect(summary.filesModified).toEqual(['/src/app.ts']);
    });

    it('tracks multiple tool uses across multiple assistant messages', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
              { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
            ],
          },
        },
        { type: 'result', result: 'Done', duration_ms: 5000 },
      ];

      const summary = parseTranscript(events);
      expect(summary.toolsUsed).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write']));
      expect(summary.toolsUsed).toHaveLength(3);
      // Only Edit and Write modify files
      expect(summary.filesModified).toEqual(expect.arrayContaining(['/src/app.ts', '/src/new.ts']));
    });

    it('deduplicates tool names and file paths', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
            ],
          },
        },
        { type: 'result', result: 'Done' },
      ];

      const summary = parseTranscript(events);
      expect(summary.toolsUsed).toEqual(['Edit']);
      expect(summary.filesModified).toEqual(['/src/app.ts']);
    });

    it('prefers total_cost_usd over cost_usd', () => {
      const events: StreamJsonEvent[] = [
        { type: 'result', result: 'Done', cost_usd: 0.01, total_cost_usd: 0.05 },
      ];

      const summary = parseTranscript(events);
      expect(summary.costUsd).toBe(0.05);
    });

    it('falls back to cost_usd when total_cost_usd is absent', () => {
      const events: StreamJsonEvent[] = [
        { type: 'result', result: 'Done', cost_usd: 0.03 },
      ];

      const summary = parseTranscript(events);
      expect(summary.costUsd).toBe(0.03);
    });
  });

  // ============================================================
  // Last assistant text fallback
  // ============================================================
  describe('last assistant text fallback', () => {
    it('uses last assistant text when no result event', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'I completed the task successfully.' }],
          },
        },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe('I completed the task successfully.');
    });

    it('truncates long fallback text to 500 chars', () => {
      const longText = 'x'.repeat(600);
      const events: StreamJsonEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: longText }],
          },
        },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).not.toBeNull();
      expect(summary.summary!.length).toBe(500);
      expect(summary.summary!.endsWith('...')).toBe(true);
    });

    it('result event overrides assistant text fallback', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Working on it...' }],
          },
        },
        { type: 'result', result: 'Done!' },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe('Done!');
    });
  });

  // ============================================================
  // Legacy streaming format
  // ============================================================
  describe('legacy streaming format', () => {
    it('tracks tool_use from content_block_start', () => {
      const events: StreamJsonEvent[] = [
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Bash' },
        },
        { type: 'result', result: 'Done' },
      ];

      const summary = parseTranscript(events);
      expect(summary.toolsUsed).toEqual(['Bash']);
    });

    it('accumulates text from content_block_delta', () => {
      const events: StreamJsonEvent[] = [
        { type: 'message_start' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world!' } },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe('Hello world!');
    });

    it('message_start resets accumulated text', () => {
      const events: StreamJsonEvent[] = [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'old text' } },
        { type: 'message_start' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'new text' } },
      ];

      const summary = parseTranscript(events);
      expect(summary.summary).toBe('new text');
    });
  });
});
