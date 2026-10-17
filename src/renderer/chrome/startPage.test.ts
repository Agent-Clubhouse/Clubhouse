import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openNewAgentFromShortcut, openNewAgentPage } from './startPage';
import { useChromeFlagStore } from './chromeFlag';
import { useChromeStore } from './chromeStore';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'plugin:files', activeHostId: null, quickAgentDialogOpen: false, projectExplorerTab: {} });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'a', path: '/a' }, { id: 'p2', name: 'b', path: '/b' }] as never, activeProjectId: 'p2' });
  useChromeStore.setState({ projectScopeId: null, lastProjectId: null, newAgent: null });
  useQuickAgentStore.setState({ selectedCompletedId: 'q1' });
});

afterEach(() => useChromeFlagStore.setState({ enabled: false }));

describe('openNewAgentFromShortcut (⌘⇧N)', () => {
  it('opens the Quick Agent dialog in the legacy shell', () => {
    openNewAgentFromShortcut();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);
    expect(useChromeStore.getState().newAgent).toBeNull();
  });

  it('opens the New agent page with Durable chosen in the new shell', () => {
    useChromeFlagStore.setState({ enabled: true });
    openNewAgentFromShortcut();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(false);
    expect(useChromeStore.getState().newAgent).toMatchObject({ kind: 'durable', projectId: undefined });
  });

  it('keeps the dialog on a satellite host or with no projects', () => {
    useChromeFlagStore.setState({ enabled: true });
    useUIStore.setState({ activeHostId: 'sat-1' });
    openNewAgentFromShortcut();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);

    useUIStore.setState({ activeHostId: null, quickAgentDialogOpen: false });
    useProjectStore.setState({ projects: [], activeProjectId: null });
    openNewAgentFromShortcut();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);
    expect(useChromeStore.getState().newAgent).toBeNull();
  });
});

describe('openNewAgentPage', () => {
  it('opens with the kind and project asked for, fresh on every open', () => {
    useChromeFlagStore.setState({ enabled: true });
    openNewAgentPage('quick', 'p1');
    const first = useChromeStore.getState().newAgent;
    expect(first).toMatchObject({ kind: 'quick', projectId: 'p1' });
    openNewAgentPage('durable');
    expect(useChromeStore.getState().newAgent!.seq).toBeGreaterThan(first!.seq);
  });

  it("keeps the opener's options and says it opened", () => {
    useChromeFlagStore.setState({ enabled: true });
    const onCreated = () => {};
    expect(openNewAgentPage('durable', 'p1', { onCreated, stayInView: true })).toBe(true);
    expect(useChromeStore.getState().newAgent).toMatchObject({ kind: 'durable', projectId: 'p1', onCreated, stayInView: true });
  });

  it('returns false and does nothing where the page cannot open', () => {
    // Legacy shell.
    expect(openNewAgentPage('quick', 'p1', { onCreated: () => {} })).toBe(false);
    expect(useChromeStore.getState().newAgent).toBeNull();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(false);
    useChromeFlagStore.setState({ enabled: true });
    useUIStore.setState({ activeHostId: 'sat-1' });
    expect(openNewAgentPage('durable')).toBe(false);
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(false);
  });

  it('returns false with no projects, even in the new shell', () => {
    useChromeFlagStore.setState({ enabled: true });
    useProjectStore.setState({ projects: [], activeProjectId: null });
    expect(openNewAgentPage('durable', undefined, { onClosed: () => {} })).toBe(false);
    expect(useChromeStore.getState().newAgent).toBeNull();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(false);
  });

  it('tells the previous opener nothing was made when a new open replaces it', () => {
    useChromeFlagStore.setState({ enabled: true });
    const onClosed = vi.fn();
    openNewAgentPage('durable', 'p1', { onClosed });
    openNewAgentPage('quick');
    expect(onClosed).toHaveBeenCalledWith(null);
    useChromeStore.getState().closeNewAgent();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
