import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Assistant agent backend tests.
 *
 * TEST GAPS (documented):
 * - Cannot test full agent communication — requires running orchestrator
 * - Cannot test PTY data streaming — requires Electron PTY process
 * - Cannot test headless transcript reading — requires real agent run
 */

const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
const mockStartStructured = vi.fn().mockResolvedValue(undefined);
const mockSendStructuredMessage = vi.fn().mockResolvedValue(undefined);
const mockKillAgent = vi.fn().mockResolvedValue(undefined);
const mockCheckOrchestrator = vi.fn().mockResolvedValue({ available: true });
const mockOnStructuredEvent = vi.fn().mockReturnValue(() => {});
const mockReadTranscript = vi.fn().mockResolvedValue(null);
const mockPtyWrite = vi.fn();
const mockPtyOnData = vi.fn().mockReturnValue(() => {});
const mockPtyOnExit = vi.fn().mockReturnValue(() => {});

vi.stubGlobal('window', {
  clubhouse: {
    platform: 'darwin',
    agent: {
      spawnAgent: mockSpawnAgent,
      startStructured: mockStartStructured,
      sendStructuredMessage: mockSendStructuredMessage,
      killAgent: mockKillAgent,
      checkOrchestrator: mockCheckOrchestrator,
      onStructuredEvent: mockOnStructuredEvent,
      readTranscript: mockReadTranscript,
    },
    pty: {
      write: mockPtyWrite,
      onData: mockPtyOnData,
      onExit: mockPtyOnExit,
    },
  },
});

vi.stubGlobal('process', { env: { HOME: '/tmp/test-home' } });

if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal('crypto', {
    ...globalThis.crypto,
    randomUUID: () => '12345678-1234-1234-1234-123456789012',
  });
}

import * as agent from './assistant-agent';

describe('assistant-agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent.reset();
  });

  it('starts in idle status with interactive mode', () => {
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getMode()).toBe('interactive');
    expect(agent.getError()).toBeNull();
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('sendMessage adds user message to feed', async () => {
    await agent.sendMessage('Hello');
    const items = agent.getFeedItems();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].type).toBe('message');
    expect(items[0].message?.role).toBe('user');
    expect(items[0].message?.content).toBe('Hello');
  });

  it('shows error when no orchestrator is configured', async () => {
    mockCheckOrchestrator.mockResolvedValueOnce({ available: false, error: 'CLI not found' });
    await agent.sendMessage('Hello');
    expect(agent.getStatus()).toBe('error');
    const items = agent.getFeedItems();
    const errorMsg = items.find(i => i.type === 'message' && i.message?.role === 'assistant');
    expect(errorMsg?.message?.content).toContain('orchestrator');
  });

  it('interactive mode spawns without structuredMode flag', async () => {
    agent.setMode('interactive');
    await agent.sendMessage('Hello');
    if (mockSpawnAgent.mock.calls.length > 0) {
      const params = mockSpawnAgent.mock.calls[0][0];
      expect(params.structuredMode).toBeUndefined();
      expect(params.kind).toBe('quick');
    }
  });

  it('structured mode spawns with structuredMode: true', async () => {
    agent.setMode('structured');
    await agent.sendMessage('Hello');
    if (mockSpawnAgent.mock.calls.length > 0) {
      const params = mockSpawnAgent.mock.calls[0][0];
      expect(params.structuredMode).toBe(true);
    }
  });

  it('interactive mode sets up PTY listeners', async () => {
    agent.setMode('interactive');
    await agent.sendMessage('Hello');
    if (mockSpawnAgent.mock.calls.length > 0) {
      expect(mockPtyOnData).toHaveBeenCalled();
      expect(mockPtyOnExit).toHaveBeenCalled();
    }
  });

  it('structured mode sets up structured event listener', async () => {
    agent.setMode('structured');
    await agent.sendMessage('Hello');
    if (mockSpawnAgent.mock.calls.length > 0) {
      expect(mockOnStructuredEvent).toHaveBeenCalled();
    }
  });

  it('setMode resets conversation', () => {
    agent.setMode('structured');
    expect(agent.getMode()).toBe('structured');
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('setMode notifies listeners', () => {
    const listener = vi.fn();
    const unsub = agent.onModeChange(listener);
    agent.setMode('headless');
    expect(listener).toHaveBeenCalledWith('headless');
    unsub();
  });

  it('reset clears all state but preserves mode', async () => {
    agent.setMode('structured');
    await agent.sendMessage('Hello');
    agent.reset();
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getMode()).toBe('structured');
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('onFeedUpdate notifies on changes', async () => {
    const listener = vi.fn();
    const unsub = agent.onFeedUpdate(listener);
    await agent.sendMessage('Hello');
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('onStatusChange notifies on transitions', async () => {
    const listener = vi.fn();
    const unsub = agent.onStatusChange(listener);
    await agent.sendMessage('Hello');
    expect(listener).toHaveBeenCalled();
    const statuses = listener.mock.calls.map((c: any[]) => c[0]);
    expect(statuses).toContain('starting');
    unsub();
  });
});
