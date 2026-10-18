import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  live: false,
  inflight: false,
  ptyRunning: false,
  config: null as null | { orchestrator?: string; runtimeMode?: 'chat' | 'terminal' },
  configError: null as Error | null,
  /** Providers with a chat driver. */
  drivers: new Set<string>(['claude-code', 'github-copilot']),
  /** Mode resolveRuntimeMode gives when the agent has no override (the flag and provider settings). */
  providerMode: 'chat' as 'chat' | 'terminal',
}));

vi.mock('./index', () => ({ isChatAgent: () => state.live }));
vi.mock('./chat-spawn', () => ({ hasChatStartInFlight: () => state.inflight }));
vi.mock('./chat-drivers', () => ({ resolveChatDriver: (p: string) => (state.drivers.has(p) ? { id: 'driver', provider: p } : undefined) }));
vi.mock('../pty-manager', () => ({ isRunning: () => state.ptyRunning }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-config', () => ({
  getDurableConfig: vi.fn(async () => {
    if (state.configError) throw state.configError;
    return state.config;
  }),
}));
vi.mock('../chat-runtime-settings', () => ({
  resolveRuntimeMode: (_provider: string, override?: 'chat' | 'terminal') => ({ mode: override ?? state.providerMode }),
}));

import { getAgentRuntimeInfo } from './runtime-info';
import { getDurableConfig } from '../agent-config';

const waking = { projectPath: '/work/proj', starting: true };

describe('getAgentRuntimeInfo (#2206)', () => {
  beforeEach(() => {
    Object.assign(state, { live: false, inflight: false, ptyRunning: false, config: null, configError: null, providerMode: 'chat' });
    state.drivers = new Set(['claude-code', 'github-copilot']);
    vi.mocked(getDurableConfig).mockClear();
  });

  it('is chat and live while a chat runtime runs the agent', async () => {
    state.live = true;
    expect(await getAgentRuntimeInfo('a1', 'claude-code')).toEqual({ chat: true, live: true, chatAvailable: true });
  });

  it('is chat, not live, while a chat start is in flight, even for older callers', async () => {
    state.inflight = true;
    expect(await getAgentRuntimeInfo('a1', 'claude-code')).toEqual({ chat: true, live: false, chatAvailable: true });
  });

  it('answers chat for a waking agent whose durable config resolves to chat', async () => {
    state.config = { orchestrator: 'github-copilot', runtimeMode: 'chat' };
    expect(await getAgentRuntimeInfo('a1', 'github-copilot', waking)).toEqual({ chat: true, live: false, chatAvailable: true });
    expect(getDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1');
  });

  it('uses the provider default when the agent has no override', async () => {
    state.config = { orchestrator: 'claude-code' };
    expect((await getAgentRuntimeInfo('a1', 'claude-code', waking)).chat).toBe(true);
    state.providerMode = 'terminal';
    expect((await getAgentRuntimeInfo('a1', 'claude-code', waking)).chat).toBe(false);
  });

  it('answers terminal for a waking terminal-mode agent', async () => {
    state.config = { orchestrator: 'claude-code', runtimeMode: 'terminal' };
    expect(await getAgentRuntimeInfo('a1', 'claude-code', waking)).toEqual({ chat: false, live: false, chatAvailable: true });
  });

  it('answers terminal when the provider has no chat driver', async () => {
    state.config = { orchestrator: 'codex-cli', runtimeMode: 'chat' };
    expect(await getAgentRuntimeInfo('a1', 'codex-cli', waking)).toEqual({ chat: false, live: false, chatAvailable: false });
  });

  it('answers terminal once a terminal runs it, so a chat start that fell back shows the terminal', async () => {
    state.config = { orchestrator: 'claude-code', runtimeMode: 'chat' };
    state.ptyRunning = true;
    expect((await getAgentRuntimeInfo('a1', 'claude-code', waking)).chat).toBe(false);
    expect(getDurableConfig).not.toHaveBeenCalled();
  });

  it('only reads the config while the agent is starting', async () => {
    state.config = { orchestrator: 'claude-code', runtimeMode: 'chat' };
    expect((await getAgentRuntimeInfo('a1', 'claude-code', { projectPath: '/work/proj', starting: false })).chat).toBe(false);
    expect((await getAgentRuntimeInfo('a1', 'claude-code')).chat).toBe(false);
    expect((await getAgentRuntimeInfo('a1', 'claude-code', { starting: true })).chat).toBe(false);
    expect(getDurableConfig).not.toHaveBeenCalled();
  });

  it('answers terminal when the agent or its config is missing', async () => {
    expect((await getAgentRuntimeInfo('a1', 'claude-code', waking)).chat).toBe(false);
    state.configError = new Error('unreadable');
    expect((await getAgentRuntimeInfo('a1', 'claude-code', waking)).chat).toBe(false);
  });
});
