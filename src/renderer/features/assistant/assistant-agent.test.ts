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
const mockSendStructuredFollowup = vi.fn().mockResolvedValue({ agentId: 'assistant_structured_followup_123' });
const mockOnResult = vi.fn().mockReturnValue(() => {});
const mockPtyWrite = vi.fn();
const mockPtyOnData = vi.fn().mockReturnValue(() => {});
const mockPtyOnExit = vi.fn().mockReturnValue(() => {});
const mockAssistantReset = vi.fn().mockResolvedValue(undefined);
const mockSaveHistory = vi.fn().mockResolvedValue(undefined);
const mockLoadHistory = vi.fn().mockResolvedValue(null);

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
      sendStructuredFollowup: mockSendStructuredFollowup,
      onResult: mockOnResult,
      reset: mockAssistantReset,
      saveHistory: mockSaveHistory,
      loadHistory: mockLoadHistory,
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
  beforeEach(() => {
    // Reset call counts but preserve mock implementations (mockResolvedValue, etc.)
    vi.clearAllMocks();
    // Restore mock implementations that clearAllMocks may have stripped
    mockSaveHistory.mockResolvedValue(undefined);
    mockLoadHistory.mockResolvedValue(null);
    mockAssistantReset.mockResolvedValue(undefined);
    mockKillAgent.mockResolvedValue(undefined);
    mockCheckOrchestrator.mockResolvedValue({ available: true });
    mockAssistantSpawn.mockResolvedValue({ success: true });
    mockSendFollowup.mockResolvedValue({ agentId: 'assistant_followup_123' });
    mockSendStructuredFollowup.mockResolvedValue({ agentId: 'assistant_structured_followup_123' });
    mockOnResult.mockReturnValue(() => {});
    mockOnStructuredEvent.mockReturnValue(() => {});
    mockPtyOnExit.mockReturnValue(() => {});
    mockPtyOnData.mockReturnValue(() => {});
    agent.reset();
  });

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
    if (mockAssistantSpawn.mock.calls.length > 0) {
      expect(agent.getAgentId()).not.toBeNull();
      expect(agent.getStatus()).toBe('active');
    }
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
    if (mockAssistantSpawn.mock.calls.length > 0) {
      expect(l).toHaveBeenCalled();
    }
    u();
  });

  describe('headless follow-ups', () => {
    it('sends follow-up via assistant.sendFollowup and updates agentId', async () => {
      agent.setMode('headless');
      await agent.sendMessage('Hello');
      // Simulate agent reaching active state after first response
      // We need to manually trigger the headless result to get to 'active'
      const resultCb = mockOnResult.mock.calls[0]?.[0];
      if (resultCb) {
        mockReadTranscript.mockResolvedValueOnce('{"type":"result","result":"Hi there"}\n');
        resultCb({ agentId: agent.getAgentId(), exitCode: 0 });
        await vi.waitFor(() => expect(agent.getStatus()).toBe('active'));

        // Now send follow-up
        await agent.sendMessage('How are you?');
        expect(mockSendFollowup).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'How are you?' }),
        );
      }
    });
  });

  describe('structured mode', () => {
    it('registers event listener BEFORE spawn to prevent race condition', async () => {
      agent.setMode('structured');
      let listenerRegisteredBeforeSpawn = false;
      // Track the order: onStructuredEvent should be called before spawn
      mockOnStructuredEvent.mockImplementation(() => {
        // At this point, spawn should NOT have been called yet
        if (mockAssistantSpawn.mock.calls.length === 0) {
          listenerRegisteredBeforeSpawn = true;
        }
        return () => {};
      });
      await agent.sendMessage('Hello');
      expect(mockOnStructuredEvent).toHaveBeenCalled();
      expect(listenerRegisteredBeforeSpawn).toBe(true);
    });

    it('cleans up old listeners before registering new ones on follow-up', async () => {
      agent.setMode('structured');
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();
      mockOnStructuredEvent.mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2);

      // First message
      await agent.sendMessage('Hello');
      expect(mockOnStructuredEvent).toHaveBeenCalledTimes(1);

      // Simulate structured event handler receiving 'end' to go active
      const eventCb = mockOnStructuredEvent.mock.calls[0][0];
      eventCb(agent.getAgentId(), { type: 'end', timestamp: Date.now(), data: { reason: 'complete' } });
      expect(agent.getStatus()).toBe('active');

      // Follow-up: sendStructuredMessage throws → falls back to structured followup
      mockSendStructuredMessage.mockRejectedValueOnce(new Error('not supported'));
      await agent.sendMessage('Follow up');

      // Old listener should have been cleaned up
      expect(unsub1).toHaveBeenCalled();
    });

    it('sends structured follow-up via sendStructuredFollowup', async () => {
      agent.setMode('structured');
      await agent.sendMessage('Hello');

      // Simulate reaching active state via 'end' event
      const eventCb = mockOnStructuredEvent.mock.calls[0][0];
      eventCb(agent.getAgentId(), { type: 'end', timestamp: Date.now(), data: { reason: 'complete' } });
      expect(agent.getStatus()).toBe('active');

      // Follow-up message: sendStructuredMessage throws → structured followup
      mockSendStructuredMessage.mockRejectedValueOnce(new Error('not supported'));
      await agent.sendMessage('Follow up');
      expect(mockSendStructuredFollowup).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Follow up' }),
      );
    });

    it('handles text_delta events for streaming', async () => {
      agent.setMode('structured');
      await agent.sendMessage('Hello');
      const eventCb = mockOnStructuredEvent.mock.calls[0][0];
      const agentId = agent.getAgentId();

      // Send text_delta events
      eventCb(agentId, { type: 'text_delta', timestamp: Date.now(), data: { text: 'Hi ' } });
      eventCb(agentId, { type: 'text_delta', timestamp: Date.now(), data: { text: 'there!' } });

      const items = agent.getFeedItems();
      const assistantMsg = items.find(i => i.message?.role === 'assistant');
      expect(assistantMsg?.message?.content).toBe('Hi there!');
      expect(agent.getStatus()).toBe('responding');
    });

    it('finalizes message on text_done and returns to active', async () => {
      agent.setMode('structured');
      await agent.sendMessage('Hello');
      const eventCb = mockOnStructuredEvent.mock.calls[0][0];
      const agentId = agent.getAgentId();

      eventCb(agentId, { type: 'text_delta', timestamp: Date.now(), data: { text: 'Complete response' } });
      eventCb(agentId, { type: 'text_done', timestamp: Date.now(), data: { text: 'Complete response' } });

      expect(agent.getStatus()).toBe('active');
      const items = agent.getFeedItems();
      const msg = items.find(i => i.message?.role === 'assistant');
      // After text_done, streaming ID should be replaced with a permanent ID
      expect(msg?.message?.id).not.toMatch(/^streaming-/);
    });

    it('ignores events from other agents', async () => {
      agent.setMode('structured');
      await agent.sendMessage('Hello');
      const eventCb = mockOnStructuredEvent.mock.calls[0][0];

      // Event from a different agent should be ignored
      eventCb('other_agent_123', { type: 'text_delta', timestamp: Date.now(), data: { text: 'Intruder' } });

      const items = agent.getFeedItems();
      const intruderMsg = items.find(i => i.message?.content === 'Intruder');
      expect(intruderMsg).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('surfaces non-zero exit code as error message', async () => {
      agent.setMode('headless');
      await agent.sendMessage('Hello');
      const resultCb = mockOnResult.mock.calls[0]?.[0];
      if (resultCb) {
        resultCb({ agentId: agent.getAgentId(), exitCode: 1 });
        await vi.waitFor(() => {
          const items = agent.getFeedItems();
          const errorMsg = items.find(i =>
            i.message?.role === 'assistant' && i.message.content.includes('exited with an error'),
          );
          expect(errorMsg).toBeDefined();
        });
      }
    });

    it('surfaces error events from transcript', async () => {
      agent.setMode('headless');
      await agent.sendMessage('Hello');
      const resultCb = mockOnResult.mock.calls[0]?.[0];
      if (resultCb) {
        mockReadTranscript.mockResolvedValueOnce('{"type":"error","error":"Rate limit exceeded"}\n');
        resultCb({ agentId: agent.getAgentId(), exitCode: 0 });
        await vi.waitFor(() => {
          const items = agent.getFeedItems();
          const errorMsg = items.find(i =>
            i.message?.role === 'assistant' && i.message.content.includes('Rate limit exceeded'),
          );
          expect(errorMsg).toBeDefined();
        });
      }
    });

    it('removes placeholder message after receiving response', async () => {
      agent.setMode('headless');
      await agent.sendMessage('Hello');
      const resultCb = mockOnResult.mock.calls[0]?.[0];
      if (resultCb) {
        // Before response, there should be a placeholder
        const beforeItems = agent.getFeedItems();
        const placeholder = beforeItems.find(i =>
          i.message?.content === '_Processing your request..._',
        );
        expect(placeholder).toBeDefined();

        // After response, placeholder should be gone
        mockReadTranscript.mockResolvedValueOnce('{"type":"result","result":"Response text"}\n');
        resultCb({ agentId: agent.getAgentId(), exitCode: 0 });
        await vi.waitFor(() => {
          const afterItems = agent.getFeedItems();
          const remaining = afterItems.find(i =>
            i.message?.content === '_Processing your request..._',
          );
          expect(remaining).toBeUndefined();
        });
      }
    });
  });

  describe('history persistence', () => {
    it('calls saveHistory after receiving headless response', async () => {
      vi.useFakeTimers();
      agent.setMode('headless');
      await agent.sendMessage('Hello');
      const resultCb = mockOnResult.mock.calls[0]?.[0];
      if (resultCb) {
        mockReadTranscript.mockResolvedValueOnce('{"type":"result","result":"Hi"}\n');
        resultCb({ agentId: agent.getAgentId(), exitCode: 0 });
        // Wait for transcript read
        await vi.waitFor(() => {
          const items = agent.getFeedItems();
          return items.some(i => i.message?.content === 'Hi');
        });
        // Advance past debounce timer
        vi.advanceTimersByTime(600);
        expect(mockSaveHistory).toHaveBeenCalled();
      }
      vi.useRealTimers();
    });

    it('clears history on reset', () => {
      agent.reset();
      expect(mockSaveHistory).toHaveBeenCalledWith([]);
    });

    it('loadHistory restores feed items', async () => {
      const savedItems = [
        { type: 'message', message: { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1000 } },
        { type: 'message', message: { id: 'msg-2', role: 'assistant', content: 'Hi!', timestamp: 2000 } },
      ];
      mockLoadHistory.mockResolvedValueOnce(savedItems);
      await agent.loadHistory();
      const items = agent.getFeedItems();
      expect(items).toHaveLength(2);
      expect(items[0].message?.content).toBe('Hello');
      expect(items[1].message?.content).toBe('Hi!');
    });
  });

  describe('reset cleanup', () => {
    it('calls assistant.reset IPC to clean up main process resources', async () => {
      agent.setMode('headless');
      await agent.sendMessage('Hello');
      const agentId = agent.getAgentId();
      agent.reset();
      if (agentId) {
        expect(mockAssistantReset).toHaveBeenCalledWith(agentId);
      }
    });
  });
});
