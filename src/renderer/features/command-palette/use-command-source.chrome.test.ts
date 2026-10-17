import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCommandSource } from './use-command-source';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { useChromeStore } from '../../chrome/chromeStore';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useRemoteProjectStore, namespacedAgentId, namespacedProjectId } from '../../stores/remoteProjectStore';
import { useKeyboardShortcutsStore, buildShortcuts, CHROME_SHORTCUTS } from '../../stores/keyboardShortcutsStore';

/** Palette additions in the new shell (docs/chrome-redesign-spec.md §4.3). */

const rp = namespacedProjectId('s1', 'site');
const ra = namespacedAgentId('s1', 'bold-owl');

beforeEach(() => {
  useChromeFlagStore.setState({ enabled: true });
  // The shortcut store picks its set at launch; give it the new shell's.
  useKeyboardShortcutsStore.setState({ shortcuts: buildShortcuts(CHROME_SHORTCUTS, {}) });
  useUIStore.setState({ activeHostId: null, explorerTab: 'agents' });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/ch' }] as never, activeProjectId: 'p1' });
  useAgentStore.setState({ agents: {}, activeAgentId: null });
  usePluginStore.setState({ plugins: { files: { manifest: { id: 'files', contributes: { tab: { label: 'Files' } } } } } as never, projectEnabled: { p1: ['files'] } });
  useChromeStore.setState({ titleTabs: [{ id: 'agents' }, { id: 'plugin:files' }] });
  useAnnexClientStore.setState({
    satellites: [{ id: 's1', alias: 'Studio', state: 'connected', fingerprint: 'fp', icon: '', color: 'blue', host: 'h', mainPort: 1, pairingPort: 2, snapshot: null, lastError: null }],
  });
  useRemoteProjectStore.setState({
    satelliteProjects: { s1: [{ id: rp, name: 'Site', path: '/srv/site', remote: true, satelliteId: 's1', satelliteName: 'Studio' }] as never },
    remoteAgents: { [ra]: { id: ra, projectId: rp, name: 'bold-owl', kind: 'durable', status: 'running', color: 'blue' } as never },
  });
});

afterEach(() => {
  useChromeFlagStore.setState({ enabled: false });
  useAnnexClientStore.setState({ satellites: [] });
});

const items = () => renderHook(() => useCommandSource()).result.current;

describe('palette in the new shell', () => {
  it('lists hosts, and a satellite’s projects and agents with their host', () => {
    const list = items();
    expect(list.find((i) => i.id === 'host:local')?.label).toBe('Switch to Local');
    expect(list.find((i) => i.id === 'host:s1')).toMatchObject({ label: 'Switch to Studio', category: 'Hosts' });
    expect(list.find((i) => i.id === `project:${rp}`)?.detail).toBe('on Studio');
    expect(list.find((i) => i.id === `agent:${ra}`)?.detail).toBe('Site on Studio · Idle');
  });

  it('opening a satellite’s agent switches host and selects it', () => {
    const item = items().find((i) => i.id === `agent:${ra}`)!;
    act(() => item.execute());
    expect(useUIStore.getState().activeHostId).toBe('s1');
    expect(useProjectStore.getState().activeProjectId).toBe(rp);
    expect(useAgentStore.getState().activeAgentId).toBe(ra);
  });

  it('shows the ⌘N tab shortcut on tab commands', () => {
    const list = items();
    expect(list.find((i) => i.id === 'nav:agents')?.shortcut).toBeTruthy();
    expect(list.find((i) => i.id === 'nav:plugin:files')?.shortcut).toBeTruthy();
  });

  it('shows no shortcut on a disabled tab', () => {
    useChromeStore.setState({ titleTabs: [{ id: 'agents' }, { id: 'plugin:files', disabled: true }] });
    expect(items().find((i) => i.id === 'nav:plugin:files')?.shortcut).toBeUndefined();
  });

  it('adds none of this in the legacy shell', () => {
    useChromeFlagStore.setState({ enabled: false });
    const list = items();
    expect(list.some((i) => i.category === 'Hosts')).toBe(false);
    expect(list.find((i) => i.id === 'nav:plugin:files')?.shortcut).toBeUndefined();
  });
});
