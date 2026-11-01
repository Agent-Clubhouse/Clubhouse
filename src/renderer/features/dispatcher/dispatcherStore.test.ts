import { describe, it, expect, afterEach } from 'vitest';
import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { isDispatcherAgent, useDispatcherStore } from './dispatcherStore';

describe('isDispatcherAgent', () => {
  afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

  it('is true for the Dispatcher\'s id whatever its projectId (#2552)', () => {
    useDispatcherStore.getState().setState({ enabled: true, agentId: 'disp', path: 'dispatcher-dir', config: null });
    expect(isDispatcherAgent({ id: 'disp', projectId: 'dispatcher-dir' })).toBe(true);
    expect(isDispatcherAgent({ id: 'disp', projectId: DISPATCHER_PROJECT_ID })).toBe(true);
    expect(isDispatcherAgent({ id: 'other', projectId: 'proj-1' })).toBe(false);
  });

  it('falls back to the synthetic project id before the state loads', () => {
    expect(isDispatcherAgent({ id: 'disp', projectId: DISPATCHER_PROJECT_ID })).toBe(true);
    expect(isDispatcherAgent({ id: 'disp', projectId: 'dispatcher-dir' })).toBe(false);
    expect(isDispatcherAgent(null)).toBe(false);
  });
});
