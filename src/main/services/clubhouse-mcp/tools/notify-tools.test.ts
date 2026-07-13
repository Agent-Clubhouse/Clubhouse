import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../../../shared/ipc-channels';

const mockBroadcast = vi.fn();
vi.mock('../../../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { registerNotifyTools, NOTIFY_MESSAGE_MAX_LENGTH, NOTIFY_TITLE_MAX_LENGTH } from './notify-tools';
import { callTool, _resetForTesting } from '../tool-registry';

describe('notify_user tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    registerNotifyTools();
  });

  it('is registered as a global tool callable by any agent', async () => {
    const result = await callTool('any-agent', 'notify_user', { message: 'Need you' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Notification sent');
  });

  it('broadcasts AGENT_ATTENTION with agentId and payload', async () => {
    await callTool('agent-7', 'notify_user', { message: 'Pick an approach', title: 'Blocked' });

    expect(mockBroadcast).toHaveBeenCalledWith(
      IPC.APP.AGENT_ATTENTION,
      'agent-7',
      { message: 'Pick an approach', title: 'Blocked' },
    );
  });

  it('omits title from the payload when not provided', async () => {
    await callTool('agent-7', 'notify_user', { message: 'Just a message' });

    expect(mockBroadcast).toHaveBeenCalledWith(
      IPC.APP.AGENT_ATTENTION,
      'agent-7',
      { message: 'Just a message' },
    );
  });

  it('rejects an empty / whitespace-only message and does not broadcast', async () => {
    const result = await callTool('agent-7', 'notify_user', { message: '   ' });
    expect(result.isError).toBe(true);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('rejects a missing message via schema validation', async () => {
    const result = await callTool('agent-7', 'notify_user', {});
    expect(result.isError).toBe(true);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('caps message and title length', async () => {
    const longMessage = 'm'.repeat(NOTIFY_MESSAGE_MAX_LENGTH + 50);
    const longTitle = 't'.repeat(NOTIFY_TITLE_MAX_LENGTH + 50);
    await callTool('agent-7', 'notify_user', { message: longMessage, title: longTitle });

    const payload = mockBroadcast.mock.calls[0][2] as { message: string; title: string };
    expect(payload.message).toHaveLength(NOTIFY_MESSAGE_MAX_LENGTH);
    expect(payload.title).toHaveLength(NOTIFY_TITLE_MAX_LENGTH);
  });
});
