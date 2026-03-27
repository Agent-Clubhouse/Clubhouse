import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { buildToolName, buildToolKey, parseToolName, shortHash, _resetForTesting as resetToolRegistry } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import { agentQueueRegistry } from '../../agent-queue-registry';
import type { McpBinding } from '../types';

function makeBinding(overrides: Partial<McpBinding> & { agentId: string; targetId: string; targetKind: McpBinding['targetKind'] }): McpBinding {
  return { label: 'Test', ...overrides };
}

describe('Agent Queue Tool Names', () => {
  beforeEach(() => {
    resetToolRegistry();
    bindingManager._resetForTesting();
    agentQueueRegistry._resetForTesting();
  });

  it('builds tool key with name and hash for agent-queue targets', () => {
    const binding = makeBinding({
      agentId: 'a1',
      targetId: 'aq_123_abc',
      targetKind: 'agent-queue',
      targetName: 'My Queue',
    });
    const key = buildToolKey(binding);
    expect(key).toBe(`My_Queue_${shortHash('aq_123_abc')}`);
  });

  it('builds queue-prefixed tool name for agent-queue targets', () => {
    const binding = makeBinding({
      agentId: 'a1',
      targetId: 'aq_123_abc',
      targetKind: 'agent-queue',
      targetName: 'My Queue',
    });
    const name = buildToolName(binding, 'invoke');
    expect(name).toBe(`queue__My_Queue_${shortHash('aq_123_abc')}__invoke`);
  });

  it('parses queue-prefixed tool names', () => {
    const parsed = parseToolName('queue__My_Queue_abcd__invoke');
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe('queue');
    expect(parsed!.toolKey).toBe('My_Queue_abcd');
    expect(parsed!.suffix).toBe('invoke');
  });

  it('parses queue tool names for all suffixes', () => {
    for (const suffix of ['invoke', 'get_output', 'list', 'cancel', 'get_queue_info']) {
      const parsed = parseToolName(`queue__test_1234__${suffix}`);
      expect(parsed).not.toBeNull();
      expect(parsed!.suffix).toBe(suffix);
    }
  });
});
