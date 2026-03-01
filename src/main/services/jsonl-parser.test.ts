import { describe, it, expect, vi } from 'vitest';
import { JsonlParser } from './jsonl-parser';

describe('JsonlParser', () => {
  describe('feed', () => {
    it('emits line event for complete JSON line', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('{"type":"init"}\n');

      expect(handler).toHaveBeenCalledWith({ type: 'init' });
    });

    it('buffers incomplete lines until newline arrives', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('{"type":');
      expect(handler).not.toHaveBeenCalled();

      parser.feed('"init"}\n');
      expect(handler).toHaveBeenCalledWith({ type: 'init' });
    });

    it('emits multiple line events for multiple complete lines', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('{"type":"a"}\n{"type":"b"}\n');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith({ type: 'a' });
      expect(handler).toHaveBeenCalledWith({ type: 'b' });
    });

    it('skips empty lines', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('\n\n{"type":"a"}\n\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ type: 'a' });
    });

    it('skips malformed JSON lines silently', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('not json\n{"type":"good"}\n');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ type: 'good' });
    });

    it('handles all StreamJsonEvent fields', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      const event = {
        type: 'result',
        subtype: 'final',
        cost_usd: 0.05,
        duration_ms: 1000,
        is_error: false,
        session_id: 'sess-123',
      };
      parser.feed(JSON.stringify(event) + '\n');

      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('flush', () => {
    it('parses remaining buffer content', () => {
      const parser = new JsonlParser();
      const lineHandler = vi.fn();
      const endHandler = vi.fn();
      parser.on('line', lineHandler);
      parser.on('end', endHandler);

      parser.feed('{"type":"final"}');
      expect(lineHandler).not.toHaveBeenCalled();

      parser.flush();
      expect(lineHandler).toHaveBeenCalledWith({ type: 'final' });
      expect(endHandler).toHaveBeenCalled();
    });

    it('emits end event even when buffer is empty', () => {
      const parser = new JsonlParser();
      const endHandler = vi.fn();
      parser.on('end', endHandler);

      parser.flush();
      expect(endHandler).toHaveBeenCalled();
    });

    it('clears the buffer after flush', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('{"type":"a"}');
      parser.flush();
      expect(handler).toHaveBeenCalledTimes(1);

      // Second flush should not emit anything
      parser.flush();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('skips malformed buffer content on flush', () => {
      const parser = new JsonlParser();
      const lineHandler = vi.fn();
      const endHandler = vi.fn();
      parser.on('line', lineHandler);
      parser.on('end', endHandler);

      parser.feed('not valid json');
      parser.flush();

      expect(lineHandler).not.toHaveBeenCalled();
      expect(endHandler).toHaveBeenCalled();
    });
  });

  describe('chunked input simulation', () => {
    it('handles realistic streaming scenario', () => {
      const parser = new JsonlParser();
      const events: any[] = [];
      parser.on('line', (e) => events.push(e));

      // Simulate chunks arriving from a streaming process
      parser.feed('{"type":"init","session_id":"s1"}\n{"type":"conte');
      parser.feed('nt_block","content_block":{"type":"text","text":"Hello"}}\n');
      parser.feed('{"type":"result","cost_usd":0.01}\n');

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('init');
      expect(events[1].type).toBe('content_block');
      expect(events[2].cost_usd).toBe(0.01);
    });

    it('accumulates many small chunks without newlines then emits on newline', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      // Feed 20 small chunks without newlines — should not emit
      const parts = '{"type":"accumulated"}'.split('');
      for (const ch of parts) {
        parser.feed(ch);
      }
      expect(handler).not.toHaveBeenCalled();

      // Newline triggers emission
      parser.feed('\n');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ type: 'accumulated' });
    });

    it('handles a large payload split across many chunks', () => {
      const parser = new JsonlParser();
      const events: any[] = [];
      parser.on('line', (e) => events.push(e));

      const bigText = 'x'.repeat(10_000);
      const fullLine = JSON.stringify({ type: 'big', data: bigText }) + '\n';

      // Split into 100-byte chunks
      for (let i = 0; i < fullLine.length; i += 100) {
        parser.feed(fullLine.substring(i, i + 100));
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('big');
      expect(events[0].data).toBe(bigText);
    });

    it('handles rapid sequential feeds with mixed complete and partial lines', () => {
      const parser = new JsonlParser();
      const events: any[] = [];
      parser.on('line', (e) => events.push(e));

      // 100 rapid feeds, each a complete line
      for (let i = 0; i < 100; i++) {
        parser.feed(`{"type":"event","i":${i}}\n`);
      }

      expect(events).toHaveLength(100);
      expect(events[0].i).toBe(0);
      expect(events[99].i).toBe(99);
    });

    it('correctly handles newline at chunk boundary', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      // Newline is the entire chunk
      parser.feed('{"type":"a"}');
      parser.feed('\n');
      parser.feed('{"type":"b"}');
      parser.feed('\n');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith({ type: 'a' });
      expect(handler).toHaveBeenCalledWith({ type: 'b' });
    });

    it('flushes correctly after multiple no-newline chunks', () => {
      const parser = new JsonlParser();
      const handler = vi.fn();
      parser.on('line', handler);

      parser.feed('{"type"');
      parser.feed(':"flushed"');
      parser.feed('}');
      expect(handler).not.toHaveBeenCalled();

      parser.flush();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ type: 'flushed' });
    });
  });
});
