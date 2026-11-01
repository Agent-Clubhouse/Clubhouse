import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { createChatViewState, type ChatViewState } from '../../../stores/chatStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useChatIdleSettingsStore } from '../../../stores/chatIdleSettingsStore';
import { useClubhouseModeStore } from '../../../stores/clubhouseModeStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentSettingsPages } from '../agentSettingsPages';
import { AgentDetails } from './AgentDetails';
import {
  accessLabel, instructionsLabel, isRowLocked, LOCKED_HINT, modelLabel, settingsSummary,
} from './SettingsCard';
import { useAgentDetailsStore } from './detailsStore';

const agent: Agent = {
  id: 'a1', projectId: 'p1', name: 'faithful-urchin', kind: 'durable', status: 'running', color: 'teal',
  orchestrator: 'claude-code', worktreePath: '/work/proj/.clubhouse/agents/faithful-urchin',
};

function chatState(over: Partial<ChatViewState> = {}): ChatViewState {
  return {
    ...createChatViewState('a1'),
    provider: 'claude-code', cliVersion: '2.1.0', model: 'claude-opus-5-5', effort: 'high', effortReported: true,
    level: 'full_access', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }],
    ...over,
  };
}

let saved: Record<string, unknown>;

beforeEach(() => {
  saved = { idleSleep: 30 };
  localStorage.clear();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useAgentDetailsStore.setState({ open: true, settingsOpen: false, focus: null });
  useChatIdleSettingsStore.setState({ idleTimeoutMinutes: 60 } as never);
  useOrchestratorStore.setState({
    allOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { permissions: true } },
      { id: 'codex-cli', displayName: 'Codex', shortName: 'CX', capabilities: { permissions: false } },
    ] as never,
  });
  useClubhouseModeStore.setState({ enabled: true, projectOverrides: {}, loadSettings: vi.fn(async () => {}) } as never);
  window.clubhouse.settings.get = vi.fn(async () => ({ idleTimeoutMinutes: 60 })) as never;
  window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
  window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'a1', ...saved })) as never;
  window.clubhouse.agent.updateDurableConfig = vi.fn(async (_p: string, _id: string, updates: Record<string, unknown>) => {
    Object.assign(saved, updates);
  }) as never;
  window.clubhouse.project.readDefaultMcps = vi.fn(async () => ['github', 'linear']) as never;
  window.clubhouse.project.readLaunchWrapper = vi.fn(async () => ({ binary: 'wrap' })) as never;
  window.clubhouse.agentSettings.readMcpConfig = vi.fn(async () => [{ name: 'playwright' }]) as never;
  window.clubhouse.agentSettings.readInstructions = vi.fn(async () => 'one\ntwo\nthree\n') as never;
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

function openSettings() {
  fireEvent.click(screen.getByTestId('details-card-settings-toggle'));
  return within(screen.getByTestId('details-card-settings'));
}

describe('settings helpers', () => {
  it('locks only rows that change while asleep, and only while running', () => {
    expect(isRowLocked('sleeping', true)).toBe(true);
    expect(isRowLocked('sleeping', false)).toBe(false);
    expect(isRowLocked('always', true)).toBe(false);
    expect(isRowLocked('never', true)).toBe(false);
  });

  it('builds the summary from what is known', () => {
    expect(settingsSummary({ runsIn: 'Chat', model: 'Opus 5.5', access: 'Full access', autoSleep: 'Sleeps after 30 min' }))
      .toBe('Chat · Opus 5.5 · Full access · Sleeps after 30 min');
    expect(settingsSummary({ runsIn: 'Terminal', model: 'Default model', access: 'Ask before edits', autoSleep: null }))
      .toBe('Terminal · Default model · Ask before edits');
  });

  it('names models, access and instructions in sentence case', () => {
    expect(modelLabel('default')).toBe('Default model');
    expect(modelLabel(undefined)).toBe('Default model');
    // A live session that hasn't resolved its model yet (#2293) reads the same as the composer chip.
    expect(modelLabel(null, { models: [{ id: 'claude-sonnet-5.5', label: 'Sonnet 5.5' }] })).toBe('Default model');
    expect(modelLabel('sonnet', { models: [] })).toBe('sonnet');
    expect(modelLabel('claude-opus-5-5', { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] })).toBe('Opus 5.5');
    expect(accessLabel({ level: 'auto', levelNames: { auto: 'Agent' } }, false, true)).toBe('Agent');
    expect(accessLabel({ level: 'ask', levelNames: {} }, false, true)).toBe('Ask first');
    expect(accessLabel(undefined, true, true)).toBe('Free agent');
    expect(accessLabel(undefined, false, true)).toBe('Ask before edits');
    expect(accessLabel(undefined, true, false)).toBe('Set by the CLI');
    expect(instructionsLabel('project-manager', null)).toBe('Project Manager');
    expect(instructionsLabel('dispatcher', null)).toBe('Dispatcher');
    expect(instructionsLabel(undefined, 'a\nb\n')).toBe('Custom, 2 lines');
    expect(instructionsLabel(undefined, 'a')).toBe('Custom, 1 line');
    expect(instructionsLabel(undefined, '  \n')).toBeNull();
  });
});

describe('Settings card (#2280)', () => {
  it('is the first card, collapsed, with a summary of the current values', async () => {
    render(<AgentDetails agent={agent} chat={chatState()} />);
    const cards = screen.getAllByTestId(/^details-card-[a-z]+$/);
    expect(cards[0]).toHaveAttribute('data-testid', 'details-card-settings');
    expect(cards[0]).not.toHaveAttribute('data-open');
    await waitFor(() => expect(screen.getByTestId('details-card-settings-summary'))
      .toHaveTextContent('Chat · Opus 5.5 · Full access · Sleeps after 30 min'));
  });

  it('remembers whether it is open in the details store', () => {
    const { unmount } = render(<AgentDetails agent={agent} chat={chatState()} />);
    openSettings();
    expect(useAgentDetailsStore.getState().settingsOpen).toBe(true);
    expect(localStorage.getItem('clubhouse.agentDetails.settingsOpen')).toBe('1');
    unmount();
    render(<AgentDetails agent={{ ...agent, id: 'a2' }} chat={chatState()} />);
    expect(screen.getByTestId('details-card-settings')).toHaveAttribute('data-open', 'true');
  });

  it('lists the chat agent\'s settings, read-only while running except auto-sleep', async () => {
    saved = { idleSleep: 30, mcpIds: ['github'], persona: 'project-manager' };
    render(<AgentDetails agent={agent} chat={chatState()} />);
    const card = openSettings();
    expect(card.getByTestId('details-setting-cli')).toHaveTextContent('Claude Code 2.1.0');
    expect(card.getByTestId('details-setting-runs-in')).toHaveTextContent('Chat');
    expect(card.getByTestId('details-setting-model')).toHaveTextContent('Opus 5.5');
    expect(card.getByTestId('details-setting-effort')).toHaveTextContent('High');
    expect(card.getByTestId('details-setting-access')).toHaveTextContent('Full access');
    expect(card.getByTestId('details-setting-clubhouse-mode')).toHaveTextContent('On');
    // github from the wrapper (the agent's own pick) plus playwright from .mcp.json.
    await waitFor(() => expect(card.getByTestId('details-setting-mcp')).toHaveTextContent('2 enabled'));
    expect(window.clubhouse.project.readDefaultMcps).not.toHaveBeenCalled();
    await waitFor(() => expect(card.getByTestId('details-setting-instructions')).toHaveTextContent('Project Manager'));

    // Spawn settings are locked while it runs, with one hint tied to them.
    const hint = card.getByTestId('details-settings-locked-hint');
    expect(hint).toHaveTextContent(LOCKED_HINT);
    for (const id of ['runs-in', 'model', 'access', 'clubhouse-mode']) {
      const row = card.getByTestId(`details-setting-${id}`);
      expect(row).toHaveAttribute('data-locked', 'true');
      expect(row).toHaveAttribute('aria-describedby', hint.id);
    }
    // Read-only summaries and live-editable auto-sleep aren't "locked".
    for (const id of ['cli', 'effort', 'mcp', 'instructions', 'auto-sleep']) {
      expect(card.getByTestId(`details-setting-${id}`)).not.toHaveAttribute('data-locked');
    }
    expect(card.queryByRole('combobox', { name: /model/i })).not.toBeInTheDocument();
  });

  it('keeps auto-sleep editable while running and applies it live', async () => {
    render(<AgentDetails agent={agent} chat={chatState()} />);
    const card = openSettings();
    const select = card.getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(select.value).toBe('30');
    fireEvent.change(select, { target: { value: 'never' } });
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenLastCalledWith('/work/proj', 'a1', { idleSleep: 'never' }));
    await waitFor(() => expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('Never sleeps'));
  });

  it('rolls auto-sleep and the summary back when the save fails', async () => {
    window.clubhouse.agent.updateDurableConfig = vi.fn(async () => { throw new Error('disk full'); }) as never;
    render(<AgentDetails agent={agent} chat={chatState()} />);
    const card = openSettings();
    const select = card.getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: '240' } });
    await waitFor(() => expect(card.getByTestId('details-auto-sleep-source')).toHaveTextContent('Couldn’t save'));
    expect(select.value).toBe('30');
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('Sleeps after 30 min');
  });

  it('shows a terminal agent on a CLI without permissions, falling back to the project MCP defaults', async () => {
    saved = { model: 'gpt-5.5', freeAgentMode: true };
    const codex: Agent = { ...agent, orchestrator: 'codex-cli' };
    render(<AgentDetails agent={codex} />);
    await waitFor(() => expect(screen.getByTestId('details-card-settings-summary'))
      .toHaveTextContent('Terminal · gpt-5.5 · Set by the CLI'));
    const card = openSettings();
    expect(card.getByTestId('details-setting-cli')).toHaveTextContent('Codex');
    expect(card.queryByTestId('details-setting-effort')).not.toBeInTheDocument();
    // Only chat agents idle-sleep.
    expect(card.queryByTestId('details-setting-auto-sleep')).not.toBeInTheDocument();
    // No pick of its own: the project defaults, plus .mcp.json.
    await waitFor(() => expect(card.getByTestId('details-setting-mcp')).toHaveTextContent('3 enabled'));
    await waitFor(() => expect(card.getByTestId('details-setting-instructions')).toHaveTextContent('Custom, 3 lines'));
    expect(window.clubhouse.project.readDefaultMcps).toHaveBeenCalledWith('/work/proj');
  });

  it('shows Free agent mode for a terminal Claude agent and Clubhouse mode off for this agent', async () => {
    saved = { freeAgentMode: true, clubhouseModeOverride: true };
    render(<AgentDetails agent={agent} />);
    const card = openSettings();
    await waitFor(() => expect(card.getByTestId('details-setting-access')).toHaveTextContent('Free agent'));
    expect(card.getByTestId('details-setting-clubhouse-mode')).toHaveTextContent('Off for this agent');
  });

  it('has no hint and no locked rows when the agent isn\'t running', async () => {
    render(<AgentDetails agent={{ ...agent, status: 'sleeping' }} />);
    const card = openSettings();
    await waitFor(() => expect(card.getByTestId('details-setting-mcp')).not.toHaveTextContent('Loading'));
    expect(card.queryByTestId('details-settings-locked-hint')).not.toBeInTheDocument();
    expect(card.getByTestId('details-setting-model')).not.toHaveAttribute('data-locked');
  });

  it('opens the full settings on General from "All settings"', () => {
    const openAgentSettings = vi.fn();
    useAgentStore.setState({ openAgentSettings } as never);
    act(() => { useAgentSettingsPages.getState().setPage('mcp'); });
    render(<AgentDetails agent={agent} chat={chatState()} />);
    fireEvent.click(openSettings().getByTestId('details-all-settings'));
    expect(openAgentSettings).toHaveBeenCalledWith('a1');
    expect(useAgentSettingsPages.getState().page).toBe('general');
  });
});

describe('Settings card edge cases', () => {
  it('counts only .mcp.json servers when the project has no launch wrapper', async () => {
    window.clubhouse.project.readLaunchWrapper = vi.fn(async () => undefined) as never;
    render(<AgentDetails agent={agent} />);
    const card = openSettings();
    await waitFor(() => expect(card.getByTestId('details-setting-mcp')).toHaveTextContent('1 enabled'));
    expect(window.clubhouse.project.readDefaultMcps).not.toHaveBeenCalled();
  });

  it('says it couldn\'t read rather than loading forever', async () => {
    window.clubhouse.agentSettings.readMcpConfig = vi.fn(async () => { throw new Error('nope'); }) as never;
    window.clubhouse.agentSettings.readInstructions = vi.fn(async () => { throw new Error('nope'); }) as never;
    render(<AgentDetails agent={agent} />);
    const card = openSettings();
    await waitFor(() => expect(card.getByTestId('details-setting-mcp')).toHaveTextContent('Couldn’t read'));
    await waitFor(() => expect(card.getByTestId('details-setting-instructions')).toHaveTextContent('Couldn’t read'));
  });

  it('reads nothing for a quick agent and offers no All settings', () => {
    const quick: Agent = { ...agent, kind: 'quick' };
    render(<AgentDetails agent={quick} />);
    const card = openSettings();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(card.queryByTestId('details-all-settings')).not.toBeInTheDocument();
    expect(card.queryByTestId('details-setting-mcp')).not.toBeInTheDocument();
    expect(card.getByTestId('details-setting-model')).toBeInTheDocument();
  });

  it('reads no config for an agent on another machine and leaves out local-only rows', () => {
    const remote: Agent = { ...agent, projectId: 'remote||sat-1||p1' };
    render(<AgentDetails agent={remote} chat={chatState()} />);
    const card = openSettings();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
    expect(card.queryByTestId('details-setting-auto-sleep')).not.toBeInTheDocument();
    expect(card.queryByTestId('details-setting-clubhouse-mode')).not.toBeInTheDocument();
    expect(card.getByTestId('details-setting-access')).toHaveTextContent('Full access');
  });

  it('shows the CLI\'s own access for a chat driver without levels', async () => {
    const codex: Agent = { ...agent, orchestrator: 'codex-cli' };
    render(<AgentDetails agent={codex} chat={chatState({ provider: 'codex-cli', level: null, model: 'gpt-5.5', models: [], effortReported: false })} />);
    await waitFor(() => expect(screen.getByTestId('details-card-settings-summary'))
      .toHaveTextContent('Chat · gpt-5.5 · Set by the CLI · Sleeps after 30 min'));
    expect(openSettings().queryByTestId('details-setting-effort')).not.toBeInTheDocument();
  });

  it('keeps an auto-sleep change when the config couldn\'t be read', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => { throw new Error('locked'); }) as never;
    render(<AgentDetails agent={agent} chat={chatState()} />);
    const card = openSettings();
    const select = card.getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: '15' } });
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1', { idleSleep: 15 }));
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(select.value).toBe('15');
  });

  it('never shows the previous agent\'s config after switching agents', async () => {
    const pending: Record<string, (v: unknown) => void> = {};
    window.clubhouse.agent.getDurableConfig = vi.fn((_p: string, id: string) => new Promise((r) => { pending[id] = r; })) as never;
    const { rerender } = render(<AgentDetails agent={agent} />);
    rerender(<AgentDetails agent={{ ...agent, id: 'a2' }} />);
    await waitFor(() => expect(pending.a2).toBeDefined());
    await act(async () => { pending.a1({ id: 'a1', model: 'from-a1' }); });
    expect(screen.getByTestId('details-card-settings-summary')).not.toHaveTextContent('from-a1');
    await act(async () => { pending.a2({ id: 'a2', model: 'from-a2' }); });
    expect(screen.getByTestId('details-card-settings-summary')).toHaveTextContent('from-a2');
  });
});

describe('Session card after #2280', () => {
  it('keeps live stats only', () => {
    render(<AgentDetails agent={agent} chat={chatState()} />);
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const session = within(screen.getByTestId('details-card-session'));
    expect(session.queryByTestId('details-auto-sleep')).not.toBeInTheDocument();
    expect(session.queryByText('Model')).not.toBeInTheDocument();
    expect(session.queryByText('Level')).not.toBeInTheDocument();
    expect(session.getByText('Runs on')).toBeInTheDocument();
    expect(session.getByText('Usage')).toBeInTheDocument();
  });
});
