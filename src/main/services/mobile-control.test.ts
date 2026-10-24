import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, ChatEvent } from '../../shared/chat';
import { MobileCommandService, MobileControlError, parseMobileCommand, executeChatCommand, pendingInteractions, MOBILE_COMMAND_TTL_MS } from './mobile-control';

const command = (service: MobileCommandService, extra = {}) => ({ version: 1, epoch: service.epoch, commandId: 'cmd-1', type: 'chat.send', agentId: 'agent-1', sessionId: 'session-1', text: 'hello', ...extra });
const event = (type: string, data: object, seq = 1) => ({ v: 1, type, data, seq, agentId: 'agent-1', sessionId: 'session-1', ts: 1 }) as ChatEvent;
function runtime(events: ChatEvent[] = []): AgentRuntime {
  return { kind: 'chat', agentId: 'agent-1', isRunning: () => true, getSessionId: () => 'session-1',
    getState: () => 'idle', sendMessage: vi.fn().mockResolvedValue({ delivery: 'queued', messageId: 'message-1' }),
    interrupt: vi.fn().mockResolvedValue(undefined), readTranscript: vi.fn().mockResolvedValue({ kind: 'chat', events }),
    getPendingPermissionOptions: (requestId: string) => pendingInteractions(events).pendingPermissions.find((e) => e.data.requestId === requestId)?.data.options,
    respondPermission: vi.fn().mockResolvedValue(undefined), answerQuestion: vi.fn().mockResolvedValue(undefined), hasPendingQuestion: () => true,
  } as unknown as AgentRuntime;
}

describe('mobile command receipts', () => {
  it('fails closed without a paired certificate principal', async () => {
    const service = new MobileCommandService(); const run = vi.fn();
    expect((await service.execute(undefined, command(service), run)).statusCode).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent requests and key ordering under the same peer', async () => {
    const service = new MobileCommandService(); let finish!: (value: unknown) => void;
    const run = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = service.execute('peer', command(service), run);
    const second = service.execute('peer', { text: 'hello', ...command(service) }, run);
    await Promise.resolve(); expect(run).toHaveBeenCalledTimes(1);
    finish({ delivery: 'queued' });
    expect(await first).toEqual(await second);
  });
  it('rejects ID reuse with different content but scopes IDs to a peer', async () => {
    const service = new MobileCommandService(); const run = vi.fn().mockResolvedValue({});
    await service.execute('a', command(service), run);
    expect((await service.execute('a', command(service, { text: 'other' }), run)).body.error?.code).toBe('command_conflict');
    expect((await service.execute('b', command(service), run)).statusCode).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('retains failures to avoid duplicate partial effects and does not expose exceptions', async () => {
    const service = new MobileCommandService(); const run = vi.fn().mockRejectedValue(new Error('/secret/path token=value'));
    const first = await service.execute('a', command(service), run);
    expect(first.body.status).toBe('failed'); expect(first.body.error?.code).toBe('command_failed');
    expect(await service.execute('a', command(service), run)).toEqual(first); expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects stale epochs after host restart before dispatch', async () => {
    const service = new MobileCommandService(); const old = command(service); service.reset(); const run = vi.fn();
    expect((await service.execute('a', old, run)).body.error?.code).toBe('epoch_mismatch'); expect(run).not.toHaveBeenCalled();
  });
  it('rejects at capacity instead of dropping valid receipts; expires only settled commands', async () => {
    let now = 1; const service = new MobileCommandService(() => now, 1); const run = vi.fn().mockResolvedValue({});
    await service.execute('a', command(service), run);
    expect((await service.execute('a', command(service, { commandId: 'cmd-2' }), run)).statusCode).toBe(429);
    now += MOBILE_COMMAND_TTL_MS + 1;
    expect((await service.execute('a', command(service, { commandId: 'cmd-2' }), run)).statusCode).toBe(200);
  });
  it('returns structured expected failures', async () => {
    const service = new MobileCommandService();
    expect((await service.execute('a', command(service), async () => { throw new MobileControlError('session_mismatch'); })).body.status).toBe('rejected');
  });
});

describe('mobile validation and chat dispatch', () => {
  it.each([null, [], { commandId: null }, { version: 2 }, { type: 'shell.exec' }, { text: '' }, { delivery: 'force' }, { freeAgentMode: true }, { text: 'x'.repeat(65537) }])('rejects malformed or escalating input %j', (bad) => {
    const service = new MobileCommandService();
    expect(() => parseMobileCommand(bad === null || Array.isArray(bad) ? bad : { ...command(service), ...bad })).toThrow();
  });
  it('preserves requested delivery and reports actual delivery', async () => {
    const service = new MobileCommandService(); const rt = runtime();
    const cmd = parseMobileCommand(command(service, { delivery: 'steer' }));
    expect(await executeChatCommand(cmd as any, rt, async () => true)).toEqual({ delivery: 'queued', messageId: 'message-1' });
    expect(rt.sendMessage).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], { source: 'annex', delivery: 'steer', clientCommandId: 'cmd-1' });
  });
  it('does not fall through to terminal input', async () => {
    const cmd = command(new MobileCommandService()); const rt = runtime(); Object.assign(rt, { kind: 'pty' });
    await expect(executeChatCommand(cmd as any, rt, async () => true)).rejects.toMatchObject({ code: 'not_chat' });
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects stale sessions and revert races', async () => {
    const rt = runtime(); const cmd = command(new MobileCommandService());
    await expect(executeChatCommand({ ...cmd, sessionId: 'stale' } as any, rt, async () => true)).rejects.toMatchObject({ code: 'session_mismatch' });
    await expect(executeChatCommand(cmd as any, rt, async () => false)).rejects.toMatchObject({ code: 'revert_in_progress' });
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });
  it('interrupts the turn without stopping the agent', async () => {
    const rt = runtime(); const cmd = command(new MobileCommandService(), { type: 'chat.interrupt' });
    await executeChatCommand(cmd as any, rt, async () => true); expect(rt.interrupt).toHaveBeenCalledOnce();
  });
  it('requires an exact pending option and rejects persistent permission escalation', async () => {
    const rt = runtime([event('permission_request', { requestId: 'p', options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }] })]);
    const cmd = command(new MobileCommandService(), { type: 'chat.permission', requestId: 'p', optionId: 'always' });
    await expect(executeChatCommand(cmd as any, rt, async () => true)).rejects.toMatchObject({ code: 'persistent_approval_not_supported' });
    await expect(executeChatCommand({ ...cmd, optionId: 'bogus' } as any, rt, async () => true)).rejects.toMatchObject({ code: 'pending_request_not_found' });
    await executeChatCommand({ ...cmd, optionId: 'once' } as any, rt, async () => true);
    expect(rt.respondPermission).toHaveBeenCalledExactlyOnceWith('p', 'once');
  });
  it('rejects approval already settled while its transcript entry is still pending', async () => {
    const rt = runtime([event('permission_request', { requestId: 'p', options: [{ optionId: 'once', kind: 'allow_once' }] })]);
    rt.getPendingPermissionOptions = () => undefined;
    const cmd = command(new MobileCommandService(), { type: 'chat.permission', requestId: 'p', optionId: 'once' });
    await expect(executeChatCommand(cmd as any, rt, async () => true)).rejects.toMatchObject({ code: 'pending_request_not_found' });
    expect(rt.respondPermission).not.toHaveBeenCalled();
  });
  it('rechecks authorization after awaiting a send prerequisite', async () => {
    const rt = runtime(); let authorized = true;
    const guard = () => { if (!authorized) throw new MobileControlError('authorization_revoked', 403); };
    await expect(executeChatCommand(command(new MobileCommandService()) as any, rt, async () => { authorized = false; return true; }, guard)).rejects.toMatchObject({ code: 'authorization_revoked' });
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });
  it('rechecks runtime identity after awaiting an approval transcript', async () => {
    const rt = runtime(); let current = true;
    rt.readTranscript = vi.fn().mockImplementation(async () => { current = false; return { events: [] }; });
    const cmd = command(new MobileCommandService(), { type: 'chat.permission', requestId: 'p', optionId: 'once' });
    await expect(executeChatCommand(cmd as any, rt, async () => true, () => {
      if (!current) throw new MobileControlError('session_mismatch');
    })).rejects.toMatchObject({ code: 'session_mismatch' });
    expect(rt.respondPermission).not.toHaveBeenCalled();
  });
  it('removes only the requested queued messages and reports actual removal', async () => {
    const rt = runtime(); rt.removeQueued = vi.fn().mockResolvedValue(['queued-1']);
    const cmd = command(new MobileCommandService(), { type: 'chat.queue.remove', messageIds: ['queued-1', 'already-delivered'] });
    expect(await executeChatCommand(cmd as any, rt, async () => true)).toEqual({ removed: ['queued-1'] });
    expect(rt.removeQueued).toHaveBeenCalledExactlyOnceWith(['queued-1', 'already-delivered']);
  });
  it('does not resurrect resolved or ended-session prompts', () => {
    const events = [event('permission_request', { requestId: 'p', options: [] }), event('question', { requestId: 'q', questions: [] }), event('permission_resolved', { requestId: 'p' })];
    expect(pendingInteractions(events).pendingPermissions).toEqual([]);
    expect(pendingInteractions(events).pendingQuestions).toHaveLength(1);
    expect(pendingInteractions([...events, event('session_ended', {})])).toEqual({ pendingPermissions: [], pendingQuestions: [] });
  });
});
