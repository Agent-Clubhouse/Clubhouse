import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../../shared/chat';
import type { ControllerChatPage } from '../../shared/controller-chat';
const mocks = vi.hoisted(() => ({ member: true, controller: true, outcome: 'allow', events: [] as ChatEvent[], live: false, read: vi.fn(), grant: vi.fn() }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => 'controller' }));
vi.mock('./dispatcher-federation', () => ({ remoteFederationController: () => mocks.controller ? { enabled: true, agentId: 'caller' } : undefined }));
vi.mock('./annex-agent-calls', () => ({ isNetworkComputer: () => mocks.member }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ decideGrant: (...args: unknown[]) => { mocks.grant(...args); return { outcome: mocks.outcome }; } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: () => mocks.live ? { kind: 'chat', isRunning: () => true, getSessionId: () => 's', readTranscript: async () => ({ events: await mocks.read() }) } : undefined }));
vi.mock('./agent-runtime/chat-transcript', () => ({ readChatTranscript: () => mocks.read(), listChatSessions: async () => [{ sessionId: 's', title: 'token=private-value' }] }));
import { readControllerChat, redactControllerChat } from './annex-controller-chat';

const event = (seq: number, text = `Message ${seq}`): ChatEvent => ({ agentId: 'controller', sessionId: 's', seq, ts: seq, type: 'agent_message', data: { messageId: `m${seq}`, text } });
const read = (query = '', authorized = () => true, sessions = false) => readControllerChat('peer', new URLSearchParams(query), sessions, authorized);
const page = async (query = '') => (await read(query)).body as ControllerChatPage;
beforeEach(() => {
  mocks.member = true; mocks.controller = true; mocks.outcome = 'allow'; mocks.live = false;
  mocks.events = [event(1), event(2), event(3), event(4)];
  mocks.read.mockImplementation(async () => mocks.events);
});

describe('desktop controller chat', () => {
  it('reads full history and pages back without dropping or summarizing events', async () => {
    expect(await page('limit=2')).toMatchObject({ readOnly: true, sessionId: 's', lastSeq: 4, nextBeforeSeq: 3, events: [event(3), event(4)] });
    expect(await page('limit=2&beforeSeq=3')).toMatchObject({ nextBeforeSeq: null, events: [event(1), event(2)] });
    expect(mocks.grant).toHaveBeenCalledWith('caller@peer', 'agent.read', { kind: 'agent', agentId: 'controller' }, true);
  });
  it('walks forward across large live bursts without gaps and reads the live runtime', async () => {
    mocks.live = true;
    expect(await page('afterSeq=0&limit=2')).toMatchObject({ currentSessionId: 's', nextAfterSeq: 2, events: [event(1), event(2)] });
    expect(await page('afterSeq=2&limit=2')).toMatchObject({ nextAfterSeq: null, events: [event(3), event(4)] });
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
  it.each(['limit=0', 'limit=2001', 'beforeSeq=-1', 'afterSeq=-1', 'sessionId=', 'beforeSeq=3&afterSeq=1', 'limit=1&limit=2', 'command=send'])('rejects malformed query %s', async (query) => {
    expect((await read(query)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
