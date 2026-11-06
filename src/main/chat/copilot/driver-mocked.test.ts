/** Contract test: no CLI, socket, model, auth service, or real SDK is started. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { CopilotSdkChatDriver } from './driver';

const sdkSession = () => ({
  sessionId: 'fake-session',
  rpc: { mode: { set: async () => {} }, model: { getCurrent: async () => ({ modelId: 'fake' }) }, commands: { list: async () => ({ commands: [] }) } },
  disconnect: async () => {},
});

beforeEach(() => {
  fake.configs.length = 0;
  fake.launch.mockReset().mockResolvedValue({ uri: 'fake', connectionToken: 'fake', exited: new Promise(() => {}), kill: async () => {}, stderrTail: () => '', exitCode: () => null });
  fake.create.mockReset().mockImplementation(async (config) => { fake.configs.push(config); return sdkSession(); });
  fake.resume.mockReset().mockImplementation(async (_id, config) => { fake.configs.push(config); return sdkSession(); });
});

describe('Copilot SDK callback wiring with fake transport', () => {
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
});
