import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatcherState } from '../../shared/dispatcher-types';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listener: null as ((s: DispatcherState) => void) | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(ch, fn); }) },
}));

const ON = { enabled: true, flagOn: true, agentId: 'disp', path: 'dispatcher-folder', config: null, behavior: { level: 'standard', provider: 'claude-code', auto: { ready: true } } } as unknown as DispatcherState;
vi.mock('../services/dispatcher/dispatcher-service', () => ({
  getDispatcherState: vi.fn(() => ON),
  setDispatcherEnabled: vi.fn(async (on: boolean) => ({ ...ON, enabled: on })),
  setDispatcherBehavior: vi.fn(async (level: string) => ({ ...ON, behavior: { ...ON.behavior, level } })),
  setDispatcherPersonality: vi.fn(async (personality: unknown) => ({ ...ON, personality })),
  setDispatcherSetupStatus: vi.fn(async (status: string) => ({ ...ON, setup: { status, upgrade: false } })),
  completeDispatcherSetup: vi.fn(async () => ({ ...ON, setup: { status: 'done', upgrade: false } })),
  onDispatcherChanged: vi.fn((l: (s: DispatcherState) => void) => { h.listener = l; return () => {}; }),
  initDispatcher: vi.fn(async () => undefined),
}));
vi.mock('../services/dispatcher/dispatcher-clear-chat', () => ({ clearDispatcherChat: vi.fn(async () => ({ cleared: 'now' })) }));
vi.mock('../services/dispatcher/dispatcher-news', () => ({ installGroupChat: vi.fn() }));
vi.mock('../services/dispatcher/dispatcher-setup', () => ({
  tryDispatcherPersonality: vi.fn(async () => ({ ok: true, text: 'Hello.' })),
  checkDispatcherBehavior: vi.fn(async () => ({ ready: true })),
}));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('./mcp-binding-handlers', () => ({ restorePersistedBindings: vi.fn(async () => {}) }));

import { IPC } from '../../shared/ipc-channels';
import * as dispatcher from '../services/dispatcher/dispatcher-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { restorePersistedBindings } from './mcp-binding-handlers';
import { clearDispatcherChat } from '../services/dispatcher/dispatcher-clear-chat';
import { installGroupChat } from '../services/dispatcher/dispatcher-news';
import { registerDispatcherHandlers, _resetDispatcherHandlersForTesting } from './dispatcher-handlers';
import { checkDispatcherBehavior, tryDispatcherPersonality } from '../services/dispatcher/dispatcher-setup';
import { AGENT_CARDS_UNAVAILABLE, setAgentCardSource } from '../services/dispatcher/dispatcher-agent-card-source';

beforeEach(() => {
  vi.clearAllMocks();
  setAgentCardSource(null);
  h.handlers.clear();
  _resetDispatcherHandlersForTesting();
  registerDispatcherHandlers();
});

describe('dispatcher handlers', () => {
  it('starts the service once and answers get', async () => {
    expect(dispatcher.initDispatcher).toHaveBeenCalledTimes(1);
    expect(await h.handlers.get(IPC.DISPATCHER.GET)!({})).toEqual(ON);
  });

  it('makes its chat a group chat, and clears the chat on request (#3043)', async () => {
    expect(installGroupChat).toHaveBeenCalledTimes(1);
    expect(await h.handlers.get(IPC.DISPATCHER.CLEAR_CHAT)!({})).toEqual({ cleared: 'now' });
    expect(clearDispatcherChat).toHaveBeenCalledTimes(1);
  });

  it('setEnabled takes a boolean only', async () => {
    expect(await h.handlers.get(IPC.DISPATCHER.SET_ENABLED)!({}, false)).toEqual({ ...ON, enabled: false });
    expect(dispatcher.setDispatcherEnabled).toHaveBeenCalledWith(false);
    await expect(Promise.resolve().then(() => h.handlers.get(IPC.DISPATCHER.SET_ENABLED)!({}, 'yes'))).rejects.toThrow();
  });

  it('setBehavior takes a level only (#3045)', async () => {
    const state = await h.handlers.get(IPC.DISPATCHER.SET_BEHAVIOR)!({}, 'thorough') as DispatcherState;
    expect(state.behavior.level).toBe('thorough');
    expect(dispatcher.setDispatcherBehavior).toHaveBeenCalledWith('thorough');
    await expect(Promise.resolve().then(() => h.handlers.get(IPC.DISPATCHER.SET_BEHAVIOR)!({}, 'extreme'))).rejects.toThrow(/Unknown Behavior/);
    await expect(Promise.resolve().then(() => h.handlers.get(IPC.DISPATCHER.SET_BEHAVIOR)!({}, 2))).rejects.toThrow();
    expect(dispatcher.setDispatcherBehavior).toHaveBeenCalledTimes(1);
  });

  it('a Behavior change alone doesn\'t rebuild its wires', () => {
    h.listener!(ON);
    h.listener!({ ...ON, behavior: { ...ON.behavior, level: 'light' } });
    expect(broadcastToAllWindows).toHaveBeenCalledTimes(2);
    expect(restorePersistedBindings).toHaveBeenCalledTimes(1);
  });

  it('broadcasts changes and rebuilds its wires only while enabled', () => {
    h.listener!(ON);
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.DISPATCHER.CHANGED, ON);
    expect(restorePersistedBindings).toHaveBeenCalledTimes(1);
    h.listener!({ ...ON, enabled: false });
    expect(restorePersistedBindings).toHaveBeenCalledTimes(1);
  });

  it('reads an agent\'s card: null with no card service, else what the service says (#3049)', async () => {
    const get = h.handlers.get(IPC.DISPATCHER.GET_AGENT_CARD)!;
    expect(await get({}, 'lead')).toBeNull();
    const status = vi.fn(async () => ({ state: 'ready' as const, card: { owns: 'web' } }));
    setAgentCardSource({ status, saveUserCard: vi.fn() });
    expect(await get({}, 'lead')).toEqual({ state: 'ready', card: { owns: 'web' } });
    expect(status).toHaveBeenCalledWith('lead');
    await expect(Promise.resolve().then(() => get({}, 42))).rejects.toThrow();
  });

  it('saves the user\'s edit cleaned to one line per field, and tells every window (#3049)', async () => {
    const save = h.handlers.get(IPC.DISPATCHER.SAVE_AGENT_CARD)!;
    await expect(save({}, 'lead', { owns: 'x' })).rejects.toThrow(AGENT_CARDS_UNAVAILABLE);
    const saveUserCard = vi.fn(async () => ({ state: 'ready' as const, card: { owns: 'web app' } }));
    setAgentCardSource({ status: vi.fn(), saveUserCard });
    const view = await save({}, 'lead', { owns: '  web\n app ', contactWhen: 'releases', extra: 'dropped' });
    expect(view).toEqual({ state: 'ready', card: { owns: 'web app' } });
    expect(saveUserCard).toHaveBeenCalledWith('lead', { owns: 'web app', contactWhen: 'releases' });
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.DISPATCHER.AGENT_CARD_CHANGED, 'lead');
    await expect(Promise.resolve().then(() => save({}, 'lead', 'text'))).rejects.toThrow();
  });

  describe('personality and setup (#3047)', () => {
    const call = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => h.handlers.get(channel)!({}, ...args));

    it('saves a personality', async () => {
      await call(IPC.DISPATCHER.SET_PERSONALITY, { preset: 'friendly', text: 'Hi' });
      expect(dispatcher.setDispatcherPersonality).toHaveBeenCalledWith({ preset: 'friendly', text: 'Hi' });
      await expect(call(IPC.DISPATCHER.SET_PERSONALITY, 'friendly')).rejects.toThrow();
    });

    it('finishes setup with what it sent, cleaned, and refuses an unusable one', async () => {
      await call(IPC.DISPATCHER.COMPLETE_SETUP, { name: ' Rosie ', color: 'rose', provider: 'codex-cli', behavior: 'light', personality: { preset: 'concise', text: 'Short.' } });
      expect(dispatcher.completeDispatcherSetup).toHaveBeenCalledWith({ name: 'Rosie', color: 'rose', provider: 'codex-cli', behavior: 'light', personality: { preset: 'concise', text: 'Short.' } });
      await expect(call(IPC.DISPATCHER.COMPLETE_SETUP, { name: '', color: 'rose', provider: 'x', behavior: 'light' })).rejects.toThrow('Give it a name.');
      expect(dispatcher.completeDispatcherSetup).toHaveBeenCalledTimes(1);
    });

    it('takes later or done for the setup status, never pending', async () => {
      await call(IPC.DISPATCHER.SET_SETUP_STATUS, 'later');
      expect(dispatcher.setDispatcherSetupStatus).toHaveBeenCalledWith('later');
      await expect(call(IPC.DISPATCHER.SET_SETUP_STATUS, 'pending')).rejects.toThrow(/Unknown setup status/);
      expect(dispatcher.setDispatcherSetupStatus).toHaveBeenCalledTimes(1);
    });

    it('runs Try it out and checks Behavior for an unsaved provider', async () => {
      expect(await call(IPC.DISPATCHER.TRY_PERSONALITY, { name: 'Rosie', provider: 'claude-code', behavior: 'standard', personality: { preset: 'concise', text: 'Short.' } }))
        .toEqual({ ok: true, text: 'Hello.' });
      expect(tryDispatcherPersonality).toHaveBeenCalledWith({ name: 'Rosie', provider: 'claude-code', behavior: 'standard', personality: { preset: 'concise', text: 'Short.' } });
      expect(await call(IPC.DISPATCHER.CHECK_BEHAVIOR, 'codex-cli', 'thorough')).toEqual({ ready: true });
      expect(checkDispatcherBehavior).toHaveBeenCalledWith('codex-cli', 'thorough');
      await expect(call(IPC.DISPATCHER.CHECK_BEHAVIOR, 'codex-cli', 'max')).rejects.toThrow(/Unknown Behavior/);
    });
  });
});
