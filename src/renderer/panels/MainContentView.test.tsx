import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useProjectStore } from '../stores/projectStore';
import { MainContentView } from './MainContentView';
import type { CompletedQuickAgent } from '../../shared/types';

// Mock child components to isolate MainContentView logic
vi.mock('../features/agents/AgentTerminal', () => ({
  AgentTerminal: (props: any) => <div data-testid="agent-terminal" data-focused={String(!!props.focused)} />,
}));
vi.mock('../features/agents/SleepingAgent', () => ({
  SleepingAgent: () => <div data-testid="sleeping-agent" />,
}));
vi.mock('../features/agents/HeadlessAgentView', () => ({
  HeadlessAgentView: () => <div data-testid="headless-agent" />,
}));
vi.mock('../features/agents/AgentSettingsView', () => ({
  AgentSettingsView: () => <div data-testid="agent-settings" />,
}));
vi.mock('../features/agents/QuickAgentGhost', () => ({
  QuickAgentGhost: (props: any) => (
    <div data-testid="quick-agent-ghost">
      <span data-testid="ghost-mission">{props.completed?.mission}</span>
      <button data-testid="ghost-dismiss" onClick={props.onDismiss}>Dismiss</button>
      <button data-testid="ghost-delete" onClick={props.onDelete}>Delete</button>
    </div>
  ),
}));
vi.mock('../features/settings/ProjectSettings', () => ({
  ProjectSettings: () => <div data-testid="project-settings" />,
}));
vi.mock('../features/settings/NotificationSettingsView', () => ({
  NotificationSettingsView: () => <div />,
}));
vi.mock('../features/settings/DisplaySettingsView', () => ({
  DisplaySettingsView: () => <div />,
}));
vi.mock('../features/settings/OrchestratorSettingsView', () => ({
  OrchestratorSettingsView: () => <div />,
}));
vi.mock('./PluginContentView', () => ({
  PluginContentView: () => <div />,
}));
vi.mock('../features/settings/PluginDetailSettings', () => ({
  PluginDetailSettings: () => <div />,
}));
vi.mock('../features/settings/PluginListSettings', () => ({
  PluginListSettings: () => <div />,
}));
vi.mock('../features/settings/AboutSettingsView', () => ({
  AboutSettingsView: () => <div />,
}));
vi.mock('../features/settings/LoggingSettingsView', () => ({
  LoggingSettingsView: () => <div />,
}));
vi.mock('../features/settings/UpdateSettingsView', () => ({
  UpdateSettingsView: () => <div />,
}));
vi.mock('../features/settings/AnnexSettingsView', () => ({
  AnnexSettingsView: () => <div />,
}));
vi.mock('../features/settings/WhatsNewSettingsView', () => ({
  WhatsNewSettingsView: () => <div />,
}));
vi.mock('../features/settings/GettingStartedSettingsView', () => ({
  GettingStartedSettingsView: () => <div />,
}));
vi.mock('../features/settings/KeyboardShortcutsSettingsView', () => ({
  KeyboardShortcutsSettingsView: () => <div />,
}));

const completedAgent: CompletedQuickAgent = {
  id: 'completed-1',
  projectId: 'proj-1',
  name: 'test-quick',
  mission: 'fix the bug',
  summary: 'Fixed it',
  filesModified: ['src/foo.ts'],
  exitCode: 0,
  completedAt: Date.now(),
};

function resetStores() {
  useUIStore.setState({
    explorerTab: 'agents',
    settingsSubPage: undefined,
    settingsContext: 'app',
  });
  useAgentStore.setState({
    agents: {},
    activeAgentId: null,
    agentSettingsOpenFor: null,
  });
  useQuickAgentStore.setState({
    completedAgents: {},
    selectedCompletedId: null,
  });
  useProjectStore.setState({
    activeProjectId: 'proj-1',
  });
}

describe('MainContentView selectedCompleted derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('shows QuickAgentGhost when a completed agent is selected', () => {
    useQuickAgentStore.setState({
      completedAgents: { 'proj-1': [completedAgent] },
      selectedCompletedId: 'completed-1',
    });

    render(<MainContentView />);
    expect(screen.getByTestId('quick-agent-ghost')).toBeInTheDocument();
    expect(screen.getByTestId('ghost-mission')).toHaveTextContent('fix the bug');
  });

  it('shows no-active-agent view when no agent or completed is selected', () => {
    useQuickAgentStore.setState({
      completedAgents: {},
      selectedCompletedId: null,
    });

    render(<MainContentView />);
    expect(screen.getByTestId('no-active-agent')).toBeInTheDocument();
  });

  it('shows no-active-agent when selectedCompletedId does not match any record', () => {
    useQuickAgentStore.setState({
      completedAgents: { 'proj-1': [completedAgent] },
      selectedCompletedId: 'nonexistent-id',
    });

    render(<MainContentView />);
    expect(screen.getByTestId('no-active-agent')).toBeInTheDocument();
  });

  it('derives selectedCompleted from raw state without calling store getters', () => {
    // Populate completed agents across multiple projects
    const otherCompleted: CompletedQuickAgent = {
      ...completedAgent,
      id: 'completed-2',
      projectId: 'proj-2',
      mission: 'other project task',
    };
    useQuickAgentStore.setState({
      completedAgents: {
        'proj-1': [completedAgent],
        'proj-2': [otherCompleted],
      },
      selectedCompletedId: 'completed-2',
    });

    render(<MainContentView />);
    // Should find completed-2 from proj-2 via Object.values iteration
    expect(screen.getByTestId('quick-agent-ghost')).toBeInTheDocument();
    expect(screen.getByTestId('ghost-mission')).toHaveTextContent('other project task');
  });

  it('updates when completedAgents state changes', () => {
    useQuickAgentStore.setState({
      completedAgents: { 'proj-1': [completedAgent] },
      selectedCompletedId: 'completed-1',
    });

    const { rerender } = render(<MainContentView />);
    expect(screen.getByTestId('quick-agent-ghost')).toBeInTheDocument();

    // Dismiss the completed agent — remove from store
    act(() => {
      useQuickAgentStore.setState({
        completedAgents: { 'proj-1': [] },
      });
    });

    rerender(<MainContentView />);
    // selectedCompletedId still set but no matching record => no-active-agent
    expect(screen.getByTestId('no-active-agent')).toBeInTheDocument();
  });
});

describe('MainContentView terminal focus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('passes focused=true to AgentTerminal when on agents tab', async () => {
    useAgentStore.setState({
      agents: { 'a-1': { id: 'a-1', projectId: 'proj-1', status: 'running', kind: 'durable' } as any },
      activeAgentId: 'a-1',
    });

    render(<MainContentView />);

    // Allow the useEffect + rAF to settle
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(screen.getByTestId('agent-terminal')).toHaveAttribute('data-focused', 'true');
  });

  it('passes focused=false when switching away from agents tab', async () => {
    useAgentStore.setState({
      agents: { 'a-1': { id: 'a-1', projectId: 'proj-1', status: 'running', kind: 'durable' } as any },
      activeAgentId: 'a-1',
    });

    const { rerender } = render(<MainContentView />);

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(screen.getByTestId('agent-terminal')).toHaveAttribute('data-focused', 'true');

    // Switch to settings tab
    act(() => {
      useUIStore.setState({ explorerTab: 'settings' });
    });

    rerender(<MainContentView />);

    // AgentTerminal should no longer be rendered at all
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
  });

  it('re-focuses terminal after project switch', async () => {
    useAgentStore.setState({
      agents: {
        'a-1': { id: 'a-1', projectId: 'proj-1', status: 'running', kind: 'durable' } as any,
        'a-2': { id: 'a-2', projectId: 'proj-2', status: 'running', kind: 'durable' } as any,
      },
      activeAgentId: 'a-1',
    });

    const { rerender } = render(<MainContentView />);

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(screen.getByTestId('agent-terminal')).toHaveAttribute('data-focused', 'true');

    // Switch to project 2
    act(() => {
      useProjectStore.setState({ activeProjectId: 'proj-2' });
      useAgentStore.setState({ activeAgentId: 'a-2' });
    });

    rerender(<MainContentView />);

    // The effect sets focused=false first, then rAF sets true
    // After rAF settles, focused should be true again
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });

    expect(screen.getByTestId('agent-terminal')).toHaveAttribute('data-focused', 'true');
  });
});
