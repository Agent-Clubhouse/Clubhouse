import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock('./annex-event-bus', () => ({
  emitPtyExit: vi.fn(),
}));

import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import { broadcastAgentExit } from './agent-exit-broadcast';

beforeEach(() => {
  vi.mocked(broadcastToAllWindows).mockReset();
  vi.mocked(annexEventBus.emitPtyExit).mockReset();
});

describe('broadcastAgentExit', () => {
  it('broadcasts to renderer and annex event bus', () => {
    broadcastAgentExit('agent-1', 0);

    expect(broadcastToAllWindows).toHaveBeenCalledWith('pty:exit', 'agent-1', 0);
    expect(annexEventBus.emitPtyExit).toHaveBeenCalledWith('agent-1', 0);
  });

  it('passes lastOutput to renderer broadcast when provided', () => {
    broadcastAgentExit('agent-2', 1, 'some output');

    expect(broadcastToAllWindows).toHaveBeenCalledWith('pty:exit', 'agent-2', 1, 'some output');
    expect(annexEventBus.emitPtyExit).toHaveBeenCalledWith('agent-2', 1);
  });

  it('omits lastOutput argument when not provided', () => {
    broadcastAgentExit('agent-3', 137);

    // Should be called with exactly 3 args (no trailing undefined)
    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    const call = vi.mocked(broadcastToAllWindows).mock.calls[0];
    expect(call).toEqual(['pty:exit', 'agent-3', 137]);
    expect(call).toHaveLength(3);
  });

  it('passes empty string lastOutput correctly', () => {
    broadcastAgentExit('agent-4', 1, '');

    expect(broadcastToAllWindows).toHaveBeenCalledWith('pty:exit', 'agent-4', 1, '');
    expect(annexEventBus.emitPtyExit).toHaveBeenCalledWith('agent-4', 1);
  });

  it('always calls both targets exactly once', () => {
    broadcastAgentExit('agent-5', 0);

    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(annexEventBus.emitPtyExit).toHaveBeenCalledTimes(1);
  });
});
