import { create } from 'zustand';
import { AgentState } from './agent/types';
import { createUISlice } from './agent/agentUISlice';
import { createCrudSlice } from './agent/agentCrudSlice';
import { createLifecycleSlice } from './agent/agentLifecycleSlice';
import { createStatusSlice } from './agent/agentStatusSlice';
import { createIconSlice } from './agent/agentIconSlice';

// Re-export public types consumers depend on
export type { DeleteMode } from './agent/types';

export const useAgentStore = create<AgentState>((set, get) => ({
  ...createUISlice(set, get),
  ...createCrudSlice(set, get),
  ...createLifecycleSlice(set, get),
  ...createStatusSlice(set, get),
  ...createIconSlice(set, get),
}));

/** Check if an agent was user-cancelled (consumes the flag) */
export function consumeCancelled(agentId: string): boolean {
  const was = agentId in useAgentStore.getState().cancelledAgentIds;
  if (was) {
    useAgentStore.setState((s) => {
      const { [agentId]: _, ...rest } = s.cancelledAgentIds;
      return { cancelledAgentIds: rest };
    });
  }
  return was;
}
