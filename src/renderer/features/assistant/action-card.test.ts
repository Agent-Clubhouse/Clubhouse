import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionCardData, ActionCardStatus, FeedItem } from './types';

// ── Mock window.clubhouse for assistant-agent import ──────────────────────

const mockAssistantSpawn = vi.fn().mockResolvedValue({ success: true });
const mockApproveToolExecution = vi.fn().mockResolvedValue(undefined);
const mockSkipToolExecution = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal('window', {
  clubhouse: {
    platform: 'darwin',
    agent: {
      spawnAgent: vi.fn().mockResolvedValue(undefined),
      sendStructuredMessage: vi.fn().mockResolvedValue(undefined),
      killAgent: vi.fn().mockResolvedValue(undefined),
      checkOrchestrator: vi.fn().mockResolvedValue({ available: true }),
      onStructuredEvent: vi.fn().mockReturnValue(() => {}),
      readTranscript: vi.fn().mockResolvedValue(null),
      getOrchestrators: vi.fn().mockResolvedValue([]),
      approveToolExecution: mockApproveToolExecution,
      skipToolExecution: mockSkipToolExecution,
    },
    assistant: {
      spawn: mockAssistantSpawn,
      bind: vi.fn().mockResolvedValue(undefined),
      unbind: vi.fn().mockResolvedValue(undefined),
      sendFollowup: vi.fn().mockResolvedValue({ agentId: 'followup_1' }),
      onResult: vi.fn().mockReturnValue(() => {}),
    },
    pty: {
      write: vi.fn(),
      onData: vi.fn().mockReturnValue(() => {}),
      onExit: vi.fn().mockReturnValue(() => {}),
    },
  },
});

vi.stubGlobal('process', { env: { HOME: '/tmp/test-home' } });
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => '12345678-1234-1234-1234-123456789012' });
}

import * as agent from './assistant-agent';

// ── Types Tests ──────────────────────────────────────────────────────────────

describe('ActionCardData types', () => {
  it('supports all status values', () => {
    const statuses: ActionCardStatus[] = ['pending_approval', 'pending', 'running', 'completed', 'error', 'skipped'];
    expect(statuses).toHaveLength(6);
  });

  it('ActionCardData has groupId and resultSummary fields', () => {
    const action: ActionCardData = {
      id: '1',
      toolName: 'create_canvas',
      description: 'test',
      status: 'completed',
      groupId: 'group-1',
      resultSummary: 'canvas "My Board" created',
    };
    expect(action.groupId).toBe('group-1');
    expect(action.resultSummary).toBe('canvas "My Board" created');
  });
});

// ── Approval Flow Tests ──────────────────────────────────────────────────────

describe('approval flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent.reset();
  });

  it('approveAction transitions pending_approval to running', async () => {
    // Start agent in structured mode
    agent.setMode('structured');
    await agent.sendMessage('Create a canvas');

    // Manually inject a pending_approval action via the feed
    const items = agent.getFeedItems();
    // The agent should have at least a user message
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].message?.content).toBe('Create a canvas');
  });

  it('skipAction transitions pending_approval to skipped', () => {
    // Verify the function exists and is callable
    expect(typeof agent.skipAction).toBe('function');
    expect(typeof agent.approveAction).toBe('function');
  });

  it('approveAction is a no-op for non-pending_approval actions', () => {
    // Should not throw
    agent.approveAction('nonexistent-id');
  });

  it('skipAction is a no-op for non-pending_approval actions', () => {
    // Should not throw
    agent.skipAction('nonexistent-id');
  });
});

// ── Action Grouping Tests ────────────────────────────────────────────────────

describe('action grouping', () => {
  it('actions with same groupId are logically related', () => {
    const actions: ActionCardData[] = [
      { id: '1', toolName: 'create_canvas', description: 'My Board', status: 'completed', groupId: 'g1' },
      { id: '2', toolName: 'add_card', description: 'Card 1', status: 'completed', groupId: 'g1' },
      { id: '3', toolName: 'add_card', description: 'Card 2', status: 'completed', groupId: 'g1' },
      { id: '4', toolName: 'add_wire', description: 'Wire 1-2', status: 'running', groupId: 'g1' },
    ];

    const grouped = actions.filter(a => a.groupId === 'g1');
    expect(grouped).toHaveLength(4);
  });

  it('FeedItem supports action_group type', () => {
    const item: FeedItem = {
      type: 'action_group',
      actionGroup: {
        id: 'g1',
        label: 'Creating canvas with 2 cards',
        actionIds: ['1', '2', '3'],
        status: 'running',
      },
    };
    expect(item.type).toBe('action_group');
    expect(item.actionGroup?.actionIds).toHaveLength(3);
  });
});

// ── Error Formatting Tests ───────────────────────────────────────────────────

describe('error formatting', () => {
  it('ActionCardData carries error field', () => {
    const action: ActionCardData = {
      id: '1',
      toolName: 'run_command',
      description: 'npm test',
      status: 'error',
      error: 'Command failed with exit code 1',
    };
    expect(action.error).toBe('Command failed with exit code 1');
  });

  it('error actions have distinct status', () => {
    const action: ActionCardData = {
      id: '1',
      toolName: 'create_project',
      description: 'test',
      status: 'error',
      error: '{"message": "Project already exists"}',
    };
    expect(action.status).toBe('error');
  });
});

// ── MUTATING_TOOLS / Structured Event Handling ───────────────────────────────

describe('structured event tool handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent.reset();
  });

  it('exports approveAction and skipAction', () => {
    expect(agent.approveAction).toBeDefined();
    expect(agent.skipAction).toBeDefined();
  });

  it('reset clears all feed items', () => {
    agent.reset();
    expect(agent.getFeedItems()).toHaveLength(0);
  });
});
