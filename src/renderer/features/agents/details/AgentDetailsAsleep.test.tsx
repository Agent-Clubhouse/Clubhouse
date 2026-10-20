import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useChatIdleSettingsStore } from '../../../stores/chatIdleSettingsStore';
import { useClubhouseModeStore } from '../../../stores/clubhouseModeStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { resetChatFlagCache } from '../chat/AgentRuntimePane';
import type { LastSessionInfo } from '../states/useLastSession';
import { AgentDetails } from './AgentDetails';
import { LOCKED_HINT, NEXT_WAKE_NOTE } from './SettingsCard';
import { useAgentDetailsStore } from './detailsStore';

const sleeping: Agent = {
  id: 'a1', projectId: 'p1', name: 'faithful-urchin', kind: 'durable', status: 'sleeping', color: 'teal',
  orchestrator: 'claude-code', worktreePath: '/work/proj/.clubhouse/agents/faithful-urchin',
  lastSleep: { reason: 'idle', idleMinutes: 30, at: new Date(Date.now() - 2 * 3600_000).toISOString() },
};

const last: LastSessionInfo = {
  sessionId: 's1', loading: false, summary: 'Did things', filesModified: [], lastActiveAt: Date.now() - 2 * 3600_000,
  durationMs: 45 * 60_000, costUsd: 1.25, ahead: 0, remote: '', uncommitted: 0, hasGit: true,
};

/** agents.json for a1, as main keeps it. */
let saved: Record<string, unknown>;
let chatFlag: boolean;

beforeEach(() => {
  saved = { idleSleep: 30 };
  chatFlag = true;
  localStorage.clear();
  resetChatFlagCache();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useAgentDetailsStore.setState({ open: true, settingsOpen: true, focus: null });
  useChatIdleSettingsStore.setState({ idleTimeoutMinutes: 60 } as never);
  useAgentStore.setState({ agents: { a1: sleeping } } as never);
  useOrchestratorStore.setState({
    allOrchestrators: [{ id: 'claude-code', displayName: 'Claude Code', shortName: 'CC', capabilities: { permissions: true } }] as never,
  });
  useClubhouseModeStore.setState({ enabled: true, projectOverrides: {}, loadSettings: vi.fn(async () => {}) } as never);
  window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ chat: chatFlag })) as never;
  window.clubhouse.app.isPreviewEligible = vi.fn(async () => true) as never;
  // Main's answer for a sleeping agent: the runtime its next wake starts in.
  window.clubhouse.chat.getAgentRuntime = vi.fn(async () => ({ chat: saved.runtimeMode !== 'terminal', live: false, chatAvailable: true })) as never;
  window.clubhouse.settings.get = vi.fn(async () => ({ idleTimeoutMinutes: 60 })) as never;
  window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
  window.clubhouse.agent.getModelOptions = vi.fn(async () => [{ id: 'default', label: 'Default' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }]) as never;
  window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'a1', ...saved })) as never;
  window.clubhouse.agent.updateDurableConfig = vi.fn(async (_p: string, _id: string, updates: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === false || v === 'default') delete saved[k]; else saved[k] = v;
    }
  }) as never;
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

function settings() {
  return within(screen.getByTestId('details-card-settings'));
}

/**
 * The Model select once its options have loaded. Enabled alone isn't enough: until the
 * options arrive, a change to a model it doesn't list yet reads back as '' (#2375).
 */
async function loadedModelSelect(id: string) {
  const model = await settings().findByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
  await waitFor(() => {
    expect(model).not.toBeDisabled();
    expect(model.querySelector(`option[value="${id}"]`)).not.toBeNull();
  });
  return model;
}

describe('Agent details for a sleeping agent (#2281)', () => {
  it('shows Settings, Changes, Canvases and the last session, and leaves out live-only cards', () => {
    render(<AgentDetails agent={sleeping} lastSession={last} />);
    for (const id of ['settings', 'changes', 'canvases', 'session']) expect(screen.getByTestId(`details-card-${id}`)).toBeInTheDocument();
    for (const id of ['subagents', 'context', 'mcp']) {
      expect(screen.queryByTestId(`details-card-${id}`)).not.toBeInTheDocument();
    }
  });

  it('shows the last session with when, how long, cost and why it slept', () => {
    render(<AgentDetails agent={sleeping} lastSession={last} />);
    expect(screen.getByTestId('details-card-session-summary')).toHaveTextContent('2h ago · 45m · $1.25');
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    const card = within(screen.getByTestId('details-card-session'));
    expect(card.getByText('Last session')).toBeInTheDocument();
    expect(card.getByText('Slept after 30 min idle')).toBeInTheDocument();
    expect(card.getByText('$1.25')).toBeInTheDocument();
  });

  it('shows the sleep reason at once and the last session when it arrives', () => {
    const { rerender } = render(<AgentDetails agent={sleeping} lastSession={null} />);
    expect(screen.getByTestId('details-card-session-summary')).toHaveTextContent('2h ago');
    expect(screen.getByTestId('details-card-session-summary')).not.toHaveTextContent('$');
    // The session id is known first; the summary fills in later.
    rerender(<AgentDetails agent={sleeping} lastSession={{ ...last, loading: true, durationMs: 0, costUsd: 0 }} />);
    fireEvent.click(screen.getByTestId('details-card-session-toggle'));
    expect(screen.getByTestId('details-last-session-loading')).toBeInTheDocument();
    rerender(<AgentDetails agent={sleeping} lastSession={last} />);
    expect(screen.getByTestId('details-card-session-summary')).toHaveTextContent('$1.25');
    expect(screen.queryByTestId('details-last-session-loading')).not.toBeInTheDocument();
  });

  it('makes the spawn settings editable, with no lock hint and the next-wake note', async () => {
    render(<AgentDetails agent={sleeping} />);
    await waitFor(() => expect(settings().getByRole('combobox', { name: 'Model' })).toBeInTheDocument());
    expect(settings().getByRole('switch', { name: 'Free agent mode' })).toBeInTheDocument();
    expect(settings().getByRole('switch', { name: 'Clubhouse mode for this agent' })).toBeInTheDocument();
    await waitFor(() => expect(settings().getByRole('combobox', { name: 'Runs in' })).toBeInTheDocument());
    expect(settings().getByTestId('details-settings-next-wake')).toHaveTextContent(NEXT_WAKE_NOTE);
    expect(settings().queryByText(LOCKED_HINT)).not.toBeInTheDocument();
    // Read-only summaries stay read-only.
    expect(within(settings().getByTestId('details-setting-mcp')).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('saves each setting to the agent config and keeps the agent store in step', async () => {
    render(<AgentDetails agent={sleeping} />);
    const model = await loadedModelSelect('opus');
    fireEvent.change(model, { target: { value: 'opus' } });
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1', { model: 'opus' }));
    await waitFor(() => expect(useAgentStore.getState().agents.a1.model).toBe('opus'));

    fireEvent.click(settings().getByRole('switch', { name: 'Free agent mode' }));
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1', { freeAgentMode: true }));
    await waitFor(() => expect(settings().getByTestId('details-setting-access')).toHaveTextContent('Free agent'));

    fireEvent.click(settings().getByRole('switch', { name: 'Clubhouse mode for this agent' }));
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1', { clubhouseModeOverride: true }));

    const runsIn = await settings().findByRole('combobox', { name: 'Runs in' });
    fireEvent.change(runsIn, { target: { value: 'terminal' } });
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1', { runtimeMode: 'terminal' }));
    expect(saved).toMatchObject({ model: 'opus', freeAgentMode: true, clubhouseModeOverride: true, runtimeMode: 'terminal' });
    // Waking into the terminal: no idle sleep, so the Auto-sleep row goes.
    await waitFor(() => expect(settings().queryByTestId('details-setting-auto-sleep')).not.toBeInTheDocument());
  });

  it('rolls a failed save back and says so on that row', async () => {
    window.clubhouse.agent.updateDurableConfig = vi.fn(async () => { throw new Error('disk full'); }) as never;
    render(<AgentDetails agent={sleeping} />);
    const toggle = await settings().findByRole('switch', { name: 'Free agent mode' });
    fireEvent.click(toggle);
    await waitFor(() => expect(settings().getByTestId('details-setting-access-error')).toHaveTextContent('Couldn’t save'));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(settings().getByTestId('details-setting-access')).toHaveTextContent('Ask before edits');
  });

  it('keeps an edit across a wake: saved for the spawn, then locked and shown while it runs', async () => {
    const { rerender } = render(<AgentDetails agent={sleeping} />);
    const model = await loadedModelSelect('sonnet');
    fireEvent.change(model, { target: { value: 'sonnet' } });
    const save = vi.mocked(window.clubhouse.agent.updateDurableConfig);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('/work/proj', 'a1', { model: 'sonnet' });
    await save.mock.results[0].value;
    expect(saved.model).toBe('sonnet');
    await waitFor(() => expect(useAgentStore.getState().agents.a1.model).toBe('sonnet'));
    // The wake reads agents.json; then the agent runs with it.
    const awake = { ...useAgentStore.getState().agents.a1, status: 'running' as const };
    rerender(<AgentDetails agent={awake} />);
    const row = settings().getByTestId('details-setting-model');
    expect(row).toHaveTextContent('sonnet');
    expect(row).toHaveAttribute('data-locked', 'true');
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(settings().getByText(LOCKED_HINT)).toBeInTheDocument();
  });

  // #2375: a change before the provider lists its models used to save model: '' and drop the saved model.
  // React still runs onChange for a disabled select here, so this checks the card's guard, not only the attribute.
  it('saves nothing from the Model select until its options have loaded', async () => {
    saved.model = 'opus';
    let list!: (v: unknown) => void;
    window.clubhouse.agent.getModelOptions = vi.fn(() => new Promise((r) => { list = r; })) as never;
    render(<AgentDetails agent={sleeping} />);
    const model = await settings().findByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(model).toBeDisabled();
    fireEvent.change(model, { target: { value: 'sonnet' } });
    fireEvent.change(model, { target: { value: 'default' } });
    expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    expect(saved.model).toBe('opus');

    list([{ id: 'default', label: 'Default' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }]);
    await loadedModelSelect('sonnet');
    expect(model.value).toBe('opus');
  });

  it('saves nothing for a model the provider did not list', async () => {
    saved.model = 'opus';
    render(<AgentDetails agent={sleeping} />);
    const model = await loadedModelSelect('sonnet');
    // A value with no option (here a model the list dropped) reads back as ''.
    fireEvent.change(model, { target: { value: 'haiku' } });
    expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    expect(saved.model).toBe('opus');
  });

  it('shows the terminal and no Runs in control with the Chat flag off', async () => {
    chatFlag = false;
    render(<AgentDetails agent={sleeping} />);
    await waitFor(() => expect(settings().getByTestId('details-setting-runs-in')).toHaveTextContent('Terminal'));
    expect(settings().queryByRole('combobox', { name: 'Runs in' })).not.toBeInTheDocument();
    expect(settings().queryByTestId('details-setting-auto-sleep')).not.toBeInTheDocument();
  });

  it('keeps auto-sleep for an agent that wakes into chat', async () => {
    render(<AgentDetails agent={sleeping} />);
    const select = await settings().findByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: '15' } });
    await waitFor(() => expect(saved.idleSleep).toBe(15));
  });

  it('is read-only for an agent on another machine', () => {
    useRemoteProjectStore.setState({ satelliteProjects: { 'sat-1': [{ id: 'remote||sat-1||p1', name: 'proj', path: '/x', remote: true, satelliteId: 'sat-1', satelliteName: 'studio-mac' }] } } as never);
    const remote: Agent = { ...sleeping, id: 'remote||sat-1||a1', projectId: 'remote||sat-1||p1' };
    render(<AgentDetails agent={remote} />);
    expect(settings().queryByRole('combobox')).not.toBeInTheDocument();
    expect(settings().queryByRole('switch')).not.toBeInTheDocument();
    expect(settings().getByTestId('details-settings-remote')).toHaveTextContent('Change on studio-mac');
    expect(settings().queryByTestId('details-all-settings')).not.toBeInTheDocument();
    expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
  });

  it('keeps the Runs in select and row while main re-answers after a change', async () => {
    saved.runtimeMode = 'chat';
    let answer!: (v: unknown) => void;
    render(<AgentDetails agent={sleeping} />);
    const select = await settings().findByRole('combobox', { name: 'Runs in' }) as HTMLSelectElement;
    window.clubhouse.chat.getAgentRuntime = vi.fn(() => new Promise((r) => { answer = r; })) as never;
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1', { runtimeMode: null }));
    // Still asking main which runtime the provider default means: the control stays put.
    await waitFor(() => expect(window.clubhouse.chat.getAgentRuntime).toHaveBeenCalled());
    expect(settings().getByRole('combobox', { name: 'Runs in' })).toBe(select);
    expect(settings().getByTestId('details-setting-auto-sleep')).toBeInTheDocument();
    answer({ chat: false, live: false, chatAvailable: true });
    await waitFor(() => expect(settings().getByTestId('details-setting-runs-in')).toHaveTextContent('Terminal'));
  });

  it('rolls a failed select back to the saved value', async () => {
    saved.model = 'sonnet';
    window.clubhouse.agent.updateDurableConfig = vi.fn(async () => { throw new Error('disk full'); }) as never;
    render(<AgentDetails agent={sleeping} />);
    const model = await loadedModelSelect('opus');
    expect(model.value).toBe('sonnet');
    fireEvent.change(model, { target: { value: 'opus' } });
    await waitFor(() => expect(settings().getByTestId('details-setting-model-error')).toHaveTextContent('Couldn’t save'));
    expect(model.value).toBe('sonnet');
    expect(useAgentStore.getState().agents.a1.model).toBeUndefined();
  });

  it('is editable for an agent that failed to start, and locked while one wakes', async () => {
    const { rerender } = render(<AgentDetails agent={{ ...sleeping, status: 'error' }} />);
    expect(await settings().findByRole('combobox', { name: 'Model' })).toBeInTheDocument();
    rerender(<AgentDetails agent={{ ...sleeping, status: 'waking' }} />);
    expect(settings().queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
    expect(settings().getByTestId('details-setting-model')).toHaveAttribute('data-locked', 'true');
    expect(settings().getByText(LOCKED_HINT)).toBeInTheDocument();
  });

  it('offers no controls when the config couldn\'t be read', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => { throw new Error('locked'); }) as never;
    render(<AgentDetails agent={sleeping} />);
    expect(await settings().findByTestId('details-settings-unreadable')).toBeInTheDocument();
    expect(settings().queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument();
    expect(settings().queryByRole('switch')).not.toBeInTheDocument();
  });

  it('keeps one agent\'s save state from another after switching agents', async () => {
    let finishA!: () => void;
    window.clubhouse.agent.updateDurableConfig = vi.fn((_p: string, id: string) => (id === 'a1'
      ? new Promise<void>((r) => { finishA = r; })
      : new Promise<void>(() => { /* b2 stays saving */ }))) as never;
    const b2: Agent = { ...sleeping, id: 'b2', name: 'other' };
    useAgentStore.setState({ agents: { a1: sleeping, b2 } } as never);
    const { rerender } = render(<AgentDetails agent={sleeping} />);
    fireEvent.click(await settings().findByRole('switch', { name: 'Free agent mode' }));
    rerender(<AgentDetails agent={b2} />);
    const toggleB = await settings().findByRole('switch', { name: 'Free agent mode' });
    await waitFor(() => expect(toggleB).not.toBeDisabled());
    fireEvent.click(toggleB);
    expect(toggleB).toBeDisabled();
    finishA();
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(toggleB).toBeDisabled();
  });
});

