import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../../shared/chat';
import type { ControllerChatPage } from '../../shared/controller-chat';
const mocks = vi.hoisted(() => ({ member: true, controller: true, outcome: 'allow', events: [] as ChatEvent[], live: false, read: vi.fn(), grant: vi.fn() }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => 'controller' }));
vi.mock('./dispatcher-federation', () => ({ remoteFederationController: () => mocks.controller ? { enabled: true, agentId: 'caller' } : undefined }));
vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => mocks.member }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ decideGrant: (...args: unknown[]) => { mocks.grant(...args); return { outcome: mocks.outcome }; } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => mocks.live ? { kind: 'chat', isRunning: () => true, getSessionId: () => 's', readTranscript: async () => ({ events: await mocks.read() }) } : undefined }));
vi.mock('./agent-runtime/chat-transcript', () => ({
  readChatTranscript: (_agent: string, opts: { afterSeq?: number }) => mocks.read(opts),
  chatTranscriptHead: async () => ({ sessionId: mocks.events[mocks.events.length - 1]?.sessionId ?? null, lastSeq: mocks.events[mocks.events.length - 1]?.seq ?? 0 }),
  listChatSessions: async () => [{ sessionId: 's', title: 'token=private-value' }],
}));
import { readControllerChat, redactControllerChat, resetControllerChatReads } from './annex-controller-chat';

const event = (seq: number, text = `Message ${seq}`): ChatEvent => ({ agentId: 'controller', sessionId: 's', seq, ts: seq, type: 'agent_message', data: { messageId: `m${seq}`, text } });
const read = (query = '', authorized = () => true, sessions = false) => readControllerChat('peer', new URLSearchParams(query), sessions, authorized);
const page = async (query = '') => (await read(query)).body as ControllerChatPage;
beforeEach(() => {
  resetControllerChatReads();
  mocks.member = true; mocks.controller = true; mocks.outcome = 'allow'; mocks.live = false;
  mocks.events = [event(1), event(2), event(3), event(4)];
  mocks.read.mockImplementation(async (opts?: { afterSeq?: number }) => mocks.events.filter((event) => opts?.afterSeq === undefined || event.seq > opts.afterSeq));
});

describe('desktop controller chat', () => {
  it('reads full history and pages back without dropping or summarizing events', async () => {
    expect(await page('limit=2')).toMatchObject({ readOnly: true, sessionId: 's', lastSeq: 4, nextBeforeSeq: 3, events: [event(3), event(4)] });
    expect(await page('limit=2&beforeSeq=3')).toMatchObject({ nextBeforeSeq: null, events: [event(1), event(2)] });
    expect(mocks.grant).toHaveBeenCalledWith('caller@peer', 'agent.read', { kind: 'agent', agentId: 'controller' }, true);
  });
  it('walks forward across large live bursts without gaps and reports the live session', async () => {
    mocks.live = true;
    expect(await page('afterSeq=0&limit=2')).toMatchObject({ currentSessionId: 's', nextAfterSeq: 2, events: [event(1), event(2)] });
    expect(await page('afterSeq=2&limit=2')).toMatchObject({ nextAfterSeq: null, events: [event(3), event(4)] });
  });
  it('reads only newly appended lines on a poll, and no transcript lines when unchanged', async () => {
    await page();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect((await page('afterSeq=4')).events).toEqual([]);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    mocks.events.push(event(5));
    expect((await page('afterSeq=4')).events).toEqual([event(5)]);
    expect(mocks.read).toHaveBeenLastCalledWith({ sessionId: 's', afterSeq: 4, tail: 1 });
  });
  it.each(['duplicate', 'non-event'])('falls back to a full read when a %s line crowds events out of the incremental tail', async (kind) => {
    await page();
    mocks.events.push(event(5), event(6), event(7));
    mocks.read.mockImplementation(async (opts: { tail?: number }) => opts.tail
      ? kind === 'duplicate' ? [event(6), event(7), event(7)] : [event(6), event(7)]
      : mocks.events);
    expect((await page('afterSeq=4')).events).toEqual([event(5), event(6), event(7)]);
    expect(mocks.read).toHaveBeenNthCalledWith(2, { sessionId: 's', afterSeq: 4, tail: 3 });
    expect(mocks.read).toHaveBeenNthCalledWith(3, { sessionId: 's' });
  });
  it('rate limits each peer before transcript IO', async () => {
    for (let i = 0; i < 20; i++) expect((await read()).status).toBe(200);
    const calls = mocks.read.mock.calls.length;
    expect(await read()).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(mocks.read).toHaveBeenCalledTimes(calls);
    expect((await readControllerChat('another-peer', new URLSearchParams(), false, () => true)).status).toBe(200);
  });
  it.each(['refuse', 'ask'])('refuses a host grant of %s before reading', async (outcome) => {
    mocks.outcome = outcome;
    expect((await read()).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rejects nonmembers and unverified controller identities', async () => {
    mocks.member = false;
    expect((await read()).status).toBe(403);
    mocks.member = true; mocks.controller = false;
    expect((await read()).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rechecks the pin/membership and host grant after transcript IO', async () => {
    let allowed = true;
    mocks.read.mockImplementationOnce(async () => { allowed = false; return mocks.events; });
    expect((await read('', () => allowed)).status).toBe(403);
    resetControllerChatReads();
    mocks.read.mockImplementationOnce(async () => { mocks.outcome = 'refuse'; return mocks.events; });
    expect((await read()).status).toBe(403);
  });
  it('scrubs nested credential values, tool inputs and output text, without cutting ordinary chat', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvw';
    mocks.events = [event(1, `Useful context ${secret} Bearer abcdefghijklmno`), {
      ...event(2), type: 'tool_call', data: { toolCallId: 'tool', kind: 'other', title: 'Read', status: 'completed', rawInput: { password: 'private', nested: { apiKey: 'private' } }, content: [{ type: 'text', text: 'token=private-output' }] },
    } as ChatEvent];
    const result = JSON.stringify(await page());
    expect(result).toContain('Useful context'); expect(result).toContain('tool_call');
    for (const value of [secret, 'abcdefghijklmno', 'private', 'private-output']) expect(result).not.toContain(value);
    expect(redactControllerChat({ inputTokens: 123, text: 'a'.repeat(5000) })).toEqual({ inputTokens: 123, text: 'a'.repeat(5000) });
  });
  it('reads saved sessions and scrubs their titles', async () => {
    expect(await read('', () => true, true)).toEqual({ status: 200, body: { sessions: [{ sessionId: 's', title: 'token=<redacted>' }] } });
  });
  it('redacts credentials spanning streamed message, thought and appended tool output chunks', async () => {
    mocks.events = [
      { ...event(1), type: 'agent_message_chunk', data: { messageId: 'm', text: 'Bearer abc' } },
      { ...event(2), type: 'agent_message_chunk', data: { messageId: 'm', text: 'defghi' } },
      { ...event(3), type: 'agent_thought_chunk', data: { messageId: 't', text: 'sk-abcdefghij' } },
      { ...event(4), type: 'agent_thought_chunk', data: { messageId: 't', text: 'klmnopqrstuv' } },
      { ...event(5), type: 'tool_call', data: { toolCallId: 'tool', kind: 'other', title: 'Output', status: 'in_progress', content: [{ type: 'terminal', output: 'sk-abcdefghij' }] } },
      { ...event(6), type: 'tool_call_update', data: { toolCallId: 'tool', contentMode: 'append', content: [{ type: 'terminal', output: 'klmnopqrstuv' }] } },
    ] as ChatEvent[];
    const result = await page('afterSeq=1');
    expect(result.events[0]).toMatchObject({ seq: 2, type: 'agent_message', data: { text: 'Bearer <redacted>' } });
    expect(result.events.find((e) => e.seq === 4)).toMatchObject({ type: 'agent_thought', data: { text: '<redacted>' } });
    expect(result.events.find((e) => e.seq === 6)).toMatchObject({ type: 'tool_call_update', data: { contentMode: 'replace', content: [{ type: 'terminal', output: '<redacted>' }] } });
  });
  it('represents an empty conversation, and bounds failures without exporting content', async () => {
    mocks.events = [];
    expect(await page()).toMatchObject({ events: [], sessionId: null, lastSeq: 0, nextBeforeSeq: null, nextAfterSeq: null });
    mocks.events = [event(1)];
    mocks.read.mockRejectedValueOnce(new Error('SECRET filesystem details'));
    expect(await read()).toEqual({ status: 500, body: { error: 'controller_chat_failed' } });
  });
  it('preserves distinct terminal command contexts when projecting output', async () => {
    mocks.events = [{ ...event(1), type: 'tool_call', data: { toolCallId: 'tool', kind: 'other', title: 'Commands', status: 'completed', content: [
      { type: 'terminal', command: 'first', output: 'one' }, { type: 'terminal', command: 'second', output: 'two' },
    ] } } as ChatEvent];
    expect((await page()).events[0]).toMatchObject({ data: { content: [
      { type: 'terminal', command: 'first', output: 'one' }, { type: 'terminal', command: 'second', output: 'two' },
    ] } });
  });
  it('returns explicit failure for an oversized whole event rather than summarizing or skipping it', async () => {
    mocks.events = [event(1, 'x'.repeat(8 * 1024 * 1024))];
    expect(await read()).toEqual({ status: 413, body: { error: 'event_too_large' } });
  });
  it('keeps 500 events from a 30 KB reply streamed in 1000 chunks without quadratic body copies (P1)', async () => {
    mocks.events = Array.from({ length: 1000 }, (_, i) => ({ ...event(i + 1), type: 'agent_message_chunk', data: { messageId: 'reply', text: 'x'.repeat(30) } } as ChatEvent));
    const result = await page();
    expect(result.events).toHaveLength(500);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(200_000);
    const text = result.events.filter((e) => e.type === 'agent_message').map((e) => e.data.text).filter(Boolean);
    expect(text).toEqual(['x'.repeat(30_000)]);
  });
  it('shows a labeled bounded tool preview instead of 413 for 2000 appended 5 KB blocks (P1b)', async () => {
    mocks.events = [{ ...event(1), type: 'tool_call', data: { toolCallId: 'large', kind: 'other', title: 'Large output', status: 'in_progress', content: [] } } as ChatEvent,
      ...Array.from({ length: 2000 }, (_, i) => ({ ...event(i + 2), type: 'tool_call_update', data: { toolCallId: 'large', contentMode: 'append', content: [{ type: 'terminal', output: 'x'.repeat(5000) }] } } as ChatEvent))];
    const result = await read();
    expect(result.status).toBe(200);
    const value = result.body as ControllerChatPage;
    expect(value.events).toHaveLength(500);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(1024 * 1024);
    expect(JSON.stringify(value.events[value.events.length - 1])).toContain('omitted here');
  });
  it('blanks every superseded per-character token prefix (P4)', async () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz';
    mocks.events = [...token].map((text, i) => ({ ...event(i + 1), type: 'agent_message_chunk', data: { messageId: 'secret', text } } as ChatEvent));
    const value = await page();
    expect(value.events.slice(0, -1).every((e) => e.type === 'agent_message' && e.data.text === '')).toBe(true);
    expect(value.events[value.events.length - 1]).toMatchObject({ data: { text: '<redacted>' } });
    expect(JSON.stringify(value)).not.toContain('sk-');
  });
  it('preserves usage tokens and turn totals as structured numeric values (P5)', async () => {
    const tokens = { input: 20, output: 10, cachedInput: 3, cacheWrite: 4, total: 30 };
    mocks.events = [
      { ...event(1), type: 'usage', data: { scope: 'turn', tokens, costUsd: 0.2 } },
      { ...event(2), type: 'turn_ended', data: { stopReason: 'end_turn', usage: tokens, costUsd: 0.2 } },
    ] as ChatEvent[];
    expect((await page()).events).toEqual(mocks.events);
    expect(redactControllerChat({ tokens: { password: 'secret', input: 2 }, password: ['secret text'] })).toEqual({ tokens: { password: '<redacted>', input: 2 }, password: ['secret text'] });
  });
  it.each(['limit=0', 'limit=2001', 'beforeSeq=-1', 'afterSeq=-1', 'sessionId=', 'beforeSeq=3&afterSeq=1', 'limit=1&limit=2', 'command=send'])('rejects malformed query %s', async (query) => {
    expect((await read(query)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
