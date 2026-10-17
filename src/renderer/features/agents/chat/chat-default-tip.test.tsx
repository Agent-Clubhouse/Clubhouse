import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { useUIStore } from '../../../stores/uiStore';
import { useProjectStore } from '../../../stores/projectStore';
import {
  CHAT_DEFAULT_TIP_KEY,
  CHAT_DEFAULT_TIP_TEXT,
  isChatTipResolved,
  shouldShowChatDefaultTip,
} from './chat-default-tip';
import { ChatDefaultTip, resetChatDefaultTipClaim } from './ChatDefaultTip';

const agent = { id: 'a1', name: 'Scout', projectId: 'p1', orchestrator: 'claude-code', kind: 'durable', status: 'running' } as Agent;

const getRuntimeSettings = vi.fn();
const getDurableConfig = vi.fn();

beforeEach(() => {
  localStorage.removeItem(CHAT_DEFAULT_TIP_KEY);
  resetChatDefaultTipClaim();
  getRuntimeSettings.mockReset().mockResolvedValue({});
  getDurableConfig.mockReset().mockResolvedValue({ id: 'a1' });
  window.clubhouse.chat.getRuntimeSettings = getRuntimeSettings;
  window.clubhouse.agent.getDurableConfig = getDurableConfig;
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'p', path: '/proj' }] } as never);
});

afterEach(() => localStorage.removeItem(CHAT_DEFAULT_TIP_KEY));

describe('shouldShowChatDefaultTip', () => {
  it('shows when chat came from the provider default', async () => {
    expect(await shouldShowChatDefaultTip(agent, '/proj')).toBe(true);
    expect(getDurableConfig).toHaveBeenCalledWith('/proj', 'a1');
  });

  it('never shows once resolved', async () => {
    localStorage.setItem(CHAT_DEFAULT_TIP_KEY, 'dismissed');
    expect(await shouldShowChatDefaultTip(agent, '/proj')).toBe(false);
    expect(getRuntimeSettings).not.toHaveBeenCalled();
  });

  it('never shows for users who explicitly chose Terminal for any provider', async () => {
    getRuntimeSettings.mockResolvedValue({ 'codex-cli': { mode: 'terminal' } });
    expect(await shouldShowChatDefaultTip(agent, '/proj')).toBe(false);
    expect(localStorage.getItem(CHAT_DEFAULT_TIP_KEY)).toBe('chose_terminal');
  });

  it('does not show when the provider or agent was explicitly set to Chat', async () => {
    getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'chat' } });
    expect(await shouldShowChatDefaultTip(agent, '/proj')).toBe(false);
    localStorage.removeItem(CHAT_DEFAULT_TIP_KEY);
    getRuntimeSettings.mockResolvedValue({});
    getDurableConfig.mockResolvedValue({ id: 'a1', runtimeMode: 'chat' });
    expect(await shouldShowChatDefaultTip(agent, '/proj')).toBe(false);
  });

  it('treats an agent set to Terminal as an explicit Terminal choice', async () => {
    getDurableConfig.mockResolvedValue({ id: 'a1', runtimeMode: 'terminal' });
    expect(await shouldShowChatDefaultTip(agent, '/proj')).toBe(false);
    expect(isChatTipResolved()).toBe(true);
  });

  it('counts unavailable storage as resolved, so it never nags', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(isChatTipResolved()).toBe(true);
    spy.mockRestore();
  });
});

describe('ChatDefaultTip', () => {
  it('shows once, remembered as soon as it is seen', async () => {
    const { unmount } = render(<ChatDefaultTip agent={agent} />);
    expect(await screen.findByText(CHAT_DEFAULT_TIP_TEXT)).toBeInTheDocument();
    expect(localStorage.getItem(CHAT_DEFAULT_TIP_KEY)).toBe('shown');
    unmount();
    resetChatDefaultTipClaim();
    render(<ChatDefaultTip agent={agent} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('chat-default-tip')).not.toBeInTheDocument();
  });

  it('Got it hides it', async () => {
    render(<ChatDefaultTip agent={agent} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('chat-default-tip')).not.toBeInTheDocument();
    expect(localStorage.getItem(CHAT_DEFAULT_TIP_KEY)).toBe('dismissed');
  });

  it('Open settings deep-links to the provider runtime setting', async () => {
    useUIStore.setState({ explorerTab: 'agents', settingsSubPage: 'about', settingsContext: 'p1', settingsFocus: null });
    render(<ChatDefaultTip agent={{ ...agent, orchestrator: 'codex-cli' } as Agent} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    expect(useUIStore.getState()).toMatchObject({
      explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'orchestrators', settingsFocus: 'runtime:codex-cli',
    });
    expect(screen.queryByTestId('chat-default-tip')).not.toBeInTheDocument();
    expect(localStorage.getItem(CHAT_DEFAULT_TIP_KEY)).toBe('opened_settings');
  });

  it('shows in only one pane when several chat agents mount together', async () => {
    render(<><ChatDefaultTip agent={agent} /><ChatDefaultTip agent={{ ...agent, id: 'a2' } as Agent} /></>);
    await waitFor(() => expect(screen.getAllByTestId('chat-default-tip')).toHaveLength(1));
  });
});
