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
  it.each([{ attachmentIds: [] }, { attachmentIds: 'a' }, { attachmentIds: [''] }, { attachmentIds: ['a', 'a'] },
    { attachmentIds: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { attachmentIds: ['x'.repeat(129)] }, { text: '', attachmentIds: [] },
  ])('rejects malformed attachmentIds %j', (bad) => {
    expect(() => parseMobileCommand({ ...command(new MobileCommandService()), ...bad })).toThrow();
  });
  it('sends image-only and captioned messages with resolved attachments (#2453)', async () => {
    const service = new MobileCommandService();
    const rt = Object.assign(runtime(), { getCapabilities: () => ({ images: true }) });
    const image = { type: 'image', mimeType: 'image/png', path: '/staged/x.png' } as const;
    const resolve = vi.fn().mockResolvedValue([image]);
    const imageOnly = parseMobileCommand(command(service, { text: '', attachmentIds: ['att-1'] }));
    await executeChatCommand(imageOnly as any, rt, async () => true, () => {}, resolve);
    expect(resolve).toHaveBeenCalledWith(['att-1'], { images: true });
    expect(rt.sendMessage).toHaveBeenLastCalledWith([image], { source: 'annex', delivery: 'auto', clientCommandId: 'cmd-1' });
    const captioned = parseMobileCommand(command(service, { attachmentIds: ['att-1'] }));
    await executeChatCommand(captioned as any, rt, async () => true, () => {}, resolve);
    expect(rt.sendMessage).toHaveBeenLastCalledWith([{ type: 'text', text: 'hello' }, image], expect.anything());
  });
  it('refuses attachments for agents without image support, and unusable ids, sending nothing', async () => {
    const cmd = parseMobileCommand(command(new MobileCommandService(), { attachmentIds: ['att-1'] }));
    const resolve = vi.fn().mockResolvedValue([]);
    for (const caps of [undefined, { images: false }]) {
      const rt = Object.assign(runtime(), { getCapabilities: () => caps });
      await expect(executeChatCommand(cmd as any, rt, async () => true, () => {}, resolve)).rejects.toMatchObject({ code: 'images_not_supported' });
      expect(rt.sendMessage).not.toHaveBeenCalled();
    }
    expect(resolve).not.toHaveBeenCalled();
    const rt = Object.assign(runtime(), { getCapabilities: () => ({ images: true }) });
    const failing = vi.fn().mockRejectedValue(new Error('/Users/me/secret.png moved'));
    const err = await executeChatCommand(cmd as any, rt, async () => true, () => {}, failing).catch((e) => e);
    expect(err).toMatchObject({ code: 'attachment_unavailable' });
    expect(err.message).not.toContain('/Users');
    expect(rt.sendMessage).not.toHaveBeenCalled();
  });
  it('fingerprints attachmentIds: a retry with other images is a conflict', async () => {
    const service = new MobileCommandService(); const run = vi.fn().mockResolvedValue({});
    const first = await service.execute('a', command(service, { attachmentIds: ['x', 'y'] }), run);
    expect(await service.execute('a', command(service, { attachmentIds: ['x', 'y'] }), run)).toEqual(first);
    expect((await service.execute('a', command(service, { attachmentIds: ['y', 'x'] }), run)).body.error?.code).toBe('command_conflict');
    expect((await service.execute('a', command(service), run)).body.error?.code).toBe('command_conflict');
    expect(run).toHaveBeenCalledTimes(1);
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

describe('agent.create and agent.update parsing (#2451, #2452)', () => {
  const base = { version: 1, epoch: 'e', commandId: 'c' };
  const create = (extra: object = {}) => ({ ...base, type: 'agent.create', projectId: 'p', name: 'brave-otter', color: 'indigo', ...extra });
  const update = (extra: object = {}) => ({ ...base, type: 'agent.update', agentId: 'a', ...extra });
  const code = (input: unknown) => { try { parseMobileCommand(input); return 'ok'; } catch (e) { return (e as MobileControlError).code; } };

  it('accepts every New agent page field', () => {
    expect(code(create())).toBe('ok');
    expect(code(create({ orchestrator: 'codex-cli', model: 'default', persona: 'qa', useWorktree: true, mcpIds: [], branchName: 'feat/x', branchFrom: 'main', folderName: 'otter' }))).toBe('ok');
  });
  it('requires name and color, and types each field', () => {
    for (const bad of [{ name: undefined }, { color: undefined }, { name: '' }, { useWorktree: 'yes' }, { mcpIds: 'ado' }, { mcpIds: ['a', 'a'] }, { mcpIds: [''] }, { persona: null }, { branchName: 7 }]) {
      expect(code(create(bad))).toBe('invalid_command');
    }
  });
  it('rejects unknown fields on both commands', () => {
    expect(code(create({ mcpConfigs: {} }))).toBe('invalid_command');
    expect(code(create({ parentAgentId: 'x' }))).toBe('invalid_command');
    expect(code(update({ icon: 'x.png' }))).toBe('invalid_command');
    expect(code(update({ instructions: 'x' }))).toBe('invalid_command');
  });
  it('never accepts Free Agent Mode from a phone, whatever its value', () => {
    for (const freeAgentMode of [true, false, null]) {
      expect(code(create({ freeAgentMode }))).toBe('free_agent_mode_not_allowed');
      expect(code(update({ idleSleep: 30, freeAgentMode }))).toBe('free_agent_mode_not_allowed');
    }
    try { parseMobileCommand(create({ freeAgentMode: true })); } catch (e) { expect((e as MobileControlError).statusCode).toBe(403); }
  });
  it('needs at least one setting on agent.update and validates each', () => {
    expect(code(update())).toBe('invalid_command');
    expect(code(update({ agentId: undefined, idleSleep: 30 }))).toBe('invalid_command');
    for (const ok of [{ idleSleep: 'inherit' }, { idleSleep: 'never' }, { idleSleep: 240 }, { emoji: null }, { emoji: '🦦' }, { persona: null },
      { runtime: 'default' }, { runtime: 'chat' }, { clubhouseMode: false }, { name: 'x', color: 'rose', model: 'opus', orchestrator: 'claude-code' }]) {
      expect(code(update(ok))).toBe('ok');
    }
    for (const bad of [{ idleSleep: 45 }, { idleSleep: 0 }, { idleSleep: '30' }, { runtime: 'headless' }, { clubhouseMode: 'on' }, { name: null },
      { model: null }, { emoji: 'x'.repeat(17) }, { color: '' }]) {
      expect(code(update(bad))).toBe('invalid_command');
    }
  });
  it('fingerprints every create field, so a retry with any change conflicts', async () => {
    const service = new MobileCommandService(); const run = vi.fn().mockResolvedValue({ agentId: 'durable_1' });
    const first = { ...create(), epoch: service.epoch, mcpIds: ['ado'], branchFrom: 'main' };
    expect((await service.execute('peer', first, run)).statusCode).toBe(200);
    expect((await service.execute('peer', { ...first }, run)).statusCode).toBe(200);
    for (const change of [{ mcpIds: ['kusto'] }, { branchFrom: 'dev' }, { useWorktree: false }, { persona: 'qa' }]) {
      expect((await service.execute('peer', { ...first, ...change }, run)).body.error?.code).toBe('command_conflict');
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reports a refusal sentence in the receipt message', async () => {
    const service = new MobileCommandService();
    const response = await service.execute('peer', { ...update({ name: 'x y' }), epoch: service.epoch },
      async () => { throw new MobileControlError('invalid_name', 400, 'rejected', 'Names cannot contain spaces'); });
    expect(response).toMatchObject({ statusCode: 400, body: { status: 'rejected', error: { code: 'invalid_name', message: 'Names cannot contain spaces' } } });
  });
});
