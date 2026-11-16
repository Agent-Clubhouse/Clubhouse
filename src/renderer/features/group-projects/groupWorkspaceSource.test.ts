import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { openGroupWorkspace } from './groupProjectsNav';
import { useGroupProjectsNavStore } from './groupProjectsNavStore';
import { currentViewSource, openGroupWorkspaceFrom, useGroupWorkspaceBack } from './groupWorkspaceSource';
import { resolveGroupWorkspaceRoute } from './groupProjectRoute';

beforeEach(() => {
  useGroupProjectsNavStore.setState({ route: null });
  useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: false });
});

describe('group workspace route', () => {
  it('resolves a missing or unknown section to Board and keeps a named one', () => {
    expect(resolveGroupWorkspaceRoute({ groupId: 'g' })).toEqual({ groupId: 'g', section: 'board' });
    expect(resolveGroupWorkspaceRoute({ groupId: 'g', section: 'bogus' as never })).toEqual({ groupId: 'g', section: 'board' });
    expect(resolveGroupWorkspaceRoute({ groupId: 'g', section: 'members' })).toEqual({ groupId: 'g', section: 'members' });
  });

  it('opens a group by its id, naming no section unless asked', () => {
    openGroupWorkspace({ groupId: 'g1' });
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'g1' });
    openGroupWorkspace({ groupId: 'g1', section: 'actions' });
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'g1', section: 'actions' });
  });
});

describe('Back from a group workspace', () => {
  it('has no source when opened by a plain link, and Back goes to the hub', () => {
    openGroupWorkspace({ groupId: 'g1' });
    const { result } = renderHook(() => useGroupWorkspaceBack());
    expect(result.current.source).toBeNull();
    act(() => result.current.back());
    expect(useGroupProjectsNavStore.getState().route).toBeNull();
  });

  it('names its source and restores it', () => {
    const restore = vi.fn();
    openGroupWorkspaceFrom({ groupId: 'g1' }, { label: 'Analyst', restore });
    const { result } = renderHook(() => useGroupWorkspaceBack());
    expect(result.current.source?.label).toBe('Analyst');
    act(() => result.current.back());
    expect(restore).toHaveBeenCalledTimes(1);
    expect(useGroupProjectsNavStore.getState().route).toBeNull();
  });

  it('forgets a source once another open replaces its route', () => {
    openGroupWorkspaceFrom({ groupId: 'g1' }, { label: 'Canvas', restore: vi.fn() });
    openGroupWorkspace({ groupId: 'g1' });
    const { result } = renderHook(() => useGroupWorkspaceBack());
    expect(result.current.source).toBeNull();
  });

  it('puts the tab and Dispatcher state it was opened from back', () => {
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    const source = currentViewSource('Canvas');
    useUIStore.setState({ explorerTab: 'settings' });
    source.restore();
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:canvas');
  });
});
