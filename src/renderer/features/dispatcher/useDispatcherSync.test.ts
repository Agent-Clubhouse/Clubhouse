import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID, type DispatcherState } from '../../../shared/dispatcher-types';
import type { DurableAgentConfig } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useDispatcherSync } from './useDispatcherSync';
import { findLocalProject, isDispatcherAgent, useDispatcherStore } from './dispatcherStore';

const config = { id: 'disp', name: 'Dispatcher', color: 'indigo', createdAt: '2026-10-31T00:00:00.000Z', model: 'opus' } as DurableAgentConfig;
const ON: DispatcherState = { enabled: true, flagOn: true, agentId: 'disp', path: 'dispatcher-dir', config };

describe('useDispatcherSync', () => {
  let emit: ((s: DispatcherState) => void) | null;
  const originals = { get: window.clubhouse.dispatcher.get, onChanged: window.clubhouse.dispatcher.onChanged, listDurable: window.clubhouse.agent.listDurable };

  beforeEach(() => {
    emit = null;
    useAgentStore.setState({ agents: {}, agentDetailedStatus: {} });
    useUIStore.setState({ dispatcherOpen: false });
    window.clubhouse.dispatcher.onChanged = vi.fn((cb) => { emit = cb; return () => { emit = null; }; });
    window.clubhouse.agent.listDurable = vi.fn(async (path: string) => (path === 'dispatcher-dir' ? [config] : []));
  });
  afterEach(() => {
    Object.assign(window.clubhouse.dispatcher, { get: originals.get, onChanged: originals.onChanged });
    window.clubhouse.agent.listDurable = originals.listDurable;
    useDispatcherStore.getState().setState(DISPATCHER_OFF);
    useDispatcherStore.setState({ loadError: null });
  });

  it('loads the Dispatcher agent under the synthetic project id, with its folder as the path', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    renderHook(() => useDispatcherSync());
    await waitFor(() => expect(useAgentStore.getState().agents.disp).toBeTruthy());
    expect(window.clubhouse.agent.listDurable).toHaveBeenCalledWith('dispatcher-dir');
    expect(useAgentStore.getState().agents.disp).toMatchObject({ projectId: DISPATCHER_PROJECT_ID, kind: 'durable', status: 'sleeping', model: 'opus' });
    // Agent views find its folder through the synthetic id.
    expect(findLocalProject(DISPATCHER_PROJECT_ID)).toEqual({ id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: 'dispatcher-dir' });
  });

  it('drops the agent and closes its view when turned off, and keeps nothing while off', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    renderHook(() => useDispatcherSync());
    await waitFor(() => expect(useAgentStore.getState().agents.disp).toBeTruthy());
    act(() => useUIStore.setState({ dispatcherOpen: true }));
    // Off keeps the id and folder so turning it back on resumes (#2533).
    act(() => emit?.({ ...ON, enabled: false }));
    expect(useAgentStore.getState().agents.disp).toBeUndefined();
    expect(useUIStore.getState().dispatcherOpen).toBe(false);
    expect(findLocalProject(DISPATCHER_PROJECT_ID)).toBeUndefined();
  });

  it('repairs a record a resume keyed on the folder before the state arrived (#2552)', async () => {
    // The resume ran first and, with no Dispatcher state yet, fell back to the folder.
    useAgentStore.setState({ agents: { disp: { id: 'disp', projectId: 'dispatcher-dir', name: 'Dispatcher', kind: 'durable', status: 'running', color: 'indigo' } } });
    // The repair doesn't wait for listDurable.
    window.clubhouse.agent.listDurable = vi.fn(() => new Promise<DurableAgentConfig[]>(() => {}));
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    renderHook(() => useDispatcherSync());
    await waitFor(() => expect(useAgentStore.getState().agents.disp.projectId).toBe(DISPATCHER_PROJECT_ID));
    expect(useAgentStore.getState().agents.disp.status).toBe('running');
    expect(findLocalProject(useAgentStore.getState().agents.disp.projectId)?.path).toBe('dispatcher-dir');
    expect(isDispatcherAgent(useAgentStore.getState().agents.disp)).toBe(true);
  });

  it('loads nothing while the Dispatcher is off', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue({ ...ON, enabled: false });
    renderHook(() => useDispatcherSync());
    await waitFor(() => expect(useDispatcherStore.getState().state).not.toBeNull());
    expect(window.clubhouse.agent.listDurable).not.toHaveBeenCalled();
    expect(useAgentStore.getState().agents.disp).toBeUndefined();
  });

  it('keeps a failed load for the view, and Retry loads again (#2557)', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    window.clubhouse.agent.listDurable = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'agent:listDurable': Error: disk unavailable"))
      .mockResolvedValue([config]);
    renderHook(() => useDispatcherSync());
    await waitFor(() => expect(useDispatcherStore.getState().loadError).toBe('disk unavailable'));
    expect(useAgentStore.getState().agents.disp).toBeUndefined();
    act(() => useDispatcherStore.getState().retryLoad());
    await waitFor(() => expect(useAgentStore.getState().agents.disp).toBeTruthy());
    expect(useDispatcherStore.getState().loadError).toBeNull();
  });

  it('says so when the load finds no agent in its folder', async () => {
    window.clubhouse.dispatcher.get = vi.fn().mockResolvedValue(ON);
    window.clubhouse.agent.listDurable = vi.fn().mockResolvedValue([]);
    renderHook(() => useDispatcherSync());
    await waitFor(() => expect(useDispatcherStore.getState().loadError).toBe('Its agent wasn’t found in its folder.'));
  });
});
