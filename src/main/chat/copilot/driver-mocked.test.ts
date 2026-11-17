/** Contract test: no CLI, socket, model, auth service, or real SDK is started. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { ChatEventDraft } from '../../../shared/chat';

const fake = vi.hoisted(() => ({ configs: [] as any[], clients: [] as unknown[], launch: vi.fn(), create: vi.fn(), resume: vi.fn() }));
vi.mock('./launch', () => ({
  CopilotLaunchError: class extends Error {},
  launchCopilotServer: fake.launch,
}));
vi.mock('./sdk-loader', () => ({
  loadCopilotSdk: async () => ({
    RuntimeConnection: { forTcp: (host: string, port: number) => ({ kind: 'tcp', host, port }) },
    CopilotClient: class {
      constructor(options: unknown) { fake.clients.push(options); }
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
  fake.clients.length = 0;
  fake.launch.mockReset().mockImplementation(() => {
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    return { host: '127.0.0.1', port: 12345, connectionToken: 'fake', exited, kill: async () => exit(), stderrTail: () => '', exitCode: () => null };
  });
  fake.create.mockReset().mockImplementation(async (config) => { fake.configs.push(config); return sdkSession(); });
  fake.resume.mockReset().mockImplementation(async (_id, config) => { fake.configs.push(config); return sdkSession(); });
});

describe('Copilot SDK callback wiring with fake transport', () => {
  it('uses explicit TCP and coding-agent mode even when ambient SDK defaults request native hosting', async () => {
    const prior = process.env.COPILOT_SDK_DEFAULT_CONNECTION;
    process.env.COPILOT_SDK_DEFAULT_CONNECTION = 'inprocess';
    try {
      const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'installed-copilot', level: 'ask' });
      expect(fake.clients).toEqual([{ runtime: { kind: 'tcp', host: '127.0.0.1', port: 12345 }, mode: 'coding-agent', observability: { logLevel: 'error' } }]);
      await session.close();
    } finally {
      if (prior === undefined) delete process.env.COPILOT_SDK_DEFAULT_CONNECTION;
      else process.env.COPILOT_SDK_DEFAULT_CONNECTION = prior;
    }
  });

  it.each([undefined, 'prior-session'])('preserves grouped config, MCP, provider, saved model and context on create/resume (%s)', async (resumeNativeSessionId) => {
    const session = await new CopilotSdkChatDriver().start({
      agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'installed-copilot', level: 'ask', resumeNativeSessionId,
      model: 'saved-model', contextWindow: 'long_context',
      env: { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:0/v1', COPILOT_PROVIDER_MODEL_ID: 'base-model', COPILOT_PROVIDER_WIRE_MODEL: 'deployment', COPILOT_MODEL: 'env-model' },
      mcpServers: { local: { command: 'node', args: ['bridge.js'] } },
    });
    expect(fake.configs[0]).toMatchObject({
      model: 'saved-model', workingDirectory: '/synthetic', enableConfigDiscovery: true,
      events: { streaming: true, onEvent: expect.any(Function) },
      permissions: { onRequest: expect.any(Function) },
      interaction: { onUserInputRequest: expect.any(Function), onExitPlanModeRequest: expect.any(Function), onElicitationRequest: expect.any(Function) },
      inference: { contextTier: 'long_context', defaultProvider: 'clubhouse-env', providers: [{ name: 'clubhouse-env', baseUrl: 'http://127.0.0.1:0/v1' }], models: [{ id: 'saved-model', provider: 'clubhouse-env', modelId: 'base-model', wireModel: 'deployment' }] },
      github: { capi: { enabled: false } },
      mcp: { servers: { local: { type: 'stdio', command: 'node', args: ['bridge.js'] } } },
    });
    for (const removed of ['provider', 'streaming', 'contextTier', 'mcpServers', 'onEvent', 'onPermissionRequest', 'toolSearch']) expect(fake.configs[0]).not.toHaveProperty(removed);
    await session.close();
  });

  it.each([false, true])('carries BYOK model defaults through live switching, including existing resumed rows (%s)', async (exists) => {
    const list = vi.fn(async () => ({ list: exists ? [{ id: 'clubhouse-env/next-model' }] : [] }));
    const add = vi.fn(async () => ({}));
    const updateModel = vi.fn(async () => {});
    const setModel = vi.fn(async () => {});
    fake.create.mockImplementationOnce(async (config) => {
      fake.configs.push(config);
      const sdk = sdkSession();
      return { ...sdk, setModel, rpc: { ...sdk.rpc, model: { ...sdk.rpc.model, list }, provider: { add, updateModel } } };
    });
    const session = await new CopilotSdkChatDriver().start({
      agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'installed-copilot', level: 'ask', model: 'saved-model',
      env: { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:0', COPILOT_PROVIDER_MODEL_ID: 'base-model', COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '1000' },
    });
    await session.setModel('next-model');
    const definition = { id: 'next-model', provider: 'clubhouse-env', modelId: 'base-model', wireModel: 'base-model', maxPromptTokens: 1000 };
    if (exists) {
      expect(updateModel).toHaveBeenCalledWith({ model: definition });
      expect(add).not.toHaveBeenCalled();
    } else {
      expect(add).toHaveBeenCalledWith({ models: [definition] });
      expect(updateModel).not.toHaveBeenCalled();
    }
    expect(setModel).toHaveBeenCalledWith('next-model', undefined);
    await session.setModel('clubhouse-env/next-model');
    expect(list).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it.each(['empty_response', 'query'])('scrubs planted turn/system prompts from %s errors and exit stderr (#1919)', async (errorType) => {
    const prompt = `COPILOT-${errorType}-PRIVATE-TURN-1919`;
    const system = `COPILOT-${errorType}-PRIVATE-SYSTEM-1919`;
    let exit!: () => void;
    fake.launch.mockResolvedValue({ host: '127.0.0.1', port: 12345, connectionToken: 'fake', exited: new Promise<void>((r) => { exit = r; }), kill: async () => exit(), stderrTail: () => `warning: ${system} ${prompt}`, exitCode: () => 1 });
    const send = vi.fn(async () => 'message-1');
    fake.create.mockImplementationOnce(async (config) => { fake.configs.push(config); return { ...sdkSession(), send }; });
    const log = vi.fn();
    const session = await new CopilotSdkChatDriver({ log }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit' });
    await session.send([{ type: 'text', text: system }, { type: 'text', text: prompt }], 'prompt');
    fake.configs[0].events.onEvent({ type: 'session.error', data: { errorType, errorCode: errorType, message: `rejected: ${system} ${prompt}` } });
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
    config.events.onEvent({ type: 'session.error', data });
    config.events.onEvent({ type: 'session.idle', data: {} });
    // A later turn still works, and idle does not end the empty turn twice.
    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    config.events.onEvent({ type: 'assistant.message', data: { messageId: 'reply', content: 'Ready' } });
    config.events.onEvent({ type: 'session.idle', data: {} });
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
    fake.configs[0].events.onEvent({ type: 'session.error', data: { errorType: 'query', message: 'Something broke' } });
    await session.close();
    const events: ChatEventDraft[] = [];
    for await (const event of session.events) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', data: { code: 'unknown', message: 'Something broke', fatal: false } }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_ended', data: { stopReason: 'error' } }));
  });

  it('does not log SDK error content while closing for an update', async () => {
    let exited!: () => void;
    fake.launch.mockResolvedValue({
      host: '127.0.0.1', port: 12345, connectionToken: 'fake', exited: new Promise<void>((resolve) => { exited = resolve; }),
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
    expect(config.events.onEvent).toBeTypeOf('function');
    expect(config.permissions.onRequest).toBeTypeOf('function');
    expect(await config.permissions.onRequest({ kind: 'write' })).toEqual({ kind: 'approve-once' });
    config.events.onEvent({ type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'view', arguments: {} } });
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
    expect(fake.configs[0].tools?.search).toEqual({ deferThreshold: COPILOT_EAGER_TOOL_CEILING });
    expect(COPILOT_EAGER_TOOL_CEILING).toBe(120);
    await session.close();
  });

  it('leaves tool search to the CLI for any other start (#3615)', async () => {
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit' });
    expect(fake.configs[0]).not.toHaveProperty('tools.search');
    await session.close();
  });

  it('keeps a lower default\'s search on and raises only its threshold (#3615)', async () => {
    const session = await new CopilotSdkChatDriver({ sessionDefaults: { tools: { search: { enabled: true } } } }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', loadAllTools: true });
    expect(fake.configs[0].tools?.search).toEqual({ enabled: true, deferThreshold: COPILOT_EAGER_TOOL_CEILING });
    await session.close();
  });

  it('warns once when a start that loads every tool goes over the ceiling, with counts and no tool names (#3615)', async () => {
    let count = COPILOT_EAGER_TOOL_CEILING;
    const tool = (i: number) => ({ name: `secret_tool_${i}`, description: 'd' });
    // Search back on adds tool_search_tool to the list; the ceiling doesn't count it.
    const getCurrentMetadata = vi.fn(async () => ({ tools: [...Array.from({ length: count }, (_, i) => tool(i)), { name: 'tool_search_tool', description: 's' }] }));
    fake.create.mockImplementationOnce(async (config) => {
      fake.configs.push(config);
      const s = sdkSession();
      return { ...s, rpc: { ...s.rpc, tools: { getCurrentMetadata } } };
    });
    const log = vi.fn();
    const session = await new CopilotSdkChatDriver({ log }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', loadAllTools: true });
    const idle = async () => {
      fake.configs[0].events.onEvent({ type: 'session.idle', data: {} });
      await vi.waitFor(() => expect(getCurrentMetadata).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      getCurrentMetadata.mockClear();
    };
    const warned = () => log.mock.calls.filter(([level, message]) => level === 'warn' && String(message).includes('ceiling'));
    await idle();
    expect(warned()).toEqual([]);
    count = COPILOT_EAGER_TOOL_CEILING + 1;
    await idle();
    expect(warned()).toHaveLength(1);
    expect(warned()[0][2]).toEqual({ agentId: 'fixture', total: COPILOT_EAGER_TOOL_CEILING + 1, ceiling: COPILOT_EAGER_TOOL_CEILING });
    expect(JSON.stringify(warned())).not.toContain('secret_tool');
    expect(String(warned()[0][1])).toContain('#3641');
    fake.configs[0].events.onEvent({ type: 'session.idle', data: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(getCurrentMetadata).not.toHaveBeenCalled();
    expect(warned()).toHaveLength(1);
    await session.close();
  });

  it('never reads the tool count for a start that doesn\'t load every tool (#3615)', async () => {
    const getCurrentMetadata = vi.fn(async () => ({ tools: [] }));
    fake.create.mockImplementationOnce(async (config) => {
      fake.configs.push(config);
      const s = sdkSession();
      return { ...s, rpc: { ...s.rpc, tools: { getCurrentMetadata } } };
    });
    const session = await new CopilotSdkChatDriver().start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit' });
    fake.configs[0].events.onEvent({ type: 'session.idle', data: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(getCurrentMetadata).not.toHaveBeenCalled();
    await session.close();
  });

  it('lets an explicit session override of tool search beat loading all tools (#3615)', async () => {
    const session = await new CopilotSdkChatDriver({ sessionOverrides: { tools: { search: { enabled: true } } } }).start({ agentId: 'fixture', provider: 'copilot-cli', cwd: '/synthetic', binaryPath: 'fake', level: 'auto_edit', loadAllTools: true });
    expect(fake.configs[0].tools?.search).toEqual({ enabled: true });
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
    config.events.onEvent(loaded);
    config.events.onEvent(loaded);
    config.events.onEvent({ ...loaded, agentId: 'sub-1', data: { skills: [{ name: 'sub-only', enabled: true, description: 'd', source: 'project', userInvocable: true }] } });
    config.events.onEvent({ type: 'session.skills_loaded', data: { skills: 'bad' } });
    config.events.onEvent({ type: 'session.idle', data: {} });
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
    config.events.onEvent({ type: 'assistant.usage', data: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } });
    config.events.onEvent({ type: 'assistant.usage', data: { inputTokens: 50, outputTokens: 5 } });
    config.events.onEvent({ type: 'session.idle', data: {} });
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
