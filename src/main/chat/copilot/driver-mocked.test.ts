/** Contract test: no CLI, socket, model, auth service, or real SDK is started. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { ChatEventDraft } from '../../../shared/chat';

const fake = vi.hoisted(() => ({ configs: [] as any[], launch: vi.fn(), create: vi.fn(), resume: vi.fn() }));
vi.mock('./launch', () => ({
  CopilotLaunchError: class extends Error {},
  launchCopilotServer: fake.launch,
}));
vi.mock('./sdk-loader', () => ({
  loadCopilotSdk: async () => ({
    RuntimeConnection: { forUri: () => ({}) },
    CopilotClient: class {
      start = async () => {};
      getStatus = async () => ({ version: 'fixture' });
      getAuthStatus = async () => ({ isAuthenticated: true });
      listModels = async () => [];
      createSession = fake.create;
      resumeSession = fake.resume;
      stop = async () => {};
      forceStop = async () => {};
    },
  }),
}));
import { COPILOT_EAGER_TOOL_CEILING, CopilotSdkChatDriver } from './driver';

const sdkSession = () => ({
  sessionId: 'fake-session',
  send: async () => 'message-1',
  rpc: { mode: { set: async () => {} }, model: { getCurrent: async () => ({ modelId: 'fake' }) }, commands: { list: async () => ({ commands: [] }) } },
  disconnect: async () => {},
});

beforeEach(() => {
  fake.configs.length = 0;
  fake.launch.mockReset().mockImplementation(() => {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    return { uri: 'fake', connectionToken: 'fake', exited, kill: async () => exit(), stderrTail: () => '', exitCode: () => null };
  });
  fake.create.mockReset().mockImplementation(async (config) => { fake.configs.push(config); return sdkSession(); });
  fake.resume.mockReset().mockImplementation(async (_id, config) => { fake.configs.push(config); return sdkSession(); });
});

describe('Copilot SDK callback wiring with fake transport', () => {
  it.each(['empty_response', 'query'])('scrubs planted turn/system prompts from %s errors and exit stderr (#1919)', async (errorType) => {
    const prompt = `COPILOT-${errorType}-PRIVATE-TURN-1919`;
    const system = `COPILOT-${errorType}-PRIVATE-SYSTEM-1919`;
    let exit!: () => void;
    fake.launch.mockResolvedValue({ uri: 'fake', connectionToken: 'fake', exited: new Promise<void>((r) => { exit = r; }), kill: async () => exit(), stderrTail: () => `warning: ${system} ${prompt}`, exitCode: () => 1 });
    const send = vi.fn(async () => 'message-1');
    fake.create.mockImplementationOnce(async (config) => { fake.configs.push(config); return { ...sdkSession(), send }; });
    const log = vi.fn();
    const session = await new CopilotSdkChatDriver({ log }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit' });
    await session.send([{ type: 'text', text: system }, { type: 'text', text: prompt }], 'prompt');
    fake.configs[0].onEvent({ type: 'session.error', data: { errorType, errorCode: errorType, message: `rejected: ${system} ${prompt}` } });
    exit();
    await new Promise((r) => setImmediate(r));
    const errorLog = log.mock.calls.find((c) => c[1] === (errorType === 'empty_response' ? 'Copilot returned no response' : 'Copilot session error'));
    expect(errorLog?.[2]?.message).toContain('rejected: <redacted:');
    const exitLog = log.mock.calls.find((c) => c[1] === 'Copilot CLI exited');
    expect(exitLog?.[2]).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('warning: <redacted:') });
    expect(JSON.stringify(log.mock.calls)).not.toContain(prompt);
    expect(JSON.stringify(log.mock.calls)).not.toContain(system);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ prompt: `${system}\n${prompt}` }));
    await session.close();
  });

  it.each([
    { errorType: 'query', message: 'No response was returned. Send your message again to retry.' },
    { errorType: 'empty_response', message: 'Empty answer' },
    { errorType: 'query', errorCode: 'empty_response', message: 'Empty answer' },
  ])('ends an empty acknowledgement normally with a quiet notice (%j)', async (data) => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: path.resolve('synthetic'), binaryPath: 'fake', level: 'auto_edit' });
    const config = fake.configs[0];
    await session.send([{ type: 'text', text: '[TASK:sample] [FROM:sample-agent] TASK_RESULT:sample: Acknowledged; closed.' }], 'prompt');
    config.onEvent({ type: 'session.error', data });
    config.onEvent({ type: 'session.idle', data: {} });
    // A later turn still works, and idle does not end the empty turn twice.
    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    config.onEvent({ type: 'assistant.message', data: { messageId: 'reply', content: 'Ready' } });
    config.onEvent({ type: 'session.idle', data: {} });
    await session.close();
    const events: ChatEventDraft[] = [];
    for await (const event of session.events) events.push(event);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'notice')).toContainEqual(expect.objectContaining({
      turnId: 'turn-1', data: { level: 'info', code: 'empty_response', message: 'No response' },
    }));
    expect(events.filter((event) => event.type === 'turn_ended')).toMatchObject([
      { turnId: 'turn-1', data: { stopReason: 'end_turn' } },
      { turnId: 'turn-2', data: { stopReason: 'end_turn' } },
    ]);
  });

  it('still fails a genuine provider error', async () => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: path.resolve('synthetic'), binaryPath: 'fake', level: 'auto_edit' });
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    fake.configs[0].onEvent({ type: 'session.error', data: { errorType: 'query', message: 'Something broke' } });
    await session.close();
    const events: ChatEventDraft[] = [];
    for await (const event of session.events) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', data: { code: 'unknown', message: 'Something broke', fatal: false } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_ended', data: { stopReason: 'error' } }));
  });

  it('does not log SDK error content while closing for an update', async () => {
    let exited!: () => void;
    fake.launch.mockResolvedValue({
      uri: 'fake', connectionToken: 'fake', exited: new Promise<void>((resolve) => { exited = resolve; }),
      kill: async () => { exited(); }, stderrTail: () => '', exitCode: () => null,
    });
    fake.create.mockResolvedValue({
      ...sdkSession(),
      disconnect: async () => { throw new Error('private prompt /private/chat/path'); },
    });
    const log = vi.fn();
    const session = await new CopilotSdkChatDriver({ log }).start({
      agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit',
    });

    await session.close();

    expect(log).toHaveBeenCalledWith('warn', 'Copilot did not close cleanly');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private prompt');
    expect(JSON.stringify(log.mock.calls)).not.toContain('/private/chat/path');
  });

  it.each([undefined, 'prior-session'])('registers callbacks once for create or resume (%s)', async (resumeNativeSessionId) => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', resumeNativeSessionId });
    expect(fake.configs).toHaveLength(1);
    const config = fake.configs[0];
    expect(config.enableConfigDiscovery).toBe(true);
    expect(config.hooks).toBeUndefined();
    expect(config.onEvent).toBeTypeOf('function');
    expect(config.onPermissionRequest).toBeTypeOf('function');
    expect(await config.onPermissionRequest({ kind: 'write' })).toEqual({ kind: 'approve-once' });
    config.onEvent({ type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'view', arguments: {} } });
    const iterator = session.events[Symbol.asyncIterator]();
    const events = [];
    for (let i = 0; i < 8; i++) {
      const next = await iterator.next();
      events.push(next.value);
      if (next.value?.type === 'tool_call') break;
    }
    expect(events.filter((event) => event?.type === 'tool_call')).toHaveLength(1);
    expect(fake.create).toHaveBeenCalledTimes(resumeNativeSessionId ? 0 : 1);
    expect(fake.resume).toHaveBeenCalledTimes(resumeNativeSessionId ? 1 : 0);
  });

  it.each([undefined, 'prior-session'])('raises the tool search threshold to the ceiling on create and resume when the start loads all tools, without turning search on (#3615) (%s)', async (resumeNativeSessionId) => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', resumeNativeSessionId, loadAllTools: true });
    expect(fake.configs[0].toolSearch).toEqual({ deferThreshold: COPILOT_EAGER_TOOL_CEILING });
    expect(COPILOT_EAGER_TOOL_CEILING).toBe(120);
    await session.close();
  });

  it('leaves tool search to the CLI for any other start (#3615)', async () => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit' });
    expect(fake.configs[0]).not.toHaveProperty('toolSearch');
    await session.close();
  });

  it('keeps a lower default\'s search on and raises only its threshold (#3615)', async () => {
    const session = await new CopilotSdkChatDriver({ sessionDefaults: { toolSearch: { enabled: true } } }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', loadAllTools: true });
    expect(fake.configs[0].toolSearch).toEqual({ enabled: true, deferThreshold: COPILOT_EAGER_TOOL_CEILING });
    await session.close();
  });

  it('lets an explicit session override of tool search beat loading all tools (#3615)', async () => {
    const session = await new CopilotSdkChatDriver({ sessionOverrides: { toolSearch: { enabled: true } } }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', loadAllTools: true });
    expect(fake.configs[0].toolSearch).toEqual({ enabled: true });
    await session.close();
  });

  it('reports enabled loaded skills by name only, once per change, never a subagent\'s list (#2855)', async () => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: path.resolve('synthetic'), binaryPath: 'fake', level: 'auto_edit' });
    const config = fake.configs[0];
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    const loaded = { type: 'session.skills_loaded', data: { skills: [
      { name: 'review', enabled: true, description: 'd', source: 'project', userInvocable: true, path: path.resolve('secret-path', 'SKILL.md') },
      { name: 'off', enabled: false, description: 'd', source: 'project', userInvocable: true },
    ] } };
    config.onEvent(loaded);
    config.onEvent(loaded);
    config.onEvent({ ...loaded, agentId: 'sub-1', data: { skills: [{ name: 'sub-only', enabled: true, description: 'd', source: 'project', userInvocable: true }] } });
    config.onEvent({ type: 'session.skills_loaded', data: { skills: 'bad' } });
    config.onEvent({ type: 'session.idle', data: {} });
    await session.close();
    const reports: unknown[] = [];
    for await (const event of session.events) if (event.type === 'session_info' && event.data.providerInventory) reports.push(event.data.providerInventory);
    expect(reports).toEqual([
      { provider: 'copilot', driver: 'copilot_sdk', source: 'session.skills_loaded', nativeSessionId: 'fake-session', skills: ['review'] },
      { provider: 'copilot', driver: 'copilot_sdk', source: 'session.skills_loaded', nativeSessionId: 'fake-session', skills: null },
    ]);
    expect(JSON.stringify(reports)).not.toContain('secret-path');
  });

  it('reports a turn and the session as inclusive of subagent calls, keeping zeros and leaving unreported figures out', async () => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit' });
    const config = fake.configs[0];
    await session.send([{ type: 'text', text: 'go' }], 'prompt');
    config.onEvent({ type: 'assistant.usage', data: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } });
    config.onEvent({ type: 'assistant.usage', data: { inputTokens: 50, outputTokens: 5 } });
    config.onEvent({ type: 'session.idle', data: {} });
    const usage: Array<{ scope: string; coverage?: string; tokens?: Record<string, number> }> = [];
    const iterator = session.events[Symbol.asyncIterator]();
    for (let i = 0; i < 12; i++) {
      const next = await iterator.next();
      if (next.value?.type === 'usage') usage.push(next.value.data);
      if (next.value?.type === 'turn_ended') break;
    }
    expect(usage.map((u) => [u.scope, u.coverage])).toEqual([['turn', 'inclusive'], ['session', 'inclusive']]);
    expect(usage[0].tokens).toMatchObject({ input: 150, output: 15, cachedInput: 0, total: 165 });
    expect(usage[0].tokens).not.toHaveProperty('reasoning');
  });
});
