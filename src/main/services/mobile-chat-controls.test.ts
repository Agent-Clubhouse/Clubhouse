import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, ChatCapabilities, ChatEvent } from '../../shared/chat';
import { MINIMAL_CHAT_CAPABILITIES } from '../../shared/chat';
import { MobileCommandService, chatControls, executeChatCommand, parseMobileCommand } from './mobile-control';

// chat.setModel / chat.setLevel and the snapshot's chatControls (#2462).
let seq = 0;
const event = (type: string, data: object) => ({ v: 1, type, data, seq: ++seq, agentId: 'agent-1', sessionId: 'session-1', ts: 1 }) as ChatEvent;
const caps = (over: Partial<ChatCapabilities> = {}): ChatCapabilities => ({
  ...MINIMAL_CHAT_CAPABILITIES, modelSwitch: 'live', effortSwitch: 'live', effortDefault: true,
  liveLevels: ['plan', 'ask', 'auto_edit', 'full_access'], ...over,
});
const sessionEvents = (): ChatEvent[] => [
  event('session_started', { driver: 'claude_agent_sdk', provider: 'claude-code', cwd: '/p', resumed: false, model: 'opus', level: 'ask', capabilities: caps() }),
  event('session_info', { models: [{ id: 'opus', label: 'Opus' }, { id: 'haiku', label: 'Haiku' }], efforts: ['low', 'high'], levelNames: { ask: 'default', plan: 'plan' } }),
  event('model_changed', { modelId: 'opus', effort: 'high' }),
];
function runtime(events: ChatEvent[] = sessionEvents(), capabilities: ChatCapabilities | undefined = caps()) {
  return { kind: 'chat', agentId: 'agent-1', isRunning: () => true, getSessionId: () => 'session-1', getState: () => 'idle',
    readTranscript: vi.fn().mockResolvedValue({ kind: 'chat', events }), getCapabilities: () => capabilities,
    setModel: vi.fn().mockResolvedValue(undefined), setLevel: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRuntime & { setModel: ReturnType<typeof vi.fn>; setLevel: ReturnType<typeof vi.fn> };
}
const base = { version: 1, commandId: 'c1', epoch: 'e1', agentId: 'agent-1', sessionId: 'session-1' };
const setModel = (extra: object) => parseMobileCommand({ ...base, type: 'chat.setModel', ...extra }) as Extract<ReturnType<typeof parseMobileCommand>, { sessionId: string }>;
const setLevel = (level: string) => parseMobileCommand({ ...base, type: 'chat.setLevel', level }) as Extract<ReturnType<typeof parseMobileCommand>, { sessionId: string }>;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code: string }) => e.code);

describe('chat.setModel and chat.setLevel parsing', () => {
  it('accepts the documented shapes, effort null included', () => {
    expect(setModel({ model: 'opus' })).toMatchObject({ type: 'chat.setModel', model: 'opus' });
    expect(setModel({ model: 'opus', effort: 'high' })).toMatchObject({ effort: 'high' });
    expect(setModel({ model: 'opus', effort: null })).toMatchObject({ effort: null });
    expect(setLevel('full_access')).toMatchObject({ type: 'chat.setLevel', level: 'full_access' });
  });
  it.each([
    [{ type: 'chat.setModel' }],
    [{ type: 'chat.setModel', model: '' }],
    [{ type: 'chat.setModel', model: 'opus', effort: '' }],
    [{ type: 'chat.setModel', model: 'opus', effort: 3 }],
    [{ type: 'chat.setModel', model: 'opus', level: 'ask' }],
    [{ type: 'chat.setModel', model: 'opus', sessionId: undefined }],
    [{ type: 'chat.setLevel' }],
    [{ type: 'chat.setLevel', level: 'root' }],
    [{ type: 'chat.setLevel', level: 'ask', model: 'opus' }],
  ])('rejects %j', (extra) => {
    expect(() => parseMobileCommand({ ...base, ...extra })).toThrow('invalid_command');
  });
  it('fingerprints every field, so a retry with another effort or level conflicts', async () => {
    const service = new MobileCommandService(); const run = vi.fn().mockResolvedValue({});
    const cmd = { ...base, epoch: service.epoch, type: 'chat.setModel', model: 'opus', effort: 'high' };
    await service.execute('peer', cmd, run);
    expect((await service.execute('peer', { ...cmd, effort: 'low' }, run)).body.error?.code).toBe('command_conflict');
    expect((await service.execute('peer', { ...cmd, effort: null }, run)).body.error?.code).toBe('command_conflict');
    const lvl = { ...base, epoch: service.epoch, commandId: 'c2', type: 'chat.setLevel', level: 'plan' };
    await service.execute('peer', lvl, run);
    expect((await service.execute('peer', { ...lvl, level: 'ask' }, run)).body.error?.code).toBe('command_conflict');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('chatControls snapshot fields', () => {
  it('folds model, effort, level, lists and capability fields from the session', () => {
    const events = [...sessionEvents(), event('mode_changed', { level: 'plan' })];
    expect(chatControls(events, caps({ modelSwitch: 'per_turn', effortSwitch: 'per_turn' }))).toEqual({
      model: 'opus', modelUnknown: false, effort: 'high', effortIsDefault: false, effortReported: true, level: 'plan',
      models: [{ id: 'opus', label: 'Opus' }, { id: 'haiku', label: 'Haiku' }], efforts: ['low', 'high'],
      levelNames: { ask: 'default', plan: 'plan' }, liveLevels: ['plan', 'ask', 'auto_edit', 'full_access'],
      modelSwitch: 'per_turn', effortSwitch: 'per_turn', effortDefault: true, switchNote: 'Applies from the next message.',
    });
  });
  it('reports an unknown default model and an unreported effort, as the composer waits for them', () => {
    const c = chatControls([sessionEvents()[0], event('session_info', { model: null })], caps());
    expect(c).toMatchObject({ model: null, modelUnknown: true, effort: null, effortReported: false, switchNote: null });
  });
  it('a new session clears the last one\'s lists', () => {
    const c = chatControls([...sessionEvents(), event('session_started', { driver: 'acp', provider: 'x', cwd: '/', resumed: true, capabilities: caps() })], caps());
    expect(c).toMatchObject({ models: [], efforts: [], levelNames: {}, model: 'opus', level: 'ask' });
  });
  it('is conservative without capabilities', () => {
    expect(chatControls([], undefined)).toMatchObject({ liveLevels: [], modelSwitch: 'none', effortSwitch: 'none', effortDefault: false, switchNote: null });
  });
});

describe('chat.setModel', () => {
  it('switches model and keeps a chosen effort the list offers, as the model menu does', async () => {
    const rt = runtime();
    expect(await executeChatCommand(setModel({ model: 'haiku' }), rt, async () => true)).toEqual({ model: 'haiku', effort: 'high', changed: true });
    expect(rt.setModel).toHaveBeenCalledWith('haiku', 'high');
  });
  it('lets a default effort follow the new model\'s default', async () => {
    const rt = runtime([...sessionEvents(), event('model_changed', { modelId: 'opus', effort: 'high', effortIsDefault: true })]);
    expect(await executeChatCommand(setModel({ model: 'haiku' }), rt, async () => true)).toEqual({ model: 'haiku', effort: null, changed: true });
    expect(rt.setModel).toHaveBeenCalledWith('haiku', undefined);
  });
  it('changes effort on the current model, and null returns it to the provider default', async () => {
    const rt = runtime();
    expect(await executeChatCommand(setModel({ model: 'opus', effort: 'low' }), rt, async () => true)).toMatchObject({ effort: 'low', changed: true });
    expect(await executeChatCommand(setModel({ model: 'opus', effort: null }), rt, async () => true)).toMatchObject({ effort: null, changed: true });
    expect(rt.setModel.mock.calls).toEqual([['opus', 'low'], ['opus', null]]);
  });
  it('does nothing when nothing changes', async () => {
    const rt = runtime();
    expect(await executeChatCommand(setModel({ model: 'opus' }), rt, async () => true)).toEqual({ model: 'opus', effort: 'high', changed: false });
    expect(rt.setModel).not.toHaveBeenCalled();
  });
  it.each([
    ['model_switch_not_supported', { model: 'haiku' }, caps({ modelSwitch: 'none' })],
    ['unknown_model', { model: 'gpt' }, caps()],
    ['effort_switch_not_supported', { model: 'opus', effort: 'low' }, caps({ effortSwitch: 'none' })],
    ['effort_default_not_supported', { model: 'opus', effort: null }, caps({ effortDefault: undefined })],
    ['unknown_effort', { model: 'opus', effort: 'xhigh' }, caps()],
  ])('refuses with %s', async (expected, extra, capabilities) => {
    const rt = runtime(sessionEvents(), capabilities);
    expect(await code(executeChatCommand(setModel(extra), rt, async () => true))).toBe(expected);
    expect(rt.setModel).not.toHaveBeenCalled();
  });
  it('refuses a switch when the session lists no models', async () => {
    const rt = runtime([sessionEvents()[0], sessionEvents()[2]]);
    expect(await code(executeChatCommand(setModel({ model: 'haiku' }), rt, async () => true))).toBe('model_switch_not_supported');
  });
  it('refuses another session', async () => {
    const rt = runtime();
    expect(await code(executeChatCommand({ ...setModel({ model: 'haiku' }), sessionId: 'old' }, rt, async () => true))).toBe('session_mismatch');
  });
});

describe('chat.setLevel', () => {
  it('raises and lowers to any live level: a paired phone has full control', async () => {
    const rt = runtime();
    expect(await executeChatCommand(setLevel('full_access'), rt, async () => true)).toEqual({ level: 'full_access', changed: true });
    expect(await executeChatCommand(setLevel('plan'), rt, async () => true)).toEqual({ level: 'plan', changed: true });
    expect(rt.setLevel.mock.calls).toEqual([['full_access'], ['plan']]);
  });
  it('only accepts levels in liveLevels', async () => {
    const rt = runtime();
    expect(await code(executeChatCommand(setLevel('auto'), rt, async () => true))).toBe('level_not_live');
    expect(rt.setLevel).not.toHaveBeenCalled();
  });
  it('the current level is a no-op even if it can\'t be re-entered live', async () => {
    const rt = runtime(sessionEvents(), caps({ liveLevels: [] }));
    expect(await executeChatCommand(setLevel('ask'), rt, async () => true)).toEqual({ level: 'ask', changed: false });
    expect(rt.setLevel).not.toHaveBeenCalled();
  });
  it('refuses a runtime without level control', async () => {
    const rt = { ...runtime(), setLevel: undefined } as unknown as AgentRuntime;
    expect(await code(executeChatCommand(setLevel('plan'), rt, async () => true))).toBe('level_switch_not_supported');
  });
});
