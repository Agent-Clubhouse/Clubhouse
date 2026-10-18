import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { createChatViewState } from '../../../stores/chatStore';
import { useChatIdleSettingsStore } from '../../../stores/chatIdleSettingsStore';
import { useProjectStore } from '../../../stores/projectStore';
import { AgentDetails } from './AgentDetails';
import { autoSleepSource } from './AutoSleepRow';
import { useAgentDetailsStore } from './detailsStore';

const agent: Agent = {
  id: 'a1', projectId: 'p1', name: 'faithful-urchin', kind: 'durable', status: 'running', color: 'teal',
  orchestrator: 'claude-code', worktreePath: '/work/proj/.clubhouse/agents/faithful-urchin',
};
const chat = createChatViewState('a1');

let saved: Record<string, unknown>;

beforeEach(() => {
  saved = {};
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useAgentDetailsStore.setState({ open: true, focus: null });
  useChatIdleSettingsStore.setState({ idleTimeoutMinutes: 30 } as never);
  window.clubhouse.settings.get = vi.fn(async () => ({ idleTimeoutMinutes: 30 })) as never;
  window.clubhouse.git.branchChanges = vi.fn(async () => ({ available: false, files: [] }));
  window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'a1', ...saved })) as never;
  window.clubhouse.agent.updateDurableConfig = vi.fn(async (_p: string, _id: string, updates: Record<string, unknown>) => {
    if (updates.idleSleep === null) delete saved.idleSleep; else saved.idleSleep = updates.idleSleep;
  }) as never;
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

function openSession() {
  fireEvent.click(screen.getByTestId('details-card-session-toggle'));
  return within(screen.getByTestId('details-card-session'));
}

describe('autoSleepSource', () => {
  it('says where the value comes from', () => {
    expect(autoSleepSource('inherit', 30)).toBe('App default: 30 min');
    expect(autoSleepSource(15, 240)).toBe('Set for this agent. App default: 4 h');
    expect(autoSleepSource('never', 0)).toBe('Set for this agent. App default: Never');
  });
});

describe('Auto-sleep in the Session card (#2143)', () => {
  it('shows the app default for an agent that inherits', async () => {
    render(<AgentDetails agent={agent} chat={chat} />);
    const card = openSession();
    const select = card.getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(select.value).toBe('inherit');
    expect(card.getByRole('option', { name: 'App default (30 min)' })).toBeInTheDocument();
    expect(card.getByTestId('details-auto-sleep-source')).toHaveTextContent('App default: 30 min');
    expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalledWith('/work/proj', 'a1');
  });

  it('saves the agent\'s own value, and clears it back to inherit', async () => {
    render(<AgentDetails agent={agent} chat={chat} />);
    const card = openSession();
    const select = card.getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());

    fireEvent.change(select, { target: { value: '15' } });
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenLastCalledWith('/work/proj', 'a1', { idleSleep: 15 });
    expect(card.getByTestId('details-auto-sleep-source')).toHaveTextContent('Set for this agent. App default: 30 min');

    fireEvent.change(select, { target: { value: 'never' } });
    await waitFor(() => expect(saved.idleSleep).toBe('never'));

    fireEvent.change(select, { target: { value: 'inherit' } });
    await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenLastCalledWith('/work/proj', 'a1', { idleSleep: null }));
    expect(saved).not.toHaveProperty('idleSleep');
  });

  it('shows a saved value, including one outside the list', async () => {
    saved = { idleSleep: 45 };
    render(<AgentDetails agent={agent} chat={chat} />);
    const select = openSession().getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('45'));
    expect(screen.getByRole('option', { name: 'After 45 min idle' })).toBeInTheDocument();
  });

  it('goes back to the saved value when the save fails', async () => {
    saved = { idleSleep: 60 };
    window.clubhouse.agent.updateDurableConfig = vi.fn(async () => { throw new Error('disk full'); }) as never;
    render(<AgentDetails agent={agent} chat={chat} />);
    const card = openSession();
    const select = card.getByTestId('details-auto-sleep') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('60'));
    fireEvent.change(select, { target: { value: 'never' } });
    await waitFor(() => expect(card.getByTestId('details-auto-sleep-source')).toHaveTextContent('Couldn’t save'));
    expect(select.value).toBe('60');
  });

  it('is left out for terminal agents, which don\'t idle-sleep', () => {
    render(<AgentDetails agent={agent} />);
    expect(openSession().queryByTestId('details-auto-sleep')).not.toBeInTheDocument();
  });

  it('works in a popout, which has no project list, by asking main for the folder', async () => {
    useProjectStore.setState({ projects: [] });
    const isPopout = window.clubhouse.window.isPopout;
    const list = window.clubhouse.project.list;
    window.clubhouse.window.isPopout = () => true;
    window.clubhouse.project.list = vi.fn(async () => [{ id: 'p1', name: 'proj', path: '/work/proj' }]) as never;
    try {
      render(<AgentDetails agent={agent} chat={chat} />);
      const card = openSession();
      const select = await card.findByTestId('details-auto-sleep') as HTMLSelectElement;
      await waitFor(() => expect(select).not.toBeDisabled());
      fireEvent.change(select, { target: { value: '240' } });
      await waitFor(() => expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenLastCalledWith('/work/proj', 'a1', { idleSleep: 240 }));
    } finally {
      window.clubhouse.window.isPopout = isPopout;
      window.clubhouse.project.list = list;
    }
  });
});
