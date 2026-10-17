import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCommandActions } from './command-actions';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import { useChromeStore } from '../../chrome/chromeStore';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';

/** ⌘1–9 and ⌥⌘1–9 in the new shell (docs/chrome-redesign-spec.md §5.3), against the real stores. */

const run = (id: string) => getCommandActions().find((a) => a.id === id)!.execute();
const agent = (id: string, kind: string, status = 'running') => ({ id, projectId: 'p1', name: id, kind, status, color: 'blue' });

beforeEach(() => {
  useChromeFlagStore.setState({ enabled: true });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'A', path: '/a' }] as never, activeProjectId: 'p1' });
  useUIStore.setState({ explorerTab: 'agents', projectExplorerTab: {} });
  useChromeStore.setState({ titleTabs: [{ id: 'agents' }, { id: 'plugin:files' }, { id: 'plugin:git', disabled: true }] });
  useAgentStore.setState({
    agents: {
      s1: agent('s1', 'durable', 'sleeping'),
      q1: agent('q1', 'quick'),
      d1: agent('d1', 'durable'),
      c1: agent('c1', 'companion'),
      d2: agent('d2', 'durable'),
    } as never,
    activeAgentId: null,
  });
});

afterEach(() => useChromeFlagStore.setState({ enabled: false }));

describe('new-shell shortcut actions', () => {
  it('tab-N selects the Nth title-bar tab, skipping disabled and missing ones', () => {
    run('tab-2');
    expect(useUIStore.getState().explorerTab).toBe('plugin:files');
    run('tab-3');
    expect(useUIStore.getState().explorerTab).toBe('plugin:files');
    run('tab-9');
    expect(useUIStore.getState().explorerTab).toBe('plugin:files');
    run('tab-1');
    expect(useUIStore.getState().explorerTab).toBe('agents');
  });

  it('switch-agent-N counts the sidebar rows: awake durable, quick, then sleeping', () => {
    run('switch-agent-1');
    expect(useAgentStore.getState().activeAgentId).toBe('d1');
    run('switch-agent-3');
    expect(useAgentStore.getState().activeAgentId).toBe('q1');
    run('switch-agent-4');
    expect(useAgentStore.getState().activeAgentId).toBe('s1');
    useAgentStore.setState({ activeAgentId: null });
    run('switch-agent-5');
    expect(useAgentStore.getState().activeAgentId).toBeNull();
  });

  it('switch-agent-N keeps counting durable agents only in the legacy shell', () => {
    useChromeFlagStore.setState({ enabled: false });
    run('switch-agent-1');
    expect(useAgentStore.getState().activeAgentId).toBe('s1');
    run('switch-agent-3');
    expect(useAgentStore.getState().activeAgentId).toBe('d2');
  });
});
