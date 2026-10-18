import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../shared/ipc-channels';

const { on, removeListener } = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: { on, removeListener } }));

import { mcpBinding } from './mcpBinding';

describe('MCP connection notifications', () => {
  it('forwards the agent id and removes the same listener on unsubscribe', () => {
    const callback = vi.fn();
    const unsubscribe = mcpBinding.mcpBinding.onAgentConnectionChanged(callback);
    expect(on).toHaveBeenCalledWith(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, expect.any(Function));
    const listener = on.mock.calls[0][1];
    listener({}, 'agent-1');
    expect(callback).toHaveBeenCalledExactlyOnceWith('agent-1');
    unsubscribe();
    expect(removeListener).toHaveBeenCalledExactlyOnceWith(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, listener);
  });
});
