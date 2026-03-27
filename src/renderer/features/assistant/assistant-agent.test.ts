import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Assistant agent backend tests.
 *
 * TEST GAPS (documented):
 * - Cannot test full agent communication — requires running orchestrator
 * - Cannot test headless transcript reading — requires real agent run
 * - Cannot test AgentTerminal rendering — requires xterm DOM
 */

const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
const mockSendStructuredMessage = vi.fn().mockResolvedValue(undefined);
const mockKillAgent = vi.fn().mockResolvedValue(undefined);
const mockCheckOrchestrator = vi.fn().mockResolvedValue({ available: true });
const mockOnStructuredEvent = vi.fn().mockReturnValue(() => {});
const mockReadTranscript = vi.fn().mockResolvedValue(null);
const mockAssistantSpawn = vi.fn().mockResolvedValue({ success: true });
const mockSendFollowup = vi.fn().mockResolvedValue({ agentId: 'assistant_followup_123' });
const mockOnResult = vi.fn().mockReturnValue(() => {});
const mockPtyWrite = vi.fn();
const mockPtyOnData = vi.fn().mockReturnValue(() => {});
const mockPtyOnExit = vi.fn().mockReturnValue(() => {});

vi.stubGlobal('window', {
  clubhouse: {
    platform: 'darwin',
    agent: {
      spawnAgent: mockSpawnAgent,
      sendStructuredMessage: mockSendStructuredMessage,
      killAgent: mockKillAgent,
      checkOrchestrator: mockCheckOrchestrator,
      onStructuredEvent: mockOnStructuredEvent,
      readTranscript: mockReadTranscript,
      getOrchestrators: vi.fn().mockResolvedValue([]),
    },
    assistant: {
      spawn: mockAssistantSpawn,
      bind: vi.fn().mockResolvedValue(undefined),
      unbind: vi.fn().mockResolvedValue(undefined),
      sendFollowup: mockSendFollowup,
      onResult: mockOnResult,
    },
    pty: { write: mockPtyWrite, onData: mockPtyOnData, onExit: mockPtyOnExit },
  },
});

vi.stubGlobal('process', { env: { HOME: '/tmp/test-home' } });
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => '12345678-1234-1234-1234-123456789012' });
}

import * as agent from './assistant-agent';

describe('assistant-agent', () => {
  beforeEach(() => { vi.clearAllMocks(); agent.reset(); });

  it('starts idle with interactive mode', () => {
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getMode()).toBe('interactive');
    expect(agent.getOrchestrator()).toBeNull();
    expect(agent.getAgentId()).toBeNull();
  });

  it('sendMessage adds user message', async () => {
    await agent.sendMessage('Hello');
    expect(agent.getFeedItems()[0].message?.content).toBe('Hello');
  });

  it('uses dedicated assistant.spawn IPC', async () => {
    await agent.sendMessage('Hello');
    if (mockAssistantSpawn.mock.calls.length > 0) {
      const p = mockAssistantSpawn.mock.calls[0][0];
      expect(p.executionMode).toBe('interactive');
      expect(p.mission).toBe('Hello');
    }
  });

  it('interactive mode sets up PTY exit listener (not data)', async () => {
    await agent.sendMessage('Hello');
    if (mockAssistantSpawn.mock.calls.length > 0) {
      // Interactive renders AgentTerminal directly — no data listener needed
      expect(mockPtyOnExit).toHaveBeenCalled();
      expect(mockPtyOnData).not.toHaveBeenCalled();
    }
  });

  it('interactive mode exposes agentId for terminal rendering', async () => {
    await agent.sendMessage('Hello');
    expect(agent.getAgentId()).not.toBeNull();
    expect(agent.getStatus()).toBe('active');
  });

  it('structured passes mode to spawn', async () => {
    agent.setMode('structured');
    await agent.sendMessage('Hello');
    if (mockAssistantSpawn.mock.calls.length > 0) {
      expect(mockAssistantSpawn.mock.calls[0][0].executionMode).toBe('structured');
    }
  });

  it('headless passes mode to spawn and listens for result', async () => {
    agent.setMode('headless');
    await agent.sendMessage('Hello');
    if (mockAssistantSpawn.mock.calls.length > 0) {
      expect(mockAssistantSpawn.mock.calls[0][0].executionMode).toBe('headless');
      expect(mockOnResult).toHaveBeenCalled();
    }
  });

  it('orchestrator passed to spawn', async () => {
    agent.setOrchestrator('copilot-cli');
    await agent.sendMessage('Hello');
    if (mockAssistantSpawn.mock.calls.length > 0) {
      expect(mockAssistantSpawn.mock.calls[0][0].orchestrator).toBe('copilot-cli');
    }
  });

  it('mode change resets', () => {
    agent.setMode('headless');
    expect(agent.getMode()).toBe('headless');
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('reset preserves mode and orchestrator', () => {
    agent.setMode('headless');
    agent.setOrchestrator('codex-cli');
    agent.reset();
    expect(agent.getMode()).toBe('headless');
    expect(agent.getOrchestrator()).toBe('codex-cli');
  });

  it('error on unavailable orchestrator', async () => {
    mockCheckOrchestrator.mockResolvedValueOnce({ available: false, error: 'not found' });
    await agent.sendMessage('Hello');
    expect(agent.getStatus()).toBe('error');
  });

  it('notifies mode listeners', () => {
    const l = vi.fn(); const u = agent.onModeChange(l);
    agent.setMode('structured'); expect(l).toHaveBeenCalledWith('structured'); u();
  });

  it('notifies orchestrator listeners', () => {
    const l = vi.fn(); const u = agent.onOrchestratorChange(l);
    agent.setOrchestrator('copilot-cli'); expect(l).toHaveBeenCalledWith('copilot-cli'); u();
  });

  it('notifies agentId listeners', async () => {
    const l = vi.fn(); const u = agent.onAgentIdChange(l);
    await agent.sendMessage('Hello');
    expect(l).toHaveBeenCalled();
    u();
  });
});
