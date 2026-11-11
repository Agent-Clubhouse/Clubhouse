import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `config` is the chat a phone sees (#3036); `coordinatorId` the hidden agent that keeps the Dispatcher's id. */
const S = vi.hoisted(() => ({
  enabled: false, newLayout: true, running: false, classicUnsaved: false, requestsUnderWay: 0,
  config: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01' } as Record<string, unknown> | null,
  coordinatorId: 'durable_coordinator',
}));

vi.mock('./dispatcher/dispatcher-service', () => {
  const state = () => ({ enabled: S.enabled, flagOn: true, savedOn: S.enabled, classic: !S.newLayout, running: S.running,
    offReason: S.enabled ? null : S.classicUnsaved ? 'classic_layout' : 'switch_off', agentId: S.config ? S.coordinatorId : null,
    path: S.config ? '/base/dispatcher' : null, config: S.config ? { ...S.config, id: S.coordinatorId } : null,
    chatAgentId: (S.config?.id as string) ?? null, chatPath: S.config ? '/base/dispatcher-chat' : null, chatRunning: S.running, requestsUnderWay: S.requestsUnderWay });
  return {
    DISPATCHER_NAME: 'Dispatcher',
    getDispatcherPath: () => '/base/dispatcher',
    getDispatcherChatPath: () => '/base/dispatcher-chat',
    getDispatcherChatConfig: () => S.config,
    isDispatcherAgentId: (id?: string) => !!id && !!S.config && id === S.coordinatorId,
    isDispatcherChatAgentId: (id?: string) => !!id && id === S.config?.id,
    getDispatcherAgentId: () => (S.config ? S.coordinatorId : null),
    getDispatcherChatAgentId: () => (S.config?.id as string) ?? null,
    isDispatcherEnabled: () => S.enabled,
    getDispatcherState: state,
    setDispatcherEnabled: vi.fn(async (on: boolean) => { S.enabled = on; return state(); }),
  };
});
vi.mock('../window-chrome', () => ({ newChromeEnabled: () => S.newLayout }));

import * as dispatcher from './dispatcher/dispatcher-service';
import {
  activeDispatcher, assertDispatcherCommand, dispatcherCapability, dispatcherChange, dispatcherCommandsWhileOff, dispatcherFolderProject,
  dispatcherOffFields, dispatcherShellProject, dispatcherSnapshotFlags, isDisabledDispatcherId, phoneChatEvent, phoneChatEvents, setDispatcherEnabledFromPhone,
} from './mobile-dispatcher';
import type { ChatEvent } from '../../shared/chat';

const allow = () => {};
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (e) { return e as { code: string; statusCode: number }; }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  Object.assign(S, { enabled: false, newLayout: true, running: false, classicUnsaved: false, requestsUnderWay: 0, config: { id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01' } });
  vi.mocked(dispatcher.setDispatcherEnabled).mockClear();
});

describe('resolving the Dispatcher for phones', () => {
  it('resolves its chat\'s id with the chat\'s folder as the __dispatcher__ project only while it is on (#3036)', () => {
    expect(activeDispatcher('durable_d')).toBeNull();
    expect(isDisabledDispatcherId('durable_d')).toBe(true);
    expect(dispatcherFolderProject('__dispatcher__')).toBeUndefined();
    S.enabled = true;
    expect(activeDispatcher('durable_d')).toEqual({
      config: S.config, project: { id: '__dispatcher__', name: 'Dispatcher', path: '/base/dispatcher-chat' },
    });
    expect(activeDispatcher()).not.toBeNull();
    expect(activeDispatcher('durable_other')).toBeNull();
    expect(isDisabledDispatcherId('durable_d')).toBe(false);
    expect(isDisabledDispatcherId('durable_other')).toBe(false);
    expect(dispatcherFolderProject('__dispatcher__')).toMatchObject({ path: '/base/dispatcher-chat' });
    expect(dispatcherFolderProject('proj_app')).toBeUndefined();
  });

  it('never resolves the hidden agent that keeps the Dispatcher\'s id (#3036)', () => {
    S.enabled = true;
    expect(activeDispatcher(S.coordinatorId)).toBeNull();
    expect(isDisabledDispatcherId(S.coordinatorId)).toBe(false);
    expect(dispatcherChange().agentId).toBe('durable_d');
    expect(() => assertDispatcherCommand('agent.start', S.coordinatorId)).not.toThrow();
    S.enabled = false;
    expect(dispatcherChange().agentId).toBeNull();
    expect(isDisabledDispatcherId(S.coordinatorId)).toBe(false);
  });

  it('answers nothing switched off, or before it was ever created', () => {
    S.enabled = false;
    expect(activeDispatcher('durable_d')).toBeNull();
    S.enabled = true;
    S.config = null;
    expect(activeDispatcher()).toBeNull();
  });
});

describe('while it is off', () => {
  const view = (config: unknown) => ({ view: config });

  it('switched off: only setEnabled is left, and every payload says so', () => {
    Object.assign(S, { enabled: false, running: false });
    expect(dispatcherShellProject('__dispatcher__')).toBeUndefined();
    expect(dispatcherChange()).toEqual({ enabled: false, flagOn: true, requestsUnderWay: 0, agentId: null });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toEqual({
      offReason: 'switched_off', running: false, status: 'sleeping', detail: 'Turned off', commandsWhileOff: ['dispatcher.setEnabled'], agent: { view: S.config },
    });
  });

  it('never says mcp_off: the Clubhouse MCP always runs', () => {
    Object.assign(S, { enabled: false, running: true });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toMatchObject({ offReason: 'switched_off', running: true });
  });

  it('its status is what the agent says, so the two can\'t differ', () => {
    Object.assign(S, { enabled: false, running: true });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), () => ({ status: 'sleeping' }))).toMatchObject({ running: true, status: 'sleeping' });
    S.config = null;
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toMatchObject({ status: 'running', agent: null });
  });

  it('adds nothing while it is on', () => {
    Object.assign(S, { enabled: true });
    expect(dispatcherOffFields(dispatcher.getDispatcherState(), view)).toEqual({});
    expect(dispatcherCommandsWhileOff(dispatcher.getDispatcherState())).toEqual([]);
  });
});

describe('the one list of commands', () => {
  const EVERY_COMMAND = ['agent.start', 'agent.stop', 'agent.update', 'chat.send', 'chat.interrupt', 'chat.permission', 'chat.question', 'chat.queue.remove', 'chat.setModel', 'chat.setLevel'];
  const STATES: Array<[name: string, state: Partial<typeof S>, reason: string, code: string]> = [
    ['switched_off', { enabled: false }, 'switched_off', 'dispatcher_off'],
    ['switched_off running', { enabled: false, running: true }, 'switched_off', 'dispatcher_off'],
    ['classic_layout', { enabled: false, newLayout: false, classicUnsaved: true }, 'classic_layout', 'dispatcher_off'],
  ];

  it.each(STATES)('%s: what is advertised is exactly what is accepted', (_name, state, reason, code) => {
    Object.assign(S, state);
    const current = dispatcher.getDispatcherState();
    const { commandsWhileOff, offReason } = dispatcherOffFields(current, (c) => c) as { commandsWhileOff: string[]; offReason: string };
    expect(offReason).toBe(reason);
    const accepted = EVERY_COMMAND.filter((type) => {
      try {
        assertDispatcherCommand(type, 'durable_d');
        return true;
      } catch (err) {
        expect((err as { code: string; statusCode: number }).code).toBe(code);
        expect((err as { statusCode: number }).statusCode).toBe(409);
        return false;
      }
    });
    expect(accepted.sort()).toEqual(commandsWhileOff.filter((c) => c !== 'dispatcher.setEnabled').sort());
    expect(commandsWhileOff).toContain('dispatcher.setEnabled');
  });

  it('leaves other agents alone', () => {
    Object.assign(S, { enabled: false });
    expect(() => assertDispatcherCommand('agent.start', 'durable_other')).not.toThrow();
  });
});

describe('capability and change event', () => {
  it('reports the gate and the layout', () => {
    S.enabled = true;
    expect(dispatcherCapability()).toEqual({
      version: 1, enabled: true, flagOn: true, requestsUnderWay: 0, newLayout: true, projectId: '__dispatcher__',
      snapshotField: 'dispatcher', event: 'dispatcher:changed',
      // Settings > Dispatcher from a phone (#3206): its route and commands.
      commands: ['dispatcher.setEnabled', 'dispatcher.update', 'dispatcher.setModels', 'dispatcher.clearChat', 'dispatcher.forgetEverything'],
      settings: { version: 1, path: '/api/v1/mobile/dispatcher/settings' },
    });
  });

  it('sends the agent id only while it is on', () => {
    expect(dispatcherChange()).toEqual({ enabled: false, flagOn: true, requestsUnderWay: 0, agentId: null });
    S.enabled = true;
    expect(dispatcherChange()).toEqual({ enabled: true, flagOn: true, requestsUnderWay: 0, agentId: 'durable_d' });
  });

  it.each([false, true])('shares the request count in every payload while enabled is %s', (enabled) => {
    S.enabled = enabled;
    for (const requestsUnderWay of [0, 2, 1, 0]) {
      S.requestsUnderWay = requestsUnderWay;
      for (const payload of [dispatcherSnapshotFlags(), dispatcherChange(), dispatcherCapability()]) {
        expect(payload).toMatchObject({ enabled, requestsUnderWay });
      }
    }
  });

  it('uses the supplied event state rather than a newer service state', () => {
    const state = { ...dispatcher.getDispatcherState(), enabled: true, requestsUnderWay: 2 };
    expect(dispatcherChange(state)).toEqual({ enabled: true, flagOn: true, requestsUnderWay: 2, agentId: 'durable_d' });
  });
});

describe('dispatcher.setEnabled', () => {
  it('turns it on and off', async () => {
    expect(await setDispatcherEnabledFromPhone(true, allow)).toEqual({ enabled: true, flagOn: true, requestsUnderWay: 0, agentId: 'durable_d' });
    expect(await setDispatcherEnabledFromPhone(false, allow)).toEqual({ enabled: false, flagOn: true, requestsUnderWay: 0, agentId: null });
    expect(dispatcher.setDispatcherEnabled).toHaveBeenCalledTimes(2);
  });

  it('refuses turning it on on the classic layout, as Settings > Dispatcher does', async () => {
    S.newLayout = false;
    expect(await refusal(setDispatcherEnabledFromPhone(true, allow))).toMatchObject({
      code: 'dispatcher_layout_off', statusCode: 409, detail: 'The Dispatcher needs the new layout. Turn off Classic layout in Settings > Display & UI on the desktop, then restart Clubhouse.',
    });
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
  });

  it('lets one that is still on be turned off on the classic layout, and leaves one that is on alone', async () => {
    S.enabled = true;
    S.newLayout = false;
    expect(await setDispatcherEnabledFromPhone(true, allow)).toMatchObject({ enabled: true });
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
    expect(await setDispatcherEnabledFromPhone(false, allow)).toMatchObject({ enabled: false });
  });

  it('rechecks authorization before changing anything', async () => {
    const revoked = () => { throw new Error('authorization_revoked'); };
    await expect(setDispatcherEnabledFromPhone(true, revoked)).rejects.toThrow('authorization_revoked');
    expect(dispatcher.setDispatcherEnabled).not.toHaveBeenCalled();
  });
});

describe('the Dispatcher\'s chat on a phone (#3043)', () => {
  const ev = (agentId: string, seq: number, type: string, data: Record<string, unknown>) => ({ v: 2, agentId, sessionId: 's', seq, ts: seq, type, data }) as ChatEvent;
  const tool = (agentId: string) => ev(agentId, 1, 'tool_call', { toolCallId: 't', kind: 'other', title: 'list_agents', status: 'pending' });
  const fromCoordinator = (agentId: string) => ev(agentId, 2, 'user_message', {
    messageId: 'm', source: 'mcp', delivery: 'prompt', content: [{ type: 'text', text: 'x' }], routed: [{ sender: { agentId: 'durable_coordinator', name: 'Dispatcher' }, text: 'x' }],
  });

  it('sends its chat\'s and its coordinator\'s events as the group chat shows them', () => {
    for (const id of ['durable_d', 'durable_coordinator']) {
      expect(phoneChatEvent(tool(id))).toBeNull();
      // A message from its own coordinator is never an interjection.
      expect(phoneChatEvent(fromCoordinator(id))).toBeNull();
    }
    expect(phoneChatEvents('durable_d', [tool('durable_d'), ev('durable_d', 3, 'turn_ended', { stopReason: 'end_turn' })]).map((e) => e.type)).toEqual(['turn_ended']);
  });

  it('sends every other agent\'s events as they are', () => {
    const events = [tool('durable_other'), fromCoordinator('durable_other')];
    for (const event of events) expect(phoneChatEvent(event)).toBe(event);
    expect(phoneChatEvents('durable_other', events)).toBe(events);
  });

  it('sends everything before the Dispatcher was first created', () => {
    S.config = null;
    const event = tool('durable_d');
    expect(phoneChatEvent(event)).toBe(event);
  });
});
