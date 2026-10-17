import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';

vi.mock('./ChromeSidebar', () => ({ ChromeSidebar: () => <div data-testid="chrome-sidebar" /> }));
vi.mock('../panels/MainContentView', () => ({ MainContentView: () => <div data-testid="main-content" /> }));
vi.mock('./pages/ProjectStartPage', () => ({ ProjectStartPage: ({ project }: { project: { id: string } }) => <div data-testid="start-page">{project.id}</div> }));
vi.mock('./pages/FirstRun', () => ({ FirstRun: () => <div data-testid="first-run" /> }));
vi.mock('./pages/NewAgentPage', () => ({ NewAgentPage: ({ request }: { request: { kind: string } }) => <div data-testid="new-agent-page">{request.kind}</div> }));

import { ChromeBody } from './ChromeBody';
import { useChromeFlagStore } from './chromeFlag';
import { useChromeStore } from './chromeStore';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';

beforeEach(() => {
  useChromeFlagStore.setState({ enabled: true });
  useUIStore.setState({ explorerTab: 'agents', activeHostId: null });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: '/ch' }] as never, projectsLoaded: true, activeProjectId: 'p1' });
  useAgentStore.setState({
    agents: { a1: { id: 'a1', projectId: 'p1', name: 'gallant-swift', kind: 'durable', status: 'running', color: 'blue' } } as never,
    activeAgentId: 'a1',
  });
  useQuickAgentStore.setState({ selectedCompletedId: null });
  useChromeStore.setState({ projectScopeId: null, newAgent: null, newAgentBusy: false });
});

afterEach(() => useChromeFlagStore.setState({ enabled: false }));

describe('ChromeBody', () => {
  it('shows the New agent page over the pane until something else opens', () => {
    useUIStore.setState({ explorerTab: 'settings' });
    render(<ChromeBody />);
    act(() => useChromeStore.getState().openNewAgent('quick'));
    expect(screen.getByTestId('new-agent-page').textContent).toBe('quick');
    act(() => useUIStore.setState({ explorerTab: 'help' }));
    expect(useChromeStore.getState().newAgent).toBeNull();
    expect(screen.queryByTestId('new-agent-page')).toBeNull();
  });

  it('keeps the New agent page through selection changes it makes while busy', () => {
    render(<ChromeBody />);
    act(() => { useChromeStore.getState().openNewAgent('durable'); useChromeStore.getState().setNewAgentBusy(true); });
    // Adding a project activates it; the creating placeholder becomes the active agent.
    act(() => useProjectStore.setState({ activeProjectId: 'p1' }));
    act(() => useAgentStore.setState({ activeAgentId: 'tmp' }));
    act(() => useChromeStore.getState().setNewAgentBusy(false));
    expect(useChromeStore.getState().newAgent).not.toBeNull();
    act(() => useUIStore.setState({ explorerTab: 'help' }));
    expect(useChromeStore.getState().newAgent).toBeNull();
  });

  it('shows the selected agent on the Agents tab', () => {
    render(<ChromeBody />);
    expect(screen.getByTestId('main-content')).toBeTruthy();
    expect(screen.queryByTestId('start-page')).toBeNull();
  });

  it('shows the start page when the project header is selected', () => {
    useChromeStore.setState({ projectScopeId: 'p1' });
    render(<ChromeBody />);
    expect(screen.getByTestId('start-page').textContent).toBe('p1');
  });

  it('leaves the start page for any agent that becomes active (a spawn, a notification, the palette)', () => {
    useChromeStore.setState({ projectScopeId: 'p1' });
    useAgentStore.setState({ activeAgentId: null });
    render(<ChromeBody />);
    expect(screen.getByTestId('start-page')).toBeTruthy();
    // A failed quick-agent spawn adds and selects the errored agent.
    act(() => useAgentStore.setState((s) => ({
      agents: { ...s.agents, q9: { id: 'q9', projectId: 'p1', name: 'q9', kind: 'quick', status: 'error', color: 'gray' } as never },
      activeAgentId: 'q9',
    })));
    expect(useChromeStore.getState().projectScopeId).toBeNull();
    expect(screen.getByTestId('main-content')).toBeTruthy();
  });

  it('shows the start page for a project with no agent selected', () => {
    useAgentStore.setState({ activeAgentId: null });
    render(<ChromeBody />);
    expect(screen.getByTestId('start-page')).toBeTruthy();
  });

  it('shows an open finished quick agent rather than the start page', () => {
    useChromeStore.setState({ projectScopeId: 'p1' });
    useQuickAgentStore.setState({ selectedCompletedId: 'q1' });
    render(<ChromeBody />);
    expect(screen.getByTestId('main-content')).toBeTruthy();
  });

  it('shows the tab content on other tabs, even with the project as scope', () => {
    useChromeStore.setState({ projectScopeId: 'p1' });
    useUIStore.setState({ explorerTab: 'plugin:terminal' });
    render(<ChromeBody />);
    expect(screen.getByTestId('main-content')).toBeTruthy();
  });

  it('shows nothing until the project list has loaded', () => {
    useProjectStore.setState({ projects: [], projectsLoaded: false, activeProjectId: null });
    render(<ChromeBody />);
    expect(screen.queryByTestId('first-run')).toBeNull();
  });

  it('shows first run with no projects', () => {
    useProjectStore.setState({ projects: [], activeProjectId: null });
    useAgentStore.setState({ agents: {}, activeAgentId: null });
    render(<ChromeBody />);
    expect(screen.getByTestId('first-run')).toBeTruthy();
  });

  it('follows the active project to its host', () => {
    useUIStore.setState({ activeHostId: 's1' });
    render(<ChromeBody />);
    // A palette or notification click opened the local project p1.
    expect(useUIStore.getState().activeHostId).toBeNull();
    act(() => useProjectStore.setState({ activeProjectId: 'remote||s1||site' }));
    expect(useUIStore.getState().activeHostId).toBe('s1');
  });
});
