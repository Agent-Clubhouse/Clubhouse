import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActionCardData, ActionCardStatus, FeedItem } from './types';

// ── Extend window.clubhouse mock from setup-renderer.ts ──────────────────
// setup-renderer.ts already provides the full window.clubhouse mock.
// We only add test-specific methods not in the base mock.

const mockApproveToolExecution = vi.fn().mockResolvedValue(undefined);
const mockSkipToolExecution = vi.fn().mockResolvedValue(undefined);

(window.clubhouse.agent as any).approveToolExecution = mockApproveToolExecution;
(window.clubhouse.agent as any).skipToolExecution = mockSkipToolExecution;
if (!globalThis.crypto?.randomUUID) {
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => '12345678-1234-1234-1234-123456789012' });
}

import * as agent from './assistant-agent';
import { humanError, buildResultSummary } from './AssistantActionCard';
import { buildGroups, inferGroupLabel } from './AssistantFeed';

// ── humanError() Tests ──────────────────────────────────────────────────────

describe('humanError', () => {
  it('extracts message field from JSON', () => {
    expect(humanError('{"message": "Project already exists"}')).toBe('Project already exists');
  });

  it('extracts error field from JSON', () => {
    expect(humanError('{"error": "Not found"}')).toBe('Not found');
  });

  it('prefers message over error in JSON', () => {
    expect(humanError('{"message": "msg", "error": "err"}')).toBe('msg');
  });

  it('strips "Error: " prefix', () => {
    expect(humanError('Error: something went wrong')).toBe('something went wrong');
  });

  it('strips case-insensitive error prefix', () => {
    expect(humanError('error: bad request')).toBe('bad request');
  });

  it('truncates stack traces', () => {
    const withStack = 'Connection refused\n    at Socket.connect (net.js:1)\n    at Agent.createConnection';
    expect(humanError(withStack)).toBe('Connection refused');
  });

  it('caps output at 300 characters', () => {
    const long = 'x'.repeat(400);
    const result = humanError(long);
    expect(result.length).toBe(300);
    expect(result.endsWith('...')).toBe(true);
  });

  it('passes through plain strings unchanged', () => {
    expect(humanError('simple error')).toBe('simple error');
  });

  it('handles empty string', () => {
    expect(humanError('')).toBe('');
  });

  it('handles non-object JSON', () => {
    expect(humanError('"just a string"')).toBe('"just a string"');
  });
});

// ── buildResultSummary() Tests ──────────────────────────────────────────────

describe('buildResultSummary', () => {
  it('returns summary for completed creation tool with name in output', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'create_canvas', description: '', status: 'completed',
      output: '{"name": "My Board", "id": "canvas-1"}',
    };
    expect(buildResultSummary(action)).toBe('canvas "My Board" created');
  });

  it('uses title field if name is missing', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'create_project', description: '', status: 'completed',
      output: '{"title": "My Project"}',
    };
    expect(buildResultSummary(action)).toBe('project "My Project" created');
  });

  it('falls back to id field', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'add_card', description: '', status: 'completed',
      output: '{"id": "card-abc"}',
    };
    expect(buildResultSummary(action)).toBe('card "card-abc" created');
  });

  it('returns null for non-creation tools', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'search_help', description: '', status: 'completed',
      output: '{"results": []}',
    };
    expect(buildResultSummary(action)).toBeNull();
  });

  it('returns null for non-completed actions', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'create_canvas', description: '', status: 'running',
      output: '{"name": "Board"}',
    };
    expect(buildResultSummary(action)).toBeNull();
  });

  it('returns null when output is missing', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'create_canvas', description: '', status: 'completed',
    };
    expect(buildResultSummary(action)).toBeNull();
  });

  it('returns null for non-JSON output', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'create_canvas', description: '', status: 'completed',
      output: 'Created successfully',
    };
    expect(buildResultSummary(action)).toBeNull();
  });

  it('returns pre-set resultSummary if present', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'create_canvas', description: '', status: 'completed',
      resultSummary: 'custom summary',
    };
    expect(buildResultSummary(action)).toBe('custom summary');
  });

  it('strips create/add prefix for type label', () => {
    const action: ActionCardData = {
      id: '1', toolName: 'add_zone', description: '', status: 'completed',
      output: '{"name": "Zone A"}',
    };
    expect(buildResultSummary(action)).toBe('zone "Zone A" created');
  });
});

// ── inferGroupLabel() Tests ──────────────────────────────────────────────────

describe('inferGroupLabel', () => {
  function makeAction(toolName: string, id: string): FeedItem {
    return { type: 'action', action: { id, toolName, description: '', status: 'completed' } };
  }

  it('generates canvas label with card and wire counts', () => {
    const actions = [
      makeAction('create_canvas', '1'),
      makeAction('add_card', '2'),
      makeAction('add_card', '3'),
      makeAction('add_wire', '4'),
    ];
    expect(inferGroupLabel(actions)).toBe('Creating canvas with 2 cards, 1 wire');
  });

  it('generates canvas label with cards only', () => {
    const actions = [
      makeAction('create_canvas', '1'),
      makeAction('add_card', '2'),
    ];
    expect(inferGroupLabel(actions)).toBe('Creating canvas with 1 card');
  });

  it('generates canvas label with no cards or wires', () => {
    const actions = [
      makeAction('create_canvas', '1'),
      makeAction('add_zone', '2'),
    ];
    expect(inferGroupLabel(actions)).toBe('Creating canvas');
  });

  it('generates project setup label', () => {
    const actions = [
      makeAction('create_project', '1'),
      makeAction('create_agent', '2'),
      makeAction('create_agent', '3'),
    ];
    expect(inferGroupLabel(actions)).toBe('Setting up project (3 steps)');
  });

  it('generates generic label for unknown tool groups', () => {
    const actions = [
      makeAction('write_file', '1'),
      makeAction('write_file', '2'),
    ];
    expect(inferGroupLabel(actions)).toBe('2 related actions');
  });
});

// ── buildGroups() Tests ──────────────────────────────────────────────────────

describe('buildGroups', () => {
  function makeAction(id: string, groupId?: string): FeedItem {
    return {
      type: 'action',
      action: { id, toolName: 'create_canvas', description: '', status: 'completed', groupId },
    };
  }

  function makeMessage(id: string): FeedItem {
    return {
      type: 'message',
      message: { id, role: 'assistant', content: 'hello', timestamp: 1 },
    };
  }

  it('groups consecutive actions with same groupId', () => {
    const items = [makeAction('1', 'g1'), makeAction('2', 'g1'), makeAction('3', 'g1')];
    const result = buildGroups(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('group');
    const grouped = result[0] as any;
    expect(grouped.group.actionIds).toEqual(['1', '2', '3']);
  });

  it('does not group single-item groups', () => {
    const items = [makeAction('1', 'g1')];
    const result = buildGroups(items);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('group');
  });

  it('separates different groupIds', () => {
    const items = [makeAction('1', 'g1'), makeAction('2', 'g1'), makeAction('3', 'g2'), makeAction('4', 'g2')];
    const result = buildGroups(items);
    expect(result).toHaveLength(2);
    expect((result[0] as any).group.actionIds).toEqual(['1', '2']);
    expect((result[1] as any).group.actionIds).toEqual(['3', '4']);
  });

  it('passes through ungrouped items', () => {
    const items = [makeMessage('m1'), makeAction('a1'), makeMessage('m2')];
    const result = buildGroups(items);
    expect(result).toHaveLength(3);
    expect((result[0] as FeedItem).type).toBe('message');
    expect((result[1] as FeedItem).type).toBe('action');
    expect((result[2] as FeedItem).type).toBe('message');
  });

  it('interleaves messages and grouped actions correctly', () => {
    const items = [
      makeMessage('m1'),
      makeAction('a1', 'g1'),
      makeAction('a2', 'g1'),
      makeMessage('m2'),
      makeAction('a3'),
    ];
    const result = buildGroups(items);
    expect(result).toHaveLength(4); // message, group, message, action
    expect((result[0] as FeedItem).type).toBe('message');
    expect((result[1] as any).type).toBe('grouped');
    expect((result[2] as FeedItem).type).toBe('message');
    expect((result[3] as FeedItem).type).toBe('action');
  });

  it('computes group status from child statuses', () => {
    const items: FeedItem[] = [
      { type: 'action', action: { id: '1', toolName: 'add_card', description: '', status: 'completed', groupId: 'g1' } },
      { type: 'action', action: { id: '2', toolName: 'add_card', description: '', status: 'running', groupId: 'g1' } },
    ];
    const result = buildGroups(items);
    expect((result[0] as any).group.status).toBe('running');
  });

  it('group status is error when any child has error', () => {
    const items: FeedItem[] = [
      { type: 'action', action: { id: '1', toolName: 'add_card', description: '', status: 'completed', groupId: 'g1' } },
      { type: 'action', action: { id: '2', toolName: 'add_card', description: '', status: 'error', groupId: 'g1' } },
    ];
    const result = buildGroups(items);
    expect((result[0] as any).group.status).toBe('error');
  });

  it('group status is completed when all children complete', () => {
    const items: FeedItem[] = [
      { type: 'action', action: { id: '1', toolName: 'add_card', description: '', status: 'completed', groupId: 'g1' } },
      { type: 'action', action: { id: '2', toolName: 'add_card', description: '', status: 'completed', groupId: 'g1' } },
    ];
    const result = buildGroups(items);
    expect((result[0] as any).group.status).toBe('completed');
  });

  it('returns empty array for empty input', () => {
    expect(buildGroups([])).toEqual([]);
  });
});

// ── Approval Flow Tests ──────────────────────────────────────────────────────

describe('approval flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent.reset();
  });

  it('approveAction is a no-op for nonexistent action', () => {
    agent.approveAction('nonexistent-id');
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('skipAction is a no-op for nonexistent action', () => {
    agent.skipAction('nonexistent-id');
    expect(agent.getFeedItems()).toHaveLength(0);
  });

  it('exports approveAction and skipAction as functions', () => {
    expect(typeof agent.approveAction).toBe('function');
    expect(typeof agent.skipAction).toBe('function');
  });

  it('reset clears all feed items', async () => {
    agent.setMode('structured');
    await agent.sendMessage('test');
    expect(agent.getFeedItems().length).toBeGreaterThan(0);
    agent.reset();
    expect(agent.getFeedItems()).toHaveLength(0);
  });
});
