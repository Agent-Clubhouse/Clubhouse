import { describe, it, expect } from 'vitest';
import { IPC } from './ipc-channels';

describe('IPC structured mode channels', () => {
  it('defines STRUCTURED_EVENT channel', () => {
    expect(IPC.AGENT.STRUCTURED_EVENT).toBe('agent:structured-event');
  });

  it('defines START_STRUCTURED channel', () => {
    expect(IPC.AGENT.START_STRUCTURED).toBe('agent:start-structured');
  });

  it('defines CANCEL_STRUCTURED channel', () => {
    expect(IPC.AGENT.CANCEL_STRUCTURED).toBe('agent:cancel-structured');
  });

  it('defines SEND_STRUCTURED_MESSAGE channel', () => {
    expect(IPC.AGENT.SEND_STRUCTURED_MESSAGE).toBe('agent:send-structured-message');
  });

  it('defines RESPOND_PERMISSION channel', () => {
    expect(IPC.AGENT.RESPOND_PERMISSION).toBe('agent:respond-permission');
  });

  it('all structured channels are unique (no collisions)', () => {
    const structuredChannels = [
      IPC.AGENT.STRUCTURED_EVENT,
      IPC.AGENT.START_STRUCTURED,
      IPC.AGENT.CANCEL_STRUCTURED,
      IPC.AGENT.SEND_STRUCTURED_MESSAGE,
      IPC.AGENT.RESPOND_PERMISSION,
    ];
    const uniqueSet = new Set(structuredChannels);
    expect(uniqueSet.size).toBe(structuredChannels.length);
  });

  it('structured channels do not collide with existing agent channels', () => {
    const allAgentChannels = Object.values(IPC.AGENT);
    const uniqueSet = new Set(allAgentChannels);
    expect(uniqueSet.size).toBe(allAgentChannels.length);
  });
});
