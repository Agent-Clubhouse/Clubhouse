import { describe, expect, it } from 'vitest';
import { TOOL_EVENT_MAX_BYTES, boundChatEvent, previewText } from './annex-chat-bounds';

const update = (data: Record<string, unknown>) => ({ type: 'tool_call_update', agentId: 'a', seq: 1, ts: 0, sessionId: 's', data: { toolCallId: 't', ...data } }) as never;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('previewText', () => {
  it('leaves what fits', () => {
    expect(previewText('short', 100)).toBe('short');
  });

  it('keeps both ends within the limit, and says how much went', () => {
    const preview = previewText(`${'a\n'.repeat(50_000)}`, 4096);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(4096);
    expect(preview).toMatch(/\[Clubhouse: \d+ bytes of this output are omitted here/);
  });

  it('never splits a character', () => {
    const preview = previewText('🦊'.repeat(100_000), 4096);
    expect(preview).not.toContain('�');
    expect(Buffer.from(preview).toString()).toBe(preview);
    expect(preview).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('never ends the first part inside an escape sequence', () => {
    const preview = previewText('\x1b[38;2;1;2;3mx'.repeat(100_000), 4096);
    const head = preview.slice(0, preview.indexOf('\n[Clubhouse'));
    expect(head).toMatch(/(^|x)$/);
  });

  it('measures what is sent, so control characters count as their escapes', () => {
    const preview = previewText('\x01'.repeat(20 * 1024 * 1024), 256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(256 * 1024);
    expect(preview).toMatch(/\[Clubhouse: \d+ bytes/);
  });

  it('never starts the last part inside an escape sequence', () => {
    const sequence = '\x1b[38;2;10;20;30mA';
    for (let pad = 0; pad < sequence.length; pad++) {
      const preview = previewText(`${'y'.repeat(pad)}${sequence.repeat(100_000)}`, 4096);
      const tail = preview.slice(preview.lastIndexOf(']\n') + 2);
      // Whole sequences, after at most the one character that followed the one it skipped.
      expect(['', 'A']).toContain(tail.replaceAll(sequence, ''));
    }
  });

  it('cuts at a line when one is near', () => {
    const preview = previewText(`${'line of text\n'.repeat(100_000)}`, 4096);
    expect(preview.slice(0, preview.indexOf('\n[Clubhouse'))).toMatch(/line of text\n$/);
  });
});

describe('boundChatEvent', () => {
  const big = 'x'.repeat(5 * 1024 * 1024);

  it('previews a terminal block\'s command and cwd, not only its output', () => {
    const event = update({ content: [{ type: 'terminal', command: 'c'.repeat(20 * 1024 * 1024), cwd: 'd'.repeat(2 * 1024 * 1024), output: 'ok', exitCode: 2 }] });
    const bounded = boundChatEvent(event, bytes(event)) as any;
    expect(bytes(bounded)).toBeLessThan(64 * 1024);
    const [block] = bounded.data.content;
    expect(block).toMatchObject({ type: 'terminal', output: 'ok', exitCode: 2 });
    expect(block.command).toMatch(/\[Clubhouse: \d+ bytes/);
    expect(block.cwd).toMatch(/\[Clubhouse: \d+ bytes/);
  });

  it('previews a diff\'s path', () => {
    const event = update({ content: [{ type: 'diff', path: 'p'.repeat(2 * 1024 * 1024), newText: 'small' }] });
    expect(bytes(boundChatEvent(event, bytes(event)))).toBeLessThan(8 * 1024);
  });

  it('says so whenever a diff becomes text, even if what is left looks whole', () => {
    const event = update({ content: [{ type: 'diff', path: 'f', oldText: 'o'.repeat(3 * 1024 * 1024), newText: 'small' }] });
    const [block] = (boundChatEvent(event, bytes(event)) as any).data.content;
    expect(block.type).toBe('text');
    expect(block.text).toContain('too large to show as a diff');
    expect(block.text).toContain('small');
  });

  it('stays within its limit when the output is all control characters', () => {
    const one = update({ content: [{ type: 'terminal', output: '\x01'.repeat(20 * 1024 * 1024) }] });
    expect(bytes(boundChatEvent(one, bytes(one)))).toBeLessThanOrEqual(TOOL_EVENT_MAX_BYTES);
    const two = update({ content: [{ type: 'text', text: '\x01'.repeat(10 * 1024 * 1024) }, { type: 'text', text: '\x02'.repeat(10 * 1024 * 1024) }] });
    expect(bytes(boundChatEvent(two, bytes(two)))).toBeLessThanOrEqual(TOOL_EVENT_MAX_BYTES);
  });

  it('passes everything else through, however large', () => {
    const event = { type: 'assistant_message', data: { text: big } } as never;
    expect(boundChatEvent(event, bytes(event))).toBe(event);
  });

  it('passes a small tool update through', () => {
    const event = update({ status: 'completed', content: [{ type: 'text', text: 'small' }] });
    expect(boundChatEvent(event, bytes(event))).toBe(event);
  });

  it('keeps what the call is, and replaces content', () => {
    const event = update({ status: 'failed', durationMs: 5, error: 'it broke', contentMode: 'append', content: [{ type: 'terminal', command: 'c', cwd: '/x', output: big, exitCode: 2 }] });
    const { data } = boundChatEvent(event, bytes(event)) as any;
    expect(data).toMatchObject({ toolCallId: 't', status: 'failed', durationMs: 5, error: 'it broke', contentMode: 'replace', truncated: { originalBytes: bytes(event) } });
    expect(data.content[0]).toMatchObject({ type: 'terminal', command: 'c', cwd: '/x', exitCode: 2 });
    expect(bytes(data)).toBeLessThan(TOOL_EVENT_MAX_BYTES);
  });

  it('keeps a small rawOutput and drops a large one', () => {
    const small = boundChatEvent(update({ content: [{ type: 'text', text: big }], rawOutput: { ok: true } }), 6 * 1024 * 1024) as any;
    expect(small.data.rawOutput).toEqual({ ok: true });
    const large = boundChatEvent(update({ rawOutput: { stdout: big } }), 6 * 1024 * 1024) as any;
    expect(large.data).not.toHaveProperty('rawOutput');
    expect(large.data).not.toHaveProperty('contentMode');
  });

  it('turns a diff too large to send into text, so part of one can not read as the change', () => {
    const { data } = boundChatEvent(update({ content: [{ type: 'diff', path: 'a.ts', oldText: big, newText: big }] }), 11 * 1024 * 1024) as any;
    expect(data.content[0].type).toBe('text');
    expect(data.content[0].text.startsWith('a.ts\n')).toBe(true);
    expect(bytes(data)).toBeLessThan(TOOL_EVENT_MAX_BYTES);
  });

  it('stays bounded with very many blocks, and says some went', () => {
    const blocks = Array.from({ length: 5000 }, () => ({ type: 'text', text: 'y'.repeat(4096) }));
    const { data } = boundChatEvent(update({ content: blocks }), 20 * 1024 * 1024) as any;
    expect(bytes(data)).toBeLessThan(2 * TOOL_EVENT_MAX_BYTES);
    expect(data.content.at(-1).text).toMatch(/4936 more blocks/);
  });
});
