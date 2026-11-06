import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import {
  CHAT_DEFAULT_TIP_ACTION,
  CHAT_DEFAULT_TIP_TEXT,
  CHAT_MESSAGE_SHOWN_KEY,
  CHAT_TIP_RULED_OUT_KEY,
  markChatMessageShown,
  showChatDefaultTip,
} from './chat-default-tip';

const getExperimentalSettings = vi.fn();
const isExperimentalSettingsUnreadable = vi.fn();
const getRuntimeSettings = vi.fn();
const getAgentRuntime = vi.fn();
const listDurable = vi.fn();
const listProjects = vi.fn();

const toasts = () => useToastStore.getState().toasts;

beforeEach(() => {
  localStorage.removeItem(CHAT_MESSAGE_SHOWN_KEY);
  localStorage.removeItem(CHAT_TIP_RULED_OUT_KEY);
  useToastStore.setState({ toasts: [] });
  getExperimentalSettings.mockReset().mockResolvedValue({});
  getRuntimeSettings.mockReset().mockResolvedValue({});
  getAgentRuntime.mockReset().mockResolvedValue({ chat: true });
  listDurable.mockReset().mockResolvedValue([{ id: 'a1', orchestrator: 'codex-cli' }]);
  listProjects.mockReset().mockResolvedValue([{ id: 'p1', path: '/proj' }]);
  isExperimentalSettingsUnreadable.mockReset().mockResolvedValue(false);
  window.clubhouse.app.getExperimentalSettings = getExperimentalSettings;
  window.clubhouse.app.isExperimentalSettingsUnreadable = isExperimentalSettingsUnreadable;
  window.clubhouse.chat.getRuntimeSettings = getRuntimeSettings;
  window.clubhouse.chat.getAgentRuntime = getAgentRuntime;
  window.clubhouse.agent.listDurable = listDurable;
  (window.clubhouse as { project: unknown }).project = { ...window.clubhouse.project, list: listProjects };
});

describe('showChatDefaultTip', () => {
  it('shows one toast for an existing agent that now opens in chat, and marks it told', async () => {
    await showChatDefaultTip();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ message: CHAT_DEFAULT_TIP_TEXT, type: 'info', action: { label: CHAT_DEFAULT_TIP_ACTION } });
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBe('true');
    expect(getAgentRuntime).toHaveBeenCalledWith('a1', 'codex-cli', { projectPath: '/proj', starting: true });
  });

  it('shows it once only, across launches', async () => {
    await showChatDefaultTip();
    useToastStore.setState({ toasts: [] });
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
    expect(getExperimentalSettings).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when chatMessageShown is set, as a welcome intro would', async () => {
    expect(markChatMessageShown()).toBe(true);
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
    expect(getExperimentalSettings).not.toHaveBeenCalled();
  });

  it('does not show if the intro covers chat while eligibility is being read', async () => {
    let release!: (value: object) => void;
    getRuntimeSettings.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = showChatDefaultTip();
    await vi.waitFor(() => expect(getRuntimeSettings).toHaveBeenCalled());
    markChatMessageShown();
    release({});
    await pending;
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBeNull();
  });

  it('shows only once if two decisions overlap', async () => {
    await Promise.all([showChatDefaultTip(), showChatDefaultTip()]);
    expect(toasts()).toHaveLength(1);
  });

  it('links straight to the provider on Settings > Agents & providers', async () => {
    await showChatDefaultTip();
    toasts()[0].action!.onClick();
    const ui = useUIStore.getState();
    expect(ui.explorerTab).toBe('settings');
    expect(ui.settingsSubPage).toBe('orchestrators');
    expect(ui.settingsFocus).toBe('runtime:codex-cli');
  });

  it('has plain copy, with no em dashes or colon reveals', () => {
    expect(CHAT_DEFAULT_TIP_TEXT).not.toMatch(/[—–:]/);
  });

  it('rules out a new install for good, so agents it gets later bring no toast', async () => {
    listProjects.mockResolvedValue([]);
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBe('no_chat_agents');
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();

    listProjects.mockResolvedValue([{ id: 'p1', path: '/proj' }]);
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
  });

  it.each([
    ['chat saved on', () => getExperimentalSettings.mockResolvedValue({ chat: true })],
    ['chat saved off', () => getExperimentalSettings.mockResolvedValue({ chat: false })],
    ['a provider saved on Chat', () => getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'chat' } })],
    ['a provider saved on CLI', () => getRuntimeSettings.mockResolvedValue({ 'claude-code': { mode: 'terminal' } })],
    ['an agent saved on Chat', () => listDurable.mockResolvedValue([{ id: 'a1' }, { id: 'a2', runtimeMode: 'chat' }])],
    ['an agent saved on CLI', () => listDurable.mockResolvedValue([{ id: 'a1' }, { id: 'a2', runtimeMode: 'terminal' }])],
  ])('rules itself out with %s', async (_name, arrange) => {
    arrange();
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBe('saved_choice');
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();
  });

  it('rules itself out when no agent would open in chat, such as a provider with no chat driver', async () => {
    getAgentRuntime.mockResolvedValue({ chat: false });
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBe('no_chat_agents');
  });

  it('counts a marker saved by the tip in earlier builds', async () => {
    localStorage.setItem(CHAT_TIP_RULED_OUT_KEY, 'dismissed');
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
  });

  it('decides nothing when the settings can\'t be read, so the next launch asks again', async () => {
    getRuntimeSettings.mockRejectedValueOnce(new Error('not ready'));
    await expect(showChatDefaultTip()).rejects.toThrow('not ready');
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBeNull();

    await showChatDefaultTip();
    expect(toasts()).toHaveLength(1);
  });

  it('decides nothing while the flags file is unreadable: no marker and no toast, and a readable launch evaluates normally', async () => {
    isExperimentalSettingsUnreadable.mockResolvedValue(true);
    // What main sends the renderer for that file: a stand-in, not a saved choice.
    getExperimentalSettings.mockResolvedValue({ chat: false, richChatContent: false, newChrome: false });
    await showChatDefaultTip();
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();

    isExperimentalSettingsUnreadable.mockResolvedValue(false);
    getExperimentalSettings.mockResolvedValue({});
    await showChatDefaultTip();
    expect(toasts()).toHaveLength(1);
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBe('true');
  });

  it('decides nothing when a project\'s agents can\'t be listed, so the next launch asks again', async () => {
    listDurable.mockRejectedValueOnce(new Error('unreadable'));
    await expect(showChatDefaultTip()).rejects.toThrow('unreadable');
    expect(toasts()).toEqual([]);
    expect(localStorage.getItem(CHAT_MESSAGE_SHOWN_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_TIP_RULED_OUT_KEY)).toBeNull();

    await showChatDefaultTip();
    expect(toasts()).toHaveLength(1);
  });

  it('shows nothing when the marker can\'t be written, rather than every launch', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      await showChatDefaultTip();
      expect(toasts()).toEqual([]);
    } finally {
      setItem.mockRestore();
    }
  });
});
