import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches them
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../../agent-exit-broadcast', () => ({
  onAgentExit: vi.fn().mockReturnValue(() => {}),
  broadcastAgentExit: vi.fn(),
}));

vi.mock('../../../shared/agent-id', () => ({
  generateQuickAgentId: vi.fn().mockReturnValue('quick-test-123'),
}));

vi.mock('../../../shared/name-generator', () => ({
  generateQuickName: vi.fn().mockReturnValue('test-agent'),
}));

// --- Domain mocks (the four direct dependencies of agent-queue-tools) ------

const mockRegistryGet = vi.fn();
vi.mock('../../agent-queue-registry', () => ({
  agentQueueRegistry: {
    get: (...args: unknown[]) => mockRegistryGet(...args),
    _resetForTesting: vi.fn(),
  },
}));

const mockGetTask = vi.fn();
const mockListTaskSummaries = vi.fn();
const mockGetStatusCounts = vi.fn();
vi.mock('../../agent-queue-task-store', () => ({
  agentQueueTaskStore: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
    listTaskSummaries: (...args: unknown[]) => mockListTaskSummaries(...args),
    getStatusCounts: (...args: unknown[]) => mockGetStatusCounts(...args),
  },
}));

const mockEnqueueTask = vi.fn();
const mockCancelTask = vi.fn();
vi.mock('../../agent-queue-runner', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { registerAgentQueueTools } from './agent-queue-tools';
import {
  getScopedToolList,
  callTool,
  buildToolName,
  _resetForTesting as resetToolRegistry,
} from '../tool-registry';
import { bindingManager } from '../binding-manager';
import type { McpBinding } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shortcut to build a binding targeting an agent-queue. */
function makeBinding(
  overrides: Partial<McpBinding> & { agentId: string; targetId: string },
): McpBinding {
  return { label: 'Test Queue', targetKind: 'agent-queue', targetName: 'Test Queue', ...overrides };
}

/** Parse the JSON body from a tool result. */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0]?.text;
  if (!text) throw new Error('No text in result');
  try {
    return JSON.parse(text);
  } catch {
    return text; // plain-text error messages
  }
}

// ---------------------------------------------------------------------------
// A fixed binding used across all tests
// ---------------------------------------------------------------------------

const QUEUE_ID = 'aq_test_queue_001';
const AGENT_ID = 'agent-caller-1';

const binding = makeBinding({
  agentId: AGENT_ID,
  targetId: QUEUE_ID,
  targetName: 'Test Queue',
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AgentQueueTools', () => {
  beforeEach(() => {
    // Reset registries
    resetToolRegistry();
    bindingManager._resetForTesting();

    // Re-register templates each test
    registerAgentQueueTools();

    // Create the binding so tools are scoped for this agent
    bindingManager.bind(AGENT_ID, {
      targetId: QUEUE_ID,
      targetKind: 'agent-queue',
      label: 'Test Queue',
      targetName: 'Test Queue',
    });

    // Reset all mocks
    mockRegistryGet.mockReset();
    mockGetTask.mockReset();
    mockListTaskSummaries.mockReset();
    mockGetStatusCounts.mockReset();
    mockEnqueueTask.mockReset();
    mockCancelTask.mockReset();
  });

  /** Helper: get the full tool name for a suffix on our binding. */
  function toolName(suffix: string): string {
    return buildToolName(binding, suffix);
  }

  // =========================================================================
  // Registration
  // =========================================================================

  it('registers 5 tools for the agent-queue binding', () => {
    const tools = getScopedToolList(AGENT_ID);
    expect(tools).toHaveLength(5);

    const suffixes = tools.map(t => t.name.split('__').pop());
    expect(suffixes).toContain('invoke');
    expect(suffixes).toContain('get_output');
    expect(suffixes).toContain('list');
    expect(suffixes).toContain('cancel');
    expect(suffixes).toContain('get_queue_info');
  });

  // =========================================================================
  // invoke
  // =========================================================================

  describe('invoke', () => {
    it('succeeds with a valid mission', async () => {
      mockRegistryGet.mockResolvedValue({ id: QUEUE_ID, name: 'Test Queue' });
      mockEnqueueTask.mockResolvedValue({ id: 'task-001', status: 'pending' });

      const result = await callTool(AGENT_ID, toolName('invoke'), { mission: 'Do something important' });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.taskId).toBe('task-001');
      expect(body.status).toBe('pending');
      expect(body.queueName).toBe('Test Queue');
      expect(body.message).toContain('get_output');

      expect(mockEnqueueTask).toHaveBeenCalledWith(QUEUE_ID, 'Do something important');
    });

    it('rejects empty/falsy mission', async () => {
      const result = await callTool(AGENT_ID, toolName('invoke'), { mission: '' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('mission is required.');
    });

    it('returns error when queue not found', async () => {
      mockRegistryGet.mockResolvedValue(null);

      const result = await callTool(AGENT_ID, toolName('invoke'), { mission: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain(QUEUE_ID);
    });

    it('returns error when enqueue throws', async () => {
      mockRegistryGet.mockResolvedValue({ id: QUEUE_ID, name: 'Test Queue' });
      mockEnqueueTask.mockRejectedValue(new Error('concurrency limit reached'));

      const result = await callTool(AGENT_ID, toolName('invoke'), { mission: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to enqueue task');
      expect(result.content[0].text).toContain('concurrency limit reached');
    });
  });

  // =========================================================================
  // get_output
  // =========================================================================

  describe('get_output', () => {
    it('returns task data for completed task with summary', async () => {
      mockGetTask.mockResolvedValue({
        id: 'task-001',
        status: 'completed',
        mission: 'Analyse logs',
        agentName: 'quick-agent-1',
        createdAt: 1000,
        startedAt: 1100,
        completedAt: 1500,
        exitCode: 0,
        durationMs: 400,
        filesModified: ['a.ts'],
        errorMessage: null,
        summary: 'Found 3 issues.',
        detail: null,
      });

      const result = await callTool(AGENT_ID, toolName('get_output'), { task_id: 'task-001' });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.taskId).toBe('task-001');
      expect(body.status).toBe('completed');
      expect(body.summary).toBe('Found 3 issues.');
      expect(body).not.toHaveProperty('detail');
      expect(body).not.toHaveProperty('hasDetail');
    });

    it('includes detail when include_detail=true', async () => {
      mockGetTask.mockResolvedValue({
        id: 'task-002',
        status: 'completed',
        mission: 'Deep analysis',
        agentName: 'quick-agent-2',
        createdAt: 2000,
        startedAt: 2100,
        completedAt: 2900,
        exitCode: 0,
        durationMs: 800,
        filesModified: [],
        errorMessage: null,
        summary: 'Summary here.',
        detail: 'Full detailed output spanning several paragraphs...',
      });

      const result = await callTool(AGENT_ID, toolName('get_output'), {
        task_id: 'task-002',
        include_detail: true,
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.detail).toBe('Full detailed output spanning several paragraphs...');
      expect(body).not.toHaveProperty('hasDetail');
      expect(body).not.toHaveProperty('detailHint');
    });

    it('shows hasDetail hint when detail exists but not requested', async () => {
      mockGetTask.mockResolvedValue({
        id: 'task-003',
        status: 'completed',
        mission: 'Quick scan',
        agentName: 'quick-agent-3',
        createdAt: 3000,
        startedAt: 3100,
        completedAt: 3200,
        exitCode: 0,
        durationMs: 100,
        filesModified: [],
        errorMessage: null,
        summary: 'All good.',
        detail: 'Very long detail...',
      });

      const result = await callTool(AGENT_ID, toolName('get_output'), { task_id: 'task-003' });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.hasDetail).toBe(true);
      expect(body.detailHint).toContain('include_detail=true');
      expect(body).not.toHaveProperty('detail');
    });

    it('rejects falsy task_id', async () => {
      const result = await callTool(AGENT_ID, toolName('get_output'), { task_id: '' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('task_id is required.');
    });

    it('returns error when task not found', async () => {
      mockGetTask.mockResolvedValue(null);

      const result = await callTool(AGENT_ID, toolName('get_output'), { task_id: 'nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('nonexistent');
    });
  });

  // =========================================================================
  // list
  // =========================================================================

  describe('list', () => {
    it('returns all tasks with counts', async () => {
      const summaries = [
        { id: 't1', status: 'completed', mission: 'A' },
        { id: 't2', status: 'pending', mission: 'B' },
        { id: 't3', status: 'running', mission: 'C' },
      ];
      const counts = { pending: 1, running: 1, completed: 1, failed: 0, cancelled: 0 };

      mockListTaskSummaries.mockResolvedValue(summaries);
      mockGetStatusCounts.mockResolvedValue(counts);

      const result = await callTool(AGENT_ID, toolName('list'), {});

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.counts).toEqual(counts);
      expect(body.tasks).toEqual(summaries);

      expect(mockListTaskSummaries).toHaveBeenCalledWith(QUEUE_ID);
      expect(mockGetStatusCounts).toHaveBeenCalledWith(QUEUE_ID);
    });

    it('filters by status_filter', async () => {
      const allSummaries = [
        { id: 't1', status: 'completed', mission: 'A' },
        { id: 't2', status: 'pending', mission: 'B' },
        { id: 't3', status: 'completed', mission: 'C' },
      ];
      const counts = { pending: 1, running: 0, completed: 2, failed: 0, cancelled: 0 };

      mockListTaskSummaries.mockResolvedValue(allSummaries);
      mockGetStatusCounts.mockResolvedValue(counts);

      const result = await callTool(AGENT_ID, toolName('list'), { status_filter: 'completed' });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as { tasks: Array<{ status: string }>; counts: Record<string, number> };
      // Only completed tasks should remain after filter
      expect(body.tasks).toHaveLength(2);
      for (const task of body.tasks) {
        expect(task.status).toBe('completed');
      }
      // Counts are unfiltered
      expect(body.counts).toEqual(counts);
    });
  });

  // =========================================================================
  // cancel
  // =========================================================================

  describe('cancel', () => {
    it('succeeds for pending task', async () => {
      mockCancelTask.mockResolvedValue(true);

      const result = await callTool(AGENT_ID, toolName('cancel'), { task_id: 'task-cancel-1' });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.cancelled).toBe(true);
      expect(body.taskId).toBe('task-cancel-1');

      expect(mockCancelTask).toHaveBeenCalledWith(QUEUE_ID, 'task-cancel-1');
    });

    it('returns error when cancel fails', async () => {
      mockCancelTask.mockResolvedValue(false);

      const result = await callTool(AGENT_ID, toolName('cancel'), { task_id: 'task-running-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot cancel');
      expect(result.content[0].text).toContain('task-running-1');
    });

    it('rejects falsy task_id', async () => {
      const result = await callTool(AGENT_ID, toolName('cancel'), { task_id: '' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('task_id is required.');
    });
  });

  // =========================================================================
  // get_queue_info
  // =========================================================================

  describe('get_queue_info', () => {
    it('returns queue info with counts', async () => {
      const queueConfig = {
        id: QUEUE_ID,
        name: 'Test Queue',
        concurrency: 3,
        projectId: 'proj-1',
        model: 'claude-sonnet-4-20250514',
        orchestrator: 'claude-code',
        autoWorktree: true,
        freeAgentMode: false,
      };
      const counts = { pending: 2, running: 1, completed: 5, failed: 0, cancelled: 1 };

      mockRegistryGet.mockResolvedValue(queueConfig);
      mockGetStatusCounts.mockResolvedValue(counts);

      const result = await callTool(AGENT_ID, toolName('get_queue_info'), {});

      expect(result.isError).toBeFalsy();
      const body = parseResult(result) as Record<string, unknown>;
      expect(body.id).toBe(QUEUE_ID);
      expect(body.name).toBe('Test Queue');
      expect(body.concurrency).toBe(3);
      expect(body.projectId).toBe('proj-1');
      expect(body.model).toBe('claude-sonnet-4-20250514');
      expect(body.orchestrator).toBe('claude-code');
      expect(body.autoWorktree).toBe(true);
      expect(body.freeAgentMode).toBe(false);
      expect(body.taskCounts).toEqual(counts);

      expect(mockRegistryGet).toHaveBeenCalledWith(QUEUE_ID);
      expect(mockGetStatusCounts).toHaveBeenCalledWith(QUEUE_ID);
    });

    it('returns error when queue not found', async () => {
      mockRegistryGet.mockResolvedValue(null);

      const result = await callTool(AGENT_ID, toolName('get_queue_info'), {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain(QUEUE_ID);
    });
  });
});
