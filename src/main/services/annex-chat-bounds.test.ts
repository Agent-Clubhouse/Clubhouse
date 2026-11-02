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

  it('cuts at a line when one is near', () => {
    const preview = previewText(`${'line of text\n'.repeat(100_000)}`, 4096);
    expect(preview.slice(0, preview.indexOf('\n[Clubhouse'))).toMatch(/line of text\n$/);
  });
});

describe('boundChatEvent', () => {
  const big = 'x'.repeat(5 * 1024 * 1024);

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
