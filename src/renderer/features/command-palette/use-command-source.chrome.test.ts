import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCommandSource } from './use-command-source';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { useChromeStore } from '../../chrome/chromeStore';
import { useQuickPromptStore } from '../../chrome/quickPromptStore';
import { useUIStore } from '../../stores/uiStore';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useGroupProjectsNavStore } from '../group-projects/groupProjectsNavStore';
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
  it('derives Group Projects from the real settings categories and opens the app directory', () => {
    useUIStore.setState({ settingsContext: 'project' });
    const item = items().find((entry) => entry.id === 'settings:group-projects')!;
    expect(item).toMatchObject({ label: 'Group Projects', category: 'Settings', detail: 'App' });
    act(() => item.execute());
    expect(useUIStore.getState()).toMatchObject({
      explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'group-projects',
    });
  });

  it('lists hosts, and a satellite’s projects and agents with their host', () => {
    const list = items();
    expect(list.find((i) => i.id === 'host:local')?.label).toBe('Switch to this computer');
    expect(list.find((i) => i.id === 'host:s1')).toMatchObject({ label: 'Switch to Studio', category: 'Computers' });
    expect(list.find((i) => i.id === `project:${rp}`)?.detail).toBe('on Studio');
    expect(list.find((i) => i.id === `agent:${ra}`)?.detail).toBe('Site on Studio · Done');
  });

  it('opening a satellite’s agent switches host and selects it', () => {
    const item = items().find((i) => i.id === `agent:${ra}`)!;
    act(() => item.execute());
    expect(useUIStore.getState().activeHostId).toBe('s1');
    expect(useProjectStore.getState().activeProjectId).toBe(rp);
    expect(useAgentStore.getState().activeAgentId).toBe(ra);
  });

  it('shows separate agent shortcuts and opens the selected kind', () => {
    const list = items();
    const quick = list.find((i) => i.id === 'action:new-quick-agent')!;
    const durable = list.find((i) => i.id === 'action:new-agent')!;
    expect(quick.shortcut).toBeTruthy();
    expect(durable.shortcut).toBeTruthy();
    expect(quick.shortcut).not.toEqual(durable.shortcut);
    // Quick is ⌘N's one-line prompt (#2812), not the page.
    act(() => quick.execute());
    expect(useQuickPromptStore.getState().open).toBe(true);
    expect(useChromeStore.getState().newAgent).toBeNull();
    useQuickPromptStore.setState({ open: false });
    act(() => durable.execute());
    expect(useChromeStore.getState().newAgent?.kind).toBe('durable');
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

  it('opens the Group Projects hub, and each group by its stable id with scope and host', () => {
    useGroupProjectStore.setState({
      projects: [
        { id: 'gp1', name: 'Release checks', description: '', instructions: '', createdAt: 't', metadata: {}, scope: { level: 'project', projectId: 'p1', reach: 'local' } },
        { id: 'gp2', name: 'Release checks', description: '', instructions: '', createdAt: 't', metadata: {}, scope: { level: 'app', reach: 'network' }, hostName: 'Studio' },
      ],
    });
    const list = items();
    const hub = list.find((i) => i.id === 'group-projects:open')!;
    expect(hub).toMatchObject({ label: 'Group Projects', category: 'Commands' });
    act(() => hub.execute());
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:group-projects');
    expect(useGroupProjectsNavStore.getState().route).toBeNull();

    // Same name, two groups: told apart by scope and host, opened by id.
    const [first, second] = ['gp1', 'gp2'].map((id) => list.find((i) => i.id === `group-project:${id}`)!);
    expect(first).toMatchObject({ label: 'Release checks', category: 'Group Projects', searchOnly: true });
    expect(first.detail).toBe('Scope: Clubhouse. Reach: This computer. Host: This computer');
    expect(second.detail).toBe('Scope: App-wide. Reach: Network. Host: Studio');
    act(() => second.execute());
    expect(useGroupProjectsNavStore.getState().route).toEqual({ groupId: 'gp2' });
    useGroupProjectStore.setState({ projects: [] });
  });

  it('adds none of this in the legacy shell', () => {
    useChromeFlagStore.setState({ enabled: false });
    const list = items();
    expect(list.some((i) => i.category === 'Computers')).toBe(false);
    expect(list.find((i) => i.id === 'nav:plugin:files')?.shortcut).toBeUndefined();
  });
});
