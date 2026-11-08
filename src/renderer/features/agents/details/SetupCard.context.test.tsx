import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { createChatViewState } from '../../../stores/chatStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useAgentSettingsPages } from '../agentSettingsPages';
import { SettingsCard } from './SettingsCard';
import { useAgentDetailsStore } from './detailsStore';

/** The Setup card shows context beside Runs on, and a model changed in the session (#2790). */

const agent: Agent = { id: 'm1', projectId: 'p1', name: 'scout', kind: 'durable', status: 'running', color: 'teal', orchestrator: 'claude-code', model: 'sonnet' };
const m = () => window.clubhouse.managed;

beforeEach(() => {
  vi.restoreAllMocks();
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/work/proj' }] as never });
  useAgentDetailsStore.setState({ open: true, settingsOpen: true, focus: null });
  vi.spyOn(m(), 'getSetup').mockResolvedValue({ ok: true, value: { version: 1, blocks: [], skills: [], mcps: [] } } as never);
  vi.spyOn(m(), 'listTemplates').mockResolvedValue({ ok: true, value: [] } as never);
  vi.spyOn(m(), 'listParts').mockResolvedValue({ ok: true, value: [] } as never);
  vi.spyOn(m(), 'status').mockResolvedValue({ ok: true, value: { managed: true, running: true, waiting: false, changes: [], cliChanged: false } } as never);
});

afterEach(() => {
  useProjectStore.setState({ projects: [] });
});

describe('Setup card context and session model (#2790)', () => {
  it('shows what the session runs with and what waits for the next start, and a model changed in the session', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'm1', model: 'sonnet', contextWindow: '500000' })) as never;
    const chat = { ...createChatViewState('m1'), model: 'opus', startModel: 'sonnet', contextLimits: { effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: null } };
    render(<SettingsCard agent={agent} chat={chat} projectPath="/work/proj" provider="Claude Code" />);
    await waitFor(() => expect(screen.getByTestId('details-setup-context')).toHaveTextContent('300K, compacts at 267K. Next start: 500K'));
    expect(screen.getByTestId('details-setup-runs-on')).toHaveTextContent('Claude Code · opus. Next start: sonnet');
  });

  it('shows a saved choice for the next start while asleep, and no row when nothing is known', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'm1', contextWindow: '500000' })) as never;
    const { unmount } = render(<SettingsCard agent={{ ...agent, status: 'sleeping' }} projectPath="/work/proj" provider="Claude Code" />);
    await waitFor(() => expect(screen.getByTestId('details-setup-context')).toHaveTextContent('Next start: 500K'));
    unmount();
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'm1' })) as never;
    render(<SettingsCard agent={{ ...agent, status: 'sleeping' }} projectPath="/work/proj" provider="Claude Code" />);
    await waitFor(() => expect(screen.getByTestId('details-setup-runs-on')).toBeInTheDocument());
    expect(screen.queryByTestId('details-setup-context')).toBeNull();
  });

  it('says nothing is waiting when the session already runs at the saved size', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'm1', contextWindow: '300000' })) as never;
    const chat = { ...createChatViewState('m1'), contextLimits: { effectiveTokens: 300000, compactAtTokens: 267000, reservedTokens: null } };
    render(<SettingsCard agent={agent} chat={chat} projectPath="/work/proj" provider="Claude Code" />);
    await waitFor(() => expect(window.clubhouse.agent.getDurableConfig).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('details-setup-context')).toHaveTextContent('300K, compacts at 267K'));
    expect(screen.getByTestId('details-setup-context')).not.toHaveTextContent('Next start');
  });

  it('opens the Settings page, where model and context are changed', async () => {
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'm1' })) as never;
    const openAgentSettings = vi.fn();
    useAgentStore.setState({ openAgentSettings } as never);
    render(<SettingsCard agent={agent} projectPath="/work/proj" provider="Claude Code" />);
    fireEvent.click(await screen.findByTestId('details-setup-open-settings'));
    expect(useAgentSettingsPages.getState().requestedPage).toEqual({ agentId: 'm1', page: 'settings' });
    expect(openAgentSettings).toHaveBeenCalledWith('m1');
  });
});
