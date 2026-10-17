import { describe, it, expect, beforeEach } from 'vitest';
import { hostOf, switchHost } from './hosts';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useChromeStore } from './chromeStore';
import { namespacedProjectId } from '../stores/remoteProjectStore';

const remote = namespacedProjectId('s1', 'p9');

beforeEach(() => {
  useUIStore.setState({ activeHostId: null });
  useProjectStore.setState({ activeProjectId: 'p1' });
  useChromeStore.setState({ projectScopeId: 'p1' });
});

describe('hosts', () => {
  it('tells local ids from a satellite’s', () => {
    expect(hostOf('p1')).toBeNull();
    expect(hostOf(remote)).toBe('s1');
  });

  it('switching host clears a selection that belongs to the old host', () => {
    switchHost('s1');
    expect(useUIStore.getState().activeHostId).toBe('s1');
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(useChromeStore.getState().projectScopeId).toBeNull();

    useProjectStore.setState({ activeProjectId: remote });
    switchHost(null);
    expect(useUIStore.getState().activeHostId).toBeNull();
    expect(useProjectStore.getState().activeProjectId).toBeNull();
  });

  it('does nothing when the host is already active', () => {
    switchHost(null);
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useChromeStore.getState().projectScopeId).toBe('p1');
  });
});
