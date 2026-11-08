import { describe, it, expect, afterEach } from 'vitest';
import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { dispatcherWiresAgentId, findLocalProject, isDispatcherAgent, useDispatcherStore, visibleDispatcherAgentId } from './dispatcherStore';

describe('isDispatcherAgent', () => {
  afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

  it('is true for the Dispatcher\'s id whatever its projectId (#2552)', () => {
    useDispatcherStore.getState().setState({ enabled: true, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir', config: null });
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

describe('one Dispatcher over two agents (#3036)', () => {
  afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));
  const ON = { ...DISPATCHER_OFF, enabled: true, savedOn: true, offReason: null, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir' };

  it('shows the chat, from the chat\'s folder', () => {
    useDispatcherStore.getState().setState(ON);
    expect(visibleDispatcherAgentId()).toBe('disp');
    expect(findLocalProject(DISPATCHER_PROJECT_ID)?.path).toBe('dispatcher-dir');
  });

  it('recognises either id as the Dispatcher', () => {
    useDispatcherStore.getState().setState(ON);
    expect(isDispatcherAgent({ id: 'disp-work', projectId: 'dispatcher-work-dir' })).toBe(true);
    expect(isDispatcherAgent({ id: 'disp', projectId: 'dispatcher-dir' })).toBe(true);
  });

  it('reads the Dispatcher\'s wires from the id that holds them', () => {
    useDispatcherStore.getState().setState(ON);
    expect(dispatcherWiresAgentId({ id: 'disp', projectId: DISPATCHER_PROJECT_ID })).toBe('disp-work');
    expect(dispatcherWiresAgentId({ id: 'other', projectId: 'proj-1' })).toBe('other');
  });

  it('shows nothing until the chat exists', () => {
    useDispatcherStore.getState().setState({ ...ON, chatAgentId: null, chatPath: null });
    expect(useDispatcherStore.getState().project).toBeNull();
  });
});
