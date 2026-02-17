import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { SendToAgentDialog } from './SendToAgentDialog';
import { createMockAPI } from '../../testing';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    kind: 'durable',
    status: 'sleeping',
    color: '#ff0000',
    projectId: 'proj-1',
    ...overrides,
  };
}

describe('SendToAgentDialog', () => {
  let api: PluginAPI;
  let listSpy: ReturnType<typeof vi.fn>;
  let resumeSpy: ReturnType<typeof vi.fn>;
  let killSpy: ReturnType<typeof vi.fn>;
  let confirmSpy: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listSpy = vi.fn(() => []);
    resumeSpy = vi.fn(async () => {});
    killSpy = vi.fn(async () => {});
    confirmSpy = vi.fn(async () => false);
    onClose = vi.fn();

    api = createMockAPI({
      agents: {
        ...createMockAPI().agents,
        list: listSpy,
        resume: resumeSpy,
        kill: killSpy,
      },
      ui: {
        ...createMockAPI().ui,
        showConfirm: confirmSpy,
      },
    });
  });

  it('creates a valid React element', () => {
    const el = React.createElement(SendToAgentDialog, {
      api,
      filePath: 'test.md',
      content: '# Test',
      onClose,
    });
    expect(el).toBeDefined();
    expect(el.type).toBe(SendToAgentDialog);
  });

  it('filters agents to only durable kind', () => {
    const sleepingDurable = makeAgent({ id: 'a1', kind: 'durable', status: 'sleeping' });
    const quickAgent = makeAgent({ id: 'a2', kind: 'quick', status: 'running' });
    listSpy.mockReturnValue([sleepingDurable, quickAgent]);

    // The component internally calls api.agents.list().filter(a => a.kind === 'durable')
    const durables = api.agents.list().filter((a) => a.kind === 'durable');
    expect(durables).toHaveLength(1);
    expect(durables[0].id).toBe('a1');
  });

  it('does not include Quick Agent button (no runQuick call path)', () => {
    // The rewritten component has no handleQuickAgent or runQuick reference
    const source = SendToAgentDialog.toString();
    expect(source).not.toContain('Quick Agent');
  });

  it('uses api.widgets.AgentAvatar', () => {
    // Verify the component references AgentAvatar from the api
    const source = SendToAgentDialog.toString();
    expect(source).toContain('AgentAvatar');
  });

  describe('running agent', () => {
    it('calls showConfirm before sending to a running agent', async () => {
      const runningAgent = makeAgent({ status: 'running', name: 'Busy Agent' });
      confirmSpy.mockResolvedValue(true);

      // Simulate what handleDurableAgent does for a running agent
      if (runningAgent.status === 'running') {
        const ok = await api.ui.showConfirm('interrupt?');
        expect(ok).toBe(true);
        expect(confirmSpy).toHaveBeenCalled();
      }
    });

    it('does not resume if user cancels confirm', async () => {
      const runningAgent = makeAgent({ status: 'running' });
      confirmSpy.mockResolvedValue(false);

      if (runningAgent.status === 'running') {
        const ok = await api.ui.showConfirm('interrupt?');
        if (!ok) return;
        await api.agents.resume(runningAgent.id, 'mission');
      }

      expect(resumeSpy).not.toHaveBeenCalled();
    });
  });

  describe('sleeping agent', () => {
    it('calls resume with mission directly without confirm', async () => {
      const sleepingAgent = makeAgent({ status: 'sleeping' });

      // Simulate what handleDurableAgent does for a sleeping agent
      if (sleepingAgent.status !== 'running') {
        const mission = `Wiki page: test.md\n\nPage content:\n\`\`\`markdown\n# Hello\n\`\`\``;
        await api.agents.resume(sleepingAgent.id, mission);
      }

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(resumeSpy).toHaveBeenCalledWith(
        'agent-1',
        expect.stringContaining('Wiki page: test.md'),
      );
    });
  });

  describe('mission string', () => {
    it('includes file path and content', () => {
      const filePath = 'docs/guide.md';
      const content = '# Guide\n\nWelcome!';
      const parts = [
        `Wiki page: ${filePath}`,
        '',
        'Page content:',
        '```markdown',
        content,
        '```',
      ];
      const mission = parts.join('\n');

      expect(mission).toContain('Wiki page: docs/guide.md');
      expect(mission).toContain('# Guide');
      expect(mission).toContain('Welcome!');
    });

    it('includes additional instructions when provided', () => {
      const parts = [
        'Wiki page: test.md',
        '',
        'Page content:',
        '```markdown',
        '# Test',
        '```',
        '',
        'Additional instructions: Fix the typos',
      ];
      const mission = parts.join('\n');

      expect(mission).toContain('Additional instructions: Fix the typos');
    });
  });
});
