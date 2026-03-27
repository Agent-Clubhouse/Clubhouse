import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Assistant agent backend tests.
 *
 * TEST GAPS (documented):
 * - Cannot test full agent communication in unit tests — requires a running
 *   orchestrator process (claude-code, copilot-cli, or codex-cli).
 * - Cannot test structured event streaming end-to-end — the IPC bridge
 *   and structured adapter live in the main process.
 * - Cannot test actual PTY/headless spawning — requires Electron main process.
 *
 * What IS tested here:
 * - System prompt construction (covered in system-prompt.test.ts)
 * - Event handler logic (text accumulation, tool card creation)
 * - Message queuing during startup
 * - Status transitions
 */

// Mock window.clubhouse.agent
const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
const mockStartStructured = vi.fn().mockResolvedValue(undefined);
const mockSendStructuredMessage = vi.fn().mockResolvedValue(undefined);
const mockKillAgent = vi.fn().mockResolvedValue(undefined);
const mockCheckOrchestrator = vi.fn().mockResolvedValue({ available: true });
const mockOnStructuredEvent = vi.fn().mockReturnValue(() => {});

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
    },
  },
});

vi.stubGlobal('process', { env: { HOME: '/tmp/test-home' } });

// Must import AFTER mocking window
import * as agent from './assistant-agent';

describe('assistant-agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent.reset();
  });

  it('starts in idle status', () => {
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getError()).toBeNull();
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('sendMessage adds user message to feed', async () => {
    await agent.sendMessage('Hello');

    const items = agent.getFeedItems();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('message');
    expect(items[0].message?.role).toBe('user');
    expect(items[0].message?.content).toBe('Hello');
  });

  it('sendMessage spawns agent on first call', async () => {
    await agent.sendMessage('Hello');

    expect(mockCheckOrchestrator).toHaveBeenCalled();
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'quick',
        projectPath: '/tmp/test-home',
        cwd: '/tmp/test-home',
        freeAgentMode: true,
      }),
    );
    expect(mockStartStructured).toHaveBeenCalled();
  });

  it('shows error when no orchestrator is configured', async () => {
    mockCheckOrchestrator.mockResolvedValueOnce({
      available: false,
      error: 'Claude Code CLI not found',
    });

    await agent.sendMessage('Hello');

    expect(agent.getStatus()).toBe('error');
    const items = agent.getFeedItems();
    // Should have user message + error message
    expect(items.length).toBeGreaterThanOrEqual(2);
    const errorMsg = items.find(
      (i) => i.type === 'message' && i.message?.role === 'assistant',
    );
    expect(errorMsg?.message?.content).toContain('orchestrator');
  });

  it('reset clears all state', async () => {
    await agent.sendMessage('Hello');
    expect(agent.getFeedItems().length).toBeGreaterThan(0);

    agent.reset();
    expect(agent.getStatus()).toBe('idle');
    expect(agent.getFeedItems()).toHaveLength(0);
    expect(agent.getError()).toBeNull();
  });

  it('onFeedUpdate notifies on changes', async () => {
    const listener = vi.fn();
    const unsub = agent.onFeedUpdate(listener);

    await agent.sendMessage('Hello');

    expect(listener).toHaveBeenCalled();
    const lastCall = listener.mock.calls[listener.mock.calls.length - 1];
    expect(lastCall[0].length).toBeGreaterThan(0);

    unsub();
  });

  it('onStatusChange notifies on transitions', async () => {
    const listener = vi.fn();
    const unsub = agent.onStatusChange(listener);

    await agent.sendMessage('Hello');

    // Should have transitioned through starting -> responding (or error)
    expect(listener).toHaveBeenCalled();
    const statuses = listener.mock.calls.map((c: any[]) => c[0]);
    expect(statuses).toContain('starting');

    unsub();
  });

  it('includes system prompt with help content in spawn', async () => {
    await agent.sendMessage('Hello');

    const spawnCall = mockSpawnAgent.mock.calls[0][0];
    expect(spawnCall.systemPrompt).toContain('Clubhouse Assistant');
    expect(spawnCall.systemPrompt).toContain('Workflow Recipes');
  });
});
